import type { AudioFrameObservation } from './frame-analyzer';
import { lyricSimilarity } from './lyric-similarity';

export const KARAOKE_TIMING_SCORE_WEIGHT = 0.5;
export const KARAOKE_LYRIC_SCORE_WEIGHT = 0.3;
export const KARAOKE_PITCH_SCORE_WEIGHT = 0.2;
export const KARAOKE_UNVERIFIED_ACOUSTIC_SCALE = 0.7;

export interface ExpectedChartWord {
  readonly id: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly pitchHz?: number;
}

export type ScoringObservation = Pick<
  AudioFrameObservation,
  'mediaTimestampMs' | 'durationMs' | 'rms' | 'voiceActive' | 'pitchHz'
>;

export interface KaraokeScoringOptions {
  readonly earlyToleranceMs?: number;
  readonly lateToleranceMs?: number;
  readonly maximumPitchErrorCents?: number;
  readonly lyricAlignmentToleranceMs?: number;
  readonly locale?: string;
  readonly lyricRecognitionAvailable?: boolean;
}

export interface ObservationScore {
  readonly wordId: string;
  readonly wordText: string;
  readonly mediaTimestampMs: number;
  readonly timingScore: number;
  readonly voiceScore: number;
  readonly lyricScore: null;
  readonly pitchScore: number;
  readonly score: number;
}

export interface RecognizedLyricWordEvidence {
  readonly text: string;
  readonly songStartMs: number;
  readonly songEndMs: number;
  readonly sourceStartMs: number;
  readonly sourceEndMs: number;
  readonly confidence: number;
  readonly source: string;
}

export interface KaraokeLyricEvidenceScore {
  readonly source: string;
  readonly sourceStartMs: number;
  readonly sourceEndMs: number;
  readonly confidence: number;
  readonly final: boolean;
}

export interface KaraokeComponentScores {
  readonly timing: number;
  readonly lyrics: number;
  readonly pitch: number;
}

export interface KaraokeWordScore {
  readonly wordId: string;
  readonly text: string;
  readonly matchedObservations: number;
  readonly coverage: number;
  readonly accuracy: number;
  readonly timingScore: number;
  readonly lyricScore: number;
  readonly pitchScore: number;
  readonly components: KaraokeComponentScores;
  readonly lyricEvidence: KaraokeLyricEvidenceScore | null;
  readonly score: number;
}

export interface KaraokeScoreSummary {
  readonly score: number;
  readonly timingScore: number;
  readonly lyricScore: number;
  readonly pitchScore: number;
  readonly components: KaraokeComponentScores;
  readonly lyricRecognitionAvailable: boolean;
  readonly matchedObservations: number;
  readonly unmatchedObservations: number;
  readonly voicedObservations: number;
  readonly words: readonly KaraokeWordScore[];
}

interface Aggregate {
  matchedObservations: number;
  voicedObservations: number;
  voicedMs: number;
  timingEarnedMs: number;
  pitchEarnedMs: number;
}

interface AlignedLyricEvidence extends KaraokeLyricEvidenceScore {
  readonly wordIndex: number;
  readonly score: number;
}

interface LyricResult {
  readonly final: boolean;
  readonly matches: readonly AlignedLyricEvidence[];
}

const DEFAULT_OPTIONS = {
  earlyToleranceMs: 200,
  lateToleranceMs: 250,
  maximumPitchErrorCents: 200,
  lyricAlignmentToleranceMs: 650,
  locale: 'en-US',
  lyricRecognitionAvailable: false,
} as const;

