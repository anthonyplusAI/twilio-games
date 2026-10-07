import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

type ProfileStation = { z: number; halfWidth: number; bottom: number; top: number };

/** A low-poly body with a real silhouette, rather than a stack of rectangular boxes. */
function profileGeometry(stations: readonly ProfileStation[]): THREE.BufferGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const station of stations) {
    vertices.push(
      -station.halfWidth, station.bottom, station.z,
       station.halfWidth, station.bottom, station.z,
      -station.halfWidth, station.top, station.z,
       station.halfWidth, station.top, station.z,
    );
  }
  for (let i = 0; i < stations.length - 1; i++) {
    const a = i * 4; const b = (i + 1) * 4;
    indices.push(
      a, b, a + 1, a + 1, b, b + 1, // floor
      a + 2, a + 3, b + 2, a + 3, b + 3, b + 2, // roof
      a, a + 2, b, a + 2, b + 2, b, // left side
      a + 1, b + 1, a + 3, a + 3, b + 1, b + 3, // right side
    );
  }
  const last = (stations.length - 1) * 4;
  indices.push(0, 1, 2, 1, 3, 2, last, last + 2, last + 1, last + 1, last + 2, last + 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function fallbackCar(color: string): THREE.Group {
  const car = new THREE.Group();
  car.userData.fallbackCar = true;
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.48, roughness: 0.3, side: THREE.DoubleSide });
  const trim = new THREE.MeshStandardMaterial({ color: 0x111827, metalness: 0.22, roughness: 0.66 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x183c56, metalness: 0.26, roughness: 0.15,
    transparent: true, opacity: 0.91, side: THREE.DoubleSide });
  const hub = new THREE.MeshStandardMaterial({ color: 0xb8c5d2, metalness: 0.8, roughness: 0.26 });
  const headlight = new THREE.MeshStandardMaterial({ color: 0xe8f8ff, emissive: 0xa5e8ff,
    emissiveIntensity: 1.5, roughness: 0.2 });
  const taillight = new THREE.MeshStandardMaterial({ color: 0xff2e48, emissive: 0xff1028,
    emissiveIntensity: 1.2 });

  const chassis = new THREE.Mesh(profileGeometry([
    { z: -1.9, halfWidth: 0.76, bottom: 0.38, top: 0.66 },
    { z: -1.35, halfWidth: 1.0, bottom: 0.38, top: 0.86 },
    { z: 0.5, halfWidth: 1.02, bottom: 0.38, top: 0.83 },
    { z: 1.55, halfWidth: 0.82, bottom: 0.38, top: 0.67 },
    { z: 1.95, halfWidth: 0.65, bottom: 0.38, top: 0.55 },
  ]), paint);
  chassis.name = 'fallback-chassis';
  car.add(chassis);

  const cockpit = new THREE.Mesh(profileGeometry([
    { z: -0.92, halfWidth: 0.79, bottom: 0.85, top: 0.91 },
    { z: -0.52, halfWidth: 0.69, bottom: 0.85, top: 1.43 },
    { z: 0.34, halfWidth: 0.66, bottom: 0.84, top: 1.43 },
    { z: 0.84, halfWidth: 0.78, bottom: 0.78, top: 0.83 },
  ]), glass);
  cockpit.name = 'fallback-cockpit';
  car.add(cockpit);

  const addBox = (name: string, material: THREE.Material, size: [number, number, number],
    position: [number, number, number]): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    mesh.position.set(...position);
    car.add(mesh);
    return mesh;
  };
  // Roof, splitter, diffuser and wing give the fallback a recognizable racing-car profile.
  addBox('fallback-roof', paint, [1.2, 0.08, 0.9], [0, 1.43, -0.07]);
  addBox('fallback-front-splitter', trim, [1.55, 0.08, 0.27], [0, 0.39, 1.83]);
  addBox('fallback-rear-diffuser', trim, [1.68, 0.12, 0.22], [0, 0.39, -1.79]);
  addBox('fallback-grille', trim, [0.94, 0.15, 0.04], [0, 0.49, 1.94]);
  for (const side of [-1, 1]) {
    addBox('fallback-wing-support', trim, [0.09, 0.38, 0.08], [side * 0.64, 1.04, -1.55]);
    addBox('fallback-side-intake', trim, [0.035, 0.22, 0.55], [side * 1.015, 0.67, -0.66]);
    addBox('fallback-headlight', headlight, [0.32, 0.10, 0.07], [side * 0.52, 0.62, 1.88]);
    addBox('fallback-taillight', taillight, [0.40, 0.09, 0.06], [side * 0.50, 0.65, -1.89]);
    addBox('fallback-hood-stripe', trim, [0.06, 0.012, 0.7], [side * 0.12, 0.83, 1.1]);
  }
  addBox('fallback-rear-wing', trim, [2.03, 0.10, 0.34], [0, 1.25, -1.62]);

  const wheels: THREE.Object3D[] = [];
  const tireGeometry = new THREE.CylinderGeometry(0.48, 0.48, 0.31, 16);
  const hubGeometry = new THREE.CylinderGeometry(0.26, 0.26, 0.325, 12);
  for (const x of [-1.03, 1.03]) for (const z of [-1.2, 1.22]) {
    const wheel = new THREE.Group();
    wheel.position.set(x, 0.48, z);
    const tire = new THREE.Mesh(tireGeometry, trim);
    tire.rotation.z = Math.PI / 2;
    const rim = new THREE.Mesh(hubGeometry, hub);
    rim.rotation.z = Math.PI / 2;
    wheel.add(tire, rim);
    car.add(wheel);
    wheels.push(wheel);
  }
  car.userData.wheels = wheels;
  return car;
}

