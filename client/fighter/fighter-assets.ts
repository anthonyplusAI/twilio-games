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
// Shorter than the selected-model first-attempt window, so one stalled optional
// motion cannot prevent a downloaded character from appearing in the match.
const FIGHTER_ANIMATION_BANK_BUDGET_MS = 8_000;
export const fighterAssetUrl = (file: string) => `${FIGHTER_ASSET_ROOT}${file}?v=${FIGHTER_ASSET_VERSION}`;

export function preferProceduralFighterAssets(connection?: { saveData?: boolean; effectiveType?: string }): boolean {
  // Honor an explicit data-saving preference. A slow effectiveType still gets a
  // bounded attempt at the selected real model instead of skipping it outright.
  return Boolean(connection?.saveData);
}

export function fighterAssetFirstAttemptMs(connection?: { effectiveType?: string }): number {
  return /^(?:slow-2g|2g|3g)$/.test(connection?.effectiveType ?? '') ? 12_000 : 24_000;
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
  const rigName = (name: string) => name.replace(/^mixamorig\d*[:_]?/i, '');
  let targetHipsY: number | null = null;
  target.traverse((node) => {
    if (!node.name) return;
    const bone = rigName(node.name);
    targetByBone.set(bone, node.name);
    if (bone.toLowerCase() === 'hips') targetHipsY = node.position.y;
  });

  const playableTracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const separator = track.name.lastIndexOf('.');
    if (separator < 0) continue;
    const sourceNode = track.name.slice(0, separator);
    const targetNode = targetByBone.get(rigName(sourceNode));
    if (!targetNode || !(/\.quaternion$/i.test(track.name) || /hips\.position$/i.test(track.name))) continue;
    track.name = targetNode + track.name.slice(separator);
    playableTracks.push(track);
  }

  // Retarget rotations, but never copy source-rig limb/head translations onto a differently
  // proportioned character. Mixamo's hip translation is the only positional track we need.
  clip.tracks = playableTracks;

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
  const bank = new AbortController();
  const onAbort = () => bank.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => bank.abort(new Error('Fighter animation bank timed out')), FIGHTER_ANIMATION_BANK_BUDGET_MS);
  let loaded = 0;
  let nextIndex = 0;
  const loadNext = async () => {
    while (!bank.signal.aborted && nextIndex < specs.length) {
      const spec = specs[nextIndex++]!;
      try {
        const source = await loadFbx(spec.file, undefined, bank.signal), clip = source.animations[0];
        if (clip && clip.duration > 0 && clip.tracks.length > 0) sources.set(spec.id, clip);
      } catch { /* Keep the clips that did load; missing actions receive local animation fallbacks. */ }
      finally {
        loaded += 1; onLoaded?.(loaded, specs.length, spec.label);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(3, specs.length) }, () => loadNext()));
    return sources;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onAbort);
  }
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
    if (rooted.duration <= 0 || rooted.tracks.length === 0) continue;
    const clip = normalizeClipGround(model, rooted, restorePose);
    clip.name = spec.id;
    clips.set(spec.id, clip);
  }
  addMissingFighterClips(model, clips);
  return clips;
}

type MotionPart = 'body' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';
type MotionAxis = 'x' | 'z';
type MotionTrack = readonly [MotionPart, MotionAxis, readonly number[], readonly number[]];

/** Small, rig-aware motions keep a downloaded character playable when an optional FBX clip is
 * unavailable. The body track works even for a custom rig; limb tracks enrich Mixamo rigs. */
