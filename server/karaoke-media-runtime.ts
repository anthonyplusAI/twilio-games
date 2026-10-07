import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { KaraokeJudgment, KaraokePhase } from '../shared/karaoke-protocol';
import { KARAOKE_MAX_SCORE } from '../shared/karaoke-protocol';
import type { KaraokeSong } from '../shared/karaoke';
import { KARAOKE_DEVELOPMENT_SONGS } from '../shared/karaoke-songs';
import type { KaraokeServer } from './karaoke-server';
import { KaraokeFrameWindow } from './audio/karaoke-frame-window';
import { analyzePcmFrame, type FrameAnalyzerOptions } from './audio/frame-analyzer';
import {
  KaraokeScoreAccumulator,
  type RecognizedLyricWordEvidence,
  type KaraokeScoringOptions,
  type KaraokeScoreSummary,
} from './audio/scoring';
import type {
  KaraokeLyricRecognitionResult,
  KaraokeLyricRecognizerFactory,
  KaraokeStreamingLyricRecognizer,
} from './karaoke-lyric-recognizer';
import {
  TwilioMediaStreamParseError,
  TwilioMediaStreamParser,
  type TwilioMediaFrame,
  type TwilioStartFrame,
} from './audio/twilio-media-stream';

const DEFAULT_TOKEN_TTL_MS = 60_000;
const MAX_TOKEN_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_PENDING_ATTEMPTS = 128;
const DEFAULT_MAX_ACTIVE_SESSIONS = 4;
const DEFAULT_MAX_REMEMBERED_ATTEMPTS = 256;
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1_024;
const DEFAULT_MAX_SESSION_MEDIA_BYTES = 8_000 * 65;
const DEFAULT_MAX_SESSION_DURATION_MS = 65_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 70_000;
const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 5_000;
const DEFAULT_CLEAN_STOP_GRACE_MS = 8_000;
const DEFAULT_FINALIZED_RETENTION_MS = 5 * 60_000;
const DEFAULT_LATE_TOLERANCE_MS = 180;
const DEFAULT_LYRIC_JUDGMENT_GRACE_MS = 250;
export const KARAOKE_LYRIC_FINALIZATION_TIMEOUT_MS = 2_500;
const DUMMY_TOKEN_DIGEST = Buffer.alloc(32);
const ACTIVE_ATTEMPT_PHASES: readonly KaraokePhase[] = ['loading', 'countdown', 'performing'];

export const KARAOKE_MEDIA_CUSTOM_PARAMETERS = Object.freeze({
  attemptId: 'attemptId',
  token: 'attemptToken',
  roomCode: 'roomCode',
  playerId: 'playerId',
  songId: 'songId',
  loadingGeneration: 'loadingGeneration',
} as const);

export type KaraokeMediaErrorCode =
  | 'RUNTIME_CLOSED'
  | 'ATTEMPT_CAPACITY'
  | 'SESSION_CAPACITY'
  | 'INVALID_ATTEMPT'
  | 'INVALID_TOKEN'
  | 'ATTEMPT_EXPIRED'
  | 'ATTEMPT_REPLAYED'
  | 'IDENTITY_MISMATCH'
  | 'STALE_ATTEMPT'
  | 'SESSION_LIMIT'
  | 'SESSION_CLOSED';

export class KaraokeMediaError extends Error {
  constructor(readonly code: KaraokeMediaErrorCode, message: string) {
    super(message);
    this.name = 'KaraokeMediaError';
  }
}

export interface KaraokeMediaAttemptBinding {
  readonly accountSid: string;
  readonly callSid: string;
  readonly roomCode: string;
  readonly playerId: string;
  readonly songId: string;
  readonly loadingGeneration: number;
}

export interface KaraokeMediaAttemptRequest extends KaraokeMediaAttemptBinding {
  /** Song start in the Twilio Media Streams timestamp domain. */
  readonly songStartTimestampMs: number;
  /** Added after subtracting songStartTimestampMs; useful for measured transport calibration. */
  readonly calibrationOffsetMs?: number;
  readonly expiresInMs?: number;
}

export interface KaraokeMediaAttempt extends KaraokeMediaAttemptBinding {
  readonly attemptId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly songStartTimestampMs: number;
  readonly calibrationOffsetMs: number;
}

export interface IssuedKaraokeMediaAttempt extends KaraokeMediaAttempt {
  readonly token: string;
  readonly customParameters: Readonly<Record<string, string>>;
}

export interface KaraokeMediaAttemptCredentials extends KaraokeMediaAttemptBinding {
  readonly attemptId: string;
  readonly token: string;
}

interface StoredAttempt extends KaraokeMediaAttempt {
  readonly tokenDigest: Buffer;
}

interface UsedAttempt {
  readonly tokenDigest: Buffer;
  readonly forgetAtMs: number;
}

export interface KaraokeMediaAttemptRegistryOptions {
  readonly now?: () => number;
  readonly defaultTtlMs?: number;
  readonly maxPendingAttempts?: number;
  readonly maxRememberedAttempts?: number;
  readonly replayRetentionMs?: number;
}

/** In-memory, process-local one-use credentials for Twilio start frames. */
export class KaraokeMediaAttemptRegistry {
  private readonly pending = new Map<string, StoredAttempt>();
  private readonly used = new Map<string, UsedAttempt>();
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly maxPendingAttempts: number;
  private readonly maxRememberedAttempts: number;
  private readonly replayRetentionMs: number;

  constructor(options: KaraokeMediaAttemptRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = positiveInteger(options.defaultTtlMs ?? DEFAULT_TOKEN_TTL_MS, 'defaultTtlMs');
    if (this.defaultTtlMs > MAX_TOKEN_TTL_MS) throw new RangeError('defaultTtlMs is too large');
    this.maxPendingAttempts = positiveInteger(
      options.maxPendingAttempts ?? DEFAULT_MAX_PENDING_ATTEMPTS,
      'maxPendingAttempts',
    );
    this.maxRememberedAttempts = positiveInteger(
      options.maxRememberedAttempts ?? DEFAULT_MAX_REMEMBERED_ATTEMPTS,
      'maxRememberedAttempts',
    );
    this.replayRetentionMs = positiveInteger(
      options.replayRetentionMs ?? DEFAULT_FINALIZED_RETENTION_MS,
      'replayRetentionMs',
    );
  }

  issue(request: KaraokeMediaAttemptRequest): IssuedKaraokeMediaAttempt {
    validateBinding(request);
    const now = this.now();
    this.reap(now);
    if (this.pending.size >= this.maxPendingAttempts) {
      throw new KaraokeMediaError('ATTEMPT_CAPACITY', 'too many pending karaoke media attempts');
    }
    const expiresInMs = positiveInteger(request.expiresInMs ?? this.defaultTtlMs, 'expiresInMs');
    if (expiresInMs > MAX_TOKEN_TTL_MS) throw new RangeError('expiresInMs is too large');
    nonNegativeSafeInteger(request.songStartTimestampMs, 'songStartTimestampMs');
    const calibrationOffsetMs = request.calibrationOffsetMs ?? 0;
    if (!Number.isSafeInteger(calibrationOffsetMs) || Math.abs(calibrationOffsetMs) > 5_000) {
      throw new RangeError('calibrationOffsetMs must be an integer from -5000 to 5000');
    }

    let attemptId: string;
    do attemptId = randomBytes(24).toString('base64url');
    while (this.pending.has(attemptId) || this.used.has(attemptId));
    const token = randomBytes(32).toString('base64url');
    const attempt: StoredAttempt = Object.freeze({
      attemptId,
      accountSid: request.accountSid,
      callSid: request.callSid,
      roomCode: request.roomCode,
      playerId: request.playerId,
      songId: request.songId,
      loadingGeneration: request.loadingGeneration,
      issuedAtMs: now,
      expiresAtMs: now + expiresInMs,
      songStartTimestampMs: request.songStartTimestampMs,
      calibrationOffsetMs,
      tokenDigest: tokenDigest(token),
    });
    this.pending.set(attemptId, attempt);
    return Object.freeze({
      ...publicAttempt(attempt),
      token,
      customParameters: Object.freeze({
        [KARAOKE_MEDIA_CUSTOM_PARAMETERS.attemptId]: attemptId,
        [KARAOKE_MEDIA_CUSTOM_PARAMETERS.token]: token,
        [KARAOKE_MEDIA_CUSTOM_PARAMETERS.roomCode]: request.roomCode,
        [KARAOKE_MEDIA_CUSTOM_PARAMETERS.playerId]: request.playerId,
        [KARAOKE_MEDIA_CUSTOM_PARAMETERS.songId]: request.songId,
        [KARAOKE_MEDIA_CUSTOM_PARAMETERS.loadingGeneration]: String(request.loadingGeneration),
      }),
    });
  }

