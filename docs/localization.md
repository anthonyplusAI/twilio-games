# Localization

Twilio Games supports US English (`en-US`) and Brazilian Portuguese (`pt-BR`) across the home page, all six playable game displays, deterministic voice commands, Conversation Relay transcription, and spoken responses.

Station entry channels are also localized. English visitors may enter through configured SMS or WhatsApp channels. Portuguese visitors use WhatsApp rather than SMS, and the server rejects Portuguese SMS even if a visitor bypasses the chooser. Lead-capture mode offers localized browser registration to both locales as a visually secondary fallback; messaging remains the preferred path. A phone identity that selected Portuguese on WhatsApp cannot switch to SMS unless it explicitly selects English.

## Display Locale

The browser resolves its display locale in this order:

1. The `locale` URL parameter, such as `?locale=pt-BR`.
2. The saved `twilio-games-locale` browser preference.
3. The closest supported browser language.
4. US English.

The language picker appears on the home page. It saves the choice, reloads the home page with the locale parameter, and preserves that locale in launched game links. Each game display also sends its locale when it joins a room WebSocket. Station join URLs include both `station` and `locale` parameters.

## Call Locale And Routing

The server chooses a call's locale in this order:

1. The locale mapped uniquely to the Twilio `To` number that the caller dialed.
2. The preferred locale of the routed game's display in the routed room, then another localized connection in that room.
3. `DEFAULT_LOCALE`, which defaults to `en-US`.

The dialed locale-specific number takes precedence over a display locale. `ArcadeApi.voiceLocaleForNumber()` returns a locale only when exactly one configured locale uses the normalized E.164 number. A shared legacy fallback number therefore does not identify a locale by itself.

Routing and locale selection remain separate decisions. In station mode, the persisted caller assignment selects the game and its dynamically generated engine room; display recency does not participate. In standalone mode, the most recently opened `display=1` connection selects the game, and the normal standalone room fallback selects the room. Standalone display registration does not validate the station display token. After that route exists, the server applies the locale precedence above.

The selected locale drives the Conversation Relay `transcriptionLanguage`, `ttsLanguage`, hints, `locale`, and `commandLocale` values. Server text frames carry the same language code. `CR_TTS_VOICE_PT_BR` can select a Portuguese ElevenLabs voice; when it is empty, Relay uses its `pt-BR` default.

## Source Map

| Concern | Source |
|---|---|
| Supported locales, fallback resolution, and Twilio language profiles | `shared/i18n/locales.ts` |
| Translation, formatting, and Unicode command normalization | `shared/i18n/translate.ts` |
| Shared navigation and music labels | `shared/i18n/common.ts` |
| Home and five catalog-backed game displays | `shared/i18n/home.ts`, `shared/i18n/racer.ts`, `shared/i18n/monsters.ts`, `shared/i18n/fighter.ts`, `shared/i18n/karaoke.ts`, and `shared/i18n/trivia.ts` |
| Browser locale persistence and picker | `client/i18n.ts` |
| Locale-specific lobby number and QR updates | `client/station-client.ts` and the six game entry points |
| Dialed-number, station, standalone-display, room, and locale routing | `server/http-server.ts` and `server/arcade-api.ts` |
| Conversation Relay language attributes and custom parameters | `server/twiml.ts` |
| Trivia display copy and category labels/aliases | `client/trivia/trivia-view.ts` and `shared/i18n/trivia.ts` |
| Trivia question schema, localized answer matching, and safe client projection | `shared/trivia.ts` |
| Trivia protected content editor and persistent store | `client/editor/trivia-question-editor.ts` and `server/trivia-content-store.ts` |
| Chess display copy and spoken move description | `client/chess/chess.ts` and `shared/chess-intent.ts` |

## Command And Number Parsers

Commands remain locale-neutral after parsing. For example, `left` and `esquerda` both become `MOVE_LEFT`, while `punch` and `soco` both become the Fighter command `punch`. Room state, analytics, protocols, and replays therefore do not depend on translated labels.

| Game concern | Parser source |
|---|---|
| Racer gameplay command tokens | `server/voice-intent.ts` |
| Racer cardinal, ordinal, digit, and fuzzy car/map selection | `server/game-host.ts` |
| Racer flow words, late gameplay prompts, and Relay hints | `server/http-server.ts` |
| Monsters root actions, move numbers, and move-name matching shared by browser and server | `shared/battle-intent.ts` |
| Monsters flow words, monster selection numbers/names, and caller-name parsing | `server/battle-voice.ts` |
| Fighter combat commands, repeated counts, and command chains | `shared/fighter-intent.ts` |
| Fighter roster/map selection numbers, ordinals, names, and aliases | `server/fighter-voice.ts` |
| Karaoke setup and song-selection commands | `server/karaoke-voice.ts` |
| Trivia category votes, answer letters/numbers/text, and private aliases | `server/trivia-voice.ts` and `shared/trivia.ts` |
| Chess piece and square selection, move confirmation, and help | `shared/chess-intent.ts` and `server/chess-voice.ts` |

Content IDs also remain stable. Arena, fighter, monster, move, car, track, song, Trivia question, category, and choice names are translated for display and speech without changing IDs or persisted English keys such as `cyberpunk-city` and `Silver Lake`. Voice selection accepts supported localized aliases, canonical names, and selection numbers according to the parser responsible for that game phase.

