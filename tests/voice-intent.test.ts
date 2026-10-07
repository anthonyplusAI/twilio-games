import { describe, it, expect } from 'vitest';
import { intentsFromTranscript, mapTranscriptToIntent } from '../server/voice-intent';

describe('mapTranscriptToIntent', () => {
  it('maps core command words', () => {
    expect(mapTranscriptToIntent('left')).toBe('MOVE_LEFT');
    expect(mapTranscriptToIntent('right')).toBe('MOVE_RIGHT');
    expect(mapTranscriptToIntent('boost')).toBe('BOOST');
    expect(mapTranscriptToIntent('brake')).toBe('BRAKE');
  });
  it('maps multi-word and synonym phrases', () => {
    expect(mapTranscriptToIntent('nitro')).toBe('USE_POWER');          // primary trigger word
    expect(mapTranscriptToIntent('use nitro')).toBe('USE_POWER');
    expect(mapTranscriptToIntent('go left')).toBe('MOVE_LEFT');
    expect(mapTranscriptToIntent('turn right')).toBe('MOVE_RIGHT');
    expect(mapTranscriptToIntent('power')).toBe('USE_POWER');          // legacy synonym still works
    expect(mapTranscriptToIntent('slow down')).toBe('BRAKE');
    expect(mapTranscriptToIntent('go')).toBe('BOOST');
  });
  it('is case- and punctuation-insensitive', () => {
    expect(mapTranscriptToIntent('LEFT!')).toBe('MOVE_LEFT');
    expect(mapTranscriptToIntent('  Right. ')).toBe('MOVE_RIGHT');
  });
  it('finds a command word inside a longer interim transcript', () => {
    expect(mapTranscriptToIntent('uh go left now')).toBe('MOVE_LEFT');
  });
  it('returns null for unrecognized speech', () => {
    expect(mapTranscriptToIntent('hello there')).toBeNull();
    expect(mapTranscriptToIntent('')).toBeNull();
  });
  it('prioritizes the last directional word in a phrase', () => {
    // "left ... no right" — caller corrected themselves; take the latest
    expect(mapTranscriptToIntent('left no right')).toBe('MOVE_RIGHT');
  });

  it.each([
    ['esquerda', 'MOVE_LEFT'],
    ['direita', 'MOVE_RIGHT'],
    ['acelerar', 'BOOST'],
    ['turbo', 'USE_POWER'],
    ['vai', 'BOOST'],
    ['frear', 'BRAKE'],
    ['devagar', 'BRAKE'],
    ['parar', 'BRAKE'],
    ['NÍTRO!!!', 'USE_POWER'],
    ['poder', 'USE_POWER'],
  ] as const)('maps Portuguese command %s', (transcript, intent) => {
    expect(mapTranscriptToIntent(transcript, 'pt-BR')).toBe(intent);
  });

  it.each([
    ['acelere', 'BOOST'], ['acelera', 'BOOST'], ['freie', 'BRAKE'], ['freia', 'BRAKE'],
    ['reduza', 'BRAKE'], ['desacelere', 'BRAKE'],
  ] as const)('accepts natural Portuguese Racer command %s', (spoken, intent) => {
    expect(mapTranscriptToIntent(spoken, 'pt-BR')).toBe(intent);
  });

  it('extracts a Portuguese command burst in order with Unicode-safe punctuation', () => {
    expect(intentsFromTranscript('Esquerda, direita; ACELERAR — nitro… frear!', 'pt-BR')).toEqual([
      'MOVE_LEFT', 'MOVE_RIGHT', 'BOOST', 'USE_POWER', 'BRAKE',
    ]);
  });

  it('keeps command aliases locale-specific', () => {
    expect(mapTranscriptToIntent('esquerda')).toBeNull();
    expect(mapTranscriptToIntent('left', 'pt-BR')).toBeNull();
  });

  it('does not fire negated controls or questions about controls', () => {
    expect(intentsFromTranscript("Don't go left, I am asking what nitro does?")).toEqual([]);
    expect(intentsFromTranscript('Não acelere, o que faz o turbo?', 'pt-BR')).toEqual([]);
    expect(intentsFromTranscript('Tell me how to use nitro')).toEqual([]);
    expect(intentsFromTranscript('Could you explain the boost?')).toEqual([]);
    expect(intentsFromTranscript('Me explica o nitro', 'pt-BR')).toEqual([]);
    expect(intentsFromTranscript('I want to save my nitro')).toEqual([]);
    expect(intentsFromTranscript('I have nitro saved')).toEqual([]);
    expect(intentsFromTranscript('My boost is empty')).toEqual([]);
    expect(intentsFromTranscript('Please stop talking')).toEqual([]);
  });

  it('honors a same-utterance correction without executing the discarded command', () => {
    expect(intentsFromTranscript('left, no, right now')).toEqual(['MOVE_RIGHT']);
    expect(intentsFromTranscript('esquerda, não, direita agora', 'pt-BR')).toEqual(['MOVE_RIGHT']);
  });

  it('distinguishes a directional go request from a boost request', () => {
    expect(intentsFromTranscript('go left')).toEqual(['MOVE_LEFT']);
    expect(intentsFromTranscript('go faster')).toEqual(['BOOST']);
  });
});
