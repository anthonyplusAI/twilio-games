import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { KaraokeFrameWindow } from '../server/audio/karaoke-frame-window';
import type { TwilioMediaFrame, TwilioStartFrame } from '../server/audio/twilio-media-stream';
import {
  KaraokeMediaAttemptRegistry,
  KaraokeMediaError,
  KaraokeMediaRuntime,
  midiToHz,
  type KaraokeMediaAttemptRequest,
  type KaraokeMediaScoreServer,
  type KaraokeMediaSocket,
} from '../server/karaoke-media-runtime';
import type {
  KaraokeLyricRecognitionResult,
  KaraokeLyricRecognizerFactory,
  KaraokeLyricRecognizerSessionOptions,
  KaraokeRecognizerAudioFrame,
  KaraokeStreamingLyricRecognizer,
} from '../server/karaoke-lyric-recognizer';
import { parseKaraokeSong, type KaraokeSong } from '../shared/karaoke';
import type { KaraokeJudgment, KaraokeState } from '../shared/karaoke-protocol';

const SONG = parseKaraokeSong({
  id: 'runtime-test-song',
  title: 'Runtime Test',
  artist: 'Runtime Artist',
  locale: 'en-US',
  durationMs: 45_000,
  bpm: 100,
  singerCount: 1,
  provenance: 'original-development',
  chart: {
    laneCount: 4,
    words: [{ id: 'runtime-word-1', text: 'tone', startMs: 0, endMs: 400, targetMidi: 69, lane: 0 }],
  },
});

const BASE_REQUEST: KaraokeMediaAttemptRequest = {
  accountSid: 'AC-test-account',
  callSid: 'CA-test-call',
  roomCode: 'ROOM1',
  playerId: 'player-1',
  songId: SONG.id,
  loadingGeneration: 3,
  songStartTimestampMs: 0,
};

interface Hit {
  wordId: string;
  judgment: KaraokeJudgment;
  points: number;
}

class ScoreServer implements KaraokeMediaScoreServer {
  stateValue = stateFor(SONG);
  hits: Hit[] = [];
  scores: number[] = [];

  findRoom(code: string): { state(): KaraokeState } | undefined {
    return code === this.stateValue.roomCode ? { state: () => this.stateValue } : undefined;
  }

  recordWordJudgment(_code: string, _playerId: string, wordId: string,
    judgment: KaraokeJudgment, points: number): boolean {
    this.hits.push({ wordId, judgment, points });
    return true;
  }

  updateScore(_code: string, _playerId: string, score: number): boolean {
    this.scores.push(score);
    return true;
  }

  finalizeMediaScore(_code: string, _playerId: string, score: number, hits: readonly Hit[]): boolean {
    this.hits = [...hits];
    this.scores.push(score);
    return true;
  }
}

class FakeSocket extends EventEmitter implements KaraokeMediaSocket {
  closes: Array<{ code?: number; reason?: string }> = [];

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
}

class FakeLyricRecognizer implements KaraokeStreamingLyricRecognizer {
  readonly audioFrames: KaraokeRecognizerAudioFrame[] = [];
  readonly close = vi.fn();
  readonly finalize = vi.fn(() => this.finalization);
  private readonly finalization: Promise<void>;
  private resolveFinalization!: () => void;

  constructor(private readonly options: KaraokeLyricRecognizerSessionOptions, autoFinalize: boolean,
    readonly source = 'fake') {
    this.finalization = new Promise(resolve => { this.resolveFinalization = resolve; });
    if (autoFinalize) this.resolveFinalization();
  }

  acceptAudio(frame: KaraokeRecognizerAudioFrame): void {
    this.audioFrames.push({ ...frame, audio: Uint8Array.from(frame.audio) });
  }

  emit(result: Omit<KaraokeLyricRecognitionResult, 'source'>): void {
    this.options.onResult({ ...result, source: this.source });
  }

  finish(): void { this.resolveFinalization(); }
}