function scoringOptions(options: KaraokeScoringOptions): Required<KaraokeScoringOptions> {
  const normalized = {
    earlyToleranceMs: options.earlyToleranceMs ?? DEFAULT_OPTIONS.earlyToleranceMs,
    lateToleranceMs: options.lateToleranceMs ?? DEFAULT_OPTIONS.lateToleranceMs,
    maximumPitchErrorCents: options.maximumPitchErrorCents ?? DEFAULT_OPTIONS.maximumPitchErrorCents,
    lyricAlignmentToleranceMs: options.lyricAlignmentToleranceMs ?? DEFAULT_OPTIONS.lyricAlignmentToleranceMs,
    locale: options.locale ?? DEFAULT_OPTIONS.locale,
    lyricRecognitionAvailable: options.lyricRecognitionAvailable ?? DEFAULT_OPTIONS.lyricRecognitionAvailable,
  };
  if (!Number.isFinite(normalized.earlyToleranceMs) || normalized.earlyToleranceMs < 0) {
    throw new RangeError('earlyToleranceMs must be a non-negative finite number');
  }
  if (!Number.isFinite(normalized.lateToleranceMs) || normalized.lateToleranceMs < 0) {
    throw new RangeError('lateToleranceMs must be a non-negative finite number');
  }
  if (!Number.isFinite(normalized.maximumPitchErrorCents) || normalized.maximumPitchErrorCents <= 0) {
    throw new RangeError('maximumPitchErrorCents must be a positive finite number');
  }
  if (!Number.isFinite(normalized.lyricAlignmentToleranceMs) || normalized.lyricAlignmentToleranceMs < 0) {
    throw new RangeError('lyricAlignmentToleranceMs must be a non-negative finite number');
  }
  if (typeof normalized.locale !== 'string' || normalized.locale.length === 0 || normalized.locale.length > 32) {
    throw new TypeError('locale is invalid');
  }
  if (typeof normalized.lyricRecognitionAvailable !== 'boolean') {
    throw new TypeError('lyricRecognitionAvailable is invalid');
  }
  return normalized;
}

function validateWord(word: ExpectedChartWord): void {
  if (typeof word.id !== 'string' || word.id.length === 0) throw new TypeError('chart word id is required');
  if (typeof word.text !== 'string' || word.text.length === 0) throw new TypeError('chart word text is required');
  if (!Number.isFinite(word.startMs) || word.startMs < 0) throw new RangeError('chart word startMs is invalid');
  if (!Number.isFinite(word.endMs) || word.endMs <= word.startMs) throw new RangeError('chart word endMs is invalid');
  if (word.pitchHz !== undefined && (!Number.isFinite(word.pitchHz) || word.pitchHz <= 0)) {
    throw new RangeError('chart word pitchHz is invalid');
  }
}

function validateObservation(observation: ScoringObservation): void {
  if (!Number.isFinite(observation.mediaTimestampMs) || observation.mediaTimestampMs < 0) {
    throw new RangeError('observation mediaTimestampMs is invalid');
  }
  if (!Number.isFinite(observation.durationMs) || observation.durationMs <= 0) {
    throw new RangeError('observation durationMs is invalid');
  }
  if (!Number.isFinite(observation.rms) || observation.rms < 0 || observation.rms > 1) {
    throw new RangeError('observation rms is invalid');
  }
  if (typeof observation.voiceActive !== 'boolean') throw new TypeError('observation voiceActive is invalid');
  if (observation.pitchHz !== null && (!Number.isFinite(observation.pitchHz) || observation.pitchHz <= 0)) {
    throw new RangeError('observation pitchHz is invalid');
  }
}

function rawTimingScore(
  observation: ScoringObservation,
  word: ExpectedChartWord,
  options: Required<KaraokeScoringOptions>,
): number {
  const midpoint = observation.mediaTimestampMs + observation.durationMs / 2;
  if (midpoint >= word.startMs && midpoint <= word.endMs) return 1;
  if (midpoint < word.startMs) {
    if (options.earlyToleranceMs === 0) return 0;
    return Math.max(0, 1 - (word.startMs - midpoint) / options.earlyToleranceMs);
  }
  if (options.lateToleranceMs === 0) return 0;
  return Math.max(0, 1 - (midpoint - word.endMs) / options.lateToleranceMs);
}

/** Scores one timestamped, non-audio observation against one chart word. */
export function scoreObservationAgainstWord(
  observation: ScoringObservation,
  word: ExpectedChartWord,
  options: KaraokeScoringOptions = {},
): ObservationScore {
  validateObservation(observation);
  validateWord(word);
  const normalizedOptions = scoringOptions(options);
  const voice = observation.voiceActive ? 1 : 0;
  const timing = rawTimingScore(observation, word, normalizedOptions) * voice;
  let pitch = 0;
  if (word.pitchHz !== undefined && observation.voiceActive && observation.pitchHz !== null) {
    const rawCents = 1_200 * Math.log2(observation.pitchHz / word.pitchHz);
    const cents = Math.abs(rawCents - Math.round(rawCents / 1_200) * 1_200);
    pitch = Math.max(0, 1 - cents / normalizedOptions.maximumPitchErrorCents);
  }
  return {
    wordId: word.id,
    wordText: word.text,
    mediaTimestampMs: observation.mediaTimestampMs,
    timingScore: timing,
    voiceScore: voice,
    lyricScore: null,
    pitchScore: pitch,
    score: KARAOKE_TIMING_SCORE_WEIGHT * timing + KARAOKE_PITCH_SCORE_WEIGHT * pitch,
  };
}

