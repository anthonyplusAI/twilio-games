import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { WizardPieceLibrary } from '../client/chess/wizard-pieces';
import { readGlb } from '../tools/glb-read';

const modelNames = ['ron', 'harry', 'hermione', 'knight', 'queen', 'king', 'pawn'] as const;

describe('Wizard Chess supplied models', () => {
  it.each(modelNames)('ships renderable %s geometry', async name => {
    const glb = await readGlb(`assets/chess/wizard/${name}.glb`);
    expect(glb.primitiveCount).toBeGreaterThan(0);
    expect(glb.size.every(size => Number.isFinite(size) && size > 0.001)).toBe(true);
  });

  it('shows a loaded character with its original material and silhouette', () => {
    const library = new WizardPieceLibrary(() => {}, false);
    const nativeMaterial = new THREE.MeshStandardMaterial({ color: 0x6aacc9 });
    const nativeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, 0.3), nativeMaterial);
    nativeMesh.name = 'Object_9'; // Harry's supplied outer garment was previously recolored.
    const template = new THREE.Group();
    template.userData.wizardAsset = 'harry';
    template.add(nativeMesh);
    (library as unknown as { templates: Map<string, THREE.Group> }).templates.set('harry', template);

    const piece = library.createPiece('a3', 'b', 'b');
    const original = piece.getObjectByName('Object_9') as THREE.Mesh;
    expect(original.material).toBe(nativeMaterial);
    const costumeCoveringModel = piece.children.slice(1).some(child =>
      new THREE.Box3().setFromObject(child).max.y > 0.25);
    expect(costumeCoveringModel).toBe(false);
    library.dispose();
  });

  it('loads the complete seven-model set on activation, including on low-detail devices', async () => {
    const library = new WizardPieceLibrary(() => {}, true);
    const requested: string[] = [];
    vi.spyOn(library as unknown as { load: (key: string, retry: boolean) => Promise<void> }, 'load')
      .mockImplementation(async (key, retry) => { if (retry) requested.push(key); });

    library.prefetch(true);
    await vi.waitFor(() => expect(requested).toHaveLength(modelNames.length));
    expect(new Set(requested)).toEqual(new Set(modelNames));
    library.dispose();
  });
});
