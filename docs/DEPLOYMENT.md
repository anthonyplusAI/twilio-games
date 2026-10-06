# Deployment

Twilio Games deploys six playable titles, Voice Racer, Voice Monsters, Voice Fighter, Voice Karaoke, Voice Trivia, and Voice Chess, to one Azure Container App. The Node process serves the built browser clients, APIs, static assets, Twilio webhooks, game WebSockets, and Karaoke Media Streams.

For project setup and local development, see the [README](../README.md). For the one-time Azure and GitHub setup, see [Infrastructure setup](./INFRA_SETUP.md).

## Deployment flow

```mermaid
flowchart LR
  Push[Push to main or manual dispatch] --> Checkout[Checkout LFS pointers only]
  Checkout --> Validate[Deploy job: npm ci, typecheck, tests, build]
  Validate -->|success| Infra[Validate credentials and ensure Azure resources]
  Infra --> Assets[Download exact private Blob bundle and verify SHA-256]
  Assets --> Build[ACR builds SHA and latest images]
  Build --> Stop[Stop old revisions and assert zero replicas]
  Stop --> Deploy[Apply uniquely named full-spec revision]
  Deploy --> Verify[Verify SHA image, Provisioned, Healthy, latestReady, mount, and probes]
  Verify --> Smoke[Smoke /livez, /healthz, and pages on revision FQDN]
  Smoke --> Cutover[Assign 100% public traffic]
  Cutover --> Commit[Restore and verify single revision mode]
```

`.github/workflows/deploy.yml` runs on pushes to `main` and manual `workflow_dispatch` events. Deployments are serialized and are not canceled in progress. There is no GitHub environment approval gate. A push triggers CI and deployment independently; deployment reaches Azure only after its own validation steps succeed.

1. `deploy.yml` validates independently and does not call `.github/workflows/ci.yml`. Both workflows verify Fighter pointers and run typecheck, tests, and the client build; deployment additionally runs the explicit bundled Trivia-bank validator.
2. The deploy job checks out Git LFS pointers without downloading their binaries, installs Node 22.13 with `actions/setup-node@v6`, runs `npm ci`, `npm run verify:fighter-asset-pointers`, `npm run validate:trivia-bank`, `npm run typecheck`, `npm test`, and `npm run build`, validates production credentials, then signs in with `azure/login@v3` using `AZURE_CREDENTIALS`.
3. Unlike `ci.yml`, `deploy.yml` does not run `npm audit`. The CI workflow runs the high-severity audit as informational with `|| true`.
4. Azure CLI commands create missing resource group, Basic ACR, Standard LRS storage account, private Fighter asset Blob container, 5 GiB Azure Files share, Log Analytics workspace, Container Apps environment, and environment storage attachment. Existing resource properties and tags are not generally reconciled.
5. Before ACR build, the workflow derives an immutable bundle ID from every committed LFS path, size, and SHA-256, downloads only that prefix from the private `fighter-build-assets` container, and verifies every hydrated byte against the committed pointers. Missing, stale, corrupt, or unresolved assets stop deployment before an image is built.
6. `az acr build` builds remotely and pushes `twilio-games:<commit-sha>` plus the mutable `twilio-games:latest`. These are image tags, not Azure resource tags, and ACR does not enforce their immutability.
7. A new ACR is created with its admin account enabled. An existing ACR must already expose admin credentials. The workflow reads the admin username/password, masks the password, and stores it as the application-scoped `acr-password` secret.
8. The workflow renders `.github/containerapp.yaml` with a unique `sha-<short-sha>-r<run-id>-a<attempt>` revision suffix. An existing app may be in `Single` or `Multiple` mode, but it must have exactly one active revision. The workflow switches to `Multiple` when needed, pins traffic to the old revision, deactivates it, and waits for zero replicas before updating. It also accepts a stopped, zero-running-replica first-deployment retry; every other topology fails closed.
9. A first deployment creates the minimal Azure-resource-tagged app required by tenant policy with external ingress and `minReplicas=0`, records its temporary revision, immediately switches to Multiple mode, deactivates it, and waits for zero replicas before setting secrets or applying the full specification. Because external ingress exists before deactivation, do not treat the temporary shell as a traffic-isolation boundary.
10. Before committing the rollout, the workflow requires the exact uniquely named revision to use `twilio-games:<commit-sha>`, be active with one replica, be `Provisioned` and `Healthy`, equal `latestReadyRevisionName`, include the `appdata` Azure Files mount, and include all three health probes. It also asserts that no other revision has a running replica.
11. Before public cutover, the candidate revision FQDN must return HTTP 200 for `/livez`, `/healthz`, `/`, `/instructions`, `/join`, `/player`, `/karaoke.html`, `/trivia.html`, `/chess.html`, and `/analytics`, plus the expected HTTP 302 authentication redirect for `/operator`. The route set is retried for up to five minutes. The workflow then assigns 100% public traffic and requires exact `Single` mode around the verified revision.
12. Before the candidate can produce external or public durable side effects, a failed rollout may stop it, restore the byte-verified pre-rollout Azure Files snapshot, reactivate the prior revision, pin 100% traffic to it, and deliberately leave recovery in `Multiple` mode. If outbound delivery is enabled, restore becomes unsafe before the candidate update because its worker may call Twilio immediately. Once restore is unsafe, automatic rollback is disabled and the workflow leaves data and revision state intact for manual recovery rather than erasing accepted registrations/webhooks or duplicating messages. A failed first deployment has no prior revision to restore and remains stopped.