  consume(credentials: KaraokeMediaAttemptCredentials): KaraokeMediaAttempt {
    const pending = this.pending.get(credentials.attemptId);
    const used = this.used.get(credentials.attemptId);
    const expectedDigest = pending?.tokenDigest ?? used?.tokenDigest ?? DUMMY_TOKEN_DIGEST;
    const boundedToken = typeof credentials.token === 'string' && credentials.token.length <= 256
      ? credentials.token
      : '';
    const suppliedDigest = tokenDigest(boundedToken);
    const validToken = timingSafeEqual(expectedDigest, suppliedDigest)
      && credentials.token === boundedToken;
    suppliedDigest.fill(0);
    if (!validToken || (!pending && !used)) {
      throw new KaraokeMediaError('INVALID_TOKEN', 'invalid karaoke media attempt token');
    }
    if (used) throw new KaraokeMediaError('ATTEMPT_REPLAYED', 'karaoke media attempt was already used');

    const now = this.now();
    if (now >= pending!.expiresAtMs) {
      pending!.tokenDigest.fill(0);
      this.pending.delete(credentials.attemptId);
      throw new KaraokeMediaError('ATTEMPT_EXPIRED', 'karaoke media attempt expired');
    }
    if (!sameBinding(pending!, credentials)) {
      throw new KaraokeMediaError('IDENTITY_MISMATCH', 'karaoke media attempt identity does not match');
    }

    this.pending.delete(credentials.attemptId);
    this.rememberUsed(pending!, now);
    this.reap(now);
    return publicAttempt(pending!);
  }

  revoke(attemptId: string): boolean {
    const attempt = this.pending.get(attemptId);
    if (!attempt) return false;
    attempt.tokenDigest.fill(0);
    this.pending.delete(attemptId);
    return true;
  }

  clear(): void {
    for (const attempt of this.pending.values()) attempt.tokenDigest.fill(0);
    for (const attempt of this.used.values()) attempt.tokenDigest.fill(0);
    this.pending.clear();
    this.used.clear();
  }

  private rememberUsed(attempt: StoredAttempt, now: number): void {
    this.used.set(attempt.attemptId, {
      tokenDigest: Buffer.from(attempt.tokenDigest),
      forgetAtMs: Math.max(attempt.expiresAtMs, now + this.replayRetentionMs),
    });
    attempt.tokenDigest.fill(0);
    while (this.used.size > this.maxRememberedAttempts) {
      const oldest = this.used.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.used.get(oldest)?.tokenDigest.fill(0);
      this.used.delete(oldest);
    }
  }

  private reap(now: number): void {
    for (const [attemptId, attempt] of this.pending) {
      if (now < attempt.expiresAtMs) continue;
      attempt.tokenDigest.fill(0);
      this.pending.delete(attemptId);
    }
    for (const [attemptId, attempt] of this.used) {
      if (now < attempt.forgetAtMs) continue;
      attempt.tokenDigest.fill(0);
      this.used.delete(attemptId);
    }
  }
}

export interface KaraokeMediaScoreServer {
  findRoom(code: string): Pick<NonNullable<ReturnType<KaraokeServer['findRoom']>>, 'state'> | undefined;
  markMediaReady?(
    code: string,
    playerId: string,
    songId: string,
    loadingGeneration: number,
    songStartTimestampMs: number,
  ): boolean;
  recordWordJudgment(
    code: string,
    playerId: string,
    wordId: string,
    judgment: KaraokeJudgment,
    points: number,
  ): boolean;
  updateScore(code: string, playerId: string, score: number): boolean;
  /** `score` is a derived checksum; the room must atomically recompute authoritative state from `hits`. */
  finalizeMediaScore(
    code: string,
    playerId: string,
    score: number,
    hits: readonly KaraokeMediaFinalJudgment[],
  ): boolean;
}

export interface KaraokeMediaFinalJudgment {
  readonly wordId: string;
  readonly judgment: KaraokeJudgment;
  readonly points: number;
}

export type KaraokeMediaFinalizeReason = 'stop' | 'socket-close' | 'manual' | 'session-timeout';

export interface KaraokeMediaQualityDiagnostics {
  readonly mediaFrames: number;
  readonly mediaBytes: number;
  readonly analyzedWindows: number;
  readonly scoredWindows: number;
  readonly matchedObservations: number;
  readonly unmatchedObservations: number;
  readonly voicedWindows: number;
  readonly pitchedWindows: number;
  readonly voicedRatio: number;
  readonly pitchDetectionRatio: number;
  readonly averageRms: number;
  readonly averagePitchClarity: number;
  readonly discardedLeadingWindows: number;
  readonly discardedTrailingWindows: number;
  readonly discardedPartialSamples: number;
  readonly judgmentsEmitted: number;
  readonly judgmentsRejected: number;
  readonly identityCurrentAtFinalize: boolean;
  readonly lyricRecognitionAvailable: boolean;
  readonly lyricProvider: string | null;
  readonly lyricFinalizationTimedOut: boolean;
  readonly timingScore: number;
  readonly lyricScore: number;
  readonly pitchScore: number;
  readonly retainedPcmSamples: 0;
  readonly rawAudioRetained: false;
}

export interface KaraokeMediaFinalResult {
  readonly attemptId: string;
  readonly score: number;
  /** Complete chart-order judgments derived after lyric finalization. */
  readonly judgments: readonly KaraokeMediaFinalJudgment[];
  readonly scoreAccepted: boolean;
  readonly finalizedAtMs: number;
  readonly reason: KaraokeMediaFinalizeReason;
  readonly scoring: KaraokeScoreSummary;
  readonly diagnostics: KaraokeMediaQualityDiagnostics;
}

export interface KaraokeMediaSessionInspection {
  readonly attemptId: string;
  readonly mediaFrames: number;
  readonly mediaBytes: number;
  readonly analyzedWindows: number;
  readonly retainedPcmSamples: number;
  readonly finalized: boolean;
  readonly rawAudioRetained: false;
}

interface KaraokeMediaSessionOptions {
  readonly attempt: KaraokeMediaAttempt;
  readonly song: KaraokeSong;
  readonly scoreServer: KaraokeMediaScoreServer;
  readonly now: () => number;
  readonly windowMs: number;
  readonly analyzerOptions: FrameAnalyzerOptions;
  readonly scoringOptions: KaraokeScoringOptions;
  readonly goodThreshold: number;
  readonly perfectThreshold: number;
  readonly lateToleranceMs: number;
  readonly lyricJudgmentGraceMs: number;
  readonly lyricFinalizationTimeoutMs: number;
  readonly lyricRecognizerFactory?: KaraokeLyricRecognizerFactory;
  readonly maxMediaBytes: number;
  readonly maxDurationMs: number;
  readonly identityIsCurrent: () => boolean;
  readonly songStartTimestampMs: number;
  readonly onCoverageComplete: () => void;
  readonly onFinalized: (result: KaraokeMediaFinalResult) => void;
  readonly onAborted: () => void;
  readonly setTimeout: typeof setTimeout;
  readonly clearTimeout: typeof clearTimeout;
}

