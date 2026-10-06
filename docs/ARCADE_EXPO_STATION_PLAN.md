# Twilio Games: One-Display Expo Station Plan

> **Document status (2026-07-25):** This completed plan is the historical expo-station baseline.
> Later implementation deltas supersede it where they differ.
>
> **Operational truth:** Use the [README](../README.md), [Deployment](DEPLOYMENT.md), and
> [Infrastructure Setup](INFRA_SETUP.md) for current behavior and operations.
>
> **Earlier implementation delta (2026-07-25):** Direct Conversation Relay owns Voice. Signed
> `POST /sms` owns SMS/WhatsApp commands and immediate replies; Conversation Orchestrator and TAC
> enrich Conversation Memory only. One individual FIFO ready line feeds up to two assigned callers
> in Racer, Monsters, or Fighter, with FIFO overflow and caller-scoped setup. Those games used
> explicit caller-driven phase gates. WhatsApp
> call-now uses the approved Phone CTA when configured. Every playable game emits factual results,
> and the operator can reset Racer leaderboard records for one selected map.
>
> **Current implementation delta (2026-10-06):** The canonical registry now has six playable games:
> Racer, Monsters, and Fighter each admit up to two humans with AI/fewer-human fallback; Karaoke admits
> one human without AI; Trivia admits one to four humans without AI at `/trivia.html`; Chess admits
> one human against the computer at `/chess.html`. The station, messaging game choices (`1` through
> `6`), automatic selection order, launch routing, factual results, and coin costs all consume that
> registry. Trivia provides localized category voting, eight-question voice rounds, protected bilingual
> content, normalized results, and persistent all-time/category leaderboards. Chess has no leaderboard.
> Authenticated staff can reset Racer map, Karaoke song, and Trivia board records.

**Original plan date:** 2026-07-21
**Status:** Completed historical baseline; retained for decision history
**Scope:** One shared display at one conference booth, one active game at a time
**Historical relationship:** This plan originally superseded the station, queue-wave, game-selection,
capacity, and QR journey in `TWILIO_ARCADE_PLAN.md` where it was more specific.

This document preserves the decisions and implementation baseline for the original one-display expo
flow. It is not the current operational source of truth.

## 1. Locked Decisions

| Area | Decision |
|---|---|
| Physical setup | One shared display, one persistent station, one active game at a time |
| Public terminology | Use **station**, **round**, **ready for next game**, and **coin inserted** |
| Hidden identifiers | Station ID and engine room IDs are internal and never shown to visitors |
| Persistent entry | One localized station QR remains discoverable before, during, and after games |
| Primary onboarding | English: SMS or WhatsApp; Brazilian Portuguese: WhatsApp |
| Fallback onboarding | Browser registration for either locale when lead capture permits it |
| Coin ownership | Server-side wallet; never a transferable text code |
| Coin insertion | Player replies `COIN`; server reserves one coin for the station ready pool |
| Coin cost | One coin per human per game; AI never consumes coins |
| Grouping | FIFO individual ready pool for v1; no explicit party codes |
| Game selection | Ready players vote by game name/number or browser; staff may override |
| Manual control | Staff can advance early whenever at least one player is ready |
| Automatic control | Timers provide unattended fallback and hard throughput bounds |
| Overflow | Players beyond selected-game capacity keep reservation and FIFO priority for next game |
| Racer capacity | **Maximum 2 human players** |
| Monsters capacity | Maximum 2 human players; AI fills solo play |
| Fighter capacity | Maximum 2 human players; AI fills solo play |
| Trivia | Deferred by this original baseline; superseded by the current six-game registry above |
| Browser display voice | No browser `speechSynthesis`; caller audio remains Conversation Relay |
| Language | Display language flows into QR, chooser, messaging, wallet, queue, and Memory preference |
| Messaging authority | Signed `POST /sms` owns commands and immediate replies for SMS and WhatsApp |
| Memory enrichment | Conversation Orchestrator and TAC enrich Conversation Memory only |
| Authority | Deterministic station/game services own state; direct Conversation Relay owns Voice gameplay |

Runtime configuration enforces these economics: paid `per_player` play starts new players with at least
one coin, and `defaultGameCost` plus every game-specific cost must equal exactly one. Free play uses zero.
The operator console applies the same minimum and does not expose variable station pricing.

## 2. Visitor Mental Model

The booth behaves like one physical arcade machine:

1. Scan the station QR.
2. Choose a preferred messaging channel: SMS or WhatsApp in English, WhatsApp in Portuguese.
3. Complete quick conversational registration or, in lead-capture mode, use the visually secondary browser registration if Messaging is not practical.
4. Receive one wallet coin.
5. Reply `COIN` when ready to play.
6. Watch the display animate the inserted coin and add the player to the ready pool.
7. Vote for a game by replying with its name/number or choosing it on the player page.
8. Admitted players play; overflow stays first for the next game.
9. An admitted messaging player follows the call-now notice. The signed Voice webhook routes the
   caller to the assigned game and room and supplies their registered name and player slot automatically.

