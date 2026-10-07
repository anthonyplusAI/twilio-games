import type { SupportedLocale } from './i18n/locales';

export type Intent = 'MOVE_LEFT' | 'MOVE_RIGHT' | 'BOOST' | 'BRAKE' | 'USE_POWER';
export const INTENTS: readonly Intent[] = ['MOVE_LEFT','MOVE_RIGHT','BOOST','BRAKE','USE_POWER'];

export type ItemKind = 'barrier' | 'boost';
export interface Item { id: number; kind: ItemKind; lane: number; z: number; }

export interface CarState {
  id: string;            // playerId
  name: string;
  color: string;
  carIndex: number;      // which car MODEL the player chose (index into the car manifest)
  lane: number;          // current logical lane
  targetLane: number;    // lane the car is easing toward
  x: number;             // interpolated lateral position
  z: number;             // cumulative forward distance
  speed: number;
  boost: number;         // -1..+2-ish modifier
  power: number;         // remaining one-shot power-ups (NITRO DASH charges)
  powerActive: number;   // seconds of active power remaining
  invulnerable: boolean; // true while a POWER dash is active: smashes THROUGH barriers unharmed
  stunned: number;       // seconds of stun remaining
  lap: number;
  finished: boolean;
  finishT: number;
  place: number;
}

// Full room lifecycle. The pre-race flow (lobby → car_select → map_select) is owned by the Lobby
// state machine; countdown/racing/finished are the RaceWorld's. 'results' shows the post-race
// scoreboard before returning to a fresh lobby.
export type Phase = 'lobby' | 'car_select' | 'map_select' | 'countdown' | 'racing' | 'finished' | 'results';

export interface WorldSnapshot {
  tick: number;
  t: number;             // sim seconds since race start
  phase: Phase;
  countdown: number;     // seconds remaining in countdown (>=0)
  cars: CarState[];
  items: Item[];         // static for a race; sent once at start, omitted after (see protocol)
  consumedItems: number[];   // ids of boosts currently picked-up (hidden, respawning) — shared state
}

// ---- Protocol: client -> server ----
export type ClientMessage =
  | { type: 'join'; roomCode: string; name: string; color?: string; locale?: SupportedLocale }
  | { type: 'intent'; intent: Intent }
  | { type: 'ready' }
  | { type: 'restart' }
  | { type: 'spectate'; roomCode: string; locale?: SupportedLocale; displayToken?: string }
  | { type: 'leave' }                              // drop this conn's player slot but stay connected (→ spectator)
  | { type: 'select_car'; carIndex: number }      // player claims a car (car_select phase)
  | { type: 'select_map'; map: string }           // pick the level (map_select phase)
  | { type: 'advance' }                            // host: move the flow forward one phase
  | { type: 'back' }                              // host: move the flow back one phase
  | { type: 'display_select_car'; roomCode: string; expectedPhase: 'car_select'; forPlayerId: string; carIndex: number }
  | { type: 'display_select_map'; roomCode: string; expectedPhase: 'map_select'; forPlayerId: string; map: string }
  | { type: 'display_advance'; roomCode: string; expectedPhase: 'lobby' | 'car_select' | 'map_select' | 'results'; forPlayerId?: string }
  | { type: 'display_back'; roomCode: string; expectedPhase: 'car_select' | 'map_select' };

/** Shared-screen actions are labeled with the current authoritative caller seat and gates. */
export interface MenuTouchState {
  activePlayerId: string | null;
  advancePlayerId: string | null;
  canAdvance: boolean;
  canBack: boolean;
}

export interface LobbyPlayer {
  playerId: string;
  name: string;
  color: string;
  lane: number;
  carIndex: number | null;   // chosen car model (car_select), null until picked
  ready: boolean;            // locked their car in
}

/** A finished race's standings, persisted to the leaderboard + shown on the results screen. */
export interface RaceResult {
  playerId: string;
  name: string;
  carIndex: number;
  place: number;        // 1 = winner
  finishT: number;      // seconds from GO to crossing the line (0 if DNF)
  finished: boolean;
}

// ---- Protocol: server -> client ----
export type ServerMessage =
  | { type: 'joined'; playerId: string; lane: number; roomCode: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'items'; items: Item[]; map?: string | null }   // sent once at race start (map = chosen level)
  | { type: 'snapshot'; snapshot: WorldSnapshot } // sent ~30/s during a race
  | { type: 'event'; event: GameEvent }           // announcer cues (lead change, finish, ...)
  | { type: 'lobby'; roomCode: string; players: LobbyPlayer[]; phase: Phase; touch?: MenuTouchState }   // roster (~2/s in pre-race)
  | { type: 'select_state'; roomCode: string; phase: Phase; players: LobbyPlayer[];
      maps: string[]; selectedMap: string | null;
      mapVotes?: Record<string, number>; mapTie?: boolean; touch?: MenuTouchState }   // car/map-select screen state (+ live vote tally)
  | { type: 'results'; roomCode: string; map: string | null; results: RaceResult[]; touch?: MenuTouchState }; // post-race scoreboard

export type GameEvent =
  | { kind: 'enter_car_select'; spokenReplyPlayerId?: string }  // flow reached car-select
  | { kind: 'enter_map_select'; spokenReplyPlayerId?: string }  // flow reached map-select
  | { kind: 'car_picked'; playerId: string; name: string; car: string; spokenReplyPlayerId?: string }  // a player locked a car
  | { kind: 'map_picked'; map: string; playerId?:string; spokenReplyPlayerId?: string } // one caller cast or changed a track vote
  | { kind: 'countdown'; n: number }
  | { kind: 'go' }
  | { kind: 'lead_change'; playerId: string; name: string }
  | { kind: 'hit'; playerId: string }
  | { kind: 'hit_streak'; playerId: string; name: string; count: number }  // hit N barriers total (milestone)
  | { kind: 'barrier_smashed'; playerId: string; itemId: number }          // POWER dash blasted through a barrier
  | { kind: 'fell_to_last'; playerId: string; name: string }               // dropped into last place mid-race
  | { kind: 'boost_taken'; playerId: string; itemId: number }
  | { kind: 'finish'; playerId: string; name: string; place: number }
  | { kind: 'race_over' };
