import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ArenaBackground, ArenaPreload, ARENA_PRELOAD_TIMEOUT_MS } from '../client/battle/arena-background';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// A tiny real glTF document exercises the fetch -> parse path without browser WebGL or Draco setup.
const EMPTY_GLTF = new TextEncoder().encode(JSON.stringify({
  asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [],
})).buffer;

function arenaResponse() { return new Response(EMPTY_GLTF, { status: 200 }); }

describe('Voice Monsters arena preload', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('prepares the authored config and model once, then transfers the same scene to battle', async () => {
    const config = { file: 'custom-arena.glb', pos: [1, 2, 3], spinSpeed: 0.31 };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/arena') return new Response(JSON.stringify(config), { status: 200 });
      if (url === '/assets/arena/custom-arena.glb') return arenaResponse();
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const preload = new ArenaPreload();

    const first = preload.start();
    expect(preload.start()).toBe(first);
    await first;
    const background = Object.create(ArenaBackground.prototype) as ArenaBackground;
    Object.assign(background, { disposed: false, model: null, loadGeneration: 0 });
    const install = vi.fn((_config: unknown, scene: THREE.Object3D) => {
      Object.assign(background, { model: scene });
    });
    Object.assign(background, { install });
    await background.loadPreloaded(preload);
    await background.loadPreloaded(preload); // rematch reuses the installed model

    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]?.[0]).toEqual(config);
    expect(install.mock.calls[0]?.[1]).toBeInstanceOf(THREE.Group);
    expect(preload.takeReady()).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/arena', '/assets/arena/custom-arena.glb',
    ]);
    preload.dispose();
  });

  it('uses the bundled file if the config request fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/arena') throw new Error('config offline');
      if (url === '/assets/arena/arena.glb') return arenaResponse();
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const preload = new ArenaPreload();

    await preload.start();

    expect(preload.takeReady()?.config.file).toBe('arena.glb');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    preload.dispose();
  });

  it('settles a stalled model request at the deadline without retrying it', async () => {
    vi.useFakeTimers();
    const stalled = deferred<Response>();
    let modelSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/api/arena') return Promise.resolve(new Response(JSON.stringify({ file: 'arena.glb' })));
      modelSignal = options?.signal as AbortSignal;
      return stalled.promise; // deliberately ignores abort
    });
    vi.stubGlobal('fetch', fetchMock);
    const preload = new ArenaPreload();
    const pending = preload.start();

    await vi.advanceTimersByTimeAsync(ARENA_PRELOAD_TIMEOUT_MS);
    await pending;

    expect(modelSignal?.aborted).toBe(true);
    expect(preload.takeReady()).toBeNull();
    await preload.start();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stalled.resolve(arenaResponse());
    preload.dispose();
  });

  it('retries a failed early model once in an active battle, reusing its config', async () => {
    const firstModel = deferred<Response>();
    const config = { file: 'custom-arena.glb', spinSpeed: 0.31 };
    let modelRequests = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/arena') return Promise.resolve(new Response(JSON.stringify(config)));
      modelRequests++;
      return modelRequests === 1 ? firstModel.promise : Promise.resolve(arenaResponse());
    });
    vi.stubGlobal('fetch', fetchMock);
    const preload = new ArenaPreload();
    const earlyLoad = preload.start();
    await vi.waitFor(() => expect(modelRequests).toBe(1));
    const background = Object.create(ArenaBackground.prototype) as ArenaBackground;
    Object.assign(background, { disposed: false, model: null, loadGeneration: 0 });
    const install = vi.fn((_config: unknown, scene: THREE.Object3D) => {
      Object.assign(background, { model: scene });
    });
    Object.assign(background, { install });
    const battleLoad = background.loadPreloaded(preload);

    expect(install).not.toHaveBeenCalled(); // battle can draw its procedural fallback now
    firstModel.reject(new Error('offline'));
    await Promise.all([earlyLoad, battleLoad]);
    await background.loadPreloaded(preload); // later state/rematch must not repeat the retry

    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]?.[0]).toEqual(config);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/arena', '/assets/arena/custom-arena.glb', '/assets/arena/custom-arena.glb',
    ]);
    preload.dispose();
  });

  it('caps failed battle retries at one across repeated battle entries', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/arena') return new Response(JSON.stringify({ file: 'arena.glb' }));
      throw new Error('model offline');
    });
    vi.stubGlobal('fetch', fetchMock);
    const preload = new ArenaPreload();
    await preload.start();
    const background = Object.create(ArenaBackground.prototype) as ArenaBackground;
    Object.assign(background, { disposed: false, model: null, loadGeneration: 0 });
    const install = vi.fn();
    Object.assign(background, { install });

    await background.loadPreloaded(preload);
    background.cancelPendingLoad();
    await background.loadPreloaded(preload);

    expect(install).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/arena', '/assets/arena/arena.glb', '/assets/arena/arena.glb',
    ]);
    preload.dispose();
  });

  it('disposes a decoded scene that arrives after the page leaves', async () => {
    const parsing = deferred<Awaited<ReturnType<GLTFLoader['parseAsync']>>>();
    vi.spyOn(GLTFLoader.prototype, 'parseAsync').mockReturnValue(parsing.promise);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/arena'
      ? new Response(JSON.stringify({ file: 'arena.glb' })) : arenaResponse()));
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    const disposeMaterial = vi.spyOn(material, 'dispose');
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(geometry, material));
    const preload = new ArenaPreload();
    const pending = preload.start();
    await vi.waitFor(() => expect(GLTFLoader.prototype.parseAsync).toHaveBeenCalledTimes(1));

    preload.dispose();
    await pending;
    parsing.resolve({ scene } as Awaited<ReturnType<GLTFLoader['parseAsync']>>);
    await vi.waitFor(() => expect(disposeGeometry).toHaveBeenCalledTimes(1));

    expect(disposeMaterial).toHaveBeenCalledTimes(1);
    expect(preload.takeReady()).toBeNull();
  });

  it('lets a new battle claim a pending scene while the ended battle stays stale', async () => {
    const ready = deferred<void>();
    const prepared = { config: { file: 'arena.glb' }, scene: new THREE.Group() };
    const takeReady = vi.fn(() => prepared);
    const preload = { start: () => ready.promise, takeReady } as unknown as ArenaPreload;
    // Only the async ownership handoff needs testing; WebGL construction belongs to the browser.
    const background = Object.create(ArenaBackground.prototype) as ArenaBackground;
    Object.assign(background, { disposed: false, model: null, loadGeneration: 0 });
    const install = vi.fn();
    Object.assign(background, { install });

    const firstBattle = background.loadPreloaded(preload);
    background.cancelPendingLoad();
    const nextBattle = background.loadPreloaded(preload);
    ready.resolve();
    await Promise.all([firstBattle, nextBattle]);

    expect(takeReady).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledExactlyOnceWith(prepared.config, prepared.scene);
  });

  it('does not hand a pending scene to a disposed background', async () => {
    const ready = deferred<void>();
    const takeReady = vi.fn();
    const preload = { start: () => ready.promise, takeReady } as unknown as ArenaPreload;
    const background = Object.create(ArenaBackground.prototype) as ArenaBackground;
    Object.assign(background, { disposed: false, model: null, loadGeneration: 0 });
    const install = vi.fn();
    Object.assign(background, { install });

    const pending = background.loadPreloaded(preload);
    Object.assign(background, { disposed: true });
    ready.resolve();
    await pending;

    expect(takeReady).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });
});