class FakeLyricRecognizerFactory implements KaraokeLyricRecognizerFactory {
  readonly sessions: FakeLyricRecognizer[] = [];

  constructor(private readonly autoFinalize = true, readonly source = 'fake') {}

  create(options: KaraokeLyricRecognizerSessionOptions): FakeLyricRecognizer {
    const recognizer = new FakeLyricRecognizer(options, this.autoFinalize, this.source);
    this.sessions.push(recognizer);
    return recognizer;
  }
}

function lyricResult(
  text: string,
  mediaStartTimestampMs: number,
  mediaEndTimestampMs: number,
  final = true,
): Omit<KaraokeLyricRecognitionResult, 'source'> {
  return {
    resultId: 'fake-segment-1',
    final,
    words: [{
      text,
      sourceStartMs: 125,
      sourceEndMs: 525,
      mediaStartTimestampMs,
      mediaEndTimestampMs,
      confidence: 1,
    }],
  };
}

function stateFor(song: KaraokeSong): KaraokeState {
  return {
    roomCode: BASE_REQUEST.roomCode,
    phase: 'performing',
    singer: { playerId: BASE_REQUEST.playerId, name: 'Ada', nameConfirmed: true },
    expectedPlayerCount: 1,
    hasExpectedPlayers: true,
    automaticSetup: true,
    preferredLocale: 'en-US',
    catalog: [song],
    selectedSong: song,
    selectedByPlayerId: BASE_REQUEST.playerId,
    selectionGeneration: 1,
    loadingGeneration: BASE_REQUEST.loadingGeneration,
    serverNowMs: 1_000,
    countdown: null,
    countdownEndsAtMs: null,
    performanceStartedAtMs: 1_000,
    performanceEndsAtMs: 46_000,
    score: 0,
    combo: 0,
    bestCombo: 0,
    result: null,
  };
}

function credentials(issue: ReturnType<KaraokeMediaAttemptRegistry['issue']>) {
  return {
    attemptId: issue.attemptId,
    token: issue.token,
    accountSid: issue.accountSid,
    callSid: issue.callSid,
    roomCode: issue.roomCode,
    playerId: issue.playerId,
    songId: issue.songId,
    loadingGeneration: issue.loadingGeneration,
  };
}

function startFrame(issue: ReturnType<KaraokeMediaRuntime['issueAttempt']>, overrides: {
  accountSid?: string;
  callSid?: string;
  parameters?: Record<string, string>;
} = {}): TwilioStartFrame {
  return {
    event: 'start',
    sequenceNumber: 1,
    streamSid: 'MZ-runtime',
    start: {
      accountSid: overrides.accountSid ?? issue.accountSid,
      callSid: overrides.callSid ?? issue.callSid,
      streamSid: 'MZ-runtime',
      tracks: ['inbound'],
      customParameters: { ...issue.customParameters, ...overrides.parameters },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8_000, channels: 1 },
    },
  };
}

function mediaFrame(payload: Uint8Array, timestampMs: number, chunk = timestampMs / 20 + 1): TwilioMediaFrame {
  return {
    event: 'media',
    sequenceNumber: chunk + 1,
    streamSid: 'MZ-runtime',
    media: { track: 'inbound', chunk, timestampMs, durationMs: payload.length / 8, payload },
  };
}

function encodeMuLaw(sampleInput: number): number {
  let sample = Math.max(-32_635, Math.min(32_635, Math.round(sampleInput)));
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent -= 1, mask >>= 1) {
    // Locate the mu-law magnitude segment.
  }
  return (~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f))) & 0xff;
}

function toneFrames(frequencyHz: number, durationMs = 400): TwilioMediaFrame[] {
  const frames: TwilioMediaFrame[] = [];
  for (let timestampMs = 0; timestampMs < durationMs; timestampMs += 20) {
    const payload = new Uint8Array(160);
    const startSample = timestampMs * 8;
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = encodeMuLaw(16_000 * Math.sin(2 * Math.PI * frequencyHz * (startSample + index) / 8_000));
    }
    frames.push(mediaFrame(payload, timestampMs));
  }
  return frames;
}

