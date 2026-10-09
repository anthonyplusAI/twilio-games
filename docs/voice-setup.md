# Voice Setup

This guide configures the locale-specific Twilio numbers used by Voice Racer, Voice Monsters, Voice Fighter, Voice Karaoke, Voice Trivia, and Voice Chess. For the project overview and general development setup, see the [README](../README.md).

## How Calls Are Routed

Configure the Twilio number's incoming voice webhook as:

| Setting | Value |
|---|---|
| Handler | Webhook |
| URL | `https://<public-host>/voice/incoming` |
| Method | `POST` |

`POST /voice/incoming` connects an admitted active-event call directly to Conversation Relay. It does not gather a room code. When the event is paused, the server ignores retained station state and either routes an explicitly enabled standalone call or returns localized unavailable TwiML and hangs up.

In station mode, the server resolves the caller to one persisted admitted player and places the game, engine room, ready-entry ID, match ID, and launch generation in Relay custom parameters. These values are not signed claims. A dedicated `VOICE_RELAY_TOKEN` authenticates the Relay setup frame, and the server revalidates the call SID and every station parameter against the current call binding and persisted match before joining the room. Recent-display routing is used only for standalone Voice:

| Display | Local URL | WebSocket |
|---|---|---|
| Voice Racer | `http://localhost:5173/play.html?display=1&room=4821` | `/game` |
| Voice Monsters | `http://localhost:5173/monsters.html?display=1&room=4821` | `/battle` |
| Voice Fighter | `http://localhost:5173/fighter.html?display=1&room=4821` | `/fighter` |
| Voice Karaoke | `http://localhost:5173/karaoke.html?display=1&room=4821` | `/karaoke` and `/karaoke-media` |
| Voice Trivia | `http://localhost:5173/trivia.html?display=1&room=4821` | `/trivia` |
| Voice Chess | `http://localhost:5173/chess.html?display=1&room=4821` | `/chess` |

Room `4821` is the standalone room only. Active station matches use generated 12-character engine room codes.

For standalone testing, pause the event, open the intended shared display before placing the call, and close unused game displays. An eligible display must belong to an operator-enabled game, connect as `display=1`, join the call's room, and remain open. A connected socket that has not joined the room cannot claim the call. Standalone room `4821` does not use operator pairing or validate the station display token, so expose standalone routing only in a controlled deployment. Generated station rooms are different: their display must inherit the authenticated `ARCADE_DISPLAY_TOKEN` capability installed by `/operator`. Multiple independent eligible display tabs are ambiguous even when they show the same game and receive unavailable TwiML; navigating one tab to another game can hand off its display binding.

The selected game is passed to `/voice` as a Conversation Relay custom parameter and remains fixed for that call. `POST /voice/join` is a legacy alias: it uses a posted `Digits` value when present and otherwise uses `4821`. Non-default Trivia and Chess rooms require a room-authenticated display; the stock standalone pages use `4821`. Do not configure new numbers to use `/voice/join`.

When Conversation Relay ends a session, Twilio calls `POST /voice/session-ended`. The server uses the call SID to recover or clean up all six games.

## Requirements

- Node.js 22.13 or later
- A primary Twilio account with the English Voice number, a separate SMS-capable number, and an approved WhatsApp sender required for preferred Portuguese Messaging entry; lead-capture mode retains a browser fallback
- A second Twilio account with the Portuguese Voice number
- Both account Auth Tokens for webhook signature validation
- A Deepgram project and server-side API key for production Karaoke Nova-3 streaming lyric verification
- A public HTTPS URL that forwards to the server on port `8080`
- A public WebSocket path on the same host; the server derives `wss://<public-host>/voice` from `PUBLIC_BASE_URL`

The direct Conversation Relay gameplay path does not use the Twilio Account SID itself. The production station also enables TAC/Memory and therefore requires the primary account REST credentials documented in [Infrastructure Setup](INFRA_SETUP.md). Voice webhook and session-ended signatures are accepted when either configured Voice account Auth Token validates the request; the exact dialed `To` number then selects `en-US` or `pt-BR`. The signing token does not select the locale. Station mode uses the operator-configured locale Voice numbers; `GAME_PHONE_NUMBER` is only a legacy fallback. `TWILIO_SMS_NUMBER` is the independent primary-account TAC/SMS sender.

## Run Locally With a Public Tunnel

Install dependencies and start the server:

```bash
npm install

PUBLIC_BASE_URL=https://<public-host> \
TWILIO_AUTH_TOKEN=<auth-token> \
VOICE_RELAY_TOKEN=<independent-random-token> \
DEEPGRAM_API_KEY=<deepgram-api-key> \
GAME_PHONE_NUMBER=<e164-number> \
PORT=8080 \
npm run dev:server
```

Start the client in another terminal:

```bash
GAME_SERVER_EXPECTED_ORIGIN=https://<public-host> npm run dev:client
```

Expose port `8080` through one public HTTPS tunnel. Examples:

```bash
# Cloudflare quick tunnel
cloudflared tunnel --url http://localhost:8080

# ngrok
ngrok http 8080
```

VS Code public port forwarding also works. Forward port `8080`, set its visibility to public, and use its HTTPS URL as `PUBLIC_BASE_URL`. Do not tunnel the Vite port. Twilio must reach the Node server, which owns the webhooks and `/voice` WebSocket.

If the tunnel URL changes, update server-side `PUBLIC_BASE_URL`, update client-side `GAME_SERVER_EXPECTED_ORIGIN`, restart both development processes, and update the Twilio webhook. Twilio signs the exact public webhook URL, so the configured URL and `PUBLIC_BASE_URL` must match, including the scheme and host.

For a deployed environment, configure the same `POST /voice/incoming` webhook against the deployed host. See [Infrastructure Setup](INFRA_SETUP.md) and [Deployment](DEPLOYMENT.md).

