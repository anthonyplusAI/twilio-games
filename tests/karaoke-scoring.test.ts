import { describe, expect, it } from 'vitest';
import {
  KARAOKE_LYRIC_SCORE_WEIGHT,
  KARAOKE_PITCH_SCORE_WEIGHT,
  KARAOKE_TIMING_SCORE_WEIGHT,
  KaraokeScoreAccumulator,
  matchObservationToChart,
  normalizeKaraokeLyricWord,
  scoreObservationAgainstWord,
  type ExpectedChartWord,
  type RecognizedLyricWordEvidence,
  type ScoringObservation,
} from '../server/audio/scoring';

const WORD: ExpectedChartWord = {
  id: 'hello-1',
  text: 'hello',
  startMs: 1_000,
  endMs: 1_100,
  pitchHz: 440,
};

function observation(mediaTimestampMs: number, overrides: Partial<ScoringObservation> = {}): ScoringObservation {
  return {
    mediaTimestampMs,
    durationMs: 20,
    rms: 0.3,
    voiceActive: true,
    pitchHz: 440,
    ...overrides,
  };
}

function evidence(
  text: string,
  startMs = WORD.startMs,
  endMs = WORD.endMs,
  confidence = 1,
): RecognizedLyricWordEvidence {
  return {
    text,
    songStartMs: startMs,
    songEndMs: endMs,
    sourceStartMs: startMs + 50,
    sourceEndMs: endMs + 50,
    confidence,
    source: 'fake',
  };
}

function fillWord(scorer: KaraokeScoreAccumulator, word = WORD, overrides: Partial<ScoringObservation> = {}): void {
  for (let timestamp = word.startMs; timestamp < word.endMs; timestamp += 20) {
    scorer.observe(observation(timestamp, overrides));
  }
}