The confirmation message is not the coin. The wallet ledger is authoritative.

## 3. Display State Machine

```text
IDLE (internal phase: ATTRACT) / RECRUITING
  no ready players: no timer
  first COIN: start 90-second recruiting deadline
  staff may advance early
  hard deadline: 120 seconds
          |
          v
GAME_SELECTION
  render numbered game cards with looping previews and live vote totals
  ready players vote by message or on the browser player page
  staff may override; ties or no votes use the configured 30-second fallback
          |
          v
LOCKED
  assign admitted players by FIFO and game capacity
  preserve overflow for next round
  10-second visible countdown
          |
          v
LAUNCHING
  request authoritative game display/lobby
  wait for display-ready acknowledgement
          |
          v
PLAYING
  redeem admitted reservations only after authoritative engine start
  compact QR rail accepts players for the next ready pool
          |
          v
RESULTS
  complete match from authoritative game result
  if next pool exists: 45-second final join window
  otherwise return to attract with no timer
```

Deadlines are persisted timestamps. In-memory timers are wakeups only. Restart processing must
immediately apply overdue transitions exactly once.

## 4. Timing Defaults

| Timer | Default | Starts when | Behavior |
|---|---:|---|---|
| Idle recruiting | None | No coins inserted | QR remains available indefinitely |
| Recruiting window | 90 seconds | First valid `COIN` while no game is active | Staff may advance early |
| Hard recruiting deadline | 120 seconds | First valid `COIN` | Cannot be extended indefinitely |
| Game selection window | 30 seconds | Recruiting closes | Highest vote wins; ties/no votes use configured fallback |
| Locked countdown | 10 seconds | Participants assigned | Launch preparation |
| Post-game join window | 45 seconds | Results with next-pool players | Staff may skip early |

Registration never starts a round timer. A visitor can take as long as needed to register; only
`COIN` means physically ready near the display.

## 5. Ready Pool and Capacity

Ready entries are ordered by `(originalReadyAt, id)`. The same order survives overflow, restart, and
temporary deferral.

At selection time, cards show capacity impact:

```text
5 ready

Voice Racer     Playing this round: 2 · Waiting for next game: 3
Voice Monsters  Playing this round: 2 · Waiting for next game: 3
Voice Fighter   Playing this round: 2 · Waiting for next game: 3
```

Selecting a game atomically divides the pool:

- First `capacity` eligible entries become admitted.
- Remaining entries become overflow with unchanged original priority.
- Admitted reservations are redeemed only on authoritative engine start.
- Overflow reservations remain active for the next game.
- Cancel, leave, or unrecoverable launch failure releases the affected reservation.

Friends are not explicitly grouped in v1. Players inserting coins together normally remain adjacent
under FIFO. Party codes are deferred until expo observation proves they are needed.

## 6. Persistent QR Layout

### 6.1 Idle and Recruiting

The root shared-display experience is one viewport with no vertical scrolling:

```text
┌──────────────────────────────────────┬─────────────────────┐
│ Rotating asymmetric gameplay mosaic │ SCAN TO PLAY        │
│ Racer / Monsters / Fighter           │ [large station QR]  │
│ Muted looping clips                  │ Choose channel      │
│ Ready-player animation               │ Register            │
│                                      │ Receive coin        │
│                                      │ Reply COIN          │
└──────────────────────────────────────┴─────────────────────┘
```

- Gameplay media: 65-70% width.
- QR/instructions/ready count: 30-35% width.
- Existing game cards are not changed visually; they become the `GAME_SELECTION` phase.

### 6.2 Active Gameplay

Games reserve a fixed 220-260px right rail on a 1080p display:

```text
┌────────────────────────────────────────────┬──────────────┐
│ Existing game viewport                     │ JOIN NEXT    │
│                                            │ GAME         │
│ No QR overlay over active play             │ [compact QR] │
│                                            │ N ready next │
└────────────────────────────────────────────┴──────────────┘
```

The rail is preset, not draggable. Operator settings are `auto`, `always`, or `hidden`, with an
optional temporary hotkey. `auto` means large while idle or showing results and compact during gameplay.

The QR encodes only:

```text
/join?station=ARCADE-01&locale=en-US
```

No PII, balance, player ID, round ID, or bearer credential appears in the QR.

## 7. Mobile Join and Messaging

`/join` is a small localized channel chooser. English entry can offer:

- Continue with SMS
- Continue with WhatsApp
- Continue with browser registration when lead capture permits it

