// The 3D battle arena that sits BEHIND the 2D Game Boy overlay. A slowly-spinning turntable of the
// arena model (three.js), rendered into its own WebGL canvas layered under the pixel-art battle
// canvas — the monsters + HP boxes draw over it, the command window is an opaque panel at the bottom.
// Transform/camera/spin come from an ArenaConfig (authored later in the multi-game editor); sensible
// defaults auto-frame the model so it looks right with zero config.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// One small config and one authored GLB are all the menu may prepare. A slow connection must not
// leave either request running indefinitely or make battle entry wait for the arena.
export const ARENA_PRELOAD_TIMEOUT_MS = 15_000;
const MAX_ARENA_GLB_BYTES = 8 * 1024 * 1024;
const DEFAULT_ARENA_CONFIG: ArenaConfig = { file: 'arena.glb', spinSpeed: 0.18 };

export interface ArenaConfig {
  file: string;                 // under /assets/arena/
  pos?: [number, number, number];
  rotDeg?: [number, number, number];
  scale?: number;
  spinSpeed?: number;           // turntable radians/sec (0 = static). Default a slow spin.
  cam?: { pos: [number, number, number]; lookAt: [number, number, number]; fov?: number };
}

/** interactive: true → the editor gets drag-rotate + scroll-zoom OrbitControls (and the auto-spin is
 *  paused) so you can PICK the camera angle, then read it back with cameraPose(). false (default) →
 *  the in-battle background: fixed auto-framed camera + turntable spin, non-interactive. */
export interface ArenaOpts { interactive?: boolean }

interface PreparedArena { config: ArenaConfig; scene: THREE.Group }

/** A single menu-time download/decode whose scene is handed to the first battle that needs it. */
export class ArenaPreload {
  private controller: AbortController | null = null;
  private loadPromise: Promise<void> | null = null;
  private retryPromise: Promise<void> | null = null;
  private firstFailed = false;
  private config: ArenaConfig | null = null;
  private prepared: PreparedArena | null = null;
  private disposed = false;

  start(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    if (this.disposed) return Promise.resolve();
    this.loadPromise = this.loadAttempt(true);
    return this.loadPromise;
  }

  /** One extra attempt only when battle needs an arena and the early attempt failed. */
  retryFailed(): Promise<void> {
    if (this.disposed || !this.firstFailed || this.prepared) return this.loadPromise ?? Promise.resolve();
    this.retryPromise ??= this.loadAttempt(false);
    return this.retryPromise;
  }

  private loadAttempt(first: boolean): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(), ARENA_PRELOAD_TIMEOUT_MS);
    return this.prepare(controller.signal).then(
      prepared => {
        if (this.disposed || controller.signal.aborted) {
          disposeScene(prepared.scene);
          if (first && !this.disposed) this.firstFailed = true;
        } else this.prepared = prepared;
      },
      () => {
        if (first && !this.disposed) this.firstFailed = true;
        // Config/model unavailable: the procedural arena remains visible.
      },
    ).finally(() => {
      clearTimeout(deadline);
      if (this.controller === controller) this.controller = null;
    });
  }

  /** Transfers ownership to the renderer; a second battle keeps its already installed scene. */
  takeReady(): PreparedArena | null {
    if (this.disposed) return null;
    const prepared = this.prepared;
    this.prepared = null;
    return prepared;
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    if (this.prepared) disposeScene(this.prepared.scene);
    this.prepared = null;
  }

  private async prepare(signal: AbortSignal): Promise<PreparedArena> {
    let config = this.config ?? DEFAULT_ARENA_CONFIG;
    if (!this.config) {
      try {
        const response = await untilAbort(fetch('/api/arena', { signal }), signal, cancelResponse);
        if (response.ok) {
          const value: unknown = await untilAbort(response.json(), signal);
          if (isArenaConfig(value)) config = this.config = value;
        } else cancelResponse(response);
      } catch { /* A missing config uses the bundled arena. */ }
    }
    if (signal.aborted) throw new DOMException('arena preload aborted', 'AbortError');

    const response = await untilAbort(fetch(arenaUrl(config.file), { signal }), signal, cancelResponse);
    if (!response.ok) {
      cancelResponse(response);
      throw new Error(`arena model request failed with HTTP ${response.status}`);
    }
    const bytes = await readBoundedGlb(response, signal);
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    loader.setDRACOLoader(draco);
    const parsing = loader.parseAsync(bytes, '/assets/arena/');
    void parsing.then(() => draco.dispose(), () => draco.dispose());
    const gltf = await untilAbort(parsing, signal, late => disposeScene(late.scene));
    return { config, scene: gltf.scene };
  }
}

