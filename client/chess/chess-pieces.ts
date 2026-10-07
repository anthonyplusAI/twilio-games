import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type ChessColor = 'w' | 'b';
export type ChessPieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

const ivory = new THREE.MeshPhysicalMaterial({
  color: 0xf0e7d3, roughness: 0.31, metalness: 0.16, clearcoat: 0.6, clearcoatRoughness: 0.16,
});
const obsidian = new THREE.MeshPhysicalMaterial({
  color: 0x18243b, roughness: 0.23, metalness: 0.46, clearcoat: 0.74, clearcoatRoughness: 0.13,
});
const ivoryShadow = new THREE.MeshStandardMaterial({ color: 0x9e9486, roughness: 0.46, metalness: 0.12 });
const obsidianShadow = new THREE.MeshStandardMaterial({ color: 0x0a1021, roughness: 0.36, metalness: 0.4 });
const antiqueGold = new THREE.MeshStandardMaterial({ color: 0xd5a866, roughness: 0.31, metalness: 0.79 });
const ruby = new THREE.MeshStandardMaterial({ color: 0xf62f4d, roughness: 0.16, metalness: 0.23, emissive: 0xb50c27, emissiveIntensity: 0.5 });
const sapphire = new THREE.MeshStandardMaterial({ color: 0x54b9f5, roughness: 0.19, metalness: 0.32, emissive: 0x134ba6, emissiveIntensity: 0.42 });

const latheCache = new Map<string, THREE.LatheGeometry>();
const shapeCache = new Map<string, THREE.BufferGeometry>();
const sphere = new THREE.SphereGeometry(1, 20, 12);
const smallSphere = new THREE.SphereGeometry(1, 12, 8);
const cone = new THREE.ConeGeometry(1, 1, 12);
const box = new THREE.BoxGeometry(1, 1, 1);
const pieceGeometryCache = new Map<string, readonly { geometry: THREE.BufferGeometry; material: THREE.Material }[]>();

function profile(name: string, points: readonly (readonly [number, number])[]): THREE.LatheGeometry {
  let result = latheCache.get(name);
  if (!result) {
    result = new THREE.LatheGeometry(points.map(([radius, y]) => new THREE.Vector2(radius, y)), 32);
    result.computeVertexNormals();
    latheCache.set(name, result);
  }
  return result;
}

function add(parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material,
  position: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function band(parent: THREE.Group, radius: number, y: number, material: THREE.Material, tube = 0.018): void {
  const key = `band:${radius}:${tube}`;
  let geometry = shapeCache.get(key);
  if (!geometry) {
    geometry = new THREE.TorusGeometry(radius, tube, 7, 28);
    shapeCache.set(key, geometry);
  }
  const mesh = add(parent, geometry, material, [0, y, 0]);
  mesh.rotation.x = Math.PI / 2;
}

function commonFoot(group: THREE.Group, body: THREE.Material, shade: THREE.Material,
  accent: THREE.Material): void {
  add(group, profile('foot', [
    [0, 0.025], [0.26, 0.025], [0.33, 0.045], [0.38, 0.10], [0.38, 0.145],
    [0.34, 0.18], [0.27, 0.22], [0.255, 0.275], [0, 0.275],
  ]), body);
  band(group, 0.373, 0.137, antiqueGold, 0.014);
  band(group, 0.27, 0.245, shade, 0.013);
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    add(group, smallSphere, accent, [Math.sin(angle) * 0.31, 0.164, Math.cos(angle) * 0.31], [0.027, 0.027, 0.027]);
  }
}

function makePawn(group: THREE.Group, body: THREE.Material, accent: THREE.Material): void {
  add(group, profile('pawn-stem', [
    [0, 0.25], [0.245, 0.25], [0.205, 0.33], [0.155, 0.56], [0.185, 0.69],
    [0.195, 0.74], [0.15, 0.78], [0, 0.78],
  ]), body);
  band(group, 0.19, 0.73, antiqueGold, 0.014);
  add(group, sphere, body, [0, 0.94, 0], [0.18, 0.18, 0.18]);
  add(group, smallSphere, accent, [0, 1.125, 0], [0.052, 0.052, 0.052]);
}

