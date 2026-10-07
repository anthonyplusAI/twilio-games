import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { FIGHTER_ROSTER } from '../shared/fighter-roster';
import { ANIMATION_POOLS, FIGHTER_ANIMATIONS, STARTUP_ANIMATION_IDS, clipsForFighter, fighterAssetUrl, loadFbx, preferProceduralFighterAssets, prepareFighterModel } from '../client/fighter/fighter-assets';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

  it('keeps optional high-resolution fighters local on data-saving and slow links', () => {
    expect(preferProceduralFighterAssets({ saveData: true })).toBe(true);
    expect(preferProceduralFighterAssets({ effectiveType: '3g' })).toBe(true);
    expect(preferProceduralFighterAssets({ effectiveType: '4g' })).toBe(false);
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
    model.animations = [new THREE.AnimationClip('empty', 0, [])];
    const external = new THREE.AnimationClip('idle', 1, []);
    expect(clipsForFighter(model, new Map([['idle', external]]), true).has('idle')).toBe(true);
  });
});