const LOCAL_FIGHTER_MOTIONS: Record<string, { duration: number; tracks: readonly MotionTrack[] }> = {
  idle: { duration: 1.1, tracks: [
    ['body', 'z', [0, .55, 1.1], [0, .018, 0]],
  ] },
  walk: { duration: .7, tracks: [
    ['body', 'z', [0, .175, .35, .525, .7], [0, -.055, 0, .055, 0]],
    ['leftLeg', 'x', [0, .175, .35, .525, .7], [.3, 0, -.3, 0, .3]],
    ['rightLeg', 'x', [0, .175, .35, .525, .7], [-.3, 0, .3, 0, -.3]],
  ] },
  'walk-back': { duration: .7, tracks: [
    ['body', 'z', [0, .175, .35, .525, .7], [0, .055, 0, -.055, 0]],
    ['leftLeg', 'x', [0, .175, .35, .525, .7], [-.25, 0, .25, 0, -.25]],
    ['rightLeg', 'x', [0, .175, .35, .525, .7], [.25, 0, -.25, 0, .25]],
  ] },
  jump: { duration: .64, tracks: [
    ['body', 'x', [0, .16, .43, .64], [0, -.09, -.09, 0]],
    ['leftLeg', 'x', [0, .16, .43, .64], [0, .34, .34, 0]],
    ['rightLeg', 'x', [0, .16, .43, .64], [0, -.34, -.34, 0]],
  ] },
  block: { duration: .54, tracks: [
    ['body', 'z', [0, .12, .42, .54], [0, .06, .06, 0]],
    ['leftArm', 'x', [0, .12, .42, .54], [0, -.85, -.85, 0]],
    ['rightArm', 'x', [0, .12, .42, .54], [0, -.85, -.85, 0]],
  ] },
  punch: { duration: .47, tracks: [
    ['body', 'z', [0, .12, .25, .47], [0, -.12, -.16, 0]],
    ['rightArm', 'x', [0, .12, .25, .47], [0, -1.0, -1.3, 0]],
  ] },
  kick: { duration: .66, tracks: [
    ['body', 'z', [0, .16, .36, .66], [0, .08, .13, 0]],
    ['rightLeg', 'x', [0, .16, .36, .66], [0, -.42, -1.06, 0]],
  ] },
  reaction: { duration: .36, tracks: [
    ['body', 'z', [0, .12, .36], [0, .23, 0]],
  ] },
  fall: { duration: .7, tracks: [
    ['body', 'z', [0, .7], [0, 1.42]],
  ] },
  celebration: { duration: 1.1, tracks: [
    ['body', 'z', [0, .25, .72, 1.1], [0, -.07, .07, 0]],
    ['leftArm', 'x', [0, .25, .72, 1.1], [0, -1.15, -1.15, 0]],
    ['rightArm', 'x', [0, .25, .72, 1.1], [0, -1.15, -1.15, 0]],
  ] },
};

function addMissingFighterClips(model: THREE.Group, clips: Map<string, THREE.AnimationClip>): void {
  const authoredIds = new Set(clips.keys());
  const rig: Partial<Record<MotionPart, THREE.Object3D>> = { body: model };
  model.traverse(node => {
    if (!(node as THREE.Bone).isBone || !node.name) return;
    const name = node.name.toLowerCase().replace(/[^a-z]/g, '');
    for (const part of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg'] as const) {
      const suffix = part === 'leftLeg' ? 'leftupleg' : part === 'rightLeg' ? 'rightupleg' : part.toLowerCase();
      if (!rig[part] && name.endsWith(suffix)) rig[part] = node;
    }
  });
  for (const [pool, ids] of Object.entries(ANIMATION_POOLS)) {
    if (ids.some(id => clips.has(id))) continue;
    const id = ids[0];
    if (!id) continue;
    const opposite = pool === 'walk' ? 'walk-back' : pool === 'walk-back' ? 'walk' : null;
    if (opposite && authoredIds.has(opposite)) {
      clips.set(id, reverseClip(clips.get(opposite)!, id));
      continue;
    }
    const motion = LOCAL_FIGHTER_MOTIONS[pool];
    if (!motion) continue;
    const tracks = motion.tracks.flatMap(([part, axis, times, offsets]) => {
      const node = rig[part];
      if (!node || (part !== 'body' && /[.\[\]]/.test(node.name))) return [];
      const path = part === 'body' ? `.rotation[${axis}]` : `${node.name}.rotation[${axis}]`;
      return [new THREE.NumberKeyframeTrack(path, times, offsets.map(offset => node.rotation[axis] + offset))];
    });
    clips.set(id, new THREE.AnimationClip(id, motion.duration, tracks));
  }
}

function reverseClip(source: THREE.AnimationClip, id: string): THREE.AnimationClip {
  const reversed = source.clone();
  reversed.name = id;
  for (const track of reversed.tracks) {
    const values = track.values.slice();
    const stride = track.getValueSize();
    for (let frame = 0; frame < track.times.length; frame++) {
      const sourceOffset = (track.times.length - 1 - frame) * stride;
      const targetOffset = frame * stride;
      for (let value = 0; value < stride; value++) track.values[targetOffset + value] = values[sourceOffset + value]!;
    }
  }
  return reversed;
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
