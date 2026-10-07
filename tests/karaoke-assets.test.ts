import { readFile, stat } from 'node:fs/promises';
import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KARAOKE_ASSET_MANIFEST,
  KARAOKE_ASSET_TIMEOUT_MS,
  KARAOKE_ASSET_VERSION,
  KARAOKE_LEAD_MATERIAL_COUNT,
  KARAOKE_LEAD_TEXTURE_COUNT,
  KaraokeAssetLoader,
  disposeKaraokeObjectResources,
  hasVisibleKaraokeTriangles,
  karaokeDrumAnchor,
  karaokeMaterialDiagnostics,
  neutralizeKaraokeRootMotion,
  normalizeKaraokeAsset,
  visibleKaraokeBounds,
  type KaraokeAssetSpec,
} from '../client/karaoke/karaoke-assets';
import {
  KARAOKE_CROWD_DRAW_CALLS,
  KARAOKE_CROWD_MEMBER_COUNT,
  createKaraokeCrowdLayout,
  createKaraokeCrowdMeshes,
  createKaraokeProceduralLedWall,
  createKaraokeProceduralLogo,
} from '../client/karaoke/karaoke-stage';
import { readGlb } from '../tools/glb-read';
import { DEFAULT_KARAOKE_VENUE, karaokeVenueModel } from '../shared/karaoke-venue';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Voice Karaoke optional assets', () => {
  it('keeps authored placement outside normalization and versions every validated model URL', () => {
    expect(karaokeVenueModel(DEFAULT_KARAOKE_VENUE, 'stage').transform.rotation).toEqual([0, 180, 0]);
    for (const asset of KARAOKE_ASSET_MANIFEST) {
      expect(new URL(asset.url, 'https://karaoke.test').searchParams.get('v')).toBe(KARAOKE_ASSET_VERSION);
    }
  });

  it('allows realistic nonblocking time for progressively loaded models', () => {
    expect(KARAOKE_ASSET_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it('accepts only models with triangles that are actually visible', () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    root.add(mesh);
    expect(hasVisibleKaraokeTriangles(root)).toBe(true);
    root.visible = false;
    expect(hasVisibleKaraokeTriangles(root)).toBe(false);
    root.visible = true;
    mesh.material.opacity = 0;
    expect(hasVisibleKaraokeTriangles(root)).toBe(false);
    disposeKaraokeObjectResources(root);
  });

  it('disposes geometry, material, and texture resources together', () => {
    const texture = new THREE.Texture();
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const geometry = new THREE.PlaneGeometry(1, 1);
    const root = new THREE.Mesh(geometry, material);
    const textureDispose = vi.spyOn(texture, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    disposeKaraokeObjectResources(root);
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).toHaveBeenCalledOnce();
  });

  it('reports distinct loaded textures without replacing source materials', () => {
    const loaded = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const pending = new THREE.Texture();
    const first = new THREE.MeshStandardMaterial({ map: loaded, normalMap: pending });
    const second = new THREE.MeshStandardMaterial({ map: loaded });
    const root = new THREE.Group();
    root.add(
      new THREE.Mesh(new THREE.PlaneGeometry(1, 1), first),
      new THREE.Mesh(new THREE.PlaneGeometry(1, 1), second),
    );
    expect(karaokeMaterialDiagnostics(root)).toEqual({
      materialCount: 2,
      textureCount: 2,
      loadedTextureCount: 1,
    });
    disposeKaraokeObjectResources(root);
  });

  it('times out each optional role and retains an empty animation metadata contract', async () => {
    vi.useFakeTimers();
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(() => new Promise(() => {}));
    const spec: KaraokeAssetSpec = {
      role: 'lead-singer',
      url: '/assets/karaoke/test-singer.glb?v=test',
      targetHeight: 2.22,
    };
    const resultPromise = new KaraokeAssetLoader().loadOptional(undefined, [spec], 25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(resultPromise).resolves.toMatchObject({ failed: ['lead-singer'] });
    const result = await resultPromise;
    expect(result.models.size).toBe(0);
    expect(result.animations.size).toBe(0);
  });

  it('configures the shared Draco decoder path', () => {
    const decoderPath = vi.spyOn(DRACOLoader.prototype, 'setDecoderPath');
    const attachDecoder = vi.spyOn(GLTFLoader.prototype, 'setDRACOLoader');
    new KaraokeAssetLoader();
    expect(decoderPath).toHaveBeenCalledWith('/draco/');
    expect(attachDecoder).toHaveBeenCalledOnce();
  });

  it('normalizes characters independently by visible height', () => {
    const scene = new THREE.Group();
    const source = new THREE.Mesh(new THREE.BoxGeometry(10, 100, 4), new THREE.MeshBasicMaterial());
    source.position.set(30, 70, -20);
    scene.add(source);
    const spec = KARAOKE_ASSET_MANIFEST.find(asset => asset.role === 'backup-singer')!;
    const normalized = normalizeKaraokeAsset(spec, scene)!;
    const bounds = visibleKaraokeBounds(normalized)!;
    const size = bounds.getSize(new THREE.Vector3());
    expect(size.y).toBeCloseTo(2.22, 5);
    expect(bounds.min.y).toBeCloseTo(0, 5);
    expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(0, 5);
    disposeKaraokeObjectResources(normalized);
  });

  it('centers and grounds arbitrary stage units within the target width and depth', () => {
    const scene = new THREE.Group();
    const source = new THREE.Mesh(new THREE.BoxGeometry(30_162, 10_557, 19_175), new THREE.MeshBasicMaterial());
    source.position.set(12_000, -4_000, 8_000);
    scene.add(source);
    const spec = KARAOKE_ASSET_MANIFEST.find(asset => asset.role === 'stage')!;
    const normalized = normalizeKaraokeAsset(spec, scene)!;
    const bounds = visibleKaraokeBounds(normalized)!;
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    expect(size.x).toBeLessThanOrEqual(14.000_001);
    expect(size.z).toBeLessThanOrEqual(8.900_001);
    expect(Math.max(size.x / 14, size.z / 8.9)).toBeCloseTo(1, 5);
    expect(bounds.min.y).toBeCloseTo(0, 5);
    expect(center.x).toBeCloseTo(0, 5);
    expect(center.z).toBeCloseTo(0, 5);
    disposeKaraokeObjectResources(normalized);
  });

  it('recomputes the drum anchor from post-rotation batteria bounds', () => {
    const scene = new THREE.Group();
    const stageBody = new THREE.Mesh(new THREE.BoxGeometry(10, 2, 6), new THREE.MeshBasicMaterial());
    stageBody.position.y = 1;
    const drumKit = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), new THREE.MeshBasicMaterial());
    drumKit.name = 'batteria';
    drumKit.position.set(2, .5, 1.5);
    scene.add(stageBody, drumKit);
    const venue = new THREE.Group();
    const spec = KARAOKE_ASSET_MANIFEST.find(asset => asset.role === 'stage')!;
    const normalized = normalizeKaraokeAsset(spec, scene)!;
    venue.add(normalized);
    const anchor = karaokeDrumAnchor(normalized, venue)!;
    expect(anchor.toArray()).toEqual([
      expect.closeTo(2.8, 5),
      expect.closeTo(0, 5),
      expect.closeTo(1.22, 5),
    ]);
    disposeKaraokeObjectResources(venue);
  });

  it('neutralizes horizontal hip motion without removing vertical performance motion', () => {
    const clip = new THREE.AnimationClip('performance', 2, [
      new THREE.VectorKeyframeTrack('mixamorig:Hips_01.position', [0, 1, 2], [2, 5, 3, 8, 7, 9, -4, 6, 1]),
    ]);
    const normalized = neutralizeKaraokeRootMotion([clip])[0]!;
    expect(Array.from(normalized.tracks[0]!.values)).toEqual([2, 5, 3, 2, 7, 3, 2, 6, 3]);
    expect(Array.from(clip.tracks[0]!.values)).toEqual([2, 5, 3, 8, 7, 9, -4, 6, 1]);
  });

  it('installs successful roles progressively while another role is still pending', async () => {
    vi.useFakeTimers();
    const stageSpec = KARAOKE_ASSET_MANIFEST.find(asset => asset.role === 'stage')!;
    const singerSpec = KARAOKE_ASSET_MANIFEST.find(asset => asset.role === 'lead-singer')!;
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async url => {
      if (String(url).includes('lead-singer')) return new Promise(() => {});
      const scene = new THREE.Group();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
      return { scene, animations: [] } as unknown as Awaited<ReturnType<GLTFLoader['loadAsync']>>;
    });
    const installed: string[] = [];
    const result = new KaraokeAssetLoader().loadOptional(undefined, [stageSpec, singerSpec], 25, asset => {
      installed.push(asset.role);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(installed).toEqual(['stage']);
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toMatchObject({ failed: ['lead-singer'] });
  });
});

