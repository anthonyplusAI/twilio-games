import { describe, expect, it } from 'vitest';
import { lyricSimilarity } from '../server/audio/lyric-similarity';

describe('lyricSimilarity', () => {
  it.each([
    ['Você', 'voce', 'pt-BR', 1],
    ['coração', 'corasao', 'pt-BR', 0.85],
    ['feeling', 'feelin', 'en-US', 0.85],
    ['running', 'runnin', 'en-US', 0.85],
    ['tomorrow', 'tomorow', 'en-US', 0.85],
  ])('recognizes a close ASR rendering of %s', (expected, recognized, locale, minimum) => {
    expect(lyricSimilarity(expected, recognized, locale)).toBeGreaterThanOrEqual(minimum);
  });

  it.each([
    ['hello', 'jello', 'en-US'],
    ['heart', 'heard', 'en-US'],
    ['running', 'dunning', 'en-US'],
    ['feeling', 'failing', 'en-US'],
    ['coração', 'cantar', 'pt-BR'],
  ])('does not credit an unrelated or too-short near word %s', (expected, recognized, locale) => {
    expect(lyricSimilarity(expected, recognized, locale)).toBe(0);
  });
});
