import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { FighterActor } from '../client/fighter/fighter-actor';
import { FighterActorLoadCoordinator, FighterWarmupRetryBudget, fighterActorLoadContext, fighterShouldRetainActor, fighterWarmupCandidates } from '../client/fighter/fighter-actor-loading';
import { loadAnimationSources } from '../client/fighter/fighter-assets';
import type { FighterState } from '../shared/fighter-protocol';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function state(phase: FighterState['phase'], generation = 4): FighterState {
  return {
    roomCode: 'TEST', phase, loadingGeneration: generation, selectedMap: 'foundry', aiFighterId: null,
    mapVotesByPlayerId: {}, expectedPlayerCount: 2, hasExpectedPlayers: true, automaticSetup: false, players: [
      { playerId: 'one', name: 'One', side: 'p1', fighterId: 'nyx', isAi: false },
      { playerId: 'two', name: 'Two', side: 'p2', fighterId: 'wraith', isAi: false },
    ], world: null, intro: null, countdown: null, result: null,
    hudPresented:false,resultsPresented:false,
  };
}

describe('Fighter actor loading coordination', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('keeps an authored character and its embedded idle when external animation downloads fail', async () => {
    const model = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
    body.position.y = 1;
    model.add(body);
    model.animations = [new THREE.AnimationClip('embedded-idle', 1, [
      new THREE.NumberKeyframeTrack('.rotation[z]', [0, 0.5, 1], [0, 0.01, 0]),
    ])];
    vi.spyOn(FBXLoader.prototype, 'parse').mockReturnValue(model);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })));

    const actor = await FighterActor.load({ id: 'ember', label: 'Ember', file: 'ember.fbx', embeddedIdle: true }, new Map());

    expect(actor.model).toBe(model);
    expect(actor.playRandom('punch')).toBeGreaterThan(0);
    expect(actor.playRandom('walk-back')).toBeGreaterThan(0);
    expect(actor.playRandom('fall', { hold: true, fade: 0, lockFloor: true })).toBeGreaterThan(0);
    actor.update(0.6);
    expect(model.rotation.z).toBeGreaterThan(0.5);
    actor.dispose();
  });

  it('still animates an authored character without an embedded idle when the clip bank is empty', async () => {
    const model = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
    body.position.y = 1;
    model.add(body);
    vi.spyOn(FBXLoader.prototype, 'parse').mockReturnValue(model);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })));

    const actor = await FighterActor.load({ id: 'nyx', label: 'Nyx', file: 'nyx.fbx' }, new Map());

    expect(actor.model).toBe(model);
    expect(actor.playRandom('idle', { loop: true })).toBeGreaterThan(0);
    expect(actor.playRandom('kick')).toBeGreaterThan(0);
    actor.dispose();
  });

  it('retains a downloaded fighter when one shared startup clip fails', async () => {
    const model = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
    body.position.y = 1;
    model.add(body);
    const hips = new THREE.Bone();
    hips.name = 'mixamorigHips';
    model.add(hips);
    const clip = new THREE.AnimationClip('motion', 1, [
      new THREE.QuaternionKeyframeTrack('mixamorig10Hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    vi.spyOn(FBXLoader.prototype, 'parse').mockImplementation(buffer => {
      if (typeof buffer !== 'string' && new Uint8Array(buffer)[0] === 2) return model;
      const animation = new THREE.Group();
      animation.animations = [clip];
      return animation;
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('run-backward.fbx')
      ? new Response(null, { status: 503 })
      : new Response(new Uint8Array([url.includes('nyx.fbx') ? 2 : 1]), { status: 200 })));

    const actor = await FighterActor.load({ id: 'nyx', label: 'Nyx', file: 'nyx.fbx' }, loadAnimationSources());

    expect(actor.model).toBe(model);
    expect(actor.playRandom('walk-back')).toBeGreaterThan(0);
    expect(actor.playRandom('punch')).toBeGreaterThan(0);
    actor.dispose();
  });

  it('uses the authored actors when they finish inside the first-attempt window', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const ready = vi.fn(), fallback = vi.fn();
    const coordinator = new FighterActorLoadCoordinator(12_000);
    coordinator.start('4:nyx:wraith', () => pending.promise, () => true, ready, fallback);
    await vi.advanceTimersByTimeAsync(8_000);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

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

  it('warms only selected characters during setup, before arena voting finishes', () => {
    const lobby=state('lobby');
    expect(fighterWarmupCandidates(lobby)).toEqual([]);
    const choosing=state('fighter_select');
    choosing.players[1]!.fighterId=null;
    expect(fighterWarmupCandidates(choosing)).toEqual(['nyx']);
    choosing.players[1]!.fighterId='wraith';
    expect(fighterWarmupCandidates(choosing)).toEqual(['nyx','wraith']);
    expect(fighterWarmupCandidates(state('map_select'))).toEqual(['nyx','wraith']);
    const solo = state('map_select');
    solo.players.splice(1);
    solo.aiFighterId = 'gran-slam';
    expect(fighterWarmupCandidates(solo)).toEqual(['nyx', 'gran-slam']);
    expect(fighterShouldRetainActor(solo, 'gran-slam')).toBe(true);
    expect(fighterWarmupCandidates(state('fight'))).toEqual([]);
  });

  it('discards a late actor once its selection or match is no longer current', () => {
    const choosing=state('fighter_select');
    expect(fighterShouldRetainActor(choosing,'nyx')).toBe(true);
    choosing.players[0]!.fighterId='cinder-capone';
    expect(fighterShouldRetainActor(choosing,'nyx')).toBe(false);
    expect(fighterShouldRetainActor(choosing,'cinder-capone')).toBe(true);
    expect(fighterShouldRetainActor(state('loading'),'wraith')).toBe(true);
    expect(fighterShouldRetainActor(state('results'),'wraith')).toBe(false);
  });

  it('gives a selected model one delayed retry after a transient setup failure', () => {
    const budget = new FighterWarmupRetryBudget(3_500, 2);
    expect(budget.canStart('nyx', 0)).toBe(true);
    expect(budget.failed('nyx', 100)).toBe(3_500);
    expect(budget.canStart('nyx', 3_599)).toBe(false);
    expect(budget.canStart('nyx', 3_600)).toBe(true);
    budget.succeeded('nyx');
    expect(budget.canStart('nyx', 3_600)).toBe(true);

    expect(budget.failed('nyx', 4_000)).toBe(3_500);
    expect(budget.failed('nyx', 7_500)).toBeNull();
    expect(budget.canStart('nyx', 100_000)).toBe(false);
    budget.retainOnly(new Set(['wraith']));
    expect(budget.canStart('nyx', 100_000)).toBe(true);
  });
});