/** Selects the strongest timing-window match without retaining the observation. */
export function matchObservationToChart(
  observation: ScoringObservation,
  words: readonly ExpectedChartWord[],
  options: KaraokeScoringOptions = {},
): ObservationScore | null {
  validateObservation(observation);
  const normalizedOptions = scoringOptions(options);
  let best: ObservationScore | null = null;
  let bestRawTiming = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  const observationMidpoint = observation.mediaTimestampMs + observation.durationMs / 2;
  for (const word of words) {
    validateWord(word);
    const candidateTiming = rawTimingScore(observation, word, normalizedOptions);
    if (candidateTiming === 0) continue;
    const score = scoreObservationAgainstWord(observation, word, normalizedOptions);
    const wordMidpoint = (word.startMs + word.endMs) / 2;
    const distance = Math.abs(observationMidpoint - wordMidpoint);
    if (best === null || candidateTiming > bestRawTiming || (
      candidateTiming === bestRawTiming && distance < bestDistance
    )) {
      best = score;
      bestRawTiming = candidateTiming;
      bestDistance = distance;
    }
  }
  return best;
}

/** Locale-aware comparison form for provider words and chart words. */
export function normalizeKaraokeLyricWord(value: string, locale: string = DEFAULT_OPTIONS.locale): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase(locale)
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Streaming scorer that stores chart data and aggregate scalar scores only.
 * PCM, mu-law payloads, and recognized transcript text are never retained.
 */
export class KaraokeScoreAccumulator {
  private readonly words: readonly ExpectedChartWord[];
  private readonly aggregates: Aggregate[];
  private readonly options: Required<KaraokeScoringOptions>;
  private readonly wordIndexById = new Map<string, number>();
  private readonly lyricResults = new Map<string, LyricResult>();
  private lyricRecognitionAvailable: boolean;
  private lastObservationEndMs = 0;
  private hasObservation = false;
  private matchedObservations = 0;
  private unmatchedObservations = 0;
  private voicedObservations = 0;

  constructor(words: readonly ExpectedChartWord[], options: KaraokeScoringOptions = {}) {
    if (words.length === 0) throw new TypeError('at least one chart word is required');
    const ids = new Set<string>();
    let previousStart = -1;
    this.words = words.map((word, index) => {
      validateWord(word);
      if (ids.has(word.id)) throw new TypeError(`duplicate chart word id: ${word.id}`);
      if (word.startMs < previousStart) throw new TypeError('chart words must be sorted by startMs');
      ids.add(word.id);
      this.wordIndexById.set(word.id, index);
      previousStart = word.startMs;
      return Object.freeze({ ...word });
    });
    this.aggregates = this.words.map(() => ({
      matchedObservations: 0,
      voicedObservations: 0,
      voicedMs: 0,
      timingEarnedMs: 0,
      pitchEarnedMs: 0,
    }));
    this.options = scoringOptions(options);
    this.lyricRecognitionAvailable = this.options.lyricRecognitionAvailable;
  }

  observe(observation: ScoringObservation): ObservationScore | null {
    validateObservation(observation);
    if (this.hasObservation && observation.mediaTimestampMs < this.lastObservationEndMs) {
      throw new RangeError('observations must be chronological and non-overlapping by media timestamp');
    }
    this.hasObservation = true;
    this.lastObservationEndMs = observation.mediaTimestampMs + observation.durationMs;

    const match = matchObservationToChart(observation, this.words, this.options);
    if (match === null) {
      this.unmatchedObservations += 1;
      return null;
    }
    const wordIndex = this.wordIndexById.get(match.wordId)!;
    const aggregate = this.aggregates[wordIndex]!;
    aggregate.matchedObservations += 1;
    this.matchedObservations += 1;
    if (observation.voiceActive) {
      aggregate.voicedObservations += 1;
      aggregate.voicedMs += observation.durationMs;
      aggregate.timingEarnedMs += observation.durationMs * match.timingScore;
      aggregate.pitchEarnedMs += observation.durationMs * match.pitchScore;
      this.voicedObservations += 1;
    }
    return match;
  }

