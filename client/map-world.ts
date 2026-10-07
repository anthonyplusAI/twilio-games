// Loads a track-model "map" and places it directly into the GAME scene. The map config now
// stores the track's transform in GAME space (the same space the race runs in: cars drive +Z
// from the origin). No strip / no relative-matrix conversion — you align the track around the
// real race in the in-game align mode (?align=1), so what you align is exactly what you play.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RACE_LEN } from '../shared/constants';
import { authHeaders } from './editor/editor-auth';

export interface MapTransform { pos: number[]; rotDeg: number[]; scale: number; }
/**
 * A map = a GLB scenery model + TWO independent transforms you align against each other:
 *  - `model`: where the GLB sits in game space.
 *  - `track`: where the generated race (lanes, cars, items, markings) sits.
 * You can move EITHER in the align tool; the game applies both. `model` is optional for
 * back-compat with older configs that only stored `track`.
 */
/** The saved camera shot for the map-select preview thumbnail (world space). Captured in the editor
 *  ("Set preview shot"); renderMapThumbnail renders from it instead of the auto establishing shot. */
export interface PreviewCam { pos: number[]; lookAt: number[]; fov?: number }
export interface MapConfig { map: string; file: string; track: MapTransform; model?: MapTransform; path?: TrackPath; previewCam?: PreviewCam; }

/**
 * A render-only curved path for the track. Control points are XZ positions (y is ground level).
 * The SIM stays straight: a car's sim-z (0..RACE_LEN) is treated as ARC-LENGTH along this curve,
 * and its sim-x (lane offset) becomes a sideways offset perpendicular to the curve tangent. So the
 * road/scenery and cars *look* like they follow the curve while the server still simulates a
 * straight lane-runner — no sim/lap/collision changes. `points` in sim-z order (start → finish).
 */
export interface TrackPath {
  // Control points: [x, z] (ground level, legacy) or [x, y, z] (per-point HEIGHT, so the track can
  // follow the map's hills). The curve interpolates Y between points. In sim-z order (start→finish).
  points: number[][];
  // Visual width controls (render-only; the sim's lane logic is unchanged):
  //  - laneScale: multiplier on the 3-lane spacing (1 = default TRACK_W). Cars' sideways offset is
  //    scaled by this too, so they stay centered in the widened lanes.
  //  - shoulder: extra opaque road (world units) added on EACH side beyond the lanes, to cover the
  //    map's own road so only our distinct track shows.
  laneScale?: number;
  shoulder?: number;
  //  - smoothing: 0 = STRAIGHT segments between points (sharp corners, exact placement); higher
  //    rounds the corners into a flowing curve (1 = max). Default 0 so adding a point doesn't bend.
  smoothing?: number;
}

/** Identity transform (no move/rotate, scale 1) — the sensible default for either object. */
export const IDENTITY_TRANSFORM: MapTransform = { pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1 };

/**
 * The geometric CENTER of the FULL race (the whole distance cars drive, z 0..RACE_LEN) in sim
 * coords: x centered on the track, z at half the full driven length. Both the align tool and the
 * game place the track group's ORIGIN here, so the gizmo sits at the race's true middle and
 * rotation pivots about it. Using RACE_LEN (not one lap) is what makes the editor footprint match
 * the length cars actually traverse. Keeping this identical in both prevents align→play drift.
 */
export const TRACK_CENTER: [number, number, number] = [0, 0, RACE_LEN / 2];

const d2r = (d: number) => (d * Math.PI) / 180;

/** Fetch all map configs (server reads assets/maps/maps.json). Returns {} on any failure. */
export async function fetchMaps(signal?: AbortSignal): Promise<Record<string, MapConfig>> {
  try {
    const res = await fetch('/api/maps', { signal });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, MapConfig>;
  } catch { return {}; }
}

/** List the available map GLB files in assets/maps/ (for the New-level map picker). */
export async function fetchMapFiles(): Promise<string[]> {
  try {
    const res = await fetch('/api/map-files');
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.filter((f): f is string => typeof f === 'string') : [];
  } catch { return []; }
}

/** Delete a level by key. Returns true on success. */
export async function deleteMap(key: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/maps?map=${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    return res.ok;
  } catch { return false; }
}

/** Apply a saved track transform to a group (used by the game + align mode). */
export function applyTrackTransform(group: THREE.Object3D, t: MapTransform): void {
  group.position.fromArray(t.pos);
  group.rotation.set(d2r(t.rotDeg[0] ?? 0), d2r(t.rotDeg[1] ?? 0), d2r(t.rotDeg[2] ?? 0));
  group.scale.setScalar(t.scale || 1);
}

const r2d = (r: number) => (r * 180) / Math.PI;

/** Decompose a similarity matrix (uniform scale) back to a {pos, rotDeg, scale} MapTransform. */
export function transformFromMatrix(m: THREE.Matrix4): MapTransform {
  const pos = new THREE.Vector3(); const quat = new THREE.Quaternion(); const scl = new THREE.Vector3();
  m.decompose(pos, quat, scl);
  const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  const round = (n: number, p = 3) => Math.round(n * 10 ** p) / 10 ** p;
  return {
    pos: [round(pos.x), round(pos.y), round(pos.z)],
    rotDeg: [Math.round(r2d(e.x)), Math.round(r2d(e.y)), Math.round(r2d(e.z))],
    scale: round(scl.x),   // uniform: x==y==z
  };
}

