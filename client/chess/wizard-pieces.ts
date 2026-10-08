import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ChessColor, ChessPieceType } from '../../shared/chess-protocol';
import { wizardCharacterAt, type WizardChessCharacter } from '../../shared/wizard-chess-scene';

export { wizardCharacterAt } from '../../shared/wizard-chess-scene';

type ModelAsset = 'king' | 'knight' | 'pawn' | 'queen' | WizardChessCharacter;
type WizardAsset = ChessPieceType | ModelAsset;

const MODEL_PATH = '/assets/chess/wizard/';
// The three players should appear as soon as the scene opens, even while the armies finish loading.
const MODEL_FILES: readonly ModelAsset[] = ['ron', 'harry', 'hermione', 'knight', 'queen', 'king', 'pawn'];
const PIECE_MODEL: Partial<Record<ChessPieceType, ModelAsset>> = {
  k: 'king', n: 'knight', p: 'pawn', q: 'queen',
};
const CHARACTER_NAMES: Readonly<Record<WizardChessCharacter, string>> = {
  ron: 'Ron', hermione: 'Hermione', harry: 'Harry',
};
export function wizardAssetForPiece(square: string, color: ChessColor,
  type: ChessPieceType): WizardAsset {
  return wizardCharacterAt(square, color, type) ?? PIECE_MODEL[type] ?? type;
}

const targetHeight: Record<ModelAsset, number> = {
  king: 1.52, knight: 1.42, pawn: 0.88, queen: 1.49,
  harry: 1.9, ron: 1.9, hermione: 1.9,
};

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Group,
  x: number, y: number, z: number): THREE.Mesh {
  const part = new THREE.Mesh(geometry, material);
  part.position.set(x, y, z);
  part.castShadow = true;
  part.receiveShadow = true;
  parent.add(part);
  return part;
}

/** Loaded model templates share geometry and textures; the board only clones scene nodes. */
export class WizardPieceLibrary {
  private readonly loader = new GLTFLoader();
  private readonly draco = new DRACOLoader();
  private readonly templates = new Map<ModelAsset, THREE.Group>();
  private readonly inFlight = new Map<ModelAsset, { promise: Promise<void>; activation: boolean }>();
  private readonly failed = new Set<ModelAsset>();
  private readonly stoneWhite = new THREE.MeshStandardMaterial({
    color: 0xf2e8d9, roughness: 0.58, metalness: 0.08,
  });
  private readonly stoneBlack = new THREE.MeshStandardMaterial({
    color: 0x263448, roughness: 0.45, metalness: 0.22,
    emissive: 0x0a1728, emissiveIntensity: 0.22,
  });
  private readonly gold = new THREE.MeshStandardMaterial({
    color: 0xc89e5a, roughness: 0.37, metalness: 0.73,
  });
  private readonly rune = new THREE.MeshStandardMaterial({
    color: 0x8cc5d1, roughness: 0.24, metalness: 0.2,
    emissive: 0x2c7398, emissiveIntensity: 0.45,
  });
  private readonly glasses = new THREE.MeshStandardMaterial({
    color: 0x121118, roughness: 0.46, metalness: 0.28,
  });
  private readonly skin = new THREE.MeshStandardMaterial({
    color: 0xd9a07b, roughness: 0.82,
  });
  private readonly uniform = new THREE.MeshStandardMaterial({
    color: 0x30344b, roughness: 0.89,
  });
  private readonly hair = {
    harry: new THREE.MeshStandardMaterial({ color: 0x211b1a, roughness: 0.92 }),
    ron: new THREE.MeshStandardMaterial({ color: 0xb7542c, roughness: 0.91 }),
    hermione: new THREE.MeshStandardMaterial({ color: 0x673b26, roughness: 0.91 }),
  };
  private readonly pendingControllers = new Set<AbortController>();
  private readonly detailGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly waitingLoads: Array<{ activation: boolean; resume: () => void }> = [];
  private activeLoads = 0;
  private disposed = false;
  private warmed = false;
  private activationPass: Promise<void> | null = null;

  constructor(private readonly onModelReady: () => void, private readonly lowDetail: boolean) {
    this.draco.setDecoderPath('/draco/');
    this.loader.setDRACOLoader(this.draco);
  }

