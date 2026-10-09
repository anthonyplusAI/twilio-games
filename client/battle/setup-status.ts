import type { BattleLobbyPlayer } from '../../shared/battle-protocol';

export type SetupSeatState = 'open' | 'phone' | 'name_needed' | 'needs_ready' | 'needs_monster' | 'needs_battle' | 'needs_rematch' | 'ready';
export interface SetupSeat {
  playerId: string | null;
  seatNumber: number;
  name: string | null;
  state: SetupSeatState;
}

export function setupSeatStates(
  phase: 'lobby' | 'monster_select', players: BattleLobbyPlayer[], expectedPlayerCount: number,
): SetupSeat[] {
  const humans = players.filter(player => !player.isAi);
  const count = Math.min(2, Math.max(1, expectedPlayerCount, humans.length));
  return Array.from({ length: count }, (_, index) => {
    const player = seatPlayer(humans, index);
    if (!player) return { playerId: null, seatNumber: index + 1, name: null, state: 'open' };
    const name = player.nameConfirmed ? player.name : null;
    const state: SetupSeatState = player.phonePending ? 'phone' : !player.nameConfirmed ? 'name_needed'
      : phase === 'lobby' ? player.setupReady ? 'ready' : 'needs_ready'
        : !player.monsterId ? 'needs_monster' : player.setupReady ? 'ready' : 'needs_battle';
    return { playerId: player.playerId, seatNumber: index + 1, name, state };
  });
}

export function rematchSeatStates(players: BattleLobbyPlayer[]): SetupSeat[] {
  const humans = players.filter(player => !player.isAi);
  return Array.from({ length: 2 }, (_, index) => {
    const player = seatPlayer(humans, index);
    if (!player) return { playerId: null, seatNumber: index + 1, name: null, state: 'open' };
    return { playerId: player.playerId, seatNumber: index + 1,
      name: player.nameConfirmed ? player.name : null,
      state: player.phonePending ? 'phone' : player.setupReady ? 'ready' : 'needs_rematch' };
  });
}

export function isSharedRematch(snapshot: { b: { id: string } } | null, players: BattleLobbyPlayer[]): boolean {
  return Boolean(snapshot && (snapshot.b.id !== 'cpu' || players.filter(player => !player.isAi).length >= 2));
}

function seatPlayer(humans: BattleLobbyPlayer[], index: number): BattleLobbyPlayer | undefined {
  return humans.some(player => player.side)
    ? humans.find(player => player.side === (index === 0 ? 'a' : 'b'))
    : humans[index];
}

export function touchSelectionTarget(
  players: BattleLobbyPlayer[], selectedPlayerId: string | null, requireExplicit: boolean,
): string | null {
  const humans = players.filter(player => !player.isAi);
  if (selectedPlayerId && humans.some(player => player.playerId === selectedPlayerId
    && (!requireExplicit || player.nameConfirmed)))
    return selectedPlayerId;
  if (requireExplicit) return null;
  return humans.find(player => !player.monsterId)?.playerId ?? humans[0]?.playerId ?? null;
}