/** Build the Matrix4 a MapTransform represents (pos · rot(XYZ) · uniform-scale). */
export function matrixFromTransform(t: MapTransform): THREE.Matrix4 {
  const pos = new THREE.Vector3().fromArray(t.pos);
  const quat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(d2r(t.rotDeg[0] ?? 0), d2r(t.rotDeg[1] ?? 0), d2r(t.rotDeg[2] ?? 0), 'XYZ'));
  const scl = new THREE.Vector3().setScalar(t.scale || 1);
  return new THREE.Matrix4().compose(pos, quat, scl);
}

/**
 * The CANONICAL track transform the game always uses: identity-positioned at the race center so
 * cars/items run in raw sim space (z 0..TRACK_LEN, scale 1). The editor may move the track freely
 * for convenience, but on save we re-express the MAP relative to THIS, and the game pins the track
 * here — so the camera/fog/physics (which assume sim space) never break.
 */
export const CANONICAL_TRACK: MapTransform = { pos: [...TRACK_CENTER], rotDeg: [0, 0, 0], scale: 1 };

/**
 * Wrap a loaded GLB scene in a transform group whose LOCAL ORIGIN is the model's
 * visual center. GLBs author their pivot anywhere (often a corner), which would put
 * the align gizmo far off in space; recentering puts the pivot on the track itself.
 * MUST be used by BOTH align mode and the game so the saved transform means the same
 * thing in both (the stored pos = where the model's center sits in game space).
 */
export function wrapMapScene(scene: THREE.Object3D): THREE.Group {
  const wrap = new THREE.Group();
  let meshCount = 0;
  const bounds = new THREE.Box3();
  scene.updateMatrixWorld(true);
  scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (mesh.geometry?.getAttribute('position')?.count ?? 0) < 3) return;
    for (let current: THREE.Object3D | null = mesh; current; current = current.parent) if (!current.visible) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    if (materials.length === 0 || materials.every(material => !material.visible)) return;
    bounds.union(new THREE.Box3().setFromObject(mesh));
    meshCount += 1;
  });
  const size = bounds.getSize(new THREE.Vector3());
  if (meshCount === 0 || bounds.isEmpty() || ![size.x, size.y, size.z].every(Number.isFinite)
    || Math.max(size.x, size.y, size.z) <= 1e-6) throw new Error('map has no renderable geometry');
  const center = bounds.getCenter(new THREE.Vector3());
  scene.position.sub(center);   // recenter: model's visual center → wrap's local origin
  wrap.add(scene);
  return wrap;
}

/** Release a map that finished decoding after its race or preview was cancelled. */
export function disposeMapWorld(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const bitmaps = new Set<ImageBitmap>();
  const skeletons = new Set<THREE.Skeleton>();
  const instances = new Set<THREE.InstancedMesh>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) instances.add(mesh as THREE.InstancedMesh);
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((mesh as THREE.SkinnedMesh).skeleton);
    if (mesh.geometry) geometries.add(mesh.geometry);
    const assigned = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of assigned) if (material) materials.add(material);
  });
  for (const instance of instances) instance.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) bitmaps.add(texture.image);
    texture.dispose();
  }
  for (const bitmap of bitmaps) bitmap.close();
}

/**
 * Load the scenery GLB for `cfg` into a recentered group placed in game space per cfg.model.
 * (The TRACK transform is applied separately by the game to its own race group.)
 * A race deadline can abort the download. Decoding cannot be interrupted, so a scene decoded
 * after cancellation is disposed before it can replace the generated race presentation.
 * Resolves null on failure (game falls back to its own generated track + sky).
 */
export async function loadMapWorld(cfg: MapConfig, signal?: AbortSignal): Promise<THREE.Group | null> {
  if (signal?.aborted) return null;
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  loader.setDRACOLoader(draco);
  let ownedScene: THREE.Object3D | null = null;
  try {
    const response = await fetch(`/assets/maps/${cfg.file}`, { signal });
    if (!response.ok || signal?.aborted) return null;
    const bytes = await response.arrayBuffer();
    if (signal?.aborted) return null;
    // Relative resources in authored GLBs resolve against the same map directory as load().
    const gltf = await loader.parseAsync(bytes, '/assets/maps/');
    ownedScene = gltf.scene;
    if (signal?.aborted) return null;
    const wrap = wrapMapScene(ownedScene);
    ownedScene = wrap;
    applyTrackTransform(wrap, cfg.model ?? IDENTITY_TRANSFORM);
    // Map terrain both casts AND receives shadows so the raking sun models its hills/buildings.
    wrap.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    if (signal?.aborted) return null;
    ownedScene = null; // ownership passes to the caller/renderer
    return wrap;
  } catch {
    return null;
  } finally {
    if (ownedScene) disposeMapWorld(ownedScene);
    draco.dispose();
  }
}
