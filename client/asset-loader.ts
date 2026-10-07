import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { isWheelNode, isDisplayBaseNode, groundPlaneIndices, CAR_TARGET, BARRIER_TARGET, BOOST_TARGET } from '../shared/asset-fit';
import type { MeshSize } from '../shared/asset-fit';
import { parseManifest } from '../shared/asset-manifest';
import type { Manifest, AssetRef } from '../shared/asset-manifest';
import { applyModelTransform } from './model-transform';

const RACER_ASSET_TIMEOUT_MS = 45_000;
const MAX_CONCURRENT_ASSET_LOADS = 4;
type AssetLoadState = 'idle' | 'loading' | 'ready' | 'failed';

/** Count mesh descendants of an object (including itself). */
function meshCount(o: THREE.Object3D): number {
  let n = 0; o.traverse((c) => { if ((c as THREE.Mesh).isMesh) n++; }); return n;
}

function visibleGeometryBounds(root: THREE.Object3D): { count: number; bounds: THREE.Box3 } {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  let count = 0;
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (mesh.geometry?.getAttribute('position')?.count ?? 0) < 3) return;
    for (let current: THREE.Object3D | null = mesh; current; current = current.parent) if (!current.visible) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    if (materials.length === 0 || materials.every(material => !material.visible)) return;
    bounds.union(new THREE.Box3().setFromObject(mesh));
    count += 1;
  });
  return { count, bounds };
}

function disposeUninstalledScene(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material) materials.add(material);
    }
    const skin = mesh as THREE.SkinnedMesh;
    if (skin.isSkinnedMesh && skin.skeleton) skeletons.add(skin.skeleton);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}

/**
 * Remove showroom display props (bases, floors, turntable discs, photo backdrops) from a
 * loaded GLB so only the actual vehicle remains. Shared by the game loader and the editor
 * so both see identical geometry. Collects matches first, then detaches (mutating during
 * traverse is unsafe).
 *
 * STRUCTURAL GUARD: a real showroom prop is a SMALL leaf (a single flat plane/disc/dome), whereas
 * car parts that happen to be named "Circle"/"Sphere"/"Base" (e.g. wheels named Circle_NNN that
 * PARENT the rim/tire meshes, or a body named BaseCar) hold many meshes. So we only strip a
 * name-matched node when it carries at most 1 mesh — this protects wheel groups + bodies that
 * earlier over-eager name rules were deleting (McLaren wheels, climber body).
 */
export function stripDisplayBases(root: THREE.Object3D): void {
  const remove: THREE.Object3D[] = [];
  root.traverse(o => {
    if (o === root || !o.name || !isDisplayBaseNode(o.name)) return;
    if (meshCount(o) > 1) return;   // a multi-mesh group is real geometry, not a flat prop
    remove.push(o);
  });
  for (const o of remove) o.parent?.remove(o);
  stripGroundPlanes(root);
}

/**
 * Remove giant flat "environment" meshes (embedded floors/tracks/stadiums) that name-based
 * stripping can't catch because they're named generically (e.g. the Squadra Lamborghini ships a
 * whole oval circuit as Object_99…). Uses size, not name: measures each MESH's local bbox and drops
 * the flat huge outliers (see groundPlaneIndices). Conservative — does nothing unless there's a
 * clear small-vehicle-vs-huge-ground split.
 */
export function stripGroundPlanes(root: THREE.Object3D): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  if (meshes.length < 3) return;
  const box = new THREE.Box3(); const size = new THREE.Vector3();
  const sizes: MeshSize[] = meshes.map(m => {
    box.setFromObject(m); box.getSize(size);
    return { w: size.x, h: size.y, d: size.z };
  });
  for (const i of groundPlaneIndices(sizes)) meshes[i]!.parent?.remove(meshes[i]!);
}

