import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetLoader } from '../client/asset-loader';
import { AssetLoader as RacerAssetLoader } from '../client/asset-loader';
import { renderBoostThumbnailAsync, renderCarThumbnailsAsync } from '../client/thumbnails';
import * as THREE from 'three';
import { BARRIER_TARGET, CAR_TARGET } from '../shared/asset-fit';

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
    for (let turn = 0; turn < 12 && parses.length < 4; turn++) await Promise.resolve();
    expect(parses).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(parses).toHaveLength(4);
    parses[0]!.resolve({ scene: new THREE.Group(), animations: [] });
    for (let turn = 0; turn < 12 && parses.length < 5; turn++) await Promise.resolve();
    expect(parses).toHaveLength(5);
    for (const parse of parses.slice(1)) parse.resolve({ scene: new THREE.Group(), animations: [] });
    await expect(Promise.all(loads)).resolves.toEqual([null, null, null, null, null]);
  });

  it('starts a newly chosen car while four optional models are still decoding', async () => {
    const optionalParses: Array<ReturnType<typeof deferred<{ scene: THREE.Group; animations: [] }>>> = [];
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const file = url.replace('/assets/', '');
      requests.push(file);
      return file === 'chosen.glb'
        ? { ok: false }
        : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    }));
    const loader = new RacerAssetLoader() as unknown as {
      manifest: { cars: Array<{ file: string }>; barrier: null; boostPad: null; props: [] };
      loader: { parseAsync(): Promise<{ scene: THREE.Group; animations: [] }> };
      loadRef(ref: { file: string }, target: number, isCar?: boolean): Promise<THREE.Group | null>;
      prioritizeCarIndexes(indexes: number[]): void;
    };
    loader.manifest = { cars: Array.from({ length: 5 }, (_, i) => ({ file: `optional-${i}.glb` })),
      barrier: null, boostPad: null, props: [] };
    loader.manifest.cars[4] = { file: 'chosen.glb' };
    loader.loader.parseAsync = () => {
      const parse = deferred<{ scene: THREE.Group; animations: [] }>();
      optionalParses.push(parse);
      return parse.promise;
    };
    const optional = loader.manifest.cars.slice(0, 4)
      .map(ref => loader.loadRef(ref, CAR_TARGET, true));
    await vi.waitFor(() => expect(optionalParses).toHaveLength(4));

    const chosen = loader.loadRef(loader.manifest.cars[4]!, CAR_TARGET, true);
    loader.prioritizeCarIndexes([4]);
    await vi.waitFor(() => expect(requests).toContain('chosen.glb'));
    expect(optionalParses).toHaveLength(4); // None had to finish or be discarded.

    for (const parse of optionalParses) parse.resolve({ scene: new THREE.Group(), animations: [] });
    await expect(Promise.all([...optional, chosen])).resolves.toEqual([null, null, null, null, null]);
  });

  it('lets a selected car start while cosmetic car downloads are paused for map loading', async () => {
    const fetchAsset = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal('fetch', fetchAsset);
    const loader = new RacerAssetLoader() as unknown as {
      manifest: { cars: Array<{ file: string }>; barrier: null; boostPad: null; props: [] };
      loadRef(ref: { file: string }, target: number): Promise<THREE.Group | null>;
      setOptionalDownloadsPaused(paused: boolean): void;
      prioritizeCarIndexes(indexes: number[]): void;
    };
    loader.manifest = { cars: [{ file: 'selected.glb' }], barrier: null, boostPad: null, props: [] };
    loader.setOptionalDownloadsPaused(true);
    const optional = loader.loadRef({ file: 'portrait-only.glb' }, 5);
    await Promise.resolve();
    expect(fetchAsset).not.toHaveBeenCalled();

    loader.prioritizeCarIndexes([0]);
    await loader.loadRef({ file: 'selected.glb' }, 5);
    expect(fetchAsset).toHaveBeenCalledTimes(1);

    loader.setOptionalDownloadsPaused(false);
    await optional;
    expect(fetchAsset).toHaveBeenCalledTimes(2);
  });

  it('starts a newly selected car before four optional catalog downloads settle', async () => {
    const requests: Array<{ file: string; signal: AbortSignal; resolve: (response: Response) => void }> = [];
    const attempts = new Map<string, number>();
    vi.stubGlobal('fetch', vi.fn((url: string, options: { signal: AbortSignal }) => {
      const file = url.replace('/assets/', '');
      attempts.set(file, (attempts.get(file) ?? 0) + 1);
      if ((attempts.get(file) ?? 0) > 1) return Promise.resolve({ ok: false } as Response);
      return new Promise<Response>((resolve, reject) => {
        requests.push({ file, signal: options.signal, resolve });
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }));
    const loader = new RacerAssetLoader() as unknown as {
      manifest: { cars: Array<{ file: string }>; barrier: null; boostPad: null; props: [] };
      loadRef(ref: { file: string }, target: number, isCar?: boolean): Promise<THREE.Group | null>;
      prioritizeCarIndexes(indexes: number[]): void;
    };
    loader.manifest = { cars: Array.from({ length: 5 }, (_, i) => ({ file: `car-${i}.glb` })),
      barrier: null, boostPad: null, props: [] };
    const optional = Array.from({ length: 4 }, (_, i) => loader.loadRef(loader.manifest.cars[i]!, CAR_TARGET, true));
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    const chosen = loader.loadRef(loader.manifest.cars[4]!, CAR_TARGET, true);
    loader.prioritizeCarIndexes([4]);

    await vi.waitFor(() => expect(requests.some(request => request.file === 'car-4.glb')).toBe(true));
    expect(requests.filter(request => request.file !== 'car-4.glb' && request.signal.aborted)).toHaveLength(1);
    for (const request of requests) if (!request.signal.aborted) request.resolve({ ok: false } as Response);
    await expect(Promise.all([...optional, chosen])).resolves.toEqual([null, null, null, null, null]);
  });

  it('preempts active optional car downloads, including an unresponsive fetch, then resumes', async () => {
    const requests: Array<{
      file: string;
      signal: AbortSignal;
      resolve: (response: Response) => void;
    }> = [];
    vi.stubGlobal('fetch', vi.fn((url: string, options: { signal: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        const file = url.replace('/assets/', '');
        requests.push({ file, signal: options.signal, resolve });
        // One optional request ignores cancellation. The loader must still free its logical slot.
        if (file !== 'optional-b.glb') {
          options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }
      })));
    const loader = new RacerAssetLoader() as unknown as {
      manifest: { cars: Array<{ file: string }>; barrier: { file: string }; boostPad: null; props: [] };
      loadRef(ref: { file: string }, target: number, isCar?: boolean): Promise<THREE.Group | null>;
      setOptionalDownloadsPaused(paused: boolean): void;
      prioritizeCarIndexes(indexes: number[]): void;
    };
    loader.manifest = {
      cars: [
        { file: 'selected.glb' }, { file: 'urgent.glb' },
        { file: 'optional-a.glb' }, { file: 'optional-b.glb' },
      ],
      barrier: { file: 'barrier.glb' }, boostPad: null, props: [],
    };
    loader.prioritizeCarIndexes([0, 1]);
    const optionalA = loader.loadRef({ file: 'optional-a.glb' }, CAR_TARGET, true);
    const optionalB = loader.loadRef({ file: 'optional-b.glb' }, CAR_TARGET, true);
    const selected = loader.loadRef({ file: 'selected.glb' }, CAR_TARGET, true);
    const barrier = loader.loadRef({ file: 'barrier.glb' }, BARRIER_TARGET);
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    let optionalSettled = false;
    void Promise.all([optionalA, optionalB]).then(() => { optionalSettled = true; });

    loader.setOptionalDownloadsPaused(true);
    expect(requests.filter(request => request.file.startsWith('optional-')).every(request => request.signal.aborted)).toBe(true);
    expect(requests.find(request => request.file === 'selected.glb')?.signal.aborted).toBe(false);
    expect(requests.find(request => request.file === 'barrier.glb')?.signal.aborted).toBe(false);

    const urgent = loader.loadRef({ file: 'urgent.glb' }, CAR_TARGET, true);
    await vi.waitFor(() => expect(requests.some(request => request.file === 'urgent.glb')).toBe(true));
    expect(optionalSettled).toBe(false);
    expect(requests.filter(request => request.file.startsWith('optional-'))).toHaveLength(2);
    const staleBody = vi.fn(async () => new ArrayBuffer(4));
    requests.find(request => request.file === 'optional-b.glb')!.resolve({ ok: true, arrayBuffer: staleBody } as unknown as Response);
    await Promise.resolve();
    expect(staleBody).not.toHaveBeenCalled();

    for (const request of requests.filter(request => !request.file.startsWith('optional-'))) {
      request.resolve({ ok: false } as Response);
    }
    await expect(Promise.all([selected, barrier, urgent])).resolves.toEqual([null, null, null]);
    loader.setOptionalDownloadsPaused(false);
    await vi.waitFor(() => expect(requests.filter(request => request.file.startsWith('optional-'))).toHaveLength(4));
    for (const request of requests.filter(request => request.file.startsWith('optional-') && !request.signal.aborted)) {
      request.resolve({ ok: false } as Response);
    }
    await expect(Promise.all([optionalA, optionalB])).resolves.toEqual([null, null]);
  });

  it('retries a chosen car once when its first early model load fails', async () => {
    const loader = new RacerAssetLoader() as unknown as {
      manifest: { cars: Array<{ file: string }>; barrier: null; boostPad: null; props: [] };
      cars: Array<THREE.Group | null>;
      carLoadStates: string[];
      carLoadGenerations: number[];
      carLoads: Promise<void>[];
      loadRef(ref: { file: string }, target: number): Promise<THREE.Group | null>;
      startCarLoad(index: number): Promise<void>;
      prioritizeCarIndexes(indexes: number[]): void;
      carTemplate(index: number): THREE.Group | null;
    };
    loader.manifest = { cars: [{ file: 'chosen.glb' }], barrier: null, boostPad: null, props: [] };
    loader.cars = [null]; loader.carLoads = []; loader.carLoadStates = ['idle']; loader.carLoadGenerations = [0];
    const realCar = new THREE.Group();
    loader.loadRef = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(realCar);
    loader.prioritizeCarIndexes([0]);

    await loader.startCarLoad(0);

    expect(loader.loadRef).toHaveBeenCalledTimes(2);
    expect(loader.carTemplate(0)).toBe(realCar);
  });

  it('retries a model that failed before car selection, without looping on menu broadcasts', async () => {
    const loader = new RacerAssetLoader() as unknown as {
      manifest: { cars: Array<{ file: string }>; barrier: null; boostPad: null; props: [] };
      cars: Array<THREE.Group | null>;
      carLoadStates: string[];
      carLoadGenerations: number[];
      carLoads: Promise<void>[];
      loadRef(ref: { file: string }, target: number): Promise<THREE.Group | null>;
      startCarLoad(index: number): Promise<void>;
      prioritizeCarIndexes(indexes: number[]): void;
      carReady(index: number): Promise<boolean>;
    };
    loader.manifest = { cars: [{ file: 'chosen.glb' }], barrier: null, boostPad: null, props: [] };
    loader.cars = [null]; loader.carLoads = []; loader.carLoadStates = ['idle']; loader.carLoadGenerations = [0];
    loader.loadRef = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(new THREE.Group());
    await loader.startCarLoad(0);

    loader.prioritizeCarIndexes([0]);
    expect(await loader.carReady(0)).toBe(true);
    loader.prioritizeCarIndexes([0]);
    expect(loader.loadRef).toHaveBeenCalledTimes(2);
  });
});
