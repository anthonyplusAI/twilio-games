// Map a caller's spoken utterance to one of the 4 moves the active monster knows. Players SHOUT the
// move name ("Ember!", "Thunder Jolt"), with a number fallback ("two", "move 3"). Reuses the same
// number/fuzzy matching family as the racer's game-host. Pure + testable.
import { describe, it, expect } from 'vitest';
import { matchMove, matchBattleAction, type BattleMenuCtx } from '../shared/battle-intent';
import { monsterById } from '../shared/monster-roster';

const moves = monsterById('sparkmouse')!.moves;
// sparkmouse moves: 0 Thunder Jolt, 1 Static Zap, 2 Quick Bite, 3 Tackle
const names = moves.map(m => m.name);

describe('matchMove', () => {
  it('matches a full move name', () => {
    expect(matchMove('Thunder Jolt', names)).toBe(0);
    expect(matchMove('quick bite', names)).toBe(2);
  });

  it('matches a distinctive partial / single keyword', () => {
    expect(matchMove('jolt', names)).toBe(0);
    expect(matchMove('use tackle!', names)).toBe(3);
    expect(matchMove('zap them', names)).toBe(1);
  });

  it('matches by NUMBER (digit + word + ordinal)', () => {
    expect(matchMove('one', names)).toBe(0);
    expect(matchMove('move 3', names)).toBe(2);
    expect(matchMove('the second one', names)).toBe(1);
    expect(matchMove('4', names)).toBe(3);
  });

  it('returns -1 when nothing plausibly matches', () => {
    expect(matchMove('banana', names)).toBe(-1);
    expect(matchMove('', names)).toBe(-1);
  });

  it('out-of-range numbers do not match', () => {
    expect(matchMove('move 9', names)).toBe(-1);
  });

  it('prefers an explicit number over an incidental name word', () => {
    // "give me two" → index 1 by number, even though no name says "two"
    expect(matchMove('give me two', names)).toBe(1);
  });
});

// ── matchBattleAction: the TWO-LEVEL command menu by voice ─────────────────────────────────────────
// Context the caller supplies from the live snapshot: the 4 moves (id+name, slot order), remaining
// potions, and which menu level they're on. Level matters because a bare number ("two") means a ROOT
// action at the root but a MOVE in the fight submenu.
const ctx = (over: Partial<BattleMenuCtx> = {}): BattleMenuCtx => ({
  moves: moves.map(m => ({ id: m.id, name: m.name })),
  potions: 2,
  level: 'root',
  ...over,
});

