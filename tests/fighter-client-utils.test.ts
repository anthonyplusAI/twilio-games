import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fighterResultActionState, isInteractiveShortcutTarget, resolveNumericSelection } from '../client/fighter/fighter-client-utils';

describe('fighter client shortcuts', () => {
  it('offers result Rematch only to a connected standalone host display', () => {
    expect(fighterResultActionState(false, true, 'connected', 'results')).toBe('rematch');
    expect(fighterResultActionState(false, false, 'connected', 'results')).toBe('viewer');
    expect(fighterResultActionState(false, true, 'reconnecting', 'results')).toBe('reconnecting');
    expect(fighterResultActionState(false, true, 'closed', 'results')).toBe('reconnecting');
    expect(fighterResultActionState(true, true, 'connected', 'results')).toBe('station');
    expect(fighterResultActionState(false, true, 'connected', 'fight')).toBe('unavailable');
  });
  it('allows all twelve fighters to be selected numerically', () => {
    expect(resolveNumericSelection('', '1', 12)).toMatchObject({ buffer: '1', waiting: true });
    expect(resolveNumericSelection('1', '0', 12).selection).toBe(10);
    expect(resolveNumericSelection('1', '1', 12).selection).toBe(11);
    expect(resolveNumericSelection('1', '2', 12).selection).toBe(12);
    expect(resolveNumericSelection('', '9', 12).selection).toBe(9);
  });

  it('identifies controls that own their keyboard events', () => {
    expect(isInteractiveShortcutTarget({ closest: () => ({}) } as unknown as EventTarget)).toBe(true);
    expect(isInteractiveShortcutTarget({ closest: () => null } as unknown as EventTarget)).toBe(false);
  });

  it('waits for assigned actors but fails safe when model loading stalls', () => {
    const source=readFileSync(new URL('../client/fighter/fighter.ts',import.meta.url),'utf8');
    expect(source).toContain('state.hasExpectedPlayers && state.players.length > 0');
    expect(source).toContain("console.warn('Fighter model failed to load; using fallback actors.'");
    expect(source).toContain('const FIGHTER_ACTOR_FALLBACK_MS = 5_000');
    expect(source).toContain('animationSources = new Map()');
    expect(source).toContain('actorLoadCoordinator.start(');
    expect(source).toContain("fighterConnectionState !== 'connected'");
    expect(source).toContain('FighterActor.fallback(color, id)');
    expect(source).toContain('keep.add(current.p1Id); keep.add(current.p2Id)');
    expect(source).toContain("actors.p1 !== loadedActors.get(p1Id)");
    expect(source).toContain('`${state.loadingGeneration}:${state.selectedMap}`');
    expect(source).toContain("arena model has no renderable geometry");
    expect(source).toContain("status !== 'connected'");
    expect(source).toContain('failedMapKey === loadKey');
    expect(source).toContain('hasRenderableTriangle(gltf.scene)');
    expect(source).toContain('if (mapModel) mapModel.visible = false;');
    expect(source).toContain('if (mapModel && mapVisible !== undefined) mapModel.visible = mapVisible;');
    expect(source).not.toContain('scheduleViewportMapReload');
    expect(source).not.toContain("loadedMapId = '';\n    applyMapTheme(mapId)");
    expect(source).toContain('applyProceduralFallbackFraming(config)');
    expect(source).toContain("renderer.domElement.addEventListener('webglcontextlost'");
  });

  it('uses equal horizontal arena rows and event-readable fight controls in portrait', () => {
    const css=readFileSync(new URL('../client/fighter/fighter.css',import.meta.url),'utf8');
    expect(css).toContain('@media (orientation:portrait) and (min-width:721px)');
    expect(css).toMatch(/\.select-grid\.map-grid \{[^}]*grid-template-columns:1fr[^}]*grid-template-rows:repeat\(5/);
    expect(css).toContain('grid-template-columns:minmax(0,68%) minmax(0,32%)');
    expect(css).toContain('body[data-phase="fight"] .commands { grid-template-columns:repeat(3,minmax(0,1fr));gap:9px; }');
    expect(css).toContain('font-size:clamp(32px,3.7vw,40px)');
  });
});
