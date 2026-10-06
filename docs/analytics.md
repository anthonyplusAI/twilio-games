# Activation Analytics

The private `/analytics` dashboard reports engagement for all six playable titles: Voice Racer, Voice Monsters, Voice Fighter, Voice Karaoke, Voice Trivia, and Voice Chess. It provides summary metrics, UTC daily trends, per-game performance, popular selections, generated takeaways, and downloadable PDF reports.

## Authentication Setup

The dashboard accepts either Google OAuth or an event admin PIN. Both methods create the same session, which authorizes private analytics and the operator console.

### Google OAuth

Create an OAuth 2.0 Web application client in Google Cloud Console. Add each redirect URI that the deployment uses:

| Environment | Authorized redirect URI |
|---|---|
| Production | `https://<app-fqdn>/auth/google/callback` |
| Local server | `http://localhost:8080/auth/google/callback` |

The redirect URI must exactly match `PUBLIC_BASE_URL` plus `/auth/google/callback`.

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth web client secret |
| `ANALYTICS_ADMIN_PIN` | 6-64 character admin PIN for analytics and operator access; letters, numbers, and special characters are accepted; keep it in a secret store |
| `ANALYTICS_ALLOWED_EMAIL` | Optional exact external email that may read analytics |
| `ANALYTICS_PATH` | Rollup file path; defaults to `data/analytics.json` |

The deployment workflow reads the client ID, client secret, and optional admin PIN from GitHub Actions secrets. It reads `ANALYTICS_ALLOWED_EMAIL` from a repository variable.

If an allowed account is outside Twilio Google Workspace, the OAuth application's audience must permit it. A Workspace-internal OAuth application can block the account before the application evaluates either allowlist.

## Authentication And Authorization

1. `GET /auth/google` creates a random OAuth state, retains it in memory for ten minutes, and sends the value in an HTTP-only, SameSite=Lax cookie.
2. Google redirects to `/auth/google/callback`; the server validates the state and cookie, exchanges the code, reads userinfo, and requires `email_verified: true`.
3. A verified `@twilio.com` address or the exact `ANALYTICS_ALLOWED_EMAIL` may receive an application session.
4. Alternatively, `POST /auth/pin` compares the supplied PIN with `ANALYTICS_ADMIN_PIN` in constant time. Five failures from one client lock that client out of PIN attempts for 15 minutes; Google remains available when configured.
5. Either successful method stores an opaque random session in memory for eight hours and sends only its ID in an HTTP-only, SameSite=Lax cookie.
6. Analytics authorization is narrower: only an accepted Google identity or the configured admin PIN may request reports.

`/operator` and every `/api/admin/` route require this same session in production. Unauthenticated operator page requests redirect to this login screen and return to `/operator` after either login method succeeds. Expired admin API sessions return `401`, causing the operator client to return to login. Credential-free access remains available only for non-production loopback development.

OAuth state and session cookies include `Secure` only when the configured redirect URI uses HTTPS. Local HTTP cookies remain HTTP-only and SameSite=Lax without `Secure`. Google credentials and the admin PIN never reach dashboard JavaScript. A process restart clears OAuth state, PIN rate-limit state, and active sessions.

## Session Status

`GET /api/analytics/session` always returns no-store JSON describing the current browser session:

| Field | Meaning |
|---|---|
| `authenticated` | The session cookie maps to a live eight-hour application session |
| `analyticsAuthorized` | That authenticated identity may use analytics and operator endpoints |
| `configured` | At least one authentication method is configured |
| `googleConfigured` | Both Google OAuth client ID and client secret are present |
| `pinConfigured` | A valid `ANALYTICS_ADMIN_PIN` is present |
| `email` | Normalized Google email or `Admin PIN`; omitted when no session is authenticated |

Clients check both `authenticated` and `analyticsAuthorized` before displaying the dashboard.

## Metrics

Collection occurs at authoritative game-state transitions. Spectator connections and browser refreshes do not create sessions.

| Metric | Definition |
|---|---|
| Engaged participants | Distinct pseudonymous participant keys in the selected UTC buckets and games; this is not identity resolution across people or devices |
| Sessions | Active races, battles, fights, Karaoke performances, Trivia generations, or Chess matches that were later recorded as completed or abandoned |
| Completed | Racer result with at least one finisher, Monsters result, Fighter victory/results transition, finalized Karaoke result, Voice Trivia results for the tracked generation, or a finished Chess match |
| Abandoned | A tracked active match that left gameplay without its completed terminal transition |
| Active play time | Rounded elapsed seconds from the tracked gameplay start until completion or abandonment |
| Voice commands | Accepted semantic commands; for Karaoke these are setup actions only, never sung words, raw speech, or transcripts |
| Selections | Aggregate map, song, Trivia category, monster/fighter, and Racer vehicle values stored with recorded sessions; Chess has no selection dimension |

For every recorded match, `sessions` increases once and exactly one of `completed` or `abandoned` increases. Completion rate is `completed / sessions`; average session time is `playSeconds / sessions`. A session is assigned to the UTC date on which it is recorded, usually its completion or abandonment date. Voice commands use the UTC date on which the command is accepted.

### Voice Karaoke collection

A Karaoke session starts for analytics only when a real singer has a selected song, a positive loading generation, a performance start timestamp, and the room reaches `performing` or `finalizing`. Loading, audio preflight, countdown, failed pre-performance handoff, and a loading retry do not create a session. A result for the same generation records one completed session; leaving, reset, stream/provider failure, or room removal after performance start records one abandoned session. Repeated abort notifications are idempotent. The selected song ID is counted in `selections.songs`, and active play time runs from the authoritative performance start to completion or abandonment.