describe('Voice Karaoke human crowd', () => {
  it('uses smooth round heads, varied instanced hairstyles, and deterministic body variety', () => {
    const layout = createKaraokeCrowdLayout();
    const repeated = createKaraokeCrowdLayout();
    expect(layout).toEqual(repeated);
    expect(layout).toHaveLength(KARAOKE_CROWD_MEMBER_COUNT);
    expect(new Set(layout.map(member => member.height)).size).toBeGreaterThan(20);
    expect(new Set(layout.map(member => member.shirtColor)).size).toBeGreaterThan(3);
    expect(new Set(layout.map(member => member.skinColor)).size).toBeGreaterThan(3);
    expect(new Set(layout.map(member => member.hairColor)).size).toBeGreaterThan(3);
    expect(new Set(layout.map(member => member.hairStyle))).toEqual(new Set([0, 1, 2]));
    expect(new Set(layout.map(member => member.pose))).toEqual(new Set([0, 1, 2]));

    const crowd = createKaraokeCrowdMeshes(layout);
    expect(crowd.root.name).toBe('human-crowd');
    expect(crowd.root.children).toHaveLength(KARAOKE_CROWD_DRAW_CALLS);
    expect(crowd.root.children.every(child => (child as THREE.InstancedMesh).isInstancedMesh)).toBe(true);
    expect(crowd.heads.geometry.type).toBe('SphereGeometry');
    expect((crowd.heads.material as THREE.MeshStandardMaterial).flatShading).toBe(false);
    expect(crowd.torsos.geometry.type).toBe('CylinderGeometry');
    expect(crowd.heads.count).toBe(KARAOKE_CROWD_MEMBER_COUNT);
    expect(crowd.hairs.reduce((total, mesh) => total + mesh.count, 0)).toBe(KARAOKE_CROWD_MEMBER_COUNT);
    expect(crowd.torsos.count).toBe(KARAOKE_CROWD_MEMBER_COUNT);
    expect(crowd.arms.reduce((total, mesh) => total + mesh.count, 0)).toBe(KARAOKE_CROWD_MEMBER_COUNT);
    disposeKaraokeObjectResources(crowd.root);
  });
});

