import * as THREE from 'three';

export type ChessTheme = 'light' | 'dark';

const PALETTES = {
  light: {
    sky: 0xaab7c6, fog: 0xaab7c6, floor: 0x565d66, floorTile: 0x77756d,
    floorAlternate: 0x576474, masonry: 0xb7ac9c, stoneShade: 0x737d89,
    brass: 0xa27a47, glass: 0x4f9bc6, seal: 0xc3e8ef, flame: 0xffb35e,
    dust: 0xffe2ad, ambientSky: 0xf5f0e4, ambientGround: 0x6c7387,
    key: 0xfff5df, keyIntensity: 1.9, hemiIntensity: 1.26,
    warmIntensity: 16, coolIntensity: 10, glassOpacity: 0.86,
  },
  dark: {
    sky: 0x080e20, fog: 0x101a32, floor: 0x101a2d, floorTile: 0x273149,
    floorAlternate: 0x1b2940, masonry: 0x394760, stoneShade: 0x222f48,
    brass: 0xad8158, glass: 0x274a91, seal: 0x78d2f2, flame: 0xff9a58,
    dust: 0xafd9ff, ambientSky: 0xabc9ed, ambientGround: 0x261a31,
    key: 0xe0e8ff, keyIntensity: 2.35, hemiIntensity: 1.55,
    warmIntensity: 18, coolIntensity: 17, glassOpacity: 0.88,
  },
} as const;

function pointedShape(width: number, height: number, foot = 0): THREE.Shape {
  const half = width / 2;
  const shoulder = height * 0.71;
  const shape = new THREE.Shape();
  shape.moveTo(-half, foot);
  shape.lineTo(half, foot);
  shape.lineTo(half, shoulder);
  shape.quadraticCurveTo(half * 0.85, height * 0.87, 0, height);
  shape.quadraticCurveTo(-half * 0.85, height * 0.87, -half, shoulder);
  shape.closePath();
  return shape;
}

function archFrameGeometry(): THREE.ExtrudeGeometry {
  const outer = pointedShape(3.96, 6.25);
  const opening = pointedShape(2.57, 5.0, 0.85);
  outer.holes.push(new THREE.Path(opening.getPoints(16)));
  const geometry = new THREE.ExtrudeGeometry(outer, {
    depth: 0.34, steps: 1, bevelEnabled: true, bevelSize: 0.06,
    bevelThickness: 0.045, bevelSegments: 1, curveSegments: 12,
  });
  geometry.computeVertexNormals();
  return geometry;
}

function ring(radius: number, tube: number, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 5, 96), material);
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

interface HallWall {
  axis: 'x' | 'z';
  sign: -1 | 1;
  group: THREE.Group;
}

interface CandleField {
  direction: THREE.Vector3;
  group: THREE.Group;
}

