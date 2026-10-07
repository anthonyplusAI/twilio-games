import { isSafeKaraokeId, type KaraokeLane, type KaraokeSong } from './karaoke';
import { isSupportedLocale, type SupportedLocale } from './i18n/locales';

export const KARAOKE_MAX_SCORE = 100_000;
export const KARAOKE_COUNTDOWN_MS = 3_000;
export const KARAOKE_LOADING_TIMEOUT_MS = 30_000;
export const KARAOKE_PROTOCOL_MAX_JSON_LENGTH = 16 * 1024;

export type KaraokePhase =
  | 'lobby'
  | 'song_select'
  | 'loading'
  | 'countdown'
  | 'performing'
  | 'finalizing'
  | 'results';

export type KaraokeJudgment = 'perfect' | 'good' | 'miss';

export interface KaraokeSinger {
  playerId: string;
  name: string;
  nameConfirmed: boolean;
}

export interface KaraokeResult {
  generation: number;
  playerId: string;
  name: string;
  songId: string;
  score: number;
  bestCombo: number;
  completedAtMs: number;
}

export type KaraokeEvent =
  | { type: 'word_judgment'; wordId: string; judgment: KaraokeJudgment; points: number; score: number; combo: number; atMs: number }
  | { type: 'combo'; combo: number; bestCombo: number; atMs: number }
  | { type: 'countdown'; count: 3 | 2 | 1; atMs: number }
  | { type: 'start'; startedAtMs: number; endsAtMs: number }
  | { type: 'loading_timeout'; generation: number; displayReady: boolean; mediaReady: boolean; atMs: number }
  | { type: 'result'; result: KaraokeResult };

export interface KaraokeState {
  roomCode: string;
  phase: KaraokePhase;
  singer: KaraokeSinger | null;
  expectedPlayerCount: 1;
  hasExpectedPlayers: boolean;
  automaticSetup: boolean;
  preferredLocale: SupportedLocale;
  catalog: readonly KaraokeSong[];
  selectedSong: KaraokeSong | null;
  selectedByPlayerId: string | null;
  /** Increments even when the current singer selects the same song again. */
  selectionGeneration: number;
  loadingGeneration: number;
  /** Present on server snapshots; optional for locally-created demo/test snapshots. */
  displayReady?: boolean;
  mediaReady?: boolean;
  mediaSongStartTimestampMs?: number | null;
  serverNowMs: number;
  countdown: number | null;
  countdownEndsAtMs: number | null;
  performanceStartedAtMs: number | null;
  performanceEndsAtMs: number | null;
  score: number;
  combo: number;
  bestCombo: number;
  result: KaraokeResult | null;
}

export type KaraokeClientMessage =
  | { type: 'join'; roomCode: string; name: string; sessionId?: string; locale?: SupportedLocale }
  | { type: 'spectate'; roomCode: string; locale?: SupportedLocale }
  | { type: 'display_auth'; roomCode: string; token: string }
  | { type: 'clock_sync'; clientSentAtMs: number }
  | { type: 'select_song'; songId: string }
  | { type: 'advance' }
  | { type: 'ready'; loadingGeneration: number }
  | { type: 'retry_loading'; loadingGeneration: number }
  | { type: 'lane_input'; lane: KaraokeLane }
  | { type: 'leave'; sessionId?: string };

export type KaraokeErrorMessage = { type: 'error'; code: string; message: string };

export type KaraokeServerMessage =
  | { type: 'karaoke_capabilities'; displayAuth: boolean }
  | { type: 'clock_sync'; clientSentAtMs: number; serverNowMs: number }
  | { type: 'joined'; playerId: string; roomCode: string }
  | { type: 'host_identity'; roomCode: string; isHost: boolean; loadingGeneration: number }
  | { type: 'karaoke_catalog'; locale: SupportedLocale; songs: readonly KaraokeSong[] }
  | ({ type: 'karaoke_state' } & KaraokeState)
  | { type: 'karaoke_events'; events: KaraokeEvent[] }
  | KaraokeErrorMessage;