describe('Voice Karaoke procedural stage', () => {
  it('keeps the Twilio mark visible with no image request or texture dependency', () => {
    const logo = createKaraokeProceduralLogo();
    expect(logo.children).toHaveLength(2);
    expect(hasVisibleKaraokeTriangles(logo)).toBe(true);
    expect(karaokeMaterialDiagnostics(logo).textureCount).toBe(0);
    disposeKaraokeObjectResources(logo);
  });

  it('renders the fallback LED wall in one draw call', () => {
    const wall = createKaraokeProceduralLedWall();
    expect(wall.isInstancedMesh).toBe(true);
    expect(wall.count).toBeGreaterThan(50);
    expect(wall.count).toBeLessThan(200);
    expect(wall.instanceColor).not.toBeNull();
    disposeKaraokeObjectResources(wall);
  });
});

const MIB = 1024 * 1024;
const releaseAssets = [
  {
    file: 'stage.glb',
    maxBytes: 3 * MIB,
    animations: [],
    attribution: {
      title: 'Stage',
      author: 'MEC CAD (https://sketchfab.com/meccad)',
      source: 'https://sketchfab.com/3d-models/stage-75918ce264ca4362adb3aa7d87a88f37',
    },
  },
  {
    file: 'lead-singer.glb',
    maxBytes: 4 * MIB,
    animations: ['Mixamo'],
    attribution: {
      title: 'Freddie Mercury',
      author: 'Gerwerni (https://sketchfab.com/gerwerni)',
      source: 'https://sketchfab.com/3d-models/freddie-mercury-965ebf37fb364b73abb91f6d63e49e08',
    },
  },
  {
    file: 'backup-singer.glb',
    maxBytes: 1 * MIB,
    animations: ['Animation'],
    attribution: {
      title: 'Animated Model Singing with Microphone in Hand',
      author: 'LasquetiSpice (https://sketchfab.com/LasquetiSpice)',
      source: 'https://sketchfab.com/3d-models/animated-model-singing-with-microphone-in-hand-dade090dddcb4d1b8614972b2133d22e',
    },
  },
  {
    file: 'drummer.glb',
    maxBytes: 1.25 * MIB,
    animations: ['mixamo.com'],
    attribution: {
      title: 'Playing Drums',
      author: 'kodexar (https://sketchfab.com/kodexar)',
      source: 'https://sketchfab.com/3d-models/playing-drums-22c1e9e36d6a4bb6b122cb95dc06d025',
    },
  },
  {
    file: 'guitarist.glb',
    maxBytes: 1 * MIB,
    animations: ['Animation'],
    attribution: {
      title: 'Animated Musical Trem Playing Guitar Loop',
      author: 'LasquetiSpice (https://sketchfab.com/LasquetiSpice)',
      source: 'https://sketchfab.com/3d-models/animated-musical-trem-playing-guitar-loop-7dde986b68834de6b5a9deff6819d3f1',
    },
  },
] as const;