  /** Begin bounded downloads while the call QR is showing; no game action waits for these. */
  prefetch(retryFailed = false): void {
    if (this.disposed || (!retryFailed && this.warmed) || (retryFailed && this.activationPass)) return;
    this.warmed = true;
    const keys = this.lowDetail && !retryFailed
      ? MODEL_FILES.filter(key => key !== 'pawn' && key !== 'king')
      : MODEL_FILES;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < keys.length && !this.disposed) {
        const key = keys[cursor++]!;
        await this.load(key, retryFailed);
      }
    };
    const pass = Promise.all([worker(), worker()]).then(() => {});
    if (retryFailed) {
      this.activationPass = pass;
      void pass.finally(() => { if (this.activationPass === pass) this.activationPass = null; });
    }
  }

  createPiece(square: string, color: ChessColor, type: ChessPieceType): THREE.Group {
    const key = wizardAssetForPiece(square, color, type);
    const template = this.templates.get(key as ModelAsset);
    if (!template) return this.createFallback(type, color, key);
    const piece = new THREE.Group();
    piece.add(template.clone(true));
    piece.userData.wizardAsset = key;
    piece.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
      if (!isCharacter(key)) object.material = color === 'w' ? this.stoneWhite : this.stoneBlack;
    });
    if (isCharacter(key)) {
      // Keep the supplied character textures and silhouette visible.
      this.styleCharacter(piece, key, true);
    }
    else this.addStoneSigil(piece, color);
    return piece;
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.pendingControllers) controller.abort();
    this.pendingControllers.clear();
    this.draco.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const template of this.templates.values()) template.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const values = Array.isArray(object.material) ? object.material : [object.material];
      values.forEach(value => materials.add(value));
    });
    geometries.forEach(item => item.dispose());
    this.detailGeometries.forEach(item => item.dispose());
    materials.forEach(item => {
      const map = (item as THREE.MeshStandardMaterial).map;
      map?.dispose();
      item.dispose();
    });
    for (const item of [this.stoneWhite, this.stoneBlack, this.gold, this.rune,
      this.glasses, this.skin, this.uniform, ...Object.values(this.hair)]) item.dispose();
  }

  private async load(key: ModelAsset, retryFailed: boolean): Promise<void> {
    if (this.disposed || this.templates.has(key) || (this.failed.has(key) && !retryFailed)) return;
    const current = this.inFlight.get(key);
    if (current) {
      await current.promise;
      // Activation may arrive while the QR prefetch is still in flight. If that first
      // attempt timed out, make one fresh request before settling for the procedural figure.
      if (retryFailed && !current.activation && !this.disposed && !this.templates.has(key)) {
        await this.load(key, true);
      }
      return;
    }
    const promise = (async () => {
      await this.acquireLoadSlot(retryFailed);
      const controller = new AbortController();
      this.pendingControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 11_000);
      try {
        if (this.disposed) return;
        const response = await fetch(`${MODEL_PATH}${key}.glb`, {
          signal: controller.signal, cache: 'force-cache',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const loaded = await this.loader.parseAsync(bytes, MODEL_PATH);
        const normalized = this.normalize(loaded.scene, key);
        if (this.disposed) {
          normalized.traverse(object => {
            if (object instanceof THREE.Mesh) object.geometry.dispose();
          });
          return;
        }
        this.templates.set(key, normalized);
        this.failed.delete(key);
        this.onModelReady();
      } catch (error) {
        if (!this.disposed) {
          this.failed.add(key);
          console.info(`Wizard Chess will use its sculpted ${key} fallback.`, error);
        }
      } finally {
        clearTimeout(timeout);
        this.pendingControllers.delete(controller);
        this.inFlight.delete(key);
        this.releaseLoadSlot();
      }
    })();
    this.inFlight.set(key, { promise, activation: retryFailed });
    return promise;
  }

  private acquireLoadSlot(activation: boolean): Promise<void> {
    if (this.activeLoads < 2) {
      this.activeLoads++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const waiter = { activation, resume: resolve };
      if (!activation) { this.waitingLoads.push(waiter); return; }
      const firstBackground = this.waitingLoads.findIndex(item => !item.activation);
      if (firstBackground < 0) this.waitingLoads.push(waiter);
      else this.waitingLoads.splice(firstBackground, 0, waiter);
    });
  }

  private releaseLoadSlot(): void {
    const next = this.waitingLoads.shift();
    if (next) next.resume(); // transfer the slot without briefly allowing a third fetch
    else this.activeLoads--;
  }

  private normalize(original: THREE.Group, key: ModelAsset): THREE.Group {
    const bounds = new THREE.Box3().setFromObject(original);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const root = new THREE.Group();
    if (!Number.isFinite(size.y) || size.y <= 0.001) throw new Error(`Empty ${key} model`);
    const maxWidth = Math.max(size.x, size.z, 0.001);
    const maxFootprint = isCharacter(key) ? 0.74 : 0.83;
    const scale = Math.min(targetHeight[key] / size.y, maxFootprint / maxWidth);
    original.position.set(-center.x, -bounds.min.y, -center.z);
    root.scale.setScalar(scale);
    root.add(original);
    root.userData.wizardAsset = key;
    return root;
  }

  private addStoneSigil(piece: THREE.Group, color: ChessColor): void {
    const material = color === 'w' ? this.gold : this.rune;
    const ring = mesh(this.geometry('stone-sigil', () => new THREE.TorusGeometry(0.36, 0.018, 6, 28)),
      material, piece, 0, 0.025, 0);
    ring.rotation.x = Math.PI / 2;
  }

  private styleCharacter(piece: THREE.Group, character: WizardChessCharacter, modelLoaded: boolean): void {
    piece.userData.wizardCharacter = character;
    piece.userData.faceAudience = true;
    const base = mesh(this.geometry('avatar-base', () => new THREE.CylinderGeometry(0.37, 0.4, 0.11, 12)), this.stoneBlack,
      piece, 0, 0.045, 0);
    base.receiveShadow = true;
    const ring = mesh(this.geometry('avatar-ring', () => new THREE.TorusGeometry(0.37, 0.018, 6, 32)), this.gold,
      piece, 0, 0.102, 0);
    ring.rotation.x = Math.PI / 2;
    // The supplied Harry GLB already includes glasses. Add a pair only to the
    // generated offline figure, fitted to that figure's actual face position.
    if (character === 'harry' && !modelLoaded) this.addHarryGlasses(piece);
  }

  private addHarryGlasses(piece: THREE.Group): void {
    const eyeHeight = 1.37;
    for (const x of [-0.065, 0.065]) {
      mesh(this.geometry('harry-lens', () => new THREE.TorusGeometry(0.052, 0.006, 6, 22)), this.glasses,
        piece, x, eyeHeight, 0.215);
    }
    const bridge = mesh(this.geometry('harry-bridge', () => new THREE.BoxGeometry(0.035, 0.007, 0.008)), this.glasses,
      piece, 0, eyeHeight, 0.215);
    bridge.castShadow = false;
  }

  private createFallback(type: ChessPieceType, color: ChessColor, key: WizardAsset): THREE.Group {
    const root = isCharacter(key)
      ? this.createCharacterFallback(key)
      : this.createArmoredFallback(type, color);
    root.userData.wizardAsset = key;
    if (isCharacter(key)) {
      this.styleCharacter(root, key, false);
      // The fallback figure still needs an obvious label when the character GLB is unavailable.
      root.userData.wizardFallbackName = CHARACTER_NAMES[key];
    } else this.addStoneSigil(root, color);
    return root;
  }

  private createCharacterFallback(character: WizardChessCharacter): THREE.Group {
    const root = new THREE.Group();
    const hair = this.hair[character];
    mesh(this.geometry('fallback-robe', () => new THREE.CylinderGeometry(0.18, 0.30, 0.94, 9)),
      this.uniform, root, 0, 0.6, 0);
    mesh(this.geometry('fallback-face', () => new THREE.SphereGeometry(0.165, 12, 8)),
      this.skin, root, 0, 1.32, 0.04);
    mesh(this.geometry('fallback-hair', () => new THREE.SphereGeometry(0.178, 12, 8)),
      hair, root, 0, 1.43, 0);
    for (const side of [-1, 1]) {
      const arm = mesh(this.geometry('fallback-arm', () => new THREE.CylinderGeometry(0.055, 0.072, 0.63, 8)),
        this.uniform, root, side * 0.21, 0.86, 0);
      arm.rotation.z = -side * 0.22;
      mesh(this.geometry('fallback-boot', () => new THREE.BoxGeometry(0.14, 0.2, 0.21)),
        this.glasses, root, side * 0.115, 0.13, 0.06);
    }
    mesh(this.geometry('fallback-wand', () => new THREE.CylinderGeometry(0.014, 0.02, 0.55, 6)),
      this.gold, root, 0.35, 0.66, 0.13).rotation.z = -0.28;
    if (character === 'hermione') {
      for (const side of [-1, 1]) {
        mesh(this.geometry('fallback-long-hair', () => new THREE.CylinderGeometry(0.065, 0.09, 0.51, 7)),
          hair, root, side * 0.15, 1.16, -0.02);
      }
    }
    return root;
  }

  /** Distinct low-poly wizard armies keep the scene legible without network or GPU headroom. */
  private createArmoredFallback(type: ChessPieceType, color: ChessColor): THREE.Group {
    if (type === 'p') return this.createPawnGuard(color);
    if (type === 'n') return this.createMountedKnight(color);
    if (type === 'k' || type === 'q') return this.createRoyalGuard(type, color);
    const root = new THREE.Group();
    const stone = color === 'w' ? this.stoneWhite : this.stoneBlack;
    mesh(this.geometry('guard-plinth', () => new THREE.CylinderGeometry(0.36, 0.39, 0.14, 8)), stone, root, 0, 0.07, 0);
    mesh(this.geometry('guard-body', () => new THREE.CylinderGeometry(0.24, 0.31, 0.78, 8)), stone, root, 0, 0.51, 0);
    mesh(this.geometry('guard-head', () => new THREE.SphereGeometry(0.165, 10, 7)), stone, root, 0, 1.03, 0);
    mesh(this.geometry('guard-collar', () => new THREE.BoxGeometry(0.3, 0.1, 0.22)), this.gold, root, 0, 0.86, 0);
    const shield = mesh(this.geometry('guard-shield', () => new THREE.BoxGeometry(0.21, 0.32, 0.055)), stone,
      root, -0.2, 0.69, 0.20);
    shield.rotation.z = 0.16;
    mesh(this.geometry('guard-crest', () => new THREE.OctahedronGeometry(0.065)), this.rune, root, -0.2, 0.7, 0.24);
    if (type === 'b') {
      mesh(this.geometry('bishop-mitre', () => new THREE.ConeGeometry(0.18, 0.42, 8)), stone, root, 0, 1.3, 0);
      mesh(this.geometry('bishop-staff', () => new THREE.BoxGeometry(0.055, 1.0, 0.055)), this.gold, root, 0.25, 0.82, 0.06);
      mesh(this.geometry('bishop-crozier', () => new THREE.TorusGeometry(0.11, 0.025, 6, 12, Math.PI * 1.45)), this.gold,
        root, 0.25, 1.32, 0.06);
    } else {
      mesh(this.geometry('rook-turret', () => new THREE.CylinderGeometry(0.21, 0.21, 0.22, 8)), stone, root, 0, 1.18, 0);
      for (const [x, z] of [[-0.16, -0.16], [-0.16, 0.16], [0.16, -0.16], [0.16, 0.16]] as const) {
        mesh(this.geometry('rook-crenel', () => new THREE.BoxGeometry(0.12, 0.2, 0.12)), stone, root, x, 1.36, z);
      }
      mesh(this.geometry('rook-spear', () => new THREE.BoxGeometry(0.05, 0.38, 0.05)), this.gold, root, 0.26, 0.72, 0.02);
      mesh(this.geometry('rook-tip', () => new THREE.ConeGeometry(0.09, 0.26, 6)), this.gold, root, 0.26, 1.04, 0.02);
    }
    return root;
  }

  private createPawnGuard(color: ChessColor): THREE.Group {
    const root = new THREE.Group();
    const stone = color === 'w' ? this.stoneWhite : this.stoneBlack;
    mesh(this.geometry('pawn-plinth', () => new THREE.CylinderGeometry(0.34, 0.37, 0.14, 8)), stone, root, 0, 0.07, 0);
    mesh(this.geometry('pawn-armor', () => new THREE.CylinderGeometry(0.18, 0.24, 0.47, 8)), stone, root, 0, 0.38, 0);
    mesh(this.geometry('pawn-head', () => new THREE.SphereGeometry(0.13, 9, 6)), stone, root, 0, 0.7, 0.01);
    mesh(this.geometry('pawn-helm', () => new THREE.ConeGeometry(0.18, 0.20, 8)), stone, root, 0, 0.83, 0);
    const shield = mesh(this.geometry('pawn-shield', () => new THREE.BoxGeometry(0.23, 0.28, 0.045)),
      stone, root, -0.19, 0.4, 0.14);
    shield.rotation.z = -0.1;
    mesh(this.geometry('pawn-shield-gem', () => new THREE.OctahedronGeometry(0.055)), this.rune,
      root, -0.19, 0.43, 0.18);
    mesh(this.geometry('pawn-spear', () => new THREE.CylinderGeometry(0.017, 0.018, 0.65, 5)), this.gold,
      root, 0.21, 0.51, 0.06);
    return root;
  }

  private createRoyalGuard(type: 'k' | 'q', color: ChessColor): THREE.Group {
    const root = new THREE.Group();
    const stone = color === 'w' ? this.stoneWhite : this.stoneBlack;
    mesh(this.geometry('royal-plinth', () => new THREE.CylinderGeometry(0.38, 0.40, 0.17, 10)),
      stone, root, 0, 0.085, 0);
    mesh(this.geometry('royal-robe', () => new THREE.CylinderGeometry(0.2, 0.33, 0.91, 10)),
      stone, root, 0, 0.65, 0);
    mesh(this.geometry('royal-head', () => new THREE.SphereGeometry(0.17, 11, 7)),
      stone, root, 0, 1.23, 0);
    mesh(this.geometry('royal-crown-band', () => new THREE.CylinderGeometry(0.19, 0.19, 0.11, 10)),
      this.gold, root, 0, 1.37, 0);
    for (let i = 0; i < (type === 'k' ? 4 : 5); i++) {
      const angle = i * Math.PI * 2 / (type === 'k' ? 4 : 5);
      mesh(this.geometry('royal-crown-point', () => new THREE.ConeGeometry(0.055, 0.22, 6)),
        stone, root, Math.sin(angle) * 0.15, 1.50, Math.cos(angle) * 0.15);
    }
    mesh(this.geometry('royal-gem', () => new THREE.OctahedronGeometry(0.08)), this.rune,
      root, 0, 0.94, 0.22);
    if (type === 'k') {
      mesh(this.geometry('king-sword', () => new THREE.BoxGeometry(0.055, 0.9, 0.045)),
        this.gold, root, 0.28, 0.66, 0.04);
      mesh(this.geometry('king-crossguard', () => new THREE.BoxGeometry(0.24, 0.05, 0.05)),
        this.gold, root, 0.28, 0.46, 0.04);
    } else {
      mesh(this.geometry('queen-scepter', () => new THREE.CylinderGeometry(0.024, 0.03, 0.87, 7)),
        this.gold, root, 0.28, 0.72, 0.02);
      mesh(this.geometry('queen-orb', () => new THREE.OctahedronGeometry(0.105)),
        this.rune, root, 0.28, 1.19, 0.02);
    }
    return root;
  }

  private createMountedKnight(color: ChessColor): THREE.Group {
    const root = new THREE.Group();
    const stone = color === 'w' ? this.stoneWhite : this.stoneBlack;
    mesh(this.geometry('horse-plinth', () => new THREE.CylinderGeometry(0.38, 0.40, 0.14, 9)),
      stone, root, 0, 0.07, 0);
    mesh(this.geometry('horse-body', () => new THREE.SphereGeometry(0.31, 11, 8)),
      stone, root, 0, 0.65, 0).scale.set(1.1, 0.55, 0.66);
    for (const x of [-0.19, 0.19]) for (const z of [-0.13, 0.13]) {
      mesh(this.geometry('horse-leg', () => new THREE.CylinderGeometry(0.055, 0.075, 0.48, 7)),
        stone, root, x, 0.36, z);
    }
    const neck = mesh(this.geometry('horse-neck', () => new THREE.CylinderGeometry(0.105, 0.14, 0.55, 8)),
      stone, root, 0.17, 0.91, 0);
    neck.rotation.z = -0.33;
    mesh(this.geometry('horse-head', () => new THREE.BoxGeometry(0.29, 0.24, 0.24)),
      stone, root, 0.25, 1.18, 0);
    mesh(this.geometry('horse-mane', () => new THREE.ConeGeometry(0.13, 0.36, 7)),
      this.gold, root, 0.02, 1.16, -0.03);
    mesh(this.geometry('knight-rider', () => new THREE.CylinderGeometry(0.095, 0.16, 0.43, 8)),
      stone, root, -0.15, 1.02, 0);
    mesh(this.geometry('knight-rider-head', () => new THREE.SphereGeometry(0.12, 9, 6)),
      stone, root, -0.15, 1.3, 0);
    mesh(this.geometry('knight-lance', () => new THREE.CylinderGeometry(0.02, 0.022, 1.12, 6)),
      this.gold, root, -0.33, 0.99, 0.08).rotation.z = -0.24;
    return root;
  }

  private geometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let result = this.detailGeometries.get(key);
    if (!result) {
      result = create();
      this.detailGeometries.set(key, result);
    }
    return result;
  }
}

function isCharacter(key: WizardAsset): key is WizardChessCharacter {
  return key === 'ron' || key === 'harry' || key === 'hermione';
}