function makeRook(group: THREE.Group, body: THREE.Material, shade: THREE.Material,
  accent: THREE.Material): void {
  add(group, profile('rook-tower', [
    [0, 0.25], [0.23, 0.25], [0.245, 0.34], [0.19, 0.43], [0.17, 0.80],
    [0.25, 0.86], [0.28, 0.93], [0.28, 0.98], [0, 0.98],
  ]), body);
  band(group, 0.276, 0.91, antiqueGold, 0.018);
  add(group, profile('rook-hollow', [[0, 0.989], [0.185, 0.989], [0.185, 1.006], [0, 1.006]]), shade);
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    const battlement = add(group, box, body,
      [Math.sin(angle) * 0.235, 1.072, Math.cos(angle) * 0.235], [0.16, 0.16, 0.12]);
    battlement.rotation.y = angle;
  }
  add(group, smallSphere, accent, [0, 1.018, 0], [0.066, 0.038, 0.066]);
}

function makeBishop(group: THREE.Group, body: THREE.Material, shade: THREE.Material,
  accent: THREE.Material): void {
  add(group, profile('bishop-body', [
    [0, 0.25], [0.24, 0.25], [0.20, 0.34], [0.135, 0.69], [0.18, 0.76],
    [0.23, 0.82], [0.23, 0.86], [0, 0.86],
  ]), body);
  band(group, 0.224, 0.833, antiqueGold, 0.017);
  add(group, sphere, body, [0, 1.07, 0], [0.195, 0.305, 0.175]);
  const slash = add(group, box, shade, [0.005, 1.10, 0.172], [0.07, 0.29, 0.017]);
  slash.rotation.z = 0.56;
  const backSlash = add(group, box, shade, [0.005, 1.10, -0.172], [0.07, 0.29, 0.017]);
  backSlash.rotation.z = 0.56;
  add(group, cone, accent, [0, 1.402, 0], [0.075, 0.18, 0.075]);
}

function knightGeometry(): THREE.BufferGeometry {
  let geometry = shapeCache.get('knight-head');
  if (geometry) return geometry;
  const shape = new THREE.Shape();
  shape.moveTo(-0.27, 0.36);
  shape.lineTo(0.20, 0.36);
  shape.lineTo(0.17, 0.51);
  shape.quadraticCurveTo(0.04, 0.59, 0.02, 0.72);
  shape.lineTo(0.11, 0.85);
  shape.lineTo(0.32, 0.88);
  shape.lineTo(0.39, 0.99);
  shape.lineTo(0.25, 1.065);
  shape.lineTo(0.10, 1.055);
  shape.lineTo(0.035, 1.20);
  shape.lineTo(-0.055, 1.28);
  shape.lineTo(-0.13, 1.13);
  shape.lineTo(-0.19, 1.15);
  shape.quadraticCurveTo(-0.20, 0.96, -0.28, 0.84);
  shape.lineTo(-0.36, 0.58);
  shape.lineTo(-0.27, 0.36);
  geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.32, steps: 1, bevelEnabled: true, bevelThickness: 0.035,
    bevelSize: 0.035, bevelSegments: 2, curveSegments: 6,
  });
  geometry.translate(0, 0, -0.16);
  geometry.computeVertexNormals();
  shapeCache.set('knight-head', geometry);
  return geometry;
}

function makeKnight(group: THREE.Group, body: THREE.Material, shade: THREE.Material,
  accent: THREE.Material): void {
  add(group, knightGeometry(), body);
  for (const side of [-1, 1]) {
    add(group, smallSphere, shade, [0.14, 0.995, side * 0.205], [0.038, 0.043, 0.025]);
    add(group, smallSphere, accent, [0.145, 1.0, side * 0.227], [0.015, 0.019, 0.013]);
    const rein = add(group, box, antiqueGold, [0.257, 0.886, side * 0.207], [0.20, 0.019, 0.013]);
    rein.rotation.z = -0.25;
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const mane = add(group, cone, shade, [-0.215 - t * 0.045, 1.075 - t * 0.14, side * 0.08],
        [0.065, 0.14, 0.075]);
      mane.rotation.z = -0.62;
    }
  }
  band(group, 0.265, 0.265, antiqueGold, 0.016);
}