  /** Restores the timing/pitch-only fallback after an active recognizer becomes unavailable. */
  disableLyricRecognition(): boolean {
    if (!this.lyricRecognitionAvailable) return false;
    this.lyricRecognitionAvailable = false;
    this.lyricResults.clear();
    return true;
  }

  /** Replaces one provider segment revision. Duplicate final segments are idempotent. */
  replaceLyricResult(
    resultId: string,
    evidence: readonly RecognizedLyricWordEvidence[],
    final: boolean,
  ): boolean {
    if (!this.lyricRecognitionAvailable) return false;
    if (typeof resultId !== 'string' || resultId.length === 0 || resultId.length > 128
      || /[\p{Cc}]/u.test(resultId)) throw new TypeError('lyric resultId is invalid');
    if (typeof final !== 'boolean') throw new TypeError('lyric final flag is invalid');
    const prior = this.lyricResults.get(resultId);
    if (prior?.final) return false;
    if (evidence.length > 256) throw new RangeError('too many recognized lyric words');

    const ordered = evidence.map((word, index) => {
      validateLyricEvidence(word);
      return { word, index };
    }).sort((left, right) => left.word.songStartMs - right.word.songStartMs || left.index - right.index);
    const matches: AlignedLyricEvidence[] = [];
    let nextWordIndex = 0;
    for (const { word: recognized } of ordered) {
      const normalizedRecognized = normalizeKaraokeLyricWord(recognized.text, this.options.locale);
      const recognizedMidpoint = (recognized.songStartMs + recognized.songEndMs) / 2;
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      let bestSimilarity = 0;
      let secondSimilarity = 0;
      for (let index = nextWordIndex; index < this.words.length; index += 1) {
        const expected = this.words[index]!;
        if (expected.startMs - this.options.lyricAlignmentToleranceMs > recognized.songEndMs) break;
        if (expected.endMs + this.options.lyricAlignmentToleranceMs < recognized.songStartMs) continue;
        const similarity = lyricSimilarity(expected.text, normalizedRecognized, this.options.locale);
        if (similarity === 0 || (similarity < 1 && recognized.confidence < 0.8)) continue;
        const distance = Math.abs(recognizedMidpoint - (expected.startMs + expected.endMs) / 2);
        if (similarity > bestSimilarity || (similarity === bestSimilarity && distance < bestDistance)) {
          secondSimilarity = bestSimilarity;
          bestIndex = index;
          bestSimilarity = similarity;
          bestDistance = distance;
        } else secondSimilarity = Math.max(secondSimilarity, similarity);
      }
      if (bestIndex < 0 || (bestSimilarity < 1 && bestSimilarity - secondSimilarity < 0.05)) continue;
      matches.push(Object.freeze({
        wordIndex: bestIndex,
        score: recognized.confidence * bestSimilarity,
        source: recognized.source,
        sourceStartMs: recognized.sourceStartMs,
        sourceEndMs: recognized.sourceEndMs,
        confidence: recognized.confidence,
        final,
      }));
      nextWordIndex = bestIndex + 1;
    }
    this.lyricResults.set(resultId, Object.freeze({ final, matches: Object.freeze(matches) }));
    return true;
  }