describe('karaoke weighted scoring', () => {
  it('exports and applies exact 50/30/20 component arithmetic', () => {
    expect([KARAOKE_TIMING_SCORE_WEIGHT, KARAOKE_LYRIC_SCORE_WEIGHT, KARAOKE_PITCH_SCORE_WEIGHT])
      .toEqual([0.5, 0.3, 0.2]);
    const scorer = new KaraokeScoreAccumulator([WORD], {
      earlyToleranceMs: 0,
      lateToleranceMs: 0,
      lyricRecognitionAvailable: true,
    });
    fillWord(scorer);
    scorer.replaceLyricResult('weighted-result', [evidence('hello', undefined, undefined, 0.5)], true);
    const summary = scorer.summary();
    expect(summary.components).toEqual({ timing: 0.85, lyrics: 0.5, pitch: 0.85 });
    expect(summary.score).toBe(0.5 * 0.85 + 0.3 * 0.5 + 0.2 * 0.85);
    expect(summary.words[0]).toMatchObject({
      timingScore: 0.85,
      lyricScore: 0.5,
      pitchScore: 0.85,
      lyricEvidence: {
        source: 'fake', sourceStartMs: 1_050, sourceEndMs: 1_150, confidence: 0.5, final: true,
      },
    });
    expect(summary.words[0]?.score).toBe(0.5 * 0.85 + 0.3 * 0.5 + 0.2 * 0.85);
  });

  it('scores observations by media timestamp and gates timing and pitch on voice activity', () => {
    const options = { earlyToleranceMs: 100, lateToleranceMs: 100 };
    expect(scoreObservationAgainstWord(observation(1_020), WORD, options).score).toBe(0.7);
    expect(scoreObservationAgainstWord(observation(940), WORD, options).timingScore).toBeCloseTo(0.5);
    expect(scoreObservationAgainstWord(observation(1_140), WORD, options).timingScore).toBeCloseTo(0.5);
    expect(matchObservationToChart(observation(880), [WORD], options)).toBeNull();
    expect(scoreObservationAgainstWord(
      observation(1_020, { voiceActive: false, pitchHz: null }), WORD,
    )).toMatchObject({ timingScore: 0, pitchScore: 0, score: 0 });
    expect(scoreObservationAgainstWord(observation(1_020, { pitchHz: 880 }), WORD).pitchScore).toBe(1);
  });

  it('forces silence to zero even if injected provider evidence claims a correct lyric', () => {
    const scorer = new KaraokeScoreAccumulator([WORD], {
      lyricRecognitionAvailable: true,
      earlyToleranceMs: 0,
      lateToleranceMs: 0,
    });
    fillWord(scorer, WORD, { voiceActive: false, pitchHz: null, rms: 0 });
    scorer.replaceLyricResult('silent-result', [evidence('hello')], true);
    expect(scorer.summary()).toMatchObject({
      score: 0,
      voicedObservations: 0,
      components: { timing: 0, lyrics: 0, pitch: 0 },
      words: [{ score: 0, lyricScore: 0 }],
    });
  });

  it('keeps reduced acoustic credit without making singing ASR a hard gate', () => {
    const scorer = new KaraokeScoreAccumulator([WORD], {
      lyricRecognitionAvailable: true,
      earlyToleranceMs: 0,
      lateToleranceMs: 0,
    });
    fillWord(scorer);
    expect(scorer.summary()).toMatchObject({
      score: 0.49,
      lyricRecognitionAvailable: true,
      components: { timing: 0.7, lyrics: 0, pitch: 0.7 },
      words: [{ score: 0.49, timingScore: 0.7, lyricScore: 0, pitchScore: 0.7 }],
    });
    expect(scorer.disableLyricRecognition()).toBe(true);
    expect(scorer.summary()).toMatchObject({
      score: 0.7,
      lyricRecognitionAvailable: false,
      components: { timing: 1, lyrics: 0, pitch: 1 },
    });
  });

  it('scores correct, wrong, punctuated, and accent-folded words without retaining transcript text', () => {
    expect(normalizeKaraokeLyricWord('Você!', 'pt-BR')).toBe('voce');
    const word = { ...WORD, text: 'Você!' };
    const scorer = new KaraokeScoreAccumulator([word], {
      locale: 'pt-BR', lyricRecognitionAvailable: true, earlyToleranceMs: 0, lateToleranceMs: 0,
    });
    fillWord(scorer, word);
    scorer.replaceLyricResult('accent', [evidence('VOCE,')], true);
    expect(scorer.summary().lyricScore).toBe(1);

    const wrong = new KaraokeScoreAccumulator([word], {
      locale: 'pt-BR', lyricRecognitionAvailable: true, earlyToleranceMs: 0, lateToleranceMs: 0,
    });
    fillWord(wrong, word);
    wrong.replaceLyricResult('wrong', [evidence('provider-secret-transcript')], true);
    const summary = wrong.summary();
    expect(summary.lyricScore).toBe(0);
    expect(summary.words[0]?.lyricEvidence).toBeNull();
    expect(JSON.stringify(summary)).not.toContain('provider-secret-transcript');
  });

  it('credits a high-confidence close lyric rendering only inside the timed word window', () => {
    const word = { ...WORD, text: 'feeling', startMs: 1_000, endMs: 1_200 };
    const scorer = new KaraokeScoreAccumulator([word], {
      locale: 'en-US', lyricRecognitionAvailable: true, earlyToleranceMs: 0, lateToleranceMs: 0,
      lyricAlignmentToleranceMs: 100,
    });
    fillWord(scorer, word);
    scorer.replaceLyricResult('accented-asr', [evidence('feelin', 1_050, 1_150, 0.9)], true);
    expect(scorer.summary().lyricScore).toBeGreaterThan(0.7);

    const late = new KaraokeScoreAccumulator([word], {
      locale: 'en-US', lyricRecognitionAvailable: true, earlyToleranceMs: 0, lateToleranceMs: 0,
      lyricAlignmentToleranceMs: 100,
    });
    fillWord(late, word);
    late.replaceLyricResult('late', [evidence('feelin', 1_500, 1_600, 0.9)], true);
    expect(late.summary().lyricScore).toBe(0);
  });

  it('rejects low-confidence and ambiguous approximate lyric evidence', () => {
    const word = { ...WORD, text: 'feeling', startMs: 1_000, endMs: 1_200 };
    const uncertain = new KaraokeScoreAccumulator([word], { lyricRecognitionAvailable: true });
    fillWord(uncertain, word);
    uncertain.replaceLyricResult('uncertain', [evidence('feelin', 1_050, 1_150, 0.5)], true);
    expect(uncertain.summary().lyricScore).toBe(0);

    const duplicateWords = [word, { ...word, id: 'duplicate' }];
    const ambiguous = new KaraokeScoreAccumulator(duplicateWords, { lyricRecognitionAvailable: true });
    fillWord(ambiguous, word);
    ambiguous.replaceLyricResult('ambiguous', [evidence('feelin', 1_050, 1_150, 0.95)], true);
    expect(ambiguous.summary().words.map(item => item.lyricScore)).toEqual([0, 0]);
  });

  it('aligns recognized words in chart order to nearby media-origin timestamps', () => {
    const words: ExpectedChartWord[] = [
      { ...WORD, id: 'first', text: 'first', startMs: 0, endMs: 100 },
      { ...WORD, id: 'second', text: 'second', startMs: 300, endMs: 400 },
    ];
    const scorer = new KaraokeScoreAccumulator(words, {
      lyricRecognitionAvailable: true, earlyToleranceMs: 0, lateToleranceMs: 0,
      lyricAlignmentToleranceMs: 100,
    });
    fillWord(scorer, words[0]);
    fillWord(scorer, words[1]);
    scorer.replaceLyricResult('later-word', [evidence('second', 320, 380)], true);
    expect(scorer.summary().words.map(word => word.lyricScore)).toEqual([0, 1]);

    const noisy = new KaraokeScoreAccumulator(words, {
      lyricRecognitionAvailable: true, earlyToleranceMs: 0, lateToleranceMs: 0,
      lyricAlignmentToleranceMs: 100,
    });
    fillWord(noisy, words[0]);
    fillWord(noisy, words[1]);
    noisy.replaceLyricResult('sequence', [evidence('wrong', 0, 100), evidence('second', 320, 380)], true);
    expect(noisy.summary().words.map(word => word.lyricScore)).toEqual([0, 1]);
  });

  it('replaces interim revisions and deduplicates final results instead of double counting', () => {
    const scorer = new KaraokeScoreAccumulator([WORD], {
      lyricRecognitionAvailable: true, earlyToleranceMs: 0, lateToleranceMs: 0,
    });
    fillWord(scorer);
    expect(scorer.replaceLyricResult('segment-1', [evidence('hello', undefined, undefined, 0.4)], false)).toBe(true);
    expect(scorer.summary().lyricScore).toBe(0.4);
    expect(scorer.summary({ finalLyricsOnly: true }).score).toBe(0.49);
    expect(scorer.replaceLyricResult('segment-1', [evidence('wrong')], false)).toBe(true);
    expect(scorer.summary().score).toBe(0.49);
    expect(scorer.replaceLyricResult('segment-1', [evidence('hello', undefined, undefined, 0.8)], true)).toBe(true);
    expect(scorer.summary().lyricScore).toBe(0.8);
    expect(scorer.summary({ finalLyricsOnly: true }).lyricScore).toBe(0.8);
    expect(scorer.replaceLyricResult('segment-1', [evidence('wrong')], true)).toBe(false);
    expect(scorer.summary().lyricScore).toBe(0.8);
  });

  it('keeps the fixed lyric weight at zero when no provider is configured', () => {
    const scorer = new KaraokeScoreAccumulator([WORD], { earlyToleranceMs: 0, lateToleranceMs: 0 });
    fillWord(scorer);
    expect(scorer.replaceLyricResult('ignored', [evidence('hello')], true)).toBe(false);
    expect(scorer.summary()).toMatchObject({
      score: 0.7,
      lyricRecognitionAvailable: false,
      components: { timing: 1, lyrics: 0, pitch: 1 },
    });
  });
});
