import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { KaraokeLane, KaraokeSong, KaraokeWord } from '../../shared/karaoke';
import type { KaraokeEvent, KaraokeJudgment, KaraokePhase } from '../../shared/karaoke-protocol';
import { karaokeLyricsAtTime, visibleKaraokeWordsAtTime } from '../../shared/karaoke-timeline';
import {
  DEFAULT_KARAOKE_VENUE,
  cloneKaraokeVenueConfig,
  karaokeVenueModel,
  type KaraokeTransform,
  type KaraokeVenueConfig,
} from '../../shared/karaoke-venue';
import {
  KARAOKE_DRUMMER_FALLBACK_POSITION,
  disposeKaraokeObjectResources,
  karaokeDrumAnchor,
  type KaraokeAssetRole,
  type KaraokeLoadedAsset,
} from './karaoke-assets';
import {
  KARAOKE_WORD_TEXTURE_HEIGHT,
  KARAOKE_WORD_TEXTURE_WIDTH,
  KARAOKE_SUSTAIN_TAIL_DEPTH,
  KARAOKE_WORD_TILE_DEPTH,
  karaokeAdaptiveRenderMode,
  karaokeAnimatedTransform,
  karaokeCanInstallOptionalAssets,
  karaokeCameraShot,
  karaokeDrumAnchorTransform,
  karaokeFallbackWordProjection,
  karaokeHighwayPose,
  karaokeInitialRenderMode,
  karaokeRenderPixelRatio,
  karaokeResponsiveHighwayTransform,
  karaokeStageIntensity,
  karaokeStaticCameraShot,
  karaokeSustainTailPose,
  type KaraokeCameraTargets,
  type KaraokeRenderMode,
} from './karaoke-client-utils';

type JudgmentEvent = Extract<KaraokeEvent, { type: 'word_judgment' }>;

export interface KaraokeStageFrame {
  song: KaraokeSong | null;
  phase: KaraokePhase;
  songTimeMs: number;
  serverNowMs: number;
  score: number;
  combo: number;
}

interface TileVisual {
  root: THREE.Group;
  face: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  tail: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.CanvasTexture;
}

interface BurstVisual {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  lane: KaraokeLane;
  atMs: number;
}

interface PerformerRig {
  root: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
}

interface PerformerAnimation {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: readonly THREE.AnimationAction[];
  clips: readonly THREE.AnimationClip[];
}

export interface KaraokeCrowdMember {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly phase: number;
  readonly speed: number;
  readonly height: number;
  readonly yaw: number;
  readonly pose: 0 | 1 | 2;
  readonly armSlot: number;
  readonly shirtColor: number;
  readonly skinColor: number;
  readonly hairStyle: 0 | 1 | 2;
  readonly hairSlot: number;
  readonly hairColor: number;
}

export interface KaraokeCrowdMeshes {
  root: THREE.Group;
  heads: THREE.InstancedMesh;
  hairs: readonly [THREE.InstancedMesh, THREE.InstancedMesh, THREE.InstancedMesh];
  torsos: THREE.InstancedMesh;
  arms: readonly [THREE.InstancedMesh, THREE.InstancedMesh, THREE.InstancedMesh];
}

const LANE_COLORS = [0xef223a, 0x2188ef, 0xfd7685, 0x3acefa] as const;
const LANE_CSS = ['#EF223A', '#2188EF', '#FD7685', '#3ACEFA'] as const;
const CROWD_SHIRT_COLORS = [0xef223a, 0x2188ef, 0xfd7685, 0x3acefa, 0x656e87, 0xf6c85f] as const;
const CROWD_SKIN_COLORS = [0x6f3f2b, 0x9b6042, 0xc88968, 0xe0ad87, 0xf1c8a7] as const;
const CROWD_HAIR_COLORS = [0x110d12, 0x2a1712, 0x5c3020, 0x9b6a38, 0xb8a58f, 0x64231e] as const;
export const KARAOKE_CROWD_MEMBER_COUNT = 126;
export const KARAOKE_CROWD_DRAW_CALLS = 8;

export function createKaraokeCrowdLayout(): readonly KaraokeCrowdMember[] {
  const values: KaraokeCrowdMember[] = [];
  let seed = 0x434f4e43;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    return seed / 0xffff_ffff;
  };
  const hairSlots = [0, 0, 0];
  for (let row = 0; row < 7; row++) {
    for (let column = 0; column < 18; column++) {
      const index = values.length;
      const side = column < 9 ? -1 : 1;
      const pose = index % 3 as 0 | 1 | 2;
      const hairStyle = Math.floor(random() * 3) as 0 | 1 | 2;
      const hairSlot = hairSlots[hairStyle]!;
      hairSlots[hairStyle] = hairSlot + 1;
      values.push(Object.freeze({
        x: side * (4.25 + (column % 9) * .58 + random() * .24),
        y: .18 + row * .13,
        z: 2.1 + row * .95 + random() * .3,
        phase: random() * Math.PI * 2,
        speed: 2.25 + random() * 1.2,
        height: .82 + random() * .3,
        yaw: (random() - .5) * .32,
        pose,
        armSlot: Math.floor(index / 3),
        shirtColor: CROWD_SHIRT_COLORS[Math.floor(random() * CROWD_SHIRT_COLORS.length)]!,
        skinColor: CROWD_SKIN_COLORS[Math.floor(random() * CROWD_SKIN_COLORS.length)]!,
        hairStyle,
        hairSlot,
        hairColor: CROWD_HAIR_COLORS[Math.floor(random() * CROWD_HAIR_COLORS.length)]!,
      }));
    }
  }
  return Object.freeze(values);
}

function crowdHairGeometry(style: 0 | 1 | 2): THREE.BufferGeometry {
  const cap = new THREE.SphereGeometry(.112, 16, 10, 0, Math.PI * 2, 0, Math.PI * .52)
    .translate(0, .872, 0);
  if (style === 0) return cap;
  const pieces: THREE.BufferGeometry[] = [cap];
  if (style === 1) {
    pieces.push(
      new THREE.SphereGeometry(.055, 12, 8).scale(.7, 1.35, .8).translate(-.082, .868, -.012),
      new THREE.SphereGeometry(.055, 12, 8).scale(.7, 1.35, .8).translate(.082, .868, -.012),
    );
  } else {
    pieces.push(new THREE.SphereGeometry(.067, 14, 10).translate(0, .987, -.04));
  }
  const merged = mergeGeometries(pieces, false);
  for (const piece of pieces) piece.dispose();
  if (!merged) throw new Error('Unable to create Karaoke crowd hair geometry.');
  return merged;
}

function crowdArmGeometry(pose: 0 | 1 | 2): THREE.BufferGeometry {
  const vectors = [
    [[-.18, .38], [.18, .38]],
    [[-.28, .12], [.1, .42]],
    [[-.08, .42], [.3, .15]],
  ] as const;
  const geometries = vectors[pose].map(([x, y], index) => {
    const side = index === 0 ? -1 : 1;
    const direction = new THREE.Vector3(x, y, 0);
    const geometry = new THREE.CylinderGeometry(.034, .044, direction.length(), 5);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(side * .15 + x * .5, .58 + y * .5, 0),
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
      new THREE.Vector3(1, 1, 1),
    );
    return geometry.applyMatrix4(matrix);
  });
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) throw new Error('Unable to create Karaoke crowd arm geometry.');
  return merged;
}