export class ArenaBackground {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private turntable = new THREE.Group();   // the arena is parented here; we spin THIS
  private raf = 0;
  private last = performance.now();
  private spinSpeed = 0.18;                 // slow, cinematic default
  private disposed = false;
  private orbit: OrbitControls | null = null;   // editor-only camera control
  private interactive: boolean;
  private active = true;
  private loadGeneration = 0;
  private model: THREE.Object3D | null = null;
  private fallback = makeFallbackArena();

  constructor(private host: HTMLElement, opts: ArenaOpts = {}) {
    this.interactive = opts.interactive ?? false;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setClearColor(0x0b1a0c, 1);          // deep GB-green void behind the arena
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;z-index:1';
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(0, 3, 8);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.turntable);
    this.turntable.add(this.fallback);
    // Lighting: a warm key + cool fill + hemisphere so the arena reads without a PMREM env (cheap).
    const key = new THREE.DirectionalLight(0xfff2d8, 2.0); key.position.set(6, 10, 6); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.7); fill.position.set(-6, 4, -4); this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0xdff0ff, 0x24401c, 0.9));
    // EDITOR ONLY: drag to rotate, scroll to zoom, right-drag to pan — same basic camera controls the
    // racer editor has. In the live battle this stays null (fixed auto-framed camera + turntable spin).
    if (this.interactive) {
      this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
      this.orbit.enableDamping = true;
      this.orbit.minDistance = 0.5;
      this.orbit.zoomToCursor = true;
    }
    this.resize();
    window.addEventListener('resize', this.resize);
    this.loop();
  }

  /** Show the menu-prepared model when it is ready, without another config or GLB request. */
  async loadPreloaded(preload: ArenaPreload): Promise<void> {
    if (this.disposed || this.model) return;
    const generation = ++this.loadGeneration;
    await preload.start();
    if (this.disposed || this.model || generation !== this.loadGeneration) return;
    let prepared = preload.takeReady();
    if (!prepared) {
      await preload.retryFailed();
      if (this.disposed || this.model || generation !== this.loadGeneration) return;
      prepared = preload.takeReady();
    }
    if (prepared) this.install(prepared.config, prepared.scene);
  }

  /** Prevent an old battle's pending preload from installing after its stage has been hidden. */
  cancelPendingLoad(): void { this.loadGeneration++; }

  /** Stop drawing while the results/menu stage is hidden; resume the same scene on rematch. */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) {
      this.last = performance.now();
      this.resize();
      this.loop();
    } else {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  /** Editor path: load the current config, ignoring any older request that finishes afterward. */
  load(cfg: ArenaConfig): void {
    if (this.disposed) return;
    const generation = ++this.loadGeneration;
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    loader.setDRACOLoader(draco);
    loader.load(arenaUrl(cfg.file), (gltf) => {
      draco.dispose();
      if (this.disposed || generation !== this.loadGeneration) {
        disposeScene(gltf.scene);
        return;
      }
      this.install(cfg, gltf.scene);
    }, undefined, () => { draco.dispose(); /* Keep the current/procedural arena. */ });
  }

  private install(cfg: ArenaConfig, model: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) { disposeScene(model); return; }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    if (this.model) {
      this.turntable.remove(this.model);
      disposeScene(this.model);
    } else {
      this.turntable.remove(this.fallback);
      disposeScene(this.fallback);
    }
    this.model = model;
    this.spinSpeed = cfg.spinSpeed ?? 0.18;
    // Recenter the model on its own footprint so the turntable spins about its center, not a corner.
    model.position.sub(center);
    if (cfg.pos) model.position.add(new THREE.Vector3(...cfg.pos));
    if (cfg.rotDeg) model.rotation.set(...cfg.rotDeg.map(d => (d * Math.PI) / 180) as [number, number, number]);
    if (cfg.scale !== undefined) model.scale.setScalar(cfg.scale);
    this.turntable.add(model);
    // Auto-frame: pull the camera back to fit the model, angled down slightly (arena look).
    const lookAt = new THREE.Vector3(0, 0, 0);
    if (cfg.cam) {
      this.camera.fov = cfg.cam.fov ?? 45;
      this.camera.position.set(...cfg.cam.pos);
      lookAt.set(...cfg.cam.lookAt);
    } else {
      this.camera.fov = 45;
      const r = Math.max(size.x, size.y, size.z) * (cfg.scale ?? 1);
      const dist = r * 1.4 + 2;
      this.camera.position.set(0, r * 0.5, dist);
    }
    this.camera.lookAt(lookAt);
    if (this.orbit) { this.orbit.target.copy(lookAt); this.orbit.update(); }
    this.camera.updateProjectionMatrix();
  }

  private resize = (): void => {
    const w = this.host.clientWidth || 640, h = this.host.clientHeight || 640;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private loop = (): void => {
    if (this.disposed || !this.active) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1); this.last = now;
    // In the editor you're POSING the camera, so pause the auto-spin (you'd fight it); the battle
    // background spins. A tiny preview spin in the editor is still nice, so keep a gentle spin only
    // when the user isn't actively dragging.
    if (!this.interactive) this.turntable.rotation.y += this.spinSpeed * dt;
    this.orbit?.update();
    this.renderer.render(this.scene, this.camera);
  };

  /** Read back the current camera pose (for the editor's "Set camera" → saved into ArenaConfig.cam). */
  cameraPose(): { pos: [number, number, number]; lookAt: [number, number, number]; fov: number } {
    const t = this.orbit ? this.orbit.target : new THREE.Vector3(0, 0, 0);
    const p = this.camera.position;
    return { pos: [round(p.x), round(p.y), round(p.z)], lookAt: [round(t.x), round(t.y), round(t.z)], fov: this.camera.fov };
  }
  /** Live spin-speed setter so the editor's slider updates the preview immediately. */
  setSpin(speed: number): void { this.spinSpeed = speed; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadGeneration++;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.orbit?.dispose();
    disposeScene(this.model ?? this.fallback);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;

function isArenaConfig(value: unknown): value is ArenaConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cfg = value as Record<string, unknown>;
  const file = cfg.file;
  if (typeof file !== 'string' || !file.endsWith('.glb')
    || !file.split('/').every(part => part !== '' && part !== '.' && part !== '..')) return false;
  if (cfg.pos !== undefined && !isVec3(cfg.pos)) return false;
  if (cfg.rotDeg !== undefined && !isVec3(cfg.rotDeg)) return false;
  if (cfg.scale !== undefined && (!isFiniteNumber(cfg.scale) || cfg.scale <= 0)) return false;
  if (cfg.spinSpeed !== undefined && !isFiniteNumber(cfg.spinSpeed)) return false;
  if (cfg.cam !== undefined) {
    if (!cfg.cam || typeof cfg.cam !== 'object' || Array.isArray(cfg.cam)) return false;
    const cam = cfg.cam as Record<string, unknown>;
    if (!isVec3(cam.pos) || !isVec3(cam.lookAt)) return false;
    if (cam.fov !== undefined && (!isFiniteNumber(cam.fov) || cam.fov <= 0 || cam.fov >= 180)) return false;
  }
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

function arenaUrl(file: string): string {
  return `/assets/arena/${file.split('/').map(encodeURIComponent).join('/')}`;
}

/** Abort settles even when a browser/network promise ignores its signal. */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(new DOMException('arena preload aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void work.then(value => {
      if (settled) { disposeLate?.(value); return; }
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

async function readBoundedGlb(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_ARENA_GLB_BYTES) {
    cancelResponse(response);
    throw new Error('arena model too large');
  }
  if (!response.body) {
    const bytes = await untilAbort(response.arrayBuffer(), signal);
    if (bytes.byteLength > MAX_ARENA_GLB_BYTES) throw new Error('arena model too large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await untilAbort(reader.read(), signal);
      if (done) { complete = true; break; }
      total += value.byteLength;
      if (total > MAX_ARENA_GLB_BYTES) throw new Error('arena model too large');
      chunks.push(value);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

function cancelResponse(response: Response): void {
  if (response.body) void response.body.cancel().catch(() => {});
}

function makeFallbackArena(): THREE.Group {
  const arena = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.5, 0.22, 48),
    new THREE.MeshStandardMaterial({ color: 0x314b2e, roughness: 0.9 }));
  base.position.y = -0.55;
  arena.add(base);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.75, 0.06, 8, 48),
    new THREE.MeshStandardMaterial({ color: 0x99b879, roughness: 0.75 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.42;
  arena.add(ring);
  return arena;
}

function disposeScene(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (!mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
}