function makeQueen(group: THREE.Group, body: THREE.Material, accent: THREE.Material): void {
  add(group, profile('queen-body', [
    [0, 0.25], [0.24, 0.25], [0.205, 0.36], [0.16, 0.66], [0.19, 0.78],
    [0.275, 0.86], [0.285, 0.92], [0.20, 0.96], [0.20, 1.04], [0, 1.04],
  ]), body);
  band(group, 0.275, 0.905, antiqueGold, 0.017);
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 2 / 5;
    const x = Math.sin(angle) * 0.22;
    const z = Math.cos(angle) * 0.22;
    const spike = add(group, cone, body, [x, 1.105, z], [0.084, 0.24, 0.084]);
    spike.rotation.z = -Math.sin(angle) * 0.20;
    spike.rotation.x = Math.cos(angle) * 0.20;
    add(group, smallSphere, accent, [x * 1.08, 1.245, z * 1.08], [0.044, 0.044, 0.044]);
  }
  add(group, sphere, accent, [0, 1.105, 0], [0.10, 0.10, 0.10]);
}

function makeKing(group: THREE.Group, body: THREE.Material, accent: THREE.Material): void {
  add(group, profile('king-body', [
    [0, 0.25], [0.25, 0.25], [0.22, 0.37], [0.17, 0.69], [0.19, 0.83],
    [0.29, 0.90], [0.30, 0.97], [0.22, 1.01], [0.22, 1.12], [0, 1.12],
  ]), body);
  band(group, 0.292, 0.942, antiqueGold, 0.019);
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    add(group, sphere, accent, [Math.sin(angle) * 0.22, 1.13, Math.cos(angle) * 0.22],
      [0.074, 0.074, 0.074]);
  }
  add(group, box, antiqueGold, [0, 1.34, 0], [0.085, 0.40, 0.085]);
  add(group, box, antiqueGold, [0, 1.385, 0], [0.32, 0.085, 0.085]);
  add(group, smallSphere, accent, [0, 1.555, 0], [0.06, 0.06, 0.06]);
}

function sculptPiece(type: ChessPieceType, color: ChessColor): THREE.Group {
  const group = new THREE.Group();
  const body = color === 'w' ? ivory : obsidian;
  const shade = color === 'w' ? ivoryShadow : obsidianShadow;
  const accent = color === 'w' ? ruby : sapphire;
  commonFoot(group, body, shade, accent);
  switch (type) {
    case 'p': makePawn(group, body, accent); break;
    case 'r': makeRook(group, body, shade, accent); break;
    case 'n': makeKnight(group, body, shade, accent); break;
    case 'b': makeBishop(group, body, shade, accent); break;
    case 'q': makeQueen(group, body, accent); break;
    case 'k': makeKing(group, body, accent); break;
  }
  group.userData = { type, color };
  return group;
}

/** Merge fixed sculptural details once, leaving only a few draws per animated piece. */
export function createChessPiece(type: ChessPieceType, color: ChessColor): THREE.Group {
  const key = `${color}:${type}`;
  let meshes = pieceGeometryCache.get(key);
  if (!meshes) {
    const sculpture = sculptPiece(type, color);
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    sculpture.updateMatrixWorld(true);
    sculpture.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const material = object.material as THREE.Material;
      let baked = object.geometry.clone();
      baked.applyMatrix4(object.matrixWorld);
      if (baked.index) {
        const expanded = baked.toNonIndexed();
        baked.dispose();
        baked = expanded;
      }
      const geometries = byMaterial.get(material) ?? [];
      geometries.push(baked);
      byMaterial.set(material, geometries);
    });
    const merged: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
    for (const [material, geometries] of byMaterial) {
      const geometry = mergeGeometries(geometries, false);
      geometries.forEach(item => item.dispose());
      if (!geometry) throw new Error(`Could not merge ${key} chess geometry.`);
      merged.push({ geometry, material });
    }
    meshes = merged;
    pieceGeometryCache.set(key, meshes);
  }
  const group = new THREE.Group();
  for (const { geometry, material } of meshes) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData = { type, color };
  return group;
}

export function pieceShardMaterial(color: ChessColor): THREE.MeshStandardMaterial {
  return (color === 'w' ? ivory : obsidian).clone();
}

export function pieceSpellColor(color: ChessColor): THREE.Color {
  return new THREE.Color(color === 'w' ? 0xf22f48 : 0x6bc5ff);
}
