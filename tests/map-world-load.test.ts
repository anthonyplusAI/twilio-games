import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeMapWorld, fetchMaps, IDENTITY_TRANSFORM, loadMapWorld, type MapConfig } from '../client/map-world';
import { renderMapThumbnail } from '../client/thumbnails';

const map: MapConfig = { map: 'Test', file: 'test.glb', track: IDENTITY_TRANSFORM };

function renderableScene(): { root: THREE.Group; geometry: THREE.BoxGeometry; material: THREE.MeshBasicMaterial; texture: THREE.Texture } {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(2, 1, 4);
  const texture = new THREE.Texture();
  const material = new THREE.MeshBasicMaterial({ map: texture });
  root.add(new THREE.Mesh(geometry, material));
  return { root, geometry, material, texture };
}

function stubMapBytes(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('cancellable Voice Racer maps', () => {
  it('passes cancellation through the map catalog request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchMaps(controller.signal)).toEqual({});
    expect(fetchMock).toHaveBeenCalledWith('/api/maps', { signal: controller.signal });
  });

  it('aborts an in-flight GLB download before decoding it', async () => {
    const controller = new AbortController();
    let requestedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestedSignal = options.signal as AbortSignal;
      requestedSignal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const parse = vi.spyOn(GLTFLoader.prototype, 'parseAsync');
    const decoderDispose = vi.spyOn(DRACOLoader.prototype, 'dispose');
    const pending = loadMapWorld(map, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith('/assets/maps/test.glb', { signal: controller.signal });
    controller.abort();
    expect(await pending).toBeNull();
    expect(requestedSignal?.aborted).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    expect(decoderDispose).toHaveBeenCalledOnce();
  });

  it('cancels a cosmetic preview download before allocating a WebGL context', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      (options.signal as AbortSignal).addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const preview = renderMapThumbnail(map, 480, controller.signal);
    expect(fetchMock).toHaveBeenCalledOnce();
    controller.abort();
    expect(await preview).toBe('');
  });

  it('disposes a map that finishes decoding after the race was cancelled', async () => {
    stubMapBytes();
    const controller = new AbortController();
    const scene = renderableScene();
    const geometryDispose = vi.spyOn(scene.geometry, 'dispose');
    const materialDispose = vi.spyOn(scene.material, 'dispose');
    const textureDispose = vi.spyOn(scene.texture, 'dispose');
    const decoderDispose = vi.spyOn(DRACOLoader.prototype, 'dispose');
    let resolveParse!: (result: Awaited<ReturnType<GLTFLoader['parseAsync']>>) => void;
    vi.spyOn(GLTFLoader.prototype, 'parseAsync').mockImplementation(() => new Promise(resolve => { resolveParse = resolve; }));
    const pending = loadMapWorld(map, controller.signal);
    await vi.waitFor(() => expect(resolveParse).toBeTypeOf('function'));
    controller.abort();
    resolveParse({ scene: scene.root } as Awaited<ReturnType<GLTFLoader['parseAsync']>>);
    expect(await pending).toBeNull();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(decoderDispose).toHaveBeenCalledOnce();
  });

  it('transfers a successful map to the renderer without disposing its geometry', async () => {
    const fetchMock = stubMapBytes();
    const scene = renderableScene();
    const geometryDispose = vi.spyOn(scene.geometry, 'dispose');
    const parse = vi.spyOn(GLTFLoader.prototype, 'parseAsync').mockResolvedValue({ scene: scene.root } as Awaited<ReturnType<GLTFLoader['parseAsync']>>);
    const decoderDispose = vi.spyOn(DRACOLoader.prototype, 'dispose');
    const controller = new AbortController();
    const loaded = await loadMapWorld(map, controller.signal);
    expect(loaded?.children).toContain(scene.root);
    expect(fetchMock).toHaveBeenCalledWith('/assets/maps/test.glb', { signal: controller.signal });
    expect(parse).toHaveBeenCalledWith(expect.any(ArrayBuffer), '/assets/maps/');
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(decoderDispose).toHaveBeenCalledOnce();
    disposeMapWorld(loaded!);
    expect(geometryDispose).toHaveBeenCalledOnce();
  });
});