Brazilian Portuguese entry offers WhatsApp instead of SMS. Lead-capture mode offers browser
registration in both locales, while the server still rejects Portuguese SMS attempts.

Opening `/join` directly resolves the current cabinet automatically. A station query is used only to
detect genuinely stale printed or cached QR links.

Channel links prefill one short localized command. The player only needs to tap **Send**:

```text
JOIN
```

Portuguese links prefill `ENTRAR`. Legacy commands containing a station ID or `LANG` remain accepted,
but are not shown to new players.

Messaging flow:

```text
QR chooser
  -> SMS or WhatsApp
  -> signed POST /sms
  -> deterministic registration, wallet, ready-line, and voting commands
  -> immediate localized reply

Conversation Orchestrator capture
  -> signed POST /tac/webhook
  -> TAC lifecycle processing
  -> Conversation Memory enrichment only
```

The channel address supplies the trusted phone destination. Signed `/sms` runs the deterministic
step-by-step registration flow and validates exact fields, consent, idempotency, wallet, ready-line,
and match operations. Orchestrator/TAC does not execute the command or send a second reply. Recalled
Memory contributes profile and locale continuity, not economic authority.

After registration:

```text
You have 1 game coin.

Reply COIN when you are ready to play at the screen.
```

After insertion:

```text
Coin inserted.
You are ready for the next game.
Position: 3
When game selection appears, reply with the game name or number.
```

When an assigned player must call, SMS sends the locale-specific Voice number. WhatsApp uses the
approved localized `twilio/call-to-action` Phone CTA when its Content SID is configured, including
inside the 24-hour session window. The action contains the static locale Voice number and opens the
device Phone dialer; it is not a WhatsApp Voice Call action. Without the template, an in-window notice
falls back to a free-form phone number and an out-of-window notice is suppressed.

Signed `/sms` parses deterministic commands and generates the immediate reply:

- `JOIN`
- `COIN`
- `STATUS`
- `LEAVE`
- `HELP`
- `1` / `RACER`, `2` / `MONSTERS`, `3` / `FIGHTER`, `4` / `KARAOKE`, or `5` / `TRIVIA` during game selection
- localized equivalents

Inbound provider message IDs are durably idempotent. SMS and WhatsApp addresses normalize into a
channel-address model linked to the authoritative player and Memory profile.

## 8. Language

The selected display language chooses the short initial command (`JOIN` or `ENTRAR`). It controls:

- Attract/recruiting instructions
- Mobile channel chooser
- SMS/WhatsApp prefilled command
- Signed `/sms` registration prompts
- Wallet and coin confirmation
- Queue status and call messages
- Post-game messages
- Conversation Memory profile continuity plus the authoritative application locale

Supported v1 languages remain `en-US` and `pt-BR`. A player can explicitly switch language in the
conversation without changing the shared display language.

## 9. Authoritative Domain Additions

Add schema-versioned durable records:

```text
Station
  id, phase, activeRoundId, activeGame, activeMatchId, revision, updatedAt

RecruitingRound
  id, stationId, phase, firstCoinAt, recruitingEndsAt, hardEndsAt,
  selectionEndsAt, selectedGame, gameChoicesByReadyEntryId, startedAt, closedAt, configVersion

ReadyEntry
  id, roundId, stationId, playerId, originalReadyAt, readyAt,
  status, reservationId, assignment, overflowOrdinal

ArcadeMatch
  id, roundId, stationId, game, phase, participantReadyEntryIds,
  overflowReadyEntryIds, engineRoomCode, launchGeneration,
  launchRequestedAt, displayReadyAt, startedAt, completedAt, configVersion

ChannelAddress
  id, playerId, channel, normalizedAddress, providerAddress,
  firstSeenAt, lastSeenAt

InboundMessage
  providerMessageId, channelAddressId, normalizedCommand, receivedAt, resultFingerprint
```

State schema changes require explicit migration. Existing schema-v1 files must not become unreadable.

## 10. Playable Game Registry

Create one canonical registry consumed by scheduler, APIs, display, launch coordinator, and engine
admission:

> **Historical registry snapshot:** This table preserves the original 2026-07-21 baseline. It
> predates Karaoke, Trivia, and Chess; the six-game registry in the current implementation delta
> above supersedes it.

| Game | Route | Human capacity | Minimum | AI fallback | Playable |
|---|---|---:|---:|---|---|
| Voice Racer | `/play.html` | **2** | 1 | Race with fewer humans | Yes |
| Voice Monsters | `/monsters.html` | 2 | 1 | AI opponent | Yes |
| Voice Fighter | `/fighter.html` | 2 | 1 | AI opponent | Yes |
| Voice Trivia | Deferred in this baseline | - | - | - | Superseded |

Engine admission must enforce the same capacity and assigned participant set. Direct browser, Voice,
or stale WebSocket joins must not bypass station assignment.

