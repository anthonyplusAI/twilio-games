// Wire protocol for Voice Monsters (the /battle WebSocket). Separate from the racer's protocol
// because the battler is a turn-based STATE MACHINE (push state on change) rather than a continuous
// 20Hz simulation. Kept in shared/ so client + server agree on the shapes; the parser validates
// untrusted client input on the server.
import type { BattleSnapshot, BattleEvent, BattleAction } from './battle-world';
import { isSupportedLocale, type SupportedLocale } from './i18n/locales';

/** Client → server. */
export type BattleClientMessage =
  | { type: 'join'; roomCode: string; name: string; sessionId?: string; locale?: SupportedLocale } // become/resume a player
  | { type: 'spectate'; roomCode: string; locale?: SupportedLocale; displayToken?: string; playerCount?: 1 | 2 } // the shared display (no slot)
  | { type: 'configure_players'; count: 1 | 2 }         // standalone display reserves the phone seats
  | { type: 'select_monster'; monsterId: string }           // during monster_select
  | { type: 'display_select_monster'; playerId:string; monsterId:string } // authenticated shared display only
  | { type: 'ack_event'; generation:number; eventId:number } // displayed battle beat
  | { type: 'ack_results'; generation:number }              // results overlay paint
  | { type: 'open_fight' }                                  // battle: active side opens its 4 moves
  | { type: 'back_menu' }                                   // battle: active side backs out to root menu
  | { type: 'choose_move'; moveId: string }                 // FIGHT shim (kept for back-compat)
  | { type: 'choose_action'; action: BattleAction }         // a turn action: fight/guard/item/taunt
  | { type: 'advance' }                                     // host: lobby→select→battle / rematch
  | { type: 'back' }                                        // host: step back a phase
  | { type: 'leave'; sessionId?: string };                   // drop the player slot, keep watching

/** One selectable creature, flattened for the select screen (no logic, just display data). */
export interface RosterEntry {
  id: string; name: string; type: string; blurb: string;
  maxHp: number; attack: number; defense: number; speed: number;
  moves: { id: string; name: string; type: string; power: number }[];
}

/** A player row for the lobby / monster-select screens. */
export interface BattleLobbyPlayer { playerId: string; side?: 'a' | 'b'; name: string; nameConfirmed: boolean; monsterId: string | null; setupReady: boolean; phonePending?: boolean; isAi: boolean; }

/** Server → client. */
export type BattleServerMessage =
  | { type: 'joined'; playerId: string; roomCode: string }
  | { type: 'session_released'; sessionId: string }
  | { type: 'roster'; monsters: RosterEntry[] }             // sent on connect for the select screen
  | { type: 'host_identity'; roomCode: string; isHost: boolean }
  | { type: 'battle_state'; roomCode: string; phase: string;
      players: BattleLobbyPlayer[]; snapshot: BattleSnapshot | null;
      expectedPlayerCount: number;
      generation:number; resultsPresented:boolean;
      canAdvanceLobby:boolean; canStartBattle:boolean;
      activeSide?: 'a' | 'b' | null; activeMenu?: 'root' | 'fight';
      canRematch?: boolean;
      result: { winner: string; winnerName: string } | null }
  | { type: 'battle_events'; generation:number; eventIds:number[]; events: BattleEvent[] } // ordered paint receipts
  | { type: 'show_results'; generation:number }             // voice/touch skip of optional battle-end hold
  | { type: 'error'; code: string; message: string };

type ParseResult = BattleClientMessage | { type: 'error'; code: string; message: string };

