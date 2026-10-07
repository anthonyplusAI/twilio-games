import * as THREE from 'three';
import { TRACK_W, TRACK_LEN, RACE_LEN, LANES, laneX, TRACK_SURFACE_LIFT,
         HOVER_HEIGHT, HOVER_BOB, HOVER_BOB_SPEED, HOVER_SPIN } from '../shared/constants';
import { TRACK_CENTER } from './map-world';
import { CurvedTrack } from './track-path';
import { buildTrackSurface, type SurfaceOpts } from './track-surface';
import { makeSkyDome, setSkyColors } from './sky-dome';
import { frameField } from './field-camera';
import { autoFitScale } from '../shared/asset-fit';
import { stripDisplayBases } from './asset-loader';
import type { WorldSnapshot, Item } from '../shared/types';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { AssetLoader } from './asset-loader';

const RENDER_ASSET_TIMEOUT_MS = 30_000;
const MAX_RENDER_PIXELS = 3_200_000;
// The fallback terrain spans thousands of units. A 0.1 near plane leaves too little depth
// precision for its almost-coplanar road, especially halfway through a three-lap race.
const CAMERA_NEAR = 1;
const FALLBACK_TERRAIN_Y = -0.35;
import { buildCar,buildPlayerMarker } from './car-factory';
import { themeAtZ } from '../shared/zones';
import { shouldCycleZones } from './zone-gate';
import type { LevelLighting, LevelEffects, PlacedProp, GantryOffset, ResolvedCamera } from '../shared/level';
import { DEFAULT_CAMERA } from '../shared/level';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { chaseCameraPose } from './chase-camera';
import { splitScreenViewports, type SplitScreenViewport } from './split-screen';

export interface RendererOptions {
  splitScreen?: boolean;
}

