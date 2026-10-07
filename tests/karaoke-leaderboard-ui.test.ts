import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { karaokeCopy } from '../client/karaoke/karaoke-copy';
import { karaokeResultAnnouncement, renderKaraokeResultsHtml } from '../client/karaoke/karaoke-results-view';

const result = {
  locale: 'en-US' as const,
  singerName: 'Ada',
  score: 8_642,
  bestCombo: 13,
  song: { title: 'Signal Song', artist: 'The Twilions' },
  leaderboardEntries: [
    { name: 'Ada', score: 8_642, bestCombo: 13 },
    { name: 'Grace', score: 7_100, bestCombo: 9 },
  ],
  leaderboardLoading: false,
  canReplayOnDisplay: true,
  stationManaged: false,
};

describe('Karaoke leaderboard UI', () => {
  it('loads a per-song top ten into the localized results screen', async () => {
    const [script, styles] = await Promise.all([
      readFile('client/karaoke/karaoke.ts', 'utf8'),
      readFile('client/karaoke/karaoke.css', 'utf8'),
    ]);
    expect(script).toContain('/api/karaoke/leaderboard?song=');
    expect(script).toContain("state.phase === 'finalizing'");
    const html = renderKaraokeResultsHtml(result);
    expect(html).toContain('class="flow-card karaoke-board"');
    expect(html).toContain('Signal Song');
    expect(html).toContain('The Twilions');
    expect(html).toContain('Ada');
    expect(html).toContain('Grace');
    expect(html).toContain('8,642');
    expect(html).toContain('13x');
    expect(styles).toContain('.karaoke-board-row');
    expect(styles).toContain('container-type:inline-size');
    expect(styles).toContain('clamp(52px,20cqi,104px)');
    expect(karaokeCopy('en-US').leaderboard).toMatch(/all-time leaderboard/i);
    expect(karaokeCopy('pt-BR').leaderboard).toMatch(/ranking/i);
    expect(karaokeCopy('en-US').finalizing).toMatch(/scoring/i);
  });

  it('places standalone replay and exit before the inline technology explanation', () => {
    const html = renderKaraokeResultsHtml(result);
    expect(html).toContain('id="advance-flow"');
    expect(html).toContain('id="karaoke-exit"');
    expect(html).toContain('class="result-tech');
    expect(html.indexOf('id="advance-flow"')).toBeLessThan(html.indexOf('class="result-tech'));
    expect(html.indexOf('class="karaoke-board"')).toBeLessThan(html.indexOf('class="result-tech'));
  });

  it('keeps station scores and the song board while replacing destructive actions with rejoin guidance', () => {
    const html = renderKaraokeResultsHtml({ ...result, stationManaged: true });
    expect(html).toContain('8,642');
    expect(html).toContain('Grace');
    expect(html).toMatch(/rejoin/i);
    expect(html).toContain('class="result-tech');
    expect(html).not.toContain('id="advance-flow"');
    expect(html).not.toContain('id="karaoke-exit"');
    expect(html).not.toContain('href="/"');
  });

  it('escapes server-provided singer and leaderboard names', () => {
    const html = renderKaraokeResultsHtml({
      ...result,
      singerName: '<img src=x onerror=alert(1)>',
      leaderboardEntries: [{ name: '<script>alert(1)</script>', score: 5, bestCombo: 1 }],
    });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)');
  });

  it('keeps the rich results readable without announcing the whole board and tech panel on updates', () => {
    const html = renderKaraokeResultsHtml(result);
    expect(html).toContain('class="flow-panel results-panel" aria-live="off"');
    expect(karaokeResultAnnouncement(result)).toBe('Final note. Ada. Score: 8,642. Best combo: 13x.');
    expect(karaokeResultAnnouncement({ ...result, locale: 'pt-BR' }))
      .toBe('Nota final. Ada. Pontos: 8.642. Melhor sequência: 13x.');
  });
});