The Container App specification uses process-only `/livez` for Azure startup, readiness, and liveness probes. The workflow separately calls dependency-aware `/healthz` on the candidate revision before public cutover.

The deployment does not perform a writable persistent-store smoke. The current public write APIs change real editor, Arcade, or messaging state, and there is no existing authenticated, idempotent endpoint for a disposable write-and-delete check. Using one of those mutations as a probe would be less safe than omitting the check.

Container App secrets are application-scoped, not revision-scoped. A revision rollback does not restore previous Twilio, Google, editor, signing, display, Relay, OpenAI, Deepgram, or Dub secret values. Rotate secrets in a separate controlled change, retain the prior values securely, and restore them explicitly before reactivating an older revision when a credential change caused the failure.

## Image and process model

The `Dockerfile` uses `node:22-bookworm-slim`, installs `ca-certificates` and `tini`, and runs `npm ci --include=dev`. Development dependencies remain necessary in the production image because Vite and TypeScript build the client and `tsx` runs the TypeScript server directly. Node 22.13 or later is required by `twilio-agent-connect`.

`npm run build` typechecks the server and client and writes the Vite multi-page build to `client/dist`. `tini` runs as PID 1. `scripts/start.sh` prepares persistent storage and executes:

```bash
npx tsx server/index.ts
```

The process listens on `PORT`, which is `8080` in the image and Container App. Ingress is external, targets port 8080, and uses `transport: auto` for HTTP and WebSocket upgrades. The deployed container requests 2 vCPU and 4 GiB memory.

The app must remain at exactly one replica. Racer, battle, Fighter, host, and SMS session state is in memory, and the WebSockets are process-local. `.github/containerapp.yaml` sets both `minReplicas` and `maxReplicas` to `1`. Scaling out requires shared room/session state and cross-replica messaging.

## Runtime asset mirror

Fighter map GLBs under `assets/fighters/maps/*.glb` and Fighter source FBX files under `assets/fighters/source/*.fbx` remain Git LFS objects for source provenance. GitHub Actions deliberately checks out only their small pointer files, so CI and deployment do not consume GitHub LFS bandwidth.

Production binaries live in the private `fighter-build-assets` Blob container in `twiliogamesdata`. `npm run sync:fighter-assets` verifies the local files against committed LFS pointers, derives a content-addressed bundle ID, copies only tracked objects into an exact staging tree, and uploads a new prefix without overwrite. It then downloads the prefix to a temporary directory, rejects missing or extra files, and verifies every hash again. Run it after committing any Fighter FBX or map GLB change and before pushing the deployment commit:

```bash
npm run verify:fighter-assets
npm run sync:fighter-assets
```

The sync command requires an authenticated Azure CLI identity that can list the storage account keys. Interrupted uploads are resumable because sync uploads only missing exact paths and never overwrites an existing object. If verification identifies a corrupt existing object, delete that bundle prefix explicitly and rerun sync. Old bundle prefixes are inert and may be removed after no branch or pending deployment references their pointer set.

Before a local Docker build from a fresh clone, install Git LFS and materialize the objects:

```bash
git lfs install
git lfs pull
docker build -t twilio-games .
```

The Docker context excludes `data`, local raw/quarantined asset directories, local environment files, and development output. Runtime models, maps, Fighter animations, bundled previews, audio, fonts, and the built client ship in the image under `/app/assets` and `/app/client/dist`. A new image is required to update them.

## Persistence

The Container Apps environment exposes the Azure Files share as `appdata`; the container mounts it read-write at `/app/appdata`. `DATA_MOUNT=/app/appdata` causes `scripts/start.sh` to create `/app/appdata/data` and replace `/app/data` with a symlink to that directory.

These default paths persist:

| Path | Contents | Initialization |
|---|---|---|
| `data/leaderboard.json` | Racer leaderboard | Created on the first completed race |
| `data/karaoke-leaderboard.json` | Per-song Voice Karaoke leaderboard | Created on the first completed Karaoke performance |
| `data/analytics.json` | Anonymous daily activation rollups for all six games | Created when the first match or accepted voice command is recorded; the 730-day age cutoff can retain 731 inclusive UTC date buckets |
| `data/maps.json` | Live Racer level catalog | Seeded from `assets/maps/maps.json` when missing, blank, or corrupt; a valid live file is not overwritten |
| `data/arena.json` | Live Voice Monsters arena configuration | Read from the bundled `assets/arena/arena.json` fallback until the editor first saves a live copy |
| `data/fighter-maps.json` | Live Fighter map catalog | Seeded from `assets/fighters/maps/maps.json` when the live catalog cannot be parsed |
| `data/fighter-previews/*.png` | Fighter map previews captured in the editor | Created by editor uploads |
| `data/karaoke-venue.json` | Live Voice Karaoke stage and camera configuration | Seeded from `assets/karaoke/venue.json` when missing, blank, or corrupt |
| `data/karaoke-timings.json` | Sparse per-word Karaoke timing overrides | Created by authenticated saves from `/editor?game=karaoke&tool=timing`; future performances use the live overrides and compiled chart timings remain the fallback |
| `data/trivia-questions.json` | Complete protected Voice Trivia bank, including answer keys and optional private voice alias fields; the current seed leaves alias arrays empty | Strictly validated and durably seeded from image-owned `content/trivia/questions.json` only when missing; authenticated editor saves replace it atomically |
| `data/trivia-leaderboard.json` | Voice Trivia all-time and category leaderboard history | Loaded as empty when missing and created on the first completed round; complete rounds are retained atomically and malformed storage is never overwritten |
| `data/arcade-config.json` | Current versioned Arcade runtime configuration | Defaults to mode `off`; created on the first admin update |
| `data/arcade-config-audit.jsonl` | Hash-chained Arcade configuration audit | Appended on every admin update |
| `data/arcade-state.json` | Arcade players, leads, wallets, station state, messaging identities, and the outbound notification outbox | Opened when Arcade is enabled and for mode-off webhook replay/status cleanup |