/** One authenticated stream. It retains chart aggregates, never analyzed PCM. */
export class KaraokeMediaSession {
  readonly attempt: KaraokeMediaAttempt;
  private readonly song: KaraokeSong;
  private readonly scoreServer: KaraokeMediaScoreServer;
  private readonly now: () => number;
  private readonly frameWindow: KaraokeFrameWindow;
  private readonly scorer: KaraokeScoreAccumulator;
  private readonly lyricRecognizer: KaraokeStreamingLyricRecognizer | null;
  private readonly goodThreshold: number;
  private readonly perfectThreshold: number;
  private readonly lateToleranceMs: number;
  private readonly lyricJudgmentGraceMs: number;
  private readonly lyricFinalizationTimeoutMs: number;
  private readonly maxMediaBytes: number;
  private readonly maxDurationMs: number;
  private readonly analyzerOptions: FrameAnalyzerOptions;
  private readonly identityIsCurrent: () => boolean;
  private readonly songStartTimestampMs: number;
  private readonly onCoverageComplete: () => void;
  private readonly onFinalized: (result: KaraokeMediaFinalResult) => void;
  private readonly onAborted: () => void;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;
  private readonly judgedWords = new Set<string>();
  private readonly confirmedLiveJudgments = new Map<string, KaraokeMediaFinalJudgment>();
  private latestSongTimestampMs = 0;
  private finalResult: KaraokeMediaFinalResult | null = null;
  private finalizationPromise: Promise<KaraokeMediaFinalResult> | null = null;
  private scoreFrozen = false;
  private aborted = false;
  private mediaFrames = 0;
  private mediaBytes = 0;
  private analyzedWindows = 0;
  private scoredWindows = 0;
  private voicedWindows = 0;
  private pitchedWindows = 0;
  private rmsTotal = 0;
  private pitchClarityTotal = 0;
  private discardedLeadingWindows = 0;
  private discardedTrailingWindows = 0;
  private judgmentsEmitted = 0;
  private judgmentsRejected = 0;
  private songTimestampCovered = false;
  private lyricProviderFailed = false;
  private lyricFinalizationTimedOut = false;
  private readonly lyricRecognitionRequired: boolean;

  constructor(options: KaraokeMediaSessionOptions) {
    this.attempt = options.attempt;
    this.song = options.song;
    this.scoreServer = options.scoreServer;
    this.now = options.now;
    this.frameWindow = new KaraokeFrameWindow({ windowMs: options.windowMs, track: 'inbound' });
    this.lyricRecognitionRequired = options.lyricRecognizerFactory !== undefined;
    let lyricRecognizer: KaraokeStreamingLyricRecognizer | null = null;
    if (options.lyricRecognizerFactory) {
      try {
        lyricRecognizer = options.lyricRecognizerFactory.create({
          locale: options.song.locale,
          expectedWords: options.song.chart.words.map(word => word.text),
          onResult: result => this.acceptLyricResult(result),
          onError: () => this.markLyricProviderFailed(),
        });
      } catch {
        lyricRecognizer = null;
        this.lyricProviderFailed = true;
      }
    }
    this.lyricRecognizer = lyricRecognizer;
    this.scorer = new KaraokeScoreAccumulator(options.song.chart.words.map(word => ({
      id: word.id,
      text: word.text,
      startMs: word.startMs,
      endMs: word.endMs,
      pitchHz: midiToHz(word.targetMidi),
    })), {
      ...options.scoringOptions,
      locale: options.song.locale,
      lyricRecognitionAvailable: this.lyricRecognitionRequired,
    });
    this.goodThreshold = options.goodThreshold;
    this.perfectThreshold = options.perfectThreshold;
    this.lateToleranceMs = options.lateToleranceMs;
    this.lyricJudgmentGraceMs = options.lyricJudgmentGraceMs;
    this.lyricFinalizationTimeoutMs = options.lyricFinalizationTimeoutMs;
    this.maxMediaBytes = options.maxMediaBytes;
    this.maxDurationMs = options.maxDurationMs;
    this.analyzerOptions = options.analyzerOptions;
    this.identityIsCurrent = options.identityIsCurrent;
    this.songStartTimestampMs = options.songStartTimestampMs;
    this.onCoverageComplete = options.onCoverageComplete;
    this.onFinalized = options.onFinalized;
    this.onAborted = options.onAborted;
    this.scheduleTimeout = options.setTimeout;
    this.cancelTimeout = options.clearTimeout;
  }

  acceptMedia(frame: TwilioMediaFrame): void {
    if (this.finalResult || this.finalizationPromise || this.aborted) {
      throw new KaraokeMediaError('SESSION_CLOSED', 'karaoke media session is closed');
    }
    if (!this.identityIsCurrent()) throw new KaraokeMediaError('STALE_ATTEMPT', 'karaoke media identity is stale');
    const nextBytes = this.mediaBytes + frame.media.payload.byteLength;
    const frameEndMs = frame.media.timestampMs + frame.media.durationMs;
    if (nextBytes > this.maxMediaBytes || frameEndMs > this.maxDurationMs) {
      throw new KaraokeMediaError('SESSION_LIMIT', 'karaoke media session limit exceeded');
    }
    this.mediaFrames += 1;
    this.mediaBytes = nextBytes;
    if (this.lyricRecognizer && !this.lyricProviderFailed) {
      try {
        this.lyricRecognizer.acceptAudio({
          audio: frame.media.payload,
          mediaTimestampMs: frame.media.timestampMs,
          durationMs: frame.media.durationMs,
        });
      } catch {
        this.markLyricProviderFailed();
      }
    }
    const mappedFrameEnd = frameEndMs - this.songStartTimestampMs + this.attempt.calibrationOffsetMs;
    if (!this.songTimestampCovered && mappedFrameEnd >= this.song.durationMs) {
      this.songTimestampCovered = true;
      this.onCoverageComplete();
    }

    const windows = this.frameWindow.push(frame);
    for (const window of windows) {
      try {
        const observation = analyzePcmFrame(window.samples, window.mediaTimestampMs, this.analyzerOptions);
        this.analyzedWindows += 1;
        this.rmsTotal += observation.rms;
        if (observation.voiceActive) this.voicedWindows += 1;
        if (observation.pitchHz !== null) {
          this.pitchedWindows += 1;
          this.pitchClarityTotal += observation.pitchClarity;
        }

        const mappedStart = observation.mediaTimestampMs
          - this.songStartTimestampMs
          + this.attempt.calibrationOffsetMs;
        const mappedEnd = mappedStart + observation.durationMs;
        if (mappedEnd <= 0) {
          this.discardedLeadingWindows += 1;
          continue;
        }
        if (mappedStart >= this.song.durationMs) {
          this.judgeThrough(mappedEnd);
          this.discardedTrailingWindows += 1;
          continue;
        }
        const clippedStart = Math.max(0, mappedStart);
        const clippedEnd = Math.min(this.song.durationMs, mappedEnd);
        if (clippedEnd <= clippedStart) continue;
        this.scorer.observe({
          mediaTimestampMs: clippedStart,
          durationMs: clippedEnd - clippedStart,
          rms: observation.rms,
          voiceActive: observation.voiceActive,
          pitchHz: observation.pitchHz,
        });
        this.scoredWindows += 1;
        this.judgeThrough(mappedEnd);
      } finally {
        window.samples.fill(0);
      }
    }
  }

