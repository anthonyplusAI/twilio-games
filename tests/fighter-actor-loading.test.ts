import { afterEach, describe, expect, it, vi } from 'vitest';
import { FighterActorLoadCoordinator, fighterActorLoadContext } from '../client/fighter/fighter-actor-loading';
import type { FighterState } from '../shared/fighter-protocol';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function state(phase: FighterState['phase'], generation = 4): FighterState {
  return {
    roomCode: 'TEST', phase, loadingGeneration: generation, selectedMap: 'foundry',
    mapVotesByPlayerId: {}, expectedPlayerCount: 2, hasExpectedPlayers: true, automaticSetup: false, players: [
      { playerId: 'one', name: 'One', side: 'p1', fighterId: 'nyx', isAi: false },
      { playerId: 'two', name: 'Two', side: 'p2', fighterId: 'wraith', isAi: false },
    ], world: null, intro: null, countdown: null, result: null,
    hudPresented:false,resultsPresented:false,
  };
}

describe('Fighter actor loading coordination', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps one load and one deadline across repeated state frames', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const coordinator = new FighterActorLoadCoordinator(12_000);
    const load = vi.fn(() => pending.promise);
    const fallback = vi.fn();
    const start = () => coordinator.start('4:nyx:wraith', load, () => true, vi.fn(), fallback);

    start();
    await vi.advanceTimersByTimeAsync(6_000);
    start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(load).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('falls back immediately on rejection and ignores a later deadline', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const coordinator = new FighterActorLoadCoordinator(12_000);
    const fallback = vi.fn();
    coordinator.start('4:nyx:wraith', () => pending.promise, () => true, vi.fn(), fallback);

    pending.reject(new Error('model failed'));
    await vi.runAllTimersAsync();

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it('does not restart presentation when a real model resolves after fallback', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const coordinator = new FighterActorLoadCoordinator(100);
    const ready = vi.fn();
    coordinator.start('4:nyx:wraith', () => pending.promise, () => true, ready, vi.fn());

    await vi.advanceTimersByTimeAsync(100);
    pending.resolve();
    await Promise.resolve();

    expect(ready).not.toHaveBeenCalled();
  });

  it('allows the same context to restart when preparation still finds missing actors', async () => {
    const first = deferred();
    const second = deferred();
    const coordinator = new FighterActorLoadCoordinator(12_000);
    const ready = vi.fn();
    let attempts = 0;
    const start = () => coordinator.start(
      '4:nyx:wraith',
      () => ++attempts === 1 ? first.promise : second.promise,
      () => true,
      () => { if (attempts === 1) start(); else ready(); },
      vi.fn(),
    );

    start();
    first.resolve();
    await vi.waitFor(() => expect(attempts).toBe(2));
    second.resolve();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  });

  it('ignores an old generation after a newer operation starts', async () => {
    const oldLoad = deferred();
    const currentLoad = deferred();
    const coordinator = new FighterActorLoadCoordinator(12_000);
    const oldReady = vi.fn();
    const currentReady = vi.fn();
    coordinator.start('4:nyx:wraith', () => oldLoad.promise, () => true, oldReady, vi.fn());
    coordinator.start('5:nyx:wraith', () => currentLoad.promise, () => true, currentReady, vi.fn());

    oldLoad.resolve();
    currentLoad.resolve();
    await vi.waitFor(() => expect(currentReady).toHaveBeenCalledTimes(1));

    expect(oldReady).not.toHaveBeenCalled();
  });

  it('cancels stale generations before they can install fallback actors', async () => {
    vi.useFakeTimers();
    const coordinator = new FighterActorLoadCoordinator(100);
    const fallback = vi.fn();
    coordinator.start('4:nyx:wraith', () => new Promise(() => {}), () => true, vi.fn(), fallback);
    coordinator.clear();

    await vi.advanceTimersByTimeAsync(100);

    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(['loading', 'intro', 'countdown', 'fight'] as const)('keeps a context during %s', phase => {
    expect(fighterActorLoadContext(state(phase))).toEqual({ key: '4:nyx:wraith', p1Id: 'nyx', p2Id: 'wraith' });
  });

  it('drops actor-loading context outside active match phases', () => {
    expect(fighterActorLoadContext(state('fighter_select'))).toBeNull();
    expect(fighterActorLoadContext(state('results'))).toBeNull();
  });
});