export class AssetLoader {
  private loader: GLTFLoader;
  private manifest: Manifest = { cars: [], barrier: null, boostPad: null, props: [] };
  private cars: (THREE.Group | null)[] = [];
  private barrier: THREE.Group | null = null;
  private boost: THREE.Group | null = null;
  private manifestLoad: Promise<void> | null = null;
  private carLoads: Promise<void>[] = [];
  private carLoadStates: AssetLoadState[] = [];
  private carLoadGenerations: number[] = [];
  private barrierLoad: Promise<void> = Promise.resolve();
  private barrierLoadState: AssetLoadState = 'idle';
  private barrierLoadGeneration = 0;
  private boostLoad: Promise<void> = Promise.resolve();
  private boostLoadState: AssetLoadState = 'idle';
  private boostLoadGeneration = 0;
  private activeAssetLoads = 0;
  private pendingAssetLoads: { file: string; order: number; start: () => void }[] = [];
  private nextAssetOrder = 0;
  private priorityCarIndexes = new Set<number>();
  private priorityCarFiles = new Set<string>();

  constructor() {
    this.loader = new GLTFLoader();
    // Our models are Draco-compressed (Task 1.5). DRACOLoader needs decoder wasm/js;
    // use the three.js CDN-hosted decoder (or vendor it under /assets/draco/ for offline).
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    this.loader.setDRACOLoader(draco);
  }

  /**
   * Fetch the manifest + load the car/barrier/boost GLBs. Resolves as soon as the MANIFEST is parsed
   * (names/count known) — the model GLBs then stream in IN THE BACKGROUND, filling this.cars[i] as
   * each arrives. This is deliberate: on a slow link the 19 GLBs (one is 7.8MB) took ~40s, and the
   * old code awaited Promise.all(all cars) before the menu/attract could start → the 3D background
   * didn't appear for a long time. Now the menu is interactive immediately; cars upgrade from
   * primitive fallback to real model as they load. `ready` (optional) resolves when ALL have loaded.
   */
  loadManifest(): Promise<void> {
    if (!this.manifestLoad) {
      const attempt = this.loadManifestOnce();
      this.manifestLoad = attempt;
      void attempt.catch(() => { if (this.manifestLoad === attempt) this.manifestLoad = null; });
    }
    return this.manifestLoad;
  }