/** Strictly parses the only commands an untrusted browser may send. Scoring is intentionally absent. */
export function parseKaraokeClientMessage(raw: string): KaraokeClientMessage | KaraokeErrorMessage {
  if (typeof raw !== 'string' || raw.length > KARAOKE_PROTOCOL_MAX_JSON_LENGTH) {
    return error('bad_json', 'message is too large');
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return error('bad_json', 'invalid JSON');
  }
  if (!isRecord(value)) return error('bad_message', 'message must be an object');

  switch (value.type) {
    case 'join': {
      if (!hasOnlyKeys(value, ['type', 'roomCode', 'name', 'sessionId', 'locale'])) return badFields('bad_join');
      if (!shortText(value.roomCode, 16) || !shortText(value.name, 40)) {
        return error('bad_join', 'roomCode + name required');
      }
      if (value.sessionId !== undefined && !shortText(value.sessionId, 128)) {
        return error('bad_join', 'invalid sessionId');
      }
      if (value.locale !== undefined && !isSupportedLocale(value.locale)) {
        return error('bad_join', 'invalid locale');
      }
      return {
        type: 'join',
        roomCode: value.roomCode,
        name: value.name,
        ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
        ...(isSupportedLocale(value.locale) ? { locale: value.locale } : {}),
      };
    }
    case 'spectate': {
      if (!hasOnlyKeys(value, ['type', 'roomCode', 'locale'])) return badFields('bad_spectate');
      if (!shortText(value.roomCode, 16)) return error('bad_spectate', 'roomCode required');
      if (value.locale !== undefined && !isSupportedLocale(value.locale)) {
        return error('bad_spectate', 'invalid locale');
      }
      return {
        type: 'spectate',
        roomCode: value.roomCode,
        ...(isSupportedLocale(value.locale) ? { locale: value.locale } : {}),
      };
    }
    case 'display_auth':
      if (!hasOnlyKeys(value, ['type', 'roomCode', 'token'])
        || !shortText(value.roomCode, 16) || !shortText(value.token, 256)) {
        return error('bad_display_auth', 'roomCode + token required');
      }
      return { type: 'display_auth', roomCode: value.roomCode, token: value.token };
    case 'clock_sync':
      if (!hasOnlyKeys(value, ['type', 'clientSentAtMs'])
        || !Number.isSafeInteger(value.clientSentAtMs) || (value.clientSentAtMs as number) < 0) {
        return error('bad_clock_sync', 'clientSentAtMs must be a non-negative safe integer');
      }
      return { type: 'clock_sync', clientSentAtMs: value.clientSentAtMs as number };
    case 'select_song':
      if (!hasOnlyKeys(value, ['type', 'songId']) || !isSafeKaraokeId(value.songId)) {
        return error('bad_select', 'valid songId required');
      }
      return { type: 'select_song', songId: value.songId };
    case 'advance':
      return hasOnlyKeys(value, ['type']) ? { type: 'advance' } : badFields('bad_advance');
    case 'ready':
    case 'retry_loading': {
      if (!hasOnlyKeys(value, ['type', 'loadingGeneration'])
        || !Number.isSafeInteger(value.loadingGeneration) || (value.loadingGeneration as number) < 1) {
        return error('bad_ready', 'invalid loadingGeneration');
      }
      return { type: value.type, loadingGeneration: value.loadingGeneration as number };
    }
    case 'lane_input':
      if (!hasOnlyKeys(value, ['type', 'lane']) || !Number.isInteger(value.lane)
        || (value.lane as number) < 0 || (value.lane as number) > 3) {
        return error('bad_lane_input', 'lane must be an integer from 0 to 3');
      }
      return { type: 'lane_input', lane: value.lane as KaraokeLane };
    case 'leave':
      if (!hasOnlyKeys(value, ['type', 'sessionId'])
        || (value.sessionId !== undefined && !shortText(value.sessionId, 128))) {
        return error('bad_leave', 'invalid leave message');
      }
      return { type: 'leave', ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}) };
    default:
      return error('unknown_type', `unknown type ${String(value.type)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every(key => allowed.includes(key));
}

function shortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
}

function badFields(code: string): KaraokeErrorMessage {
  return error(code, 'unsupported message fields');
}

function error(code: string, message: string): KaraokeErrorMessage {
  return { type: 'error', code, message };
}
