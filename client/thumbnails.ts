// Render each car model to a small PNG data-URL for the car-select grid (SSB-style portraits).
// CLONES each already-normalized car template (auto-fit + grounded by the AssetLoader) with
// SkeletonUtils.clone (preserves rigged/skinned cars), frames it on a front-3/4 hero angle, snapshots
// the canvas. Falls back to '' on any failure so the grid just shows a styled placeholder tile.
//
// CRITICAL: a SEPARATE WebGLRenderer per car (disposed + context-lost after each shot). Reusing ONE
// renderer across multiple DIFFERENT GLBs leaks GPU state between them — a complex multi-mesh model
// (McLaren 91 meshes, Packard, Yuterra, Mustang, climber) inherits stale buffer/VAO bindings from the
// previously-rendered car and renders SCATTERED, even though its CPU scene graph + bounding box are
// whole. Proven by isolation: the McLaren renders whole ALONE but scatters when rendered right after
// the Batmobile in the same renderer. A fresh renderer has no prior state to inherit. The cost (a GL
// context per car) is fine: it's ~19 one-off renders at boot, off the critical path.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { disposeMapWorld, loadMapWorld } from './map-world';
import type { AssetLoader } from './asset-loader';
import type { MapConfig } from './map-world';

interface ThumbRig { renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; }

// Studio rig for the car-select PORTRAITS — the goal is to SHOW OFF each car. ONE rig per car (see
// file header on GPU-state contamination). Lit by cheap DIRECTIONAL lights (warm key + cool fill +
// faint rim + hemisphere) — NOT a PMREM environment map. PMREM looked marginally nicer but cost ~2×
// per car (it's one of three.js's most expensive ops), and 19 of them at boot stuttered the live
// attract-mode demo. Moderate intensities keep glossy paint (McLaren/Mustang) from blowing to white.
function makeThumbRig(size: number): ThumbRig {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xfff4e6, 2.1); key.position.set(5, 8, 6); scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.85); fill.position.set(-6, 4, 3); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.35); rim.position.set(0, 6, -8); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x2a3450, 0.95));
  const cam = new THREE.PerspectiveCamera(38, 1, 0.05, 2000);
  return { renderer, scene, cam };
}

/** Free the rig's GPU resources AND its WebGL context (forceContextLoss) so no GL state survives to
 *  the next car — the whole point of a per-car rig (see file header). */
function disposeRig(rig: ThumbRig): void {
  rig.renderer.dispose();
  rig.renderer.forceContextLoss();
}

/** Frame the rig's camera on a model + shoot it to a data-URL. Tight front-3/4 hero (car fills tile).
 *  Frames on the model's FULL bounding box (the same framing the garage uses). */
function frameAndShoot(rig: ThumbRig, model: THREE.Object3D): string {
  const { renderer, scene, cam } = rig;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return '';
  const center = new THREE.Vector3(); box.getCenter(center);
  const size = new THREE.Vector3(); box.getSize(size);
  const r = Math.max(size.x, size.y, size.z, 1);
  // Cars face +Z (after manifest rotations) → camera in FRONT (+z) + to the side, looking back.
  cam.position.set(center.x + r * 0.72, center.y + r * 0.42, center.z + r * 1.15);
  cam.lookAt(center.x, center.y, center.z);
  cam.updateProjectionMatrix();
  try { renderer.render(scene, cam); return renderer.domElement.toDataURL('image/png'); } catch { return ''; }
}

/** Shoot ONE car's portrait in its OWN fresh rig (''=fail). The per-car rig is the bug fix: it
 *  prevents cross-car GPU-state contamination that scattered complex models (see file header). */
function shootCar(tmpl: THREE.Object3D | null, size: number): string {
  if (!tmpl) return '';
  let rig: ThumbRig;
  try { rig = makeThumbRig(size); } catch { return ''; }
  try {
    const car = skeletonClone(tmpl);
    rig.scene.add(car);
    return frameAndShoot(rig, car);
  } finally {
    disposeRig(rig);
  }
}

/** Shoot the BOOST-PAD orb model to a small transparent PNG (''=fail) so the HUD + lobby legend can
 *  show players the ACTUAL thing they're grabbing on the track, instead of a generic bolt emoji.
 *  Its own fresh rig (same GPU-state rationale as cars). Framed tight + slightly elevated so the
 *  glowing orb reads clearly at chip size. Runs once at boot. */
export function renderBoostThumbnail(assets: AssetLoader, size = 96): string {
  const tmpl = assets.boostTemplate();
  if (!tmpl) return '';
  let rig: ThumbRig;
  try { rig = makeThumbRig(size); } catch { return ''; }
  try {
    const orb = skeletonClone(tmpl);
    rig.scene.add(orb);
    return frameAndShoot(rig, orb);
  } finally {
    disposeRig(rig);
  }
}

/** Wait until the main thread is IDLE before doing the next (expensive, synchronous) car render — so
 *  the live attract-mode animation's frames take priority and don't stutter. Uses requestIdleCallback
 *  where available (with a timeout so we never starve), falling back to a double-rAF on Safari. */