export function createKaraokeCrowdMeshes(
  layout: readonly KaraokeCrowdMember[] = createKaraokeCrowdLayout(),
): KaraokeCrowdMeshes {
  const root = new THREE.Group();
  root.name = 'human-crowd';
  const material = (flatShading = true): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: .86, metalness: 0, flatShading,
  });
  const headGeometry = new THREE.SphereGeometry(.108, 20, 14).translate(0, .86, 0);
  const torsoGeometry = new THREE.CylinderGeometry(.19, .13, .44, 5).translate(0, .42, 0);
  const heads = new THREE.InstancedMesh(headGeometry, material(false), layout.length);
  const torsos = new THREE.InstancedMesh(torsoGeometry, material(), layout.length);
  const poseCounts = [0, 1, 2].map(pose => layout.filter(member => member.pose === pose).length);
  const hairCounts = [0, 1, 2].map(style => layout.filter(member => member.hairStyle === style).length);
  const hairs: [THREE.InstancedMesh, THREE.InstancedMesh, THREE.InstancedMesh] = [
    new THREE.InstancedMesh(crowdHairGeometry(0), material(false), hairCounts[0]!),
    new THREE.InstancedMesh(crowdHairGeometry(1), material(false), hairCounts[1]!),
    new THREE.InstancedMesh(crowdHairGeometry(2), material(false), hairCounts[2]!),
  ];
  const arms: [THREE.InstancedMesh, THREE.InstancedMesh, THREE.InstancedMesh] = [
    new THREE.InstancedMesh(crowdArmGeometry(0), material(), poseCounts[0]!),
    new THREE.InstancedMesh(crowdArmGeometry(1), material(), poseCounts[1]!),
    new THREE.InstancedMesh(crowdArmGeometry(2), material(), poseCounts[2]!),
  ];
  heads.name = 'crowd-heads';
  hairs.forEach((mesh, style) => { mesh.name = `crowd-hair-style-${style}`; });
  torsos.name = 'crowd-torsos';
  arms.forEach((mesh, pose) => { mesh.name = `crowd-arms-pose-${pose}`; });
  layout.forEach((member, index) => {
    heads.setColorAt(index, new THREE.Color(member.skinColor));
    hairs[member.hairStyle].setColorAt(member.hairSlot, new THREE.Color(member.hairColor));
    torsos.setColorAt(index, new THREE.Color(member.shirtColor));
    arms[member.pose].setColorAt(member.armSlot, new THREE.Color(member.shirtColor));
  });
  for (const mesh of [heads, ...hairs, torsos, ...arms]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    root.add(mesh);
  }
  root.userData.karaokeCrowdMembers = layout.length;
  root.userData.karaokeCrowdDrawCalls = root.children.length;
  return { root, heads, hairs, torsos, arms };
}

/** Network-free Twilio mark for the procedural venue. */
export function createKaraokeProceduralLogo(): THREE.Group {
  const logo = new THREE.Group();
  logo.name = 'procedural-twilio-mark';
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  logo.add(new THREE.Mesh(new THREE.RingGeometry(.77, .95, 48), white));
  const dots = new THREE.InstancedMesh(new THREE.CircleGeometry(.135, 18), white, 4);
  const positions = [[-.32, .32], [.32, .32], [-.32, -.32], [.32, -.32]] as const;
  positions.forEach(([x, y], index) => dots.setMatrixAt(index,
    new THREE.Matrix4().makeTranslation(x, y, .01)));
  dots.instanceMatrix.needsUpdate = true;
  logo.add(dots);
  return logo;
}

/** A single instanced LED wall adds texture to the fallback stage without per-light draw calls. */
export function createKaraokeProceduralLedWall(): THREE.InstancedMesh {
  const cells: Array<{ x: number; y: number; color: number }> = [];
  for (const side of [-1, 1]) {
    for (let column = 0; column < 11; column++) {
      const height = 2 + Math.round(5 * Math.abs(Math.sin(column * .64 + side * .9)));
      for (let row = 0; row < height; row++) cells.push({
        x: side * (3.42 + column * .29),
        y: 1.05 + row * .42,
        color: row > 4 ? 0xfd7685 : column % 3 === 0 ? 0x3acefa : 0x2188ef,
      });
    }
  }
  const wall = new THREE.InstancedMesh(
    new THREE.BoxGeometry(.13, .19, .045),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    cells.length,
  );
  wall.name = 'procedural-led-wall';
  const dummy = new THREE.Object3D();
  cells.forEach((cell, index) => {
    dummy.position.set(cell.x, cell.y, -5.94);
    dummy.updateMatrix();
    wall.setMatrixAt(index, dummy.matrix);
    wall.setColorAt(index, new THREE.Color(cell.color));
  });
  wall.instanceMatrix.needsUpdate = true;
  if (wall.instanceColor) wall.instanceColor.needsUpdate = true;
  return wall;
}

