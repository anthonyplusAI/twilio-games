import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetLoader } from '../client/asset-loader';
import { AssetLoader as RacerAssetLoader } from '../client/asset-loader';
import { renderBoostThumbnailAsync, renderCarThumbnailsAsync } from '../client/thumbnails';
import * as THREE from 'three';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeAssets(carLoads: Promise<boolean>[], boostLoad: Promise<boolean> = Promise.resolve(false)): AssetLoader {
  return {
    carCount: () => carLoads.length,
    carReady: (i: number) => carLoads[i]!,
    carTemplate: () => null,
    boostReady: () => boostLoad,
    boostTemplate: () => null,
  } as unknown as AssetLoader;
}

describe('Racer progressive asset portraits', () => {
  beforeEach(() => {
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => callback());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders cars in completion order instead of manifest order', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const rendered: number[] = [];
    const complete = renderCarThumbnailsAsync(fakeAssets([first.promise, second.promise]), i => rendered.push(i));

    second.resolve(true);
    await vi.waitFor(() => expect(rendered).toEqual([1]));
    first.resolve(true);
    await complete;

    expect(rendered).toEqual([1, 0]);
  });

  it('continues after an individual car load rejects', async () => {
    const failed = deferred<boolean>();
    const ready = deferred<boolean>();
    const rendered: number[] = [];
    const complete = renderCarThumbnailsAsync(fakeAssets([failed.promise, ready.promise]), i => rendered.push(i));

    failed.reject(new Error('car failed'));
    ready.resolve(true);
    await complete;

    expect(rendered.sort()).toEqual([0, 1]);
  });

  it('pauses settled portraits during a race and resumes afterward', async () => {
    let canRender = false;
    const rendered: number[] = [];
    const complete = renderCarThumbnailsAsync(fakeAssets([Promise.resolve(true)]), i => rendered.push(i), 256, () => canRender);

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(rendered).toEqual([]);
    canRender = true;
    await complete;

    expect(rendered).toEqual([0]);
  });

  it('waits for the boost asset before attempting its portrait', async () => {
    const boost = deferred<boolean>();
    const complete = renderBoostThumbnailAsync(fakeAssets([], boost.promise));
    let settled = false;
    void complete.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    boost.resolve(false);

    await expect(complete).resolves.toBe('');
  });
});

describe('Racer slow-network asset loading', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('aborts stalled downloads and starts the next queued asset without exceeding four requests', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return new Promise<Response>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }));
    const loader = new RacerAssetLoader() as unknown as {
      loadRef(ref: { file: string }, target: number): Promise<THREE.Group | null>;
    };
    const loads = Array.from({ length: 5 }, (_, index) => loader.loadRef({ file: `car-${index}.glb` }, 5));
    await Promise.resolve();
    expect(signals).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(signals.slice(0, 4).every(signal => signal.aborted)).toBe(true);
    expect(signals).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(Promise.all(loads)).resolves.toEqual([null, null, null, null, null]);
  });

  it('holds a decode slot until a timed-out parse settles', async () => {
    vi.useFakeTimers();
    const parses: Array<ReturnType<typeof deferred<{ scene: THREE.Group; animations: [] }>>> = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    })));
    const loader = new RacerAssetLoader() as unknown as {
      loader: { parseAsync(bytes: ArrayBuffer, path: string): Promise<{ scene: THREE.Group; animations: [] }> };
      loadRef(ref: { file: string }, target: number): Promise<THREE.Group | null>;
    };
    loader.loader.parseAsync = () => {
      const parse = deferred<{ scene: THREE.Group; animations: [] }>();
      parses.push(parse);
      return parse.promise;
    };
    const loads = Array.from({ length: 5 }, (_, index) => loader.loadRef({ file: `car-${index}.glb` }, 5));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(parses).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(parses).toHaveLength(4);
    parses[0]!.resolve({ scene: new THREE.Group(), animations: [] });
    for (let turn = 0; turn < 12 && parses.length < 5; turn++) await Promise.resolve();
    expect(parses).toHaveLength(5);
    for (const parse of parses.slice(1)) parse.resolve({ scene: new THREE.Group(), animations: [] });
    await expect(Promise.all(loads)).resolves.toEqual([null, null, null, null, null]);
  });
});