`assets/manifest.json` is not persistent. Garage writes modify the running container's image layer and are lost on restart or redeploy unless the resulting manifest is copied back into the repository and included in a new image. Bundled GLB, FBX, audio, and preview files are also image-owned rather than Azure Files content.

If `DATA_MOUNT` is absent or is not a directory, the server still runs, but all `data/` writes use ephemeral container storage.

Before opening its HTTP listener, the server strictly loads the bundled and live Trivia question banks, seeds the live bank if it is absent, and loads the Trivia leaderboard. Invalid bundled content, invalid existing live content, a failed first seed write, or a corrupt leaderboard prevents startup, so `/livez` is not available in those cases. Once listening, `/healthz` returns `503` if either Trivia store is not ready and reports `triviaContent`, `triviaLeaderboard`, `triviaRooms`, and the loaded question count. `/livez` remains process-only. Neither endpoint proves that `/app/data` is backed by the Azure Files mount or that a later write will succeed; the workflow verifies the mount declaration but performs no writable-store smoke.

## Runtime configuration

The deployed specification currently sets these variables:

| Variable | Current source | Runtime behavior |
|---|---|---|
| `PORT` | Literal `8080` | HTTP and WebSocket listener |
| `NODE_ENV` | Literal `production` | Production mode and fail-closed credential checks |
| `PUBLIC_BASE_URL` | Resolved Container App FQDN | Absolute Twilio callback URLs and the Conversation Relay `wss://` URL |
| `DATA_MOUNT` | Literal `/app/appdata` | Persistent mount used by `scripts/start.sh` |
| `TWILIO_AUTH_TOKEN` | Container App secret `twilio-token` | Enables fail-closed Twilio webhook signature validation |
| `VOICE_RELAY_TOKEN` | Container App secret `voice-relay-token` | Dedicated Conversation Relay setup-frame bearer token; production validation rejects reuse of `TWILIO_AUTH_TOKEN` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET` | Container App secrets populated from matching GitHub secrets | Primary SMS/WhatsApp account credentials for TAC, Conversation Memory, and Messaging REST calls |
| `TWILIO_PT_AUTH_TOKEN` | Container App secret `twilio-pt-token` | Validates incoming Voice and session-ended callbacks from the separate Portuguese Voice account |
| `TWILIO_PHONE_NUMBER`, `TWILIO_SMS_NUMBER` | GitHub `TWILIO_SMS_NUMBER` variable | SMS-capable sender for joining and outbound notices; never falls back to a voice-only number |
| `TWILIO_CONVERSATION_CONFIGURATION_ID` | Matching GitHub repository variable | Active Conversation Orchestrator configuration linked to the Memory store; TAC enriches messaging identities while the signed `/sms` webhook owns commands and replies |
| `ARCADE_TAC_ENABLED` | Literal `true` | Starts TAC/Orchestrator and Conversation Memory integration when event mode is active; an active-mode connection failure degrades `/healthz` |
| `EDITOR_TOKEN` | Required Container App secret `editor-token` | Protects disk-writing editor and garage APIs and both read/write access to the complete Trivia bank; production fails closed when missing |
| `GOOGLE_OAUTH_CLIENT_ID` | Container App secret `google-oauth-client-id` | Identifies the Google OAuth web client used by `/analytics` and `/operator` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Container App secret `google-oauth-client-secret` | Server-side Google authorization-code exchange |
| `ANALYTICS_ADMIN_PIN` | Container App secret `analytics-admin-pin` | Alternative 6-64 character login for `/analytics` and `/operator`; five failures from one client lock that client out for 15 minutes |
| `ANALYTICS_ALLOWED_EMAIL` | GitHub repository variable | Allows one exact verified Google email in addition to `@twilio.com` accounts |
| `ARCADE_SIGNING_SECRET` | Container App secret populated from the matching GitHub secret | Root key for signed player sessions and challenge claims; ignored while station mode is `off` |
| `ARCADE_DISPLAY_TOKEN` | Container App secret populated from the matching GitHub secret | Server-held kiosk capability for station launch and display-ready acknowledgement; use at least 16 random characters |
| `ARCADE_STATE_PATH` | Literal `/app/data/arcade-state.json` | Schema-versioned player, economy, station, identity, outbox, and audit state on Azure Files |
| `ARCADE_STANDALONE_VOICE_ENABLED` | Literal `true` | Permits standalone routing to the most recently registered eligible open shared display; no display means no Relay connection and no Racer default |
| `GAME_PHONE_NUMBER` | GitHub repository variable | Legacy fallback used only when an operator has not configured locale-specific voice numbers |
| Runtime `channels.voiceNumbers` | Twilio Games operator settings | Public `en-US` and `pt-BR` voice numbers used by lobbies and call-now notices; changing one also requires reapproving the matching WhatsApp Phone CTA template and updating its Content SID |
| `TWILIO_WHATSAPP_NUMBER` | GitHub repository variable | Approved WhatsApp sender used by the localized `/join` chooser; empty hides WhatsApp |
| `TWILIO_MESSAGING_SERVICE_SID` | GitHub repository variable | Messaging Service used for approved WhatsApp Content Templates |
| `ARCADE_OUTBOUND_MESSAGING_ENABLED` | GitHub repository variable | Explicit outbound station-notification kill switch; only literal `true` enables enqueue and REST delivery |
| `TWILIO_WHATSAPP_CONTENT_SID_STATION_{ADMITTED,OVERFLOW,CALL_NOW,RESULTS,NEXT_GAME}_{EN_US,PT_BR}` | Ten GitHub repository variables | Approved localized WhatsApp templates; call-now uses a static Phone CTA inside and outside the 24-hour window, while other configured templates are selected outside it |
| `CR_TTS_VOICE` | GitHub repository variable | ElevenLabs Conversation Relay voice ID; empty uses the Relay default |
| `CR_TTS_VOICE_PT_BR` | GitHub repository variable | Optional Brazilian Portuguese ElevenLabs voice ID; empty uses Relay's `pt-BR` default |
| `DEFAULT_LOCALE` | GitHub repository variable | Fallback when the dialed number and selected display do not identify a locale; empty defaults to `en-US` |
| `OPENAI_API_KEY` | Container App secret populated from the matching GitHub secret | Enables English free-form Racer and Monsters help; missing uses deterministic behavior, and Portuguese free-form OpenAI remains disabled |
| `OPENAI_MODEL` | GitHub repository variable | OpenAI model; empty defaults to `gpt-4o-mini` |
| `DEEPGRAM_API_KEY` | Required Container App secret `deepgram-api-key` populated from the matching GitHub secret | Enables direct Nova-3 streaming lyric verification with chart keyterms for Voice Karaoke; production startup and deploy validation fail closed when missing |
| `KARAOKE_CALIBRATION_OFFSET_MS` | Optional repository variable, default `0` | Applies the measured handset/carrier offset to authoritative Karaoke scoring; accepted range is `-5000..5000` ms, positive maps observations later, and negative maps them earlier |
| `DUB_API_KEY` | Container App secret `dub-api-key` | Enables challenge-link shortening only when `DUB_SHORT_DOMAIN` is also valid; missing preserves the original long URL |
| `DUB_FOLDER_ID` | Container App secret `dub-folder-id` | Optional folder assigned to links created by the enabled Dub shortener |
| `DUB_SHORT_DOMAIN` | GitHub repository variable | Valid custom Dub hostname paired with `DUB_API_KEY`; the workflow rejects a key/domain partial configuration |

The primary account owns the English Voice number, dedicated SMS number, optional WhatsApp sender, TAC/Orchestrator configuration, Memory store, and all REST credentials. The second account owns only the Portuguese Voice number and `TWILIO_PT_AUTH_TOKEN`. Incoming Voice, Voice WebSocket, and session-ended validation accept either configured Auth Token; after authentication, the exact dialed `To` number selects the locale. The Relay token authenticates custom setup parameters but does not turn them into signed claims; station setup revalidates them against the live call binding and persisted match.

Provision a station-managed booth display from that tab: open `https://<app-fqdn>/operator`, authenticate with Google or the admin PIN, and select **Pair this tab as the big screen**. The same-origin action installs display access in `sessionStorage` and returns the tab to `/`. Staff never need to know the display capability, and it is never placed in a URL, page, notice, or visitor QR. Repeat the action for independent browser sessions because they do not inherit the authenticated tab's session storage. Standalone room `4821` does not use this pairing flow: with the event paused, an enabled standalone display registers directly and the most recently opened eligible display receives the next call.

