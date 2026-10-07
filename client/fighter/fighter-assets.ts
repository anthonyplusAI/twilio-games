import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { FIGHTER_ROSTER } from '../../shared/fighter-roster';

export interface FighterSpec {
  id: string;
  label: string;
  file: string;
  embeddedIdle?: boolean;
}

export interface FighterAnimationSpec {
  id: string;
  label: string;
  file: string;
  key: string;
  neutral?: boolean;
  stripRootMotion?: boolean;
}

export const FIGHTER_ASSET_ROOT = '/assets/fighters/source/';
export const FIGHTER_ASSET_VERSION = '4';
const FIGHTER_ANIMATION_TIMEOUT_MS = 30_000;
export const fighterAssetUrl = (file: string) => `${FIGHTER_ASSET_ROOT}${file}?v=${FIGHTER_ASSET_VERSION}`;

export function preferProceduralFighterAssets(connection?: { saveData?: boolean; effectiveType?: string }): boolean {
  return Boolean(connection?.saveData || /^(?:slow-2g|2g|3g)$/.test(connection?.effectiveType ?? ''));
}

export const FIGHTERS: FighterSpec[] = FIGHTER_ROSTER.map(entry => ({ id: entry.id, label: entry.name, file: entry.file, embeddedIdle: entry.embeddedIdle }));

export const FIGHTER_ANIMATIONS: FighterAnimationSpec[] = [
  { id: 'idle', label: 'Fighting Idle', file: 'fighting-idle.fbx', key: '1', neutral: true },
  { id: 'walk', label: 'Run Forward', file: 'run-forward.fbx', key: '2', stripRootMotion: true },
  { id: 'walk-back', label: 'Run Backward', file: 'run-backward.fbx', key: '3', stripRootMotion: true },
  { id: 'jump-01', label: 'High Jump', file: 'jump-high.fbx', key: '4', stripRootMotion: true },
  { id: 'jump-02', label: 'Vertical Jump', file: 'jump-vertical.fbx', key: '4', stripRootMotion: true },
  { id: 'block-01', label: 'Outward Block', file: 'block-outward.fbx', key: '5' },
  { id: 'punch-01', label: 'Punch Combo', file: 'punch-combo.fbx', key: '6' },
  { id: 'punch-02', label: 'Uppercut', file: 'punch-uppercut.fbx', key: '6' },
  { id: 'punch-03', label: 'Right Hook', file: 'punch-right-hook.fbx', key: '6' },
  { id: 'kick-01', label: 'MMA Kick', file: 'kick-mma-01.fbx', key: '7' },
  { id: 'kick-02', label: 'MMA Kick Two', file: 'kick-mma-02.fbx', key: '7' },
  { id: 'kick-03', label: 'MMA Kick Three', file: 'kick-mma-03.fbx', key: '7' },
  { id: 'kick-04', label: 'Standard Kick', file: 'kick-standard.fbx', key: '7' },
  { id: 'reaction-01', label: 'Hit Reaction', file: 'hit-reaction-01.fbx', key: '8' },
  { id: 'reaction-02', label: 'Head Hit', file: 'hit-reaction-head.fbx', key: '8' },
  { id: 'reaction-04', label: 'Face Hit', file: 'hit-reaction-face.fbx', key: '8' },
  { id: 'reaction-05', label: 'Body Hit', file: 'hit-reaction-body.fbx', key: '8' },
  { id: 'fall-01', label: 'Knockout Fall', file: 'knockout-fall.fbx', key: '9' },
  { id: 'fall-02', label: 'Shoulder Knockdown', file: 'knockdown-shoulder.fbx', key: '9' },
  { id: 'celebration-01', label: 'Victory', file: 'victory-01.fbx', key: 'v' },
  { id: 'celebration-02', label: 'Victory Two', file: 'victory-02.fbx', key: 'v' },
  { id: 'celebration-03', label: 'Jazz Dance', file: 'celebration-jazz.fbx', key: 'v' },
  { id: 'celebration-04', label: 'Salsa Dance', file: 'celebration-salsa.fbx', key: 'v' },
  { id: 'celebration-05', label: 'Macarena', file: 'celebration-macarena.fbx', key: 'v' },
  { id: 'celebration-06', label: 'Silly Dance', file: 'celebration-silly.fbx', key: 'v' },
];