export class Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private splitCameras: [THREE.PerspectiveCamera, THREE.PerspectiveCamera];
  private carMeshes = new Map<string, THREE.Group>();
  private carIndex = new Map<string, number>();
  private nextCarIndex = 0;
  private itemMeshes: { mesh: THREE.Object3D; item: Item }[] = [];
  // Consumable boosts: which item ids were consumed last frame (to detect the visible→gone edge and
  // fire the pickup pop once), and live one-shot pop effects to animate + retire.
  private consumedNow = new Set<number>();
  private pops: { group: THREE.Group; age: number; ttl: number }[] = [];
  private myId: string | null = null;
  private lastFrame = performance.now();
  private clock = 0;   // accumulated seconds, drives the track-emissive pulse
  private sun: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;
  private ground!: THREE.Mesh;         // surrounding terrain (theme-tinted); set in buildWorld()
  private fallbackBermMaterial!: THREE.MeshStandardMaterial;

  constructor(private readonly mount: HTMLElement, private assets?: AssetLoader) {
    const size = this.viewportSize();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(this.pixelRatioFor(size));
    this.renderer.setSize(size.width, size.height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Filmic tone mapping + sRGB output for a far less "flat" look.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.mount.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.fog = new THREE.FogExp2(0x0b1020, 0.0016);   // gentle depth haze, far horizon

    // Image-based lighting: a generated room environment so metal/paint on the GLB
    // cars actually REFLECTS the world (turns flat-plastic look into real material).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(46, size.width / size.height, CAMERA_NEAR, 4000);
    this.splitCameras = [
      new THREE.PerspectiveCamera(46, size.width / Math.max(1, size.height / 2), CAMERA_NEAR, 4000),
      new THREE.PerspectiveCamera(46, size.width / Math.max(1, size.height / 2), CAMERA_NEAR, 4000),
    ];

    // Key light (sun) with a real shadow frustum covering the play area.
    this.sun = new THREE.DirectionalLight(0xfff4e2, 2.1);
    this.sun.position.set(60, 110, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -60; sc.right = 60; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);
    // Sky/ground hemisphere fill gives natural ambient instead of flat grey.
    this.ambient = new THREE.HemisphereLight(0xbfd4ff, 0x202840, 0.7);
    this.scene.add(this.ambient);

    this.buildWorld();

    // Post-processing: bloom makes the sun, boost pads, neon edges, and bright
    // surfaces GLOW — the "AAA sheen" that reads great on a big screen.
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.width, size.height),
      0.45,   // strength — subtle, not blown out
      0.7,    // radius
      0.85,   // threshold — only genuinely bright things bloom
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    addEventListener('resize', () => {
      const next = this.viewportSize();
      this.camera.aspect = next.width / next.height; this.camera.updateProjectionMatrix();
      const pixelRatio = this.pixelRatioFor(next);
      this.renderer.setPixelRatio(pixelRatio);
      this.composer.setPixelRatio(pixelRatio);
      this.renderer.setSize(next.width, next.height);
      this.setComposerSize(next.width, this.splitScreenActive ? Math.ceil(next.height / 2) : next.height);
    });
  }

  private viewportSize(): { width: number; height: number } {
    return {
      width: Math.max(1, this.mount.clientWidth || innerWidth),
      height: Math.max(1, this.mount.clientHeight || innerHeight),
    };
  }

  private pixelRatioFor(size: { width: number; height: number }): number {
    // Large shared displays and high-DPI phones should not silently render millions of extra
    // bloom and shadow pixels. Keep a bounded GPU workload while retaining crisp 1080p output.
    return Math.min(devicePixelRatio || 1, 2,
      Math.sqrt(MAX_RENDER_PIXELS / (size.width * size.height)));
  }

  private composer!: EffectComposer;
  private renderPass!: RenderPass;
  private bloom!: UnrealBloomPass;
  private composerWidth = 0;
  private composerHeight = 0;
  private splitScreenActive = false;
  private splitFovKicks: [number, number] = [0, 0];
  private sky!: THREE.Mesh;            // gradient sky dome; tinted each frame
  private generatedWorld = new THREE.Group();   // our built track (hidden when a map model is used)
  private mapWorld: THREE.Object3D | null = null;
  // The TRACK. `trackGroup` is the transform handle the saved `track` config drives; its ORIGIN
  // sits at the race CENTER (see TRACK_CENTER) so rotation pivots about the middle. The actual
  // cars/items/markings live in `trackContent`, an inner group shifted by -TRACK_CENTER so they
  // keep their normal sim coords (cars drive +Z from z=0) while the parent's pivot is centered.
  // Moving trackGroup moves the whole race together (onto a map's road when one is loaded).
  private trackGroup = new THREE.Group();
  private trackContent = new THREE.Group();
  // Render-only curved path (Option B). When set, cars/items are placed by mapping their straight
  // sim (z, x) onto this curve; null = the classic straight track. The sim never changes.
  private path: CurvedTrack | null = null;
  private surfaceOpts: SurfaceOpts = { laneScale: 1, shoulder: 0 };
  private trackSurface: THREE.Group | null = null;   // the shared 3-lane surface (when a path is set)
  // Per-level look: when a level supplies its own lighting we LOCK it (zones stop cycling) and apply
  // the saved sun/ambient/sky/exposure once. Effects (bloom/fog/glow/sky) + props are visual-only.
  private lightingLocked = false;
  private trackEmissive = 1;
  private pulse = { speed: 0, amount: 0 };
  private sunDir = new THREE.Vector3(-180, 70, -120).normalize();   // golden-hour rake direction
  // Per-level car sizing: the game-side half of the editor's car scale. Keyed by the per-car INDEX
  // (the SAME key the editor writes), so main.ts wires (i) => resolveCarScale(level, String(i)).
  private carScale: (i: number) => number = () => 1;
  // Per-level obstacle/boost size multiplier (applied on top of the manifest's global auto-fit).
  // main.ts wires (kind) => resolveItemScale(level, kind). buildItems re-reads it, so changing it
  // and rebuilding items resizes them live.
  private itemScale: (kind: 'barrier' | 'boost') => number = () => 1;
  // Per-level camera (chase-cam tuning OR a fixed cinematic camera). Defaults to the classic chase
  // numbers so a level without a camera looks exactly as before.
  private cam: ResolvedCamera = { ...DEFAULT_CAMERA };
  private propsGroup = new THREE.Group();     // decoration props live here (added to trackContent)
  private propLoader = (() => {
    const l = new GLTFLoader(); const d = new DRACOLoader();
    d.setDecoderPath('/draco/'); l.setDRACOLoader(d);
    return l;
  })();

  /**
   * Replace the generated track with a loaded track-model "map" (from /maptest layout).
   * Pass null to revert to the generated track. The sky dome stays (backdrop either way).
   */
  setMapWorld(world: THREE.Object3D | null): void {
    if (this.mapWorld === world) {
      this.generatedWorld.visible = world === null && this.path === null;
      return;
    }
    if (this.mapWorld) {
      this.scene.remove(this.mapWorld);
      this.disposeOwnedTree(this.mapWorld);
      this.mapWorld = null;
    }
    if (world) {
      this.mapWorld = world;
      this.scene.add(world);
      this.generatedWorld.visible = false;   // hide our asphalt/curbs/gantry; map is the world
    } else {
      this.generatedWorld.visible = this.path === null;
    }
  }

  /**
   * Set the render-only curved path + its width opts (cars/items follow it visually). Pass null for
   * the classic straight track. Builds the shared 3-lane surface so the game looks like the editor.
   */
  setPath(path: CurvedTrack | null, opts: SurfaceOpts = { laneScale: 1, shoulder: 0 }): void {
    this.path = path;
    this.surfaceOpts = opts;
    this.rebuildSurface();
    // Re-place any already-built items onto the new path (cars re-place every frame in render()).
    for (const { mesh, item } of this.itemMeshes) {
      this.placeItem(mesh, item, (mesh.userData.groundY as number) ?? 0);
    }
    // Re-place the start/finish gantries onto the new curve (each remembers its sim-z).
    for (const wrapper of this.lineGroup.children) {
      this.placeLine(wrapper, (wrapper.userData.lineZ as number) ?? 0);
    }
  }

  /** (Re)build the curved 3-lane surface from the current path + width + track-glow. */
  private rebuildSurface(): void {
    if (this.trackSurface) {
      this.trackContent.remove(this.trackSurface);
      this.disposeOwnedTree(this.trackSurface);
      this.trackSurface = null;
    }
    this.pulseMats = [];
    if (!this.path) {
      this.generatedWorld.visible = this.mapWorld === null;
      return;
    }
    this.generatedWorld.visible = false;   // the curved surface replaces our straight asphalt
    this.trackSurface = buildTrackSurface(this.path, { ...this.surfaceOpts, glow: this.trackEmissive });
    this.trackSurface.traverse(o => {
      (o as THREE.Mesh).receiveShadow = true;
      // Remember each emissive lane material + its base intensity so the pulse modulates from it.
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && m.emissive && m.emissiveIntensity > 0) this.pulseMats.push({ m, base: m.emissiveIntensity });
    });
    this.trackContent.add(this.trackSurface);
  }
  // Emissive lane materials (+ their base intensity) that the pulse modulates each frame.
  private pulseMats: { m: THREE.MeshStandardMaterial; base: number }[] = [];

  /** Animate the track-glow pulse the level authored (effects.pulse). amount 0 = steady (no-op). */
  private applyPulse(): void {
    if (this.pulse.amount <= 0 || this.pulse.speed <= 0 || this.pulseMats.length === 0) return;
    // Sine 0..1; scale each material between base and base*(1+amount).
    const wave = (Math.sin(this.clock * this.pulse.speed * Math.PI * 2) + 1) / 2;
    const factor = 1 + this.pulse.amount * wave;
    for (const { m, base } of this.pulseMats) m.emissiveIntensity = base * factor;
  }

  /** Apply a level's lighting; null reverts to zone-cycling. The sun direction is taken from
   *  sunPos as a DIRECTION (the light is placed far away along it each frame so it rakes the whole
   *  scene), and the shadow frustum is widened to cover the track length so shadows actually land. */
  setLighting(l: LevelLighting | null): void {
    this.lightingLocked = !!l;
    if (!l) return;
    this.sunDir.set(l.sunPos[0]!, l.sunPos[1]!, l.sunPos[2]!).normalize();
    this.sun.intensity = l.sunIntensity;
    this.sun.color.set(l.sunColor);
    this.ambient.intensity = l.ambientIntensity;
    this.ambient.color.set(l.skyColor);
    this.ambient.groundColor.set(l.groundColor);
    this.renderer.toneMappingExposure = l.exposure;
    // Tint only the dome top to the sky color; keep the current bottom (effects own the gradient).
    const curBottom = ((this.sky.material as THREE.ShaderMaterial).uniforms.bottom!.value as THREE.Color);
    setSkyColors(this.sky, l.skyColor, curBottom.clone());
    // A wide shadow frustum so the locked sun casts real ground shadows across the play area.
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -90; sc.right = 90; sc.top = 160; sc.bottom = -160; sc.near = 1; sc.far = 1200;
    sc.updateProjectionMatrix();
  }

  /** Apply a level's effects (bloom/fog/track-glow/sky); null leaves current values. */
  setEffects(e: LevelEffects | null): void {
    if (!e) return;
    this.bloom.strength = e.bloom.strength;
    this.bloom.radius = e.bloom.radius;
    this.bloom.threshold = e.bloom.threshold;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.density = e.fog.density; fog.color.set(e.fog.color);
    this.trackEmissive = e.trackEmissive;
    this.pulse = { ...e.pulse };
    this.rebuildSurface();   // track glow changed → rebuild the lane materials with the new value
    setSkyColors(this.sky, e.skyTop, e.skyBottom);
  }

  /** Load + place decoration props (visual-only) in the track content group. */
  async setProps(props: PlacedProp[]): Promise<void> {
    this.trackContent.remove(this.propsGroup);
    this.disposeOwnedTree(this.propsGroup);
    this.propsGroup = new THREE.Group();
    this.trackContent.add(this.propsGroup);
    const target = this.propsGroup;
    await Promise.all(props.map(p => new Promise<void>(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, RENDER_ASSET_TIMEOUT_MS);
      this.propLoader.load(`/assets/${p.file}`, (gltf) => {
        if (settled || target !== this.propsGroup) { finish(); return; }
        const g = new THREE.Group(); g.add(gltf.scene);
        g.position.set(p.pos[0]!, p.pos[1]!, p.pos[2]!);
        g.rotation.set(p.rotDeg[0]! * Math.PI / 180, p.rotDeg[1]! * Math.PI / 180, p.rotDeg[2]! * Math.PI / 180);
        g.scale.setScalar(p.scale);
        g.userData.propId = p.id;
        target.add(g); finish();
      }, undefined, finish);
    })));
  }

  /** Set the per-car scale multiplier (keyed by car index) the game applies in ensureCar. ALSO
   *  re-applies to cars that already exist — the level (and thus this scale) loads asynchronously on
   *  race start, often AFTER the first snapshot created the car wrappers, so without this re-apply a
   *  car keeps its creation-time scale (the "scale not applied" bug). */
  setCarScale(fn: (i: number) => number): void {
    this.carScale = fn;
    for (const [id, wrapper] of this.carMeshes) {
      const idx = this.carIndex.get(id);
      if(idx!==undefined)this.applyCarScale(wrapper,idx);
    }
  }

  /** Remove ALL car meshes + reset the id→index maps. Called when switching from the attract-mode
   *  demo to a real race so the demo's autopilot cars don't linger frozen on the track, and on the
   *  reverse so a stale race car doesn't haunt the menu backdrop. */
  clearCars(): void {
    for (const [, wrapper] of this.carMeshes) {
      this.disposeCarVisuals(wrapper);
      this.trackContent.remove(wrapper);
    }
    this.carMeshes.clear();
    this.carIndex.clear();
    this.nextCarIndex = 0;
  }
  /** Set the per-level obstacle/boost size multiplier (applied in buildItems on top of auto-fit). */
  setItemScale(fn: (kind: 'barrier' | 'boost') => number): void { this.itemScale = fn; }
  /** Set the per-level camera (chase tuning or a fixed cinematic camera); null reverts to default. */
  setCamera(cam: ResolvedCamera | null): void {
    this.cam = cam ?? { ...DEFAULT_CAMERA };
    this.camera.fov = this.cam.fov; this.camera.updateProjectionMatrix();
    for (const camera of this.splitCameras) {
      camera.fov = this.cam.fov;
      camera.updateProjectionMatrix();
    }
  }

  resetLevelPresentation(): void {
    this.lightingLocked = false;
    this.sunDir.set(-180, 70, -120).normalize();
    this.sun.color.set(0xfff4e2);
    this.sun.intensity = 2.1;
    this.ambient.color.set(0xbfd4ff);
    this.ambient.groundColor.set(0x202840);
    this.ambient.intensity = 0.7;
    const shadowCamera = this.sun.shadow.camera as THREE.OrthographicCamera;
    shadowCamera.left = -60; shadowCamera.right = 60;
    shadowCamera.top = 120; shadowCamera.bottom = -120;
    shadowCamera.near = 1; shadowCamera.far = 400;
    shadowCamera.updateProjectionMatrix();
    this.renderer.toneMappingExposure = 1.15;
    this.bloom.strength = 0.45; this.bloom.radius = 0.7; this.bloom.threshold = 0.85;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.set(0x0b1020); fog.density = 0.0016;
    this.trackEmissive = 1; this.pulse = { speed: 0, amount: 0 };
  }

  getLightingLocked(): boolean { return this.lightingLocked; }

  /** Accessors for the in-game align mode (attach a gizmo to the live map world / track). */
  getMapWorld(): THREE.Object3D | null { return this.mapWorld; }
  getTrackGroup(): THREE.Group { return this.trackGroup; }
  getScene(): THREE.Scene { return this.scene; }
  getCamera(): THREE.PerspectiveCamera { return this.camera; }
  getDomElement(): HTMLCanvasElement { return this.renderer.domElement; }

  /** Build the static world: sky dome, terrain, asphalt track, markings, curbs, start gantry. */
  private buildWorld(): void {
    const startZ = -TRACK_LEN;
    const endZ = RACE_LEN + TRACK_LEN;
    const FULL_LEN = endZ - startZ;          // full race plus approach/runout at both ends
    const midZ = (startZ + endZ) / 2;
    // The track group rides in the scene; its inner content group is shifted by -TRACK_CENTER so
    // the group's ORIGIN (where the gizmo attaches + rotation pivots) sits at the race center,
    // while cars/items/markings inside keep normal sim coords. Moving trackGroup moves it all.
    this.scene.add(this.trackGroup);
    // Outer origin defaults to the race center; inner content shifts back by -TRACK_CENTER. Net:
    // content sits at normal sim coords (cars at z 0..TRACK_LEN) while the pivot is centered. A
    // loaded map overrides trackGroup's transform via applyTrackTransform(getTrackGroup(), ...).
    this.trackGroup.position.set(TRACK_CENTER[0], TRACK_CENTER[1], TRACK_CENTER[2]);
    this.trackContent.position.set(-TRACK_CENTER[0], -TRACK_CENTER[1], -TRACK_CENTER[2]);
    this.trackGroup.add(this.trackContent);
    this.trackContent.add(this.generatedWorld);

    // Big inside-out gradient sky dome (shared with the editor via sky-dome.ts — one source of
    // truth so the game + editor preview can't drift) so the world never reads as a black void.
    this.sky = makeSkyDome();
    this.scene.add(this.sky);

    // Keep the terrain below the road by more than a depth-buffer rounding step. At the
    // far end of the fallback race a 0.05-unit gap could make sand paint over the asphalt.
    // The curbs reach down to this level so the elevated road still has a finished edge.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, FULL_LEN + 4000),
      new THREE.MeshStandardMaterial({ color: 0x3a4a63, roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2; this.ground.position.set(0, FALLBACK_TERRAIN_Y, midZ);
    this.ground.receiveShadow = true; this.generatedWorld.add(this.ground);

    // Asphalt track surface.
    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(TRACK_W, FULL_LEN),
      new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.95, metalness: 0.0 }));
    asphalt.name = 'generated-asphalt';
    asphalt.rotation.x = -Math.PI / 2; asphalt.position.set(0, 0, midZ);
    asphalt.receiveShadow = true; this.generatedWorld.add(asphalt);

    // One instanced draw call replaces hundreds of separate lane-dash meshes. This is especially
    // important for the procedural scene on slow connections, when it is the whole game world.
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xeef2ff, roughness: 0.6 });
    const dashesPerLane = Math.ceil(FULL_LEN / 14);
    const dashes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.4, 6), dashMat,
      (LANES - 1) * dashesPerLane);
    const transform = new THREE.Object3D();
    let dashIndex = 0;
    for (let lane = 1; lane < LANES; lane++) {
      const x = TRACK_W / 2 - (TRACK_W / LANES) * lane;   // divider between lane-1 and lane
      for (let z = startZ; z < endZ; z += 14) {
        transform.position.set(x, 0.025, z);
        transform.rotation.set(-Math.PI / 2, 0, 0);
        transform.updateMatrix();
        dashes.setMatrixAt(dashIndex++, transform.matrix);
      }
    }
    dashes.count = dashIndex;
    dashes.instanceMatrix.needsUpdate = true;
    dashes.computeBoundingSphere();
    this.generatedWorld.add(dashes);

    // Solid edge lines + raised curbs on both sides.
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xeef2ff, roughness: 0.6 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xef223a, roughness: 0.7, emissive: 0x300008 });
    for (const side of [-1, 1]) {
      const ex = side * (TRACK_W / 2 - 0.3);
      const edge = new THREE.Mesh(new THREE.PlaneGeometry(0.5, FULL_LEN), edgeMat);
      edge.rotation.x = -Math.PI / 2; edge.position.set(ex, 0.02, midZ); this.generatedWorld.add(edge);
      const curbTop = 0.5;
      const curb = new THREE.Mesh(new THREE.BoxGeometry(0.8, curbTop - FALLBACK_TERRAIN_Y, FULL_LEN),
        curbMat);
      curb.position.set(side * (TRACK_W / 2 + 0.4), (curbTop + FALLBACK_TERRAIN_Y) / 2, midZ);
      curb.castShadow = true; curb.receiveShadow = true; this.generatedWorld.add(curb);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.24, FULL_LEN),
        new THREE.MeshStandardMaterial({ color: 0x8ca1b2, metalness: 0.72, roughness: 0.36 }));
      rail.position.set(side * (TRACK_W / 2 + 1.16), 0.8, midZ);
      this.generatedWorld.add(rail);
    }

    // Reflective roadside beacons give the offline track scale and rhythm. Instancing keeps the
    // entire repeating set at one draw call instead of adding a mesh for every post.
    const beaconCountPerSide = Math.ceil(FULL_LEN / 35);
    const beacons = new THREE.InstancedMesh(new THREE.BoxGeometry(0.24, 1.18, 0.32),
      new THREE.MeshStandardMaterial({ color: 0x89eaff, emissive: 0x0d718e,
        emissiveIntensity: 0.55, roughness: 0.35 }), beaconCountPerSide * 2);
    let beaconIndex = 0;
    for (const side of [-1, 1]) for (let z = startZ; z < endZ; z += 35) {
      transform.position.set(side * (TRACK_W / 2 + 1.22), 0.65, z);
      transform.rotation.set(0, 0, 0);
      transform.updateMatrix();
      beacons.setMatrixAt(beaconIndex++, transform.matrix);
    }
    beacons.count = beaconIndex;
    beacons.instanceMatrix.needsUpdate = true;
    beacons.computeBoundingSphere();
    this.generatedWorld.add(beacons);

    // A low-poly roadside silhouette gives the complete offline track depth. All berms and
    // broadcast towers share just three instanced draw calls; no remote texture/model is needed.
    this.fallbackBermMaterial = new THREE.MeshStandardMaterial({ color: 0x30324b,
      roughness: 1, flatShading: true });
    const sceneryStations = Math.ceil(FULL_LEN / 75);
    const berms = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0),
      this.fallbackBermMaterial, sceneryStations * 2);
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x263650, metalness: 0.25,
      roughness: 0.72, flatShading: true });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x60d8f5, emissive: 0x1e9ac6,
      emissiveIntensity: 0.9, roughness: 0.38 });
    const towerCount = Math.ceil(FULL_LEN / 120) * 2;
    const towers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), towerMat, towerCount);
    const towerCaps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), capMat, towerCount);
    let bermIndex = 0;
    let towerIndex = 0;
    for (const side of [-1, 1]) {
      for (let z = startZ + 22; z < endZ; z += 75) {
        const rhythm = Math.sin(z * 0.047 + side * 1.7);
        transform.position.set(side * (38 + 11 * Math.abs(rhythm)), 1.4 + 0.6 * rhythm, z);
        transform.rotation.set(0, z * 0.003, 0);
        transform.scale.set(9 + 3 * Math.abs(rhythm), 3.7 + 1.5 * Math.abs(rhythm), 13);
        transform.updateMatrix();
        berms.setMatrixAt(bermIndex++, transform.matrix);
      }
      for (let z = startZ + 45; z < endZ; z += 120) {
        const height = 8 + 12 * Math.abs(Math.sin(z * 0.014 + side));
        const x = side * (73 + 18 * Math.abs(Math.cos(z * 0.019)));
        transform.position.set(x, FALLBACK_TERRAIN_Y + height / 2, z);
        transform.rotation.set(0, 0, 0);
        transform.scale.set(6.2, height, 7.5);
        transform.updateMatrix();
        towers.setMatrixAt(towerIndex, transform.matrix);
        transform.position.y = FALLBACK_TERRAIN_Y + height + 0.45;
        transform.scale.set(6.6, 0.9, 8);
        transform.updateMatrix();
        towerCaps.setMatrixAt(towerIndex++, transform.matrix);
      }
    }
    for (const [instances, count] of [[berms, bermIndex], [towers, towerIndex], [towerCaps, towerIndex]] as const) {
      instances.count = count;
      instances.instanceMatrix.needsUpdate = true;
      instances.computeBoundingSphere();
      this.generatedWorld.add(instances);
    }

    // Start (z=0) and finish (z=RACE_LEN) line MODELS are loaded + placed by
    // setStartFinishLines(), into the lineGroup which rides trackContent — so they follow
    // BOTH the straight track and a curved map path (and any track transform/hills). A
    // lightweight primitive gantry is drawn here as a fallback until/unless the models load.
    this.trackContent.add(this.lineGroup);
    this.buildFallbackGantry(0x10141c, 'start');
    this.buildFallbackGantry(0x10141c, 'finish');
  }

  // ── Start / Finish line models ──────────────────────────────────────────────────────────────
  // Real GLB gantries that ALWAYS bookend the track. Placed in lineGroup (rides trackContent), so
  // they sit on the curve at z=0 / z=RACE_LEN in both straight and curved-map modes.
  private lineGroup = new THREE.Group();
  private lineLoader = (() => {
    const l = new GLTFLoader(); const d = new DRACOLoader();
    d.setDecoderPath('/draco/'); l.setDRACOLoader(d);
    return l;
  })();
  /** Remembered files so setPath() can re-place the gantries onto a freshly-set curve. */
  private lineFiles: { start?: string; finish?: string } = {};
  private lineLoadGeneration = 0;

  /**
   * Load + place the start and finish gantry models so they bookend the track. Each is auto-fit so
   * its widest dimension spans a bit beyond the track, grounded on the surface, and turned to face
   * across the track. Pass either/both files; missing ones keep the primitive fallback gantry.
   */
  async setStartFinishLines(files: { start?: string; finish?: string },
                      offsets: { start?: GantryOffset; finish?: GantryOffset } = {}): Promise<void> {
    const generation = ++this.lineLoadGeneration;
    this.lineFiles = files;
    this.lineOffsets = offsets;
    // clear any previously-built gantries (models + fallback) and rebuild
    for (const line of this.lineGroup.children) this.disposeOwnedTree(line);
    this.lineGroup.clear();
    this.buildFallbackGantry(0x10141c, 'start');
    this.buildFallbackGantry(0x10141c, 'finish');
    if (!files.start && !files.finish) return;
    const loads: Promise<void>[] = [];
    if (files.start) loads.push(this.loadLine(files.start, 0, offsets.start, generation));
    if (files.finish) loads.push(this.loadLine(files.finish, RACE_LEN, offsets.finish, generation));
    await Promise.all(loads);
  }
  private lineOffsets: { start?: GantryOffset; finish?: GantryOffset } = {};

  private loadLine(file: string, z: number, offset: GantryOffset | undefined, generation: number): Promise<void> {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, RENDER_ASSET_TIMEOUT_MS);
      this.lineLoader.load(`/assets/${file}`, (gltf) => {
      if (settled || generation !== this.lineLoadGeneration) {
        this.disposeOwnedTree(gltf.scene);
        finish();
        return;
      }
      const model = gltf.scene;
      stripDisplayBases(model);
      // Auto-fit so the gantry's longest axis spans a little wider than the full track width.
      const target = (TRACK_W * this.surfaceOpts.laneScale) + 2 * this.surfaceOpts.shoulder + 8;
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3(); box.getSize(size);
      const s = autoFitScale([size.x, size.y, size.z], target);
      model.scale.setScalar(s);
      // ground it: recompute, sit min.y on 0, center x/z so the wrapper controls placement
      const box2 = new THREE.Box3().setFromObject(model);
      const c = new THREE.Vector3(); box2.getCenter(c);
      model.position.x += -c.x; model.position.z += -c.z; model.position.y += -box2.min.y;
      model.traverse(o => { (o as THREE.Mesh).castShadow = true; });
      const wrapper = new THREE.Group();
      wrapper.add(model);
      wrapper.userData.lineZ = z;
      if (offset) wrapper.userData.offset = offset;   // author-pinned transform (overrides auto-place)
      const fallbackLabel = z === 0 ? 'start' : 'finish';
      const oldFallback = this.lineGroup.children.find(child => child.userData.fallbackLine === fallbackLabel);
      if (oldFallback) {
        this.lineGroup.remove(oldFallback);
        this.disposeOwnedTree(oldFallback);
      }
      this.lineGroup.add(wrapper);
      this.placeLine(wrapper, z);
      finish();
    }, undefined, finish);
    });
  }

  /** Position one gantry wrapper at sim-z (lane center x=0), onto the curve when a path is set —
   *  UNLESS the level pinned an absolute offset transform, which then wins (matches the editor). */
  private placeLine(wrapper: THREE.Object3D, z: number): void {
    const off = wrapper.userData.offset as GantryOffset | undefined;
    if (off) {
      if (off.pos) wrapper.position.set(off.pos[0]!, off.pos[1]!, off.pos[2]!);
      if (off.rotDeg) wrapper.rotation.set(off.rotDeg[0]! * Math.PI/180, off.rotDeg[1]! * Math.PI/180, off.rotDeg[2]! * Math.PI/180);
      if (off.scale !== undefined) wrapper.scale.setScalar(off.scale);
      return;
    }
    if (this.path) {
      const p = this.path.sample(z, 0);
      wrapper.position.set(p.pos.x, p.pos.y + 0.6, p.pos.z);   // +0.6 = track surface lift (Y_ROAD)
      wrapper.rotation.y = p.headingY;
    } else {
      wrapper.position.set(0, 0, z);
      wrapper.rotation.y = 0;
    }
  }

  /** Branded, legible gantry that remains in place until an optional model actually arrives. */
  private buildFallbackGantry(color: number, label: 'start' | 'finish'): void {
    const z = label === 'start' ? 0 : RACE_LEN;
    const accent = label === 'start' ? 0x26d7c1 : 0xef3151;
    const g = new THREE.Group(); g.userData.lineZ = z; g.userData.fallbackLine = label;
    const postMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 });
    const lightMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent,
      emissiveIntensity: 1.25, roughness: 0.35 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, 12, 1.2), postMat);
      post.position.set(side * (TRACK_W / 2 + 1.5), 6, 0); post.castShadow = true; g.add(post);
      const light = new THREE.Mesh(new THREE.BoxGeometry(0.11, 9.3, 0.08), lightMat);
      light.position.set(side * (TRACK_W / 2 + 1.5), 6.1, 0.65); g.add(light);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W + 6, 2.4, 1.4), postMat);
    beam.position.set(0, 11, 0); beam.castShadow = true; g.add(beam);
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W + 5, 2),
      new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.68,
        side: THREE.DoubleSide }));
    banner.position.set(0, 11, 0.8); g.add(banner);
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W, 0.8), lightMat);
    stripe.rotation.x = -Math.PI / 2; stripe.position.set(0, 0.035, 0); g.add(stripe);
    const topLight = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W + 5, 0.12, 0.18), lightMat);
    topLight.position.set(0, 12.18, 0.78); g.add(topLight);
    this.lineGroup.add(g);
    this.placeLine(g, z);
  }

  private spectator = false;
  setMyId(id: string) { this.myId = id; }
  /** The local player's id, or null on a pure spectator/shared display (empty string counts as none).
   *  The personal HUD keys off this so it never shows for a screen that isn't a single player. */
  myPlayerId(): string | null { return this.spectator ? null : (this.myId || null); }
  setSpectator(on: boolean) { this.spectator = on; }

  private buildFallbackBarrier(): THREE.Group {
    const group = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x253243, metalness: 0.55, roughness: 0.42 });
    const warning = new THREE.MeshStandardMaterial({ color: 0xffa62e, emissive: 0x8b3105,
      emissiveIntensity: 0.45, roughness: 0.48 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W / LANES - 1.5, 1.25, 0.75), steel);
    group.add(body);
    for (const x of [-1.7, -0.6, 0.6, 1.7]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.9, 0.08), warning);
      stripe.position.set(x, 0.03, 0.42);
      stripe.rotation.z = -0.35;
      group.add(stripe);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W / LANES - 1.35, 0.13, 0.87), warning);
    top.position.y = 0.69;
    group.add(top);
    return group;
  }

  private buildFallbackBoost(): THREE.Group {
    const group = new THREE.Group();
    const glow = new THREE.MeshStandardMaterial({ color: 0x5dffe2, emissive: 0x10c9a1,
      emissiveIntensity: 1.35, metalness: 0.2, roughness: 0.22 });
    const shell = new THREE.MeshStandardMaterial({ color: 0x214e63, metalness: 0.65, roughness: 0.26 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.14, 8, 24), glow);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.57, 1), shell);
    core.position.y = 0.25;
    group.add(core);
    const jewel = new THREE.Mesh(new THREE.IcosahedronGeometry(0.33, 1), glow);
    jewel.position.y = 0.25;
    group.add(jewel);
    return group;
  }

  buildItems(items: Item[]) {
    this.consumedNow.clear();   // fresh race: no orb is mid-pickup
    for (const { mesh } of this.itemMeshes) {
      this.trackContent.remove(mesh);
      this.disposeClonedSkeletons(mesh);
      const procedural = mesh.userData.proceduralModel as THREE.Object3D | undefined;
      if (procedural) this.disposeOwnedTree(procedural);
    }
    this.itemMeshes = items.map(item => {
      // NOTE: keep in sync with the editor preview (level-scene.ts) placement: world/lane position
      // goes on an OUTER wrapper group; the inner model keeps its baked grounding (-min.y) + offset
      // from AssetLoader.normalize so manifest offset survives and models sit on y=0.
      let model: THREE.Object3D;
      let usingTemplate: boolean;
      if (item.kind === 'barrier') {
        const template = this.assets?.barrierTemplate() ?? null;
        usingTemplate = !!template;
        model = template
          ? skeletonClone(template)
          : this.buildFallbackBarrier();
      } else {
        const template = this.assets?.boostTemplate() ?? null;
        usingTemplate = !!template;
        model = template
          ? skeletonClone(template)
          : this.buildFallbackBoost();
      }
      // Per-level size multiplier on an INNER group (keeps the model's baked grounding/offset),
      // so resizing scales the obstacle in place without lifting/sinking it off the track.
      const scaled = new THREE.Group();
      scaled.add(model);
      scaled.scale.setScalar(this.itemScale(item.kind));
      const mesh = new THREE.Group();
      mesh.add(scaled);
      if (!usingTemplate) mesh.userData.proceduralModel = model;
      // A real boost MODEL hovers above the track (bob + spin animated in render()); the barrier and
      // any primitive fallback stay grounded. Tag the hovering ones + remember their hover height.
      const hover = item.kind === 'boost';
      if (hover) { mesh.userData.hover = true; scaled.userData.hoverBaseY = HOVER_HEIGHT; }
      // Real models self-ground via baked -min.y, so wrapper y=0. Primitives have no baked
      // grounding (box centered, pad thin), so keep their original y (0.8 / 0.13).
      const y = usingTemplate ? 0 : (item.kind === 'barrier' ? 0.625 : 0.13);
      this.placeItem(mesh, item, y);
      mesh.userData.groundY = y;     // remembered so setPath() can re-place onto the curve
      this.trackContent.add(mesh);   // ride the track transform so items align with the race line
      return { mesh, item };
    });
  }

  /** Position one item mesh: straight sim coords, or mapped onto the curve when a path is set. */
  private placeItem(mesh: THREE.Object3D, item: Item, y: number): void {
    if (this.path) {
      // Scale the lane offset by laneScale so items sit in the (possibly widened) lanes, and lift
      // onto the track surface (Y_ROAD ≈ 0.6).
      const p = this.path.sample(item.z, laneX(item.lane) * this.surfaceOpts.laneScale);
      mesh.position.set(p.pos.x, p.pos.y + y + 0.6, p.pos.z);   // p.pos.y carries the track height
      mesh.rotation.y = p.headingY;
    } else {
      mesh.position.set(laneX(item.lane), y, item.z);
      mesh.rotation.y = 0;
    }
  }

  /**
   * Hide/show boost orbs per the sim's consumed list, and fire a one-shot pickup POP on the
   * visible→consumed edge (so it plays exactly once when a player grabs the orb). Reappears (mesh
   * shown again) when the sim respawns it ~0.5s later.
   */
  private applyConsumed(consumedItems: number[]): void {
    const consumed = new Set(consumedItems);
    for (const { mesh, item } of this.itemMeshes) {
      if (item.kind !== 'boost') continue;
      const isGone = consumed.has(item.id);
      const wasGone = this.consumedNow.has(item.id);
      if (isGone && !wasGone) {
        // pop where the orb VISUALLY was — its placed pos plus the hover float height.
        const at = mesh.position.clone();
        if (mesh.userData.hover) at.y += HOVER_HEIGHT;
        this.spawnPop(at);
      }
      mesh.visible = !isGone;
    }
    this.consumedNow = consumed;
  }

  /** Spawn a small, quick "collected!" sparkle at a world position: a thin ring that gently expands
   *  and fades, plus a brief soft flash. Tuned to be subtle, not a big shockwave. */
  private spawnPop(at: THREE.Vector3): void {
    const group = new THREE.Group();
    group.position.copy(at);
    const mat = (c: number, o: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true,
      opacity: o, depthWrite: false, blending: THREE.AdditiveBlending });
    // Thin ring (0.15 wide), starts roughly orb-sized; expands only modestly in updatePops.
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.0, 28), mat(0x7afcff, 0.85));
    ring.rotation.x = -Math.PI / 2;   // lie flat-ish; faces up
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), mat(0xcceeff, 0.7));
    group.add(ring, flash);
    this.trackContent.add(group);
    this.pops.push({ group, age: 0, ttl: 0.35 });   // short-lived
  }

  /** Advance + retire pickup sparkles: ring expands a little and fades; flash shrinks and fades. */
  private updatePops(dt: number): void {
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i]!;
      p.age += dt;
      const f = p.age / p.ttl;        // 0..1
      if (f >= 1) {
        this.trackContent.remove(p.group);
        p.group.traverse(o => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; m?.dispose(); (o as THREE.Mesh).geometry?.dispose(); });
        this.pops.splice(i, 1);
        continue;
      }
      const ease = 1 - (1 - f) * (1 - f);   // ease-out: quick then settles
      const ring = p.group.children[0] as THREE.Mesh;
      const flash = p.group.children[1] as THREE.Mesh;
      ring.scale.setScalar(1 + ease * 1.4);                       // modest expansion (was up to 7×)
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - f);
      flash.scale.setScalar(Math.max(0.01, 1 - ease));            // flash blinks out
      (flash.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - f * 1.6);
      p.group.position.y += dt * 1.2;   // gentle upward drift
    }
  }

  private ensureCar(id: string, color: string, carIndex?: number,playerNumber=1): THREE.Group {
    let wrapper = this.carMeshes.get(id);
    if (!wrapper) {
      // Prefer the player's CHOSEN car model (carIndex from the snapshot, set in car-select); fall
      // back to round-robin join order only when no choice was made (legacy / direct-join races).
      let idx = this.carIndex.get(id);
      if (idx === undefined) {
        idx = carIndex ?? this.nextCarIndex++;
        this.carIndex.set(id, idx);
      }
      const template = this.assets?.carTemplate(idx) ?? null;
      // NOTE: keep in sync with the editor preview (level-scene.ts). buildCar returns a model that may
      // carry baked grounding/offset on its own .position (template path) or be self-grounded
      // (primitive body at y=0.75). Wrap it so we set world position on the OUTER group and
      // never clobber the inner model's grounding. mixer/wheels live on the inner model.
      const model = buildCar(template, color, id === this.myId);
      model.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
      wrapper = new THREE.Group();
      const scaledModel=new THREE.Group();scaledModel.add(model);
      wrapper.add(scaledModel);
      wrapper.userData.model=model;wrapper.userData.scaledModel=scaledModel;
      const marker=buildPlayerMarker(color,playerNumber);
      wrapper.add(marker);wrapper.userData.playerMarker=marker;this.applyCarScale(wrapper,idx);
      this.trackContent.add(wrapper); this.carMeshes.set(id, wrapper);   // cars ride the track transform
    } else {
      const current = wrapper.userData.model as THREE.Group | undefined;
      const index = this.carIndex.get(id);
      const template = index === undefined ? null : this.assets?.carTemplate(index) ?? null;
      if (current?.userData.fallbackCar && template) {
        // A procedural car may have been shown immediately while its GLB streamed in. Upgrade the
        // existing wrapper in place so slow connections never pin a racer to its fallback forever.
        const actual = buildCar(template, color, id === this.myId);
        actual.traverse(o => { const mesh = o as THREE.Mesh; if (mesh.isMesh) mesh.castShadow = true; });
        const scaledModel = wrapper.userData.scaledModel as THREE.Group;
        scaledModel.remove(current);
        this.disposeOwnedTree(current);
        scaledModel.add(actual);
        wrapper.userData.model = actual;
        this.applyCarScale(wrapper, index!);
      }
    }
    return wrapper;
  }

  private disposeOwnedTree(root: THREE.Object3D): void {
    this.disposeClonedSkeletons(root);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const instances = new Set<THREE.InstancedMesh>();
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) instances.add(mesh as THREE.InstancedMesh);
      if (mesh.geometry) geometries.add(mesh.geometry);
      const assigned = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of assigned) if (material) materials.add(material);
    });
    // GLTF EXT_mesh_gpu_instancing keeps a per-instance matrix GPU buffer. Geometry/material
    // disposal alone does not release it when a loaded map is replaced after a race.
    for (const instance of instances) instance.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
    for (const texture of textures) texture.dispose();
  }

  private disposeClonedSkeletons(root: THREE.Object3D): void {
    const skeletons = new Set<THREE.Skeleton>();
    root.traverse(object => {
      const skin = object as THREE.SkinnedMesh;
      if (skin.isSkinnedMesh && skin.skeleton) skeletons.add(skin.skeleton);
    });
    for (const skeleton of skeletons) skeleton.dispose();
  }

  private disposeCarVisuals(wrapper: THREE.Group): void {
    const model = wrapper.userData.model as THREE.Object3D | undefined;
    if (model?.userData.fallbackCar) this.disposeOwnedTree(model);
    else if (model) this.disposeClonedSkeletons(model);
    const marker = wrapper.userData.playerMarker as THREE.Object3D | undefined;
    if (marker) this.disposeOwnedTree(marker);
    const aura = wrapper.userData.dashAura as THREE.Object3D | undefined;
    if (aura) this.disposeOwnedTree(aura);
  }

  private applyCarScale(wrapper:THREE.Group,index:number):void {
    const scaledModel=wrapper.userData.scaledModel as THREE.Group|undefined;
    if(!scaledModel)return;
    scaledModel.scale.setScalar(this.carScale(index));scaledModel.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(scaledModel);
    const marker=wrapper.userData.playerMarker as THREE.Group|undefined;
    if(!marker)return;
    const markerY=Number.isFinite(bounds.max.y)?Math.max(3.4,bounds.max.y+1.25):4;
    marker.position.y=markerY;marker.userData.baseY=markerY;
  }

  /** Show/hide + animate a car's NITRO-DASH aura. Built lazily the first time a car dashes: a flat
   *  flame-orange glow ring under the car + a pair of trailing speed-line planes. This is the VISUAL
   *  that makes POWER read as a distinct, invulnerable dash (not just "going faster" like boost). */
  private updateDashFx(wrapper: THREE.Group, dashing: boolean, dt: number): void {
    let aura = wrapper.userData.dashAura as THREE.Group | undefined;
    if (!aura) {
      if (!dashing) return;                       // don't build until first needed
      aura = new THREE.Group();
      // Glow ring hugging the ground under the car.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.3, 2.4, 28),
        new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.75,
          side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.15;
      aura.add(ring);
      // Two trailing speed-line planes streaming back from the car (additive → they glow).
      const streak = new THREE.Mesh(
        new THREE.PlaneGeometry(2.2, 5.5),
        new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.45,
          blending: THREE.AdditiveBlending, depthWrite: false }));
      streak.rotation.x = -Math.PI / 2; streak.position.set(0, 0.2, -3.2);
      aura.add(streak);
      wrapper.add(aura);
      wrapper.userData.dashAura = aura;
    }
    // Fade the aura in while dashing, out when not (so it doesn't pop). Pulse the ring for energy.
    const target = dashing ? 1 : 0;
    const cur = (wrapper.userData.dashFade as number | undefined) ?? 0;
    const next = cur + (target - cur) * Math.min(1, dt * 10);
    wrapper.userData.dashFade = next;
    aura.visible = next > 0.02;
    const pulse = 0.75 + 0.25 * Math.sin(this.clock * 18);
    const ring = aura.children[0] as THREE.Mesh;
    const streak = aura.children[1] as THREE.Mesh;
    (ring.material as THREE.MeshBasicMaterial).opacity = next * pulse;
    ring.scale.setScalar(0.9 + 0.15 * pulse);
    (streak.material as THREE.MeshBasicMaterial).opacity = next * 0.5;
  }

  render(snap: WorldSnapshot, options: RendererOptions = {}) {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.clock += dt;
    this.applyPulse();

    const liveCarIds = new Set(snap.cars.map(car => car.id));
    for (const [id, wrapper] of this.carMeshes) {
      if (liveCarIds.has(id)) continue;
      this.disposeCarVisuals(wrapper);
      this.trackContent.remove(wrapper);
      this.carMeshes.delete(id);
      this.carIndex.delete(id);
    }

    for (const [carPosition,c] of snap.cars.entries()) {
      const wrapper = this.ensureCar(c.id, c.color, c.carIndex,carPosition+1);
      if (this.path) {
        // Map straight sim (z=distance, x=lane offset) onto the curve. Scale x by laneScale so cars
        // stay centered in widened lanes, and lift onto the track surface.
        const p = this.path.sample(c.z, c.x * this.surfaceOpts.laneScale);
        wrapper.position.set(p.pos.x, p.pos.y + TRACK_SURFACE_LIFT, p.pos.z);   // sit on the road ribbon
        // Orient along the track AND tip with the slope: yaw (Y) then pitch about the car's local
        // lateral axis, via Euler order 'YXZ' so a hill never rolls the car sideways. rotation.x is
        // -pitch because tipping the nose UP (+Z forward → +Y) is a negative X rotation in three.js.
        wrapper.rotation.set(-p.pitch, p.headingY, 0, 'YXZ');
      } else {
        wrapper.position.set(c.x, 0, c.z);
      }
      // Dash FX: while a POWER dash is active, the car is invulnerable — show a bold NITRO look
      // (flame-orange glow ring + speed-lines) that's unmistakably different from a plain boost.
      this.updateDashFx(wrapper, c.invulnerable, dt);
      const marker=wrapper.userData.playerMarker as THREE.Group|undefined;
      if(marker)marker.position.y=(marker.userData.baseY as number)+Math.sin(this.clock*4+carPosition*Math.PI)*0.18;
      // Animation lives on the inner model (mixer/wheels set by buildCar).
      const model = wrapper.userData.model as THREE.Object3D;
      // Animation priority: baked clip (mixer) > wheel-spin > static.
      const mixer = model.userData.mixer as THREE.AnimationMixer | undefined;
      if (mixer) {
        mixer.update(dt);
      } else {
        const wheels = model.userData.wheels as THREE.Object3D[] | undefined;
        if (wheels && wheels.length) {
          for (const w of wheels) w.rotation.x += dt * 14;
        }
      }
    }
    // Consumed boosts: hide the ones the sim marks picked-up, and on the visible→gone EDGE spawn a
    // pickup pop where the orb was. They reappear (shown again) when the sim respawns them.
    this.applyConsumed(snap.consumedItems);
    // Hovering boost orbs: bob up/down around HOVER_HEIGHT and spin, so they read as floating
    // power-ups rather than sitting on the asphalt. Only meshes tagged hover + still visible.
    for (const { mesh } of this.itemMeshes) {
      if (!mesh.userData.hover || !mesh.visible) continue;
      const scaled = mesh.children[0] as THREE.Object3D | undefined;
      if (!scaled) continue;
      const base = (scaled.userData.hoverBaseY as number) ?? HOVER_HEIGHT;
      scaled.position.y = base + Math.sin(this.clock * HOVER_BOB_SPEED * Math.PI * 2) * HOVER_BOB;
      scaled.rotation.y += dt * HOVER_SPIN;
    }
    this.updatePops(dt);
    const size = this.viewportSize();
    const splitViews = options.splitScreen ? splitScreenViewports(snap.cars, size.width, size.height) : [];
    if (splitViews.length === 2) {
      this.renderSplitScreen(snap, splitViews as [SplitScreenViewport, SplitScreenViewport], dt, size);
      return;
    }
    this.splitScreenActive = false;
    this.setComposerSize(size.width, size.height);
    // Camera focus. The shared DISPLAY frames the whole FIELD (every player is on one screen, so we
    // can't chase the leader — that pushes the back of the pack off-screen). A solo keyboard player
    // (own myId, not the spectator display) still follows their own car.
    const fieldMode = this.spectator || !this.myId;
    let focus: typeof snap.cars[number] | undefined;
    if (fieldMode) {
      // `z` for zone/sun = field CENTER (mid of clamped pack), so atmosphere tracks the action.
      focus = snap.cars.length
        ? snap.cars.reduce((a, b) => (b.z > a.z ? b : a))   // leader, only used as a fallback ref
        : undefined;
    } else {
      focus = snap.cars.find(c => c.id === this.myId) ?? snap.cars[0];
    }
    const me = focus;
    // z drives zone-cycling + sun aim. In field mode use the pack center; solo uses the own car.
    let z = me ? me.z : 0;
    if (fieldMode && snap.cars.length) {
      let front = -Infinity, back = Infinity;
      for (const c of snap.cars) { if (c.z > front) front = c.z; if (c.z < back) back = c.z; }
      z = (front + back) / 2;
    }

    this.applyEnvironment(z);

    const mx = me ? me.x : 0;
    if (this.cam.mode === 'fixed' && this.cam.pos && this.cam.lookAt) {
      // FIXED cinematic camera: a static eye/look in sim-world space, mapped onto the curve when a
      // path is set (so "z" reads as track distance), else used as raw world coords. The race plays
      // from this viewpoint — cars drive through frame.
      const px = this.cam.pos[0]!, py = this.cam.pos[1]!, pz = this.cam.pos[2]!;
      const lx = this.cam.lookAt[0]!, ly = this.cam.lookAt[1]!, lz = this.cam.lookAt[2]!;
      if (this.path) {
        const eye = this.path.sample(pz, px);
        const look = this.path.sample(lz, lx);
        this.camera.position.set(eye.pos.x, eye.pos.y + py, eye.pos.z);
        this.camera.lookAt(look.pos.x, look.pos.y + ly, look.pos.z);
      } else {
        this.camera.position.set(px, py, pz);
        this.camera.lookAt(lx, ly, lz);
      }
    } else if (fieldMode) {
      // FIELD cam: frame the whole pack (sim-space eye/look from frameField), pulling back + rising
      // as the field spreads so every player stays visible. Offsets come from the level chase params.
      const { behind, height, lookAhead, lookHeight, lateral } = this.cam;
      const f = frameField(snap.cars, { behind, height, lookAhead, lookHeight, lateral });
      if (this.path) {
        const eye = this.path.sample(f.eyeZ, f.eyeX);
        const look = this.path.sample(f.lookZ, f.lookX);
        this.camera.position.set(eye.pos.x, eye.pos.y + f.eyeY, eye.pos.z);
        this.camera.lookAt(look.pos.x, look.pos.y + f.lookY, look.pos.z);
      } else {
        this.camera.position.set(f.eyeX, f.eyeY, f.eyeZ);
        this.camera.lookAt(f.lookX, f.lookY, f.lookZ);
      }
    } else {
      // SOLO CHASE cam: follow my own car. behind + above + slightly lateral, looking down-track.
      // Offsets come from the level (default = the classic 24 back / 9 up / 45 ahead / 10 lateral /
      // 2.2 look-height), so a level with no camera renders exactly as before.
      this.applyChaseCamera(this.camera, { x: mx, z });
    }
    // NITRO-DASH FOV KICK: when the focused car is dashing, punch the FOV out a few degrees for a
    // "whoosh" sense of speed, then ease back. Purely cosmetic; distinguishes the dash from boost.
    const dashKickTarget = focus?.invulnerable ? 7 : 0;
    this.fovKick += (dashKickTarget - this.fovKick) * Math.min(1, dt * 8);
    const wantFov = this.cam.fov + this.fovKick;
    if (Math.abs(this.camera.fov - wantFov) > 0.05) {
      this.camera.fov = wantFov; this.camera.updateProjectionMatrix();
    }
    // Sky dome rides with the camera so the horizon is always far away.
    this.sky.position.copy(this.camera.position);
    this.composer.render();
  }
  private fovKick = 0;   // current extra FOV degrees from an active dash (eased)

  private setComposerSize(width: number, height: number): void {
    if (this.composerWidth === width && this.composerHeight === height) return;
    this.composerWidth = width;
    this.composerHeight = height;
    this.composer.setSize(width, height);
  }

  private applyEnvironment(z: number): void {
    if (shouldCycleZones(this.lightingLocked)) {
      const theme = themeAtZ(z);
      const fog = this.scene.fog as THREE.FogExp2;
      fog.color.set(theme.fog);
      (this.ground.material as THREE.MeshStandardMaterial).color.set(theme.ground);
      this.fallbackBermMaterial.color.set(theme.ground).multiplyScalar(0.66);
      this.sun.color.set(theme.sun); this.sun.intensity = Math.max(1.4, theme.sunIntensity * 1.6);
      this.ambient.color.set(theme.sky);
      this.ambient.groundColor.set(theme.ground);
      setSkyColors(this.sky, theme.sky, theme.fog);
    }
    const target = new THREE.Vector3(0, 0, z + 20);
    this.sun.target.position.copy(target); this.sun.target.updateMatrixWorld();
    this.sun.position.copy(target).addScaledVector(this.sunDir, 260);
  }

  private applyChaseCamera(camera: THREE.PerspectiveCamera, car: { x: number; z: number }): void {
    const pose = chaseCameraPose(car, this.cam, this.path ?? undefined);
    camera.position.set(pose.eye.x, pose.eye.y, pose.eye.z);
    camera.lookAt(pose.look.x, pose.look.y, pose.look.z);
  }

  private renderSplitScreen(
    snap: WorldSnapshot,
    views: [SplitScreenViewport, SplitScreenViewport],
    dt: number,
    size: { width: number; height: number },
  ): void {
    this.splitScreenActive = true;
    this.setComposerSize(size.width, Math.ceil(size.height / 2));
    const fieldCenter = (Math.max(...snap.cars.map(car => car.z)) + Math.min(...snap.cars.map(car => car.z))) / 2;
    this.applyEnvironment(fieldCenter);
    this.renderer.setScissorTest(true);
    try {
      for (const index of [0, 1] as const) {
        const view = views[index];
        const camera = this.splitCameras[index];
        camera.aspect = view.width / view.height;
        this.applyChaseCamera(camera, view.car);
        const dashTarget = view.car.invulnerable ? 7 : 0;
        this.splitFovKicks[index] += (dashTarget - this.splitFovKicks[index]) * Math.min(1, dt * 8);
        camera.fov = this.cam.fov + this.splitFovKicks[index];
        camera.updateProjectionMatrix();
        this.sky.position.copy(camera.position);
        this.renderPass.camera = camera;
        this.renderer.setViewport(view.x, view.glY, view.width, view.height);
        this.renderer.setScissor(view.x, view.glY, view.width, view.height);
        this.composer.render();
      }
    } finally {
      this.renderPass.camera = this.camera;
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, size.width, size.height);
    }
  }
}