/** Build a car group: clone the GLB template if present (preserving wheel tags), else the procedural racer. */
export function buildCar(template: THREE.Group | null, color: string, _isMe: boolean): THREE.Group {
  let g: THREE.Group;
  if (template) {
    // SkeletonUtils.clone rebinds SkinnedMesh instances to the cloned Skeleton, so the
    // 2nd+ instance of a rigged/animated GLB animates correctly (plain clone() does not).
    // It returns an Object3D; wrap in a Group if it isn't already one so we keep the THREE.Group contract.
    const cloned = skeletonClone(template);
    g = cloned instanceof THREE.Group ? cloned : new THREE.Group().add(cloned);
    // re-collect wheels on the clone by matching the template's wheel names
    const wheelNames = new Set((template.userData.wheels as THREE.Object3D[] ?? []).map(w => w.name));
    const wheels: THREE.Object3D[] = [];
    g.traverse(o => { if (wheelNames.has(o.name)) wheels.push(o); });
    g.userData.wheels = wheels;
    // If the model has a baked animation clip, set up a mixer to play it (preferred over wheel-spin).
    const clips = (template.userData.clips as THREE.AnimationClip[]) ?? [];
    if (clips.length > 0) {
      const mixer = new THREE.AnimationMixer(g);
      mixer.clipAction(clips[0]!).play();
      g.userData.mixer = mixer;   // renderer advances it each frame: mixer.update(dt)
    }
  } else {
    g = fallbackCar(color);
  }
  return g;
}

export function buildPlayerMarker(color:string,playerNumber:number):THREE.Group {
  const marker=new THREE.Group();
  const material=new THREE.MeshBasicMaterial({color:new THREE.Color(color),depthTest:false,depthWrite:false});
  const cone=new THREE.Mesh(new THREE.ConeGeometry(0.72,1.45,4),material);
  cone.rotation.x=Math.PI;cone.renderOrder=20;marker.add(cone);
  marker.userData.isPlayerArrow=true;
  marker.userData.playerNumber=playerNumber;
  return marker;
}
