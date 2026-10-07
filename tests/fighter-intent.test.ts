import { describe, expect, it } from 'vitest';
import { matchFighterCommand, matchFighterCommands } from '../shared/fighter-intent';

describe('fighter voice intent', () => {
  it('accepts clear polite commands without waiting for an exact bare phrase', () => {
    expect(matchFighterCommands('please block')).toEqual(['block']);
    expect(matchFighterCommands('move forward please')).toEqual(['forward']);
    expect(matchFighterCommands('kick now')).toEqual(['kick']);
    expect(matchFighterCommands('por favor, bloqueie', 'pt-BR')).toEqual(['block']);
    expect(matchFighterCommands('avance por favor', 'pt-BR')).toEqual(['forward']);
  });

  it('never executes negated commands or both sides of a correction', () => {
    expect(matchFighterCommands("don't punch")).toEqual([]);
    expect(matchFighterCommands('punch, no, block')).toEqual(['block']);
    expect(matchFighterCommands('não chute', 'pt-BR')).toEqual([]);
    expect(matchFighterCommands('soco, não, defenda', 'pt-BR')).toEqual(['block']);
  });

  it.each([['move forward', 'forward'], ['step back', 'back'], ['LEAP!', 'jump'], ['jab', 'punch'], ['roundhouse', 'kick'], ['defend', 'block']] as const)('%s -> %s', (spoken, command) => {
    expect(matchFighterCommand(spoken)).toBe(command);
  });
  it('rejects ambiguous and conversational phrases', () => {
    expect(matchFighterCommand('punch or kick')).toBeNull();
    expect(matchFighterCommand('can I jump?')).toBeNull();
  });
  it('keeps explicit command bursts to two actions without treating conversation as gameplay', () => {
    expect(matchFighterCommands('punch five times')).toEqual(['punch', 'punch']);
    expect(matchFighterCommands('punch punch kick')).toEqual(['punch', 'punch']);
    expect(matchFighterCommands('punch punch punch punch punch punch punch punch punch punch punch punch')).toHaveLength(2);
    expect(matchFighterCommands('move forward then block')).toEqual(['forward', 'block']);
    expect(matchFighterCommands('can I punch now')).toEqual([]);
  });

  it.each([
    ['frente', 'forward'], ['avançar', 'forward'], ['aproximar', 'forward'],
    ['trás', 'back'], ['recuar', 'back'], ['afastar', 'back'],
    ['pular', 'jump'], ['saltar', 'jump'], ['soco', 'punch'], ['socar', 'punch'], ['golpear', 'punch'],
    ['chute', 'kick'], ['chutar', 'kick'], ['bloquear', 'block'], ['defender', 'block'],
  ] as const)('matches Portuguese %s -> %s', (spoken, command) => {
    expect(matchFighterCommand(spoken, 'pt-BR')).toBe(command);
  });

  it.each([
    ['avance', 'forward'], ['aproxime-se', 'forward'], ['recue', 'back'], ['afaste-se', 'back'],
    ['pule', 'jump'], ['dê um soco', 'punch'], ['dê um chute', 'kick'], ['defenda-se', 'block'],
  ] as const)('accepts natural Portuguese imperative %s', (spoken, command) => {
    expect(matchFighterCommand(spoken, 'pt-BR')).toBe(command);
  });

  it('normalizes Unicode and parses Portuguese repeats and filler', () => {
    expect(matchFighterCommand('ＴＲＡ́Ｓ!', 'pt-BR')).toBe('back');
    expect(matchFighterCommands('soco três vezes', 'pt-BR')).toEqual(['punch', 'punch']);
    expect(matchFighterCommands('chutar duas vezes', 'pt-BR')).toEqual(['kick', 'kick']);
    expect(matchFighterCommands('ir para frente e depois bloquear', 'pt-BR')).toEqual(['forward', 'block']);
    expect(matchFighterCommands('posso socar agora', 'pt-BR')).toEqual([]);
  });
});
