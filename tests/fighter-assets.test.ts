import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { FIGHTER_ROSTER } from '../shared/fighter-roster';
import { ANIMATION_POOLS, FIGHTER_ANIMATIONS, STARTUP_ANIMATION_IDS, clipsForFighter, fighterAssetFirstAttemptMs, fighterAssetUrl, loadAnimationSources, loadFbx, preferProceduralFighterAssets, prepareFighterModel } from '../client/fighter/fighter-assets';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('fighter assets', () => {
  it('boots with one essential clip per action instead of fetching every optional variant', () => {
    expect(STARTUP_ANIMATION_IDS.length).toBeLessThan(FIGHTER_ANIMATIONS.length);
    const startupIds = new Set<string>(STARTUP_ANIMATION_IDS);
    for (const pool of ['idle', 'walk', 'walk-back', 'jump', 'block', 'punch', 'kick', 'reaction', 'fall']) {
      expect((ANIMATION_POOLS[pool] ?? []).some(id => startupIds.has(id))).toBe(true);
    }
    expect(STARTUP_ANIMATION_IDS).not.toContain('celebration-05');
  });
  it('has unique roster IDs with models and previews', () => {
    expect(new Set(FIGHTER_ROSTER.map(fighter => fighter.id)).size).toBe(FIGHTER_ROSTER.length);
    expect(FIGHTER_ROSTER).toHaveLength(12);
    for (const fighter of FIGHTER_ROSTER) {
      expect(existsSync(`assets/fighters/source/${fighter.file}`), fighter.file).toBe(true);
      expect(existsSync(fighter.preview.split('?')[0]!.replace('/assets/', 'assets/')), fighter.preview).toBe(true);
    }
  });

  it('only references existing clips from randomized pools', () => {
    const ids = new Set(FIGHTER_ANIMATIONS.map(animation => animation.id));
    for (const pool of Object.values(ANIMATION_POOLS)) for (const id of pool) expect(ids.has(id), id).toBe(true);
    expect(ANIMATION_POOLS.punch).toHaveLength(3);
    expect(ANIMATION_POOLS.kick).toHaveLength(4);
    expect(ANIMATION_POOLS.reaction).toEqual(['reaction-01', 'reaction-02', 'reaction-04', 'reaction-05']);
    expect(ANIMATION_POOLS.fall).toEqual(['fall-01', 'fall-02']);
    const filesById = new Map(FIGHTER_ANIMATIONS.map(animation => [animation.id, animation.file]));
    expect(ANIMATION_POOLS.reaction!.map(id => filesById.get(id))).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/fall|knock|stumble/i),
    ]));
    expect(ANIMATION_POOLS.celebration).toHaveLength(6);
    expect(FIGHTER_ANIMATIONS.find(animation => animation.id === 'walk')?.file).toBe('run-forward.fbx');
    expect(FIGHTER_ANIMATIONS.find(animation => animation.id === 'walk-back')?.file).toBe('run-backward.fbx');
    for (const animation of FIGHTER_ANIMATIONS) expect(existsSync(`assets/fighters/source/${animation.file}`), animation.file).toBe(true);
  });

  it('cache-busts Fighter runtime assets after binary replacements', () => {
    expect(fighterAssetUrl('fighting-idle.fbx')).toMatch(/^\/assets\/fighters\/source\/fighting-idle\.fbx\?v=\d+$/);
  });

  it('tries selected real fighters on slow links before a bounded fallback, while honoring Save Data', () => {
    expect(preferProceduralFighterAssets({ saveData: true })).toBe(true);
    expect(preferProceduralFighterAssets({ effectiveType: '3g' })).toBe(false);
    expect(preferProceduralFighterAssets({ effectiveType: '4g' })).toBe(false);
    expect(fighterAssetFirstAttemptMs({ effectiveType: '3g' })).toBe(12_000);
    expect(fighterAssetFirstAttemptMs({ effectiveType: '4g' })).toBe(24_000);
  });

  it('aborts an optional FBX download before decoding when its selection expires', async () => {
    const parse = vi.spyOn(FBXLoader.prototype, 'parse');
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }));
    const controller = new AbortController();
    const loading = loadFbx('wraith.fbx', undefined, controller.signal);
    expect(requestSignal).toBe(controller.signal);
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('parses a downloaded FBX with the correct asset directory', async () => {
    const model = new THREE.Group();
    const parse = vi.spyOn(FBXLoader.prototype, 'parse').mockReturnValue(model);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
    const progress = vi.fn();
    expect(await loadFbx('fighting-idle.fbx', progress)).toBe(model);
    expect(parse).toHaveBeenCalledWith(expect.any(ArrayBuffer), '/assets/fighters/source/');
    expect(progress).toHaveBeenCalledWith(1);
  });

  it('keeps successful action clips when one startup animation download fails', async () => {
    const clip = new THREE.AnimationClip('motion', 1, [
      new THREE.NumberKeyframeTrack('.rotation[z]', [0, 1], [0, 0.1]),
    ]);
    vi.spyOn(FBXLoader.prototype, 'parse').mockImplementation(() => {
      const source = new THREE.Group();
      source.animations = [clip];
      return source;
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('run-backward.fbx')
      ? new Response(null, { status: 503 })
      : new Response(new Uint8Array([1]), { status: 200 })));

    const sources = await loadAnimationSources();

    expect(sources.has('idle')).toBe(true);
    expect(sources.has('walk')).toBe(true);
    expect(sources.has('punch-01')).toBe(true);
    expect(sources.has('walk-back')).toBe(false);
    expect(sources.size).toBe(STARTUP_ANIMATION_IDS.length - 1);
  });

  it('returns a partial animation bank before one stalled clip can outlast the real-model window', async () => {
    vi.useFakeTimers();
    const clip = new THREE.AnimationClip('motion', 1, [
      new THREE.NumberKeyframeTrack('.rotation[z]', [0, 1], [0, 0.1]),
    ]);
    vi.spyOn(FBXLoader.prototype, 'parse').mockImplementation(() => {
      const source = new THREE.Group();
      source.animations = [clip];
      return source;
    });
    let stalledSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (!url.includes('run-backward.fbx')) return Promise.resolve(new Response(new Uint8Array([1]), { status: 200 }));
      stalledSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        stalledSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }));

    const controller = new AbortController();
    const loading = loadAnimationSources(undefined, controller.signal);
    await vi.advanceTimersByTimeAsync(8_100);
    const abortedByBudget = stalledSignal?.aborted;
    controller.abort();
    const sources = await loading;

    expect(abortedByBudget).toBe(true);
    expect(sources.size).toBe(STARTUP_ANIMATION_IDS.length - 1);
    expect(sources.has('punch-01')).toBe(true);
  });

  it('rejects empty fighter models instead of treating them as ready', () => {
    expect(() => prepareFighterModel(new THREE.Group())).toThrow('finite renderable geometry');
  });

  it('uses the first non-empty embedded animation as idle', () => {
    const model = new THREE.Group();
    model.animations = [
      new THREE.AnimationClip('empty', 0, []),
      new THREE.AnimationClip('embedded-idle', 2, [new THREE.NumberKeyframeTrack('.position[x]', [0, 1], [0, 0])]),
    ];
    expect(clipsForFighter(model, new Map(), true).get('idle')?.duration).toBe(2);
  });

  it('uses the external idle when embedded-idle metadata has no usable embedded clip', () => {
    const model = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'mixamorigHips';
    model.add(hips);
    model.animations = [new THREE.AnimationClip('empty', 0, [])];
    const external = new THREE.AnimationClip('idle', 1.35, [
      new THREE.QuaternionKeyframeTrack('mixamorigHips.quaternion', [0, 1.35], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    expect(clipsForFighter(model, new Map([['idle', external]]), true).get('idle')?.duration).toBe(1.35);
  });

  it('uses visible local motion when an external clip targets a different rig', () => {
    const model = new THREE.Group();
    const incompatible = new THREE.AnimationClip('idle', 2, [
      new THREE.QuaternionKeyframeTrack('mixamorigHips.quaternion', [0, 2], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);

    const clips = clipsForFighter(model, new Map([['idle', incompatible]]));

    expect(clips.get('idle')?.duration).toBe(1.1);
    expect(clips.get('idle')?.tracks[0]?.name).toBe('.rotation[z]');
  });

  it('fills missing combat actions with playable local clips while preserving an embedded idle', () => {
    const model = new THREE.Group();
    const embeddedIdle = new THREE.AnimationClip('embedded-idle', 2, [
      new THREE.NumberKeyframeTrack('.rotation[z]', [0, 1, 2], [0, 0.01, 0]),
    ]);
    model.animations = [embeddedIdle];

    const clips = clipsForFighter(model, new Map(), true);

    expect(clips.get('idle')?.duration).toBe(2);
    for (const pool of Object.keys(ANIMATION_POOLS)) {
      const available = ANIMATION_POOLS[pool]!.map(id => clips.get(id)).filter(Boolean);
      expect(available.length, `${pool} has a playable clip`).toBeGreaterThan(0);
      expect(available[0]!.duration).toBeGreaterThan(0);
      expect(available[0]!.tracks.length).toBeGreaterThan(0);
    }
  });

  it('keeps an authored run and reuses its motion when the backward run is missing', () => {
    const model = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'mixamorigHips';
    model.add(hips);
    const rotated = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .25);
    const authoredWalk = new THREE.AnimationClip('walk', 1.4, [
      new THREE.QuaternionKeyframeTrack('mixamorig10Hips.quaternion', [0, 1.4], [0, 0, 0, 1, ...rotated.toArray()]),
    ]);

    const clips = clipsForFighter(model, new Map([['walk', authoredWalk]]));

    expect(clips.get('walk')?.duration).toBe(1.4);
    expect(clips.get('walk')?.tracks[0]?.name).toBe('mixamorigHips.quaternion');
    expect(clips.get('walk-back')?.duration).toBe(1.4);
    const backwardFirstPose = clips.get('walk-back')!.tracks[0]!.values.slice(0, 4);
    rotated.toArray().forEach((component, index) => expect(backwardFirstPose[index]).toBeCloseTo(component, 6));
    expect(clips.get('punch-01')?.tracks.length).toBeGreaterThan(0);
  });
});