## Environment Variables

| Variable | Required | Behavior |
|---|---|---|
| `PUBLIC_BASE_URL` | Yes for live calls | Public origin used to build webhook validation URLs, `wss://.../voice`, and `/voice/session-ended`. Defaults to local HTTP and is not usable by Twilio. A trailing slash is removed. |
| `TWILIO_AUTH_TOKEN` | Yes for a public Twilio webhook | Validates Twilio signatures. When present, validation is enabled by default. |
| `TWILIO_PT_AUTH_TOKEN` | Required for the current production topology | Validates Voice and session-ended callbacks from the separate Portuguese Voice account. |
| `TWILIO_VALIDATE_SIGNATURES` | No | Set to `false` only for controlled local testing. Any other supplied value enables validation. Without `TWILIO_AUTH_TOKEN`, primary-account Messaging, TAC, and status webhooks return `500`; Voice requests can still validate with `TWILIO_PT_AUTH_TOKEN`. |
| `GAME_PHONE_NUMBER` | Optional | Legacy lobby fallback until locale-specific voice numbers are saved in Arcade runtime settings. |
| `TWILIO_SMS_NUMBER` | Required by production deployment | SMS-capable sender/receiver registered with TAC and used by the join chooser and outbound notices. |
| `PORT` | No | HTTP and WebSocket port. Defaults to `8080`. |
| `CR_TTS_VOICE` | No | English ElevenLabs voice ID for every game's Conversation Relay talk-back. Defaults to `SA7eD52NRr8WAehitVt1`; deployment pins that value. |
| `CR_TTS_VOICE_PT_BR` | No | Optional Brazilian Portuguese ElevenLabs voice ID. Empty uses Relay's `pt-BR` default. |
| `DEFAULT_LOCALE` | No | Fallback when the dialed `To` number does not identify one locale and the selected display does not provide one. Defaults to `en-US`. |
| `ARCADE_STANDALONE_VOICE_ENABLED` | No | Set to `true` to permit standalone routing to an eligible open shared display. It does not make a game callable without a display. Production sets this to `true`. |
| `VOICE_RELAY_TOKEN` | Required by production deployment | Independent token of at least 32 characters that authenticates the Conversation Relay `setup` frame. The generated TwiML passes it to Twilio automatically; do not reuse `TWILIO_AUTH_TOKEN`. |
| `OPENAI_API_KEY` | Required for production | Enables phase-bound semantic interpretation of conversational commands in all six games, including Portuguese. Local runs without it retain deterministic commands. |
| `OPENAI_MODEL` | No | Overrides the OpenAI model when `OPENAI_API_KEY` is set. |
| `DEEPGRAM_API_KEY` | Required in production | Direct monolingual Nova-3 streaming lyric recognition with chart keyterms for Voice Karaoke. Production startup and deployment fail closed when missing because Karaoke is enabled by default. |
| `KARAOKE_CALIBRATION_OFFSET_MS` | No | Measured signed handset/carrier scoring offset from `-5000` to `5000`; defaults to `0`. Positive maps observations later and negative maps them earlier. |
| `ARCADE_DISPLAY_TOKEN` | Required for production station displays | Server-held kiosk capability installed into a station tab by `/operator`; standalone room `4821` does not pair or require it. |
| `KARAOKE_TIMINGS_PATH` | No | Persistent sparse timing-override file; defaults to `data/karaoke-timings.json`. |
| `EDITOR_TOKEN` | Required in production | Protects timing-editor and other disk writes. Supply it when prompted or in an initial `#token=` fragment; query-token credentials are ignored. It is not used by the caller or standalone display. |
| `TRIVIA_QUESTIONS_PATH` | No | Live writable Trivia bank; defaults to `data/trivia-questions.json`. A missing file is seeded from `BUNDLED_TRIVIA_QUESTIONS_PATH`. |
| `BUNDLED_TRIVIA_QUESTIONS_PATH` | No | Immutable Trivia seed; defaults to `content/trivia/questions.json`. |
| `TRIVIA_LEADERBOARD_PATH` | No | Persistent normalized Trivia results; defaults to `data/trivia-leaderboard.json`. |
| `FIGHTER_DISPLAY_TOKEN` | No | Server-side standalone override for custom Fighter integrations. Browser URLs do not accept display credentials; station booth access is installed through `/operator`. |
| `NODE_ENV` | No | `production` enables signature validation by default when `TWILIO_VALIDATE_SIGNATURES` is unset, along with production-only warnings and serving behavior. |

Map, arena, and persistence-path overrides are not required to place a voice call. Production startup still requires `EDITOR_TOKEN` so writable editor routes cannot fail open. Production deployment also requires `ARCADE_SIGNING_SECRET`, `ARCADE_DISPLAY_TOKEN`, Google OAuth or `ANALYTICS_ADMIN_PIN`, and the primary TAC/Messaging credentials documented in [Infrastructure Setup](INFRA_SETUP.md).

## Prepare the Karaoke Display

Standalone Karaoke does not pair. Pause the event, open `/karaoke.html?display=1&room=4821`, and leave that eligible display open before dialing. For a station-managed launch, authenticate in the intended booth tab at `/operator` and select **Pair this tab as the big screen**; the same-origin flow stores the display capability only in that tab's `sessionStorage`.

On either production path, select **Enable concert audio** before the first call in that loaded tab. The one-time gesture unmutes and starts Web Audio. Karaoke deliberately withholds display readiness and the countdown while audio is muted, suspended, or not preloaded. Reloading, opening a new tab, or starting a new kiosk browser session can require the gesture again.

## Conversation Relay Configuration

The generated TwiML uses these settings:

| Option | Value | Effect |
|---|---|---|
| `transcriptionProvider` | `Deepgram` | Required transcription provider |
| `speechModel` | `flux` | Low-latency speech recognition |
| `partialPrompts` | `true` | Sends interim transcripts so a newer utterance can cancel stale work; gameplay waits for the final transcript |
| `transcriptionLanguage` | Resolved call locale (`en-US` or `pt-BR`) | Recognition language selected from the dialed number, then display or default fallback |
| `ttsLanguage` | Resolved call locale (`en-US` or `pt-BR`) | Spoken response language selected by the same route |
| `interruptible` | `any` | Caller speech or keypad input stops active TTS |
| `welcomeGreetingInterruptible` | `any` | The initial greeting can also be cut off immediately |
| `reportInputDuringAgentSpeech` | `any` | Delivers speech and keypad input while TTS is playing |
| `interruptSensitivity` | `high` | Responds quickly when callers cut off prompts and menus |
| `ignoreBackchannel` | `false` | Allows short spoken acknowledgments to interrupt the host |
| `dtmfDetection` | `true` | Enables keypad events |
| `speechTimeout` | `600` | End-of-speech timeout used by Relay |
| `eotThreshold` | `0.6` | End-of-turn threshold |

The server supplies localized, game-specific recognition hints. It leaves `welcomeGreeting` empty because each game speaks its own onboarding after the `/voice` WebSocket receives the `setup` frame. See [Localization](localization.md) for locale routing and extension details.

Talk-back is active. Every server `text` message is interruptible and preemptible. Long cues stream as one Conversation Relay talk cycle, with `last=true` only on the final token, so their own chunks cannot cut off earlier audio. [Twilio documents a `tokens-played` event subscription in TwiML](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay), but its [WebSocket message guide](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages) does not specify the acknowledgement payload or timing. The transport uses a matching acknowledgement when available and otherwise estimates speech duration conservatively. Caller input or a new screen state interrupts stale speech. Gameplay never treats the estimate as proof that audio was heard; Karaoke still needs a separate final caller consent before the media handoff.

Speech barge-in stops Relay TTS. Voice Racer and Voice Monsters also invalidate stale in-flight conversational replies. Voice Fighter resets its interim-command state after an interrupt so a corrected command or selection can be recognized cleanly.

## Station Launch And Personal Setup

The persisted match roster supplies a stable slot for every caller: one for Karaoke, up to two for Racer, Monsters, Fighter, or Chess, and up to four for Trivia. The server reuses each registered first name instead of asking for it again; only a station identity without a stored completed name falls back to voice name capture in games that require a name.

Each caller controls only their personal setup choices. Racer, Monsters, and Fighter keep explicit shared phase gates; Racer and Fighter add a voting gate before gameplay. Trivia automatically opens category voting after all expected names and phone prompts are complete and begins loading when every caller has voted and heard their confirmation. Two-caller Chess waits for both names and welcome cues before starting the duel. A one-caller Monsters or Fighter match creates an AI opponent after setup; one-caller Chess faces the computer. Karaoke and Trivia have no AI players.

A station match starts only when the display has acknowledged the current launch generation, the selected engine has started, and every expected caller is connected and bound. The launch timeout is also the setup inactivity window. After all expected callers connect, each final speech prompt or DTMF input from either caller moves that deadline forward by the configured launch timeout; partial transcripts do not. Activity extends setup but does not mark gameplay started or redeem a coin.

At the deadline, a disconnected admitted caller is replaced by the first FIFO overflow caller when one exists. The dropped caller's active reservation is released, the replacement receives admitted and call-now notices, the launch generation increments, display readiness clears, and the game room receives the revised expected count. If no overflow caller exists, the automatic deadline fails the launch. Before gameplay, an operator can instead remove an unconnected caller; the same FIFO promotion applies, or the expected count drops to one when no replacement exists. That one-caller reconciliation enables the solo behavior above.

## Connection Recovery

Racer, Monsters, Fighter, Trivia, and Chess retain the call SID-to-player binding for 30 seconds after a Relay WebSocket disconnect. A replacement WebSocket for the same call SID and room resumes that player and preserves completed choices, Trivia prompt readiness, a locked Trivia answer, or the current Chess position; a normal session-ended callback removes the binding immediately, subject to retaining completed station result state.

This 30-second binding grace is separate from Relay session recovery. When `SessionStatus=failed`, the call remains `in-progress`, and the error is absent or recoverable (`39001`, `64103`, `64105`, `64111`, or `64112`), `/voice/session-ended` can return new Conversation Relay TwiML up to two times. Station recovery refreshes the route when possible and still revalidates the setup against current state. A permanent error, a completed call, or an exhausted recovery count hangs up and clears the bindings.

## Voice Racer

Voice Racer supports up to two callers. Choose the caller count on the standalone home screen or add `players=2` to its display URL before the calls arrive. Standalone play uses room `4821`; station play uses its generated engine room. The shared display keeps each caller's name, car, and track vote visible. During a two-caller race, each car has its own top or bottom chase view with its name, place, lap, and power shown beside it.

The voice flow is:

1. In standalone play, say your name. Station play greets you by your registered first name.
2. After the expected callers connect, confirm their names, and finish the current phone prompts, either player says `start` to open car selection.
3. Each player says their own car name or number.
4. After every player picks a car and finishes the current phone prompt, either player says `next` to open track voting.
5. Each player says their own track name or number. To correct a car or change a vote before advancing, say `actually` followed by the new choice (`na verdade` in Portuguese).
6. After every player votes and finishes the current phone prompt, either player says `start` to begin the race. On a two-caller result screen, both callers say `race again` after hearing their recaps to start another race.

