import type { FighterCommand, FighterEvent, FighterWorld } from './fighter-world';
import type { FighterMapEntry, FighterRosterEntry } from './fighter-roster';
import { isSupportedLocale, type SupportedLocale } from './i18n/locales';

export type FighterPhase = 'lobby' | 'fighter_select' | 'map_select' | 'loading' | 'intro' | 'countdown' | 'fight' | 'victory' | 'results';
export type FighterIntroStage = 'p1' | 'versus' | 'p2' | 'faceoff';
export const FIGHTER_INTRO_SECONDS = 14;
export function fighterIntroStage(remaining: number): FighterIntroStage {
  if (remaining > 10) return 'p1';
  if (remaining > 8) return 'versus';
  if (remaining > 4) return 'p2';
  return 'faceoff';
}
export interface FighterLobbyPlayer {
  playerId: string; name: string; fighterId: string | null; side: 'p1' | 'p2' | null; isAi: boolean;
}
export interface FighterState {
  roomCode: string; phase: FighterPhase; players: FighterLobbyPlayer[];
  /** Solo rival chosen during arena setup so its real model can load before the fight. */
  aiFighterId: string | null;
  selectedMap: string | null; mapVotesByPlayerId:Record<string,string>; world: FighterWorld | null;
  expectedPlayerCount: number; hasExpectedPlayers: boolean;
  automaticSetup:boolean;
  loadingGeneration: number;
  hudPresented:boolean; resultsPresented:boolean;
  intro: number | null;
  countdown: number | null;
  result: { winner: 'p1' | 'p2'; winnerName: string } | null;
}

export type FighterClientMessage =
  | { type: 'join'; roomCode: string; name: string; sessionId?: string; locale?: SupportedLocale }
  | { type: 'spectate'; roomCode: string; locale?: SupportedLocale }
  | { type: 'display_auth'; roomCode: string; token: string }
  | { type: 'select_fighter'; fighterId: string }
  | { type: 'select_map'; mapId: string }
  | { type: 'display_select_fighter'; playerId: string; fighterId: string }
  | { type: 'display_select_map'; playerId: string; mapId: string }
  | { type: 'ack_display'; phase:'fight'|'results'; loadingGeneration:number }
  | { type: 'command'; command: FighterCommand }
  | { type: 'advance' }
  | { type: 'ready'; loadingGeneration: number }
  | { type: 'retry_loading'; loadingGeneration: number }
  | { type: 'back' }
  | { type: 'leave'; sessionId?: string };

export type FighterServerMessage =
  | { type: 'fighter_capabilities'; displayAuth: boolean }
  | { type: 'joined'; playerId: string; roomCode: string }
  | { type: 'host_identity'; roomCode: string; isHost: boolean; loadingGeneration: number }
  | { type: 'fighter_roster'; fighters: FighterRosterEntry[]; maps: FighterMapEntry[] }
  | ({ type: 'fighter_state' } & FighterState)
  | { type: 'fighter_events'; events: FighterEvent[] }
  | { type: 'show_results'; loadingGeneration:number }
  | { type: 'error'; code: string; message: string };

export function parseFighterClientMessage(raw: string): FighterClientMessage | { type: 'error'; code: string; message: string } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return error('bad_json', 'invalid JSON'); }
  if (!value || typeof value !== 'object') return error('bad_message', 'missing type');
  const m = value as Record<string, unknown>;
  const short = (v: unknown, max = 64) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  switch (m.type) {
    case 'join':
      if (!short(m.roomCode, 16) || !short(m.name, 40)) return error('bad_join', 'roomCode + name required');
      if (m.sessionId !== undefined && !short(m.sessionId, 128)) return error('bad_join', 'invalid sessionId');
      return { type: 'join', roomCode: m.roomCode as string, name: m.name as string,
        ...(typeof m.sessionId === 'string' ? { sessionId: m.sessionId } : {}),
        ...(isSupportedLocale(m.locale) ? { locale: m.locale } : {}) };
    case 'spectate': return short(m.roomCode, 16)
      ? { type: 'spectate', roomCode: m.roomCode as string, ...(isSupportedLocale(m.locale) ? { locale: m.locale } : {}) }
      : error('bad_spectate', 'roomCode required');
    case 'display_auth':
      if (!short(m.roomCode, 16) || !short(m.token, 256)) return error('bad_display_auth', 'roomCode + token required');
      return { type: 'display_auth', roomCode: m.roomCode as string, token: m.token as string };
    case 'select_fighter': return short(m.fighterId) ? { type: 'select_fighter', fighterId: m.fighterId as string } : error('bad_select', 'fighterId required');
    case 'select_map': return short(m.mapId) ? { type: 'select_map', mapId: m.mapId as string } : error('bad_select', 'mapId required');
    case 'display_select_fighter': return short(m.playerId) && short(m.fighterId)
      ? { type: 'display_select_fighter', playerId: m.playerId as string, fighterId: m.fighterId as string }
      : error('bad_select', 'playerId + fighterId required');
    case 'display_select_map': return short(m.playerId) && short(m.mapId)
      ? { type: 'display_select_map', playerId: m.playerId as string, mapId: m.mapId as string }
      : error('bad_select', 'playerId + mapId required');
    case 'ack_display':
      return (m.phase==='fight'||m.phase==='results')&&Number.isSafeInteger(m.loadingGeneration)
        &&(m.loadingGeneration as number)>=1
        ? {type:'ack_display',phase:m.phase,loadingGeneration:m.loadingGeneration as number}
        :error('bad_ack','invalid display paint receipt');
    case 'command': return isCommand(m.command) ? { type: 'command', command: m.command } : error('bad_command', 'invalid fighter command');
    case 'advance': return { type: 'advance' };
    case 'ready':
      if (!Number.isSafeInteger(m.loadingGeneration) || (m.loadingGeneration as number) < 1) return error('bad_ready', 'invalid loadingGeneration');
      return { type: 'ready', loadingGeneration: m.loadingGeneration as number };
    case 'retry_loading':
      return Number.isSafeInteger(m.loadingGeneration) && (m.loadingGeneration as number) >= 1
        ? { type: 'retry_loading', loadingGeneration: m.loadingGeneration as number }
        : error('bad_ready', 'invalid loadingGeneration');
    case 'back': return { type: 'back' };
    case 'leave': return { type: 'leave', ...(typeof m.sessionId === 'string' ? { sessionId: m.sessionId } : {}) };
    default: return error('unknown_type', `unknown type ${String(m.type)}`);
  }
}

function isCommand(value: unknown): value is FighterCommand {
  return typeof value === 'string' && ['forward', 'back', 'jump', 'punch', 'kick', 'block'].includes(value);
}
function error(code: string, message: string) { return { type: 'error' as const, code, message }; }