describe('matchBattleAction — ROOT keywords', () => {
  it('does not turn acknowledgements, negation, or questions into irreversible actions', () => {
    for (const spoken of ['right', 'five', "don't fight yet", 'do not use a potion', 'should I guard?', 'I have two potions left', 'I have a potion', 'Tell me about the potion', 'Tell me about Thunder Jolt', 'I can block', 'guard or attack']) {
      expect(matchBattleAction(spoken, ctx())).toBeNull();
    }
    for (const spoken of ['não lute ainda', 'não use poção', 'devo defender?', 'eu tenho uma poção', 'me fale sobre Thunder Jolt']) {
      expect(matchBattleAction(spoken, ctx(), 'pt-BR')).toBeNull();
    }
  });

  it('does not choose an arbitrary move when a spoken fragment matches multiple moves', () => {
    const ambiguous = ctx({ moves: [
      { id: 'first', name: 'Thunder Jolt' },
      { id: 'second', name: 'Thunder Wave' },
      { id: 'third', name: 'Static Zap' },
    ] });
    expect(matchBattleAction('thunder', ambiguous)).toBeNull();
  });

  it('accepts a Portuguese move in the same utterance as fight', () => {
    const localized = { moves: [
      { id: 'sparkmouse.jolt', name: 'Choque Trovejante' },
      { id: 'sparkmouse.zap', name: 'Descarga Estática' },
    ], potions: 2, level: 'root' as const };
    expect(matchBattleAction('lutar dois', localized, 'pt-BR')).toEqual({ kind: 'fight', moveId: 'sparkmouse.zap' });
    expect(matchBattleAction('ataque com choque trovejante', localized, 'pt-BR')).toEqual({ kind: 'fight', moveId: 'sparkmouse.jolt' });
    expect(matchBattleAction('dois', { ...localized, level: 'fight' }, 'pt-BR')).toEqual({ kind: 'fight', moveId: 'sparkmouse.zap' });
    expect(matchBattleAction('choque trovejante', { ...localized, level: 'fight' }, 'pt-BR')).toEqual({ kind: 'fight', moveId: 'sparkmouse.jolt' });
  });
  it('"fight"/"attack" open the fight submenu', () => {
    expect(matchBattleAction('fight', ctx())).toEqual({ kind: 'openFight' });
    expect(matchBattleAction('attack!', ctx())).toEqual({ kind: 'openFight' });
    expect(matchBattleAction('let me fight', ctx())).toEqual({ kind: 'openFight' });
    expect(matchBattleAction('flight', ctx())).toBeNull();
    expect(matchBattleAction('five', ctx())).toBeNull();
    expect(matchBattleAction('luta', ctx(), 'pt-BR')).toEqual({ kind: 'openFight' });
    expect(matchBattleAction('batalhar', ctx(), 'pt-BR')).toEqual({ kind: 'openFight' });
    expect(matchBattleAction('combater', ctx(), 'pt-BR')).toEqual({ kind: 'openFight' });
  });

  it('keeps a repeated fight command idempotent while the move menu is open', () => {
    expect(matchBattleAction('fight', { ...ctx(), level: 'fight' })).toEqual({ kind: 'openFight' });
    expect(matchBattleAction('lutar', { ...ctx(), level: 'fight' }, 'pt-BR')).toEqual({ kind: 'openFight' });
  });

  it('accepts a move in the same utterance as fight or attack', () => {
    expect(matchBattleAction('fight one',ctx())).toEqual({kind:'fight',moveId:moves[0].id});
    expect(matchBattleAction('fight Thunder Jolt',ctx())).toEqual({kind:'fight',moveId:moves[0].id});
    expect(matchBattleAction('attack with Static Zap',ctx())).toEqual({kind:'fight',moveId:moves[1].id});
  });

  it('"guard"/"block"/"brace"/"defend" → guard', () => {
    expect(matchBattleAction('guard', ctx())).toEqual({ kind: 'guard' });
    expect(matchBattleAction('block', ctx())).toEqual({ kind: 'guard' });
    expect(matchBattleAction('brace for it', ctx())).toEqual({ kind: 'guard' });
    expect(matchBattleAction('defend', ctx())).toEqual({ kind: 'guard' });
  });

  it('"item"/"potion"/"heal" → item when a potion remains', () => {
    expect(matchBattleAction('item', ctx())).toEqual({ kind: 'item', item: 'potion' });
    expect(matchBattleAction('use a potion', ctx())).toEqual({ kind: 'item', item: 'potion' });
    expect(matchBattleAction('heal up', ctx())).toEqual({ kind: 'item', item: 'potion' });
  });

  it('item is REFUSED (null) when no potions remain', () => {
    expect(matchBattleAction('potion', ctx({ potions: 0 }))).toBeNull();
    expect(matchBattleAction('heal', ctx({ potions: 0 }))).toBeNull();
  });

  it('"taunt"/"mock"/"provoke" → taunt', () => {
    expect(matchBattleAction('taunt', ctx())).toEqual({ kind: 'taunt' });
    expect(matchBattleAction('mock him', ctx())).toEqual({ kind: 'taunt' });
    expect(matchBattleAction('provoke the foe', ctx())).toEqual({ kind: 'taunt' });
  });

  it('accepts unambiguous move names directly from the root menu', () => {
    expect(matchBattleAction('Thunder Jolt', ctx())).toEqual({kind:'fight',moveId:moves[0].id});
    expect(matchBattleAction('use tackle', ctx())).toEqual({kind:'fight',moveId:moves[3].id});
    expect(matchBattleAction('zap them', ctx())).toEqual({kind:'fight',moveId:moves[1].id});
  });

  it('a bare NUMBER at root selects the ROOT action (1 fight, 2 guard, 3 item, 4 taunt)', () => {
    expect(matchBattleAction('one', ctx())).toEqual({ kind: 'openFight' });     // 1 = FIGHT
    expect(matchBattleAction('two', ctx())).toEqual({ kind: 'guard' });          // 2 = GUARD
    expect(matchBattleAction('three', ctx())).toEqual({ kind: 'item', item: 'potion' });   // 3 = ITEM
    expect(matchBattleAction('four', ctx())).toEqual({ kind: 'taunt' });         // 4 = TAUNT
  });

  it('root number 3 (item) is refused when no potions remain', () => {
    expect(matchBattleAction('three', ctx({ potions: 0 }))).toBeNull();
  });

  it('"back" at root is a no-op → null (already at the top)', () => {
    expect(matchBattleAction('back', ctx())).toBeNull();
    expect(matchBattleAction('go back', ctx())).toBeNull();
  });

  it('unrecognized input → null', () => {
    expect(matchBattleAction('banana', ctx())).toBeNull();
    expect(matchBattleAction('', ctx())).toBeNull();
  });
});