Clear car and track choices use deterministic matching; the optional interpreter handles conversational requests. Callers may make their own choices in either order; either connected caller may speak the phase-advance command after all required choices and phone cues are complete. A two-caller standalone room does not allow Back or display Restart to rewind the other person's menu or race. The result screen waits for both phone recaps and both rematch requests, with each caller's status visible. Unrecognized setup speech receives concise guidance for the current screen. No caller controls another player's choice. Interim-origin tracking, duplicate-final suppression, and a post-transition guard reduce the chance that delayed speech from an earlier phase is interpreted in the next phase; physically shared audio remains an operational risk and callers should avoid speakerphone near each other.

During countdown and racing, finalized transcripts use the fast local intent path. Command bursts can fire in order, while revisable interim hypotheses never mutate the car.

Racer simulates at 60Hz, sends display snapshots at 30Hz, and renders with a 100ms interpolation buffer. Lane changes remain smooth rather than snapping and reach roughly 90% of the new lane in 167ms.

| Action | Speech |
|---|---|
| Move left | `left` |
| Move right | `right` |
| Boost | `boost`, `go` |
| Brake | `brake`, `slow`, `stop` |
| Use power | `nitro`, `power` |

Racer keypad fallback is `1` left, `2` boost, `3` right, `4` brake, and `5` power. Monsters uses its displayed menu numbers and `0` to back out of the move list. Fighter uses `0` for fighter 10, `*` for fighter 11, and `#` for fighter 12; during combat, `1` through `6` map to forward, back, jump, punch, kick, and block.

The caller hears onboarding, menu prompts, the final countdown, `Go`, selected race events, their finish, and a race-over recap. Mid-race commentary is throttled so it does not continuously cover commands. A full standalone room leaves the call connected but unbound, so commands do not move a car; check the server log for `addPlayer rejected`.

## Voice Monsters

Voice Monsters is a one-on-one room with up to two human callers. Choose one or two callers on the standalone home screen or add `players=2` to its display URL. A solo player receives an AI opponent when the battle starts. A late caller can wait for the next round when a battle is already active. If both slots are occupied, the caller hears that the battle is full or in progress.

The voice flow is:

1. In standalone play, say your name. Station play greets you by your registered first name.
2. Each caller says `next` after their name and lobby phone guidance. The shared display opens monster selection when both are ready.
3. Each player says their own monster name, number, or ordinal such as `the second one`.
4. Each caller picks their own monster and says `battle` when ready. The battle begins after both choices and both confirmations.
5. On your turn, say `attack` to hear the four moves, then say a move name or number. `Fight` remains an accepted alias, and a move name can also be spoken directly from the root menu.
6. In standalone play, each caller says `rematch` after hearing the result. The shared result waits for both callers; station play returns to the station results and requeue flow instead.

Root battle commands are:

| Action | Speech | Root number |
|---|---|---|
| Open moves | `attack` (canonical), `fight` (accepted alias) | `1` |
| Guard | `guard`, `block`, `brace`, `defend`, `shield` | `2` |
| Use potion | `item`, `potion`, `heal`, `bag`, `medicine` | `3` |
| Taunt | `taunt`, `mock`, `provoke`, `jeer`, `insult` | `4` |
| Leave move list | `back`, `cancel`, `return`, `never mind`, `undo` | Not applicable |

Inside the move list, numbers `1` through `4` choose the corresponding move. Move names support exact and distinctive partial matches. Battle actions use final transcripts only and are accepted only on the caller's turn. Without interruption, commentary remains paced with the display.

Monster move names can also be spoken directly from the root menu, and combined phrases such as `attack one` or `attack Thunder Jolt` execute the requested move without an extra turn. Monsters talk-back is explicitly interruptible and preemptible: speech, keypad input, or a replacement response cancels queued commentary so stale narration cannot block the caller's next command.

The common 30-second caller binding and up-to-two Relay recovery attempts apply to Monsters.

## Voice Fighter

Voice Fighter accepts up to two humans during the lobby or fighter-selection phase. Choose one or two callers on the standalone home screen or add `players=2` to its display URL. A solo player receives an AI rival. New callers cannot join after setup has moved beyond fighter selection. Each caller owns their fighter choice and arena vote, and every setup screen requires an explicit voice command before advancing.

The voice flow is:

1. In standalone play, say your name. Station play greets you by your registered first name.
2. Listen to the controls and how-to-play instructions while the display remains in the lobby.
3. Each caller says `next` after their own lobby guidance. The shared display opens fighter selection when both are ready.
4. Each player says their own fighter name or number.
5. Each caller chooses a fighter and says `next`. Arena voting opens after both have confirmed.
6. Each player says their own arena name or number, then says `start` when ready. The fight starts after both votes and both confirmations; an arena-vote tie has a deterministic room choice shown on the display.
7. The selected arena loads, then starts the intro and countdown.
8. In standalone play, each caller says `rematch` after hearing the fight result. The shared result waits for both callers; station play returns to the station results and requeue flow instead.

Combat commands are:

| Action | Speech |
|---|---|
| Move toward rival | `forward`, `closer`, `in` |
| Move away | `back`, `backward`, `away` |
| Jump | `jump`, `leap`, `hop` |
| Punch | `punch`, `jab`, `strike`, `hit` |
| Kick | `kick`, `roundhouse` |
| Block | `block`, `guard`, `defend` |

Fighter and arena choices and combat commands act only on finalized transcripts, preventing revised interim speech from firing the wrong move. The parser recognizes chains and repeat phrases, but the room executes one action immediately and retains at most two waiting actions. Waiting commands expire after 2.25 seconds so stale moves cannot fire much later.

Combat locks remain long enough for readable animation, but punch, kick, block, jump, and hit reactions use shorter synchronized timings. Forward and back retain their measured animation durations so movement distance and presentation stay aligned.

The common 30-second caller binding and up-to-two Relay recovery attempts apply to Fighter. Hit and miss cues are throttled, and the phone host narrates the intro, countdown, health context, and result.