export class KaraokeStage {
  private renderer: THREE.WebGLRenderer | null = null;
  private composer: EffectComposer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(39, 16 / 9, .05, 120);
  private readonly highwayScene = new THREE.Scene();
  private readonly highwayCamera = new THREE.PerspectiveCamera(39, 16 / 9, .05, 120);
  private readonly venue = new THREE.Group();
  private readonly drumAnchorRoot = new THREE.Group();
  private readonly lightingRig = new THREE.Group();
  private readonly highway = new THREE.Group();
  private readonly tileLayer = new THREE.Group();
  private readonly burstLayer = new THREE.Group();
  private readonly proceduralByRole = new Map<KaraokeAssetRole, THREE.Object3D>();
  private readonly installedByRole = new Map<KaraokeAssetRole, THREE.Object3D>();
  private readonly performerAnimations = new Map<KaraokeAssetRole, PerformerAnimation>();
  private readonly tiles = new Map<string, TileVisual>();
  private readonly judgments = new Map<string, JudgmentEvent>();
  private readonly bursts: BurstVisual[] = [];
  private readonly crowd: KaraokeCrowdMeshes;
  private readonly crowdBase: readonly KaraokeCrowdMember[];
  private readonly crowdDummy = new THREE.Object3D();
  private readonly lead: PerformerRig;
  private readonly backup: PerformerRig;
  private readonly drummer: PerformerRig;
  private readonly guitarist: PerformerRig;
  private readonly proceduralDrumKit: THREE.Group;
  private spotlights: THREE.SpotLight[] = [];
  private beams: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>[] = [];
  private ambient: THREE.HemisphereLight | null = null;
  private directional: THREE.DirectionalLight | null = null;
  private readonly tileGeometry = new THREE.PlaneGeometry(1.72, KARAOKE_WORD_TILE_DEPTH);
  private readonly tailGeometry = new THREE.PlaneGeometry(1.05, KARAOKE_SUSTAIN_TAIL_DEPTH);
  private readonly haloGeometry = new THREE.RingGeometry(.55, .73, 32);
  private readonly burstGeometry = new THREE.RingGeometry(.42, .55, 32);
  private readonly tailMaterials = LANE_COLORS.map(color => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: .24, side: THREE.DoubleSide, depthWrite: false,
  }));
  private readonly fallbackTiles = new Map<string, HTMLElement>();
  private readonly fallbackTileLayer: HTMLElement | null;
  private readonly currentLyric: HTMLElement | null;
  private readonly upcomingLyric: HTMLElement | null;
  private readonly reducedMotionQuery: MediaQueryList | null;
  private readonly reducedMotionListener: ((event: MediaQueryListEvent) => void) | null;
  private readonly resizeObserver: ResizeObserver | null;
  private currentSongId = '';
  private currentSong: KaraokeSong | null = null;
  private webGlUsable = true;
  private reducedMotion = false;
  private disposed = false;
  private lastAnimationSeconds = 0;
  private renderMode: KaraokeRenderMode = 'full';
  private lastFrameAtMs = 0;
  private frameMsTotal = 0;
  private frameSamples = 0;
  private renderModeChangedAtMs = 0;
  private lastDecorationAtMs = -Infinity;
  private drumAnchor = new THREE.Vector3(...KARAOKE_DRUMMER_FALLBACK_POSITION);
  private venueConfig = cloneKaraokeVenueConfig(DEFAULT_KARAOKE_VENUE);

  constructor(private readonly mount: HTMLElement, private readonly fallback: HTMLElement) {
    this.fallbackTileLayer = fallback.querySelector<HTMLElement>('[data-fallback-tiles]');
    this.currentLyric = mount.ownerDocument.getElementById('current-lyric');
    this.upcomingLyric = mount.ownerDocument.getElementById('upcoming-lyric');
    this.reducedMotionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.reducedMotion = this.reducedMotionQuery?.matches ?? false;
    this.reducedMotionListener = this.reducedMotionQuery
      ? event => { this.reducedMotion = event.matches; }
      : null;
    if (this.reducedMotionListener) this.reducedMotionQuery?.addEventListener('change', this.reducedMotionListener);
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
    this.resizeObserver?.observe(mount);
    this.scene.background = new THREE.Color(0x000d25);
    this.scene.fog = new THREE.FogExp2(0x000d25, .034);
    this.camera.position.set(...this.venueConfig.cameras.landscape.position);
    this.camera.lookAt(...this.venueConfig.cameras.landscape.lookAt);
    this.drumAnchorRoot.name = 'karaoke-drum-anchor';
    this.lightingRig.name = 'karaoke-light-rig';
    this.scene.add(this.venue, this.lightingRig);
    this.highwayScene.add(this.highway);
    this.venue.add(this.drumAnchorRoot);
    this.highway.add(this.tileLayer, this.burstLayer);
    this.buildVenue();
    this.lead = this.buildSinger('lead-singer', 0xef223a, -1.35, -.25, 1);
    this.backup = this.buildSinger('backup-singer', 0xfd7685, 1.35, -.25, -1);
    this.drummer = this.buildDrummer();
    this.proceduralDrumKit = this.buildDrumKit();
    this.guitarist = this.buildGuitarist();
    this.crowdBase = createKaraokeCrowdLayout();
    this.crowd = createKaraokeCrowdMeshes(this.crowdBase);
    this.animateCrowd(0, 0);
    this.venue.add(this.crowd.root);
    this.mount.dataset.karaokeCrowd = `${this.crowdBase.length}/${this.crowd.root.children.length}`;
    this.buildHighway();
    this.applyVenueConfig();
    this.mount.dataset.karaokeRenderMode = this.renderMode;
    try { this.createRenderer(); }
    catch (error) { this.failWebGl(error); }
  }

  get available(): boolean { return this.renderer !== null || this.fallbackTileLayer !== null; }

  setVenueConfig(config: KaraokeVenueConfig): void {
    this.venueConfig = cloneKaraokeVenueConfig(config);
    this.applyVenueConfig();
  }

  installAsset(asset: KaraokeLoadedAsset): void {
    const { role, model, animations, diagnostics } = asset;
    if (this.disposed) { disposeKaraokeObjectResources(model); return; }
    const prior = this.installedByRole.get(role);
    if (prior) {
      this.disposePerformerAnimation(role);
      prior.removeFromParent();
      disposeKaraokeObjectResources(prior);
    }
    (role === 'drummer' ? this.drumAnchorRoot : this.venue).add(model);
    this.installedByRole.set(role, model);
    this.proceduralByRole.get(role)!.visible = false;

    if (role === 'stage') {
      this.proceduralDrumKit.visible = false;
      this.applyRoleTransform(role, model);
      this.updateDrumAnchor();
    } else {
      this.applyRoleTransform(role, model);
      if (role === 'drummer') this.updateDrumAnchor();
      // Clips bind below the authored placement root, so even a source-root track cannot replace
      // the saved venue transform. The outer model remains the stable editor-controlled anchor.
      const animationRoot = model.children[0] ?? model;
      const mixer = new THREE.AnimationMixer(animationRoot);
      const actions = animations.map(clip => {
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
        return action;
      });
      mixer.setTime(this.lastAnimationSeconds);
      this.performerAnimations.set(role, { root: animationRoot, mixer, actions, clips: animations });
    }
    if (role === 'lead-singer') {
      this.mount.dataset.karaokeLeadMaterials = String(diagnostics.materialCount);
      this.mount.dataset.karaokeLeadTextures = `${diagnostics.loadedTextureCount}/${diagnostics.textureCount}`;
    }
    this.mount.dataset.karaokeAssets = [...this.installedByRole.keys()].join(',');
  }

  setSong(song: KaraokeSong | null): void {
    if (song?.id === this.currentSongId) { this.currentSong = song; return; }
    this.currentSongId = song?.id ?? '';
    this.currentSong = song;
    this.judgments.clear();
    for (const tile of this.tiles.values()) this.disposeTile(tile);
    this.tiles.clear();
    this.clearBursts();
    for (const tile of this.fallbackTiles.values()) tile.remove();
    this.fallbackTiles.clear();
  }

  registerJudgment(event: JudgmentEvent): void {
    this.judgments.set(event.wordId, event);
    const word = this.wordById(event.wordId);
    if (word) this.addBurst(word.lane, event.atMs, event.judgment);
  }

  pulseLane(lane: KaraokeLane, atMs: number): void {
    this.addBurst(lane, atMs, 'good');
  }

  resize(): void {
    if (!this.renderer) return;
    const width = Math.max(1, this.mount.clientWidth || innerWidth);
    const height = Math.max(1, this.mount.clientHeight || innerHeight);
    const pixelRatio = karaokeRenderPixelRatio(width, height, devicePixelRatio)
      * (this.renderMode === 'light' ? .8 : 1);
    this.camera.aspect = width / height;
    this.highwayCamera.aspect = width / height;
    this.applyHighwayTransform();
    this.applyHighwayCamera();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer?.setPixelRatio(pixelRatio);
    this.composer?.setSize(width, height);
  }

  update(frame: KaraokeStageFrame): void {
    this.setSong(frame.song);
    this.updateAccessibleLyrics(frame);
    if (!this.renderer) {
      this.updateFallbackHighway(frame);
      return;
    }
    const frameAtMs = performance.now();
    this.sampleFrameTime(frameAtMs, frame.phase);
    const activeTimeMs = frame.phase === 'countdown' || frame.phase === 'performing'
      ? frame.songTimeMs
      : frame.serverNowMs;
    const seconds = activeTimeMs / 1000;
    const animationSeconds = frame.phase === 'countdown' || frame.phase === 'performing'
      ? Math.max(0, frame.songTimeMs / 1000)
      : (frame.serverNowMs % 60_000) / 1000;
    const recent = this.latestJudgment(frame.serverNowMs);
    const intensity = karaokeStageIntensity(frame.combo, frame.score, recent);
    const motionSeconds = this.reducedMotion ? 0 : seconds;
    const motionIntensity = this.reducedMotion ? 0 : intensity;
    this.animatePerformers(motionSeconds, frame.song?.bpm ?? 100, motionIntensity);
    this.animateInstalledPerformers(this.reducedMotion ? 0 : animationSeconds);
    if (frameAtMs - this.lastDecorationAtMs >= 30 || frameAtMs < this.lastDecorationAtMs) {
      this.animateCrowd(motionSeconds, motionIntensity);
      this.animateLighting(motionSeconds, motionIntensity);
      this.lastDecorationAtMs = frameAtMs;
    }
    this.updateHighway(frame);
    this.updateBursts(frame.serverNowMs);
    const shot = this.reducedMotion
      ? karaokeStaticCameraShot(this.camera.aspect, this.venueConfig.cameras)
      : karaokeCameraShot(
        this.camera.aspect,
        frame.songTimeMs,
        motionIntensity,
        this.venueConfig.cameras,
        this.cameraTargets(),
      );
    this.mount.dataset.karaokeCameraShot = shot.id;
    this.camera.position.set(...shot.position);
    this.camera.fov = shot.fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(...shot.lookAt);
    try { this.renderLayers(); }
    catch (error) { this.failWebGl(error); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tile of this.tiles.values()) this.disposeTile(tile);
    this.tiles.clear();
    this.clearBursts();
    for (const tile of this.fallbackTiles.values()) tile.remove();
    this.fallbackTiles.clear();
    this.resizeObserver?.disconnect();
    if (this.reducedMotionListener) this.reducedMotionQuery?.removeEventListener('change', this.reducedMotionListener);
    for (const role of this.performerAnimations.keys()) this.disposePerformerAnimation(role);
    disposeKaraokeObjectResources(this.scene);
    disposeKaraokeObjectResources(this.highwayScene);
    this.tileGeometry.dispose();
    this.tailGeometry.dispose();
    this.haloGeometry.dispose();
    this.burstGeometry.dispose();
    for (const material of this.tailMaterials) material.dispose();
    this.composer?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = null;
  }

  private createRenderer(): void {
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const context = renderer.getContext();
    const debugRenderer = context.getExtension('WEBGL_debug_renderer_info');
    const rendererName = debugRenderer
      ? String(context.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    this.renderMode = karaokeInitialRenderMode(rendererName, navigator.hardwareConcurrency);
    this.renderModeChangedAtMs = performance.now();
    this.mount.dataset.karaokeRenderMode = this.renderMode;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = this.renderMode === 'full';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute('aria-label', 'Procedural Voice Karaoke concert stage');
    renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.failWebGl(new Error('WebGL context lost'));
    });
    this.mount.append(renderer.domElement);
    this.renderer = renderer;
    if (this.renderMode === 'full') this.createComposer();
    this.resize();
  }

  private createComposer(): void {
    if (!this.renderer || this.composer) return;
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), .58, .38, .72));
    this.composer = composer;
  }

  private failWebGl(error: unknown): void {
    if (!this.webGlUsable) return;
    this.webGlUsable = false;
    console.warn('Voice Karaoke WebGL presentation unavailable; using the DOM fallback.', error);
    this.composer?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.composer = null;
    this.renderer = null;
    this.fallback.hidden = false;
    document.body.classList.add('karaoke-webgl-fallback');
  }

  private applyVenueConfig(): void {
    for (const role of this.venueConfig.models.map(model => model.role)) {
      const procedural = this.proceduralByRole.get(role);
      const installed = this.installedByRole.get(role);
      if (procedural) this.applyRoleTransform(role, procedural);
      if (installed) this.applyRoleTransform(role, installed);
    }
    this.updateDrumAnchor();
    this.applyHighwayTransform();
    this.applyHighwayCamera();
    this.buildLighting();
  }

  private applyRoleTransform(role: KaraokeAssetRole, object: THREE.Object3D): void {
    const authored = karaokeVenueModel(this.venueConfig, role).transform;
    let transform = authored;
    // The procedural stage was modeled in the legacy venue coordinate system. Treat the compiled
    // stage transform as its authored origin so edits still compose without changing that fallback.
    if (role === 'stage' && object === this.proceduralByRole.get('stage')) {
      const base = karaokeVenueModel(DEFAULT_KARAOKE_VENUE, 'stage').transform;
      transform = {
        position: authored.position.map((value, axis) => value - base.position[axis]!) as [number, number, number],
        rotation: authored.rotation.map((value, axis) => value - base.rotation[axis]!) as [number, number, number],
        scale: authored.scale.map((value, axis) => value / base.scale[axis]!) as [number, number, number],
      };
    }
    applyTransform(object, transform);
  }

  private applyHighwayTransform(): void {
    const transform = karaokeResponsiveHighwayTransform(this.camera.aspect, this.venueConfig.highway);
    applyTransform(this.highway, transform);
  }

  private applyHighwayCamera(): void {
    const shot = karaokeStaticCameraShot(this.highwayCamera.aspect, this.venueConfig.cameras);
    this.highwayCamera.position.set(...shot.position);
    this.highwayCamera.fov = shot.fov;
    this.highwayCamera.updateProjectionMatrix();
    this.highwayCamera.lookAt(...shot.lookAt);
  }

  private cameraTargets(): KaraokeCameraTargets {
    this.venue.updateMatrixWorld(true);
    const target = (
      role: Extract<KaraokeAssetRole, 'lead-singer' | 'backup-singer' | 'guitarist'>,
      height: number,
    ): [number, number, number] => {
      const object = this.installedByRole.get(role) ?? this.proceduralByRole.get(role);
      if (!object) {
        const position = karaokeVenueModel(this.venueConfig, role).transform.position;
        return [position[0], position[1] + height, position[2]];
      }
      const position = object.getWorldPosition(new THREE.Vector3());
      return [position.x, position.y + height, position.z];
    };
    return {
      lead: target('lead-singer', 1.22),
      backup: target('backup-singer', 1.22),
      guitarist: target('guitarist', 1.18),
    };
  }

  private renderLayers(): void {
    if (!this.renderer) return;
    if (this.composer && this.renderMode === 'full') this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.highwayScene, this.highwayCamera);
    this.renderer.autoClear = autoClear;
  }

  private sampleFrameTime(nowMs: number, phase: KaraokePhase): void {
    const deltaMs = nowMs - this.lastFrameAtMs;
    this.lastFrameAtMs = nowMs;
    // Ignore a suspended tab or one large decoder stall; respond to sustained frame cost.
    if (deltaMs < 4 || deltaMs > 120) return;
    this.frameMsTotal += deltaMs;
    if (++this.frameSamples < 90) return;
    const next = karaokeAdaptiveRenderMode(
      this.renderMode, this.frameMsTotal / this.frameSamples, nowMs - this.renderModeChangedAtMs,
    );
    this.frameSamples = 0;
    this.frameMsTotal = 0;
    if (next === this.renderMode || !this.renderer) return;
    if (next === 'full' && !karaokeCanInstallOptionalAssets(phase)) return;
    if (next === 'full') {
      try { this.createComposer(); }
      catch (error) {
        console.warn('Karaoke bloom unavailable; keeping the lightweight renderer.', error);
        return;
      }
    } else {
      this.composer?.dispose();
      this.composer = null;
    }
    this.renderMode = next;
    this.renderModeChangedAtMs = nowMs;
    this.renderer.shadowMap.enabled = next === 'full';
    this.renderer.shadowMap.needsUpdate = true;
    this.mount.dataset.karaokeRenderMode = next;
    this.resize();
  }

  private buildVenue(): void {
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x080c18, roughness: .48, metalness: .58 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 24), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -.03, -1);
    floor.receiveShadow = true;
    this.venue.add(floor);

    const fallbackStage = new THREE.Group();
    fallbackStage.name = 'procedural-stage';
    this.venue.add(fallbackStage);
    this.proceduralByRole.set('stage', fallbackStage);

    const stage = new THREE.Mesh(
      new THREE.CylinderGeometry(7.2, 7.65, .65, 48, 1, false, 0, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x191f36, metalness: .72, roughness: .3 }),
    );
    stage.rotation.y = Math.PI / 2;
    stage.position.set(0, .18, -2.85);
    stage.receiveShadow = true;
    fallbackStage.add(stage);

    const backdrop = new THREE.Mesh(
      new THREE.CircleGeometry(4.35, 64),
      new THREE.MeshStandardMaterial({ color: 0x0b2a60, emissive: 0x0b2a60, emissiveIntensity: 1.25, roughness: .3 }),
    );
    backdrop.position.set(0, 3.65, -6.25);
    fallbackStage.add(backdrop);
    const bug = this.buildBugMark();
    bug.position.set(0, 3.65, -6.16);
    bug.scale.setScalar(1.15);
    fallbackStage.add(bug);
    fallbackStage.add(createKaraokeProceduralLedWall());

    const steel = new THREE.MeshStandardMaterial({ color: 0x38425e, metalness: .92, roughness: .24 });
    const beamGeometry = new THREE.CylinderGeometry(.075, .075, 1, 8);
    const beamPieces: THREE.BufferGeometry[] = [];
    const addBeam = (from: THREE.Vector3, to: THREE.Vector3): void => {
      const midpoint = from.clone().add(to).multiplyScalar(.5);
      const rotation = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize(),
      );
      const matrix = new THREE.Matrix4().compose(
        midpoint, rotation, new THREE.Vector3(1, from.distanceTo(to), 1),
      );
      beamPieces.push(beamGeometry.clone().applyMatrix4(matrix));
    };
    for (const side of [-1, 1]) {
      const x = side * 7.15;
      addBeam(new THREE.Vector3(x, .35, -4), new THREE.Vector3(x, 7.2, -4));
      for (let y = .6; y < 7; y += .7) {
        addBeam(new THREE.Vector3(x, y, -4), new THREE.Vector3(x, y + .7, -3.58));
        addBeam(new THREE.Vector3(x, y, -3.58), new THREE.Vector3(x, y + .7, -4));
      }
    }
    addBeam(new THREE.Vector3(-7.15, 7.2, -4), new THREE.Vector3(7.15, 7.2, -4));
    for (let x = -6.8; x < 6.8; x += .9) {
      addBeam(new THREE.Vector3(x, 7.2, -4), new THREE.Vector3(x + .45, 6.78, -4));
      addBeam(new THREE.Vector3(x + .45, 6.78, -4), new THREE.Vector3(x + .9, 7.2, -4));
    }
    beamGeometry.dispose();
    const truss = mergeGeometries(beamPieces, false);
    if (truss) {
      for (const piece of beamPieces) piece.dispose();
      const mesh = new THREE.Mesh(truss, steel);
      mesh.name = 'procedural-stage-truss';
      fallbackStage.add(mesh);
    } else for (const piece of beamPieces) fallbackStage.add(new THREE.Mesh(piece, steel));
    for (const side of [-1, 1]) {
      const stack = new THREE.Group();
      for (let y = .65; y < 3; y += .72) {
        const speaker = new THREE.Mesh(
          new THREE.BoxGeometry(.9, .62, .58),
          new THREE.MeshStandardMaterial({ color: 0x080c18, roughness: .7 }),
        );
        speaker.position.y = y;
        const cone = new THREE.Mesh(new THREE.CircleGeometry(.19, 20), new THREE.MeshBasicMaterial({ color: 0x4d5777 }));
        cone.position.set(0, y, .296);
        stack.add(speaker, cone);
      }
      stack.position.set(side * 6.2, 0, -3.85);
      fallbackStage.add(stack);
    }
  }

  private buildBugMark(): THREE.Group {
    return createKaraokeProceduralLogo();
  }

  private buildCharacter(primary: number, secondary: number): PerformerRig {
    const root = new THREE.Group();
    const suit = new THREE.MeshStandardMaterial({ color: primary, roughness: .5, metalness: .15 });
    const accent = new THREE.MeshStandardMaterial({ color: secondary, roughness: .4, metalness: .35 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xdde0e6, roughness: .72 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(.34, .76, 6, 14), suit);
    torso.position.y = 1.28;
    torso.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(.27, 20, 14), skin);
    head.position.y = 2.08;
    head.castShadow = true;
    const facePieces: THREE.BufferGeometry[] = [
      new THREE.SphereGeometry(.027, 8, 6).translate(-.09, 2.12, .257),
      new THREE.SphereGeometry(.027, 8, 6).translate(.09, 2.12, .257),
      new THREE.BoxGeometry(.11, .019, .013).translate(0, 1.984, .252),
    ];
    const face = mergeGeometries(facePieces, false);
    for (const piece of facePieces) piece.dispose();
    if (face) root.add(new THREE.Mesh(face,
      new THREE.MeshStandardMaterial({ color: 0x191f36, roughness: .8 })));
    const lapelGeometry = new THREE.BufferGeometry();
    lapelGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -.27, 1.59, .285, -.055, 1.53, .357, -.10, 1.27, .347,
      .27, 1.59, .285, .10, 1.27, .347, .055, 1.53, .357,
    ], 3));
    lapelGeometry.computeVertexNormals();
    root.add(new THREE.Mesh(lapelGeometry, new THREE.MeshStandardMaterial({
      color: 0xdde0e6, metalness: .18, roughness: .5, side: THREE.DoubleSide,
    })));
    const hips = new THREE.Mesh(new THREE.SphereGeometry(.31, 16, 10), accent);
    hips.scale.y = .68;
    hips.position.y = .72;
    const leftArm = new THREE.Group();
    const rightArm = new THREE.Group();
    for (const [arm, side] of [[leftArm, -1], [rightArm, 1]] as const) {
      const limb = new THREE.Mesh(new THREE.CapsuleGeometry(.105, .64, 5, 10), suit);
      limb.position.y = -.42;
      arm.position.set(side * .41, 1.65, 0);
      arm.rotation.z = side * .2;
      arm.add(limb);
      root.add(arm);
    }
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(.12, .7, 5, 10), accent);
      leg.position.set(side * .17, .22, 0);
      root.add(leg);
    }
    root.add(torso, hips, head);
    return { root, leftArm, rightArm };
  }

  private buildSinger(
    role: Extract<KaraokeAssetRole, 'lead-singer' | 'backup-singer'>,
    color: number,
    x: number,
    z: number,
    micSide: -1 | 1,
  ): PerformerRig {
    const rig = this.buildCharacter(color, 0x191f36);
    rig.root.position.set(x, .58, z);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(.285, 18, 10, 0, Math.PI * 2, 0, Math.PI * .55), new THREE.MeshStandardMaterial({ color: 0x080c18 }));
    hair.position.y = 2.16;
    rig.root.add(hair);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(.025, .035, 1.85, 10), new THREE.MeshStandardMaterial({ color: 0x9aa0b4, metalness: .9, roughness: .22 }));
    stand.position.set(micSide * .42, .92, .32);
    stand.rotation.z = micSide * -.08;
    const mic = new THREE.Mesh(new THREE.CapsuleGeometry(.065, .13, 6, 10), new THREE.MeshStandardMaterial({ color: 0x232b45, metalness: .72 }));
    mic.position.set(micSide * .49, 1.83, .32);
    mic.rotation.z = micSide * -.08;
    rig.root.add(stand, mic);
    this.venue.add(rig.root);
    this.proceduralByRole.set(role, rig.root);
    return rig;
  }

  private buildDrummer(): PerformerRig {
    const rig = this.buildCharacter(0x2188ef, 0x232b45);
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(.281, 16, 10, 0, Math.PI * 2, 0, Math.PI * .43),
      new THREE.MeshStandardMaterial({ color: 0x181224, roughness: .85 }),
    );
    hair.position.y = 2.19;
    rig.root.add(hair);
    this.drumAnchorRoot.add(rig.root);
    this.proceduralByRole.set('drummer', rig.root);
    return rig;
  }

  private buildDrumKit(): THREE.Group {
    const kit = new THREE.Group();
    kit.name = 'procedural-drum-kit';
    kit.position.set(0, 0, .72);
    const drumMaterial = new THREE.MeshStandardMaterial({ color: 0xef223a, metalness: .48, roughness: .35 });
    const bass = new THREE.Mesh(new THREE.CylinderGeometry(.6, .6, .48, 24), drumMaterial);
    bass.rotation.x = Math.PI / 2;
    bass.position.set(0, .62, 0);
    const bassHead = new THREE.Mesh(new THREE.CircleGeometry(.54, 32),
      new THREE.MeshStandardMaterial({ color: 0xf2f1ed, roughness: .64, side: THREE.DoubleSide }));
    bassHead.position.set(0, .62, .248);
    const bassBadge = new THREE.Mesh(new THREE.RingGeometry(.13, .18, 24),
      new THREE.MeshBasicMaterial({ color: 0xef223a, side: THREE.DoubleSide }));
    bassBadge.position.set(0, .62, .255);
    const snare = new THREE.Mesh(new THREE.CylinderGeometry(.34, .34, .25, 20), new THREE.MeshStandardMaterial({ color: 0xdde0e6, metalness: .65 }));
    snare.position.set(.7, 1.05, -.37);
    const toms = new THREE.InstancedMesh(new THREE.CylinderGeometry(.26, .23, .32, 18), drumMaterial, 2);
    toms.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-.32, 1.28, -.28));
    toms.setMatrixAt(1, new THREE.Matrix4().makeTranslation(.30, 1.28, -.28));
    toms.instanceMatrix.needsUpdate = true;
    const cymbals = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(.48, .48, .035, 28),
      new THREE.MeshStandardMaterial({ color: 0xc8a963, metalness: .82, roughness: .2 }),
      2,
    );
    cymbals.setMatrixAt(0, new THREE.Matrix4().compose(
      new THREE.Vector3(-.85, 1.62, -.6), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, .08)),
      new THREE.Vector3(1, 1, 1),
    ));
    cymbals.setMatrixAt(1, new THREE.Matrix4().compose(
      new THREE.Vector3(.96, 1.56, -.64), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -.08)),
      new THREE.Vector3(.84, 1, .84),
    ));
    cymbals.instanceMatrix.needsUpdate = true;
    kit.add(bass, bassHead, bassBadge, snare, toms, cymbals);
    this.drumAnchorRoot.add(kit);
    return kit;
  }

  private buildGuitarist(): PerformerRig {
    const rig = this.buildCharacter(0x0b2a60, 0x38425e);
    rig.root.position.set(3.45, .58, -1.2);
    rig.root.rotation.y = -.12;
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(.287, 18, 10, 0, Math.PI * 2, 0, Math.PI * .52),
      new THREE.MeshStandardMaterial({ color: 0x512922, roughness: .9 }),
    );
    hair.position.y = 2.16;
    rig.root.add(hair);
    const guitar = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(.38, 20, 14), new THREE.MeshStandardMaterial({ color: 0xef223a, metalness: .55, roughness: .27 }));
    body.scale.set(1, 1.28, .28);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(.12, 1.28, .08), new THREE.MeshStandardMaterial({ color: 0x9aa0b4, roughness: .4 }));
    neck.position.y = .87;
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(.26, .06, .04),
      new THREE.MeshStandardMaterial({ color: 0x191f36, metalness: .3 }));
    bridge.position.set(0, -.19, .12);
    const strings = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-.06, -.19, .148), new THREE.Vector3(-.06, 1.43, .068),
        new THREE.Vector3(-.02, -.19, .148), new THREE.Vector3(-.02, 1.43, .068),
        new THREE.Vector3(.02, -.19, .148), new THREE.Vector3(.02, 1.43, .068),
        new THREE.Vector3(.06, -.19, .148), new THREE.Vector3(.06, 1.43, .068),
      ]),
      new THREE.LineBasicMaterial({ color: 0xf6e7c1 }),
    );
    guitar.add(body, neck, bridge, strings);
    guitar.position.set(.08, 1.1, .35);
    guitar.rotation.z = -.43;
    rig.root.add(guitar);
    this.venue.add(rig.root);
    this.proceduralByRole.set('guitarist', rig.root);
    return rig;
  }

  private buildLighting(): void {
    for (const child of [...this.lightingRig.children]) child.removeFromParent();
    for (const light of this.spotlights) light.dispose();
    for (const beam of this.beams) { beam.geometry.dispose(); beam.material.dispose(); }
    this.spotlights = [];
    this.beams = [];
    const config = this.venueConfig.lighting;
    this.ambient = new THREE.HemisphereLight(
      config.ambient.skyColor, config.ambient.groundColor, config.ambient.intensity,
    );
    this.directional = new THREE.DirectionalLight(config.directional.color, config.directional.intensity);
    this.directional.position.set(...config.directional.position);
    this.lightingRig.add(this.ambient, this.directional);
    for (const spec of config.spotlights) {
      const light = new THREE.SpotLight(
        spec.color,
        spec.intensity,
        spec.distance,
        THREE.MathUtils.degToRad(spec.angleDeg),
        spec.penumbra,
        spec.decay,
      );
      light.name = spec.id;
      light.position.set(...spec.position);
      light.target.position.set(...spec.target);
      if (spec.color.toLowerCase() === '#ffffff') {
        light.castShadow = true;
        light.shadow.mapSize.set(1024, 1024);
      }
      const beam = new THREE.Mesh(
        new THREE.ConeGeometry(1.65, 8, 28, 1, true),
        new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: spec.beamOpacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      beam.name = `${spec.id}-beam`;
      beam.position.set(spec.position[0] * .6, (spec.position[1] + spec.target[1]) * .5, spec.position[2] + 1.2);
      beam.rotation.z = spec.position[0] * -.035;
      this.lightingRig.add(light, light.target, beam);
      this.spotlights.push(light);
      this.beams.push(beam);
    }
  }

  private buildHighway(): void {
    const positions = new Float32Array([-4.35, 0, 6.65, 4.35, 0, 6.65, 2.15, 0, -3.75, -2.15, 0, -3.75]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    const surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x000d25, transparent: true, opacity: .72, side: THREE.DoubleSide }));
    surface.position.y = .065;
    this.highway.add(surface);
    for (let lane = 0; lane <= 4; lane++) {
      const nearX = -4.2 + lane * 2.1;
      const farX = -2.08 + lane * 1.04;
      const lineGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(nearX, .075, 6.55), new THREE.Vector3(farX, .075, -3.65),
      ]);
      this.highway.add(new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color: 0x4d5777, transparent: true, opacity: .6 })));
    }
    for (let lane = 0; lane < 4; lane++) {
      const x = (lane - 1.5) * 2.05;
      const hit = new THREE.Mesh(
        new THREE.BoxGeometry(1.72, .035, .18),
        new THREE.MeshBasicMaterial({ color: LANE_COLORS[lane]!, transparent: true, opacity: .92 }),
      );
      hit.position.set(x, .115, 5.65);
      this.highway.add(hit);
    }
  }

  private animatePerformers(seconds: number, bpm: number, intensity: number): void {
    const beat = seconds * bpm / 60;
    const pulse = Math.max(0, Math.sin(beat * Math.PI * 2)) ** 7;
    this.applyAnimatedPerformer(
      'lead-singer',
      this.lead.root,
      Math.sin(beat * Math.PI) * (.035 + intensity * .045),
      Math.sin(seconds * .62) * (.09 + intensity * .08),
    );
    this.lead.leftArm.rotation.z = -.45 - Math.sin(seconds * 1.6) * .2;
    this.lead.rightArm.rotation.z = .2 + Math.sin(seconds * .9) * .1;
    this.applyAnimatedPerformer(
      'backup-singer',
      this.backup.root,
      Math.sin((beat + .3) * Math.PI) * (.035 + intensity * .045),
      -Math.sin(seconds * .58) * (.09 + intensity * .08),
    );
    this.backup.leftArm.rotation.z = -.2 - Math.sin(seconds * 1.1) * .12;
    this.backup.rightArm.rotation.z = .45 + Math.sin(seconds * 1.5) * .2;
    this.applyAnimatedPerformer('guitarist', this.guitarist.root, Math.sin(beat * Math.PI) * .028, 0);
    this.guitarist.rightArm.rotation.z = .2 + pulse * .72;
    this.guitarist.leftArm.rotation.z = -.35;
    this.drummer.leftArm.rotation.x = -.4 - pulse * 1.4;
    this.drummer.rightArm.rotation.x = -.5 - Math.max(0, Math.sin((beat + .5) * Math.PI * 2)) ** 7 * 1.25;
  }

  private applyAnimatedPerformer(
    role: Extract<KaraokeAssetRole, 'lead-singer' | 'backup-singer' | 'guitarist'>,
    root: THREE.Object3D,
    yDelta: number,
    yawDeltaRadians: number,
  ): void {
    const base = karaokeVenueModel(this.venueConfig, role).transform;
    applyTransform(root, karaokeAnimatedTransform(
      base,
      [0, yDelta, 0],
      [0, THREE.MathUtils.radToDeg(yawDeltaRadians), 0],
    ));
  }

  private animateInstalledPerformers(seconds: number): void {
    this.lastAnimationSeconds = Math.max(0, seconds);
    for (const animation of this.performerAnimations.values()) animation.mixer.setTime(this.lastAnimationSeconds);
  }

  private resolveDrumAnchor(stage: THREE.Object3D | undefined): THREE.Vector3 {
    if (this.venueConfig.drumAnchor.mode === 'manual') {
      return new THREE.Vector3(...this.venueConfig.drumAnchor.manualPosition);
    }
    if (!stage) return new THREE.Vector3(...this.venueConfig.drumAnchor.fallbackPosition);
    const anchor = karaokeDrumAnchor(stage, this.venue);
    if (!anchor) {
      console.warn('Karaoke stage has no finite "batteria" bounds; using the documented drummer fallback anchor.');
      return new THREE.Vector3(...this.venueConfig.drumAnchor.fallbackPosition);
    }
    return anchor;
  }

  private updateDrumAnchor(): void {
    this.drumAnchor = this.resolveDrumAnchor(this.installedByRole.get('stage'));
    const transform = karaokeDrumAnchorTransform(
      this.drumAnchor.toArray(), this.venueConfig.drumAnchor.nodeTransform,
    );
    applyTransform(this.drumAnchorRoot, transform);
    const drummer = this.installedByRole.get('drummer') ?? this.drummer.root;
    this.applyRoleTransform('drummer', drummer);
    this.mount.dataset.karaokeDrumAnchor = this.drumAnchorRoot.position.toArray()
      .map(value => value.toFixed(3)).join(',');
  }

  private disposePerformerAnimation(role: KaraokeAssetRole): void {
    const animation = this.performerAnimations.get(role);
    if (!animation) return;
    animation.mixer.stopAllAction();
    for (const action of animation.actions) action.stop();
    for (const clip of animation.clips) animation.mixer.uncacheClip(clip);
    animation.mixer.uncacheRoot(animation.root);
    this.performerAnimations.delete(role);
  }

  private animateCrowd(seconds: number, intensity: number): void {
    this.crowdBase.forEach((member, index) => {
      const bounce = Math.max(0, Math.sin(seconds * member.speed + member.phase)) * (.025 + intensity * .16);
      const sway = Math.sin(seconds * (member.speed * .43) + member.phase) * (.018 + intensity * .07);
      this.crowdDummy.position.set(member.x, member.y + bounce, member.z);
      this.crowdDummy.rotation.set(0, member.yaw, sway * .4);
      this.crowdDummy.scale.setScalar(member.height);
      this.crowdDummy.updateMatrix();
      this.crowd.heads.setMatrixAt(index, this.crowdDummy.matrix);
      this.crowd.hairs[member.hairStyle].setMatrixAt(member.hairSlot, this.crowdDummy.matrix);
      this.crowd.torsos.setMatrixAt(index, this.crowdDummy.matrix);
      this.crowdDummy.rotation.z = sway + Math.sin(seconds * member.speed * .7 + member.phase) * intensity * .08;
      this.crowdDummy.updateMatrix();
      this.crowd.arms[member.pose].setMatrixAt(member.armSlot, this.crowdDummy.matrix);
    });
    for (const mesh of [this.crowd.heads, ...this.crowd.hairs, this.crowd.torsos, ...this.crowd.arms]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private animateLighting(seconds: number, intensity: number): void {
    this.spotlights.forEach((light, index) => {
      const base = this.venueConfig.lighting.spotlights[index];
      if (!base) return;
      light.intensity = Math.max(0, base.intensity * (.58 + intensity * 1.48)
        + Math.sin(seconds * 1.2 + index) * base.intensity * .14);
      light.target.position.x = base.target[0]
        + Math.sin(seconds * (.22 + index * .025) + index) * (1.2 + intensity * 1.8);
      light.target.position.y = base.target[1];
      light.target.position.z = base.target[2] + Math.cos(seconds * .27 + index) * 1.1;
      this.beams[index]!.material.opacity = Math.min(1, base.beamOpacity * (.7 + intensity * 1.75));
    });
  }

  private updateHighway(frame: KaraokeStageFrame): void {
    const visiblePhase = frame.phase === 'countdown' || frame.phase === 'performing';
    this.highway.visible = visiblePhase && Boolean(frame.song);
    if (!visiblePhase || !frame.song) return;
    const visible = visibleKaraokeWordsAtTime(frame.song.chart, frame.songTimeMs);
    const visibleIds = new Set(visible.map(item => item.word.id));
    for (const item of visible) {
      const tile = this.tileFor(item.word);
      const pose = karaokeHighwayPose(item);
      tile.root.visible = true;
      tile.root.position.set(pose.x, .18, pose.z);
      tile.root.scale.setScalar(pose.scale);
      const tailPose = karaokeSustainTailPose(pose.sustain);
      tile.tail.position.y = tailPose.centerY;
      tile.tail.scale.y = tailPose.scaleY;
      tile.tail.visible = item.word.endMs - item.word.startMs >= 450;
      const judgment = this.judgments.get(item.word.id)?.judgment;
      tile.halo.visible = Boolean(judgment);
      tile.halo.material.color.setHex(judgment === 'perfect' ? 0xffffff : judgment === 'good' ? 0x2188ef : 0x656e87);
      tile.root.rotation.z = judgment === 'miss' && !this.reducedMotion ? Math.sin(frame.serverNowMs * .03) * .025 : 0;
    }
    for (const [wordId, tile] of this.tiles) if (!visibleIds.has(wordId)) tile.root.visible = false;
  }

  private tileFor(word: KaraokeWord): TileVisual {
    const existing = this.tiles.get(word.id);
    if (existing) return existing;
    const texture = this.wordTexture(word);
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    const face = new THREE.Mesh(
      this.tileGeometry,
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    const tail = new THREE.Mesh(
      this.tailGeometry,
      this.tailMaterials[word.lane]!,
    );
    const halo = new THREE.Mesh(
      this.haloGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .5, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    halo.scale.y = .5;
    halo.position.z = .015;
    halo.visible = false;
    root.add(tail, face, halo);
    this.tileLayer.add(root);
    const visual = { root, face, tail, halo, texture };
    this.tiles.set(word.id, visual);
    return visual;
  }

  private wordTexture(word: KaraokeWord): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = KARAOKE_WORD_TEXTURE_WIDTH;
    canvas.height = KARAOKE_WORD_TEXTURE_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable.');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'rgba(0,13,37,.96)';
    context.strokeStyle = LANE_CSS[word.lane];
    context.lineWidth = 7;
    context.beginPath();
    context.roundRect(6, 6, canvas.width - 12, canvas.height - 12, 21);
    context.fill();
    context.stroke();
    context.fillStyle = '#FFFFFF';
    context.font = "700 46px 'Twilio Sans Text', system-ui, sans-serif";
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    let fontSize = 46;
    while (context.measureText(word.text).width > canvas.width - 55 && fontSize > 24) {
      fontSize -= 2;
      context.font = `700 ${fontSize}px 'Twilio Sans Text', system-ui, sans-serif`;
    }
    context.fillText(word.text, canvas.width / 2, canvas.height / 2 + 3);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = Math.min(4, this.renderer?.capabilities.getMaxAnisotropy() ?? 1);
    return texture;
  }

  private addBurst(lane: KaraokeLane, atMs: number, judgment: KaraokeJudgment): void {
    const color = judgment === 'perfect' ? 0xffffff : judgment === 'good' ? LANE_COLORS[lane] : 0x656e87;
    const mesh = new THREE.Mesh(
      this.burstGeometry,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((lane - 1.5) * 2.05, .19, 5.62);
    this.burstLayer.add(mesh);
    this.bursts.push({ mesh, lane, atMs });
  }

  private updateBursts(serverNowMs: number): void {
    for (let index = this.bursts.length - 1; index >= 0; index--) {
      const burst = this.bursts[index]!;
      const age = Math.max(0, serverNowMs - burst.atMs);
      if (age > 720) {
        burst.mesh.material.dispose();
        burst.mesh.removeFromParent();
        this.bursts.splice(index, 1);
        continue;
      }
      const progress = age / 720;
      burst.mesh.scale.setScalar(.7 + progress * 2.8);
      burst.mesh.material.opacity = (1 - progress) * .9;
      burst.mesh.position.x = (burst.lane - 1.5) * 2.05;
    }
  }

  private latestJudgment(serverNowMs: number): { judgment: KaraokeJudgment; ageMs: number } | null {
    let latest: JudgmentEvent | null = null;
    for (const judgment of this.judgments.values()) if (!latest || judgment.atMs > latest.atMs) latest = judgment;
    return latest ? { judgment: latest.judgment, ageMs: Math.max(0, serverNowMs - latest.atMs) } : null;
  }

  private wordById(id: string): KaraokeWord | null {
    return this.currentSong?.chart.words.find(word => word.id === id) ?? null;
  }

  private disposeTile(tile: TileVisual): void {
    tile.texture.dispose();
    tile.face.material.dispose();
    tile.halo.material.dispose();
    tile.root.removeFromParent();
  }

  private clearBursts(): void {
    for (const burst of this.bursts) {
      burst.mesh.material.dispose();
      burst.mesh.removeFromParent();
    }
    this.bursts.splice(0);
  }

  private updateFallbackHighway(frame: KaraokeStageFrame): void {
    const visiblePhase = frame.phase === 'countdown' || frame.phase === 'performing';
    if (!this.fallbackTileLayer || !visiblePhase || !frame.song) {
      for (const tile of this.fallbackTiles.values()) tile.hidden = true;
      return;
    }
    const visible = visibleKaraokeWordsAtTime(frame.song.chart, frame.songTimeMs);
    const visibleIds = new Set(visible.map(item => item.word.id));
    for (const item of visible) {
      let tile = this.fallbackTiles.get(item.word.id);
      if (!tile) {
        tile = this.fallbackTileLayer.ownerDocument.createElement('span');
        tile.className = 'fallback-word';
        tile.textContent = item.word.text;
        tile.style.setProperty('--lane-color', LANE_CSS[item.word.lane]!);
        this.fallbackTileLayer.append(tile);
        this.fallbackTiles.set(item.word.id, tile);
      }
      const projection = karaokeFallbackWordProjection(item);
      tile.hidden = false;
      tile.classList.toggle('active', projection.active);
      tile.style.setProperty('--word-left', `${projection.leftPercent}%`);
      tile.style.setProperty('--word-top', `${projection.topPercent}%`);
      tile.style.setProperty('--word-scale', String(projection.scale));
    }
    for (const [wordId, tile] of this.fallbackTiles) if (!visibleIds.has(wordId)) tile.hidden = true;
  }

  private updateAccessibleLyrics(frame: KaraokeStageFrame): void {
    const visiblePhase = frame.phase === 'countdown' || frame.phase === 'performing';
    const song = frame.song;
    const lyrics = visiblePhase && song ? karaokeLyricsAtTime(song.chart, frame.songTimeMs) : null;
    const current = lyrics?.current ?? null;
    const upcoming = lyrics?.upcoming ?? null;
    if (this.currentLyric && this.currentLyric.textContent !== (current?.text ?? '')) {
      this.currentLyric.textContent = current?.text ?? '';
    }
    if (this.upcomingLyric && this.upcomingLyric.textContent !== (upcoming?.text ?? '')) {
      this.upcomingLyric.textContent = upcoming?.text ?? '';
    }
  }
}

function applyTransform(object: THREE.Object3D, transform: KaraokeTransform): void {
  object.position.set(...transform.position);
  object.rotation.set(...transform.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]);
  object.scale.set(...transform.scale);
  object.updateMatrixWorld(true);
}