function coverSong(session: { acceptMedia(frame: TwilioMediaFrame): void }, currentTimestampMs: number,
  songStartTimestampMs = 0, calibrationOffsetMs = 0, frequencyHz?: number): void {
  const requiredEndTimestampMs = songStartTimestampMs + SONG.durationMs - calibrationOffsetMs;
  const payload = new Uint8Array((requiredEndTimestampMs - currentTimestampMs) * 8).fill(0xff);
  if (frequencyHz !== undefined) {
    const startSample = currentTimestampMs * 8;
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = encodeMuLaw(16_000 * Math.sin(2 * Math.PI * frequencyHz * (startSample + index) / 8_000));
    }
  }
  session.acceptMedia(mediaFrame(
    payload,
    currentTimestampMs,
  ));
}

function createRuntime(scoreServer = new ScoreServer(), options: Record<string, unknown> = {}) {
  return {
    scoreServer,
    runtime: new KaraokeMediaRuntime({ karaokeServer: scoreServer, songs: [SONG], ...options }),
  };
}

function expectMediaCode(action: () => unknown, code: KaraokeMediaError['code']): void {
  try {
    action();
    throw new Error('expected KaraokeMediaError');
  } catch (error) {
    expect(error).toBeInstanceOf(KaraokeMediaError);
    expect((error as KaraokeMediaError).code).toBe(code);
  }
}

describe('karaoke media attempt credentials', () => {
  it('uses one-use random tokens and rejects replay and expiry', () => {
    let now = 1_000;
    const registry = new KaraokeMediaAttemptRegistry({ now: () => now, defaultTtlMs: 50 });
    const first = registry.issue(BASE_REQUEST);
    const second = registry.issue(BASE_REQUEST);
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.token).not.toBe(second.token);
    expectMediaCode(() => registry.consume({ ...credentials(first), token: 'wrong-token' }), 'INVALID_TOKEN');
    expect(registry.consume(credentials(first)).attemptId).toBe(first.attemptId);
    expectMediaCode(() => registry.consume(credentials(first)), 'ATTEMPT_REPLAYED');

    now = 1_050;
    expectMediaCode(() => registry.consume(credentials(second)), 'ATTEMPT_EXPIRED');
  });

  it('rejects every mismatched bound identity without consuming the valid credential', () => {
    const fields: Array<keyof ReturnType<typeof credentials>> = [
      'accountSid', 'callSid', 'roomCode', 'playerId', 'songId', 'loadingGeneration',
    ];
    for (const field of fields) {
      const registry = new KaraokeMediaAttemptRegistry();
      const issued = registry.issue(BASE_REQUEST);
      const wrong = { ...credentials(issued), [field]: field === 'loadingGeneration' ? 4 : 'wrong' };
      expectMediaCode(() => registry.consume(wrong), 'IDENTITY_MISMATCH');
      expect(registry.consume(credentials(issued)).attemptId).toBe(issued.attemptId);
    }
  });
});

describe('KaraokeFrameWindow', () => {
  it('coalesces five contiguous 20ms frames into one timestamped 100ms window', () => {
    const accumulator = new KaraokeFrameWindow();
    const outputs = Array.from({ length: 5 }, (_, index) => (
      accumulator.push(mediaFrame(new Uint8Array(160).fill(0xff), index * 20))
    )).flat();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ mediaTimestampMs: 0, durationMs: 100 });
    expect(outputs[0]!.samples).toHaveLength(800);
    expect(accumulator.retainedSampleCount).toBe(0);
    outputs[0]!.samples.fill(0);
    expect(accumulator.close()).toBe(0);
  });
});