## Voice Trivia

Voice Trivia is the fifth default-enabled game and stable station or Messaging option `5`. Station and standalone matches accept 1-4 callers; choose the standalone count on the home screen or add `players=2`, `3`, or `4` to `/trivia.html?display=1&room=4821` (the default is one). Trivia has no AI opponent and keeps question content, scoring, and timing server-authoritative; the optional semantic interpreter maps conversational answers to one of the current visible choices. Station play launches `/trivia.html` with a generated room and the current `station`, `match`, and `launchGeneration`. Both use the same-origin `/trivia?display=1` display WebSocket, while callers remain on `/voice`.

The standalone lobby displays the configured locale's call QR and linked number. Station launches use the station `/join` QR rail, which registers visitors before their assigned call is routed into the game.

The voice flow is:

1. In standalone play, each caller says a first name. Station play greets each caller by the registered first name unless it is missing. The lobby shows who is confirming a name, finishing a phone prompt, or ready. It leaves `lobby` only after all expected callers connect, confirm names, and finish their current setup speech.
2. Each caller votes by category name or spoken number: General Knowledge, Science, Geography, History, Entertainment, Sports, Technology, Twilio, or Mixed. The shared display can cast the currently named unvoted caller's choice. Votes can be revised, and each caller hears their category confirmation. The display shows who is choosing, finishing a phone prompt, or ready; `loading` waits for every vote and its phone confirmation. A unique plurality wins; a tied plurality selects Mixed.
3. `loading` snapshots eight questions and shuffled choices from the current bank. The display must authenticate when station-managed and send readiness for the current generation within 30 seconds. Readiness starts the three-second `countdown`; a timeout returns the room to category voting.
4. After the countdown and each reveal, the server publishes a redacted `question_prompt` and waits for the authenticated display to acknowledge the painted question. Each current caller then hears the question. Once all callers finish or skip that prompt, the shared 25-second answer clock starts with `answer_cue`, before Relay reads the four numbered choices. The display shows the same authoritative countdown while the choices are spoken. Current-attempt and display-revision checks prevent old speech or paint acknowledgments from opening a later question. Relay playback completion uses a conservative duration estimate if no completion event exists. If choice audio fails or outlasts the clock, the room pauses in `audio_problem`. A standalone caller can ask the agent to retry the question, with at most two voice-initiated retries for that question across reconnects; a station round instead needs an authenticated operator to replay it. Neither recovery charges an unheard choice set.
5. Callers may interrupt and answer at any time, including by DTMF `1`-`4`. An answer heard during the pre-clock question prompt is queued only for that question and locks when the shared clock opens; an answer heard while choices are being read locks immediately. Cardinal and ordinal words, conversational phrases, safe letter names, and the visible choice text or private aliases are accepted when unambiguous. Negated, incidental, and multi-choice mentions are rejected. The first valid final answer locks even when wrong; an on-time interim onset may receive its final frame during the 1.5-second transport grace. An unanswered reconnect receives current-question guidance without changing the shared clock; a locked reconnect does not replay it.
6. `reveal` lasts four seconds and discloses the correct answer, explanation, per-player raw-point result, and standings. The cycle repeats for eight questions, then `results` reports raw score, normalized leaderboard score, correct answers, best streak, and rank. Winner, tie, and personal phone lines use the normalized leaderboard score shown on the final display. In a standalone group, each caller first hears their own result recap, then can say `play again`; the display may also show a named replay control once that caller's recap is ready. The result stays visible until every caller opts in. Station callers return through the station requeue flow.

The eight content categories are General Knowledge, Science, Geography, History, Entertainment, Sports, Technology, and Twilio. A selected-category round contains two easy, four medium, and two hard questions. Mixed contains one question from every category with the same overall difficulty split. The complete bank has 200 questions, 25 per category, and requires matching `en-US` and `pt-BR` choice IDs plus localized prompts, choices, optional private voice aliases, and explanations.

Correct-answer speed points are 1,300 before 8 seconds, 1,200 from 8 to under 16, 1,100 from 16 to under 23, and 1,000 from 23 through 25 seconds. A correct streak adds 100 points per answer after the first, capped at 500 per answer; a wrong answer or no answer scores zero and resets the streak. The maximum raw score is 12,900. Results normalize with `round(raw * 100000 / 12900)` to a maximum of 100,000.

Final rank sorts by raw score, correct count, lower cumulative time for correct answers, then stable join/seat order. Phone speech, the shared display, and station results all use that authoritative rank; only players sharing rank `1` are announced as winners. Category vote ties select Mixed. The persistent leaderboard sorts by normalized score, correct count, cumulative correct time, then stable persisted result keys.

All answer authority remains on the server. The display is spectator-only, and the browser protocol has no answer or score command. During `question`, browser state excludes the correct choice, aliases, explanation, source/review fields, future questions, and each caller's submitted choice; it exposes only whether a caller has locked. The correct choice and explanation appear only in `reveal`. Legacy protocol phase members remain reserved for compatibility but normal room flow does not enter them.

The protected editor at `/editor?game=trivia` reads and writes the complete bilingual bank through no-store, ETag-guarded `GET`/`POST /api/trivia-questions`. Production requires `EDITOR_TOKEN`; supply it when prompted or in an initial `#token=` fragment, never a query credential, and never expose the API or its answer keys to game clients. Saves strictly validate all 200 records and atomically replace `TRIVIA_QUESTIONS_PATH`. Active rooms keep their creation-time bank, while new rooms use the new revision. Private aliases are optional with a maximum of 12 per localized choice. Source, fact-check, review-status, reviewer, date, and provenance fields are required; original provenance is immutable in the editor, so the bundled `ai-assisted-draft` provenance cannot be relabeled as human-authored.

