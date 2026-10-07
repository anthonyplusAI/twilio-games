import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createChessPiece, pieceShardMaterial, pieceSpellColor,
  type ChessColor, type ChessPieceType } from './chess-pieces';
import { ChessHall, type ChessTheme } from './chess-hall';

export interface BoardPiece {
  square: string;
  color: ChessColor;
  type: ChessPieceType;
}

export interface BoardMove {
  from: string;
  to: string;
  color: ChessColor;
  piece: ChessPieceType;
  captured?: ChessPieceType | null;
  capturedSquare?: string | null;
  promotion?: ChessPieceType | null;
  rookFrom?: string | null;
  rookTo?: string | null;
  check?: boolean;
  checkmate?: boolean;
}

interface PieceVisual extends BoardPiece { group: THREE.Group }

interface Particle {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
  born: number;
  life: number;
  velocity: THREE.Vector3;
  rotation: THREE.Vector3;
  kind: 'shard' | 'spark' | 'ring' | 'beam' | 'slash';
  baseScale: THREE.Vector3;
}

interface MoveAnimation {
  move: BoardMove;
  next: readonly BoardPiece[];
  attacker: PieceVisual;
  victim: PieceVisual | null;
  rook: PieceVisual | null;
  started: number;
  duration: number;
  cast: boolean;
  shattered: boolean;
  resolve: () => void;
}

const TOP = 0.405;
const FILES = 'abcdefgh';
const shardGeometry = new THREE.TetrahedronGeometry(0.1, 0);
const sparkGeometry = new THREE.SphereGeometry(0.045, 7, 5);
const ringGeometry = new THREE.TorusGeometry(0.38, 0.021, 7, 38);
const slashGeometry = new THREE.TorusGeometry(0.37, 0.028, 7, 32, Math.PI * 1.2);
const beamGeometry = new THREE.CylinderGeometry(0.035, 0.08, 1, 8);
// Include the plinth and its corner jewels when keeping the board in frame.
const boardFrameCorners = [-4.75, 4.75].flatMap(x => [-4.75, 4.75].flatMap(z =>
  [-0.42, 0.52].map(y => new THREE.Vector3(x, y, z))));