describe('Voice Karaoke release asset governance', () => {
  it.each(releaseAssets)('$file is a loadable attributed Draco/WebP GLB within budget', async ({
    file,
    maxBytes,
    animations,
    attribution,
  }) => {
    const path = `assets/karaoke/${file}`;
    const [metadata, info, buffer] = await Promise.all([readGlb(path), stat(path), readFile(path)]);
    const jsonLength = buffer.readUInt32LE(12);
    const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString().trim()) as {
      asset?: { extras?: Record<string, unknown> };
    };
    expect(info.isFile()).toBe(true);
    expect(info.size).toBeLessThanOrEqual(maxBytes);
    expect(metadata.extensionNames).toContain('KHR_draco_mesh_compression');
    expect(metadata.extensionNames).toContain('EXT_texture_webp');
    expect(metadata.extensionNames).not.toContain('KHR_materials_pbrSpecularGlossiness');
    expect(metadata.primitiveCount).toBeGreaterThan(0);
    expect(metadata.size).toHaveLength(3);
    expect(metadata.size.every(value => Number.isFinite(value) && value > 0)).toBe(true);
    expect(metadata.animationNames).toEqual([...animations]);
    expect(json.asset?.extras).toEqual({
      ...attribution,
      license: 'CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)',
    });
  }, 30_000);

  it('preserves a finite visible stage drum hierarchy anchor', async () => {
    const metadata = await readGlb('assets/karaoke/stage.glb');
    const drumName = Object.keys(metadata.nodeBounds).find(name => name.toLocaleLowerCase() === 'batteria');
    expect(drumName).toBeDefined();
    const drumBounds = metadata.nodeBounds[drumName!];
    expect(drumBounds?.size.every(value => Number.isFinite(value) && value > 0)).toBe(true);
    expect(metadata.nodeNames.filter(name => name.toLocaleLowerCase() === 'batteria')).toHaveLength(1);

    const allBounds = Object.values(metadata.nodeBounds);
    const sceneMin = [0, 1, 2].map(axis => Math.min(...allBounds.map(bounds => bounds.min[axis]!)));
    const sceneMax = [0, 1, 2].map(axis => Math.max(...allBounds.map(bounds => bounds.max[axis]!)));
    const sceneSize = sceneMin.map((value, axis) => sceneMax[axis]! - value);
    const sceneCenter = sceneMin.map((value, axis) => (sceneMax[axis]! + value) / 2);
    const scale = Math.min(14 / sceneSize[0]!, 8.9 / sceneSize[2]!);
    const rotatedAnchor = [
      -((((drumBounds!.min[0] + drumBounds!.max[0]) / 2) - sceneCenter[0]!) * scale),
      (drumBounds!.min[1] - sceneMin[1]!) * scale,
      -3 - (drumBounds!.max[2] - sceneCenter[2]!) * scale - .18,
    ];
    expect(rotatedAnchor).toEqual([
      expect.closeTo(-.048323, 5),
      expect.closeTo(.658959, 5),
      expect.closeTo(-4.990147, 5),
    ]);
  }, 30_000);

  it('preserves all embedded lead WebP textures and source materials', async () => {
    const buffer = await readFile('assets/karaoke/lead-singer.glb');
    expect(buffer.toString('utf8', 0, 4)).toBe('glTF');
    const jsonLength = buffer.readUInt32LE(12);
    const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString().trim()) as {
      materials?: unknown[];
      textures?: Array<{ extensions?: { EXT_texture_webp?: { source?: number } } }>;
      images?: Array<{ mimeType?: string }>;
    };
    expect(json.materials).toHaveLength(KARAOKE_LEAD_MATERIAL_COUNT);
    expect(json.textures).toHaveLength(KARAOKE_LEAD_TEXTURE_COUNT);
    expect(json.images).toHaveLength(KARAOKE_LEAD_TEXTURE_COUNT);
    expect(json.images?.every(image => image.mimeType === 'image/webp')).toBe(true);
    expect(json.textures?.every(texture => Number.isInteger(texture.extensions?.EXT_texture_webp?.source))).toBe(true);
  });
});