Completed rounds append normalized results to `TRIVIA_LEADERBOARD_PATH`. `GET /api/trivia/leaderboard?board=all-time&limit=10` and the eight category board IDs return only rank, display name, score, category, and the played-at timestamp; Mixed has no separate board and appears only in all-time. Private activation analytics record Trivia participants, sessions, completion or abandonment, active seconds, accepted voice actions, and category popularity without question text, choices, answers, transcripts, room codes, or display names.

The display reconnects with exponential delays from 500 ms to 8 seconds, then reauthenticates, re-registers its spectator identity, and resumes server-clock sync. Losing the active display during `loading` invalidates that loading generation, so the replacement must send a fresh readiness signal. Caller Relay replacement with the same call SID and room resumes the same slot for 30 seconds; recoverable Relay failures can receive new TwiML up to two times under the common recovery rules above.

## Voice Chess

Voice Chess offers one caller against the computer or two callers against each other. Choose the caller count on the standalone home screen or add `players=2` to `/chess.html?display=1&room=4821`. It is enabled by default and is stable station or Messaging option `6`; station matches use their assigned room and paired display capability. In solo mode, the server randomly assigns the caller White or Black. In two-caller mode, White and Black are stable human seats, the board shows both names and whose turn it is, and play waits until both callers connect, confirm their names, and finish their own phone introductions. Viewers can adjust the board camera, but moves are accepted only through each caller's own `/voice` session; the board uses `/chess?display=1`.

While the standalone board waits for its callers, it shows the configured locale's call QR and linked number. The board shows when a seat is connected, waiting for a name, or recovering from a dropped call. Station launches use the station `/join` QR rail instead.

Say a complete move such as `pawn from E two to E four`, or select a piece first and take as long as needed before naming its destination. Say `castle` for the available castling move; if both sides are legal, the host asks which side. The phone repeats a legal proposed move; say `confirm` to play it or `cancel` to discard it. Keypad `1`, `0`, and `9` mean confirm, cancel, and help. Ambiguous and illegal moves require a clearer choice. In a two-caller game, only the named player whose turn is on the board can move; both phones receive move and result guidance. A temporary disconnect pauses the match during the reconnect window; a completed call forfeits an active two-caller game. After a standalone result, both callers say `play again` on their own phones. The result stays on screen until both votes and phone announcements finish, then a fresh board and welcome cues begin with the same calls and names. Solo standalone play also supports replay; station play returns to the next round.

The server validates moves and chooses computer replies only in solo mode. Its default search settings aim for an approachable 800–1200 Elo feel, which has not been measured as a formal rating. The shared display animates moves and captures, plays the supplied *The Marble Gambit* track with a gesture retry for blocked autoplay, and never submits a move. Drag the board to rotate the camera, right-drag or use two fingers to pan, scroll or pinch to zoom, and double-click to reset the view. Voice Chess has private activation metrics and station results, but no leaderboard.

## Voice Karaoke

Voice Karaoke admits one singer. Conversation Relay owns setup and results, while the same call transitions to a signed, one-use Twilio Media Stream during the 45-second performance.

1. The caller gives or confirms their name.
2. The host explains the falling-word highway and display-supplied backing music.
3. The caller chooses a localized song by number or title.
4. The host begins the third-party speech-recognition disclosure. The caller may interrupt it at any point and explicitly say `start` or press `#` to consent and begin. Silence does not count as consent; `*` repeats the song list.
5. The display preloads the selected instrumental and reports ready only when its Web Audio context is running and unmuted.
6. The server sends Conversation Relay an `end` envelope with call-bound `HandoffData`. Twilio posts it to `/voice/session-ended`; the server validates the live account, call, room, singer, song, locale, and generation before issuing one-use attempt credentials.
7. The returned TwiML starts `inbound_track` at the signed, query-free `/karaoke-media` WebSocket, pauses for the 3-second countdown, 45-second song, and a 5-second stop grace, then stops the named stream and redirects to `/voice/karaoke/complete`. `/voice/karaoke/stream-status` receives signed lifecycle callbacks.
8. The countdown starts only after both the display and authenticated Media Stream `start` frame are ready. Only caller mu-law 8 kHz mono audio is analyzed; the backing track and outbound call audio are excluded.
9. At stream stop the server asks Deepgram to finalize, commits the authoritative score only if identity and provider health still pass, and lets the completion callback retry briefly while finalization is in flight.
10. `/voice/karaoke/complete` reconnects Conversation Relay in result mode to announce score and best combo.

The production performance WebSocket is `/karaoke-media`. Twilio must preserve its signed upgrade request, and reverse proxies must expose the exact public `wss://` URL represented by `PUBLIC_BASE_URL`. The parser treats bounded, non-empty `connected.protocol` and `connected.version` as informational so observed Twilio values such as `Call`/`1.0` and `Call`/`1.0.0` remain compatible. It still strictly validates event order, sequence/chunk/timestamp continuity, stream/account/call identity, custom attempt binding, inbound-only track, and `audio/x-mulaw` 8 kHz mono format.

Karaoke starts enabled in fresh Arcade settings. Complete licensed-song, production-GLB, display-audio, Deepgram billing, and live handset calibration acceptance before deployment.

### Scoring

The fixed score is 50% timing, 30% recognized lyrics, and 20% pitch; missing components are not renormalized. Locally detected voice activity gates all acoustic credit, so silence is always zero even if provider evidence claims the right word. For each exact normalized chart-word match, Deepgram confidence supplies the lyric score and scales both timing and pitch as `0.70 + 0.30 * confidence`. Consequently, missing singing ASR leaves 70% of otherwise earned acoustic credit instead of forcing a hard lyric miss, while confidence `1.0` permits 100%.