  finalize(reason: KaraokeMediaFinalizeReason = 'manual'): Promise<KaraokeMediaFinalResult> {
    if (this.finalResult) return Promise.resolve(this.finalResult);
    if (this.finalizationPromise) return this.finalizationPromise;
    this.finalizationPromise = this.finalizeOnce(reason);
    return this.finalizationPromise;
  }

  private async finalizeOnce(reason: KaraokeMediaFinalizeReason): Promise<KaraokeMediaFinalResult> {
    if (this.aborted) throw new KaraokeMediaError('SESSION_CLOSED', 'karaoke media session was aborted');
    if (!this.songTimestampCovered) {
      this.finalizationPromise = null;
      this.abort();
      throw new KaraokeMediaError('SESSION_CLOSED', 'karaoke media ended before song timestamp coverage');
    }
    const discardedPartialSamples = this.frameWindow.close();
    await this.finalizeLyricRecognizer();
    if (this.aborted) throw new KaraokeMediaError('SESSION_CLOSED', 'karaoke media session was aborted');
    this.scoreFrozen = true;
    const summary = this.scorer.summary({ finalLyricsOnly: true });
    const judgments = this.buildFinalJudgments(summary);
    const score = boundedScore(judgments.reduce((total, judgment) => total + judgment.points, 0));
    const identityCurrentAtFinalize = this.identityIsCurrent();
    let scoreAccepted = false;
    const lyricProviderHealthy = !this.lyricRecognitionRequired
      || (this.lyricRecognizer !== null && !this.lyricProviderFailed);
    if (identityCurrentAtFinalize && lyricProviderHealthy) {
      try {
        scoreAccepted = this.scoreServer.finalizeMediaScore(
          this.attempt.roomCode,
          this.attempt.playerId,
          score,
          judgments,
        );
      } catch {
        scoreAccepted = false;
      }
    }
    const voicedRatio = this.analyzedWindows === 0 ? 0 : this.voicedWindows / this.analyzedWindows;
    const pitchDetectionRatio = this.voicedWindows === 0 ? 0 : this.pitchedWindows / this.voicedWindows;
    const diagnostics: KaraokeMediaQualityDiagnostics = Object.freeze({
      mediaFrames: this.mediaFrames,
      mediaBytes: this.mediaBytes,
      analyzedWindows: this.analyzedWindows,
      scoredWindows: this.scoredWindows,
      matchedObservations: summary.matchedObservations,
      unmatchedObservations: summary.unmatchedObservations,
      voicedWindows: this.voicedWindows,
      pitchedWindows: this.pitchedWindows,
      voicedRatio,
      pitchDetectionRatio,
      averageRms: this.analyzedWindows === 0 ? 0 : this.rmsTotal / this.analyzedWindows,
      averagePitchClarity: this.pitchedWindows === 0 ? 0 : this.pitchClarityTotal / this.pitchedWindows,
      discardedLeadingWindows: this.discardedLeadingWindows,
      discardedTrailingWindows: this.discardedTrailingWindows,
      discardedPartialSamples,
      judgmentsEmitted: this.judgmentsEmitted,
      judgmentsRejected: this.judgmentsRejected,
      identityCurrentAtFinalize,
      lyricRecognitionAvailable: summary.lyricRecognitionAvailable && !this.lyricProviderFailed,
      lyricProvider: this.lyricRecognizer?.source ?? null,
      lyricFinalizationTimedOut: this.lyricFinalizationTimedOut,
      timingScore: summary.timingScore,
      lyricScore: summary.lyricScore,
      pitchScore: summary.pitchScore,
      retainedPcmSamples: 0,
      rawAudioRetained: false,
    });
    this.finalResult = Object.freeze({
      attemptId: this.attempt.attemptId,
      score,
      judgments,
      scoreAccepted,
      finalizedAtMs: this.now(),
      reason,
      scoring: summary,
      diagnostics,
    });
    this.onFinalized(this.finalResult);
    return this.finalResult;
  }

  close(reason: KaraokeMediaFinalizeReason = 'manual'): Promise<KaraokeMediaFinalResult> {
    return this.finalize(reason);
  }

  abort(): boolean {
    if (this.finalResult || this.aborted) return false;
    this.aborted = true;
    this.scoreFrozen = true;
    this.lyricRecognizer?.close();
    this.frameWindow.close();
    this.onAborted();
    return true;
  }

  get isAborted(): boolean { return this.aborted; }
  get isFinalizing(): boolean { return this.finalizationPromise !== null && this.finalResult === null; }
  get hasSongTimestampCoverage(): boolean { return this.songTimestampCovered; }

  inspect(): KaraokeMediaSessionInspection {
    return Object.freeze({
      attemptId: this.attempt.attemptId,
      mediaFrames: this.mediaFrames,
      mediaBytes: this.mediaBytes,
      analyzedWindows: this.analyzedWindows,
      retainedPcmSamples: this.frameWindow.retainedSampleCount,
      finalized: this.finalResult !== null,
      rawAudioRetained: false,
    });
  }

  private judgeThrough(songTimestampMs: number): void {
    this.latestSongTimestampMs = Math.max(this.latestSongTimestampMs, songTimestampMs);
    // The display must not count interim ASR guesses that can later reverse.
    // These are the same finalized lyric facts used by the result/leaderboard.
    const summary = this.scorer.summary({ finalLyricsOnly: true });
    for (let index = 0; index < this.song.chart.words.length; index += 1) {
      const word = this.song.chart.words[index]!;
      const lyricGraceMs = this.lyricRecognizer && !this.lyricProviderFailed ? this.lyricJudgmentGraceMs : 0;
      if (word.endMs + this.lateToleranceMs + lyricGraceMs > songTimestampMs) continue;
      this.emitLiveJudgment(index, summary);
    }
  }

  private buildFinalJudgments(summary: KaraokeScoreSummary): readonly KaraokeMediaFinalJudgment[] {
    return Object.freeze(this.song.chart.words.map((_word, index) => {
      const calculated = this.judgmentForWord(index, summary);
      return this.confirmedLiveJudgments.get(calculated.wordId) ?? calculated;
    }));
  }

  private judgmentForWord(index: number, summary: KaraokeScoreSummary): KaraokeMediaFinalJudgment {
    const word = this.song.chart.words[index]!;
    const wordScore = Math.max(0, Math.min(1, summary.words[index]?.score ?? 0));
    const judgment: KaraokeJudgment = wordScore >= this.perfectThreshold
      ? 'perfect'
      : wordScore >= this.goodThreshold ? 'good' : 'miss';
    const maximumPoints = maximumWordPoints(index, this.song.chart.words.length);
    const points = judgment === 'miss' ? 0 : Math.min(maximumPoints, boundedScore(wordScore * maximumPoints));
    return Object.freeze({ wordId: word.id, judgment, points });
  }

  private emitLiveJudgment(index: number, summary: KaraokeScoreSummary): void {
    const word = this.song.chart.words[index]!;
    if (this.judgedWords.has(word.id)) return;
    // A provider final may arrive after the acoustic window matures. Until then
    // the HUD shows only settled points; the remaining words settle at the end.
    if (this.lyricRecognitionRequired && !summary.words[index]?.lyricEvidence?.final) return;
    this.judgedWords.add(word.id);
    const hit = this.judgmentForWord(index, summary);
    this.judgmentsEmitted += 1;
    try {
      if (this.scoreServer.recordWordJudgment(
        this.attempt.roomCode,
        this.attempt.playerId,
        hit.wordId,
        hit.judgment,
        hit.points,
      )) this.confirmedLiveJudgments.set(hit.wordId, hit);
      else this.judgmentsRejected += 1;
    } catch {
      this.judgmentsRejected += 1;
    }
  }