## Voice Trivia Content

The bundled production seed defaults to `content/trivia/questions.json`, and the persistent live path
defaults to `data/trivia-questions.json`. On first startup with no live file, the server strictly
validates the seed and atomically creates the live file; later loads use the live file. A malformed
live file fails content startup rather than silently replacing operator edits with the seed. The
active content revision is a SHA-256 digest and is included in completed Trivia results.

The bank must contain exactly 200 unique questions: 25 in each of `general`, `science`, `geography`,
`history`, `entertainment`, `sports`, `technology`, and `twilio`. The current production quality tests
require 6 easy, 13 medium, and 6 hard questions per category. The runtime parser guarantees at least
the 2 easy, 4 medium, and 2 hard questions needed for each eight-question round; a category round uses
that 2/4/2 mix, while a Mixed round uses one question from each category with the same overall mix.

Every question has these localized-content requirements:

- Both `en-US` and `pt-BR` must provide a non-empty prompt, four choices, and an explanation. No locale
  fallback is accepted in the bank.
- Choice IDs and order must match across the two locales, and `correctChoiceId` must identify one of
  those four shared IDs.
- Each localized choice may provide 0-12 private spoken aliases. Its text and any aliases must
  normalize to one unambiguous choice within that locale.
- Question IDs and choice IDs are lowercase, path-safe slugs. Prompts are limited to 240 characters,
  choice text and aliases to 100, and explanations to 360.
- Every question needs a specific bounded HTTPS source URL without credentials or a fragment, a source
  title, and an ISO access date.
- Review metadata is required: `status: "reviewed"`, a non-empty `reviewedBy`, an ISO `reviewedAt`,
  `factChecked: true`, and provenance of either `human-authored` or `ai-assisted-draft`.

All 200 current questions identify `OpenAI GPT-5.6 Sol (AI-assisted editorial audit)` as the reviewer,
use `provenance: "ai-assisted-draft"`, and are marked fact-checked on `2026-08-29`. This records an
AI-assisted source and editorial audit only. It does not claim human editorial, subject-matter, or
native Brazilian Portuguese review. A later human review must preserve the AI-assisted provenance and
identify the actual reviewer rather than relabeling the existing audit.

Runtime publishes the selected localized prompt and choices directly in `question`, starts the shared
10-second answer window immediately, and speaks localized numbered choices without waiting for Relay
playback. English uses One through Four; Brazilian Portuguese uses Um through Quatro. Reconnecting
unanswered callers hear the current numbered question plus remaining-time guidance without changing
the shared timestamps.

Use `/editor?game=trivia` to edit the complete bilingual bank, answer key, private voice aliases,
sources, and review metadata. The API is `no-store`, requires `EDITOR_TOKEN` when configured, and uses
an ETag plus `If-Match`; a concurrent save returns `412` and must be reloaded instead of overwritten.
Aliases are optional, and original authorship provenance is displayed read-only and preserved on
save. Supply editor credentials when prompted or in an initial `#token=` fragment; query parameters
named `token` are scrubbed and ignored. The editor validates the complete 200-question bank before
posting. The endpoint and full payload are server-only because they contain answers and aliases.

During a question, the browser receives only the localized prompt, difficulty, category, and shuffled
choice IDs/text. It does not receive the correct choice, aliases, explanation, source, or review
metadata. The reveal projection adds only the correct choice ID and localized explanation; aliases,
source, and review metadata remain server-only.

## Adding A Language

1. Add its BCP 47 code and Twilio STT/TTS profile to `shared/i18n/locales.ts`.
2. Add a complete catalog entry to every file under `shared/i18n/`.
3. Extend each applicable parser listed above with commands, cardinals, ordinals, flow words, names, and aliases.
4. Extend the exact Trivia locale schema and editor, then provide prompts, four ordered choices, private aliases, and explanations for every question.
5. Add localized menu navigation, introductions, help, and selection responses to every applicable game voice session.
6. Add STT hints and number words in `HttpServer.voiceHints()` and `selectionNumberHints()`.
7. Configure and validate a distinct locale voice number when the dialed number must select the locale.
8. Add table-driven parser and catalog tests plus a real Conversation Relay call test.
9. Test long labels, screen-reader text, browser speech synthesis, noisy phone audio, and every supported STT model with native speakers.

Use Unicode normalization rather than ASCII-only regular expressions. Keep translated display names out of persisted IDs and protocol actions.

## Configuration

| Setting | Behavior |
|---|---|
| Runtime `channels.voiceNumbers.en-US` and `.pt-BR` | Locale-specific public voice numbers used by lobbies and dialed-number locale detection |
| `GAME_PHONE_NUMBER` | Legacy fallback only when neither runtime locale number is configured; a shared fallback cannot identify one locale uniquely |
| `DEFAULT_LOCALE` | Call fallback when neither the dialed number nor the routed display identifies a locale; defaults to `en-US` |
| `CR_TTS_VOICE` | English ElevenLabs voice ID; empty uses the Relay default |
| `CR_TTS_VOICE_PT_BR` | Brazilian Portuguese ElevenLabs voice ID; empty uses Relay's `pt-BR` default |

The Azure deployment reads the environment values from GitHub repository variables. Operators manage `channels.voiceNumbers` in runtime Arcade settings. Validate provider language, model, voice, and number availability before enabling a new locale in production.