function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 250 });
    else requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function waitUntilRenderAllowed(canRender: () => boolean): Promise<void> {
  while (!canRender()) await new Promise(resolve => setTimeout(resolve, 250));
}

/** Wait for the boost model without coupling its portrait to car or track asset readiness. */
export async function renderBoostThumbnailAsync(
  assets: AssetLoader, size = 96, canRender: () => boolean = () => true,
): Promise<string> {
  if (!await assets.boostReady()) return '';
  await waitUntilRenderAllowed(canRender);
  await whenIdle();
  try { return renderBoostThumbnail(assets, size); } catch { return ''; }
}

/**
 * Render the car-select portraits from the AssetLoader's already-normalized templates, cloning each
 * with SkeletonUtils.clone. ONE fresh renderer per car (see file header). Paces work to main-thread
 * IDLE time (whenIdle) so the live attract demo behind the menu keeps animating smoothly instead of
 * stuttering as each (heavy, synchronous) portrait renders. Reports each via onOne(i, url) as it
 * lands so tiles fill in progressively.
 */
export async function renderCarThumbnailsAsync(
  assets: AssetLoader, onOne: (i: number, url: string) => void, size = 256,
  canRender: () => boolean = () => true,
): Promise<string[]> {
  const n = assets.carCount();
  if (n === 0) return [];
  const out: string[] = new Array(n).fill('');
  const pending = new Map<number, Promise<number>>();
  for (let i = 0; i < n; i++) {
    pending.set(i, Promise.resolve().then(() => assets.carReady(i)).then(() => i, () => i));
  }
  while (pending.size) {
    const i = await Promise.race(pending.values());
    pending.delete(i);
    await waitUntilRenderAllowed(canRender);
    await whenIdle();                            // let attract paint before this synchronous render
    await waitUntilRenderAllowed(canRender);
    let url = '';
    try { url = shootCar(assets.carTemplate(i), size); } catch { /* keep the fallback tile */ }
    out[i] = url;
    try { onOne(i, url); } catch { /* one tile must not stop the remaining portraits */ }
  }
  return out;
}

/** Synchronous all-at-once render — kept for tests / non-interactive callers. */
export function renderCarThumbnails(assets: AssetLoader, size = 256): string[] {
  const n = assets.carCount();
  if (n === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(shootCar(assets.carTemplate(i), size));
  return out;
}

/**
 * Render a MAP's 3D world to a preview PNG (''=fail) for the map-select tile — so the player sees
 * what the track actually looks like instead of a blank placeholder. Places the scenery EXACTLY as
 * the game/editor do (loadMapWorld: recenter + cfg.model transform) so a camera CAPTURED IN THE
 * EDITOR (cfg.previewCam, world space) frames the identical view. Without a saved shot, falls back to
 * an auto-computed elevated 3/4 establishing shot from the scene bbox. Heavy (scenery GLBs are big);
 * runs once per map at boot, paced to idle.
 */
export async function renderMapThumbnail(cfg: MapConfig, size = 480, signal?: AbortSignal): Promise<string> {
  let renderer: THREE.WebGLRenderer | null = null;
  let world: THREE.Group | null = null;
  try {
    // Place the map IDENTICALLY to the editor/game so cfg.previewCam (captured in the editor's world
    // space) lines up. loadMapWorld returns null on failure (we then bail to the placeholder).
    world = await loadMapWorld(cfg, signal);
    if (!world || signal?.aborted) return '';
    // Do not reserve a WebGL context while a cosmetic preview waits on a slow map download.
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    const w = size, h = Math.round(size * 0.62);       // landscape tile
    renderer.setSize(w, h);
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1020);
    const sun = new THREE.DirectionalLight(0xfff4e2, 2.6); sun.position.set(60, 120, -40); scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202840, 1.1));
    scene.add(world);
    world.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(world);
    if (!box.isEmpty()) {
      const c = new THREE.Vector3(); box.getCenter(c);
      const s = new THREE.Vector3(); box.getSize(s);
      const r = Math.max(s.x, s.z, 1);
      const aspect = w / h;
      const cam = new THREE.PerspectiveCamera(50, aspect, 0.1, r * 12 + 5000);
      const pv = cfg.previewCam;
      if (pv && pv.pos.length === 3 && pv.lookAt.length === 3) {
        // CUSTOM shot captured in the editor (world space).
        cam.fov = pv.fov ?? 50; cam.updateProjectionMatrix();
        cam.position.set(pv.pos[0]!, pv.pos[1]!, pv.pos[2]!);
        cam.lookAt(pv.lookAt[0]!, pv.lookAt[1]!, pv.lookAt[2]!);
      } else {
        // AUTO: elevated 3/4 establishing shot, looking down at the scene center.
        cam.position.set(c.x + r * 0.55, c.y + r * 0.55, c.z + r * 0.75);
        cam.lookAt(c.x, c.y, c.z);
      }
      cam.updateProjectionMatrix();
      if (signal?.aborted) return '';
      renderer.render(scene, cam);
      return renderer.domElement.toDataURL('image/png');
    }
  } catch { return ''; }
  finally {
    if (world) disposeMapWorld(world);
    renderer?.dispose(); renderer?.forceContextLoss();
  }
  return '';
}