/** All scenery is procedural so the playable board needs no network assets. */
export class ChessHall {
  private readonly group = new THREE.Group();
  private readonly walls: HallWall[] = [];
  private readonly candleFields: CandleField[] = [];
  private readonly seals: THREE.Group[] = [];
  private readonly dustPositions: Float32Array;
  private readonly dust: THREE.Points;
  private readonly hemi = new THREE.HemisphereLight();
  private readonly key = new THREE.DirectionalLight();
  private readonly warm = new THREE.PointLight();
  private readonly cool = new THREE.PointLight();
  private readonly floorMat = new THREE.MeshStandardMaterial({ roughness: 0.96 });
  private readonly floorTileMat = new THREE.MeshStandardMaterial({ roughness: 0.87, metalness: 0.03 });
  private readonly floorAltMat = new THREE.MeshStandardMaterial({ roughness: 0.87, metalness: 0.03 });
  private readonly wallMat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.04 });
  private readonly stoneShadeMat = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.03 });
  private readonly brassMat = new THREE.MeshStandardMaterial({ roughness: 0.36, metalness: 0.67 });
  private readonly glassMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false,
    side: THREE.DoubleSide });
  private readonly sealMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  private readonly rubyGlassMat = new THREE.MeshBasicMaterial({ color: 0xb43d62,
    transparent: true, opacity: 0.83, side: THREE.DoubleSide, depthWrite: false });
  private readonly bannerMat = new THREE.MeshStandardMaterial({ color: 0x922e4e,
    roughness: 0.92, side: THREE.DoubleSide });
  private readonly crystalMat = new THREE.MeshStandardMaterial({ color: 0x9fd5e9,
    emissive: 0x5cabc8, emissiveIntensity: 0.64, metalness: 0.24, roughness: 0.2 });
  private readonly candleMat = new THREE.MeshStandardMaterial({ color: 0xf5e8d1, roughness: 0.88 });
  private readonly flameMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  private readonly haloMat = new THREE.PointsMaterial({ color: 0xffcf8c, size: 0.38,
    sizeAttenuation: true, transparent: true, opacity: 0.53, depthWrite: false,
    blending: THREE.AdditiveBlending });
  private readonly dustMat = new THREE.PointsMaterial({ size: 0.065, sizeAttenuation: true,
    transparent: true, opacity: 0.66, depthWrite: false, blending: THREE.AdditiveBlending });
  private readonly floorLinesMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.53 });
  private readonly floorGlowMat = new THREE.MeshBasicMaterial({ transparent: true,
    opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  private readonly windowLightMat = new THREE.MeshBasicMaterial({ transparent: true,
    opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });

  constructor(private readonly scene: THREE.Scene, private readonly lowPower: boolean,
    private readonly reducedMotion: boolean) {
    this.group.name = 'Enchanted chess hall';
    this.createFloor();
    this.createWards();
    this.createWalls();
    this.createCandles();
    const { points, positions } = this.createDust();
    this.dust = points;
    this.dustPositions = positions;
    this.group.add(this.dust);

    this.hemi.position.set(0, 8, 0);
    this.group.add(this.hemi);
    this.key.position.set(-5, 12, 8);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(lowPower ? 1024 : 2048, lowPower ? 1024 : 2048);
    this.key.shadow.camera.left = -12;
    this.key.shadow.camera.right = 12;
    this.key.shadow.camera.top = 12;
    this.key.shadow.camera.bottom = -12;
    this.key.shadow.bias = -0.00012;
    this.group.add(this.key);
    this.warm.position.set(-6.4, 3.8, -2.7);
    this.warm.distance = 14;
    this.warm.decay = 2;
    this.group.add(this.warm);
    this.cool.position.set(6.5, 4.1, -3.1);
    this.cool.distance = 14;
    this.cool.decay = 2;
    this.group.add(this.cool);
    this.scene.add(this.group);
    this.setTheme('light');
  }

  setTheme(theme: ChessTheme): void {
    const palette = PALETTES[theme];
    this.scene.background = new THREE.Color(palette.sky);
    this.scene.fog = new THREE.FogExp2(palette.fog, theme === 'light' ? 0.009 : 0.018);
    this.floorMat.color.setHex(palette.floor);
    this.floorTileMat.color.setHex(palette.floorTile);
    this.floorAltMat.color.setHex(palette.floorAlternate);
    this.wallMat.color.setHex(palette.masonry);
    this.stoneShadeMat.color.setHex(palette.stoneShade);
    this.brassMat.color.setHex(palette.brass);
    this.glassMat.color.setHex(palette.glass);
    this.glassMat.opacity = palette.glassOpacity;
    this.sealMat.color.setHex(palette.seal);
    this.rubyGlassMat.color.setHex(theme === 'light' ? 0xb43d62 : 0xad3154);
    this.bannerMat.color.setHex(theme === 'light' ? 0x922e4e : 0x742a49);
    this.crystalMat.color.setHex(theme === 'light' ? 0xa5d5e6 : 0x78c9ee);
    this.crystalMat.emissive.setHex(theme === 'light' ? 0x5cabc8 : 0x286da4);
    this.flameMat.color.setHex(palette.flame);
    this.haloMat.color.setHex(palette.flame);
    this.dustMat.color.setHex(palette.dust);
    this.floorLinesMat.color.setHex(theme === 'light' ? 0x376987 : 0x80c8e4);
    this.floorGlowMat.color.setHex(theme === 'light' ? 0x3b9cba : 0x40b4e7);
    this.floorGlowMat.opacity = theme === 'light' ? 0.20 : 0.31;
    this.windowLightMat.color.setHex(palette.glass);
    this.windowLightMat.opacity = theme === 'light' ? 0.14 : 0.19;
    this.hemi.color.setHex(palette.ambientSky);
    this.hemi.groundColor.setHex(palette.ambientGround);
    this.hemi.intensity = palette.hemiIntensity;
    this.key.color.setHex(palette.key);
    this.key.intensity = palette.keyIntensity;
    this.warm.color.setHex(palette.flame);
    this.warm.intensity = palette.warmIntensity;
    this.cool.color.setHex(palette.seal);
    this.cool.intensity = palette.coolIntensity;
  }

  update(now: number, dt: number, camera: THREE.Camera): void {
    // An open near side keeps the scene grand without scenery covering chess moves.
    for (const wall of this.walls) {
      const cameraAxis = wall.axis === 'x' ? camera.position.x : camera.position.z;
      wall.group.visible = wall.sign * cameraAxis < 0;
    }
    for (const candles of this.candleFields) {
      candles.group.visible = candles.direction.dot(camera.position) < 9;
    }
    if (this.reducedMotion) return;
    for (let i = 0; i < this.seals.length; i++) {
      const seal = this.seals[i]!;
      seal.rotation.z = Math.sin(now * 0.00016 + i * 0.9) * 0.13;
    }
    this.flameMat.opacity = 0.91 + Math.sin(now * 0.0043) * 0.08;
    if (this.lowPower && Math.floor(now / 90) === Math.floor((now - dt * 1000) / 90)) return;
    for (let i = 1; i < this.dustPositions.length; i += 3) {
      this.dustPositions[i] = (this.dustPositions[i] ?? 0) + dt * (i % 4 === 0 ? 0.12 : 0.075);
      if ((this.dustPositions[i] ?? 0) > 7.8) this.dustPositions[i] = -0.6;
    }
    (this.dust.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments) {
        geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        objectMaterials.forEach(material => materials.add(material));
      }
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
  }

  private createFloor(): void {
    const floor = new THREE.Mesh(new THREE.CircleGeometry(18, 80), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.84;
    floor.receiveShadow = true;
    this.group.add(floor);
    const lightTiles: THREE.Matrix4[] = [];
    const darkTiles: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    for (let x = -14; x <= 14; x += 1.42) for (let z = -14; z <= 14; z += 1.42) {
      const radius = Math.hypot(x, z);
      if (radius < 5.45 || radius > 14.0) continue;
      dummy.position.set(x, -0.79, z);
      dummy.rotation.y = 0;
      dummy.updateMatrix();
      const index = Math.round((x + 14) / 1.42) + Math.round((z + 14) / 1.42);
      (index % 2 ? darkTiles : lightTiles).push(dummy.matrix.clone());
    }
    const tileGeometry = new THREE.BoxGeometry(1.37, 0.075, 1.37);
    for (const [matrices, material] of [[lightTiles, this.floorTileMat], [darkTiles, this.floorAltMat]] as const) {
      const tiles = new THREE.InstancedMesh(tileGeometry, material, matrices.length);
      matrices.forEach((matrix, index) => tiles.setMatrixAt(index, matrix));
      tiles.instanceMatrix.needsUpdate = true;
      tiles.receiveShadow = true;
      this.group.add(tiles);
    }
    for (const radius of [5.7, 6.0, 9.4, 11.0]) {
      const inlay = ring(radius, radius === 6.0 ? 0.026 : 0.018, this.brassMat);
      inlay.position.y = -0.735;
      this.group.add(inlay);
    }
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < 32; i++) {
      const a = i * Math.PI / 16;
      const inner = new THREE.Vector3(Math.sin(a) * 6.1, -0.729, Math.cos(a) * 6.1);
      const outer = new THREE.Vector3(Math.sin(a) * (i % 4 === 0 ? 6.72 : 6.39),
        -0.729, Math.cos(a) * (i % 4 === 0 ? 6.72 : 6.39));
      points.push(inner, outer);
    }
    this.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), this.floorLinesMat));
    const innerGlow = new THREE.Mesh(new THREE.RingGeometry(5.89, 6.03, 96), this.floorGlowMat);
    innerGlow.rotation.x = -Math.PI / 2;
    innerGlow.position.y = -0.727;
    this.group.add(innerGlow);
    const runes: THREE.Vector3[] = [];
    for (let i = 0; i < 20; i++) {
      const angle = (i + 0.5) * Math.PI / 10;
      const tangent = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle));
      const radial = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
      const center = radial.clone().multiplyScalar(6.65).setY(-0.726);
      const tip = center.clone().addScaledVector(radial, 0.26);
      const left = center.clone().addScaledVector(tangent, -0.17);
      const right = center.clone().addScaledVector(tangent, 0.17);
      runes.push(tip, left, left, right, right, tip);
      if (i % 2 === 0) {
        const stem = center.clone().addScaledVector(radial, -0.24);
        runes.push(center, stem);
      }
    }
    this.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(runes), this.floorLinesMat));
    // Broad, low-opacity window reflections imply enchanted light without post-processing.
    const reflectionGeometry = new THREE.PlaneGeometry(1.7, 5.1);
    for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      const reflection = new THREE.Mesh(reflectionGeometry, this.windowLightMat);
      reflection.rotation.set(-Math.PI / 2, 0, angle);
      reflection.position.set(Math.sin(angle) * 8.9, -0.719, Math.cos(angle) * 8.9);
      this.group.add(reflection);
    }
  }

  private createWards(): void {
    const crystalGeometry = new THREE.OctahedronGeometry(0.44, 0);
    const plinthGeometry = new THREE.CylinderGeometry(0.4, 0.47, 0.42, 8);
    for (const [x, z] of [[-6.05, 0], [6.05, 0], [0, -6.05], [0, 6.05]] as const) {
      const ward = new THREE.Group();
      ward.position.set(x, -0.76, z);
      const plinth = new THREE.Mesh(plinthGeometry, this.stoneShadeMat);
      plinth.position.y = 0.22;
      ward.add(plinth);
      const crystal = new THREE.Mesh(crystalGeometry, this.crystalMat);
      crystal.position.y = 0.92;
      crystal.scale.set(0.72, 1.65, 0.72);
      crystal.rotation.y = Math.PI / 4;
      ward.add(crystal);
      const circlet = ring(0.32, 0.023, this.brassMat);
      circlet.position.y = 0.75;
      ward.add(circlet);
      const baseHalo = ring(0.69, 0.035, this.floorGlowMat);
      baseHalo.position.y = 0.07;
      ward.add(baseHalo);
      this.group.add(ward);
    }
  }

  private createWalls(): void {
    const frameGeometry = archFrameGeometry();
    const glassGeometry = new THREE.ShapeGeometry(pointedShape(2.51, 4.93, 0.88), 12);
    const bayIndices = this.lowPower ? [-1, 0, 1] : [-2, -1, 0, 1, 2];
    const wallWidth = bayIndices.length * 3.95 + 0.85;
    const lozengeShape = new THREE.Shape();
    lozengeShape.moveTo(0, 1.52);
    lozengeShape.lineTo(0.5, 2.58);
    lozengeShape.lineTo(0, 3.62);
    lozengeShape.lineTo(-0.5, 2.58);
    lozengeShape.closePath();
    const lozengeGeometry = new THREE.ShapeGeometry(lozengeShape);
    const bannerShape = new THREE.Shape();
    bannerShape.moveTo(-0.39, 0);
    bannerShape.lineTo(0.39, 0);
    bannerShape.lineTo(0.39, -1.72);
    bannerShape.lineTo(0, -2.04);
    bannerShape.lineTo(-0.39, -1.72);
    bannerShape.closePath();
    const bannerGeometry = new THREE.ShapeGeometry(bannerShape);
    for (const axis of ['x', 'z'] as const) for (const sign of [-1, 1] as const) {
      const wall = new THREE.Group();
      if (axis === 'z') {
        wall.position.set(0, -0.77, sign * 7.8);
        wall.rotation.y = sign < 0 ? 0 : Math.PI;
      } else {
        wall.position.set(sign * 7.8, -0.77, 0);
        wall.rotation.y = sign < 0 ? Math.PI / 2 : -Math.PI / 2;
      }
      for (const bay of bayIndices) {
        const x = bay * 3.95;
        const frame = new THREE.Mesh(frameGeometry, this.wallMat);
        frame.position.x = x;
        wall.add(frame);
        const glass = new THREE.Mesh(glassGeometry, this.glassMat);
        glass.position.set(x, 0, -0.12);
        wall.add(glass);
        if (bay !== 0) {
          const lozenge = new THREE.Mesh(lozengeGeometry, this.rubyGlassMat);
          lozenge.position.set(x, 0, -0.08);
          wall.add(lozenge);
        }
        const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.055, 3.7, 0.065), this.brassMat);
        mullion.position.set(x, 2.68, 0.42);
        wall.add(mullion);
        const rose = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 5, 30), this.brassMat);
        rose.position.set(x, 4.15, 0.43);
        wall.add(rose);
      }
      const foundation = new THREE.Mesh(new THREE.BoxGeometry(wallWidth, 0.72, 0.75), this.stoneShadeMat);
      foundation.position.set(0, 0.12, 0.14);
      wall.add(foundation);
      const cornice = new THREE.Mesh(new THREE.BoxGeometry(wallWidth + 0.6, 0.35, 0.8), this.brassMat);
      cornice.position.set(0, 6.28, 0.12);
      wall.add(cornice);
      for (const c of bayIndices) {
        const crown = new THREE.Mesh(new THREE.OctahedronGeometry(0.23), this.sealMat);
        crown.position.set(c * 3.95, 6.57, 0.45);
        wall.add(crown);
      }
      const seal = this.createSeal();
      seal.position.set(0, 3.72, 0.55);
      wall.add(seal);
      this.seals.push(seal);
      const bannerPositions = this.lowPower ? [-1.98, 1.98] : [-5.93, -1.98, 1.98, 5.93];
      for (const x of bannerPositions) {
        const banner = new THREE.Mesh(bannerGeometry, this.bannerMat);
        banner.position.set(x, 6.02, 0.56);
        wall.add(banner);
        const crest = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), this.brassMat);
        crest.position.set(x, 5.31, 0.59);
        wall.add(crest);
      }
      this.group.add(wall);
      this.walls.push({ axis, sign, group: wall });
    }
  }

  private createSeal(): THREE.Group {
    const seal = new THREE.Group();
    for (const [radius, tube] of [[0.68, 0.035], [0.95, 0.022]] as const) {
      seal.add(new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 5, 48), this.sealMat));
    }
    seal.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 0), this.sealMat));
    const diamonds = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.08), this.sealMat, 12);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6;
      dummy.position.set(Math.cos(a) * 0.82, Math.sin(a) * 0.82, 0);
      dummy.rotation.z = a;
      dummy.updateMatrix();
      diamonds.setMatrixAt(i, dummy.matrix);
    }
    diamonds.instanceMatrix.needsUpdate = true;
    seal.add(diamonds);
    return seal;
  }

  private createCandles(): void {
    const bodyGeometry = new THREE.CylinderGeometry(0.07, 0.075, 0.42, 8);
    const flameGeometry = new THREE.ConeGeometry(0.085, 0.28, 7);
    const perField = this.lowPower ? 4 : 7;
    const dummy = new THREE.Object3D();
    for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const field = new THREE.Group();
      const bodies = new THREE.InstancedMesh(bodyGeometry, this.candleMat, perField);
      const flames = new THREE.InstancedMesh(flameGeometry, this.flameMat, perField);
      const haloPositions = new Float32Array(perField * 3);
      for (let i = 0; i < perField; i++) {
        const t = (i + 0.5) / perField;
        const angle = t * Math.PI / 2;
        const radius = 7.05 + ((i * 7) % 5) * 0.39;
        const x = sx * Math.cos(angle) * radius;
        const z = sz * Math.sin(angle) * radius;
        const height = 2.5 + ((i * 11 + (sx + 2) * 3) % 7) * 0.37;
        dummy.position.set(x, height, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        bodies.setMatrixAt(i, dummy.matrix);
        dummy.position.y += 0.34;
        dummy.updateMatrix();
        flames.setMatrixAt(i, dummy.matrix);
        haloPositions[i * 3] = x;
        haloPositions[i * 3 + 1] = dummy.position.y;
        haloPositions[i * 3 + 2] = z;
      }
      bodies.instanceMatrix.needsUpdate = true;
      flames.instanceMatrix.needsUpdate = true;
      const haloGeometry = new THREE.BufferGeometry();
      haloGeometry.setAttribute('position', new THREE.BufferAttribute(haloPositions, 3));
      field.add(bodies, flames, new THREE.Points(haloGeometry, this.haloMat));
      this.group.add(field);
      this.candleFields.push({ direction: new THREE.Vector3(sx, 0, sz).normalize(), group: field });
    }
  }

  private createDust(): { points: THREE.Points; positions: Float32Array } {
    const count = this.lowPower ? 50 : 115;
    const positions = new Float32Array(count * 3);
    let seed = 0x172637;
    const random = (): number => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2;
      const radius = 5.3 + random() * 8.4;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = random() * 8.2 - 0.5;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return { points: new THREE.Points(geometry, this.dustMat), positions };
  }
}