## 11. Game Launch Contract

The station coordinator, not the most recently connected display socket, becomes authoritative for
active-game routing.

```text
Station LAUNCHING
  -> persist launch intent
  -> command shared display to selected route
  -> display sends ready acknowledgement
  -> send admitted messaging players the locale-specific call-now notice
  -> signed Voice webhook automatically binds each caller to the assigned game, room, identity, and slot
  -> game receives the registered name and expected caller count
  -> authoritative engine starts
  -> redeem admitted coin reservations
  -> station PLAYING
```

Assigned callers do not enter a room code or repeat their registered name. Game-specific selections
remain caller-driven, and the engine waits for the expected assigned callers subject to the station's
no-show and overflow policy.

On launch failure, keep or release reservations according to a deterministic compensation policy.
Never claim an engine launch and a file-store write are one transaction.

Engine completion emits one normalized result into the station coordinator, which completes the
Arcade match and transitions to results/recruiting.

All six registered games now provide factual authoritative participant results to the station
display and result notices. Racer reports place and time; Monsters and Fighter report the outcome;
Karaoke reports its normalized score; Trivia reports rank and normalized score; Chess reports win,
loss, or draw. Authenticated staff
can reset persisted Racer records for one map, Karaoke records for one song, or Trivia records for an
all-time/category board with a reason.

## 12. Realtime Events

Expand the privacy-safe station event stream:

- `station_state_updated`
- `recruiting_started`
- `ready_entry_added`
- `ready_entry_removed`
- `selection_started`
- `game_selected`
- `participants_assigned`
- `overflow_updated`
- `launch_requested`
- `display_ready`
- `match_started`
- `match_completed`
- `station_recovered`

Station events use a monotonic station event sequence, not configuration version. Shared displays
receive aliases/first names only.

## 13. Operator Controls

Authenticated staff can:

- Advance recruiting early
- Extend once within a configured bound
- Select the game
- Override admitted entries with an audited reason
- Launch, cancel, or recover a round
- Release reservations
- Toggle QR rail preset
- Reset persisted Racer scores for one selected map with a reason
- Reset the station after an unrecoverable display/game failure

Automatic timers remain active when no operator acts.

## 14. Implementation Phases

These phases record the completed baseline plan. Their original imperative wording is retained as
history; they are not a current implementation checklist.

### Phase A: Domain and Persistence

- Reconcile Racer engine capacity from 8 to 2.
- Add canonical playable-game registry.
- Add station/round/ready/match/channel state schema and migration.
- Implement pure station reducer and invariant tests.
- Implement serialized station service and first-COIN atomicity.

### Phase B: Timers, Scheduling, and APIs

- Persist and recover all deadlines.
- Implement FIFO admission and overflow.
- Implement manual advance plus automatic deadlines.
- Add public station projection, operator APIs, and station events.

### Phase C: Display

- Replace root with attract/recruiting mosaic plus large QR.
- Move existing game cards into game-selection phase unchanged.
- Add compact fixed QR rail to all active games.
- Add ready roster, countdown, capacity impact, overflow, and results states.

### Phase D: Messaging

- Add localized `/join` channel chooser and collapsed form.
- Add deterministic SMS/WhatsApp command router.
- Add durable channel identity and provider-message idempotency.
- Add TAC registration/Memory tool adapters.
- Add compliant outbound confirmations and status notifications.

### Phase E: Game Coordination

- Replace recent-display voice routing with station active game.
- Gate engine joins to assigned players.
- Launch selected game and await display ready.
- Bind Arcade identities to game-local players/calls.
- Redeem on authoritative engine start and complete from authoritative results.
- Add recovery and compensation.

## 15. Required Verification

- Simultaneous duplicate first `COIN` messages start one round and reserve once.
- Restart at every deadline and phase boundary.
- Racer admits 2 and preserves overflow priority.
- Monsters/Fighter admit 2 and preserve overflow priority.
- Staff early-start and automatic timeout produce the same valid state.
- COIN during play enters next pool, never current match.
- Full selected match participant set is required for completion.
- Launch failure never loses a coin.
- Stale display connections cannot steal voice routing.
- SMS/WhatsApp/browser identities converge without exposing PII.
- Locale flows from display QR through chooser and messaging.
- QR remains scannable on actual 1080p booth display and physical phones.
- Desktop/mobile/browser, full unit/integration, build, audit, and live Twilio tests pass.

## 16. Known Constraints

- One process and one replica remain required until shared state/session infrastructure exists.
- File persistence is acceptable for the first expo spike but not indefinite high-volume production.
- WhatsApp requires approved sender, opt-in, session-window, and template compliance.
- Direct Conversation Relay owns Voice gameplay. TAC is not in the Voice command path.
- Messaging, Memory, and live Twilio resources require account credentials and Console provisioning.
