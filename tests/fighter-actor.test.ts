import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { FighterActor } from '../client/fighter/fighter-actor';

interface ActorState { currentId: string }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('FighterActor playback', () => {
  it('starts fetching the selected real fighter while animation clips are still loading', async () => {
    let finishClips!: (clips: ReadonlyMap<string, THREE.AnimationClip>) => void;
    const clips = new Promise<ReadonlyMap<string, THREE.AnimationClip>>(resolve => { finishClips = resolve; });
    const model = new THREE.Group();
    model.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial()));
    vi.spyOn(FBXLoader.prototype, 'parse').mockReturnValue(model);
    const fetchAsset = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchAsset);

    const loading = FighterActor.load({ id: 'nyx', label: 'Nyx', file: 'nyx.fbx' }, clips);
    await vi.waitFor(() => expect(fetchAsset).toHaveBeenCalledTimes(1));
    finishClips(new Map([['idle', new THREE.AnimationClip('idle', 1, [])]]));
    const actor = await loading;
    expect(new THREE.Box3().setFromObject(actor.root).isEmpty()).toBe(false);
    actor.dispose();
  });

  it('creates a visible procedural actor when an FBX model is unavailable', () => {
    const actor = FighterActor.fallback('#ef223a');
    expect(new THREE.Box3().setFromObject(actor.root).isEmpty()).toBe(false);
    expect(actor.model.children.length).toBeGreaterThan(5);
    expect(actor.playRandom('punch')).toBeGreaterThan(0);
    expect(actor.playRandom('kick')).toBeGreaterThan(0);
    actor.update(0.1);
    actor.play('punch-01', { fade: 0 });
    actor.update(0.2);
    expect(actor.model.getObjectByName('rightArm')?.rotation.x).toBeLessThan(-0.5);
    actor.dispose();
  });

  it('holds a knockout fall on the floor without starting get-up', () => {
    const model = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1));
    body.position.y = 1;
    model.add(body);
    const fall = new THREE.AnimationClip('fall-01', 0.5, [
      new THREE.NumberKeyframeTrack('.rotation[x]', [0, 0.5], [0, Math.PI / 2]),
    ]);
    const clips = new Map([
      ['idle', new THREE.AnimationClip('idle', 1, [])],
      ['fall-01', fall],
    ]);
    const Actor = FighterActor as unknown as new (fighter: THREE.Group, animations: Map<string, THREE.AnimationClip>) => FighterActor;
    const actor = new Actor(model, clips);
    const state = actor as unknown as ActorState;
    actor.root.position.y = 3;

    actor.playRandom('fall', { hold: true, lockFloor: true });
    actor.update(0.6);

    expect(state.currentId).toBe('fall-01');
    expect(new THREE.Box3().setFromObject(model, true).min.y).toBeCloseTo(3, 5);
    actor.dispose();
  });

  it('returns to idle after a victory animation instead of freezing on its final pose', () => {
    const model = new THREE.Group();
    const clip = (name: string, duration: number) => new THREE.AnimationClip(name, duration, []);
    const clips = new Map([
      ['idle', clip('idle', 1)],
      ['celebration-01', clip('celebration-01', 0.5)],
    ]);
    const Actor = FighterActor as unknown as new (fighter: THREE.Group, animations: Map<string, THREE.AnimationClip>) => FighterActor;
    const actor = new Actor(model, clips);
    const state = actor as unknown as ActorState;

    actor.playRandom('celebration');
    expect(state.currentId).toBe('celebration-01');

    actor.update(0.6);
    expect(state.currentId).toBe('idle');

    actor.dispose();
  });
});
