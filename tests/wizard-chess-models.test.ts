import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WizardPieceLibrary } from '../client/chess/wizard-pieces';
import { readGlb } from '../tools/glb-read';

const modelNames = ['ron', 'harry', 'hermione', 'knight', 'queen', 'king', 'pawn'] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function suppliedModel(): THREE.Group {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.5, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x315b9c }));
  mesh.name = 'supplied-harry';
  mesh.position.y = 0.75;
  root.add(mesh);
  return root;
}

function stubModelParsing(library: WizardPieceLibrary): void {
  const loader = (library as unknown as { loader: { parseAsync: (bytes: ArrayBuffer,
    path: string) => Promise<unknown> } }).loader;
  vi.spyOn(loader, 'parseAsync').mockImplementation(async () => ({ scene: suppliedModel() }));
}

describe('Wizard Chess supplied models', () => {
  it.each(modelNames)('ships renderable %s geometry', async name => {
    const glb = await readGlb(`assets/chess/wizard/${name}.glb`);
    expect(glb.primitiveCount).toBeGreaterThan(0);
    expect(glb.size.every(size => Number.isFinite(size) && size > 0.001)).toBe(true);
  });

  it('shows a loaded character with its original material and silhouette', () => {
    const library = new WizardPieceLibrary(() => {}, false);
    const nativeMaterial = new THREE.MeshStandardMaterial({ color: 0x6aacc9 });
    const nativeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, 0.3), nativeMaterial);
    nativeMesh.name = 'Object_9'; // Harry's supplied outer garment was previously recolored.
    const template = new THREE.Group();
    template.userData.wizardAsset = 'harry';
    template.add(nativeMesh);
    (library as unknown as { templates: Map<string, THREE.Group> }).templates.set('harry', template);

    const piece = library.createPiece('a3', 'b', 'b');
    const original = piece.getObjectByName('Object_9') as THREE.Mesh;
    expect(original.material).toBe(nativeMaterial);
    const costumeCoveringModel = piece.children.slice(1).some(child =>
      new THREE.Box3().setFromObject(child).max.y > 0.25);
    expect(costumeCoveringModel).toBe(false);
    library.dispose();
  });

  it('loads the complete seven-model set on activation, including on low-detail devices', async () => {
    const library = new WizardPieceLibrary(() => {}, true);
    const requested: string[] = [];
    vi.spyOn(library as unknown as { load: (key: string, retry: boolean) => Promise<void> }, 'load')
      .mockImplementation(async (key, retry) => { if (retry) requested.push(key); });

    library.prefetch(true);
    await vi.waitFor(() => expect(requested).toHaveLength(modelNames.length));
    expect(new Set(requested)).toEqual(new Set(modelNames));
    library.dispose();
  });

  it('replaces a character fallback when a production model body arrives after eleven seconds', async () => {
    vi.useFakeTimers();
    let visible: THREE.Group;
    const library = new WizardPieceLibrary(() => {
      visible = library.createPiece('a3', 'b', 'b');
    }, false);
    stubModelParsing(library);
    visible = library.createPiece('a3', 'b', 'b');
    expect(visible.userData.wizardFallbackName).toBe('Harry');
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => Promise.resolve({
      ok: true, status: 200,
      arrayBuffer: () => new Promise<ArrayBuffer>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new ArrayBuffer(32)), 12_500);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('model body aborted', 'AbortError'));
        }, { once: true });
      }),
    } as Response));

    const loading = (library as unknown as { load: (key: string, retry: boolean) => Promise<void> })
      .load('harry', true);
    await vi.advanceTimersByTimeAsync(12_600);
    await loading;
    expect(visible.getObjectByName('supplied-harry')).toBeInstanceOf(THREE.Mesh);
    expect(visible.userData.wizardFallbackName).toBeUndefined();
    library.dispose();
  });

  it('starts all three character downloads immediately when the scene activates', async () => {
    const library = new WizardPieceLibrary(() => {}, false);
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      requested.push(String(url).split('/').at(-1)!);
      return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort',
        () => reject(new DOMException('disposed', 'AbortError')), { once: true }));
    });
    library.prefetch(true);
    await vi.waitFor(() => expect(requested.slice(0, 3))
      .toEqual(['ron.glb', 'harry.glb', 'hermione.glb']), { timeout: 600 });
    library.dispose();
  });

  it('retries a transient activation failure and eventually renders the supplied character', async () => {
    const library = new WizardPieceLibrary(() => {}, false);
    stubModelParsing(library);
    let harryAttempts = 0;
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (String(url).endsWith('/harry.glb') && ++harryAttempts === 1) {
        return Promise.reject(new TypeError('transient network loss'));
      }
      return Promise.resolve({ ok: true, status: 200,
        arrayBuffer: async () => new ArrayBuffer(32) } as Response);
    });
    library.prefetch(true);

    await vi.waitFor(() => {
      const piece = library.createPiece('a3', 'b', 'b');
      expect(piece.getObjectByName('supplied-harry')).toBeInstanceOf(THREE.Mesh);
    }, { timeout: 5_000, interval: 100 });
    expect(harryAttempts).toBe(2);
    library.dispose();
  });

  it('retries a failed character before a stalled army model can hold the scene in fallback', async () => {
    const library = new WizardPieceLibrary(() => {}, false);
    stubModelParsing(library);
    const requested: string[] = [];
    let harryAttempts = 0;
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const name = String(url).split('/').at(-1)!;
      requested.push(name);
      if (name === 'harry.glb' && ++harryAttempts === 1) {
        return Promise.reject(new TypeError('transient network loss'));
      }
      if (['ron.glb', 'harry.glb', 'hermione.glb'].includes(name)) {
        return Promise.resolve({ ok: true, status: 200,
          arrayBuffer: async () => new ArrayBuffer(32) } as Response);
      }
      return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort',
        () => reject(new DOMException('disposed', 'AbortError')), { once: true }));
    });
    library.prefetch(true);
    try {
      await vi.waitFor(() => expect(library.createPiece('a3', 'b', 'b')
        .getObjectByName('supplied-harry')).toBeInstanceOf(THREE.Mesh),
      { timeout: 3_000, interval: 100 });
      const secondHarry = requested.lastIndexOf('harry.glb');
      const firstArmy = requested.findIndex(name => !['ron.glb', 'harry.glb', 'hermione.glb'].includes(name));
      expect(secondHarry).toBeGreaterThan(0);
      expect(firstArmy).toBeGreaterThan(0);
    } finally {
      library.dispose();
    }
  }, 4_000);
});