Before taking the first Karaoke call in a production display tab, select **Enable concert audio** once. That gesture unmutes the display and starts Web Audio so the backing track can become ready; a muted or suspended audio context intentionally blocks the Karaoke countdown. A reload, a new tab, or a browser-created kiosk session may require the one-time gesture again.

The server also supports `TWILIO_VALIDATE_SIGNATURES`, `VOICE_RELAY_TOKEN`, `FIGHTER_DISPLAY_TOKEN`, `MAPS_PATH`, `BUNDLED_MAPS_PATH`, `ARENA_PATH`, `BUNDLED_ARENA_PATH`, `FIGHTER_MAPS_PATH`, `BUNDLED_FIGHTER_MAPS_PATH`, `FIGHTER_PREVIEW_DIR`, `KARAOKE_VENUE_PATH`, `BUNDLED_KARAOKE_VENUE_PATH`, `KARAOKE_TIMINGS_PATH`, `KARAOKE_ASSET_DIRECTORY`, `KARAOKE_LEADERBOARD_PATH`, `TRIVIA_QUESTIONS_PATH`, `BUNDLED_TRIVIA_QUESTIONS_PATH`, and `TRIVIA_LEADERBOARD_PATH`. The deployed specification relies on the Trivia defaults under `/app/data` and does not render these path overrides. Voice Trivia adds no provider-specific secret: it reuses the existing Twilio/Relay credentials, `ARCADE_DISPLAY_TOKEN`, `EDITOR_TOKEN`, and `ARCADE_SIGNING_SECRET`; the last value derives keyed leaderboard identities. See [Infrastructure setup](./INFRA_SETUP.md#configuration-gaps-and-security-notes) before relying on additional overrides in Azure.

## Public URLs

Replace `<base>` with `https://<app-fqdn>`.

| Purpose | URL |
|---|---|
| Home and game launcher | `<base>/` |
| Visitor join chooser | `<base>/join` (the shared-screen QR adds station and locale automatically) |
| Browser player page | `<base>/player` |
| Staff operator console | `<base>/operator` (Google or PIN authentication required) |
| Standalone Voice Racer shared display | `<base>/play.html?display=1&room=4821` |
| Standalone Voice Monsters shared display | `<base>/monsters.html?display=1&room=4821` |
| Standalone Voice Fighter shared display | `<base>/fighter.html?display=1&room=4821` |
| Standalone Voice Karaoke shared display | `<base>/karaoke.html?display=1&room=4821` with the event paused and Karaoke enabled; no display pairing is required |
| Standalone Voice Trivia shared display | `<base>/trivia.html?display=1&room=4821` with the event paused and Trivia enabled; callers only, with no browser-player admission or display pairing |
| Standalone Voice Chess shared display | `<base>/chess.html?display=1&room=4821` with the event paused and Chess enabled; one caller against the computer, with no browser moves or display pairing |
| Voice Karaoke local keyboard acceptance | Open `http://localhost:5173/karaoke.html`, press hidden `P`, then use mouse/keyboard controls; public and production origins reject browser singers |
| Standalone Voice Racer browser player | `<base>/play.html?room=4821&name=Ada` |
| Challenge portal | `<base>/challenge/` with the signed 15-minute token in the URL fragment; messaging supplies the complete link |
| Unified editor hub | `<base>/editor` |
| Racer editor | `<base>/editor?game=racer` |
| Monsters arena editor | `<base>/editor?game=battler` |
| Fighter map editor | `<base>/editor?game=fighter` |
| Protected Trivia question editor | `<base>/editor?game=trivia` |
| Racer garage and manifest editor | `<base>/garage` |
| Private activation analytics | `<base>/analytics` |
| Process liveness | `<base>/livez` |
| Health check | `<base>/healthz` |
| Voice webhook | `<base>/voice/incoming` using HTTP POST |
| Legacy voice join alias | `<base>/voice/join` using HTTP POST |
| Voice session-ended callback | `<base>/voice/session-ended` using HTTP POST |
| SMS webhook | `<base>/sms` using HTTP POST |
| Conversation Orchestrator callback | `<base>/tac/webhook` using signed HTTP POST |
| Messaging delivery callback | `<base>/twilio/messaging/status` using HTTP POST; generated requests include signed outbox/attempt query IDs |

Room `4821` belongs only to standalone play. Station launches use the selected game's route with a generated 12-character room code, match ID, and launch generation from the authenticated display projection; operators should not construct station launch URLs manually.

The Fighter browser page is `/fighter.html`; `/fighter` is the Fighter WebSocket upgrade endpoint and is not an HTTP page. Voice Karaoke, Voice Trivia, and Voice Chess follow the same split with `/karaoke.html` plus `/karaoke`, `/trivia.html` plus `/trivia`, and `/chess.html` plus `/chess`. Browser URLs do not accept `hostToken` or display credentials. Only station-managed launches inherit the booth access installed from `/operator`; standalone displays do not pair. `FIGHTER_DISPLAY_TOKEN` remains only a server-side override for custom standalone integrations.

WebSocket endpoints are `/game`, `/battle`, `/fighter`, `/karaoke`, `/trivia`, `/chess`, `/karaoke-media`, and `/voice`. `/trivia` and `/chess` accept same-origin display upgrades and are not HTTP smoke targets. `/karaoke-media` accepts only signed, query-free Twilio upgrades and one-use call-bound attempt tokens. The same Node server also serves `/api/*`, `/assets/*`, `/fighter-previews/*`, `/audio/*`, `/video/*`, `/brand/*`, and `/fonts/*`. The six home-card gameplay previews, including Chess, are bundled with the built client.

### Trivia content and leaderboard security

Voice Trivia supports one to four simultaneous callers and no AI fallback. A round contains eight questions. After the three-second round countdown and after every reveal, the room publishes `question` and opens its shared 10-second answer window immediately. Relay reads the question and numbered choices concurrently; playback acknowledgement never gates or shifts the timer, and caller speech or DTMF can interrupt and lock while TTS is active. The complete bilingual 200-question bank remains server-side at `data/trivia-questions.json`; it contains correct choice IDs, citations, review metadata, and optional private spoken-alias fields whose arrays are currently empty in the seed. During a question, `/trivia` sends only the current prompt and shuffled choice IDs/text. It sends the correct choice and explanation only in the reveal phase, never sends private aliases or future questions, and rejects browser-originated player answers. Final phone narration uses the same normalized leaderboard scores as the final display and persisted leaderboard.

Completed rounds append to `data/trivia-leaderboard.json`. The public `GET /api/trivia/leaderboard?board=all-time&limit=10` projection returns only rank, display name, normalized score, category, and played-at timestamp; `board` may instead name one of the eight concrete categories and `limit` must be 1-100. Internal player/result IDs and tie-break fields remain private; player identities are keyed with a salt derived from the existing deployment signing secret. Mixed rounds appear on `all-time` but do not have a separate public board.

### Karaoke media handoff, scoring, and privacy

Conversation Relay owns caller setup and consent. Once the display has preloaded the selected backing track and reports ready, the server sends Relay a Karaoke `end` handoff. Twilio posts the call-bound `HandoffData` to `/voice/session-ended`; the server validates the account, call, room, singer, song, locale, and loading generation, issues one-use credentials, and returns TwiML that starts only `inbound_track` on `/karaoke-media`. The countdown begins only after the authenticated Media Stream start frame and display are both ready. After the 3-second countdown and 45-second performance, Twilio stops the stream, calls `/voice/karaoke/complete`, and receives new Conversation Relay TwiML for the spoken result. Stream status callbacks go to `/voice/karaoke/stream-status`.

The Media Stream parser treats bounded, non-empty Twilio `connected.protocol` and `connected.version` values as informational for compatibility, including observed `Call` versions `1.0` and `1.0.0`. It remains strict about connected/start/media/stop order, sequence and chunk continuity, stream/account/call identity, inbound-only audio, and `audio/x-mulaw` 8 kHz mono format.

Voice Karaoke scores caller input as exactly 50% timing, 30% recognized lyrics, and 20% pitch. Locally detected voice activity is the acoustic gate, so silence scores zero. With lyric recognition available, a chart-word match contributes its provider confidence to the lyric component and scales timing and pitch from 70% with no match to 100% at confidence `1.0`; missing lyric evidence is not a hard miss. The phone-oriented defaults allow 200 ms early and 250 ms late timing falloff, align an exact normalized lyric within 650 ms, and reduce pitch credit across a 200-cent nearest-octave error. Pitch is octave-invariant so different vocal ranges are scored against the same melodic contour. The 50/30/20 weights are never renormalized. Karaoke is enabled in fresh Arcade configuration, and production fails closed without its required lyric provider.

When `DEEPGRAM_API_KEY` is configured, the server opens a direct monolingual Deepgram Nova-3 streaming WebSocket for each authenticated Karaoke Media Stream. It repeats up to 50 unique chart words of 4-64 characters as unweighted `keyterm` parameters and sends only live inbound caller mu-law audio at 8 kHz. The browser backing track, instrumental URL, and outbound audio are never sent. Audio and recognized provider words remain bounded in process memory; the application does not log or persist raw audio or recognized transcripts. Deepgram source timestamps and confidences are reduced to per-chart-word scalar scoring evidence. At Twilio stop, the server sends Deepgram `Finalize` and `CloseStream` and waits at most 2.5 seconds. Only final lyric evidence is committed; timeout, malformed provider output, or provider failure rejects the performance score rather than accepting interim evidence.

Calibrate `KARAOKE_CALIBRATION_OFFSET_MS` with several representative handset/carrier calls in the actual venue, not one singer. Start at `0`, compare chart targets with observed aggregate behavior, and change it in small increments: use a negative value when observations are consistently mapped late and a positive value when they are consistently mapped early. `/healthz` reports the active offset. Each completed attempt emits one `[karaoke] score finalized` line with score acceptance, total/voiced/recognized word counts, voiced and pitch-detection ratios, timing/lyric/pitch component aggregates, and `calibrationMs`; use population trends rather than raw transcripts or one performance. See [Voice setup](./voice-setup.md#calibration-and-chart-timing) for the authoring workflow and [Infrastructure setup](./INFRA_SETUP.md#deepgram-billing-and-privacy) for current provider pricing.

Deepgram is a third-party audio processor. Before operating Karaoke, confirm participant notice/consent, the Deepgram account's region, retention and model-improvement settings, contractual data-processing terms, and applicable voice/biometric and child-privacy requirements. Application non-persistence does not control Deepgram's own service-side handling. The deployment and production startup fail closed without the configured key.

Outbound station notices use a schema-versioned transactional outbox in `arcade-state.json`. The single-replica worker persists an attempt before calling Twilio, makes at most five total delivery attempts with bounded transient backoff, expires stale notices, and retains terminal delivery records for 30 days. Before every attempt it revalidates admitted, overflow, call-now, results, and next-game notices against current station state so leave, reset, launch failure, promotion, and completion transitions cannot send obsolete instructions.

WhatsApp free-form delivery is limited to 24 hours after the last inbound message with a five-minute safety margin. Outside that safe window, the notice requires its approved Content SID. Call-now uses three explicit states: a configured approved SID sends the localized Phone CTA template inside or outside the window; a missing SID inside the window sends the free-form locale Voice number and Phone-app instruction; a missing SID outside the window suppresses the notice with `WHATSAPP_TEMPLATE_REQUIRED`. A Voice-number or locale change also suppresses a pending stale call-now notice.

Results always supply template variable `{{1}}` for the localized game name and supply `{{2}}` only when paid-mode balance inclusion emits a balance. One Content SID serves all result configurations, so `{{1}}`-only is the safe general template contract; making `{{2}}` mandatory breaks free-play or balance-off sends. Challenge-bearing result notices deliberately set no Content SID because the conditional challenge prompt does not fit that approved template contract. They send to WhatsApp only as in-window free-form content and suppress outside the window. `CHALLENGE_REWARD` notices have the same out-of-window limitation.

The operator console distinguishes inbound SMS/WhatsApp onboarding from proactive notifications and reports the effective outbound state, worker error, status counts, storage capacity, cleanup eligibility, and recent failures from `/api/admin/arcade/status`. Signed inbound messages are limited per address and across the single process before a new messaging identity can be created; durable provider-SID replays are resolved before those limits. New identities stop at a guarded count/file watermark rather than reaching the state-store hard maximum.

Inactive anonymous messaging players and incomplete drafts become cleanup candidates after 30 days. Each inbound transaction prunes at most 100 oldest candidates. Cleanup is fail-closed: it retains completed lead profiles, CRM/conversation profiles, marketing consent, any wallet balance or economic history, queue or station history, ready/match state, non-messaging idempotency dependencies, and outbound notifications. Inbound receipts tied only to a deleted anonymous identity are deleted with it. Effective outbound delivery requires the literal kill switch, valid REST credentials, an enabled runtime channel, and its configured sender; mode `off` or a false kill switch enqueue and send nothing. An operator can explicitly retry a still-current `FAILED`/undelivered notice only while it is unexpired and has an attempt remaining. Retry requests require same-origin POST, a reason, and an idempotency key; the transition and actor/reason are committed atomically to the bounded messaging audit introduced in schema v10. Provider-terminal failures never auto-retry, and ambiguous provider acceptance is never eligible for operator retry.

### Arcade Configuration V8 and State V11

Configuration schema v8 adds Chess to the six-game station enablement, automatic-selection order, and one-coin game-cost maps. Fresh and migrated settings enable Chess. A strict v7 configuration keeps its existing game settings and order, then appends Chess; persisted bytes and audit hashes stay intact until the next authenticated update writes a v8 record. Earlier migrations still apply, including the v6-to-v7 Trivia migration that adds Trivia disabled and retains `station.comingSoon.trivia.enabled=false` as a compatibility tombstone.

State schema v11 permits Trivia and Chess identities in persisted station votes, assignments, matches, and results. Valid schema-v1 through v10 state is promoted in memory and written as v11 on the next transaction. A file labeled v10 but already containing Trivia station identity fails closed rather than being misinterpreted as pre-promotion data.

Older application revisions can reject v8 configuration or Chess-bearing state. Activate the new writer only after the rollback release can read its data, or retain the pre-rollout Azure Files snapshot for a stop-the-writer rollback. Never edit a schema version by hand or restore a snapshot after the candidate may have accepted public interactions or produced Twilio side effects.

## Editor writes

`/editor` is a hub for Racer levels, the Monsters arena, Fighter maps, Karaoke venue/timing authoring, and the protected Trivia bank. `EDITOR_TOKEN` protects all write operations. Most existing editor reads remain public, but the complete Trivia bank is protected on both read and write because it contains answers and optional private recognition-alias fields. The browser accepts the token through its prompt or an initial `#token=` fragment, stores it in local storage, immediately scrubs the fragment, and sends it as `x-editor-token`. A query parameter named `token` is scrubbed without being accepted; editor links and API requests never propagate credentials. Server write APIs do not accept a query-string token.

The Karaoke word-timing tool is `/editor?game=karaoke&tool=timing`. It loads the live sparse overrides with an ETag, overlays them on the compiled catalog, and provides waveform playback, word/section preview, 10/100 ms nudges, boundary drags, group moves, and per-word or per-song reset. **Save timings** sends `If-Match` plus the editor token, writes `data/karaoke-timings.json` atomically on Azure Files, and applies the new chart only to future performances. A concurrent edit returns `412`; reload before saving rather than overwriting it. Missing or invalid live timing data logs `[karaoke-timings] invalid live config; using compiled timings` and falls back to the image's compiled chart.

The Trivia tool is `/editor?game=trivia`. `GET /api/trivia-questions` requires `x-editor-token`, returns `Cache-Control: no-store`, an ETag, and a content revision, and honors exact `If-None-Match` with `304`. Private aliases are optional with at most 12 per localized choice. Original authorship provenance is read-only and preserved in every emitted payload; changing editable facts invalidates reviewer/date/fact-check metadata until explicitly reconfirmed. Before saving, the browser strictly validates all 200 bilingual questions. `POST /api/trivia-questions` requires the same token and exact current `If-Match`; a missing precondition returns `428`, stale content returns `412` with the current ETag, and invalid content returns `400` without changing the file. A successful save durably replaces `data/trivia-questions.json` and applies only to rooms created afterward; active rooms retain their creation-time bank.

The editor can change persistent JSON and generated Fighter previews, but it cannot upload required GLB or FBX runtime assets. Add those files to the repository, ensure LFS tracks the applicable Fighter paths, and deploy a new image.

## Actual npm scripts

| Command | Function |
|---|---|
| `npm test` | Run Vitest once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run typecheck` | Typecheck server/shared code and the client project |
| `npm run dev:server` | Run `server/index.ts` with `tsx watch` |
| `npm run dev:client` | Run Vite with `client` as its root |
| `npm run build` | Typecheck both projects and build the Vite client |
| `npm run make-fixtures` | Run the fixture generator |
| `npm run inspect-assets` | Inspect runtime assets |
| `npm run optimize-assets` | Optimize assets |
| `npm run verify:fighter-asset-pointers` | Verify committed Fighter LFS pointers without materializing binaries |
| `npm run verify:fighter-assets` | Verify materialized Fighter assets against their LFS pointers |
| `npm run validate:trivia-bank` | Strictly validate the bundled 200-question production bank and per-category counts |
| `npm run sync:fighter-assets` | Verify and upload the immutable Fighter asset bundle to the private Blob mirror |
| `npm run smoke` | Run the browser render smoke script |
| `npm run smoke:editor` | Run the editor smoke script |
| `npm run smoke:karaoke-editor` | Run the Karaoke venue/timing editor browser smoke script |
| `npm run smoke:trivia` | Run the deterministic Voice Trivia display smoke against an already-running Vite client |

CI verifies Fighter pointers, then runs `typecheck`, `test`, `build`, and an informational high-severity dependency audit. It does not invoke `validate:trivia-bank` separately or run browser smoke scripts; the test suite still strictly parses and audits the production Trivia bank. The deployment job runs the explicit validator before typecheck.

## Voice Trivia verification

Run the same validation sequence used by the deployment job:

```bash
npm ci
npm run verify:fighter-asset-pointers
npm run validate:trivia-bank
npm run typecheck
npm test
npm run build
```

For the desktop/mobile display smoke, start Vite in one terminal:

```bash
npm run dev:client
```

Then run the deterministic browser smoke in a second terminal. It uses Google Chrome at the macOS default path and injects server-safe public Trivia projections, so it does not require Twilio or a running game server:

```bash
npm run smoke:trivia
```

## Local production-mode check

```bash
npm ci
npm run build
ARCADE_SIGNING_SECRET="$(openssl rand -hex 32)" \
EDITOR_TOKEN="$(openssl rand -hex 32)" \
DEEPGRAM_API_KEY=local-production-check \
TWILIO_VALIDATE_SIGNATURES=false \
PORT=8099 NODE_ENV=production npx tsx server/index.ts
curl --fail http://localhost:8099/healthz
```

The synthetic Deepgram value is only for startup validation. Do not place a Karaoke call during this local check.

In production, Twilio signature validation defaults on and the deployment requires `TWILIO_AUTH_TOKEN`. Outside production it defaults off unless a Twilio token is present or `TWILIO_VALIDATE_SIGNATURES=true`. Without the primary token, SMS, WhatsApp, TAC, and messaging-status webhooks fail with status 500; Voice requests can still validate with `TWILIO_PT_AUTH_TOKEN`. The deployed `ARCADE_STANDALONE_VOICE_ENABLED=true` setting permits routing to the most recently registered eligible open display; no eligible display returns unavailable TwiML and never defaults to Racer.

## Rollback

Automatic rollback is conditional, not universal:

| Failure point | Workflow behavior |
|---|---|
| Before a candidate can make external or public durable changes | Stops every non-previous revision, waits for zero replicas, restores and byte-verifies the pre-rollout Azure Files snapshot, reactivates the previous revision, pins it to 100% traffic, and leaves the app in `Multiple` mode |
| After outbound delivery may start or public traffic is admitted | Does not restore data or switch revisions automatically; leaves current data and revision state intact for manual recovery |
| First deployment with no previous revision | Stops incomplete revisions and leaves no serving revision |

A successful deployment alone restores exact `Single` mode. An automatic rollback intentionally remains in `Multiple` mode with the previous revision pinned, so the next normal deployment can inspect that unambiguous recovery topology.

For an operator-initiated rollback, first inventory every revision and verify the full expected SHA image:

```bash
az containerapp revision list \
  --name twilio-games \
  --resource-group rg-twilio-games \
  --all \
  --query '[].{name:name,image:properties.template.containers[0].image,provisioning:properties.provisioningState,health:properties.healthState,active:properties.active,replicas:properties.replicas}' \
  --output table
```

Use the same zero-overlap invariants as the workflow:

1. Confirm exactly one current writer and verify that the target revision references `twiliogames.azurecr.io/twilio-games:<full-old-commit-sha>`. A commit tag is conventional, not registry-enforced immutability.
2. Verify schema and secret compatibility. Container App secrets are application-scoped, so reactivating an old revision does not restore its former Twilio, Google, Relay, editor, signing, display, OpenAI, Deepgram, or Dub values.
3. Switch to `Multiple`, explicitly pin 100% traffic to the current revision, deactivate it, and wait until it is inactive with zero replicas. This creates a planned outage and preserves the single-writer guarantee.
4. Take and retain an Azure Files share snapshot after the current writer stops.
5. Activate only the target revision. Wait for `Provisioned`, `Healthy`, and one replica, then use its revision-specific FQDN for read-only `/livez`, `/healthz`, `/`, `/instructions`, `/join`, `/player`, `/karaoke.html`, `/trivia.html`, `/chess.html`, and `/analytics` checks plus the `/operator` authentication redirect check.
6. Pin 100% public traffic to the verified target and keep `Multiple` mode. Do not switch to `Single`, because Azure can select the newer revision that the rollback is replacing.
7. If target validation fails, stop it and wait for zero replicas before considering the previous writer. Restore the snapshot only when no public request, webhook, worker, or external Twilio side effect could have occurred. Otherwise retain current data and perform a compatibility-aware forward recovery.

Never run `az containerapp update --image` while a writer is active, start schema-older code against configuration v8 or Chess-bearing state v11, overlap revisions on the mounted JSON stores, or restore a snapshot after accepted external activity.