  private acceptLyricResult(result: KaraokeLyricRecognitionResult): void {
    if (this.scoreFrozen || this.aborted || this.lyricProviderFailed || result.source !== this.lyricRecognizer?.source) return;
    try {
      const evidence: RecognizedLyricWordEvidence[] = result.words.flatMap(word => {
        const songStartMs = word.mediaStartTimestampMs
          - this.songStartTimestampMs
          + this.attempt.calibrationOffsetMs;
        const songEndMs = word.mediaEndTimestampMs
          - this.songStartTimestampMs
          + this.attempt.calibrationOffsetMs;
        if (songEndMs < 0 || songStartMs > this.song.durationMs) return [];
        return [{
          text: word.text,
          songStartMs: Math.max(0, songStartMs),
          songEndMs: Math.min(this.song.durationMs, Math.max(0, songEndMs)),
          sourceStartMs: word.sourceStartMs,
          sourceEndMs: word.sourceEndMs,
          confidence: word.confidence,
          source: result.source,
        }];
      });
      if (this.scorer.replaceLyricResult(result.resultId, evidence, result.final)
        && result.final && !this.finalizationPromise) this.judgeThrough(this.latestSongTimestampMs);
    } catch {
      this.markLyricProviderFailed();
    }
  }

  private markLyricProviderFailed(): void {
    if (this.lyricProviderFailed) return;
    this.lyricProviderFailed = true;
    this.lyricRecognizer?.close();
  }

