import type { FighterConnectionState } from './fighter-net';
import type { FighterLobbyPlayer, FighterState } from '../../shared/fighter-protocol';

export type FighterSharedSeatStatus = 'shared.waitingSeat' | 'shared.phoneReconnect'
  | 'shared.phonePending' | 'shared.phonePendingVote' | 'shared.phoneRetry'
  | 'shared.phoneConversation' | 'shared.backRequested'
  | 'shared.ready' | 'shared.naming' | 'shared.choosingFighter'
  | 'shared.choosingArena' | 'shared.waitingConfirm';

export function fighterSharedSeatStatus(
  state: FighterState, player: FighterLobbyPlayer | null | undefined,
): FighterSharedSeatStatus {
  if (!player) return 'shared.waitingSeat';
  const ready = state.advanceReadyPlayerIds.includes(player.playerId);
  const back = state.backReadyPlayerIds.includes(player.playerId);
  if (state.phoneDisconnectedPlayerIds.includes(player.playerId)) return 'shared.phoneReconnect';
  if (state.phoneRetryPlayerIds.includes(player.playerId)) return 'shared.phoneRetry';
  if (state.phoneTurnPendingPlayerIds.includes(player.playerId)) return 'shared.phoneConversation';
  if (state.phonePendingPlayerIds.includes(player.playerId))
    return ready || back ? 'shared.phonePendingVote' : 'shared.phonePending';
  if (back) return 'shared.backRequested';
  if (ready) return 'shared.ready';
  if (state.phase === 'lobby' && player.nameConfirmed === false) return 'shared.naming';
  if (state.phase === 'fighter_select' && !player.fighterId) return 'shared.choosingFighter';
  if (state.phase === 'map_select' && !state.mapVotesByPlayerId[player.playerId]) return 'shared.choosingArena';
  return 'shared.waitingConfirm';
}

export type FighterResultActionState = 'station' | 'rematch' | 'viewer' | 'reconnecting' | 'unavailable';

/** Match the visible result action to the authority held by this browser socket. */
export function fighterResultActionState(
  stationManaged: boolean,
  isHost: boolean,
  connection: FighterConnectionState,
  phase: string | undefined,
): FighterResultActionState {
  if (stationManaged) return 'station';
  if (phase !== 'results') return 'unavailable';
  if (connection !== 'connected') return 'reconnecting';
  return isHost ? 'rematch' : 'viewer';
}

export interface NumericSelection {
  buffer: string;
  selection: number | null;
  waiting: boolean;
}

export function resolveNumericSelection(buffer: string, key: string, total: number): NumericSelection {
  if (!/^\d$/.test(key) || total < 1) return { buffer: '', selection: null, waiting: false };
  const candidate = `${buffer}${key}`.slice(-2);
  const value = Number(candidate);
  if (buffer && value >= 1 && value <= total) return { buffer: '', selection: value, waiting: false };
  if (value >= 1 && value <= total && value * 10 > total) return { buffer: '', selection: value, waiting: false };
  if (value * 10 <= total || candidate === '0') return { buffer: candidate, selection: null, waiting: true };
  const single = Number(key);
  return single >= 1 && single <= total
    ? { buffer: '', selection: single, waiting: false }
    : { buffer: '', selection: null, waiting: false };
}

export function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return !!element?.closest?.('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="button"]');
}