  summary(options: { finalLyricsOnly?: boolean } = {}): KaraokeScoreSummary {
    const lyricByWord = this.lyricRecognitionAvailable
      ? this.bestLyricEvidence(options.finalLyricsOnly === true)
      : new Map();
    let weightedTiming = 0;
    let weightedLyrics = 0;
    let weightedPitch = 0;
    let totalDuration = 0;
    const words = this.words.map((word, index): KaraokeWordScore => {
      const aggregate = this.aggregates[index]!;
      const duration = word.endMs - word.startMs;
      const coverage = Math.min(1, aggregate.voicedMs / duration);
      const lyricEvidence = lyricByWord.get(index) ?? null;
      // Provider output cannot create a score without locally detected caller voice for this word.
      const lyrics = aggregate.voicedMs === 0 ? 0 : lyricEvidence?.score ?? 0;
      const acousticScale = this.lyricRecognitionAvailable
        ? KARAOKE_UNVERIFIED_ACOUSTIC_SCALE
          + (1 - KARAOKE_UNVERIFIED_ACOUSTIC_SCALE) * (lyricEvidence?.score ?? 0)
        : 1;
      const timing = acousticScale * Math.min(1, aggregate.timingEarnedMs / duration);
      const pitch = word.pitchHz !== undefined
        ? acousticScale * Math.min(1, aggregate.pitchEarnedMs / duration)
        : 0;
      const components = Object.freeze({ timing, lyrics, pitch });
      const score = weightedComponentScore(components);
      const audioMaximum = aggregate.voicedMs * (KARAOKE_TIMING_SCORE_WEIGHT + KARAOKE_PITCH_SCORE_WEIGHT);
      const audioEarned = acousticScale * (
        KARAOKE_TIMING_SCORE_WEIGHT * aggregate.timingEarnedMs
          + KARAOKE_PITCH_SCORE_WEIGHT * aggregate.pitchEarnedMs
      );
      weightedTiming += timing * duration;
      weightedLyrics += lyrics * duration;
      weightedPitch += pitch * duration;
      totalDuration += duration;
      return Object.freeze({
        wordId: word.id,
        text: word.text,
        matchedObservations: aggregate.matchedObservations,
        coverage,
        accuracy: audioMaximum === 0 ? 0 : audioEarned / audioMaximum,
        timingScore: timing,
        lyricScore: lyrics,
        pitchScore: pitch,
        components,
        lyricEvidence: lyricEvidence ? publicLyricEvidence(lyricEvidence) : null,
        score,
      });
    });
    const divisor = totalDuration || 1;
    const components = Object.freeze({
      timing: weightedTiming / divisor,
      lyrics: weightedLyrics / divisor,
      pitch: weightedPitch / divisor,
    });
    return Object.freeze({
      score: this.voicedObservations === 0 ? 0 : weightedComponentScore(components),
      timingScore: components.timing,
      lyricScore: components.lyrics,
      pitchScore: components.pitch,
      components,
      lyricRecognitionAvailable: this.lyricRecognitionAvailable,
      matchedObservations: this.matchedObservations,
      unmatchedObservations: this.unmatchedObservations,
      voicedObservations: this.voicedObservations,
      words: Object.freeze(words),
    });
  }

  private bestLyricEvidence(finalOnly = false): Map<number, AlignedLyricEvidence> {
    const selected = new Map<number, AlignedLyricEvidence>();
    for (const result of this.lyricResults.values()) {
      for (const candidate of result.matches) {
        if (finalOnly && !candidate.final) continue;
        const current = selected.get(candidate.wordIndex);
        if (!current || (candidate.final && !current.final)
          || (candidate.final === current.final && candidate.score > current.score)) {
          selected.set(candidate.wordIndex, candidate);
        }
      }
    }
    return selected;
  }
}

function validateLyricEvidence(word: RecognizedLyricWordEvidence): void {
  if (typeof word.text !== 'string' || word.text.length === 0 || word.text.length > 128
    || /[\p{Cc}]/u.test(word.text)) throw new TypeError('recognized lyric text is invalid');
  for (const [name, value] of [
    ['songStartMs', word.songStartMs],
    ['songEndMs', word.songEndMs],
    ['sourceStartMs', word.sourceStartMs],
    ['sourceEndMs', word.sourceEndMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 24 * 60 * 60 * 1_000) {
      throw new RangeError(`recognized lyric ${name} is invalid`);
    }
  }
  if (word.songEndMs < word.songStartMs || word.sourceEndMs < word.sourceStartMs) {
    throw new RangeError('recognized lyric timestamp range is invalid');
  }
  if (!Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1) {
    throw new RangeError('recognized lyric confidence is invalid');
  }
  if (typeof word.source !== 'string' || word.source.length === 0 || word.source.length > 32
    || !/^[A-Za-z0-9_-]+$/.test(word.source)) throw new TypeError('recognized lyric source is invalid');
}

function weightedComponentScore(components: KaraokeComponentScores): number {
  return KARAOKE_TIMING_SCORE_WEIGHT * components.timing
    + KARAOKE_LYRIC_SCORE_WEIGHT * components.lyrics
    + KARAOKE_PITCH_SCORE_WEIGHT * components.pitch;
}

function publicLyricEvidence(evidence: AlignedLyricEvidence): KaraokeLyricEvidenceScore {
  return Object.freeze({
    source: evidence.source,
    sourceStartMs: evidence.sourceStartMs,
    sourceEndMs: evidence.sourceEndMs,
    confidence: evidence.confidence,
    final: evidence.final,
  });
}