  private async finalizeLyricRecognizer(): Promise<void> {
    if (!this.lyricRecognizer || this.lyricProviderFailed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        this.lyricRecognizer.finalize().then(() => 'completed' as const, () => 'failed' as const),
        new Promise<'timeout'>(resolve => {
          timer = this.scheduleTimeout(() => resolve('timeout'), this.lyricFinalizationTimeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (outcome === 'timeout') {
        this.lyricFinalizationTimedOut = true;
        this.markLyricProviderFailed();
      } else if (outcome === 'failed') {
        this.markLyricProviderFailed();
      }
    } finally {
      if (timer) this.cancelTimeout(timer);
      if (!this.lyricProviderFailed) this.lyricRecognizer.close();
    }
  }
}

export interface KaraokeMediaSocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export type KaraokeMediaUpgrade = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  accepted: (socket: KaraokeMediaSocket) => void,
) => void;

export interface KaraokeMediaRuntimeOptions {
  readonly karaokeServer: KaraokeMediaScoreServer;
  readonly songs?: readonly KaraokeSong[];
  readonly now?: () => number;
  readonly tokenTtlMs?: number;
  readonly maxPendingAttempts?: number;
  readonly maxActiveSessions?: number;
  readonly maxRememberedAttempts?: number;
  readonly maxMessageBytes?: number;
  readonly maxSessionMediaBytes?: number;
  readonly maxSessionDurationMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly authenticationTimeoutMs?: number;
  readonly cleanStopGraceMs?: number;
  readonly finalizedRetentionMs?: number;
  readonly windowMs?: number;
  readonly analyzerOptions?: FrameAnalyzerOptions;
  readonly scoringOptions?: KaraokeScoringOptions;
  readonly lyricRecognizerFactory?: KaraokeLyricRecognizerFactory;
  readonly lyricJudgmentGraceMs?: number;
  readonly lyricFinalizationTimeoutMs?: number;
  readonly goodThreshold?: number;
  readonly perfectThreshold?: number;
  readonly path?: string;
  readonly isSecureRequest?: (request: IncomingMessage) => boolean;
  readonly validateUpgradeSignature?: (request: IncomingMessage) => boolean;
  readonly upgrade?: KaraokeMediaUpgrade;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly onSessionStarted?: (attempt: KaraokeMediaAttempt, streamSid: string) => void;
  readonly onSessionFinalized?: (result: KaraokeMediaFinalResult, attempt: KaraokeMediaAttempt) => void;
  readonly onSessionAborted?: (attempt: KaraokeMediaAttempt) => void;
}

interface CompletedResult {
  readonly result: KaraokeMediaFinalResult;
  readonly forgetAtMs: number;
}

interface ActiveSession {
  readonly session: KaraokeMediaSession;
  timeout: ReturnType<typeof setTimeout>;
  readonly connection: KaraokeMediaConnection | null;
}

/** Isolated manager suitable for mounting from http-server through an upgrade adapter. */
export class KaraokeMediaRuntime {
  private readonly scoreServer: KaraokeMediaScoreServer;
  private readonly songs: Map<string, KaraokeSong>;
  private readonly now: () => number;
  private readonly registry: KaraokeMediaAttemptRegistry;
  private readonly maxActiveSessions: number;
  private readonly maxRememberedAttempts: number;
  private readonly maxMessageBytes: number;
  private readonly maxSessionMediaBytes: number;
  private readonly maxSessionDurationMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly authenticationTimeoutMs: number;
  private readonly cleanStopGraceMs: number;
  private readonly finalizedRetentionMs: number;
  private readonly windowMs: number;
  private readonly analyzerOptions: FrameAnalyzerOptions;
  private readonly scoringOptions: KaraokeScoringOptions;
  private readonly goodThreshold: number;
  private readonly perfectThreshold: number;
  private readonly lateToleranceMs: number;
  private readonly lyricRecognizerFactory?: KaraokeLyricRecognizerFactory;
  private readonly lyricJudgmentGraceMs: number;
  private readonly lyricFinalizationTimeoutMs: number;
  private readonly path: string;
  private readonly isSecureRequest: (request: IncomingMessage) => boolean;
  private readonly validateUpgradeSignature: (request: IncomingMessage) => boolean;
  private readonly upgrade?: KaraokeMediaUpgrade;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;
  private readonly onSessionStarted?: (attempt: KaraokeMediaAttempt, streamSid: string) => void;
  private readonly onSessionFinalized?: (result: KaraokeMediaFinalResult, attempt: KaraokeMediaAttempt) => void;
  private readonly onSessionAborted?: (attempt: KaraokeMediaAttempt) => void;
  private readonly active = new Map<string, ActiveSession>();
  private readonly completed = new Map<string, CompletedResult>();
  private readonly connections = new Set<KaraokeMediaConnection>();
  private closed = false;

  constructor(options: KaraokeMediaRuntimeOptions) {
    this.scoreServer = options.karaokeServer;
    this.now = options.now ?? Date.now;
    this.maxActiveSessions = positiveInteger(
      options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS,
      'maxActiveSessions',
    );
    this.maxRememberedAttempts = positiveInteger(
      options.maxRememberedAttempts ?? DEFAULT_MAX_REMEMBERED_ATTEMPTS,
      'maxRememberedAttempts',
    );
    this.maxMessageBytes = positiveInteger(options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES, 'maxMessageBytes');
    this.maxSessionMediaBytes = positiveInteger(
      options.maxSessionMediaBytes ?? DEFAULT_MAX_SESSION_MEDIA_BYTES,
      'maxSessionMediaBytes',
    );
    this.maxSessionDurationMs = positiveInteger(
      options.maxSessionDurationMs ?? DEFAULT_MAX_SESSION_DURATION_MS,
      'maxSessionDurationMs',
    );
    this.connectionTimeoutMs = positiveInteger(
      options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      'connectionTimeoutMs',
    );
    this.authenticationTimeoutMs = positiveInteger(
      options.authenticationTimeoutMs ?? DEFAULT_AUTHENTICATION_TIMEOUT_MS,
      'authenticationTimeoutMs',
    );
    this.cleanStopGraceMs = positiveInteger(
      options.cleanStopGraceMs ?? DEFAULT_CLEAN_STOP_GRACE_MS,
      'cleanStopGraceMs',
    );
    this.finalizedRetentionMs = positiveInteger(
      options.finalizedRetentionMs ?? DEFAULT_FINALIZED_RETENTION_MS,
      'finalizedRetentionMs',
    );
    this.windowMs = options.windowMs ?? 100;
    this.analyzerOptions = Object.freeze({ ...(options.analyzerOptions ?? {}) });
    this.scoringOptions = Object.freeze({ ...(options.scoringOptions ?? {}) });
    this.lateToleranceMs = this.scoringOptions.lateToleranceMs ?? DEFAULT_LATE_TOLERANCE_MS;
    if (!Number.isFinite(this.lateToleranceMs) || this.lateToleranceMs < 0) {
      throw new RangeError('lateToleranceMs must be a non-negative finite number');
    }
    this.lyricRecognizerFactory = options.lyricRecognizerFactory;
    this.lyricJudgmentGraceMs = nonNegativeFinite(
      options.lyricJudgmentGraceMs ?? DEFAULT_LYRIC_JUDGMENT_GRACE_MS,
      'lyricJudgmentGraceMs',
    );
    this.lyricFinalizationTimeoutMs = positiveInteger(
      options.lyricFinalizationTimeoutMs ?? KARAOKE_LYRIC_FINALIZATION_TIMEOUT_MS,
      'lyricFinalizationTimeoutMs',
    );
    this.goodThreshold = finiteThreshold(options.goodThreshold ?? 0.3, 'goodThreshold');
    this.perfectThreshold = finiteThreshold(options.perfectThreshold ?? 0.8, 'perfectThreshold');
    if (this.perfectThreshold <= this.goodThreshold) {
      throw new RangeError('perfectThreshold must be greater than goodThreshold');
    }
    this.path = options.path ?? '/karaoke-media';
    if (!/^\/[A-Za-z0-9/_-]*$/.test(this.path)) throw new TypeError('path must be an absolute path without a query');
    this.isSecureRequest = options.isSecureRequest ?? (request => (
      (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted === true
    ));
    this.validateUpgradeSignature = options.validateUpgradeSignature ?? (() => true);
    this.upgrade = options.upgrade;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.onSessionStarted = options.onSessionStarted;
    this.onSessionFinalized = options.onSessionFinalized;
    this.onSessionAborted = options.onSessionAborted;
    this.registry = new KaraokeMediaAttemptRegistry({
      now: this.now,
      defaultTtlMs: options.tokenTtlMs,
      maxPendingAttempts: options.maxPendingAttempts,
      maxRememberedAttempts: this.maxRememberedAttempts,
      replayRetentionMs: this.finalizedRetentionMs,
    });
    this.songs = new Map();
    this.setSongs(options.songs ?? KARAOKE_DEVELOPMENT_SONGS);
    // Validate the configured window immediately rather than on the first authenticated call.
    new KaraokeFrameWindow({ windowMs: this.windowMs }).close();
  }

  get activeSessionCount(): number { return this.active.size; }
  get connectionCount(): number { return this.connections.size; }

  setSongs(songs: readonly KaraokeSong[]): void {
    const next = new Map<string, KaraokeSong>();
    for (const song of songs) {
      if (next.has(song.id)) throw new TypeError(`duplicate karaoke song id: ${song.id}`);
      next.set(song.id, song);
    }
    if (!next.size) throw new TypeError('karaoke catalog must not be empty');
    this.songs.clear();
    for (const [songId, song] of next) this.songs.set(songId, song);
  }

  issueAttempt(request: KaraokeMediaAttemptRequest): IssuedKaraokeMediaAttempt {
    this.assertOpen();
    const normalized: KaraokeMediaAttemptRequest = {
      ...request,
      roomCode: canonicalRoomCode(request.roomCode),
    };
    const song = this.songs.get(normalized.songId);
    if (!song || !this.bindingIsCurrent(normalized, true)) {
      throw new KaraokeMediaError('STALE_ATTEMPT', 'karaoke room identity is not current');
    }
    const calibrationOffsetMs = normalized.calibrationOffsetMs ?? 0;
    if (normalized.songStartTimestampMs + song.durationMs - calibrationOffsetMs > this.maxSessionDurationMs) {
      throw new RangeError('song timing exceeds the session duration limit');
    }
    return this.registry.issue(normalized);
  }

  startSession(start: TwilioStartFrame, connection: KaraokeMediaConnection | null = null): KaraokeMediaSession {
    this.assertOpen();
    this.reapCompleted();
    if (this.active.size >= this.maxActiveSessions) {
      throw new KaraokeMediaError('SESSION_CAPACITY', 'too many active karaoke media sessions');
    }
    if (start.start.tracks.length !== 1 || start.start.tracks[0] !== 'inbound') {
      throw new KaraokeMediaError('IDENTITY_MISMATCH', 'karaoke media stream must contain inbound audio only');
    }
    const parameters = start.start.customParameters;
    const loadingGeneration = canonicalPositiveInteger(
      parameters[KARAOKE_MEDIA_CUSTOM_PARAMETERS.loadingGeneration],
    );
    const credentials: KaraokeMediaAttemptCredentials = {
      attemptId: parameters[KARAOKE_MEDIA_CUSTOM_PARAMETERS.attemptId] ?? '',
      token: parameters[KARAOKE_MEDIA_CUSTOM_PARAMETERS.token] ?? '',
      accountSid: start.start.accountSid,
      callSid: start.start.callSid,
      roomCode: parameters[KARAOKE_MEDIA_CUSTOM_PARAMETERS.roomCode] ?? '',
      playerId: parameters[KARAOKE_MEDIA_CUSTOM_PARAMETERS.playerId] ?? '',
      songId: parameters[KARAOKE_MEDIA_CUSTOM_PARAMETERS.songId] ?? '',
      loadingGeneration,
    };
    const attempt = this.registry.consume(credentials);
    let song: KaraokeSong;
    try {
      if (!this.bindingIsCurrent(attempt, true)) {
        throw new KaraokeMediaError('STALE_ATTEMPT', 'karaoke room identity changed before media start');
      }
      const selectedSong = this.scoreServer.findRoom(attempt.roomCode)?.state().selectedSong;
      if (!selectedSong || selectedSong.id !== attempt.songId) {
        throw new KaraokeMediaError('STALE_ATTEMPT', 'karaoke song is unavailable');
      }
      song = selectedSong;
      if (this.scoreServer.markMediaReady
        && !this.scoreServer.markMediaReady(
          attempt.roomCode,
          attempt.playerId,
          attempt.songId,
          attempt.loadingGeneration,
          attempt.songStartTimestampMs,
        )) throw new KaraokeMediaError('STALE_ATTEMPT', 'karaoke room is not ready for media');
    } catch (error) {
      this.onSessionAborted?.(attempt);
      throw error;
    }

    let session!: KaraokeMediaSession;
    session = new KaraokeMediaSession({
      attempt,
      song,
      scoreServer: this.scoreServer,
      now: this.now,
      windowMs: this.windowMs,
      analyzerOptions: this.analyzerOptions,
      scoringOptions: this.scoringOptions,
      goodThreshold: this.goodThreshold,
      perfectThreshold: this.perfectThreshold,
      lateToleranceMs: this.lateToleranceMs,
      lyricJudgmentGraceMs: this.lyricJudgmentGraceMs,
      lyricFinalizationTimeoutMs: this.lyricFinalizationTimeoutMs,
      lyricRecognizerFactory: this.lyricRecognizerFactory,
      maxMediaBytes: this.maxSessionMediaBytes,
      maxDurationMs: this.maxSessionDurationMs,
      identityIsCurrent: () => this.bindingIsCurrent(attempt, false),
      songStartTimestampMs: attempt.songStartTimestampMs,
      onCoverageComplete: () => this.beginCleanStopGrace(attempt.attemptId),
      onFinalized: result => {
        const active = this.active.get(attempt.attemptId);
        if (active) this.cancelTimeout(active.timeout);
        this.active.delete(attempt.attemptId);
        this.completed.set(attempt.attemptId, {
          result,
          forgetAtMs: this.now() + this.finalizedRetentionMs,
        });
        this.boundCompleted();
        this.onSessionFinalized?.(result, attempt);
      },
      onAborted: () => {
        const active = this.active.get(attempt.attemptId);
        if (active) this.cancelTimeout(active.timeout);
        this.active.delete(attempt.attemptId);
        this.onSessionAborted?.(attempt);
      },
      setTimeout: this.scheduleTimeout,
      clearTimeout: this.cancelTimeout,
    });
    const timeout = this.scheduleTimeout(() => { void this.expireSession(attempt.attemptId); }, this.connectionTimeoutMs);
    (timeout as { unref?: () => void }).unref?.();
    this.active.set(attempt.attemptId, { session, timeout, connection });
    this.onSessionStarted?.(attempt, start.streamSid);
    return session;
  }

  async finalizeAttempt(
    attemptId: string,
    reason: KaraokeMediaFinalizeReason = 'manual',
  ): Promise<KaraokeMediaFinalResult | null> {
    this.reapCompleted();
    const active = this.active.get(attemptId);
    if (active) {
      try { return await active.session.finalize(reason); }
      catch { return null; }
    }
    return this.completed.get(attemptId)?.result ?? null;
  }

  finalizedResult(attemptId: string): KaraokeMediaFinalResult | null {
    this.reapCompleted();
    return this.completed.get(attemptId)?.result ?? null;
  }

  attemptState(attemptId: string): 'pending' | 'finalizing' | 'finalized' | 'missing' {
    this.reapCompleted();
    if (this.completed.has(attemptId)) return 'finalized';
    const active = this.active.get(attemptId);
    if (!active) return 'missing';
    return active.session.isFinalizing ? 'finalizing' : 'pending';
  }

  abortAttempt(attemptId: string): boolean {
    if (this.registry.revoke(attemptId)) return true;
    const active = this.active.get(attemptId);
    if (!active) return false;
    const aborted = active.session.abort();
    active.connection?.finishFromRuntime(false, 'karaoke media aborted');
    return aborted;
  }

  inspectAttempt(attemptId: string): KaraokeMediaSessionInspection | null {
    return this.active.get(attemptId)?.session.inspect() ?? null;
  }

  validateUpgradeRequest(request: IncomingMessage): boolean {
    return request.url === this.path && !request.url.includes('?') && this.isSecureRequest(request)
      && this.validateUpgradeSignature(request);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    this.assertOpen();
    const pathValid = request.url === this.path && !request.url.includes('?');
    const secureRequest = this.isSecureRequest(request);
    const signatureValid = this.validateUpgradeSignature(request);
    const validRequest = pathValid && secureRequest && signatureValid;
    const capacityAvailable = this.connections.size < this.maxActiveSessions;
    if (!validRequest || !this.upgrade || !capacityAvailable) {
      console.warn(`[karaoke] media upgrade rejected pathValid=${pathValid} secureRequest=${secureRequest} signatureValid=${signatureValid} upgradeConfigured=${Boolean(this.upgrade)} capacityAvailable=${capacityAvailable}`);
      rejectUpgrade(socket);
      return false;
    }
    this.upgrade(request, socket, head, accepted => {
      try {
        this.acceptSocket(accepted);
      } catch (error) {
        console.warn(`[karaoke] media socket rejected ${karaokeMediaErrorDescription(error)}`);
        accepted.close(1013, 'karaoke media unavailable');
      }
    });
    return true;
  }

  acceptSocket(socket: KaraokeMediaSocket): KaraokeMediaConnection {
    this.assertOpen();
    if (this.connections.size >= this.maxActiveSessions) {
      socket.close(1013, 'karaoke media capacity');
      throw new KaraokeMediaError('SESSION_CAPACITY', 'too many karaoke media connections');
    }
    let connection!: KaraokeMediaConnection;
    connection = new KaraokeMediaConnection({
      socket,
      runtime: this,
      maxMessageBytes: this.maxMessageBytes,
      authenticationTimeoutMs: this.authenticationTimeoutMs,
      scheduleTimeout: this.scheduleTimeout,
      cancelTimeout: this.cancelTimeout,
      onClosed: () => { this.connections.delete(connection); },
    });
    this.connections.add(connection);
    return connection;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const connection of [...this.connections]) connection.abort('runtime closed');
    for (const active of [...this.active.values()]) active.session.abort();
    this.connections.clear();
    this.active.clear();
    this.completed.clear();
    this.registry.clear();
  }

  private bindingIsCurrent(binding: KaraokeMediaAttemptBinding, requireActivePhase: boolean): boolean {
    const state = this.scoreServer.findRoom(binding.roomCode)?.state();
    return state !== undefined
      && state.roomCode === binding.roomCode
      && state.singer?.playerId === binding.playerId
      && state.selectedSong?.id === binding.songId
      && state.loadingGeneration === binding.loadingGeneration
      && (!requireActivePhase || ACTIVE_ATTEMPT_PHASES.includes(state.phase));
  }

  private assertOpen(): void {
    if (this.closed) throw new KaraokeMediaError('RUNTIME_CLOSED', 'karaoke media runtime is closed');
  }

  private reapCompleted(): void {
    const now = this.now();
    for (const [attemptId, completed] of this.completed) {
      if (now >= completed.forgetAtMs) this.completed.delete(attemptId);
    }
  }

  private boundCompleted(): void {
    this.reapCompleted();
    while (this.completed.size > this.maxRememberedAttempts) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  private beginCleanStopGrace(attemptId: string): void {
    const active = this.active.get(attemptId);
    if (!active) return;
    this.cancelTimeout(active.timeout);
    active.timeout = this.scheduleTimeout(() => { void this.expireSession(attemptId); }, this.cleanStopGraceMs);
    (active.timeout as { unref?: () => void }).unref?.();
  }

  private async expireSession(attemptId: string): Promise<void> {
    const active = this.active.get(attemptId);
    if (!active) return;
    let completed = false;
    if (active.session.hasSongTimestampCoverage) {
      try {
        completed = (await active.session.finalize('session-timeout')).scoreAccepted;
      } catch {
        active.session.abort();
      }
    } else {
      active.session.abort();
    }
    active.connection?.finishFromRuntime(completed, completed ? 'karaoke media complete' : 'karaoke media timeout');
  }
}

interface KaraokeMediaConnectionOptions {
  readonly socket: KaraokeMediaSocket;
  readonly runtime: KaraokeMediaRuntime;
  readonly maxMessageBytes: number;
  readonly authenticationTimeoutMs: number;
  readonly scheduleTimeout: typeof setTimeout;
  readonly cancelTimeout: typeof clearTimeout;
  readonly onClosed: () => void;
}

/** Per-socket parser lifecycle; exposed so injected sockets can be tested without a network listener. */
export class KaraokeMediaConnection {
  private readonly socket: KaraokeMediaSocket;
  private readonly runtime: KaraokeMediaRuntime;
  private readonly parser = new TwilioMediaStreamParser();
  private readonly maxMessageBytes: number;
  private readonly cancelTimeout: typeof clearTimeout;
  private readonly onClosed: () => void;
  private readonly timeout: ReturnType<typeof setTimeout>;
  private session: KaraokeMediaSession | null = null;
  private closed = false;

  constructor(options: KaraokeMediaConnectionOptions) {
    this.socket = options.socket;
    this.runtime = options.runtime;
    this.maxMessageBytes = options.maxMessageBytes;
    this.cancelTimeout = options.cancelTimeout;
    this.onClosed = options.onClosed;
    this.timeout = options.scheduleTimeout(() => this.timeoutConnection(), options.authenticationTimeoutMs);
    (this.timeout as { unref?: () => void }).unref?.();
    this.socket.on('message', (data: unknown, isBinary?: boolean) => { void this.onMessage(data, isBinary === true); });
    this.socket.on('close', () => this.onSocketClose());
    this.socket.on('error', () => this.abort('socket error'));
  }

  async close(): Promise<KaraokeMediaFinalResult | null> {
    if (this.closed) return null;
    let result: KaraokeMediaFinalResult | null = null;
    try { result = this.session ? await this.session.finalize('manual') : null; }
    catch { this.session?.abort(); }
    this.finishSocket(result?.scoreAccepted ? 1000 : 1008,
      result?.scoreAccepted ? 'karaoke media complete' : 'karaoke media rejected');
    return result;
  }

  abort(reason = 'karaoke media rejected'): void {
    if (this.closed) return;
    this.session?.abort();
    this.finishSocket(1008, reason);
  }

  finishFromRuntime(completed: boolean, reason: string): void {
    this.finishSocket(completed ? 1000 : 1008, reason);
  }

  private async onMessage(data: unknown, isBinary: boolean): Promise<void> {
    if (this.closed) return;
    try {
      if (isBinary) throw new KaraokeMediaError('IDENTITY_MISMATCH', 'binary WebSocket messages are not supported');
      const input = boundedMessage(data, this.maxMessageBytes);
      const frame = this.parser.parse(input);
      switch (frame.event) {
        case 'connected':
          break;
        case 'start':
          this.session = this.runtime.startSession(frame, this);
          this.cancelTimeout(this.timeout);
          break;
        case 'media':
          if (!this.session) throw new KaraokeMediaError('INVALID_ATTEMPT', 'media arrived before authentication');
          this.session.acceptMedia(frame);
          break;
        case 'stop':
          if (!this.session) throw new KaraokeMediaError('INVALID_ATTEMPT', 'stop arrived before authentication');
          if (!(await this.session.finalize('stop')).scoreAccepted) {
            throw new KaraokeMediaError('STALE_ATTEMPT', 'karaoke media score was rejected');
          }
          this.finishSocket(1000, 'karaoke media complete');
          break;
      }
    } catch (error) {
      const oversized = error instanceof KaraokeMediaError && error.code === 'SESSION_LIMIT'
        && error.message === 'WebSocket message is too large';
      console.warn(`[karaoke] media frame rejected ${karaokeMediaErrorDescription(error)}`);
      this.session?.abort();
      this.finishSocket(oversized ? 1009 : 1008, oversized ? 'message too large' : 'karaoke media rejected');
    }
  }

  private onSocketClose(): void {
    if (this.closed) return;
    if (this.session) {
      if (this.session.hasSongTimestampCoverage) {
        void this.session.finalize('socket-close').catch(() => { this.session?.abort(); });
      } else this.session.abort();
    }
    this.finish(false);
  }

  private timeoutConnection(): void {
    if (this.closed) return;
    this.session?.abort();
    this.finishSocket(1008, 'karaoke media authentication timeout');
  }

  private finishSocket(code: number, reason: string): void {
    if (this.closed) return;
    this.finish(true, code, reason);
  }

  private finish(closeSocket: boolean, code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelTimeout(this.timeout);
    this.onClosed();
    if (closeSocket) {
      try {
        this.socket.close(code, reason);
      } catch {
        this.socket.terminate?.();
      }
    }
  }
}

function karaokeMediaErrorDescription(error: unknown): string {
  if (error instanceof KaraokeMediaError || error instanceof TwilioMediaStreamParseError) {
    return `code=${error.code} message=${error.message}`;
  }
  return `code=UNKNOWN message=${error instanceof Error ? error.message.slice(0, 160) : 'unknown error'}`;
}

function publicAttempt(attempt: StoredAttempt): KaraokeMediaAttempt {
  return Object.freeze({
    attemptId: attempt.attemptId,
    accountSid: attempt.accountSid,
    callSid: attempt.callSid,
    roomCode: attempt.roomCode,
    playerId: attempt.playerId,
    songId: attempt.songId,
    loadingGeneration: attempt.loadingGeneration,
    issuedAtMs: attempt.issuedAtMs,
    expiresAtMs: attempt.expiresAtMs,
    songStartTimestampMs: attempt.songStartTimestampMs,
    calibrationOffsetMs: attempt.calibrationOffsetMs,
  });
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function sameBinding(left: KaraokeMediaAttemptBinding, right: KaraokeMediaAttemptBinding): boolean {
  return left.accountSid === right.accountSid
    && left.callSid === right.callSid
    && left.roomCode === right.roomCode
    && left.playerId === right.playerId
    && left.songId === right.songId
    && left.loadingGeneration === right.loadingGeneration;
}

function validateBinding(binding: KaraokeMediaAttemptBinding): void {
  boundedIdentity(binding.accountSid, 'accountSid', 128);
  boundedIdentity(binding.callSid, 'callSid', 128);
  if (!/^[A-Z0-9-]{1,16}$/.test(binding.roomCode)) throw new TypeError('roomCode must be canonical');
  boundedIdentity(binding.playerId, 'playerId', 128);
  boundedIdentity(binding.songId, 'songId', 64);
  positiveInteger(binding.loadingGeneration, 'loadingGeneration');
}

function boundedIdentity(value: string, name: string, maximumLength: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength
    || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError(`${name} is invalid`);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

function canonicalPositiveInteger(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return -1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function finiteThreshold(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be from 0 to 1`);
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`);
  return value;
}

function canonicalRoomCode(value: string): string {
  return value.trim().toUpperCase();
}

export function midiToHz(midi: number): number {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw new RangeError('MIDI note must be an integer from 0 to 127');
  return 440 * 2 ** ((midi - 69) / 12);
}

function boundedScore(value: number): number {
  return Math.max(0, Math.min(KARAOKE_MAX_SCORE, Math.round(value)));
}

function maximumWordPoints(index: number, wordCount: number): number {
  const base = Math.floor(KARAOKE_MAX_SCORE / wordCount);
  return base + (index < KARAOKE_MAX_SCORE % wordCount ? 1 : 0);
}

function boundedMessage(data: unknown, maximumBytes: number): string | Uint8Array {
  if (typeof data === 'string') {
    if (Buffer.byteLength(data, 'utf8') > maximumBytes) {
      throw new KaraokeMediaError('SESSION_LIMIT', 'WebSocket message is too large');
    }
    return data;
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > maximumBytes) throw new KaraokeMediaError('SESSION_LIMIT', 'WebSocket message is too large');
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength > maximumBytes) throw new KaraokeMediaError('SESSION_LIMIT', 'WebSocket message is too large');
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data) && data.every(part => ArrayBuffer.isView(part))) {
    const views = data as ArrayBufferView[];
    const length = views.reduce((total, part) => total + part.byteLength, 0);
    if (length > maximumBytes) throw new KaraokeMediaError('SESSION_LIMIT', 'WebSocket message is too large');
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const part of views) {
      joined.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
      offset += part.byteLength;
    }
    return joined;
  }
  throw new TypeError('unsupported WebSocket message data');
}

function rejectUpgrade(socket: Duplex): void {
  if (socket.destroyed) return;
  socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}