function squarePosition(square: string): THREE.Vector3 | null {
  const file = FILES.indexOf(square[0]?.toLowerCase() ?? '');
  const rank = Number(square[1]);
  if (file < 0 || !Number.isInteger(rank) || rank < 1 || rank > 8) return null;
  return new THREE.Vector3(file - 3.5, TOP, 4.5 - rank);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function marbleTexture(light: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 192;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Chess board texture could not be created.');
  const rng = seededRandom(light ? 0x2e1794 : 0x2e1795);
  context.fillStyle = light ? '#c2b9ac' : '#23314a';
  context.fillRect(0, 0, 192, 192);
  for (let i = 0; i < 420; i++) {
    const shade = light ? (rng() > 0.5 ? '255,248,231' : '70,60,56')
      : (rng() > 0.5 ? '133,154,189' : '3,8,22');
    context.fillStyle = `rgba(${shade},${0.018 + rng() * 0.075})`;
    const size = 1 + rng() * 9;
    context.fillRect(rng() * 192, rng() * 192, size, size);
  }
  for (let i = 0; i < 14; i++) {
    context.beginPath();
    const start = rng() * 230 - 20;
    const end = start + rng() * 60 - 30;
    context.moveTo(start, -15);
    context.bezierCurveTo(start + rng() * 60 - 30, 55, end + rng() * 60 - 30, 130, end, 208);
    context.strokeStyle = light ? `rgba(255,255,255,${0.03 + rng() * 0.10})`
      : `rgba(159,192,220,${0.025 + rng() * 0.07})`;
    context.lineWidth = 0.35 + rng() * 1.2;
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function textSprite(value: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Chess coordinate label could not be created.');
  context.clearRect(0, 0, 96, 96);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.shadowColor = '#020817';
  context.shadowBlur = 8;
  context.fillStyle = color;
  context.font = '700 60px "Twilio Sans Mono", ui-monospace, monospace';
  context.fillText(value, 48, 49);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(0.35, 0.35, 1);
  return sprite;
}

function spellColor(move: BoardMove): THREE.Color {
  const color = pieceSpellColor(move.color);
  const accent: Record<ChessPieceType, number> = {
    p: 0xffa166, n: 0xff344e, b: 0xb788ff, r: 0xffd39a, q: 0xff78c4, k: 0xffed9e,
  };
  return color.lerp(new THREE.Color(accent[move.piece]), move.color === 'w' ? 0.42 : 0.30);
}

export class ChessBoardScene {
  readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 100);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly orbit: OrbitControls;
  private readonly cameraFramePoint = new THREE.Vector3();
  private readonly board = new THREE.Group();
  private readonly pieceLayer = new THREE.Group();
  private readonly coordinateLayer = new THREE.Group();
  private readonly highlights = new Map<string, THREE.Group>();
  private readonly highlightSquares = new Map<string, string | null>();
  private readonly pieces = new Map<string, PieceVisual>();
  private readonly particles: Particle[] = [];
  private readonly resizeObserver: ResizeObserver | null;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly hall: ChessHall;
  private boardMaterials!: {
    stone: THREE.MeshStandardMaterial;
    underStone: THREE.MeshStandardMaterial;
    metal: THREE.MeshStandardMaterial;
    inset: THREE.MeshStandardMaterial;
    lightTile: THREE.MeshStandardMaterial;
    darkTile: THREE.MeshStandardMaterial;
  };
  private theme: ChessTheme = 'light';
  private appliedTheme: ChessTheme | null = null;
  private frame = 0;
  private lastFrameAt = 0;
  private humanColor: ChessColor = 'w';
  private animation: MoveAnimation | null = null;
  private cameraAdjusted = false;
  private ready = true;
  private onAvailability?: (available: boolean) => void;

  constructor(private readonly container: HTMLElement) {
    const device = navigator as Navigator & { deviceMemory?: number };
    const lowPowerDisplay = (device.deviceMemory !== undefined && device.deviceMemory <= 4)
      || (device.hardwareConcurrency !== undefined && device.hardwareConcurrency <= 4)
      || matchMedia('(pointer: coarse) and (max-width: 900px)').matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, lowPowerDisplay ? 1.3 : 1.7));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Only chess pieces move. Rebuilding the shadow atlas while the board is idle wastes GPU time.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.28;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cursor = 'grab';
    this.container.append(this.canvas);
    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = !this.reducedMotion;
    this.orbit.dampingFactor = 0.12;
    this.orbit.rotateSpeed = 0.72;
    this.orbit.zoomSpeed = 0.85;
    this.orbit.screenSpacePanning = false;
    this.orbit.minPolarAngle = 0.28;
    this.orbit.maxPolarAngle = 1.24;
    this.orbit.minZoom = 0.55;
    this.orbit.maxZoom = 1.65;
    this.orbit.maxTargetRadius = 1.3;
    this.orbit.addEventListener('start', this.onCameraStart);
    this.orbit.addEventListener('end', this.onCameraEnd);
    this.canvas.addEventListener('dblclick', this.onCameraDoubleClick);
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.ready = false;
      if (this.animation) this.finishAnimation(this.animation);
      this.onAvailability?.(false);
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.ready = true;
      this.renderer.shadowMap.needsUpdate = true;
      this.onAvailability?.(true);
    });

    this.hall = new ChessHall(this.scene, lowPowerDisplay, this.reducedMotion);
    this.createBoard();
    this.scene.add(this.board);
    this.scene.add(this.pieceLayer);
    this.scene.add(this.coordinateLayer);
    this.setHumanColor('w');
    this.setTheme('light');

    this.resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => this.resize()) : null;
    this.resizeObserver?.observe(container);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  setAvailabilityHandler(handler: (available: boolean) => void): void {
    this.onAvailability = handler;
    handler(this.ready);
  }

  setHumanColor(color: ChessColor): void {
    if (this.humanColor === color && this.coordinateLayer.children.length) return;
    this.humanColor = color;
    this.cameraAdjusted = false;
    this.positionCamera();
    this.replaceCoordinates();
  }

  setTheme(theme: ChessTheme): void {
    if (this.appliedTheme === theme) return;
    this.appliedTheme = theme;
    this.theme = theme;
    this.hall.setTheme(theme);
    const light = theme === 'light';
    this.renderer.toneMappingExposure = light ? 1.19 : 1.28;
    this.boardMaterials.stone.color.setHex(light ? 0x273a54 : 0x142139);
    this.boardMaterials.underStone.color.setHex(light ? 0x16263b : 0x070d1d);
    this.boardMaterials.metal.color.setHex(light ? 0xb28954 : 0xa77c51);
    this.boardMaterials.inset.color.setHex(light ? 0x9d2c4d : 0xa91131);
    this.boardMaterials.lightTile.color.setHex(light ? 0xffffff : 0xdce7fb);
    this.boardMaterials.darkTile.color.setHex(light ? 0xffffff : 0xc6d5ef);
    this.replaceCoordinates();
  }

  resetCamera(): void {
    this.cameraAdjusted = false;
    this.positionCamera();
  }

  setPosition(next: readonly BoardPiece[]): void {
    const previous = new Map(this.pieces);
    let changed = false;
    this.pieces.clear();
    for (const piece of next) {
      const position = squarePosition(piece.square);
      if (!position || !['w', 'b'].includes(piece.color) || !['p', 'n', 'b', 'r', 'q', 'k'].includes(piece.type)) continue;
      const existing = previous.get(piece.square);
      const group = existing?.type === piece.type && existing.color === piece.color
        ? existing.group : createChessPiece(piece.type, piece.color);
      const rotation = piece.color === 'w' ? 0 : Math.PI;
      changed ||= group !== existing?.group || !group.position.equals(position)
        || group.rotation.y !== rotation || group.rotation.z !== 0 || !group.visible;
      if (existing && group !== existing.group) this.pieceLayer.remove(existing.group);
      group.position.copy(position);
      group.rotation.y = rotation;
      group.rotation.z = 0;
      group.visible = true;
      if (group.parent !== this.pieceLayer) this.pieceLayer.add(group);
      this.pieces.set(piece.square, { ...piece, group });
      previous.delete(piece.square);
    }
    for (const visual of previous.values()) {
      this.pieceLayer.remove(visual.group);
      changed = true;
    }
    if (changed) this.renderer.shadowMap.needsUpdate = true;
  }

  animateTo(next: readonly BoardPiece[], move: BoardMove): Promise<void> {
    const attacker = this.pieces.get(move.from);
    const target = squarePosition(move.to);
    if (this.reducedMotion || !attacker || !target || this.animation) {
      this.setPosition(next);
      this.setLastMove(move.from, move.to);
      return Promise.resolve();
    }
    const victimSquare = move.capturedSquare || move.to;
    const victim = this.pieces.get(victimSquare) ?? null;
    const rook = move.rookFrom ? this.pieces.get(move.rookFrom) ?? null : null;
    return new Promise(resolve => {
      this.animation = {
        move, next, attacker, victim, rook, started: performance.now(),
        duration: victim ? 1230 : 780, cast: false, shattered: false, resolve,
      };
    });
  }

  setLastMove(from: string | null, to: string | null): void {
    this.placeHighlight('last-from', from, 0xc4a66d, 0.12);
    this.placeHighlight('last-to', to, 0xf0304c, 0.19);
  }

  setPendingMove(from: string | null, to: string | null): void {
    this.placeHighlight('pending-from', from, 0x09eb65, 0.48);
    this.placeHighlight('pending-to', to, 0x00ed57, 0.78);
  }

  setHint(from: string | null, to: string | null): void {
    this.placeHighlight('hint-from', from, 0x45c7ff, 0.27);
    this.placeHighlight('hint-to', to, 0x6fe8ff, 0.46);
  }

  setSelection(square: string | null): void {
    this.placeHighlight('selection', square, 0xf0304c, 0.20);
  }

  setCheck(square: string | null): void {
    this.placeHighlight('check', square, 0xff2846, 0.33);
    if (square && !this.reducedMotion && this.ready) {
      const position = squarePosition(square);
      if (position) this.spawnRing(position, new THREE.Color(0xff2846), 1.25);
    }
  }

  showResult(humanWon: boolean | null): void {
    if (this.reducedMotion) return;
    const color = new THREE.Color(humanWon === true ? 0xffd28a : humanWon === false ? 0xf02d48 : 0xaeb6d0);
    const center = new THREE.Vector3(0, TOP + 0.03, 0);
    for (let i = 0; i < 4; i++) this.spawnRing(center, color, 1.5 + i * 0.25, i * 130);
    this.spawnSparks(center.clone().setY(1.5), color, 58, 1.45);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    if (this.animation) this.finishAnimation(this.animation);
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.resize);
    this.canvas.removeEventListener('dblclick', this.onCameraDoubleClick);
    this.orbit.removeEventListener('start', this.onCameraStart);
    this.orbit.removeEventListener('end', this.onCameraEnd);
    this.orbit.dispose();
    this.hall.dispose();
    for (const particle of this.particles) {
      this.scene.remove(particle.mesh);
      particle.material.dispose();
    }
    this.particles.length = 0;
    const geometry = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const layer of [this.board, this.coordinateLayer, ...this.highlights.values()]) {
      layer.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineLoop || object instanceof THREE.Sprite) {
          if (object instanceof THREE.Mesh || object instanceof THREE.LineLoop) geometry.add(object.geometry);
          const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
          objectMaterials.forEach(material => materials.add(material));
        }
      });
    }
    geometry.forEach(item => item.dispose());
    materials.forEach(material => {
      if ('map' in material && material.map instanceof THREE.Texture) material.map.dispose();
      material.dispose();
    });
    this.renderer.dispose();
    this.canvas.remove();
  }

  private readonly onCameraStart = (): void => {
    this.cameraAdjusted = true;
    this.canvas.style.cursor = 'grabbing';
  };

  private readonly onCameraEnd = (): void => {
    this.canvas.style.cursor = 'grab';
  };

  private readonly onCameraDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    this.resetCamera();
  };

  private readonly resize = (): void => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const aspect = width / height;
    // The board needs horizontal room on narrow displays; orthographic scaling avoids clipping.
    const narrow = width < 720 || aspect < 0.78;
    const visibleHeight = narrow ? Math.max(10.1, 10.45 / aspect) : Math.max(10.2, 11.1 / aspect);
    this.camera.left = -visibleHeight * aspect / 2;
    this.camera.right = visibleHeight * aspect / 2;
    this.camera.top = visibleHeight / 2;
    this.camera.bottom = -visibleHeight / 2;
    this.camera.updateProjectionMatrix();
    if (this.cameraAdjusted) {
      this.orbit.update();
      this.constrainCameraFraming();
    } else this.positionCamera();
    this.renderer.setSize(width, height, false);
  };

  private positionCamera(): void {
    // Drain any inertial drag before changing sides or resetting the view.
    const damping = this.orbit.enableDamping;
    this.orbit.enableDamping = false;
    this.orbit.update();
    this.orbit.enableDamping = damping;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const narrow = width < 720 || width / Math.max(1, height) < 0.78;
    const sign = this.humanColor === 'w' ? 1 : -1;
    const shift = narrow ? -0.75 : 0;
    this.orbit.maxZoom = 1.65;
    this.camera.zoom = narrow ? 1 : 0.88;
    this.camera.position.set(sign * (narrow ? 0.45 : 8.5), (narrow ? 18.5 : 13.1) + shift,
      sign * (narrow ? 14.4 : 13.4));
    this.orbit.target.set(0, 0.3 + shift, 0);
    this.orbit.cursor.copy(this.orbit.target);
    this.camera.lookAt(this.orbit.target);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
    this.constrainCameraFraming();
    this.orbit.saveState();
  }

  private constrainCameraFraming(): void {
    this.camera.updateMatrixWorld();
    let maxX = 0;
    let maxY = 0;
    for (const corner of boardFrameCorners) {
      this.cameraFramePoint.copy(corner).applyMatrix4(this.camera.matrixWorldInverse);
      maxX = Math.max(maxX, Math.abs(this.cameraFramePoint.x));
      maxY = Math.max(maxY, Math.abs(this.cameraFramePoint.y));
    }
    const fitZoom = Math.min(
      (this.camera.right - this.camera.left) / (2 * maxX),
      (this.camera.top - this.camera.bottom) / (2 * maxY),
    ) * 0.965;
    this.orbit.maxZoom = Math.max(this.orbit.minZoom, Math.min(1.65, fitZoom));
    if (this.camera.zoom > this.orbit.maxZoom) {
      this.camera.zoom = this.orbit.maxZoom;
      this.camera.updateProjectionMatrix();
    }
  }

  private readonly tick = (now: number): void => {
    const dt = Math.min(0.05, (now - (this.lastFrameAt || now)) / 1000);
    this.lastFrameAt = now;
    if (this.ready && !document.hidden) {
      if (this.orbit.update()) this.constrainCameraFraming();
      this.updateAnimation(now);
      this.updateParticles(now, dt);
      this.hall.update(now, dt, this.camera);
      this.renderer.render(this.scene, this.camera);
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private updateAnimation(now: number): void {
    const animation = this.animation;
    if (!animation) return;
    const t = Math.min(1, (now - animation.started) / animation.duration);
    const from = squarePosition(animation.move.from);
    const to = squarePosition(animation.move.to);
    if (!from || !to) { this.finishAnimation(animation); return; }
    const capture = animation.victim !== null;
    const moveFraction = capture
      ? t < 0.52 ? (t / 0.52) * 0.72 : t < 0.68 ? 0.72 : 0.72 + ((t - 0.68) / 0.32) * 0.28
      : t;
    const eased = moveFraction * moveFraction * (3 - 2 * moveFraction);
    animation.attacker.group.position.copy(from).lerp(to, eased);
    this.renderer.shadowMap.needsUpdate = true;
    const arc = animation.move.piece === 'n' ? 0.64 : animation.move.piece === 'b' || animation.move.piece === 'q' ? 0.43 : 0.24;
    animation.attacker.group.position.y += Math.sin(Math.PI * moveFraction) * arc;
    const lunge = capture ? Math.max(0, 1 - Math.abs(t - 0.61) / 0.14) : 0;
    animation.attacker.group.rotation.z = animation.move.piece === 'n' ? -0.27 * lunge : 0;
    animation.attacker.group.rotation.y = (animation.attacker.color === 'w' ? 0 : Math.PI)
      + (animation.move.piece === 'q' || animation.move.piece === 'b' ? Math.sin(Math.PI * t) * 0.55 : 0);
    if (animation.rook && animation.move.rookFrom && animation.move.rookTo) {
      const rookFrom = squarePosition(animation.move.rookFrom);
      const rookTo = squarePosition(animation.move.rookTo);
      if (rookFrom && rookTo) animation.rook.group.position.copy(rookFrom).lerp(rookTo, Math.max(0, Math.min(1, (t - 0.2) / 0.75)));
    }
    if (capture && t >= 0.53 && !animation.cast) {
      animation.cast = true;
      this.spawnSpell(animation.move, animation.attacker.group.position,
        animation.victim?.group.position ?? to);
    }
    if (capture && t >= 0.66 && !animation.shattered) {
      animation.shattered = true;
      if (animation.victim) {
        animation.victim.group.visible = false;
        this.spawnShatter(animation.victim, spellColor(animation.move));
      }
    }
    if (t >= 1) this.finishAnimation(animation);
  }

  private finishAnimation(animation: MoveAnimation): void {
    this.animation = null;
    this.setPosition(animation.next);
    this.setLastMove(animation.move.from, animation.move.to);
    if (animation.move.check || animation.move.checkmate) {
      const king = animation.next.find(piece => piece.type === 'k' && piece.color !== animation.move.color);
      this.setCheck(king?.square ?? null);
    } else this.setCheck(null);
    animation.resolve();
  }

  private updateParticles(now: number, dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]!;
      const t = (now - particle.born) / particle.life;
      if (t < 0) { particle.mesh.visible = false; continue; }
      particle.mesh.visible = true;
      if (t >= 1) {
        this.scene.remove(particle.mesh);
        particle.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      particle.material.opacity = Math.max(0, 1 - t * t);
      if (particle.kind === 'shard' || particle.kind === 'spark') {
        particle.mesh.position.addScaledVector(particle.velocity, dt);
        particle.velocity.y -= (particle.kind === 'shard' ? 2.2 : 0.35) * dt;
        particle.mesh.rotation.x += particle.rotation.x * dt;
        particle.mesh.rotation.y += particle.rotation.y * dt;
        particle.mesh.rotation.z += particle.rotation.z * dt;
        if (particle.kind === 'spark') particle.mesh.scale.copy(particle.baseScale).multiplyScalar(1 - t * 0.72);
      } else if (particle.kind === 'ring') {
        particle.mesh.scale.copy(particle.baseScale).multiplyScalar(1 + t * 2.4);
      } else if (particle.kind === 'slash') {
        particle.mesh.scale.copy(particle.baseScale).multiplyScalar(1 + t * 0.75);
        particle.mesh.rotation.z += dt * 3;
      } else {
        particle.mesh.scale.x = particle.baseScale.x * (1 - t * 0.65);
        particle.mesh.scale.z = particle.baseScale.z * (1 - t * 0.65);
      }
    }
  }

  private spawnSpell(move: BoardMove, attacker: THREE.Vector3, target: THREE.Vector3): void {
    if (this.reducedMotion) return;
    const tint = spellColor(move);
    const point = target.clone().add(new THREE.Vector3(0, 0.62, 0));
    this.spawnSparks(point, tint, move.piece === 'q' ? 34 : move.piece === 'p' ? 12 : 22, 1);
    if (move.piece === 'b' || move.piece === 'q' || move.piece === 'k') {
      this.spawnBeam(attacker.clone().add(new THREE.Vector3(0, 0.8, 0)), point, tint);
    }
    if (move.piece === 'n') {
      const slash = this.addFx(slashGeometry, tint, point, 500, 'slash');
      slash.mesh.rotation.y = this.humanColor === 'w' ? 0 : Math.PI;
      slash.mesh.rotation.z = -0.55;
    }
    if (move.piece === 'r' || move.piece === 'k' || move.piece === 'q') this.spawnRing(target, tint, move.piece === 'r' ? 1.45 : 1.15);
    if (move.piece === 'p') this.spawnRing(target, tint, 0.7);
  }

  private spawnShatter(victim: PieceVisual, tint: THREE.Color): void {
    const origin = victim.group.position;
    const bodyMaterial = pieceShardMaterial(victim.color);
    const random = seededRandom(Math.round((origin.x + 9) * 1000 + (origin.z + 9) * 337 + performance.now()));
    for (let i = 0; i < 17; i++) {
      const material = bodyMaterial.clone();
      material.transparent = true;
      material.opacity = 1;
      material.emissive.copy(tint);
      material.emissiveIntensity = victim.color === 'b' ? 0.48 : 0.23;
      if (victim.color === 'b') material.color.lerp(new THREE.Color(0x8da4c6), 0.28);
      const shard = new THREE.Mesh(shardGeometry, material);
      const angle = random() * Math.PI * 2;
      shard.position.set(origin.x + (random() - 0.5) * 0.28,
        TOP + 0.2 + random() * 0.75, origin.z + (random() - 0.5) * 0.28);
      shard.scale.set(0.95 + random() * 1.8, 1 + random() * 2.7, 0.7 + random() * 1.7);
      this.scene.add(shard);
      this.particles.push({ mesh: shard, material, born: performance.now(), life: 650 + random() * 550,
        velocity: new THREE.Vector3(Math.cos(angle) * (0.8 + random() * 1.7), 1 + random() * 2.3, Math.sin(angle) * (0.8 + random() * 1.7)),
        rotation: new THREE.Vector3(random() * 9 - 4.5, random() * 9 - 4.5, random() * 9 - 4.5),
        kind: 'shard', baseScale: shard.scale.clone() });
    }
    bodyMaterial.dispose();
    this.spawnSparks(origin.clone().setY(TOP + 0.58), tint, 28, 1.2);
    this.spawnRing(origin, tint, 1.3);
  }

  private spawnSparks(origin: THREE.Vector3, color: THREE.Color, count: number, spread: number): void {
    const random = seededRandom(Math.floor(performance.now() * 17) ^ count);
    for (let i = 0; i < count; i++) {
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false });
      const spark = new THREE.Mesh(sparkGeometry, material);
      spark.position.copy(origin);
      const size = 0.4 + random() * 1.4;
      spark.scale.setScalar(size);
      this.scene.add(spark);
      const angle = random() * Math.PI * 2;
      this.particles.push({ mesh: spark, material, born: performance.now(), life: 350 + random() * 650,
        velocity: new THREE.Vector3(Math.cos(angle) * (0.7 + random() * 2) * spread,
          (random() - 0.1) * 2.2 * spread, Math.sin(angle) * (0.7 + random() * 2) * spread),
        rotation: new THREE.Vector3(), kind: 'spark', baseScale: spark.scale.clone() });
    }
  }

  private spawnRing(position: THREE.Vector3, color: THREE.Color, scale = 1, delay = 0): void {
    const effect = this.addFx(ringGeometry, color, position.clone().setY(TOP + 0.025), 780, 'ring');
    effect.mesh.rotation.x = Math.PI / 2;
    effect.mesh.scale.setScalar(scale);
    effect.baseScale.copy(effect.mesh.scale);
    effect.born += delay;
  }

  private spawnBeam(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color): void {
    const direction = to.clone().sub(from);
    const effect = this.addFx(beamGeometry, color, from.clone().add(to).multiplyScalar(0.5), 330, 'beam');
    effect.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
    effect.mesh.scale.set(1, direction.length(), 1);
    effect.baseScale.copy(effect.mesh.scale);
  }

  private addFx(geometry: THREE.BufferGeometry, color: THREE.Color, position: THREE.Vector3,
    life: number, kind: Particle['kind']): Particle {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    this.scene.add(mesh);
    const effect: Particle = { mesh, material, born: performance.now(), life, velocity: new THREE.Vector3(),
      rotation: new THREE.Vector3(), kind, baseScale: mesh.scale.clone() };
    this.particles.push(effect);
    return effect;
  }

  private placeHighlight(key: string, square: string | null, color: number, opacity: number): void {
    if (this.highlightSquares.has(key) && this.highlightSquares.get(key) === square) return;
    this.highlightSquares.set(key, square);
    const previous = this.highlights.get(key);
    if (previous) {
      this.board.remove(previous);
      const materials = new Set<THREE.Material>();
      previous.traverse(child => {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineLoop) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) child.material.forEach(material => materials.add(material));
          else materials.add(child.material);
        }
      });
      materials.forEach(material => material.dispose());
      this.highlights.delete(key);
    }
    const position = square ? squarePosition(square) : null;
    if (!position) return;
    const group = new THREE.Group();
    const hint = key.startsWith('hint-');
    // Raise recommendation overlays clear of the textured tiles so they remain
    // legible on the light board and at the shallow camera angle on phones.
    group.position.set(position.x, TOP + (hint ? 0.012 : 0.001), position.z);
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.965, 0.965),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: hint ? Math.max(opacity, 0.42) : opacity,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: !hint }));
    fill.rotation.x = -Math.PI / 2;
    group.add(fill);
    if (hint) {
      const border = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.97,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      for (const [width, height, x, z] of [
        [0.965, 0.07, 0, -0.447], [0.965, 0.07, 0, 0.447],
        [0.07, 0.965, -0.447, 0], [0.07, 0.965, 0.447, 0],
      ]) {
        const stripe = new THREE.Mesh(new THREE.PlaneGeometry(width!, height!), border);
        stripe.rotation.x = -Math.PI / 2;
        stripe.position.set(x!, 0.014, z!);
        group.add(stripe);
      }
    }
    const points = [
      new THREE.Vector3(-0.47, 0.01, -0.47), new THREE.Vector3(0.47, 0.01, -0.47),
      new THREE.Vector3(0.47, 0.01, 0.47), new THREE.Vector3(-0.47, 0.01, 0.47),
    ];
    const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity * 3.2), depthWrite: false }));
    group.add(edge);
    this.board.add(group);
    this.highlights.set(key, group);
  }

  private replaceCoordinates(): void {
    for (const child of [...this.coordinateLayer.children]) {
      this.coordinateLayer.remove(child);
      const sprite = child as THREE.Sprite;
      (sprite.material as THREE.SpriteMaterial).map?.dispose();
      sprite.material.dispose();
    }
    const near = this.humanColor === 'w' ? 1 : -1;
    const color = this.theme === 'light' ? '#fff0c8' : '#efd9ac';
    for (let i = 0; i < 8; i++) {
      const file = this.humanColor === 'w' ? i : 7 - i;
      const fileLabel = textSprite(FILES[file]!.toUpperCase(), color);
      fileLabel.position.set(file - 3.5, 0.38, near * 4.42);
      this.coordinateLayer.add(fileLabel);
      const rank = this.humanColor === 'w' ? i + 1 : 8 - i;
      const rankLabel = textSprite(String(rank), color);
      rankLabel.position.set(-near * 4.41, 0.38, 4.5 - rank);
      this.coordinateLayer.add(rankLabel);
    }
  }

  private createBoard(): void {
    const stone = new THREE.MeshStandardMaterial({ color: 0x273a54, roughness: 0.48, metalness: 0.20 });
    const underStone = new THREE.MeshStandardMaterial({ color: 0x16263b, roughness: 0.62, metalness: 0.12 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xb28954, roughness: 0.3, metalness: 0.72 });
    const redInset = new THREE.MeshStandardMaterial({ color: 0x9d2c4d, roughness: 0.25, metalness: 0.42,
      emissive: 0x8e0b25, emissiveIntensity: 0.55 });
    const under = new THREE.Mesh(new RoundedBoxGeometry(9.45, 0.30, 9.45, 3, 0.12), underStone);
    under.position.y = -0.27;
    under.castShadow = true;
    under.receiveShadow = true;
    this.board.add(under);
    const plinth = new THREE.Mesh(new RoundedBoxGeometry(9.15, 0.48, 9.15, 3, 0.09), stone);
    plinth.position.y = -0.015;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    this.board.add(plinth);
    const ribbon = new THREE.Mesh(new RoundedBoxGeometry(8.86, 0.055, 8.86, 2, 0.025), metal);
    ribbon.position.y = 0.255;
    this.board.add(ribbon);
    const inlay = new THREE.Mesh(new THREE.BoxGeometry(8.43, 0.07, 8.43), redInset);
    inlay.position.y = 0.315;
    this.board.add(inlay);
    const lightMaterial = new THREE.MeshStandardMaterial({ map: marbleTexture(true), roughness: 0.48, metalness: 0.05 });
    const darkMaterial = new THREE.MeshStandardMaterial({ map: marbleTexture(false), roughness: 0.38, metalness: 0.15 });
    this.boardMaterials = { stone, underStone, metal, inset: redInset,
      lightTile: lightMaterial, darkTile: darkMaterial };
    const tileGeometry = new THREE.BoxGeometry(0.994, 0.047, 0.994);
    const lightTiles = new THREE.InstancedMesh(tileGeometry, lightMaterial, 32);
    const darkTiles = new THREE.InstancedMesh(tileGeometry, darkMaterial, 32);
    const tile = new THREE.Object3D();
    let lightIndex = 0;
    let darkIndex = 0;
    for (let rank = 1; rank <= 8; rank++) for (let file = 0; file < 8; file++) {
      tile.position.set(file - 3.5, 0.372, 4.5 - rank);
      tile.rotation.y = ((file * 3 + rank * 7) % 4) * Math.PI / 2;
      tile.updateMatrix();
      if ((file + rank) % 2) darkTiles.setMatrixAt(darkIndex++, tile.matrix);
      else lightTiles.setMatrixAt(lightIndex++, tile.matrix);
    }
    lightTiles.instanceMatrix.needsUpdate = true;
    darkTiles.instanceMatrix.needsUpdate = true;
    lightTiles.receiveShadow = true;
    darkTiles.receiveShadow = true;
    this.board.add(lightTiles, darkTiles);
    // An illuminated groove and four corner seals make the board feel like a magical artifact.
    const groove = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-4.08, 0.405, -4.08), new THREE.Vector3(4.08, 0.405, -4.08),
      new THREE.Vector3(4.08, 0.405, 4.08), new THREE.Vector3(-4.08, 0.405, 4.08),
    ]), new THREE.LineBasicMaterial({ color: 0xe82d48, transparent: true, opacity: 0.72 }));
    this.board.add(groove);
    for (const x of [-4.35, 4.35]) for (const z of [-4.35, 4.35]) {
      const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.24, 0.14, 8), metal);
      socket.position.set(x, 0.35, z);
      this.board.add(socket);
      const jewel = new THREE.Mesh(new THREE.OctahedronGeometry(0.11), redInset);
      jewel.position.set(x, 0.46, z);
      jewel.rotation.y = Math.PI / 4;
      this.board.add(jewel);
    }
    for (let i = -3; i <= 3; i++) {
      for (const z of [-4.23, 4.23]) {
        const rune = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.008, 0.10), redInset);
        rune.position.set(i * 1.12, 0.37, z);
        rune.rotation.y = i * 0.15;
        this.board.add(rune);
      }
    }
  }

}