describe('KaraokeMediaSession scoring and cleanup', () => {
  it('keeps the missing lyric component at zero and finalizes only once', async () => {
    const { runtime, scoreServer } = createRuntime();
    const issued = runtime.issueAttempt(BASE_REQUEST);
    const session = runtime.startSession(startFrame(issued));
    for (const frame of toneFrames(midiToHz(69), 600)) session.acceptMedia(frame);
    coverSong(session, 600, 0, 0, midiToHz(69));
    expect(session.inspect()).toMatchObject({ retainedPcmSamples: 0, rawAudioRetained: false });

    const firstPromise = session.finalize();
    const secondPromise = session.finalize();
    expect(secondPromise).toBe(firstPromise);
    const first = await firstPromise;
    expect(first.score).toBe(70_000);
    expect(first.diagnostics).toMatchObject({
      retainedPcmSamples: 0,
      rawAudioRetained: false,
      lyricRecognitionAvailable: false,
      lyricProvider: null,
      lyricScore: 0,
    });
    expect(scoreServer.hits).toEqual([
      { wordId: 'runtime-word-1', judgment: 'good', points: expect.any(Number) },
    ]);
    expect(scoreServer.hits[0]!.points).toBeLessThanOrEqual(100_000);
    expect(scoreServer.scores).toEqual([first.score]);
    expect(first.judgments).toEqual(scoreServer.hits);
    expect(first.score).toBe(first.judgments.reduce((total, judgment) => total + judgment.points, 0));
    expect(await runtime.finalizeAttempt(issued.attemptId)).toBe(first);
    runtime.close();
  });

  it('maps stream timestamps through song start and emits each mature word only once', async () => {
    const { runtime, scoreServer } = createRuntime();
    const issued = runtime.issueAttempt({
      ...BASE_REQUEST,
      songStartTimestampMs: 200,
      calibrationOffsetMs: 100,
    });
    const session = runtime.startSession(startFrame(issued));
    for (const frame of toneFrames(440, 700)) session.acceptMedia(frame);
    coverSong(session, 700, 200, 100);
    expect(scoreServer.hits).toHaveLength(1);
    expect(scoreServer.hits[0]!.judgment).toBe('good');
    const result = await session.finalize();
    expect(scoreServer.hits).toHaveLength(1);
    expect(result.diagnostics.discardedLeadingWindows).toBe(1);
    runtime.close();
  });

  it('classifies a near pitch as good with bounded partial points', async () => {
    const { runtime, scoreServer } = createRuntime();
    const session = runtime.startSession(startFrame(runtime.issueAttempt(BASE_REQUEST)));
    for (const frame of toneFrames(midiToHz(70), 600)) session.acceptMedia(frame);
    coverSong(session, 600, 0, 0, midiToHz(70));
    const result = await session.finalize();
    expect(result.score).toBeGreaterThan(55_000);
    expect(result.score).toBeLessThan(65_000);
    expect(scoreServer.hits[0]).toMatchObject({ judgment: 'good' });
    expect(scoreServer.hits[0]!.points).toBeGreaterThan(0);
    expect(scoreServer.hits[0]!.points).toBeLessThan(100_000);
    runtime.close();
  });

  it('scores octave-equivalent singing fairly across vocal ranges', async () => {
    const { runtime, scoreServer } = createRuntime();
    const session = runtime.startSession(startFrame(runtime.issueAttempt(BASE_REQUEST)));
    for (const frame of toneFrames(880)) session.acceptMedia(frame);
    coverSong(session, 400);
    const result = await session.finalize();
    expect(result.score).toBeGreaterThan(68_000);
    expect(scoreServer.hits[0]).toMatchObject({ judgment: 'good' });
    runtime.close();
  });

  it('scores silence as zero', async () => {
    const { runtime, scoreServer } = createRuntime();
    const session = runtime.startSession(startFrame(runtime.issueAttempt(BASE_REQUEST)));
    for (let index = 0; index < 20; index += 1) {
      session.acceptMedia(mediaFrame(new Uint8Array(160).fill(0xff), index * 20));
    }
    coverSong(session, 400);
    const result = await session.finalize();
    expect(result.score).toBe(0);
    expect(scoreServer.hits).toHaveLength(1);
    expect(scoreServer.hits[0]).toMatchObject({ judgment: 'miss', points: 0 });
    runtime.close();
  });

  it('maps injected lyric evidence through the media origin and reaches the exact full score', async () => {
    const factory = new FakeLyricRecognizerFactory();
    const { runtime, scoreServer } = createRuntime(undefined, { lyricRecognizerFactory: factory });
    const issued = runtime.issueAttempt({ ...BASE_REQUEST, songStartTimestampMs: 200 });
    const session = runtime.startSession(startFrame(issued));
    for (const frame of toneFrames(440, 800)) session.acceptMedia(frame);
    expect(scoreServer.hits).toHaveLength(0);
    const recognizer = factory.sessions[0]!;
    recognizer.emit(lyricResult('tone!', 200, 600));
    coverSong(session, 800, 200, 0, 440);
    expect(scoreServer.hits).toEqual([
      { wordId: 'runtime-word-1', judgment: 'perfect', points: 100_000 },
    ]);
    const result = await session.finalize('stop');
    expect(result.score).toBe(scoreServer.hits.reduce((total, hit) => total + hit.points, 0));
    expect(result.score).toBe(100_000);
    expect(result.scoring.components).toEqual({ timing: 1, lyrics: 1, pitch: 1 });
    expect(result.diagnostics).toMatchObject({
      lyricRecognitionAvailable: true,
      lyricProvider: 'fake',
      lyricFinalizationTimedOut: false,
    });
    expect(result.scoring.words[0]?.lyricEvidence).toMatchObject({
      sourceStartMs: 125, sourceEndMs: 525, confidence: 1,
    });
    expect(scoreServer.hits[0]).toMatchObject({ judgment: 'perfect', points: 100_000 });
    expect(recognizer.audioFrames.length).toBeGreaterThan(0);
    expect(recognizer.audioFrames[0]?.audio).toEqual(toneFrames(440, 20)[0]?.media.payload);
    expect(JSON.stringify(result)).not.toContain('tone!');
    runtime.close();
  });

  it('accepts a delayed final lyric revision before the finalization timeout', async () => {
    vi.useFakeTimers();
    try {
      const factory = new FakeLyricRecognizerFactory(false, 'deepgram');
      const { runtime, scoreServer } = createRuntime(undefined, {
        lyricRecognizerFactory: factory,
        lyricFinalizationTimeoutMs: 1_500,
      });
      const issued = runtime.issueAttempt(BASE_REQUEST);
      const session = runtime.startSession(startFrame(issued));
      for (const frame of toneFrames(440, 600)) session.acceptMedia(frame);
      const recognizer = factory.sessions[0]!;
      recognizer.emit(lyricResult('wrong', 0, 400, false));
      coverSong(session, 600, 0, 0, 440);
      // An interim transcript may change after the song. It must not contribute
      // visible points that the final lyric result later rewrites.
      expect(scoreServer.hits).toEqual([]);
      const finalized = session.finalize('stop');
      expect(runtime.attemptState(issued.attemptId)).toBe('finalizing');
      setTimeout(() => {
        recognizer.emit(lyricResult('tone', 0, 400, true));
        recognizer.finish();
      }, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await finalized;
      expect(result.score).toBe(100_000);
      expect(result.judgments).toEqual([
        { wordId: 'runtime-word-1', judgment: 'perfect', points: 100_000 },
      ]);
      expect(scoreServer.hits).toEqual(result.judgments);
      expect(result.diagnostics.lyricFinalizationTimedOut).toBe(false);
      expect(recognizer.finalize).toHaveBeenCalledOnce();
      expect(recognizer.close).toHaveBeenCalledOnce();
      runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps already confirmed live points in the final score when later final segments overlap', async () => {
    const factory = new FakeLyricRecognizerFactory();
    const { runtime, scoreServer } = createRuntime(undefined, { lyricRecognizerFactory: factory });
    const session = runtime.startSession(startFrame(runtime.issueAttempt(BASE_REQUEST)));
    for (const frame of toneFrames(440, 600)) session.acceptMedia(frame);
    const recognizer = factory.sessions[0]!;
    const first = lyricResult('tone', 0, 400);
    recognizer.emit({
      ...first,
      words: first.words.map(word => ({ ...word, confidence: 0.8 })),
    });
    coverSong(session, 600, 0, 0, 440);
    const live = scoreServer.hits[0];
    expect(live).toMatchObject({ wordId: 'runtime-word-1', points: expect.any(Number) });
    expect(live!.points).toBeLessThan(100_000);
    recognizer.emit({ ...lyricResult('tone', 0, 400), resultId: 'later-final-segment' });
    const result = await session.finalize();
    expect(result.score).toBe(live!.points);
    expect(result.judgments).toEqual([live]);
    runtime.close();
  });

  it('reduces acoustic credit without making missing lyric evidence a hard gate', async () => {
    const factory = new FakeLyricRecognizerFactory(true, 'deepgram');
    const { runtime, scoreServer } = createRuntime(undefined, { lyricRecognizerFactory: factory });
    const session = runtime.startSession(startFrame(runtime.issueAttempt(BASE_REQUEST)));
    for (const frame of toneFrames(440, 600)) session.acceptMedia(frame);
    coverSong(session, 600, 0, 0, 440);
    const result = await session.finalize('stop');
    expect(result.score).toBe(49_000);
    expect(result.scoring.components).toEqual({ timing: 0.7, lyrics: 0, pitch: 0.7 });
    expect(result.judgments).toEqual([
      { wordId: 'runtime-word-1', judgment: 'good', points: 49_000 },
    ]);
    expect(scoreServer.hits).toEqual(result.judgments);
    runtime.close();
  });

  it('fails the score commit when a configured lyric provider cannot start', async () => {
    const lyricRecognizerFactory: KaraokeLyricRecognizerFactory = {
      source: 'broken',
      create: () => { throw new Error('provider unavailable'); },
    };
    const { runtime, scoreServer } = createRuntime(undefined, { lyricRecognizerFactory });
    const issued = runtime.issueAttempt(BASE_REQUEST);
    const session = runtime.startSession(startFrame(issued));
    coverSong(session, 0);
    const result = await session.finalize();
    expect(result.scoreAccepted).toBe(false);
    expect(result.diagnostics).toMatchObject({
      lyricRecognitionAvailable: false,
      lyricProvider: null,
    });
    expect(scoreServer.scores).toEqual([]);
  });

  it('freezes a safe score when provider finalization exceeds 1.5 seconds', async () => {
    vi.useFakeTimers();
    try {
      const factory = new FakeLyricRecognizerFactory(false);
      const { runtime } = createRuntime(undefined, {
        lyricRecognizerFactory: factory,
        lyricFinalizationTimeoutMs: 1_500,
      });
      const session = runtime.startSession(startFrame(runtime.issueAttempt(BASE_REQUEST)));
      for (const frame of toneFrames(440, 600)) session.acceptMedia(frame);
      coverSong(session, 600, 0, 0, 440);
      const finalized = session.finalize('stop');
      await vi.advanceTimersByTimeAsync(1_499);
      expect(factory.sessions[0]!.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await finalized;
      expect(result.score).toBe(49_000);
      expect(result.scoreAccepted).toBe(false);
      expect(result.diagnostics.lyricFinalizationTimedOut).toBe(true);
      expect(factory.sessions[0]!.close).toHaveBeenCalledOnce();
      runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects wrong native identity and stale room/song/generation state', () => {
    const { runtime, scoreServer } = createRuntime();
    const wrongCall = runtime.issueAttempt(BASE_REQUEST);
    expectMediaCode(() => runtime.startSession(startFrame(wrongCall, { callSid: 'CA-wrong' })), 'IDENTITY_MISMATCH');

    const stale = runtime.issueAttempt(BASE_REQUEST);
    scoreServer.stateValue = { ...scoreServer.stateValue, loadingGeneration: 4 };
    expectMediaCode(() => runtime.startSession(startFrame(stale)), 'STALE_ATTEMPT');
    runtime.close();
  });
});

describe('KaraokeMediaRuntime socket boundary', () => {
  it('rejects a clean stop that arrives before song timestamp coverage', async () => {
    const { runtime, scoreServer } = createRuntime();
    const issued = runtime.issueAttempt(BASE_REQUEST);
    const socket = new FakeSocket();
    runtime.acceptSocket(socket);
    socket.emit('message', JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }), false);
    socket.emit('message', JSON.stringify({
      event: 'start', sequenceNumber: '1', streamSid: 'MZ-runtime',
      start: {
        accountSid: issued.accountSid,
        callSid: issued.callSid,
        streamSid: 'MZ-runtime',
        tracks: ['inbound'],
        customParameters: issued.customParameters,
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8_000, channels: 1 },
      },
    }), false);
    const silence = Buffer.alloc(160, 0xff).toString('base64');
    socket.emit('message', JSON.stringify({
      event: 'media', sequenceNumber: '2', streamSid: 'MZ-runtime',
      media: { track: 'inbound', chunk: '1', timestamp: '0', payload: silence },
    }), false);
    socket.emit('message', JSON.stringify({
      event: 'stop', sequenceNumber: '3', streamSid: 'MZ-runtime',
      stop: { accountSid: issued.accountSid, callSid: issued.callSid },
    }), false);
    await vi.waitFor(() => expect(socket.closes.at(-1)).toMatchObject({ code: 1008 }));
    expect(scoreServer.scores).toHaveLength(0);
    expect(runtime.activeSessionCount).toBe(0);
    runtime.close();
  });

  it('terminates an externally aborted socket idempotently before later close and timeout work', () => {
    const { runtime } = createRuntime();
    const issued = runtime.issueAttempt(BASE_REQUEST);
    const socket = new FakeSocket();
    runtime.acceptSocket(socket);
    socket.emit('message', JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }), false);
    socket.emit('message', JSON.stringify({
      event: 'start', sequenceNumber: '1', streamSid: 'MZ-runtime',
      start: {
        accountSid: issued.accountSid, callSid: issued.callSid, streamSid: 'MZ-runtime', tracks: ['inbound'],
        customParameters: issued.customParameters,
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8_000, channels: 1 },
      },
    }), false);
    expect(runtime.abortAttempt(issued.attemptId)).toBe(true);
    expect(() => socket.emit('close')).not.toThrow();
    expect(runtime.abortAttempt(issued.attemptId)).toBe(false);
    expect(socket.closes).toHaveLength(1);
    runtime.close();
  });

  it('aborts an unclean socket close before coverage instead of completing a score', () => {
    const aborted = vi.fn();
    const { runtime, scoreServer } = createRuntime(undefined, { onSessionAborted: aborted });
    const issued = runtime.issueAttempt(BASE_REQUEST);
    const socket = new FakeSocket();
    runtime.acceptSocket(socket);
    socket.emit('message', JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }), false);
    socket.emit('message', JSON.stringify({
      event: 'start', sequenceNumber: '1', streamSid: 'MZ-runtime',
      start: {
        accountSid: issued.accountSid, callSid: issued.callSid, streamSid: 'MZ-runtime', tracks: ['inbound'],
        customParameters: issued.customParameters,
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8_000, channels: 1 },
      },
    }), false);
    expect(() => socket.emit('close')).not.toThrow();
    expect(aborted).toHaveBeenCalledOnce();
    expect(scoreServer.scores).toHaveLength(0);
    expect(runtime.activeSessionCount).toBe(0);
    runtime.close();
  });

  it('requires upgrade authentication and bounds unauthenticated sockets with a short timeout', () => {
    vi.useFakeTimers();
    try {
      const { runtime } = createRuntime(undefined, {
        authenticationTimeoutMs: 25,
        validateUpgradeSignature: (request: IncomingMessage) => request.headers['x-twilio-signature'] === 'valid',
      });
      const request = (signature?: string) => ({
        url: '/karaoke-media',
        headers: signature ? { 'x-twilio-signature': signature } : {},
        socket: { encrypted: true },
      }) as unknown as IncomingMessage;
      expect(runtime.validateUpgradeRequest(request())).toBe(false);
      expect(runtime.validateUpgradeRequest(request('valid'))).toBe(true);
      const socket = new FakeSocket();
      runtime.acceptSocket(socket);
      vi.advanceTimersByTime(25);
      expect(socket.closes.at(-1)).toMatchObject({ code: 1008, reason: 'karaoke media authentication timeout' });
      runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an authenticated stream timeout before coverage and tolerates its later close', () => {
    vi.useFakeTimers();
    try {
      const aborted = vi.fn();
      const { runtime, scoreServer } = createRuntime(undefined, {
        connectionTimeoutMs: 25,
        onSessionAborted: aborted,
      });
      const issued = runtime.issueAttempt(BASE_REQUEST);
      const socket = new FakeSocket();
      runtime.acceptSocket(socket);
      socket.emit('message', JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }), false);
      socket.emit('message', JSON.stringify({
        event: 'start', sequenceNumber: '1', streamSid: 'MZ-runtime',
        start: {
          accountSid: issued.accountSid, callSid: issued.callSid, streamSid: 'MZ-runtime', tracks: ['inbound'],
          customParameters: issued.customParameters,
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8_000, channels: 1 },
        },
      }), false);
      vi.advanceTimersByTime(25);
      expect(aborted).toHaveBeenCalledOnce();
      expect(scoreServer.scores).toHaveLength(0);
      expect(socket.closes.at(-1)).toMatchObject({ code: 1008, reason: 'karaoke media timeout' });
      expect(() => socket.emit('close')).not.toThrow();
      runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows only a short clean-stop grace after complete timestamp coverage', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, scoreServer } = createRuntime(undefined, {
        connectionTimeoutMs: 1_000,
        cleanStopGraceMs: 25,
      });
      const issued = runtime.issueAttempt(BASE_REQUEST);
      const session = runtime.startSession(startFrame(issued));
      coverSong(session, 0);
      await vi.advanceTimersByTimeAsync(24);
      expect(runtime.activeSessionCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.activeSessionCount).toBe(0);
      expect(scoreServer.scores).toHaveLength(1);
      expect(runtime.finalizedResult(issued.attemptId)?.reason).toBe('session-timeout');
      runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects query-bearing or insecure upgrades and oversized socket messages', () => {
    const { runtime } = createRuntime(undefined, { maxMessageBytes: 100 });
    const request = (url: string, encrypted: boolean) => ({
      url,
      socket: { encrypted },
    }) as unknown as IncomingMessage;
    expect(runtime.validateUpgradeRequest(request('/karaoke-media', true))).toBe(true);
    expect(runtime.validateUpgradeRequest(request('/karaoke-media?token=secret', true))).toBe(false);
    expect(runtime.validateUpgradeRequest(request('/karaoke-media', false))).toBe(false);

    const socket = new FakeSocket();
    runtime.acceptSocket(socket);
    socket.emit('message', 'x'.repeat(101), false);
    expect(socket.closes.at(-1)).toMatchObject({ code: 1009 });
    runtime.close();
  });

  it('caps synchronous media analysis at four active one-singer sessions by default', () => {
    const { runtime } = createRuntime();
    const sessions = Array.from({ length: 4 }, () => {
      const issued = runtime.issueAttempt(BASE_REQUEST);
      return { issued, session: runtime.startSession(startFrame(issued)) };
    });
    const overflow = runtime.issueAttempt(BASE_REQUEST);
    expectMediaCode(() => runtime.startSession(startFrame(overflow)), 'SESSION_CAPACITY');
    expect(runtime.activeSessionCount).toBe(4);
    for (const { issued } of sessions) expect(runtime.abortAttempt(issued.attemptId)).toBe(true);
    runtime.close();
  });
});