Karaoke `voiceCommands` counts only accepted semantic setup actions: name confirmation when needed, opening song selection, selecting a song, consenting with `start`, and standalone `sing again`. Station callers with an authoritative registered name do not generate an extra name-confirmation action. Singing audio, recognized lyric words, interim/final transcripts, word judgments, score, combo, component confidence, pitch, calibration diagnostics, display connections, and Media Stream frames are not analytics events. The separate Karaoke leaderboard persists the final name/song/score result and is not part of `data/analytics.json`.

The store hashes participant-slot keys with SHA-256 and a server-side salt before persistence. A Karaoke key is scoped to game, room, and singer slot, so participant counts are pseudonymous activation counts rather than cross-room identity resolution. It does not persist Google emails, phone numbers, display names, transcripts, raw audio, recognized lyrics, scores, scoring diagnostics, OAuth tokens, access tokens, or LLM text.

### Voice Trivia collection

A Trivia session starts when a positive loading generation has a selected category and first reaches `loading`, `countdown`, `question`, or `reveal`. Its active play time therefore begins at the first observed qualifying phase, normally `loading`, not at the first answer. Results for that same generation record one completed session. Replacing a live generation or observing it leave those phases without matching results records one abandoned session; explicit station/room abort follows the same rule. A loading retry abandons the prior generation and starts the replacement generation. A temporary caller disconnect does not itself finish the session, and repeated state or abort notifications remain idempotent. Legacy prompt/cue phase values remain recognized for compatibility but normal room flow does not emit them.

Each tracked generation increments `selections.categories` once, including abandoned generations and each side of a loading retry. Concrete and `mixed` category IDs are retained as aggregate counts. The `game=trivia` dashboard/API/PDF filter applies to summary, trend, selection, and insight calculations, while the report's `games` object still contains all six titles for the requested dates.

Trivia `voiceCommands` counts only accepted semantic mutations: a required name confirmation, each accepted category vote or revision, each accepted final answer, and explicit play-again from results. Help, rejected or interim recognition, question prompts, browser/display messages, and automatic phase changes do not count. Question text, choices, submitted answers, correctness events, scores, transcripts, and recognition payloads are not passed to `AnalyticsStore` or persisted.

Trivia participant keys use game, room, and stable caller-slot order before SHA-256 hashing. The raw room and slot values exist only in that pre-hash key and are not persisted. The rollup therefore supports pseudonymous per-room activation counts, not cross-room identity resolution. Display names and the separate `data/trivia-leaderboard.json` rows are not copied into `data/analytics.json`.

### Voice Chess collection

A Chess session starts when a connected caller's room first reaches `playing` or `pending`. A finished result records one completed session whether the caller wins, loses, or draws. A terminal call end or room retirement records one abandoned session if play began without a result. A temporary disconnect during the reconnect grace does not end the session. An accepted standalone `play again` creates a new game ID and therefore a new session when play resumes.

Chess `voiceCommands` counts accepted piece or square selection, legal move proposals, confirmation, cancellation, help, and standalone restart. Rejected speech, interim recognition, computer moves, display messages, and animations do not count. Analytics records no move list, captured piece, check, result score, transcript, phone number, or leaderboard row. The authoritative station result retains the caller's win, loss, or draw for the active event.

The active session's in-memory participant key uses the caller's call SID. `AnalyticsStore` hashes that key with its server-side salt before persistence, so two callers who play successive matches in the same room count separately without storing their call SIDs or display names. The `game=chess` dashboard/API/PDF filter applies to summary, trends, and per-game metrics; Chess contributes no selections.

## Retention

Each new analytics write prunes date keys older than the UTC date produced by `Date.now() - 730 days`. The cutoff date remains, as does the current date, so a continuously active store can contain up to 731 inclusive UTC day buckets. `MAX_DAYS = 730` expresses the age cutoff, not a maximum of 730 stored labels.

Loading the file does not prune it immediately. Older keys already on disk remain until a new match or voice command schedules persistence. Reports only read the dates explicitly requested, so retained out-of-range keys do not enter a report.

Writes are coalesced for 250 ms and serialized through an atomic temporary-file rename. In production `ANALYTICS_PATH` defaults to `data/analytics.json` on Azure Files. A persistence failure logs `[analytics] persist failed:`; the process keeps serving, so monitor that marker and verify the mount rather than assuming the dashboard is durable.

## Report APIs

| Endpoint | Purpose | Authorization |
|---|---|---|
| `GET /api/analytics/session` | Current authentication and authorization state | Public status response |
| `POST /auth/pin` | Exchange the configured admin PIN for an analytics session | Public, rate limited |
| `GET /api/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&game=all` | Filtered report JSON | Analytics-authorized session |
| `GET /api/analytics.pdf?...` | A PDF generated from the same report model and filters | Analytics-authorized session |
| `POST /auth/logout` | Deletes the in-memory session and expires its cookie | Current cookie, if present |

The report endpoints return `Cache-Control: no-store`. They return `401` whenever the session lacks analytics authorization.

Dates use strict `YYYY-MM-DD` UTC labels and include both endpoints. Omitting `from` defaults it to 29 UTC days before the current date; omitting `to` defaults it to the current UTC date, producing a 30-bucket default report. A supplied malformed date returns `400` instead of falling back.

The range validator limits the elapsed gap between `from` and `to` to 366 days. Because the endpoints are inclusive, the largest accepted request contains 367 UTC date buckets. A reversed range or a gap greater than 366 days returns `400`.

Valid game filters are `all`, `racer`, `monsters`, `fighter`, `karaoke`, `trivia`, and `chess`. The filter controls summary metrics, trends, selections, and insights. The `games` object still reports each game's metrics for the requested date range so the dashboard can show the full six-title comparison.