export const ANIMATION_POOLS: Record<string, string[]> = {
  idle: ['idle'], walk: ['walk'], 'walk-back': ['walk-back'], jump: ['jump-01', 'jump-02'], block: ['block-01'],
  punch: ['punch-01', 'punch-02', 'punch-03'], kick: ['kick-01', 'kick-02', 'kick-03', 'kick-04'],
  reaction: ['reaction-01', 'reaction-02', 'reaction-04', 'reaction-05'], fall: ['fall-01', 'fall-02'],
  celebration: ['celebration-01', 'celebration-02', 'celebration-03', 'celebration-04', 'celebration-05', 'celebration-06'],
};

/** One readable clip per combat verb is enough for the first match. Optional alternate takes
 *  should never compete with the selected fighters and arena on a slow connection. */
export const STARTUP_ANIMATION_IDS = [
  'idle', 'walk', 'walk-back', 'jump-01', 'block-01', 'punch-01', 'kick-01',
  'reaction-01', 'fall-01', 'celebration-01',
] as const;

export async function loadFbx(file: string, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<THREE.Group> {
  // FBXLoader.load uses FileLoader, whose request cannot be cancelled by callers.
  // Fetch the bytes ourselves so a timeout, changed selection, or active bout
  // actually releases network bandwidth before optional models are parsed.
  const response = await fetch(fighterAssetUrl(file), { signal });
  if (!response.ok) throw new Error(`fighter asset ${file} failed with HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (signal?.aborted) throw signal.reason ?? new DOMException('Fighter asset request aborted', 'AbortError');
  onProgress?.(1);
  return new FBXLoader().parse(buffer, FIGHTER_ASSET_ROOT);
}

/** Keep animation pose and vertical body motion, but remove Mixamo's baked X/Z travel. */
export function withoutHorizontalRootMotion(source: THREE.AnimationClip): THREE.AnimationClip {
  const clip = source.clone();
  for (const track of clip.tracks) {
    if (!/hips\.position$/i.test(track.name) || track.values.length < 3) continue;
    const x = track.values[0]!;
    const z = track.values[2]!;
    for (let i = 0; i < track.values.length; i += 3) {
      track.values[i] = x;
      track.values[i + 2] = z;
    }
  }
  return clip;
}

/** Mixamo may number an otherwise identical rig (mixamorigHips -> mixamorig1Hips). */
export function retargetClipNames(source: THREE.AnimationClip, target: THREE.Object3D): THREE.AnimationClip {
  const clip = source.clone();
  const targetByBone = new Map<string, string>();
  let targetHipsY: number | null = null;
  target.traverse((node) => {
    if (!node.name) return;
    const bone = node.name.replace(/^mixamorig\d*/i, '');
    targetByBone.set(bone, node.name);
    if (bone.toLowerCase() === 'hips') targetHipsY = node.position.y;
  });

  for (const track of clip.tracks) {
    const separator = track.name.lastIndexOf('.');
    if (separator < 0) continue;
    const sourceNode = track.name.slice(0, separator);
    const targetNode = targetByBone.get(sourceNode.replace(/^mixamorig\d*/i, ''));
    if (targetNode) track.name = targetNode + track.name.slice(separator);
  }

  // Retarget rotations, but never copy source-rig limb/head translations onto a differently
  // proportioned character. Mixamo's hip translation is the only positional track we need.
  clip.tracks = clip.tracks.filter(track => /\.quaternion$/i.test(track.name) || /hips\.position$/i.test(track.name));

  // Mixamo clips contain absolute hip positions from the character they were exported with.
  // Shift that position to the target rig's rest height while preserving the clip's Y movement.
  if (targetHipsY !== null) {
    const hipsPosition = clip.tracks.find((track) => /hips\.position$/i.test(track.name));
    if (hipsPosition && hipsPosition.values.length >= 3) {
      const offset = targetHipsY - hipsPosition.values[1]!;
      for (let i = 1; i < hipsPosition.values.length; i += 3) {
        hipsPosition.values[i] = hipsPosition.values[i]! + offset;
      }
    }
  }
  return clip;
}

export function prepareFighterModel(model: THREE.Group, targetHeight = 2.25): void {
  let meshCount = 0;
  model.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    meshCount += 1;
    const mesh = object as THREE.Mesh;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });

  const initialBox = new THREE.Box3().setFromObject(model);
  const height = initialBox.getSize(new THREE.Vector3()).y;
  if (meshCount === 0 || initialBox.isEmpty() || !Number.isFinite(height) || height <= 0) {
    throw new Error('fighter model has no finite renderable geometry');
  }
  model.scale.multiplyScalar(targetHeight / height);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;
  model.updateMatrixWorld(true);
}

export async function loadAnimationSources(
  onLoaded?: (loaded: number, total: number, label: string) => void,
  signal?: AbortSignal,
): Promise<Map<string, THREE.AnimationClip>> {
  const specs = FIGHTER_ANIMATIONS.filter(spec => STARTUP_ANIMATION_IDS.some(id => id === spec.id));
  const sources = new Map<string, THREE.AnimationClip>();
  let loaded = 0;
  let nextIndex = 0;
  const loadNext = async () => {
    while (!signal?.aborted && nextIndex < specs.length) {
      const spec = specs[nextIndex++]!;
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error(`animation ${spec.id} timed out`)), FIGHTER_ANIMATION_TIMEOUT_MS);
      try {
        const source = await loadFbx(spec.file, undefined, controller.signal), clip = source.animations[0];
        if (clip && clip.duration > 0 && clip.tracks.length > 0) sources.set(spec.id, clip);
      } catch { /* The procedural fighter remains playable if any clip fails. */ }
      finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        loaded += 1; onLoaded?.(loaded, specs.length, spec.label);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, specs.length) }, () => loadNext()));
  for (const pool of ['idle', 'walk', 'walk-back', 'jump', 'block', 'punch', 'kick', 'reaction', 'fall']) {
    if (!(ANIMATION_POOLS[pool] ?? []).some(id => sources.has(id))) throw new Error(`Required animation pool failed: ${pool}`);
  }
  return sources;
}

export function clipsForFighter(
  model: THREE.Group,
  sources: ReadonlyMap<string, THREE.AnimationClip>,
  embeddedIdle = false,
): Map<string, THREE.AnimationClip> {
  const clips = new Map<string, THREE.AnimationClip>();
  const restorePose = createPoseRestorer(model);
  const neutral = model.animations.find(clip => clip.duration > 0 && clip.tracks.length > 0);
  const hasEmbeddedIdle = embeddedIdle && Boolean(neutral);
  if (neutral) {
    const clip = neutral.clone();
    clip.name = hasEmbeddedIdle ? 'idle' : 'pose';
    clips.set(clip.name, clip);
  }
  for (const spec of FIGHTER_ANIMATIONS) {
    const source = sources.get(spec.id);
    if (!source) continue;
    if (hasEmbeddedIdle && spec.id === 'idle') continue;
    const retargeted = retargetClipNames(source, model);
    const rooted = spec.stripRootMotion ? withoutHorizontalRootMotion(retargeted) : retargeted;
    const clip = normalizeClipGround(model, rooted, restorePose);
    clip.name = spec.id;
    clips.set(spec.id, clip);
  }
  return clips;
}

/** Bake a target-specific vertical offset into the hip track once. Runtime grounding causes visible
 * popping as feet/body bounds change; clip preprocessing gives every action one stable floor plane. */
function normalizeClipGround(model: THREE.Group, source: THREE.AnimationClip, restorePose: () => void): THREE.AnimationClip {
  const clip = source.clone(), hips = clip.tracks.find(track => /hips\.position$/i.test(track.name));
  if (!hips || hips.values.length < 3 || model.scale.y === 0) return clip;
  restorePose();
  const mixer = new THREE.AnimationMixer(model), action = mixer.clipAction(clip);
  action.play(); mixer.setTime(Math.min(.001, clip.duration)); model.updateMatrixWorld(true);
  const minY = new THREE.Box3().setFromObject(model, true).min.y;
  mixer.stopAllAction(); mixer.uncacheRoot(model); restorePose();
  if (!Number.isFinite(minY) || Math.abs(minY) < .0001) return clip;
  const worldOffset = THREE.MathUtils.clamp(-minY, -2.5, 2.5);
  const localOffset = worldOffset / model.scale.y;
  for (let index = 1; index < hips.values.length; index += 3) hips.values[index] = hips.values[index]! + localOffset;
  return clip;
}

function createPoseRestorer(model: THREE.Object3D): () => void {
  const transforms: { object: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }[] = [];
  model.traverse(object => {
    if ((object as THREE.Bone).isBone) transforms.push({ object, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() });
  });
  return () => {
    for (const transform of transforms) {
      transform.object.position.copy(transform.position); transform.object.quaternion.copy(transform.quaternion); transform.object.scale.copy(transform.scale);
      transform.object.updateMatrix();
    }
    model.updateMatrixWorld(true);
  };
}