Phone input receives modest soft tolerances rather than a broad lyric gate: timing falls linearly across 200 ms before and 250 ms after a word, recognized words align in chart order within 650 ms, and pitch falls across 200 cents after folding the observation to the nearest octave. The octave-invariant comparison lets different vocal ranges follow the same melody. Live `good` and `perfect` labels use 0.3 and 0.8 word-score thresholds, while authoritative points retain the continuous component score.

Deepgram receives monolingual Nova-3 streaming options, the call locale, and up to 50 unique chart words of 4-64 characters as repeated, unweighted `keyterm` parameters. Interim revisions can update the display-time evidence, but final scoring uses only final provider words. On stop the server sends `Finalize` and `CloseStream` and waits at most 2.5 seconds. A provider startup/protocol/finalization failure, including timeout, rejects the score; it does not commit interim evidence. See [Infrastructure Setup](INFRA_SETUP.md#deepgram-billing-and-privacy) for the official free-credit, Pay As You Go, and per-performance cost note.

### Calibration And Chart Timing

Use `KARAOKE_CALIBRATION_OFFSET_MS` only for consistent inbound handset/carrier/venue transport bias. Start at `0`, run several performances with representative phones and carriers, and adjust in small increments based on aggregates. Positive values map incoming observations later on the song timeline; negative values map them earlier. If evidence is consistently mapped late, move the offset negative; if it is consistently early, move it positive. Do not compensate for one singer, a badly authored chart, display speaker delay, or browser rendering with this global server variable.

Each finalized attempt logs `[karaoke] score finalized` with `accepted`, total `words`, `voicedWords`, `recognizedWords`, `voicedRatio`, `pitchRatio`, aggregate `timing`, `lyrics`, and `pitch`, plus `calibrationMs`. `/healthz` also reports `karaokeLyricRecognition`, `karaokeMediaSessions`, and the active `karaokeCalibrationOffsetMs`. Compare these fields across a useful sample: low `voicedRatio` suggests gain, muting, or call-path trouble; low `pitchRatio` with normal voice activity suggests noisy/unclear pitch; normal voice/pitch with weak lyric confidence suggests recognition, language, chart-word, or bleed problems. The application does not log transcripts or raw audio.

Use `/editor?game=karaoke&tool=timing` for chart errors. It overlays the persistent sparse timing file on the compiled songs and provides waveform playback, scrub/zoom, word or selected-section preview, 10/100 ms nudges, boundary drags, group moves, and reset controls. **Save timings** requires `EDITOR_TOKEN`, sends the loaded ETag with `If-Match`, atomically writes `KARAOKE_TIMINGS_PATH` (default `data/karaoke-timings.json`), and applies changes to future performances. A `412` means another editor saved first; reload and reconcile. Resetting and saving a song removes its sparse overrides so compiled timings win. Back up Azure Files before broad timing edits.

## Test Without Twilio

Run the voice-focused unit and integration tests:

```bash
npm test -- voice-intent battle-intent fighter-intent karaoke trivia twiml conversation-relay battle-voice fighter-voice voice-integration
```

Validate and smoke Voice Trivia with the exact package scripts:

```bash
npm run validate:trivia-bank
npm test -- trivia
```

Start `npm run dev:client` before the browser smoke; it injects public server projections, so the Node game server and Twilio are not required:

```bash
npm run smoke:trivia
```

Run the Chess rules, voice, room, and transport tests without a phone:

```bash
npm test -- chess
```

The integration tests open fake Conversation Relay and Media Stream WebSockets and verify room binding, setup, handoff security, and deterministic scoring. They do not replace live handset tests for carrier latency, pitch quality, acoustic backing-track bleed, or Twilio callback ordering.

## Live Call Acceptance Pass

Use the actual booth phone numbers and shared display, with the production OpenAI key configured. Run the common checks in both English and Brazilian Portuguese: interrupt the welcome/menu speech with a choice, paraphrase a command, pronounce a visible choice imperfectly, correct yourself mid-turn, and speak while the host is still talking. The old cue should stop, the intended current-screen action should happen once, and an ambiguous request should get a short clarification. Tap every visible menu or selector on the shared screen and confirm the same state change; live movement, attacks, chess moves, and trivia answers remain phone-controlled. For each multiplayer game, use separate phones, stagger one caller's spoken prompt behind another's ready choice, and verify the screen stays on the current menu until required phone playback and choices finish. Repeat with a dropped and reconnected call. After a phase change or reconnect, the host should describe the screen that is actually visible and should never restart name collection mid-game.

| Game | Minimum live flow to verify |
|---|---|
| Racer | Two callers choose their own cars and track votes; steer, brake, and boost by phone; hear both result recaps and confirm that both replay choices are required. |
| Monsters | Two callers choose their own names and monsters, use distinct moves, and confirm that both result choices and phone recaps gate a free-play rematch. |
| Fighter | Two callers choose their own names and fighters, vote for an arena, move and attack by phone, then hear both results before any replay. |
| Trivia | Four callers choose or vote for a category, answer while the question is read, start the answer clock only after the required phone cues, and recover a failed cue without a duplicate round. |
| Chess | Two named callers play White and Black, hear turn-specific guidance, make legal and illegal move attempts, then finish and see the shared result. Stagger their replay votes and phone announcements to verify a same-call rematch waits for both. Also verify solo finished-screen replay. |
| Karaoke | Choose a song by voice and tap; hear and see the scoring disclosure; explicitly consent by phone before media starts; sing, score, and reconnect for the result. |

Confirm Twilio accepts `SA7eD52NRr8WAehitVt1` for English calls on the deployed account and that Portuguese calls retain their own voice. Check Conversation Relay error events and handset audio as well as the on-screen state; fake Relay tests cannot establish voice entitlement or real acoustic recognition quality.

## Troubleshooting

### The call reaches the wrong game

For standalone testing, open the intended shared display before dialing and close stale display tabs. For station testing, join through `/join`, reach `ADMITTED`, request launch, and call the locale-specific number; persisted admission overrides display recency.

### The webhook returns `403 invalid signature`

Confirm that the Twilio Console webhook URL exactly matches `${PUBLIC_BASE_URL}/voice/incoming`. Restart the server after changing `PUBLIC_BASE_URL`. Confirm either `TWILIO_AUTH_TOKEN` or `TWILIO_PT_AUTH_TOKEN` belongs to the Twilio account making the request. Reverse proxies must preserve the public scheme and host represented by `PUBLIC_BASE_URL`.

### The webhook returns `500` about the Auth Token

Signature validation is enabled while `TWILIO_AUTH_TOKEN` is empty. Set the primary token for SMS, WhatsApp, TAC, and messaging-status callbacks. Voice requests may validate with `TWILIO_PT_AUTH_TOKEN`, but production still requires the primary token. Use `TWILIO_VALIDATE_SIGNATURES=false` only for a controlled request that is not coming from Twilio.

### The call connects but no game responds

Confirm the public host supports WebSocket upgrades at `/voice` and that the generated URL uses `wss://`. Check for `unauthorized relay` in the server log; `VOICE_RELAY_TOKEN` must remain stable between the webhook response and the Relay setup frame. For standalone play, confirm the display uses room `4821`. For station play, confirm the display acknowledged the current generated room and launch generation.

### Karaoke stays on loading

Confirm the display tab has passed **Enable concert audio**, is not muted, and can fetch the selected instrumental. The handoff is not requested until display readiness; after handoff, the countdown still waits for the authenticated Media Stream start frame. `[karaoke] loading timeout ... displayReady=false` points to the display/audio path, while `mediaReady=false` points to Twilio handoff, upgrade, identity, or stream-start failure.

### Karaoke hangs up during the Media Stream handoff

Trace these success markers in order: `[karaoke] media handoff requested`, `[CR] session ended` with the handoff callback, `[karaoke] media attempt issued`, `[karaoke] media stream started`, and `[karaoke] score finalized ... accepted=true`. A missing stage identifies the boundary to inspect. `[karaoke] media upgrade rejected` reports path, TLS-forwarding, Twilio-signature, adapter, and capacity booleans. `[karaoke] media socket rejected` reports attempt/capacity rejection, and `[karaoke] media frame rejected code=...` identifies malformed order, identity, format, sequence, chunk, timestamp, payload, or session-limit failure. Ensure the proxy preserves the exact query-free `/karaoke-media` URL, `X-Twilio-Signature`, and ACA `X-Forwarded-Proto: https` semantics.

Do not reject a stream solely because Twilio's bounded `connected` metadata says `Call`/`1.0` rather than `Call`/`1.0.0`; the application intentionally treats those metadata fields as informational. Failures after `[karaoke] score finalized ... accepted=false` indicate stale identity or lyric-provider startup/protocol/finalization failure. Check the Deepgram project's key, credit, limits, region, usage, and Auto-Load/payment settings.

### Karaoke timing or scores are consistently early or late

First distinguish display-only drift from authoritative phone scoring. The local guide visual offset affects only the browser's lyric presentation and is not `KARAOKE_CALIBRATION_OFFSET_MS`. Fix song-specific chart errors in the persistent timing editor; use the global calibration variable only when aggregate handset evidence across songs and singers has one consistent transport bias. Confirm the deployed value in `/healthz` and the `calibrationMs` field in `[karaoke] score finalized`.

### Timing edits disappear or do not save

Confirm `KARAOKE_TIMINGS_PATH` resolves through `/app/data` to Azure Files and the display uses a future performance, not one already in progress. Supply `EDITOR_TOKEN` when prompted. A `412` requires a reload because the ETag changed. Check for `[karaoke-timings] invalid live config; using compiled timings`; malformed or missing live data deliberately falls back to compiled charts.

### The caller hears the right game but cannot join

Voice Racer may already have two players. Voice Monsters may have two occupied slots. Voice Fighter may have two players or may already be past fighter selection. Voice Karaoke may already have its one microphone slot occupied. Voice Trivia may already have four callers or may be past `lobby`. Voice Chess admits one or two controlling callers according to the selected mode. End stale calls or reset the shared display before retrying.

### Speech works only after the caller finishes talking

Confirm the returned TwiML contains `partialPrompts="true"`, `speechModel="flux"`, and `transcriptionProvider="Deepgram"`. Racer, Monsters, and Fighter act only on finalized gameplay transcripts. Karaoke uses Relay only for setup and switches to timestamped media for the song.

### Barge-in does not stop the host

Inspect the returned TwiML for `interruptible="any"`, `welcomeGreetingInterruptible="any"`, `reportInputDuringAgentSpeech="any"`, `interruptSensitivity="high"`, and `ignoreBackchannel="false"`. Relay should send an `interrupt` frame when speech or keypad input cuts off TTS. Check live handset behavior in the actual booth environment because room noise can affect recognition.

### Menus are quiet without an OpenAI key

All six games keep fast deterministic commands without OpenAI. `OPENAI_API_KEY` adds a bounded semantic fallback for accents, paraphrases, and conversational requests in the current game phase in both supported locales. The model receives only current actions and visible choices, and the game server validates the result before changing state. Trivia still reads only its validated question bank, and Chess still uses local rules and computer search.

### The displayed phone number is missing

For standalone local testing, set `GAME_PHONE_NUMBER` and restart the server. For Twilio Games station events, save both locale voice numbers in the operator console instead; those values are exposed through `/api/config` and take precedence without a restart.

Return to the [README](../README.md) for architecture, general scripts, and the rest of the project documentation.