  private async loadManifestOnce(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch('/api/manifest', { signal: controller.signal });
      if (!res.ok) throw new Error(`manifest request failed with HTTP ${res.status}`);
      // Run the body through parseManifest (tolerant; returns EMPTY_MANIFEST on bad input).
      this.manifest = parseManifest(await res.text());
      this.refreshAssetPriorities();
      // Pre-size the cars array so carTemplate(i) returns null (→ primitive) until GLB i lands.
      this.cars = new Array(this.manifest.cars.length).fill(null);
      // Kick off ALL loads without awaiting the whole batch — each fills its slot as it resolves.
      this.carLoads = new Array(this.manifest.cars.length);
      this.carLoadStates = new Array(this.manifest.cars.length).fill('idle');
      this.carLoadGenerations = new Array(this.manifest.cars.length).fill(0);
      // Selected cars (if the room choice arrived first) and the two gameplay items consume the
      // first network slots. Optional roster portraits can stream after them without delaying play.
      const selectedCars: number[] = [];
      const otherCars: number[] = [];
      for (let index = 0; index < this.manifest.cars.length; index++) {
        (this.priorityCarFiles.has(this.manifest.cars[index]!.file) ? selectedCars : otherCars).push(index);
      }
      for (const index of selectedCars) this.startCarLoad(index);
      this.barrierLoad = this.manifest.barrier ? this.startBarrierLoad() : Promise.resolve();
      this.boostLoad = this.manifest.boostPad ? this.startBoostLoad() : Promise.resolve();
      for (const index of otherCars) this.startCarLoad(index);
      this.carsReady = Promise.allSettled([...this.carLoads, this.barrierLoad, this.boostLoad]).then(() => undefined);
    } finally { clearTimeout(timeout); }
  }

  /** Resolves once every car/barrier/boost GLB has settled (or immediately if none). */
  carsReady: Promise<void> = Promise.resolve();

  /** Raise cars seen in the live menu or race ahead of optional roster downloads. */
  prioritizeCarIndexes(indexes: readonly number[]): void {
    for (const index of indexes) if (Number.isInteger(index) && index >= 0) this.priorityCarIndexes.add(index);
    this.refreshAssetPriorities();
  }

  private refreshAssetPriorities(): void {
    const carCount = this.manifest.cars.length;
    this.priorityCarFiles = new Set([...this.priorityCarIndexes]
      .map(index => carCount ? this.manifest.cars[index % carCount]?.file : undefined)
      .filter((file): file is string => Boolean(file)));
    this.pendingAssetLoads.sort((a, b) => this.assetPriority(a.file) - this.assetPriority(b.file)
      || a.order - b.order);
  }

  private assetPriority(file: string): number {
    if (this.priorityCarFiles.has(file)) return 0;
    if (file === this.manifest.barrier?.file || file === this.manifest.boostPad?.file) return 1;
    return 2;
  }

  private acquireAssetSlot(file: string): Promise<void> {
    if (this.activeAssetLoads < MAX_CONCURRENT_ASSET_LOADS) {
      this.activeAssetLoads++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.pendingAssetLoads.push({ file, order: this.nextAssetOrder++, start: resolve });
      this.refreshAssetPriorities();
    });
  }

  private releaseAssetSlot(): void {
    const next = this.pendingAssetLoads.shift();
    if (next) next.start(); // hand the open slot directly to the next prioritized file
    else this.activeAssetLoads--;
  }

  async waitForGameplayAssets(carIndexes: readonly number[]): Promise<void> {
    await this.loadManifest();
    if (carIndexes.length > 0 && this.carLoads.length === 0) {
      this.manifestLoad = null;
      await this.loadManifest();
    }
    if (carIndexes.length > 0 && this.carLoads.length === 0) throw new Error('car manifest failed to load');
    const indexes = [...new Set(carIndexes.map(index => (
      this.carLoads.length ? ((index % this.carLoads.length) + this.carLoads.length) % this.carLoads.length : -1
    )).filter(index => index >= 0))];
    for (const index of indexes) if (this.carLoadStates[index] === 'failed') this.startCarLoad(index);
    if (this.manifest.barrier && this.barrierLoadState === 'failed') this.barrierLoad = this.startBarrierLoad();
    if (this.manifest.boostPad && this.boostLoadState === 'failed') this.boostLoad = this.startBoostLoad();
    await this.waitForRequiredAssets(indexes);
    const failedIndexes = indexes.filter(index => this.carLoadStates[index] === 'failed');
    const retryBarrier = this.manifest.barrier && this.barrierLoadState === 'failed';
    const retryBoost = this.manifest.boostPad && this.boostLoadState === 'failed';
    if (failedIndexes.length || retryBarrier || retryBoost) {
      for (const index of failedIndexes) this.startCarLoad(index);
      if (retryBarrier) this.barrierLoad = this.startBarrierLoad();
      if (retryBoost) this.boostLoad = this.startBoostLoad();
      await this.waitForRequiredAssets(indexes);
    }
    if (indexes.some(index => !this.cars[index])) throw new Error('selected car model failed to load');
    if (this.manifest.barrier && !this.barrier) throw new Error('barrier model failed to load');
    if (this.manifest.boostPad && !this.boost) throw new Error('boost model failed to load');
  }

  private startCarLoad(index: number): Promise<void> {
    const ref = this.manifest.cars[index];
    if (!ref) return Promise.resolve();
    const generation = (this.carLoadGenerations[index] ?? 0) + 1;
    this.carLoadGenerations[index] = generation;
    this.carLoadStates[index] = 'loading';
    const load = this.loadRef(ref, CAR_TARGET).then(group => {
      if (this.carLoadGenerations[index] !== generation) return;
      if (group) {
        this.cars[index] = group;
        this.carLoadStates[index] = 'ready';
        return;
      }
      if (this.carLoadGenerations[index] !== generation) return;
      if (this.carLoadStates[index] === 'ready') return;
      this.cars[index] = group;
      this.carLoadStates[index] = 'failed';
    });
    this.carLoads[index] = load;
    return load;
  }

  private startBarrierLoad(): Promise<void> {
    const ref = this.manifest.barrier;
    if (!ref) return Promise.resolve();
    const generation = ++this.barrierLoadGeneration;
    this.barrierLoadState = 'loading';
    return this.loadRef(ref, BARRIER_TARGET).then(group => {
      if (this.barrierLoadGeneration !== generation) return;
      if (group) {
        this.barrier = group;
        this.barrierLoadState = 'ready';
        return;
      }
      if (this.barrierLoadGeneration !== generation) return;
      if (this.barrierLoadState === 'ready') return;
      this.barrier = group;
      this.barrierLoadState = 'failed';
    });
  }

  private startBoostLoad(): Promise<void> {
    const ref = this.manifest.boostPad;
    if (!ref) return Promise.resolve();
    const generation = ++this.boostLoadGeneration;
    this.boostLoadState = 'loading';
    return this.loadRef(ref, BOOST_TARGET).then(group => {
      if (this.boostLoadGeneration !== generation) return;
      if (group) {
        this.boost = group;
        this.boostLoadState = 'ready';
        return;
      }
      if (this.boostLoadGeneration !== generation) return;
      if (this.boostLoadState === 'ready') return;
      this.boost = group;
      this.boostLoadState = 'failed';
    });
  }

  private expireLoadingAssets(indexes: readonly number[]): void {
    for (const index of indexes) if (this.carLoadStates[index] === 'loading') {
      this.carLoadStates[index] = 'failed';
    }
    if (this.manifest.barrier && this.barrierLoadState === 'loading') {
      this.barrierLoadState = 'failed';
    }
    if (this.manifest.boostPad && this.boostLoadState === 'loading') {
      this.boostLoadState = 'failed';
    }
  }

  private waitForRequiredAssets(indexes: readonly number[]): Promise<void> {
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        const loading = indexes.some(index => this.carLoadStates[index] === 'loading')
          || this.manifest.barrier !== null && this.barrierLoadState === 'loading'
          || this.manifest.boostPad !== null && this.boostLoadState === 'loading';
        if (!loading) { resolve(); return; }
        if (performance.now() - startedAt >= RACER_ASSET_TIMEOUT_MS) {
          this.expireLoadingAssets(indexes);
          reject(new Error('Racer gameplay assets timed out'));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  private async loadRef(ref: AssetRef, target: number): Promise<THREE.Group | null> {
    await this.acquireAssetSlot(ref.file);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RACER_ASSET_TIMEOUT_MS);
    try {
      // GLTFLoader.load has no abort handle in this Three version. Fetch the GLB ourselves so a
      // weak connection can be cancelled rather than leaving hidden downloads behind the slot cap.
      const response = await fetch(`/assets/${ref.file}`, { signal: controller.signal });
      if (!response.ok) return null;
      const bytes = await response.arrayBuffer();
      if (timedOut) return null;
      const slash = ref.file.lastIndexOf('/');
      const resourcePath = `/assets/${slash >= 0 ? ref.file.slice(0, slash + 1) : ''}`;
      const gltf = await this.loader.parseAsync(bytes, resourcePath);
      if (timedOut) {
        disposeUninstalledScene(gltf.scene);
        return null;
      }
      try {
        const g = this.normalize(gltf.scene, ref, target);
        const visible = visibleGeometryBounds(g);
        const bounds = visible.bounds;
        const size = bounds.getSize(new THREE.Vector3());
        if (visible.count === 0 || bounds.isEmpty() || ![size.x, size.y, size.z].every(Number.isFinite)
          || Math.max(size.x, size.y, size.z) <= 1e-6) throw new Error('asset has no renderable geometry');
        // Showroom clips often pose the car open. Gameplay only plays clips explicitly opted in.
        g.userData.clips = ref.animate ? gltf.animations : [];
        g.userData.allClips = gltf.animations ?? [];
        return g;
      } catch {
        disposeUninstalledScene(gltf.scene);
        return null;
      }
    } catch {
      return null; // cancelled, unavailable, or invalid model: the procedural asset stays playable
    } finally {
      clearTimeout(timer);
      // A parse already in progress cannot be interrupted safely. Keep its slot until it settles
      // so a timeout never makes more than MAX_CONCURRENT_ASSET_LOADS decodes run at once.
      this.releaseAssetSlot();
    }
  }

  private normalize(scene: THREE.Group, ref: AssetRef, target: number): THREE.Group {
    const g = scene;
    // REMOVE showroom display props (turntable bases, floors, photo backdrops, camera
    // bokeh planes) entirely — so they don't render AND don't skew the measurements that
    // drive auto-fit and grounding. Done before any Box3 so the car alone defines the size.
    stripDisplayBases(g);
    // rotate → fit → ground/center via the shared helper (same ordering as the garage). Rotating
    // BEFORE measuring keeps off-origin models (e.g. monster truck) centered after a 90° turn.
    applyModelTransform(g, ref, target);
    // Tag wheel nodes for spin animation. We spin about each node's LOCAL X (rotation.x += dt), which
    // only looks right when the node's origin is at the wheel's axle. Two hazards in real GLBs:
    //   1) BOTH a wrapper group and its child mesh are named like a wheel (Batmobile:
    //      "frontrighttire" + "frontrighttire_BatMobile_0") → spinning both compounds rotations.
    //   2) A wrapper group's origin is the model center, not the axle → rotating it ORBITS the wheel
    //      around the car instead of spinning it ("flying around everywhere").
    // So tag only the SINGLE-MESH leaf wheels (origin ≈ the wheel itself) and skip multi-mesh wheel
    // wrappers. A model whose wheels are all wrappers simply won't wheel-spin (static glide), which
    // looks fine — far better than wheels flying off.
    const wheels: THREE.Object3D[] = [];
    g.traverse(o => {
      if (!isWheelNode(o.name)) return;
      if (meshCount(o) !== 1) return;   // wrapper/group → don't spin (would orbit)
      for (let p = o.parent; p && p !== g.parent; p = p.parent) if (isWheelNode(p.name)) return;
      wheels.push(o);
    });
    g.userData.wheels = wheels;
    g.castShadow = true; g.traverse(o => { (o as THREE.Mesh).castShadow = true; });
    return g;
  }

  carTemplate(i: number): THREE.Group | null { return this.cars.length ? this.cars[i % this.cars.length] ?? null : null; }
  async carReady(i: number): Promise<boolean> {
    try { await (this.carLoads[i] ?? Promise.resolve()); } catch { return false; }
    return this.carLoadStates[i] === 'ready' && Boolean(this.cars[i]);
  }
  barrierTemplate(): THREE.Group | null { return this.barrier; }
  boostTemplate(): THREE.Group | null { return this.boost; }
  async boostReady(): Promise<boolean> {
    try { await this.boostLoad; } catch { return false; }
    return this.boostLoadState === 'ready' && Boolean(this.boost);
  }
  /** The manifest car-model filenames in order (car index i uses carFile(i)). Used to key per-level
   *  car-scale overrides by MODEL (so each car model can be sized per level), not by join index. */
  carFiles(): string[] { return this.manifest.cars.map(r => r.file); }
  carFile(i: number): string | null {
    return this.manifest.cars.length ? this.manifest.cars[i % this.manifest.cars.length]!.file : null;
  }
  /** The loaded car template for a given model filename (null if not found / not loaded). */
  carTemplateByFile(file: string): THREE.Group | null {
    const i = this.manifest.cars.findIndex(r => r.file === file);
    return i >= 0 ? this.cars[i] ?? null : null;
  }
  /** Number of cars in the manifest (the selectable roster size). */
  carCount(): number { return this.manifest.cars.length; }
  /** The raw manifest AssetRef for car i (file + scale/rotation/offset), for the thumbnail rig to
   *  load + place a FRESH copy of the GLB (the Garage-proven path that renders every car whole). */
  carRef(i: number): AssetRef | null { return this.manifest.cars[i] ?? null; }
  /** Friendly display name for car i: the manifest `name`, else a prettified filename. */
  carName(i: number): string {
    const r = this.manifest.cars[i];
    if (!r) return `Car ${i + 1}`;
    return r.name?.trim() || r.file.replace(/\.glb$/i, '').replace(/[_-]+/g, ' ').trim();
  }
  /** All car display names in manifest order (for the car-select grid). */
  carNames(): string[] { return this.manifest.cars.map((_, i) => this.carName(i)); }
}
