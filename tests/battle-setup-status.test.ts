import { describe, expect, it } from 'vitest';
import { isSharedRematch, rematchSeatStates, setupSeatStates, touchSelectionTarget } from '../client/battle/setup-status';

describe('Monsters shared-screen setup seats', () => {
  it('shows each caller’s name confirmation and readiness separately', () => {
    const seats = setupSeatStates('lobby', [
      { playerId: 'p1', name: 'Ada', nameConfirmed: true, monsterId: null, setupReady: true, isAi: false },
      { playerId: 'p2', name: 'Challenger', nameConfirmed: false, monsterId: null, setupReady: false, isAi: false },
    ], 2);
    expect(seats).toEqual([
      { playerId: 'p1', seatNumber: 1, name: 'Ada', state: 'ready' },
      { playerId: 'p2', seatNumber: 2, name: null, state: 'name_needed' },
    ]);
  });

  it('keeps an empty second seat visible until the caller joins', () => {
    const seats = setupSeatStates('lobby', [
      { playerId: 'p1', name: 'Ada', nameConfirmed: true, monsterId: null, setupReady: true, isAi: false },
    ], 2);
    expect(seats[1]).toEqual({ playerId: null, seatNumber: 2, name: null, state: 'open' });
  });

  it('separates monster choice from the caller’s battle confirmation', () => {
    const seats = setupSeatStates('monster_select', [
      { playerId: 'p1', name: 'Ada', nameConfirmed: true, monsterId: 'sparkmouse', setupReady: true, isAi: false },
      { playerId: 'p2', name: 'Bo', nameConfirmed: true, monsterId: 'embertail', setupReady: false, isAi: false },
    ], 2);
    expect(seats).toEqual([
      { playerId: 'p1', seatNumber: 1, name: 'Ada', state: 'ready' },
      { playerId: 'p2', seatNumber: 2, name: 'Bo', state: 'needs_battle' },
    ]);
  });

  it('shows an in-progress phone prompt before the caller’s next setup action', () => {
    const seats = setupSeatStates('monster_select', [
      { playerId: 'p1', side: 'a', name: 'Ada', nameConfirmed: true, monsterId: 'sparkmouse', setupReady: true, phonePending: false, isAi: false },
      { playerId: 'p2', side: 'b', name: 'Bo', nameConfirmed: true, monsterId: 'embertail', setupReady: true, phonePending: true, isAi: false },
    ], 2);
    expect(seats.map(seat => seat.state)).toEqual(['ready', 'phone']);
  });

  it('keeps a surviving caller in the same result seat and shows a replacement’s phone response', () => {
    const survivor = { playerId: 'p2', side: 'b' as const, name: 'Bo', nameConfirmed: true,
      monsterId: 'embertail', setupReady: true, phonePending: false, isAi: false };
    expect(rematchSeatStates([survivor])).toEqual([
      { playerId: null, seatNumber: 1, name: null, state: 'open' },
      { playerId: 'p2', seatNumber: 2, name: 'Bo', state: 'ready' },
    ]);
    const replacement = { playerId: 'p3', side: 'a' as const, name: 'Cy', nameConfirmed: true,
      monsterId: null, setupReady: true, phonePending: true, isAi: false };
    expect(rematchSeatStates([replacement, survivor]).map(seat => seat.state)).toEqual(['phone', 'ready']);
    expect(isSharedRematch({ b: { id: 'p2' } }, [survivor])).toBe(true);
    expect(isSharedRematch({ b: { id: 'cpu' } }, [replacement, survivor])).toBe(true);
  });

  it('requires a named seat to be tapped before a shared two-caller screen assigns a monster', () => {
    const players = [
      { playerId: 'p1', name: 'Ada', nameConfirmed: true, monsterId: null, setupReady: false, isAi: false },
      { playerId: 'p2', name: 'Bo', nameConfirmed: true, monsterId: null, setupReady: false, isAi: false },
    ];
    expect(touchSelectionTarget(players, null, true)).toBeNull();
    expect(touchSelectionTarget(players, 'p2', true)).toBe('p2');
    expect(touchSelectionTarget(players, 'left-player', true)).toBeNull();
    expect(touchSelectionTarget(players, null, false)).toBe('p1');
    players[1]!.nameConfirmed = false;
    expect(touchSelectionTarget(players, 'p2', true)).toBeNull();
  });
});
