import { describe, it, expect } from 'vitest';
import { greetingLine, lineForEvent, placeLine, raceOverLine, ordinal } from '../server/voice-lines';

describe('voice-lines', () => {
  it('greeting welcomes + asks the caller\'s name (voice onboarding starts here)', () => {
    const g = greetingLine().toLowerCase();
    expect(g).toContain('voice racer');
    expect(g).toContain('conversation relay');
    expect(g).toMatch(/voice.*control|control.*voice/);
    expect(g).toMatch(/name/);
  });

  it('countdown speaks only the numeric 3, 2, 1 beats', () => {
    expect(lineForEvent({ kind: 'countdown', n: 6 }, 'p1')).toBeNull();
    expect(lineForEvent({ kind: 'countdown', n: 5 }, 'p1')).toBeNull();
    expect(lineForEvent({ kind: 'countdown', n: 4 }, 'p1')).toBeNull();
    expect(lineForEvent({ kind: 'countdown', n: 3 }, 'p1')).toBe('3');
    expect(lineForEvent({ kind: 'countdown', n: 0 }, 'p1')).toBeNull();
  });

  it('go event is short and does not bury the first commands with control hints', () => {
    const go = lineForEvent({ kind: 'go' }, 'p1')!;
    expect(go).toBe('Go!');
    expect(go.toLowerCase()).not.toMatch(/left|right|boost|brake|nitro/);
  });

  it('finish is spoken only for the caller\'s own player, and a win is calm', () => {
    const win = lineForEvent({ kind: 'finish', playerId: 'p1', name: 'Me', place: 1 }, 'p1')!;
    expect(win.toLowerCase()).toContain('first place');
    expect(win.toLowerCase()).toContain('won');
    expect(win).not.toMatch(/CHAMPION|YES|!!/);
    expect(lineForEvent({ kind: 'finish', playerId: 'p2', name: 'Them', place: 1 }, 'p1')).toBeNull();
    expect(lineForEvent({ kind: 'finish', playerId: 'p1', name: 'Me', place: 1 }, null)).toBeNull();
  });

  it('speaks arcade lines for the caller\'s OWN car (took lead / hit streak / fell to last)', () => {
    expect(lineForEvent({ kind: 'lead_change', playerId: 'p1', name: 'Me' }, 'p1')).toMatch(/lead|front|first/i);
    expect(lineForEvent({ kind: 'hit_streak', playerId: 'p1', name: 'Me', count: 3 }, 'p1')).toMatch(/barrier|wall|gap/i);
    expect(lineForEvent({ kind: 'fell_to_last', playerId: 'p1', name: 'Me' }, 'p1')).toMatch(/last|catch|climb|up/i);
  });

  it('does NOT speak arcade lines about OTHER players, or raw hit/race_over, to the caller', () => {
    expect(lineForEvent({ kind: 'lead_change', playerId: 'p2', name: 'Them' }, 'p1')).toBeNull();
    expect(lineForEvent({ kind: 'hit_streak', playerId: 'p2', name: 'Them', count: 3 }, 'p1')).toBeNull();
    expect(lineForEvent({ kind: 'hit', playerId: 'p1' }, 'p1')).toBeNull();       // raw hit → screen only
    expect(lineForEvent({ kind: 'race_over' }, 'p1')).toBeNull();
  });

  it('prompts the caller through the menu phases + reacts to THEIR car pick only', () => {
    expect(lineForEvent({ kind: 'enter_car_select' }, 'p1')).toMatch(/car|ride|machine|number/i);
    expect(lineForEvent({ kind: 'enter_map_select' }, 'p1')).toMatch(/track|course|number/i);
    // reacts to the caller's own pick, names the car
    expect(lineForEvent({ kind: 'car_picked', playerId: 'p1', name: 'Me', car: 'Lotus Elise' }, 'p1')).toContain('Lotus Elise');
    // silent for another player's pick
    expect(lineForEvent({ kind: 'car_picked', playerId: 'p2', name: 'Them', car: 'Beetle' }, 'p1')).toBeNull();
    expect(lineForEvent({ kind: 'map_picked', playerId: 'p1', map: 'Drift' }, 'p1')).toContain('Drift');
    expect(lineForEvent({ kind: 'map_picked', playerId: 'p1', map: 'Silver Lake' }, 'p1', 0, 'pt-BR'))
      .toContain('Lago Prateado');
    expect(lineForEvent({ kind: 'map_picked', playerId: 'p2', map: 'Drift' }, 'p1')).toBeNull();
  });

  it('placeLine covers podium + generic ordinals', () => {
    expect(placeLine(1).toLowerCase()).toContain('first');
    expect(placeLine(2).toLowerCase()).toContain('second');
    expect(placeLine(3).toLowerCase()).toContain('third');
    expect(placeLine(5)).toContain('5th');
  });

  it('raceOverLine congratulates winners and encourages non-winners', () => {
    expect(raceOverLine(1).toLowerCase()).toMatch(/congrat|won|leaderboard/);
    expect(raceOverLine(3).toLowerCase()).toMatch(/try again|finished 3rd|leaderboard/);
  });

  it('speaks a measured line when the caller clears a barrier with nitro', () => {
    const line = lineForEvent({ kind: 'barrier_smashed', playerId: 'p1', itemId: 7 }, 'p1');
    expect(line).toBeTruthy();
    expect(line!.toLowerCase()).toMatch(/nitro|barrier|through|cleared/);
    expect(line).not.toMatch(/BOOM|YES|incredible|!!/);
    // not spoken for another player's smash
    expect(lineForEvent({ kind: 'barrier_smashed', playerId: 'p2', itemId: 7 }, 'p1')).toBeNull();
  });

  it('varies arcade phrasing by seq (not the same line every time)', () => {
    const a = lineForEvent({ kind: 'lead_change', playerId: 'p1', name: 'Me' }, 'p1', 0);
    const b = lineForEvent({ kind: 'lead_change', playerId: 'p1', name: 'Me' }, 'p1', 1);
    const c = lineForEvent({ kind: 'lead_change', playerId: 'p1', name: 'Me' }, 'p1', 2);
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });

  it('ordinal handles the tricky cases', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(21)).toBe('21st');
  });

  it.each([
    [1, /primeiro lugar.*venceu/i],
    [2, /segundo lugar/i],
    [3, /terceiro lugar.*pódio/i],
    [5, /5º/],
  ] as const)('localizes Portuguese place %i', (place, expected) => {
    expect(placeLine(place, 'pt-BR')).toMatch(expected);
  });

  it('localizes greetings, events, and race-over recaps in Brazilian Portuguese', () => {
    expect(greetingLine('pt-BR')).toMatch(/voz|voice racer|nome/i);
    expect(lineForEvent({ kind: 'go' }, 'p1', 0, 'pt-BR')).toBe('Vai!');
    expect(lineForEvent({ kind: 'lead_change', playerId: 'p1', name: 'Eu' }, 'p1', 0, 'pt-BR'))
      .toMatch(/liderança|frente|primeiro/i);
    expect(raceOverLine(2, 'pt-BR')).toMatch(/fim de corrida.*2º.*classificação/i);
    expect(ordinal(21, 'pt-BR')).toBe('21º');
  });
});