describe('matchBattleAction — FIGHT submenu', () => {
  const fightCtx = (over: Partial<BattleMenuCtx> = {}) => ctx({ level: 'fight', ...over });

  it('a bare NUMBER in the fight submenu picks a MOVE (not a root action)', () => {
    expect(matchBattleAction('one', fightCtx())).toEqual({ kind: 'fight', moveId: moves[0].id });
    expect(matchBattleAction('two', fightCtx())).toEqual({ kind: 'fight', moveId: moves[1].id });
    expect(matchBattleAction('move 3', fightCtx())).toEqual({ kind: 'fight', moveId: moves[2].id });
    expect(matchBattleAction('the fourth one', fightCtx())).toEqual({ kind: 'fight', moveId: moves[3].id });
  });

  it('a move NAME in the fight submenu picks that move', () => {
    expect(matchBattleAction('static zap', fightCtx())).toEqual({ kind: 'fight', moveId: moves[1].id });
    expect(matchBattleAction('jolt', fightCtx())).toEqual({ kind: 'fight', moveId: moves[0].id });
  });

  it('"back"/"cancel"/"return" in the fight submenu → back', () => {
    expect(matchBattleAction('back', fightCtx())).toEqual({ kind: 'back' });
    expect(matchBattleAction('go back', fightCtx())).toEqual({ kind: 'back' });
    expect(matchBattleAction('cancel', fightCtx())).toEqual({ kind: 'back' });
    expect(matchBattleAction('never mind', fightCtx())).toEqual({ kind: 'back' });
  });

  it('an out-of-range move number in the fight submenu → null', () => {
    expect(matchBattleAction('move 9', fightCtx())).toBeNull();
  });

  it('unrecognized input in the fight submenu → null', () => {
    expect(matchBattleAction('banana', fightCtx())).toBeNull();
    expect(matchBattleAction('', fightCtx())).toBeNull();
  });

  it('a ROOT action keyword still works from inside the fight submenu (e.g. "guard")', () => {
    // Callers shouldn't have to say "back" first — a clear root command from the fight level acts.
    expect(matchBattleAction('guard', fightCtx())).toEqual({ kind: 'guard' });
    expect(matchBattleAction('taunt', fightCtx())).toEqual({ kind: 'taunt' });
  });
});

describe('battle commands in Brazilian Portuguese', () => {
  it('recognizes the localized root command aliases', () => {
    expect(matchBattleAction('lutar', ctx(), 'pt-BR')).toEqual({ kind: 'openFight' });
    expect(matchBattleAction('atacar!', ctx(), 'pt-BR')).toEqual({ kind: 'openFight' });
    for (const command of ['defender', 'bloquear', 'proteger']) {
      expect(matchBattleAction(command, ctx(), 'pt-BR')).toEqual({ kind: 'guard' });
    }
    expect(matchBattleAction('usar poção', ctx(), 'pt-BR')).toEqual({ kind: 'item', item: 'potion' });
    expect(matchBattleAction('curar', ctx(), 'pt-BR')).toEqual({ kind: 'item', item: 'potion' });
    expect(matchBattleAction('provocar', ctx(), 'pt-BR')).toEqual({ kind: 'taunt' });
    expect(matchBattleAction('zombar', ctx(), 'pt-BR')).toEqual({ kind: 'taunt' });
  });

  it('normalizes Unicode and understands Portuguese cardinals and ordinals', () => {
    const decomposedPotion = 'poção'.normalize('NFD');
    expect(matchBattleAction(decomposedPotion, ctx(), 'pt-BR')).toEqual({ kind: 'item', item: 'potion' });
    expect(matchBattleAction('dois', ctx(), 'pt-BR')).toEqual({ kind: 'guard' });
    expect(matchBattleAction('a terceira', ctx(), 'pt-BR')).toEqual({ kind: 'item', item: 'potion' });
    expect(matchBattleAction('quarta', ctx(), 'pt-BR')).toEqual({ kind: 'taunt' });
    expect(matchBattleAction('segundo', ctx({ level: 'fight' }), 'pt-BR')).toEqual({ kind: 'fight', moveId: moves[1].id });
  });

  it('keeps canonical English move names selectable and localizes back navigation', () => {
    expect(matchBattleAction('Thunder Jolt', ctx({ level: 'fight' }), 'pt-BR')).toEqual({ kind: 'fight', moveId: moves[0].id });
    expect(matchBattleAction('voltar', ctx({ level: 'fight' }), 'pt-BR')).toEqual({ kind: 'back' });
    expect(matchBattleAction('cancelar', ctx({ level: 'fight' }), 'pt-BR')).toEqual({ kind: 'back' });
  });
});