/** Validate + narrow an untrusted client frame. Returns an error message on anything malformed. */
export function parseBattleClientMessage(raw: string): ParseResult {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return err('bad_json', 'invalid JSON'); }
  if (!o || typeof o !== 'object') return err('bad_message', 'missing type');
  const m = o as Record<string, unknown>;
  switch (m.type) {
    case 'join':
      if (typeof m.roomCode !== 'string' || typeof m.name !== 'string') return err('bad_join', 'roomCode + name required');
      if (m.sessionId !== undefined && (typeof m.sessionId !== 'string' || !m.sessionId.trim() || m.sessionId.length > 128)) return err('bad_join', 'invalid sessionId');
      return { type: 'join', roomCode: m.roomCode, name: m.name,
        ...(typeof m.sessionId === 'string' ? { sessionId: m.sessionId } : {}),
        ...(isSupportedLocale(m.locale) ? { locale: m.locale } : {}) };
    case 'spectate':
      if (typeof m.roomCode !== 'string') return err('bad_spectate', 'roomCode required');
      if (m.playerCount !== undefined && m.playerCount !== 1 && m.playerCount !== 2)
        return err('bad_player_count', 'playerCount must be 1 or 2');
      return { type: 'spectate', roomCode: m.roomCode,
        ...(isSupportedLocale(m.locale) ? { locale: m.locale } : {}),
        ...(typeof m.displayToken === 'string' ? { displayToken: m.displayToken } : {}),
        ...(m.playerCount === 1 || m.playerCount === 2 ? { playerCount: m.playerCount } : {}) };
    case 'configure_players':
      return m.count === 1 || m.count === 2
        ? { type: 'configure_players', count: m.count }
        : err('bad_player_count', 'count must be 1 or 2');
    case 'select_monster':
      if (typeof m.monsterId !== 'string') return err('bad_select', 'monsterId required');
      return { type: 'select_monster', monsterId: m.monsterId };
    case 'display_select_monster':
      if(typeof m.playerId!=='string'||!m.playerId.trim()||m.playerId.length>64
        ||typeof m.monsterId!=='string'||!m.monsterId.trim()||m.monsterId.length>64)
        return err('bad_select','playerId + monsterId required');
      return {type:'display_select_monster',playerId:m.playerId,monsterId:m.monsterId};
    case 'ack_event':
      if(!Number.isSafeInteger(m.generation)||!Number.isSafeInteger(m.eventId)
        ||(m.generation as number)<1||(m.eventId as number)<1)return err('bad_ack','invalid event receipt');
      return {type:'ack_event',generation:m.generation as number,eventId:m.eventId as number};
    case 'ack_results':
      if(!Number.isSafeInteger(m.generation)||(m.generation as number)<1)return err('bad_ack','invalid result receipt');
      return {type:'ack_results',generation:m.generation as number};
    case 'open_fight': return { type: 'open_fight' };
    case 'back_menu':  return { type: 'back_menu' };
    case 'choose_move':
      if (typeof m.moveId !== 'string') return err('bad_move', 'moveId required');
      return { type: 'choose_move', moveId: m.moveId };
    case 'choose_action': {
      const action = parseAction(m.action);
      if (!action) return err('bad_action', 'valid action required');
      return { type: 'choose_action', action };
    }
    case 'advance': return { type: 'advance' };
    case 'back':    return { type: 'back' };
    case 'leave':
      if (m.sessionId !== undefined && (typeof m.sessionId !== 'string' || !m.sessionId.trim() || m.sessionId.length > 128)) return err('bad_leave', 'invalid sessionId');
      return { type: 'leave', ...(typeof m.sessionId === 'string' ? { sessionId: m.sessionId } : {}) };
    default:        return err('unknown_type', `unknown type ${String(m.type)}`);
  }
}
function err(code: string, message: string): { type: 'error'; code: string; message: string } {
  return { type: 'error', code, message };
}

/** Validate + narrow an untrusted BattleAction (fight/guard/item/taunt). Returns null if malformed. */
function parseAction(a: unknown): BattleAction | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  switch (o.kind) {
    case 'fight': return typeof o.moveId === 'string' ? { kind: 'fight', moveId: o.moveId } : null;
    case 'item':  return o.item === 'potion' ? { kind: 'item', item: 'potion' } : null;
    case 'guard': return { kind: 'guard' };
    case 'taunt': return { kind: 'taunt' };
    default:      return null;
  }
}
