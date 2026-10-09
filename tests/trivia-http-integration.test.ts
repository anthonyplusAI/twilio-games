import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import twilio from 'twilio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ArcadeApi } from '../server/arcade-api';
import type { AnalyticsObserver } from '../server/analytics-observer';
import {
  HttpServer,
  TRIVIA_IDENTIFICATION_TIMEOUT_MS,
  TRIVIA_PENDING_CONNECTION_LIMIT,
  TRIVIA_PUBLIC_DISPLAY_LIMIT,
  triviaLeaderboardResultId,
} from '../server/http-server';
import { TriviaRoom } from '../server/trivia-room';
import { TriviaServer } from '../server/trivia-server';
import { TriviaVoiceSession } from '../server/trivia-voice';
import type { LlmClient, LlmReply } from '../server/llm';
import { DEFAULT_ROOM } from '../shared/constants';
import {
  TRIVIA_ANSWER_WINDOW_MS,
  normalizeTriviaScore,
  parseTriviaQuestionBankJson,
  type TriviaQuestionBank,
} from '../shared/trivia';
import type { TriviaLeaderboardStore } from '../shared/trivia-leaderboard-store';
import type { TriviaResult } from '../shared/trivia-protocol';

const bundledBank = parseTriviaQuestionBankJson(
  readFileSync(new URL('../content/trivia/questions.json', import.meta.url), 'utf8'),
);
const DISPLAY_TOKEN = 'trivia-display-secret';
const VOICE_AUTH_TOKEN = 'trivia-voice-auth-token';
const VOICE_RELAY_TOKEN = 'trivia-relay-token';
const VOICE_PUBLIC_BASE_URL = 'https://games.example';

interface StationTriviaParticipant {
  readonly from: string;
  readonly callSid: string;
  readonly readyEntryId: string;
  readonly firstName: string;
  readonly participantIndex: number;
}

interface StationTriviaFixture {
  readonly roomCode: string;
  readonly matchId: string;
  readonly launchGeneration: number;
  readonly participants: readonly StationTriviaParticipant[];
}

let server: HttpServer | undefined;
let directory: string | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.stop();
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.restoreAllMocks();
});

async function harness(options: {
  stationRooms?: readonly string[];
  editorToken?: string;
  now?: { value: number };
  standaloneVoiceEnabled?: boolean;
  storageDirectory?: string;
  triviaIdentificationTimeoutMs?: number;
  publicBaseUrl?: string;
  authToken?: string;
  voiceRelayToken?: string;
  stationVoice?: StationTriviaFixture;
  manualTriviaClock?: boolean;
} = {}) {
  directory = options.storageDirectory ?? await mkdtemp(path.join(tmpdir(), 'trivia-http-'));
  const started = vi.fn();
  const completed = vi.fn();
  const abandoned = vi.fn();
  let participantReconcile: ((
    game: 'racer' | 'monsters' | 'fighter' | 'karaoke' | 'trivia',
    roomCode: string,
    count: number,
    activeEnginePlayerIds: readonly string[],
    participantSlots: readonly (string | null)[],
  ) => void) | undefined;
  const stationRooms = new Set([
    ...(options.stationRooms ?? []),
    ...(options.stationVoice ? [options.stationVoice.roomCode] : []),
  ].map(code => code.toUpperCase()));
  const stationClaims = new Map<string, string>();
  const stationVoiceRoute = vi.fn(async (from: string, callSid: string) => {
    const participant = options.stationVoice?.participants.find(candidate => (
      candidate.from === from
    ));
    const admitted = Boolean(participant && (!stationClaims.has(from) || stationClaims.get(from) === callSid));
    if (participant && admitted) stationClaims.set(from, callSid);
    return participant && options.stationVoice ? {
      game: 'trivia' as const,
      roomCode: options.stationVoice.roomCode,
      matchId: options.stationVoice.matchId,
      launchGeneration: options.stationVoice.launchGeneration,
      admitted,
      readyEntryId: participant.readyEntryId,
      participantIndex: participant.participantIndex,
      participantCount: options.stationVoice.participants.length,
    } : null;
  });
  const resolveStationVoiceSetup = vi.fn(async (input: {
    callSid: string; readyEntryId: string; matchId: string; launchGeneration: number;
    game: string; roomCode: string;
  }) => {
    const fixture = options.stationVoice;
    const participant = fixture?.participants.find(candidate => (
      candidate.readyEntryId === input.readyEntryId && stationClaims.get(candidate.from) === input.callSid
    ));
    if (!fixture || !participant || input.matchId !== fixture.matchId
      || input.launchGeneration !== fixture.launchGeneration || input.game !== 'trivia'
      || input.roomCode !== fixture.roomCode) return null;
    return {
      firstName: participant.firstName,
      terminal: false,
      participantIndex: participant.participantIndex,
      participantCount: fixture.participants.length,
    };
  });
  const stationVoiceParticipantConnected = vi.fn();
  const stationVoiceParticipantDisconnected = vi.fn();
  const stationVoiceSetupActivity = vi.fn();
  const stationVoiceCallEnded = vi.fn((callSid: string) => {
    for (const [from, claimedCallSid] of stationClaims) {
      if (claimedCallSid === callSid) stationClaims.delete(from);
    }
  });
  const arcadeApi = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    activateMessagingDelivery: vi.fn(async () => undefined),
    isStationEngineRoom: vi.fn((code: string) => stationRooms.has(code.trim().toUpperCase())),
    requiresStationVoiceAssignment: vi.fn(() => stationRooms.size > 0),
    getHealthStatus: vi.fn(() => ({ degraded: false })),
    authorizeOperatorRequest: vi.fn(() => ({ email: 'operator@test.invalid' })),
    voiceLocaleForNumber: vi.fn(() => null),
    standaloneVoiceAvailable: vi.fn(() => true),
    standaloneGameEnabled: vi.fn(() => true),
    stationVoiceRoute,
    resolveStationVoiceSetup,
    stationVoiceParticipantConnected,
    stationVoiceParticipantDisconnected,
    stationVoiceSetupActivity,
    stationEngineStarted: started,
    stationEngineCompleted: completed,
    stationEngineAbandoned: abandoned,
    stationVoiceCallEnded,
    setStationParticipantCountHandler: vi.fn((handler: NonNullable<typeof participantReconcile>) => {
      participantReconcile = handler;
    }),
  } as unknown as ArcadeApi;
  const now = options.now;
  type ManualInterval = { readonly id: number; unref(): ManualInterval };
  const manualIntervals = new Map<ManualInterval, { callback: () => void; delay: number }>();
  let nextIntervalId = 1;
  const manualSetInterval = ((callback: () => void, delay?: number) => {
    const interval: ManualInterval = {
      id: nextIntervalId++,
      unref() { return interval; },
    };
    manualIntervals.set(interval, { callback, delay: Number(delay ?? 0) });
    return interval;
  }) as unknown as typeof setInterval;
  const manualClearInterval = ((interval: ManualInterval) => {
    manualIntervals.delete(interval);
  }) as unknown as typeof clearInterval;
  const publicBaseUrl = options.publicBaseUrl ?? 'http://localhost';
  server = new HttpServer({
    port: 0,
    publicBaseUrl,
    authToken: options.authToken,
    voiceRelayToken: options.voiceRelayToken,
    validateSignatures: Boolean(options.authToken),
    standaloneVoiceEnabled: options.standaloneVoiceEnabled ?? true,
    arcadeApi,
    editorToken: options.editorToken,
    triviaDisplayToken: DISPLAY_TOKEN,
    triviaIdentificationTimeoutMs: options.triviaIdentificationTimeoutMs,
    triviaQuestionsPath: path.join(directory, 'trivia-questions.json'),
    bundledTriviaQuestionsPath: path.join(process.cwd(), 'content/trivia/questions.json'),
    triviaLeaderboardPath: path.join(directory, 'trivia-leaderboard.json'),
    analyticsPath: path.join(directory, 'analytics.json'),
    manifestPath: path.join(directory, 'manifest.json'),
    mapsPath: path.join(directory, 'maps.json'),
    arenaPath: path.join(directory, 'arena.json'),
    karaokeVenuePath: path.join(directory, 'karaoke-venue.json'),
    karaokeTimingsPath: path.join(directory, 'karaoke-timings.json'),
    karaokeLeaderboardPath: path.join(directory, 'karaoke-leaderboard.json'),
    leaderboardPath: path.join(directory, 'leaderboard.json'),
    fighterMapsPath: path.join(directory, 'fighter-maps.json'),
    fighterPreviewDir: path.join(directory, 'fighter-previews'),
    clientDir: path.join(directory, 'client'),
    triviaServerOptions: now ? {
      now: () => now.value,
      tickMs: 5,
      ...(options.manualTriviaClock ? {
        setInterval: manualSetInterval,
        clearInterval: manualClearInterval,
      } : {}),
      roomFactory: (code, roomOptions) => new TriviaRoom(code, {
        ...roomOptions,
        countdownMs: 15,
        revealMs: 5,
        questionPromptTimeoutMs: 50,
      }),
    } : undefined,
  });
  const port = await server.start();
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    trivia: (server as unknown as { trivia: TriviaServer }).trivia,
    started,
    completed,
    abandoned,
    stationVoiceRoute,
    resolveStationVoiceSetup,
    stationVoiceParticipantConnected,
    stationVoiceParticipantDisconnected,
    stationVoiceSetupActivity,
    stationVoiceCallEnded,
    tickTrivia() {
      for (const { callback, delay } of [...manualIntervals.values()]) {
        if (delay === 5) callback();
      }
    },
    get participantReconcile() { return participantReconcile; },
  };
}

async function connect(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ ws: WebSocket; messages: Record<string, any>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, {
    headers: { Origin: 'http://localhost', ...headers },
  });
  sockets.push(ws);
  const messages: Record<string, any>[] = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString()) as Record<string, any>));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, messages };
}

async function rejectedUpgrade(port: number, pathname: string, origin = 'http://localhost'): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers: { Origin: origin } });
  return new Promise<number>((resolve, reject) => {
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    ws.once('error', reject);
  });
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for Trivia integration state');
}

async function waitForAsync<T>(read: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for asynchronous Trivia integration state');
}

describe('Voice Trivia central runtime', () => {
  it('admits only explicit same-origin canonical public displays and never creates tokenless arbitrary rooms', async () => {
    const runtime = await harness();
    await expect(rejectedUpgrade(runtime.port, '/trivia')).resolves.toBe(403);
    await expect(rejectedUpgrade(runtime.port, '/trivia?display=1', 'https://attacker.example')).resolves.toBe(403);

    const arbitrary = await connect(runtime.port, '/trivia?display=1');
    arbitrary.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'PRIVATE-ROOM' }));
    await waitFor(() => arbitrary.messages.find(message => message.code === 'bad_display_auth'));
    arbitrary.ws.send(JSON.stringify({ type: 'join', roomCode: 'PRIVATE-ROOM', name: 'Browser' }));
    await waitFor(() => arbitrary.messages.find(message => message.code === 'station_voice_only'));
    expect(runtime.trivia.findRoom('PRIVATE-ROOM')).toBeUndefined();
    expect(runtime.trivia.roomCount).toBe(0);

    const display = await connect(runtime.port, '/trivia?display=1');
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: DEFAULT_ROOM }));
    await waitFor(() => display.messages.find(message => message.type === 'trivia_state'));
    expect(runtime.trivia.roomCount).toBe(1);
    display.ws.send(JSON.stringify({
      type: 'join', roomCode: DEFAULT_ROOM, name: 'Local Player', sessionId: 'http-local-player',
    }));
    await waitFor(() => display.messages.find(message => message.type === 'joined'));
    expect(runtime.trivia.findRoom(DEFAULT_ROOM)?.state().players).toEqual([
      expect.objectContaining({ name: 'Local Player' }),
    ]);
    display.ws.send(JSON.stringify({ type: 'answer', choiceId: 'anything' }));
    await waitFor(() => display.messages.find(message => message.code === 'unknown_type'));
  });

  it('caps all unidentified Trivia upgrades at eight before room registration', async () => {
    const runtime = await harness();
    expect(TRIVIA_IDENTIFICATION_TIMEOUT_MS).toBe(5_000);
    const idle = await Promise.all(Array.from(
      { length: TRIVIA_PENDING_CONNECTION_LIMIT },
      () => connect(runtime.port, '/trivia?display=1'),
    ));
    expect(idle.every(connection => connection.ws.readyState === WebSocket.OPEN)).toBe(true);
    expect(runtime.trivia.roomCount).toBe(0);
    await expect(rejectedUpgrade(runtime.port, '/trivia?display=1')).resolves.toBe(503);
    expect(runtime.trivia.connectionCount).toBe(TRIVIA_PENDING_CONNECTION_LIMIT);
  });

  it('terminates unidentified and failed-auth sockets after the timeout and accepts replacements', async () => {
    const runtime = await harness({ triviaIdentificationTimeoutMs: 300 });
    const idle = await connect(runtime.port, '/trivia?display=1');
    const failed = await connect(runtime.port, '/trivia?display=1');
    const idleClosed = new Promise<number>(resolve => idle.ws.once('close', code => resolve(code)));
    const failedClosed = new Promise<number>(resolve => failed.ws.once('close', code => resolve(code)));
    failed.ws.send(JSON.stringify({ type: 'display_auth', roomCode: 'STATION', token: 'wrong-token' }));
    await waitFor(() => failed.messages.find(message => message.code === 'bad_display_auth'));
    await expect(Promise.all([idleClosed, failedClosed])).resolves.toEqual([1006, 1006]);
    await waitFor(() => runtime.trivia.connectionCount === 0 ? true : undefined);

    const replacement = await connect(runtime.port, '/trivia?display=1');
    replacement.ws.send(JSON.stringify({ type: 'spectate', roomCode: DEFAULT_ROOM }));
    await waitFor(() => replacement.messages.find(message => message.type === 'trivia_state'));
    expect(replacement.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('recognizes a resumed local display-player session before the identification timeout', async () => {
    const runtime = await harness({ triviaIdentificationTimeoutMs: 100 });
    const first = await connect(runtime.port, '/trivia?display=1');
    first.ws.send(JSON.stringify({ type: 'spectate', roomCode: DEFAULT_ROOM }));
    await waitFor(() => first.messages.find(message => message.type === 'host_identity' && message.isHost));
    first.ws.send(JSON.stringify({
      type: 'join', roomCode: DEFAULT_ROOM, name: 'Local Player', sessionId: 'http-resume-local',
    }));
    const firstJoined = await waitFor(() => first.messages.find(message => message.type === 'joined'));
    const closed = new Promise<void>(resolve => first.ws.once('close', () => resolve()));
    first.ws.close();
    await closed;

    const resumed = await connect(runtime.port, '/trivia?display=1');
    resumed.ws.send(JSON.stringify({
      type: 'join', roomCode: DEFAULT_ROOM, name: 'ignored', sessionId: 'http-resume-local',
    }));
    const resumedJoined = await waitFor(() => resumed.messages.find(message => message.type === 'joined'));
    expect(resumedJoined.playerId).toBe(firstJoined.playerId);
    await waitFor(() => resumed.messages.find(message => message.type === 'host_identity' && message.isHost));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(resumed.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('releases pending quota without classifying active-event Trivia displays as standalone', async () => {
    const runtime = await harness({ stationRooms: ['STATION'], triviaIdentificationTimeoutMs: 300 });
    const internal = server as unknown as {
      pendingTriviaDisplays: Map<WebSocket, ReturnType<typeof setTimeout>>;
      publicTriviaDisplays: Set<WebSocket>;
    };
    const station = await connect(runtime.port, '/trivia?display=1');
    expect(internal.pendingTriviaDisplays.size).toBe(1);
    station.ws.send(JSON.stringify({ type: 'display_auth', roomCode: 'STATION', token: DISPLAY_TOKEN }));
    await waitFor(() => internal.pendingTriviaDisplays.size === 0 ? true : undefined);
    station.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'STATION' }));
    await waitFor(() => station.messages.find(message => message.type === 'trivia_state'));
    expect(internal.publicTriviaDisplays.size).toBe(0);

    const standalone = await connect(runtime.port, '/trivia?display=1');
    expect(internal.pendingTriviaDisplays.size).toBe(1);
    standalone.ws.send(JSON.stringify({ type: 'spectate', roomCode: DEFAULT_ROOM }));
    await waitFor(() => internal.pendingTriviaDisplays.size === 0 ? true : undefined);
    expect(internal.publicTriviaDisplays.size).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(station.ws.readyState).toBe(WebSocket.OPEN);
    expect(standalone.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('clears pending identification timers during server stop', async () => {
    const runtime = await harness();
    const internal = server as unknown as {
      pendingTriviaDisplays: Map<WebSocket, ReturnType<typeof setTimeout>>;
    };
    const idle = await connect(runtime.port, '/trivia?display=1');
    expect(internal.pendingTriviaDisplays.size).toBe(1);
    await server!.stop();
    server = undefined;
    expect(internal.pendingTriviaDisplays.size).toBe(0);
    await waitFor(() => idle.ws.readyState === WebSocket.CLOSED ? true : undefined);
  });

  it('rejects the ninth tokenless canonical upgrade without terminating the first eight', async () => {
    const runtime = await harness();
    const displays = await Promise.all(Array.from(
      { length: TRIVIA_PUBLIC_DISPLAY_LIMIT },
      () => connect(runtime.port, '/trivia?display=1'),
    ));
    for (const display of displays) {
      display.ws.send(JSON.stringify({ type: 'spectate', roomCode: DEFAULT_ROOM }));
    }
    await waitFor(() => displays.every(display => (
      display.messages.some(message => message.type === 'trivia_state')
    )) ? true : undefined);

    await expect(rejectedUpgrade(runtime.port, '/trivia?display=1')).resolves.toBe(503);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(displays.every(display => display.ws.readyState === WebSocket.OPEN)).toBe(true);
    await waitFor(() => runtime.trivia.connectionCount === TRIVIA_PUBLIC_DISPLAY_LIMIT ? true : undefined);
    expect(runtime.trivia.roomCount).toBe(1);
  });

  it('does not count or block authenticated station displays when the public quota is full', async () => {
    const runtime = await harness({ stationRooms: ['STATION-ONE', 'STATION-TWO'] });
    const authenticate = async (roomCode: string) => {
      const display = await connect(runtime.port, '/trivia?display=1');
      display.ws.send(JSON.stringify({ type: 'display_auth', roomCode, token: DISPLAY_TOKEN }));
      display.ws.send(JSON.stringify({ type: 'spectate', roomCode }));
      await waitFor(() => display.messages.find(message => (
        message.type === 'trivia_state' && message.roomCode === roomCode
      )));
      return display;
    };
    const firstStation = await authenticate('STATION-ONE');
    const publicDisplays = await Promise.all(Array.from(
      { length: TRIVIA_PUBLIC_DISPLAY_LIMIT },
      () => connect(runtime.port, '/trivia?display=1'),
    ));
    for (const display of publicDisplays) {
      display.ws.send(JSON.stringify({ type: 'spectate', roomCode: DEFAULT_ROOM }));
    }
    await waitFor(() => publicDisplays.every(display => (
      display.messages.some(message => message.type === 'trivia_state' && message.roomCode === DEFAULT_ROOM)
    )) ? true : undefined);

    const secondStation = await authenticate('STATION-TWO');
    expect(firstStation.ws.readyState).toBe(WebSocket.OPEN);
    expect(secondStation.ws.readyState).toBe(WebSocket.OPEN);
    expect(publicDisplays.every(display => display.ws.readyState === WebSocket.OPEN)).toBe(true);
    expect(runtime.trivia.connectionCount).toBe(TRIVIA_PUBLIC_DISPLAY_LIMIT + 2);
  });

  it('authenticates a station display, rejects every browser player/answer, and starts one caller once', async () => {
    const now = { value: 0 };
    const roomCode = DEFAULT_ROOM;
    const runtime = await harness({ stationRooms: [roomCode], now });
    const rejected = new WebSocket(`ws://127.0.0.1:${runtime.port}/trivia`, {
      headers: { Origin: 'https://attacker.example' },
    });
    await expect(new Promise<number>((resolve, reject) => {
      rejected.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      rejected.once('error', reject);
    })).resolves.toBe(403);
    const display = await connect(runtime.port, '/trivia?display=1');
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode }));
    await waitFor(() => display.messages.find(message => message.code === 'bad_display_auth'));
    display.ws.send(JSON.stringify({ type: 'join', roomCode, name: 'Browser' }));
    await waitFor(() => display.messages.find(message => message.code === 'station_voice_only'));
    display.ws.send(JSON.stringify({ type: 'display_auth', roomCode, token: DISPLAY_TOKEN }));
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode }));
    await waitFor(() => display.messages.find(message => message.type === 'host_identity' && message.isHost));

    const playerId = runtime.trivia.voiceJoin(roomCode, 'Ada', 1, true)!;
    runtime.trivia.voiceAdvance(roomCode, playerId);
    runtime.trivia.voiceVoteCategory(roomCode, playerId, 'science');
    runtime.trivia.voiceAdvance(roomCode, playerId);
    const generation = runtime.trivia.findRoom(roomCode)!.state().loadingGeneration;
    runtime.trivia.voiceSetConnected(roomCode, playerId, false);
    display.ws.send(JSON.stringify({ type: 'ready', loadingGeneration: generation }));
    await waitFor(() => display.messages.find(message => message.code === 'not_ready'));
    expect(runtime.started).not.toHaveBeenCalled();
    runtime.trivia.voiceSetConnected(roomCode, playerId, true);
    display.ws.send(JSON.stringify({ type: 'ready', loadingGeneration: generation }));
    await waitFor(() => runtime.trivia.findRoom(roomCode)?.phase === 'countdown' ? true : undefined);
    display.ws.send(JSON.stringify({ type: 'answer', choiceId: 'anything' }));
    await waitFor(() => display.messages.find(message => message.code === 'unknown_type'));
    display.ws.send(JSON.stringify({ type: 'keyboard_answer', choiceId: 'a' }));
    await waitFor(() => display.messages.find(message => message.code === 'forbidden'));

    expect(runtime.started).toHaveBeenCalledTimes(1);
    expect(runtime.started).toHaveBeenCalledWith('trivia', roomCode);
    expect(runtime.trivia.findRoom(roomCode)?.state().players).toHaveLength(1);
    runtime.trivia.voiceSetConnected(roomCode, playerId, false);
    expect(runtime.abandoned).not.toHaveBeenCalled();
    runtime.trivia.voiceSetConnected(roomCode, playerId, true);
  });

  it('completes four callers once and persists one redacted four-row round idempotently', async () => {
    const stateWaitMs = 8_000;
    const now = { value: 1_000 };
    const roomCode = 'TRIVIA-FOUR';
    const runtime = await harness({ stationRooms: [roomCode], now });
    const display = await connect(runtime.port, '/trivia?display=1');
    display.ws.send(JSON.stringify({ type: 'display_auth', roomCode, token: DISPLAY_TOKEN }));
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode }));
    await waitFor(() => display.messages.find(message => message.type === 'host_identity' && message.isHost),
      stateWaitMs);
    const players = ['Ada', 'Grace', 'Linus', 'Margaret'].map(name => (
      runtime.trivia.voiceJoin(roomCode, name, 4, true)!
    ));
    runtime.trivia.voiceAdvance(roomCode, players[0]!);
    players.forEach(playerId => runtime.trivia.voiceVoteCategory(roomCode, playerId, 'science'));
    runtime.trivia.voiceAdvance(roomCode, players[0]!);
    display.ws.send(JSON.stringify({
      type: 'ready',
      loadingGeneration: runtime.trivia.findRoom(roomCode)!.state().loadingGeneration,
    }));
    await waitFor(() => runtime.trivia.findRoom(roomCode)?.phase === 'countdown' ? true : undefined,
      stateWaitMs);
    expect(runtime.started).toHaveBeenCalledTimes(1);

    const room = runtime.trivia.findRoom(roomCode)!;
    now.value = room.state().countdownEndsAtMs!;
    for (let index = 0; index < 8; index++) {
      await waitFor(() => room.phase === 'question_prompt' && room.state().questionIndex === index
        ? true : undefined, stateWaitMs);
      await finishTrustedQuestionAudio(runtime.trivia, room, display, players);
      expect(room.phase).toBe('question');
      const question = room.state();
      now.value = question.answeringStartsAtMs!;
      for (const playerId of players) {
        expect(runtime.trivia.voiceAnswerAt(
          roomCode,
          playerId,
          question.question!.choices[0]!.id,
          true,
          question.answeringStartsAtMs!,
        )).toBe(true);
      }
      expect(room.phase).toBe('reveal');
      now.value = room.state().revealEndsAtMs!;
    }
    await waitFor(() => room.phase === 'results' ? true : undefined, stateWaitMs);
    const result = room.state().result!;
    expect(runtime.completed).toHaveBeenCalledTimes(1);
    expect(runtime.completed).toHaveBeenCalledWith('trivia', roomCode, result.players.map(player => ({
      enginePlayerId: player.playerId,
      rank: player.rank,
      completed: true,
      won: player.rank === 1,
      score: player.normalizedScore,
      durationSeconds: null,
    })));

    const internal = server as unknown as {
      persistTriviaResult(code: string, result: TriviaResult): void;
    };
    internal.persistTriviaResult(roomCode, result);
    const leaderboard = await waitForAsync(async () => {
      const response = await fetch(`${runtime.base}/api/trivia/leaderboard?board=all-time&limit=100`);
      const body = await response.json() as { entries: unknown[] };
      return body.entries.length === 4 ? { response, body } : undefined;
    }, stateWaitMs);
    expect(leaderboard.response.headers.get('etag')).toMatch(/^"trivia-leaderboard-/);
    expect(leaderboard.body.entries).toHaveLength(4);
    expect(JSON.stringify(leaderboard.body)).not.toMatch(/playerId|resultId|identityHash|engineResultId/i);
    expect(JSON.parse(await readFile(path.join(directory!, 'trivia-leaderboard.json'), 'utf8')).entries)
      .toHaveLength(4);
    const category = await fetch(`${runtime.base}/api/trivia/leaderboard?board=science&limit=4`);
    expect((await category.json() as { entries: unknown[] }).entries).toHaveLength(4);
    expect((await fetch(`${runtime.base}/api/trivia/leaderboard?board=mixed&limit=4`)).status).toBe(400);

    const summary = await fetch(`${runtime.base}/api/admin/arcade/leaderboards`);
    const summaryEtag = summary.headers.get('etag')!;
    expect((await summary.json() as { games: Array<{ game: string }> }).games.at(-1)?.game).toBe('trivia');
    const reset = await fetch(`${runtime.base}/api/admin/arcade/leaderboards/reset`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
        'If-Match': summaryEtag,
      },
      body: JSON.stringify({ game: 'trivia', map: 'science', reason: 'integration cleanup' }),
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ game: 'trivia', map: 'science', deleted: 4, remaining: 0 });
  }, 20_000);

  it('runs a production-shaped four-caller Voice Trivia match through HTTP and Relay sockets', async () => {
    const now = { value: 1_000_000 };
    const stationVoice: StationTriviaFixture = {
      roomCode: 'TRIVIA-FOUR',
      matchId: 'match-trivia-four',
      launchGeneration: 7,
      participants: [
        { from: '+14155550101', callSid: 'CA00000000000000000000000000000001', readyEntryId: 'ready-trivia-0', firstName: 'Ada', participantIndex: 0 },
        { from: '+14155550102', callSid: 'CA00000000000000000000000000000002', readyEntryId: 'ready-trivia-1', firstName: 'Grace', participantIndex: 1 },
        { from: '+14155550103', callSid: 'CA00000000000000000000000000000003', readyEntryId: 'ready-trivia-2', firstName: 'Linus', participantIndex: 2 },
        { from: '+14155550104', callSid: 'CA00000000000000000000000000000004', readyEntryId: 'ready-trivia-3', firstName: 'Margaret', participantIndex: 3 },
      ],
    };
    const runtime = await harness({
      now,
      stationVoice,
      manualTriviaClock: true,
      publicBaseUrl: VOICE_PUBLIC_BASE_URL,
      authToken: VOICE_AUTH_TOKEN,
      voiceRelayToken: VOICE_RELAY_TOKEN,
    });
    accelerateRelayChunkGaps();
    vi.spyOn(Date, 'now').mockImplementation(() => now.value);
    const internal = server as unknown as {
      triviaVoiceCallBindings: Map<string, { code: string; playerId: string }>;
      stationVoiceReconnectRoutes: Map<string, unknown>;
      voiceReconnectAttempts: Map<string, number>;
      triviaLeaderboard: TriviaLeaderboardStore;
    };
    const appendRound = vi.spyOn(internal.triviaLeaderboard, 'appendRound');
    const accountSid = 'AC00000000000000000000000000000099';
    const twimlByCall = new Map<string, { xml: string; parameters: Record<string, string> }>();

    for (const participant of stationVoice.participants) {
      const response = await signedVoicePost(runtime.port, '/voice/incoming', {
        AccountSid: accountSid,
        CallSid: participant.callSid,
        From: participant.from,
        To: '+18555993809',
      });
      const xml = await response.text();
      const parameters = relayParameters(xml);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/xml');
      expect(xml).toContain('<ConversationRelay');
      expect(xml).toContain('events="tokens-played"');
      expect(xml).toContain('partialPrompts="true"');
      expect(xml).toContain('interruptible="any"');
      expect(xml).toContain('reportInputDuringAgentSpeech="any"');
      expect(xml).toContain(`action="${VOICE_PUBLIC_BASE_URL}/voice/session-ended"`);
      expect(parameters).toEqual({
        roomCode: stationVoice.roomCode,
        game: 'trivia',
        readyEntryId: participant.readyEntryId,
        matchId: stationVoice.matchId,
        launchGeneration: String(stationVoice.launchGeneration),
        relayToken: VOICE_RELAY_TOKEN,
        locale: 'en-US',
        commandLocale: 'en-US',
      });
      const hints = relayAttribute(xml, 'hints');
      expect(hints).toMatch(/quiz, trivia, category, mixed, answer, choice, option, number, letter/i);
      expect(hints).toMatch(/one, two, three, four/i);
      expect(hints).toMatch(/ay, aye, alpha/i);
      expect(hints.split(', ')).not.toEqual(expect.arrayContaining(['eh', 'hey']));
      expect(hints).toMatch(/D, dee, Delta/i);
      expect(hints.split(', ').length).toBeLessThanOrEqual(100);
      expect(hints).toMatch(/general knowledge/i);
      expect(hints).toMatch(/science/i);
      expect(hints.split(', ')).not.toEqual(expect.arrayContaining(['be', 'see', 'the', 'de']));
      twimlByCall.set(participant.callSid, { xml, parameters });
    }
    expect(runtime.stationVoiceRoute.mock.calls.map(([from, callSid]) => [from, callSid])).toEqual(
      stationVoice.participants.map(participant => [participant.from, participant.callSid]),
    );

    const voiceSignature = twilio.getExpectedTwilioSignature(
      VOICE_AUTH_TOKEN,
      'wss://games.example/voice',
      {},
    );
    const callersByIndex = new Map<number, FakeRelayCaller>();
    for (const participant of stationVoice.participants.slice().reverse()) {
      const caller = await connectRelayCaller(runtime.port, {
        participant,
        parameters: twimlByCall.get(participant.callSid)!.parameters,
        signature: voiceSignature,
      });
      callersByIndex.set(participant.participantIndex, caller);
    }
    const callers = stationVoice.participants.map(participant => callersByIndex.get(participant.participantIndex)!);
    const room = await waitFor(() => {
      const candidate = runtime.trivia.findRoom(stationVoice.roomCode);
      return candidate?.state().players.length === 4 ? candidate : undefined;
    });
    await waitFor(() => runtime.stationVoiceParticipantConnected.mock.calls.length === 4 ? true : undefined);
    for (const participant of stationVoice.participants) {
      await waitForRelaySpeech(
        callers[participant.participantIndex]!,
        0,
        text => text.includes(`Voice Trivia, ${participant.firstName}`),
      );
    }
    const initialState = room.state();
    expect(initialState).toMatchObject({ expectedPlayerCount: 4, hasExpectedPlayers: true });
    expect(initialState.players.map(player => ({
      name: player.name,
      order: player.playerOrder,
      connected: player.connected,
    }))).toEqual(stationVoice.participants.map(participant => ({
      name: participant.firstName,
      order: participant.participantIndex,
      connected: true,
    })));
    expect(new Set(initialState.players.map(player => player.playerId)).size).toBe(4);
    expect(callers.flatMap(caller => caller.speech).join(' ')).not.toMatch(/what is your first name/i);
    expect(runtime.resolveStationVoiceSetup).toHaveBeenCalledTimes(4);
    expect(runtime.stationVoiceParticipantConnected.mock.calls.map(call => call.slice(0, 2))).toEqual(
      stationVoice.participants.slice().reverse().map(participant => [participant.callSid, participant.readyEntryId]),
    );
    expect(new Set(runtime.stationVoiceParticipantConnected.mock.calls.map(call => call[3])).size).toBe(4);
    expect(initialState.players.map(player => player.playerId)).toEqual(
      runtime.stationVoiceParticipantConnected.mock.calls.map(call => call[2]).reverse(),
    );

    const bindingPlayerIds = stationVoice.participants.map(participant => (
      internal.triviaVoiceCallBindings.get(participant.callSid)!.playerId
    ));
    expect(new Set(bindingPlayerIds).size).toBe(4);
    expect(bindingPlayerIds).toEqual(initialState.players.map(player => player.playerId));

    // A greeting can arrive before the callers' lobby audio has finished and the shared menu advances.
    await waitFor(() => room.phase === 'category_select' ? true : undefined);

    const categoryFinals = ['Science', 'History please', 'I vote for science', 'category number two'];
    const expectedVotes = [
      { science: 1, history: 0 },
      { science: 1, history: 1 },
      { science: 2, history: 1 },
      { science: 3, history: 1 },
    ];
    for (let index = 0; index < callers.length; index++) {
      sendFinalTranscript(callers[index]!, categoryFinals[index]!);
      await waitFor(() => {
        const counts = room.state().categoryVoteCounts;
        const expected = expectedVotes[index]!;
        return counts.science === expected.science && counts.history === expected.history ? true : undefined;
      });
      expect(room.state().categoryVoteCounts).toMatchObject(expectedVotes[index]!);
    }
    // The final vote is counted before every caller's category confirmation has finished playing.
    await waitFor(() => room.phase === 'loading' ? true : undefined);
    expect(room.state()).toMatchObject({
      phase: 'loading',
      category: 'science',
      categoryVoteCounts: { science: 3, history: 1 },
    });

    const display = await connect(runtime.port, '/trivia?display=1', { Origin: VOICE_PUBLIC_BASE_URL });
    display.ws.send(JSON.stringify({ type: 'display_auth', roomCode: stationVoice.roomCode, token: DISPLAY_TOKEN }));
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: stationVoice.roomCode, locale: 'en-US' }));
    await waitFor(() => display.messages.find(message => message.type === 'host_identity' && message.isHost));
    display.ws.send(JSON.stringify({
      type: 'ready',
      loadingGeneration: room.state().loadingGeneration,
    }));
    await waitFor(() => room.phase === 'countdown' ? true : undefined);
    expect(runtime.started).toHaveBeenCalledTimes(1);
    expect(runtime.started).toHaveBeenCalledWith('trivia', stationVoice.roomCode);

    for (const caller of callers) caller.holdText = text => /^Question 1\b/i.test(text);
    now.value = room.state().countdownEndsAtMs!;
    runtime.tickTrivia();
    await waitFor(() => room.phase === 'question_prompt' ? true : undefined);
    await paintTriviaView(display, runtime.trivia, room, 'question_prompt', bindingPlayerIds[0]!);
    expect(room.state().answeringStartsAtMs).toBeNull();
    await waitFor(() => callers.every(caller => caller.held.length === 1) ? true : undefined);
    for (const caller of callers) {
      expect(caller.acknowledgements).not.toContain(caller.held[0]!.token);
      expect(caller.held[0]!.text).toMatch(/^Question 1\b/i);
    }
    expect(room.phase).toBe('question_prompt');
    for (const caller of callers) acknowledgeRelayText(caller, caller.held[0]!.token);
    await waitFor(() => room.phase === 'answer_cue' ? true : undefined);
    expect(room.state().answeringStartsAtMs).toBe(now.value);
    await paintTriviaView(display, runtime.trivia, room, 'answer_cue', bindingPlayerIds[0]!);
    const firstQuestionDisplayState = await waitFor(() => display.messages.find(message => (
      message.type === 'trivia_state' && message.phase === 'question' && message.questionIndex === 0
    )));
    const firstQuestionState = room.state();
    expect(firstQuestionState.phase).toBe('question');
    expect(firstQuestionState.answeringStartsAtMs).toBe(firstQuestionDisplayState.answeringStartsAtMs);
    expect(firstQuestionState.answeringStartsAtMs).toBe(now.value);
    expect(firstQuestionState.questionEndsAtMs).toBe(now.value + TRIVIA_ANSWER_WINDOW_MS);
    expect(JSON.stringify(firstQuestionDisplayState)).not.toMatch(/correctChoiceId|submittedChoiceId|aliases|explanation/i);
    for (const caller of callers) {
      expect(caller.acknowledgements).toContain(caller.held[0]!.token);
      expect(caller.held[0]!.text).toMatch(/^Question 1\b/i);
    }

    const correctPatterns = [
      [true, true, true, true, true, false, false, false],
      [true, true, true, true, false, false, false, false],
      [false, true, true, true, false, false, false, false],
      [true, true, false, false, false, false, false, false],
    ] as const;
    const firstQuestion = firstQuestionState.question!;
    const firstCorrect = correctChoiceId(firstQuestion.id);
    const firstWrong = firstQuestion.choices.find(choice => choice.id !== firstCorrect)!.id;
    now.value = firstQuestionState.answeringStartsAtMs!;
    const initialLockCounts = callers.map(caller => relaySpeechCount(caller, /Answer locked/i));
    const revealLine = /^(?:Correct!|Incorrect\.|Time's up\.)/i;
    const initialRevealCounts = callers.map(caller => relaySpeechCount(caller, revealLine));

    const correctIndex = firstQuestion.choices.findIndex(choice => choice.id === firstCorrect);
    const firstInputs = [
      () => sendFinalTranscript(callers[0]!, `answer ${['one', 'two', 'three', 'four'][correctIndex]}`),
      () => sendFinalTranscript(callers[1]!, String(correctIndex + 1)),
      () => sendFinalTranscript(callers[2]!, firstQuestion.choices.find(choice => choice.id === firstWrong)!.text),
      () => callers[3]!.ws.send(JSON.stringify({ type: 'dtmf', digit: String(correctIndex + 1) })),
    ];
    for (let index = 0; index < firstInputs.length - 1; index++) {
      firstInputs[index]!();
      await waitFor(() => room.state().players.find(player => player.playerId === bindingPlayerIds[index])?.answered
        ? true : undefined);
      await waitFor(() => relaySpeechCount(callers[index]!, /Answer locked/i) === initialLockCounts[index]! + 1
        ? true : undefined);
      expect(room.phase).toBe('question');
      expect(room.state().players.map(player => player.answered)).toEqual(
        callers.map((_caller, playerIndex) => playerIndex <= index),
      );
      expect(callers.map(caller => relaySpeechCount(caller, /Answer locked/i))).toEqual(
        initialLockCounts.map((count, playerIndex) => count + (playerIndex <= index ? 1 : 0)),
      );
      for (const caller of callers) expect(caller.acknowledgements).toContain(caller.held[0]!.token);
    }
    expect(room.state().players.map(player => ({
      answered: player.answered,
      rawScore: player.rawScore,
      correctCount: player.correctCount,
    }))).toEqual([
      { answered: true, rawScore: 0, correctCount: 0 },
      { answered: true, rawScore: 0, correctCount: 0 },
      { answered: true, rawScore: 0, correctCount: 0 },
      { answered: false, rawScore: 0, correctCount: 0 },
    ]);
    expect(JSON.stringify(room.state())).not.toMatch(/correctChoiceId|submittedChoiceId|submittedCorrect/i);

    const duplicateActivityCount = runtime.stationVoiceSetupActivity.mock.calls.length;
    sendFinalTranscript(callers[2]!, firstQuestion.choices.find(choice => choice.id === firstCorrect)!.text);
    await waitFor(() => runtime.stationVoiceSetupActivity.mock.calls.length === duplicateActivityCount + 1
      ? true : undefined);
    expect(room.phase).toBe('question');
    expect(room.state().players.map(player => player.answered)).toEqual([true, true, true, false]);
    expect(relaySpeechCount(callers[2]!, /Answer locked/i)).toBe(initialLockCounts[2]! + 1);

    const slowRevealCaller = callers[0]!;
    slowRevealCaller.holdText = text => /^Correct!/i.test(text);
    firstInputs[3]!();
    await waitFor(() => room.phase === 'reveal' ? true : undefined);
    await waitFor(() => relaySpeechCount(callers[3]!, /Answer locked/i) === initialLockCounts[3]! + 1
      ? true : undefined);
    expect(room.state().players.map(player => player.answered)).toEqual([true, true, true, true]);
    expect(room.state().players.map(player => player.correctCount)).toEqual([1, 1, 0, 1]);
    expect(callers.every(caller => relaySpeechCount(caller, /^Question 1\b/i) === 1)).toBe(true);
    for (let index = 0; index < callers.length; index++) {
      await waitFor(() => relaySpeechCount(callers[index]!, revealLine) === initialRevealCounts[index]! + 1
        ? true : undefined);
    }
    await waitFor(() => slowRevealCaller.held.length === 2 ? true : undefined);
    const slowReveal = slowRevealCaller.held[1]!;
    expect(slowReveal.text).toMatch(/^Correct!/i);
    expect(slowRevealCaller.acknowledgements).not.toContain(slowReveal.token);
    const firstRevealSpeech = callers.map(caller => (
      caller.speech.find(text => revealLine.test(text)) ?? ''
    ));
    expect(firstRevealSpeech[2]).toMatch(/Incorrect\. The correct answer was option/i);
    expect(firstRevealSpeech[2]).toContain(firstQuestion.choices[correctIndex]!.text);
    expect(firstRevealSpeech[0]).toMatch(/You earned [1-9]/i);
    expect(firstRevealSpeech[1]).toMatch(/You earned [1-9]/i);
    expect(firstRevealSpeech[3]).toMatch(/You earned [1-9]/i);

    // The displayed answer gets at least four seconds, and a slow caller's correction
    // must finish before the next question can preempt it.
    now.value = room.state().revealEndsAtMs!;
    runtime.tickTrivia();
    expect(room.phase).toBe('reveal');
    acknowledgeRelayText(slowRevealCaller, slowReveal.token);
    await waitFor(() => room.phase === 'question_prompt' && room.state().questionIndex === 1
      ? true : undefined);
    expect(slowRevealCaller.acknowledgements).toContain(slowReveal.token);

    for (let questionIndex = 1; questionIndex < 8; questionIndex++) {
      const priorRevealCounts = callers.map(caller => relaySpeechCount(caller, revealLine));
      if (questionIndex > 1) {
        now.value = room.state().revealEndsAtMs!;
        runtime.tickTrivia();
        await waitFor(() => room.phase === 'question_prompt' && room.state().questionIndex === questionIndex
          ? true : undefined);
      }
      await paintTriviaView(display, runtime.trivia, room, 'question_prompt', bindingPlayerIds[0]!);
      await waitFor(() => room.phase === 'answer_cue' ? true : undefined);
      await paintTriviaView(display, runtime.trivia, room, 'answer_cue', bindingPlayerIds[0]!);
      await waitFor(() => room.phase === 'question' && room.state().questionIndex === questionIndex
        ? true : undefined);
      const state = room.state();
      if (questionIndex === 1) {
        expect(state).toMatchObject({
          answeringStartsAtMs: now.value,
          questionEndsAtMs: now.value + TRIVIA_ANSWER_WINDOW_MS,
        });
        await waitForRelaySpeech(slowRevealCaller, 0, text => /^Question 2\b/i.test(text));
        expect(slowRevealCaller.acknowledgements).toContain(slowReveal.token);
        expect(relaySpeechCount(slowRevealCaller, revealLine)).toBe(initialRevealCounts[0]! + 1);
      }
      const question = state.question!;
      const correct = correctChoiceId(question.id);
      const wrong = question.choices.find(choice => choice.id !== correct)!.id;
      now.value = state.answeringStartsAtMs! + (questionIndex <= 4 ? 3_000 : 0);
      for (let playerIndex = 0; playerIndex < callers.length; playerIndex++) {
        const choiceId = correctPatterns[playerIndex]![questionIndex] ? correct : wrong;
        sendRelayAnswer(callers[playerIndex]!, question, choiceId, (playerIndex + questionIndex) % 2 === 1);
        if (playerIndex < callers.length - 1) {
          await waitFor(() => room.state().players.find(player => player.playerId === bindingPlayerIds[playerIndex])?.answered
            ? true : undefined);
          expect(room.phase).toBe('question');
        }
      }
      await waitFor(() => room.phase === 'reveal' ? true : undefined);
      for (let playerIndex = 0; playerIndex < callers.length; playerIndex++) {
        await waitFor(() => relaySpeechCount(callers[playerIndex]!, revealLine) === priorRevealCounts[playerIndex]! + 1
          ? true : undefined);
      }
    }

    const resultSpeechOffsets = callers.map(caller => caller.speech.length);
    now.value = room.state().revealEndsAtMs!;
    runtime.tickTrivia();
    await waitFor(() => room.phase === 'results' ? true : undefined);
    const result = room.state().result!;
    expect(result.category).toBe('science');
    expect(result.players.map(player => ({ name: player.name, rank: player.rank, correct: player.correctCount }))).toEqual([
      { name: 'Ada', rank: 1, correct: 5 },
      { name: 'Grace', rank: 2, correct: 4 },
      { name: 'Linus', rank: 3, correct: 3 },
      { name: 'Margaret', rank: 4, correct: 2 },
    ]);
    expect(result.players[0]).toMatchObject({ rawScore: 7_500, normalizedScore: 58_140 });
    const resultDisplayState = await waitFor(() => display.messages.find(message => (
      message.type === 'trivia_state' && message.phase === 'results'
    )));
    expect(resultDisplayState.result).toEqual(result);
    expect(runtime.started).toHaveBeenCalledTimes(1);
    expect(runtime.completed).toHaveBeenCalledTimes(1);
    expect(runtime.completed).toHaveBeenCalledWith('trivia', stationVoice.roomCode, result.players.map(player => ({
      enginePlayerId: player.playerId,
      rank: player.rank,
      completed: true,
      won: player.rank === 1,
      score: player.normalizedScore,
      durationSeconds: null,
    })));
    expect(runtime.abandoned).not.toHaveBeenCalled();

    for (let index = 0; index < callers.length; index++) {
      const participant = stationVoice.participants[index]!;
      const stationResult = await waitForRelaySpeech(callers[index]!, resultSpeechOffsets[index]!, text => (
        /Ada wins\. Your leaderboard score: [\d,.]+;/i.test(text)
      ));
      expect(stationResult).toMatch(/Twilio Conversation Relay.*transcribed phone answers.*scored.*screen.*spoke results.*Check messages.*coins.*replay/i);
      expect(stationResult).toContain(`${result.players[index]!.correctCount} correct`);
      expect(stationResult.trim().split(/\s+/).length).toBeLessThanOrEqual(32);
      const resultSpeech = callers[index]!.speech.slice(resultSpeechOffsets[index]!).join(' ');
      expect(resultSpeech).not.toMatch(/say play again/i);
      expect(resultSpeech).toContain(new Intl.NumberFormat('en-US').format(result.players[index]!.normalizedScore));
      expect(resultSpeech).not.toContain('7,500');
      for (const other of result.players.filter(candidate => candidate.name !== participant.firstName)) {
        expect(resultSpeech).not.toContain(`score: ${new Intl.NumberFormat('en-US').format(other.normalizedScore)}`);
      }
    }

    const leaderboard = await waitForAsync(async () => {
      const response = await fetch(`${runtime.base}/api/trivia/leaderboard?board=all-time&limit=4`);
      const body = await response.json() as { entries: Array<Record<string, unknown>> };
      return body.entries.length === 4 ? body : undefined;
    });
    expect(appendRound).toHaveBeenCalledTimes(1);
    expect(appendRound.mock.calls[0]?.[0].result.players).toHaveLength(4);
    expect(leaderboard.entries.map(entry => entry.displayName)).toEqual(['Ada', 'Grace', 'Linus', 'Margaret']);
    expect(leaderboard.entries.every(entry => (
      Object.keys(entry).sort().join(',') === 'category,displayName,playedAt,rank,score'
    ))).toBe(true);
    expect(JSON.stringify(leaderboard)).not.toMatch(/playerId|resultId|identityHash|correctCount|cumulativeCorrectTimeMs/i);
    const persisted = JSON.parse(
      await readFile(path.join(directory!, 'trivia-leaderboard.json'), 'utf8'),
    ) as { entries: Array<Record<string, unknown>> };
    expect(persisted.entries).toHaveLength(4);
    expect(new Set(persisted.entries.map(entry => entry.resultId)).size).toBe(1);
    expect(new Set(persisted.entries.map(entry => entry.engineResultId)).size).toBe(1);
    expect(persisted.entries.every(entry => entry.resultPlayerCount === 4)).toBe(true);
    expect(persisted.entries.every(entry => /^[a-f0-9]{64}$/.test(String(entry.playerIdentityHash)))).toBe(true);
    expect(JSON.stringify(persisted)).not.toMatch(/"playerId"|"submittedChoiceId"/i);

    for (const caller of callers) {
      const outgoingTokens = caller.messages
        .filter(message => message.type === 'text')
        .map(message => String(message.token));
      expect(caller.acknowledgements).toEqual(outgoingTokens);
      const textFrames = caller.messages.filter(message => message.type === 'text');
      expect(textFrames.every(message => (
        message.lang === 'en-US' && message.interruptible === true && message.preemptible === true
      ))).toBe(true);
      expect(textFrames.at(-1)?.last).toBe(true);
    }

    const terminalResult = JSON.stringify(result);
    await Promise.all(callers.map(closeRelayCaller));
    await waitFor(() => runtime.stationVoiceParticipantDisconnected.mock.calls.length === 4 ? true : undefined);
    expect(new Set(runtime.stationVoiceParticipantDisconnected.mock.calls.map(call => call[0]))).toEqual(
      new Set(stationVoice.participants.map(participant => participant.callSid)),
    );
    expect(new Set(runtime.stationVoiceParticipantDisconnected.mock.calls.map(call => call[1]))).toEqual(
      new Set(stationVoice.participants.map(participant => participant.readyEntryId)),
    );
    expect(new Set(runtime.stationVoiceParticipantDisconnected.mock.calls.map(call => call[2])).size).toBe(4);

    for (const participant of stationVoice.participants) {
      const response = await signedVoicePost(runtime.port, '/voice/session-ended', {
        AccountSid: accountSid,
        CallSid: participant.callSid,
        From: participant.from,
        CallStatus: 'completed',
        SessionStatus: 'completed',
      });
      expect(await response.text()).toContain('<Hangup />');
    }
    expect(runtime.stationVoiceCallEnded.mock.calls.map(call => call[0])).toEqual(
      stationVoice.participants.map(participant => participant.callSid),
    );
    expect(internal.triviaVoiceCallBindings.size).toBe(0);
    expect(internal.stationVoiceReconnectRoutes.size).toBe(0);
    expect(internal.voiceReconnectAttempts.size).toBe(0);
    expect(JSON.stringify(result)).toBe(terminalResult);
    expect(Object.isFrozen(result)).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'results', result,
      players: stationVoice.participants.map(participant => expect.objectContaining({
        name: participant.firstName, connected: false,
      })),
    });
    expect(runtime.completed).toHaveBeenCalledTimes(1);
    expect(runtime.abandoned).not.toHaveBeenCalled();
    const afterCleanup = await fetch(`${runtime.base}/api/trivia/leaderboard?board=science&limit=4`);
    expect(afterCleanup.status).toBe(200);
    expect((await afterCleanup.json() as { entries: unknown[] }).entries).toHaveLength(4);
  }, 20_000);

  it('serializes an append after a reset precondition and mutation', async () => {
    const runtime = await harness();
    const internal = server as unknown as {
      persistTriviaResult(code: string, result: TriviaResult): void;
      leaderboardWrite: Promise<void>;
      triviaLeaderboard: TriviaLeaderboardStore;
    };
    internal.persistTriviaResult('RACE-ROOM', persistenceResult('before-reset', 1_000, 'Before'));
    await internal.leaderboardWrite;
    const summary = await fetch(`${runtime.base}/api/admin/arcade/leaderboards`);
    const etag = summary.headers.get('etag')!;

    const originalReset = internal.triviaLeaderboard.reset.bind(internal.triviaLeaderboard);
    let resetStarted!: () => void;
    const started = new Promise<void>(resolve => { resetStarted = resolve; });
    let releaseReset!: () => void;
    const gate = new Promise<void>(resolve => { releaseReset = resolve; });
    vi.spyOn(internal.triviaLeaderboard, 'reset').mockImplementation(async board => {
      resetStarted();
      await gate;
      return originalReset(board);
    });
    const append = vi.spyOn(internal.triviaLeaderboard, 'appendRound');
    const resetRequest = fetch(`${runtime.base}/api/admin/arcade/leaderboards/reset`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
        'If-Match': etag,
      },
      body: JSON.stringify({ game: 'trivia', map: 'science', reason: 'race test' }),
    });
    await started;
    internal.persistTriviaResult('RACE-ROOM', persistenceResult('after-reset', 2_000, 'After'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(append).not.toHaveBeenCalled();

    releaseReset();
    expect((await resetRequest).status).toBe(200);
    await internal.leaderboardWrite;
    expect(append).toHaveBeenCalledOnce();
    const response = await fetch(`${runtime.base}/api/trivia/leaderboard?board=science&limit=100`);
    expect((await response.json() as { entries: Array<{ displayName: string }> }).entries)
      .toEqual([expect.objectContaining({ displayName: 'After' })]);
  });

  it('uses a deterministic result ID across retries and process restart and clears pending suppression', async () => {
    const first = await harness();
    const storageDirectory = directory!;
    const result = persistenceResult('retry-stable-engine-result', 3_000, 'Ada');
    const expectedId = triviaLeaderboardResultId(' retry-room ', result);
    const firstInternal = server as unknown as {
      persistTriviaResult(code: string, result: TriviaResult): void;
      leaderboardWrite: Promise<void>;
      triviaResultPersistence: Map<string, Promise<void>>;
    };
    firstInternal.persistTriviaResult(' retry-room ', result);
    await firstInternal.leaderboardWrite;
    expect(firstInternal.triviaResultPersistence.size).toBe(0);
    firstInternal.persistTriviaResult('RETRY-ROOM', result);
    await firstInternal.leaderboardWrite;
    expect(JSON.parse(await readFile(path.join(storageDirectory, 'trivia-leaderboard.json'), 'utf8')).entries)
      .toHaveLength(1);

    await server!.stop();
    server = undefined;
    const restarted = await harness({ storageDirectory });
    const restartedInternal = server as unknown as {
      persistTriviaResult(code: string, result: TriviaResult): void;
      leaderboardWrite: Promise<void>;
      triviaResultPersistence: Map<string, Promise<void>>;
    };
    restartedInternal.persistTriviaResult('RETRY-ROOM', result);
    await restartedInternal.leaderboardWrite;
    expect(restartedInternal.triviaResultPersistence.size).toBe(0);
    const persisted = JSON.parse(
      await readFile(path.join(storageDirectory, 'trivia-leaderboard.json'), 'utf8'),
    ) as { entries: Array<{ resultId: string }> };
    expect(persisted.entries).toEqual([expect.objectContaining({ resultId: expectedId })]);
    expect((await fetch(`${restarted.base}/api/trivia/leaderboard?board=all-time&limit=100`)).status).toBe(200);
    void first;
  });

  it('holds an issued standalone call if its screen drops before Relay binds, then applies the restored seat count', async () => {
    const runtime = await harness({ standaloneVoiceEnabled: true });
    const display = await connect(runtime.port, '/trivia?display=1');
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: DEFAULT_ROOM, count: 3 }));
    await waitFor(() => display.messages.find(message => message.type === 'trivia_state'
      && message.expectedPlayerCount === 3));

    const callSid = 'CA-TRIVIA-DISPLAY-GAP';
    const incoming = await fetch(`${runtime.base}/voice/incoming`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: '+14155550199', To: '+18555993809', CallSid: callSid }),
    });
    const xml = await incoming.text();
    expect(xml).toContain('<Parameter name="game" value="trivia"');
    const parameters = relayParameters(xml);

    const closed = new Promise<void>(resolve => display.ws.once('close', () => resolve()));
    display.ws.close();
    await closed;
    await waitFor(() => runtime.trivia.findRoom(DEFAULT_ROOM) === undefined ? true : undefined);

    const relay = await connect(runtime.port, '/voice');
    relay.ws.send(JSON.stringify({ type: 'setup', callSid, customParameters: parameters }));
    const first = await waitFor(() => runtime.trivia.findRoom(DEFAULT_ROOM)?.state().players[0]?.playerId);
    expect(runtime.trivia.voiceSnapshot(DEFAULT_ROOM, first)?.awaitingDisplay).toBe(true);
    expect(runtime.trivia.voiceAdvance(DEFAULT_ROOM, first)).toBe(false);
    expect(runtime.trivia.findRoom(DEFAULT_ROOM)?.phase).toBe('lobby');

    const restored = await connect(runtime.port, '/trivia?display=1');
    restored.ws.send(JSON.stringify({ type: 'spectate', roomCode: DEFAULT_ROOM, count: 3 }));
    await waitFor(() => restored.messages.find(message => message.type === 'trivia_state'
      && message.expectedPlayerCount === 3));
    expect(runtime.trivia.voiceSnapshot(DEFAULT_ROOM, first)?.awaitingDisplay).toBe(false);
    expect(runtime.trivia.findRoom(DEFAULT_ROOM)?.state()).toMatchObject({
      phase: 'lobby', expectedPlayerCount: 3, hasExpectedPlayers: false,
    });
    expect(runtime.trivia.voiceJoin(DEFAULT_ROOM, 'Grace', 1, true)).toBeTruthy();
  });

  it('routes quiz voice sessions and resumes the same caller slot after transport replacement', async () => {
    const runtime = await harness({ standaloneVoiceEnabled: true });
    const callSid = 'CA-TRIVIA-RECONNECT';
    const connectVoice = async () => {
      const voice = await connect(runtime.port, '/voice');
      voice.ws.on('message', data => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === 'text') {
          voice.ws.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: message.token }));
        }
      });
      voice.ws.send(JSON.stringify({
        type: 'setup', callSid,
        customParameters: { roomCode: 'QUIZ-RECONNECT', game: 'quiz', commandLocale: 'en-US' },
      }));
      return voice;
    };
    const first = await connectVoice();
    await waitFor(() => runtime.trivia.findRoom('QUIZ-RECONNECT')?.state().players.length === 1 ? true : undefined);
    first.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Ada', last: true }));
    await waitFor(() => runtime.trivia.findRoom('QUIZ-RECONNECT')?.phase === 'category_select' ? true : undefined);
    const original = runtime.trivia.findRoom('QUIZ-RECONNECT')!.state().players[0]!.playerId;
    first.ws.close();
    await new Promise<void>(resolve => first.ws.once('close', () => resolve()));
    await waitFor(() => runtime.trivia.findRoom('QUIZ-RECONNECT')?.state().players[0]?.connected === false ? true : undefined);

    const recovery = await fetch(`${runtime.base}/voice/session-ended`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        CallSid: callSid,
        CallStatus: 'in-progress',
        SessionStatus: 'failed',
        ErrorCode: '39001',
      }),
    });
    const recoveryXml = await recovery.text();
    expect(recoveryXml).toContain('<ConversationRelay');
    expect(recoveryXml).toContain('<Parameter name="game" value="trivia"');

    const replacement = await connectVoice();
    await waitFor(() => runtime.trivia.findRoom('QUIZ-RECONNECT')?.state().players[0]?.connected === true ? true : undefined);
    expect(runtime.trivia.findRoom('QUIZ-RECONNECT')!.state().players).toEqual([
      expect.objectContaining({ playerId: original, name: 'Ada', connected: true }),
    ]);
    replacement.ws.close();
  });

  it('keeps one-player Arcade Trivia fixed while standalone Trivia remains replayable', async () => {
    const runtime = await harness();
    const internal = server as unknown as {
      makeTriviaSession(
        say: () => Promise<'played'>,
        stationFixed?: () => boolean,
      ): TriviaVoiceSession;
    };
    const bind = (roomCode: string, stationFixed: boolean) => {
      const session = internal.makeTriviaSession(async () => 'played' as const, () => stationFixed);
      session.setAuthoritativeName('Ada');
      session.setExpectedPlayers(1);
      session.setStationManaged(stationFixed);
      if (stationFixed) session.setStationAssignment(0);
      session.handleMessage(JSON.stringify({
        type: 'setup',
        callSid: `CA-${roomCode}`,
        customParameters: { roomCode, game: 'trivia', commandLocale: 'en-US' },
      }));
      return runtime.trivia.findRoom(roomCode)!;
    };

    const station = bind('STATION-ONE', true);
    const standalone = bind('STANDALONE-ONE', false);
    expect(station.state()).toMatchObject({ expectedPlayerCount: 1, automaticSetup: true });
    expect(station.stationFixed).toBe(true);
    expect(station.allowReplay).toBe(false);
    expect(standalone.state()).toMatchObject({ expectedPlayerCount: 1, automaticSetup: true });
    expect(standalone.stationFixed).toBe(false);
    expect(standalone.allowReplay).toBe(true);
  });

  it('retains a trusted station participant index across a Trivia voice reconnect', async () => {
    const runtime = await harness();
    const internal = server as unknown as {
      makeTriviaSession(
        say: () => Promise<'played'>,
        stationFixed?: () => boolean,
      ): TriviaVoiceSession;
      triviaVoiceCallBindings: Map<string, { playerId: string; participantIndex: number | null }>;
    };
    const bind = () => {
      const session = internal.makeTriviaSession(async () => 'played' as const, () => true);
      session.setAuthoritativeName('Ada');
      session.setExpectedPlayers(4);
      session.setStationManaged(true);
      session.setStationAssignment(2);
      session.handleMessage(JSON.stringify({
        type: 'setup', callSid: 'CA-INDEX-RECONNECT',
        customParameters: { roomCode: 'INDEX-RECONNECT', game: 'trivia', commandLocale: 'en-US' },
      }));
      return session;
    };

    const first = bind();
    const originalPlayerId = first.boundPlayerId!;
    expect(runtime.trivia.findRoom('INDEX-RECONNECT')!.state().players[0]).toMatchObject({
      playerId: originalPlayerId, playerOrder: 2,
    });
    first.handleClose();
    expect(internal.triviaVoiceCallBindings.get('CA-INDEX-RECONNECT')).toMatchObject({
      playerId: originalPlayerId, participantIndex: 2,
    });

    const resumed = bind();
    expect(resumed.boundPlayerId).toBe(originalPlayerId);
    expect(runtime.trivia.findRoom('INDEX-RECONNECT')!.state().players).toEqual([
      expect.objectContaining({ playerId: originalPlayerId, playerOrder: 2, connected: true }),
    ]);
  });

  it('uses the HTTP participant reconcile hook to purge a Trivia no-show and its binding', async () => {
    const runtime = await harness();
    const internal = server as unknown as {
      makeTriviaSession(
        say: () => Promise<'played'>,
        stationFixed?: () => boolean,
      ): TriviaVoiceSession;
      triviaVoiceCallBindings: Map<string, { playerId: string; participantIndex: number | null }>;
    };
    const bind = (callSid: string, name: string, participantIndex: number) => {
      const session = internal.makeTriviaSession(async () => 'played' as const, () => true);
      session.setAuthoritativeName(name);
      session.setExpectedPlayers(2);
      session.setStationManaged(true);
      session.setStationAssignment(participantIndex);
      session.handleMessage(JSON.stringify({
        type: 'setup', callSid,
        customParameters: { roomCode: 'HTTP-RECONCILE', game: 'trivia', commandLocale: 'en-US' },
      }));
      return session;
    };
    const retained = bind('CA-RETAINED', 'Ada', 0);
    const dropped = bind('CA-DROPPED', 'Grace', 1);
    await waitFor(() => runtime.trivia.findRoom('HTTP-RECONCILE')?.phase === 'category_select'
      ? true : undefined);

    runtime.participantReconcile!(
      'trivia', 'HTTP-RECONCILE', 2,
      [retained.boundPlayerId!], [retained.boundPlayerId!, null],
    );
    expect(runtime.trivia.findRoom('HTTP-RECONCILE')!.state()).toMatchObject({
      phase: 'lobby', expectedPlayerCount: 2,
      players: [{ playerId: retained.boundPlayerId, name: 'Ada', playerOrder: 0 }],
    });
    expect(runtime.trivia.voiceSnapshot('HTTP-RECONCILE', dropped.boundPlayerId!)).toBeNull();
    expect(internal.triviaVoiceCallBindings.has('CA-DROPPED')).toBe(false);

    const replacement = bind('CA-REPLACEMENT', 'Linus', 1);
    expect(replacement.boundPlayerId).not.toBeNull();
    expect(runtime.trivia.findRoom('HTTP-RECONCILE')!.state().players.map(player => player.name)).toEqual([
      'Ada', 'Linus',
    ]);
  });

  it('compacts retained Trivia bindings, releases dropped call claims, and resumes at new indexes', async () => {
    const fixture: StationTriviaFixture = {
      roomCode: 'HTTP-COMPACT',
      matchId: 'match-http-compact',
      launchGeneration: 2,
      participants: [0, 1, 2, 3].map(index => ({
        from: `+1415555020${index}`,
        callSid: `CA-COMPACT-${index}`,
        readyEntryId: `ready-compact-${index}`,
        firstName: `Player ${index}`,
        participantIndex: index,
      })),
    };
    const runtime = await harness({ stationVoice: fixture });
    const internal = server as unknown as {
      makeTriviaSession(
        say: () => Promise<'played'>,
        stationFixed?: () => boolean,
      ): TriviaVoiceSession;
      triviaVoiceCallBindings: Map<string, { playerId: string; participantIndex: number | null }>;
    };
    const bind = (callSid: string, name: string, participantIndex: number, expectedPlayers: number) => {
      const session = internal.makeTriviaSession(async () => 'played' as const, () => true);
      session.setAuthoritativeName(name);
      session.setExpectedPlayers(expectedPlayers);
      session.setStationManaged(true);
      session.setStationAssignment(participantIndex);
      session.handleMessage(JSON.stringify({
        type: 'setup', callSid,
        customParameters: { roomCode: fixture.roomCode, game: 'trivia', commandLocale: 'en-US' },
      }));
      return session;
    };
    for (const participant of fixture.participants) {
      expect(await runtime.stationVoiceRoute(participant.from, participant.callSid)).toMatchObject({ admitted: true });
    }
    const originalSessions = fixture.participants.map(participant => (
      bind(participant.callSid, participant.firstName, participant.participantIndex, 4)
    ));
    const originalPlayerIds = originalSessions.map(session => session.boundPlayerId!);
    const retainedPlayerIds = [originalPlayerIds[3]!, originalPlayerIds[1]!];

    runtime.participantReconcile!('trivia', fixture.roomCode, 2, retainedPlayerIds, retainedPlayerIds);
    expect(runtime.trivia.findRoom(fixture.roomCode)!.state().players.map(player => (
      [player.playerId, player.playerOrder]
    ))).toEqual([[retainedPlayerIds[0], 0], [retainedPlayerIds[1], 1]]);
    expect(internal.triviaVoiceCallBindings.get('CA-COMPACT-3')?.participantIndex).toBe(0);
    expect(internal.triviaVoiceCallBindings.get('CA-COMPACT-1')?.participantIndex).toBe(1);
    expect(runtime.stationVoiceCallEnded.mock.calls.map(call => call[0])).toEqual([
      'CA-COMPACT-0', 'CA-COMPACT-2',
    ]);

    const rerouted = await runtime.stationVoiceRoute(fixture.participants[0]!.from, 'CA-COMPACT-REASSIGNED');
    expect(rerouted).toMatchObject({ admitted: true, readyEntryId: 'ready-compact-0' });
    runtime.stationVoiceCallEnded('CA-COMPACT-0');
    expect(await runtime.stationVoiceRoute(fixture.participants[0]!.from, 'CA-COMPACT-REASSIGNED'))
      .toMatchObject({ admitted: true });

    originalSessions[3]!.handleClose();
    originalSessions[1]!.handleClose();
    const resumedThree = bind('CA-COMPACT-3', 'Player 3', 0, 2);
    const resumedOne = bind('CA-COMPACT-1', 'Player 1', 1, 2);
    expect([resumedThree.boundPlayerId, resumedOne.boundPlayerId]).toEqual(retainedPlayerIds);
    expect(runtime.trivia.findRoom(fixture.roomCode)!.state().players).toHaveLength(2);
  });

  it('preserves sparse Trivia binding indexes around a pending middle-seat replacement', async () => {
    const runtime = await harness();
    const internal = server as unknown as {
      makeTriviaSession(
        say: () => Promise<'played'>,
        stationFixed?: () => boolean,
      ): TriviaVoiceSession;
      triviaVoiceCallBindings: Map<string, { playerId: string; participantIndex: number | null }>;
    };
    const bind = (callSid: string, name: string, participantIndex: number) => {
      const session = internal.makeTriviaSession(async () => 'played' as const, () => true);
      session.setAuthoritativeName(name);
      session.setExpectedPlayers(4);
      session.setStationManaged(true);
      session.setStationAssignment(participantIndex);
      session.handleMessage(JSON.stringify({
        type: 'setup', callSid,
        customParameters: { roomCode: 'HTTP-SPARSE', game: 'trivia', commandLocale: 'en-US' },
      }));
      return session;
    };
    const sessions = [0, 1, 2, 3].map(index => bind(`CA-SPARSE-${index}`, `Player ${index}`, index));
    const playerIds = sessions.map(session => session.boundPlayerId!);

    runtime.participantReconcile!(
      'trivia', 'HTTP-SPARSE', 4,
      [playerIds[0]!, playerIds[2]!, playerIds[3]!],
      [playerIds[0]!, null, playerIds[2]!, playerIds[3]!],
    );
    expect(runtime.trivia.findRoom('HTTP-SPARSE')!.state().players.map(player => (
      [player.playerId, player.playerOrder]
    ))).toEqual([[playerIds[0], 0], [playerIds[2], 2], [playerIds[3], 3]]);
    expect(internal.triviaVoiceCallBindings.get('CA-SPARSE-0')?.participantIndex).toBe(0);
    expect(internal.triviaVoiceCallBindings.get('CA-SPARSE-2')?.participantIndex).toBe(2);
    expect(internal.triviaVoiceCallBindings.get('CA-SPARSE-3')?.participantIndex).toBe(3);

    sessions[2]!.handleClose();
    const resumed = bind('CA-SPARSE-2', 'Player 2', 2);
    expect(resumed.boundPlayerId).toBe(playerIds[2]);
    const replacement = bind('CA-SPARSE-REPLACEMENT', 'Replacement', 1);
    expect(replacement.boundPlayerId).not.toBeNull();
    const room = runtime.trivia.findRoom('HTTP-SPARSE')!;
    expect(room.state().players.map(player => player.playerOrder)).toEqual([0, 1, 2, 3]);
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
    for (const player of room.state().players) {
      expect(runtime.trivia.voiceVoteCategory('HTTP-SPARSE', player.playerId, 'science')).toBe(true);
    }
    await waitFor(() => room.phase === 'loading' ? true : undefined);
  });

  it('reindexes retained Trivia bindings from shrink slots while a new first seat is pending', async () => {
    const runtime = await harness();
    const internal = server as unknown as {
      makeTriviaSession(
        say: () => Promise<'played'>,
        stationFixed?: () => boolean,
      ): TriviaVoiceSession;
      triviaVoiceCallBindings: Map<string, { playerId: string; participantIndex: number | null }>;
    };
    const bind = (callSid: string, name: string, participantIndex: number, count: number) => {
      const session = internal.makeTriviaSession(async () => 'played' as const, () => true);
      session.setAuthoritativeName(name);
      session.setExpectedPlayers(count);
      session.setStationManaged(true);
      session.setStationAssignment(participantIndex);
      session.handleMessage(JSON.stringify({
        type: 'setup', callSid,
        customParameters: { roomCode: 'HTTP-SHRINK-PENDING', game: 'trivia', commandLocale: 'en-US' },
      }));
      return session;
    };
    const sessions = [0, 1, 2, 3].map(index => bind(`CA-SHRINK-${index}`, `Player ${index}`, index, 4));
    const playerIds = sessions.map(session => session.boundPlayerId!);
    const retainedIds = [playerIds[2]!, playerIds[3]!];

    runtime.participantReconcile!(
      'trivia', 'HTTP-SHRINK-PENDING', 3,
      retainedIds, [null, retainedIds[0]!, retainedIds[1]!],
    );
    expect(runtime.trivia.findRoom('HTTP-SHRINK-PENDING')!.state().players.map(player => (
      [player.playerId, player.playerOrder]
    ))).toEqual([[retainedIds[0], 1], [retainedIds[1], 2]]);
    expect(internal.triviaVoiceCallBindings.get('CA-SHRINK-2')?.participantIndex).toBe(1);
    expect(internal.triviaVoiceCallBindings.get('CA-SHRINK-3')?.participantIndex).toBe(2);

    sessions[3]!.handleClose();
    const resumed = bind('CA-SHRINK-3', 'Player 3', 2, 3);
    expect(resumed.boundPlayerId).toBe(retainedIds[1]);
    const pending = bind('CA-SHRINK-PENDING', 'Pending', 0, 3);
    expect(pending.boundPlayerId).not.toBeNull();
    const room = runtime.trivia.findRoom('HTTP-SHRINK-PENDING')!;
    expect(room.state().players.map(player => player.playerOrder)).toEqual([0, 1, 2]);
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
    for (const player of room.state().players) {
      expect(runtime.trivia.voiceVoteCategory(room.code, player.playerId, 'science')).toBe(true);
    }
    await waitFor(() => room.phase === 'loading' ? true : undefined);
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    expect(room.phase).toBe('countdown');
  });

  it('physically purges a disconnected Trivia caller when the Relay session ends', async () => {
    const runtime = await harness();
    const internal = server as unknown as {
      makeTriviaSession(say: (text: string) => Promise<'played'>): TriviaVoiceSession;
    };
    const session = internal.makeTriviaSession(async () => 'played' as const);
    session.setAuthoritativeName('Ada');
    session.handleMessage(JSON.stringify({
      type: 'setup', callSid: 'CA-PERMANENT-END',
      customParameters: { roomCode: 'PERMANENT-END', game: 'trivia', commandLocale: 'en-US' },
    }));
    const playerId = session.boundPlayerId!;
    session.handleClose();
    expect(runtime.trivia.findRoom('PERMANENT-END')!.state().players).toEqual([
      expect.objectContaining({ playerId, connected: false }),
    ]);

    const ended = await fetch(`${runtime.base}/voice/session-ended`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        CallSid: 'CA-PERMANENT-END', CallStatus: 'completed', SessionStatus: 'completed',
      }),
    });
    expect(ended.status).toBe(200);
    expect(runtime.trivia.findRoom('PERMANENT-END')).toBeUndefined();
  });

  it('preserves a completed one-player station result during terminal call cleanup', async () => {
    const now = { value: 0 };
    const runtime = await harness({ now });
    const internal = server as unknown as {
      makeTriviaSession(
        say: () => Promise<'played'>,
        stationFixed?: () => boolean,
      ): TriviaVoiceSession;
      triviaVoiceCallBindings: Map<string, unknown>;
    };
    const session = internal.makeTriviaSession(async () => 'played' as const, () => true);
    session.setAuthoritativeName('Ada');
    session.setExpectedPlayers(1);
    session.setStationManaged(true);
    session.setStationAssignment(0);
    session.handleMessage(JSON.stringify({
      type: 'setup', callSid: 'CA-STATION-TERMINAL',
      customParameters: { roomCode: 'STATION-TERMINAL', game: 'trivia', commandLocale: 'en-US' },
    }));
    const playerId = session.boundPlayerId!;
    runtime.trivia.voiceVoteCategory('STATION-TERMINAL', playerId, 'science');
    runtime.trivia.voiceAdvance('STATION-TERMINAL', playerId);
    const room = runtime.trivia.findRoom('STATION-TERMINAL')!;
    room.ready(room.state().loadingGeneration);
    now.value = room.state().countdownEndsAtMs!;
    room.tick();
    for (let questionIndex = 0; questionIndex < 8; questionIndex++) {
      settleRoomQuestionAudio(room, [playerId]);
      const question = room.state().question!;
      now.value = room.state().answeringStartsAtMs!;
      runtime.trivia.voiceAnswer('STATION-TERMINAL', playerId, correctChoiceId(question.id));
      await session.whenSpeechSettled();
      now.value = room.state().revealEndsAtMs!;
      room.tick();
    }
    const completed = room.state();
    expect(completed).toMatchObject({ phase: 'results', expectedPlayerCount: 1 });

    const ended = await fetch(`${runtime.base}/voice/session-ended`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        CallSid: 'CA-STATION-TERMINAL', CallStatus: 'completed', SessionStatus: 'completed',
      }),
    });
    expect(ended.status).toBe(200);
    expect(internal.triviaVoiceCallBindings.size).toBe(0);
    expect(runtime.trivia.findRoom('STATION-TERMINAL')!.state()).toMatchObject({
      phase: 'results',
      expectedPlayerCount: 1,
      result: completed.result,
      players: [expect.objectContaining({ playerId, name: 'Ada', connected: false })],
    });
    expect(runtime.trivia.voiceSnapshot('STATION-TERMINAL', playerId)).toMatchObject({
      phase: 'results', result: completed.result,
      myPromptReady: false, myAnswerCueReady: false, myQuestionPoints: 0,
    });
    const terminalSnapshot = JSON.stringify(runtime.trivia.findRoom('STATION-TERMINAL')!.state());
    const duplicate = await fetch(`${runtime.base}/voice/session-ended`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        CallSid: 'CA-STATION-TERMINAL', CallStatus: 'completed', SessionStatus: 'completed',
      }),
    });
    expect(duplicate.status).toBe(200);
    expect(JSON.stringify(runtime.trivia.findRoom('STATION-TERMINAL')!.state())).toBe(terminalSnapshot);
  });

  it('finishes a Portuguese station result before retirement without a tokensPlayed receipt', async () => {
    const now = { value: 0 };
    const runtime = await harness({ now });
    const internal = server as unknown as {
      makeTriviaSession(
        say: (text: string) => Promise<'played' | 'estimated'>,
        stationFixed?: () => boolean,
      ): TriviaVoiceSession;
      retireStationEngine(game: 'trivia', roomCode: string): void;
    };
    let resultLine = '';
    let estimatedResultMs = 0;
    let resultSettled = false;
    const session = internal.makeTriviaSession(text => {
      if (!/Ana venceu\. Sua pontuação no ranking: [\d,.]+;/.test(text)) return Promise.resolve('played');
      resultLine = text;
      // Model Relay's conservative fallback when Twilio sends no tokensPlayed receipt.
      estimatedResultMs = Math.min(120_000, Math.max(1_200,
        Math.ceil(text.length / 9 * 1_000) + (text.match(/[.!?;:]/g)?.length ?? 0) * 180 + 1_500));
      return new Promise(resolve => setTimeout(() => {
        resultSettled = true;
        resolve('estimated');
      }, estimatedResultMs));
    }, () => true);
    session.setAuthoritativeName('Ana');
    session.setExpectedPlayers(1);
    session.setStationManaged(true);
    session.setStationAssignment(0);
    session.handleMessage(JSON.stringify({
      type: 'setup', callSid: 'CA-STATION-PT-NO-RECEIPT',
      customParameters: { roomCode: 'STATION-PT-NO-RECEIPT', game: 'trivia', commandLocale: 'pt-BR' },
    }));
    const code = 'STATION-PT-NO-RECEIPT';
    const playerId = session.boundPlayerId!;
    runtime.trivia.voiceVoteCategory(code, playerId, 'science');
    runtime.trivia.voiceAdvance(code, playerId);
    const room = runtime.trivia.findRoom(code)!;
    room.ready(room.state().loadingGeneration);
    now.value = room.state().countdownEndsAtMs!;
    room.tick();
    for (let questionIndex = 0; questionIndex < 8; questionIndex++) {
      settleRoomQuestionAudio(room, [playerId]);
      const question = room.state().question!;
      now.value = room.state().answeringStartsAtMs!;
      runtime.trivia.voiceAnswer(code, playerId, correctChoiceId(question.id));
      await session.whenSpeechSettled();
      if (questionIndex < 7) {
        now.value = room.state().revealEndsAtMs!;
        room.tick();
      }
    }

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      now.value = room.state().revealEndsAtMs!;
      room.tick();
      session.onStateChanged();
      expect(room.phase).toBe('results');
      expect(resultLine).toMatch(/Ana venceu.*pontuação no ranking.*acertos.*Twilio Conversation Relay.*tela.*Moedas no SMS.*Jogue de novo/i);
      expect(estimatedResultMs).toBeLessThan(20_000);
      await vi.advanceTimersByTimeAsync(10_000); // the station's result-display hold
      expect(resultSettled).toBe(false);
      internal.retireStationEngine('trivia', code);
      expect(runtime.trivia.findRoom(code)).toBeDefined();
      await vi.advanceTimersByTimeAsync(9_999); // before the Relay settle cap
      expect(resultSettled).toBe(true);
      expect(runtime.trivia.findRoom(code)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the central Trivia clock after required question playback and before choice playback', async () => {
    const now = { value: 0 };
    const runtime = await harness({ now });
    const display = await connect(runtime.port, '/trivia?display=1');
    display.ws.send(JSON.stringify({ type: 'display_auth', roomCode: 'CUE-WIRING', token: DISPLAY_TOKEN }));
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'CUE-WIRING' }));
    await waitFor(() => display.messages.find(message => message.type === 'host_identity' && message.isHost));
    const internal = server as unknown as {
      makeTriviaSession(say: (text: string) => Promise<'played'>): TriviaVoiceSession;
    };
    const promptReady = vi.spyOn(runtime.trivia, 'voiceQuestionPromptReady');
    const cueReady = vi.spyOn(runtime.trivia, 'voiceQuestionAnswerCueReady');
    const spoken: string[] = [];
    let finishPrompt!: (outcome: 'played') => void;
    const pendingPrompt = new Promise<'played'>(resolve => { finishPrompt = resolve; });
    const session = internal.makeTriviaSession(text => {
      spoken.push(text);
      return /^Question 1\b/.test(text) ? pendingPrompt : Promise.resolve('played');
    });
    session.setAuthoritativeName('Ada');
    session.handleMessage(JSON.stringify({
      type: 'setup', callSid: 'CA-CUE-WIRING', customParameters: { roomCode: 'CUE-WIRING', game: 'trivia' },
    }));
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    const room = runtime.trivia.findRoom('CUE-WIRING')!;
    expect(room.phase).toBe('loading');
    room.ready(room.state().loadingGeneration);
    now.value = room.state().countdownEndsAtMs!;
    room.tick();
    session.onStateChanged();
    expect(spoken.some(text => /^Question 1\b/.test(text))).toBe(false);
    await paintTriviaView(display, runtime.trivia, room, 'question_prompt', session.boundPlayerId!);
    await waitFor(() => spoken.some(text => /^Question 1\b/.test(text)) ? true : undefined);
    expect(promptReady).not.toHaveBeenCalled();
    expect(cueReady).not.toHaveBeenCalled();
    expect(room.phase).toBe('question_prompt');
    expect(room.state().answeringStartsAtMs).toBeNull();

    finishPrompt('played');
    await waitFor(() => room.phase === 'answer_cue' ? true : undefined);
    expect(cueReady).not.toHaveBeenCalled();
    expect(room.state().answeringStartsAtMs).toBe(now.value);
    await paintTriviaView(display, runtime.trivia, room, 'answer_cue', session.boundPlayerId!);
    await session.whenSpeechSettled();
    expect(promptReady).toHaveBeenCalledOnce();
    expect(cueReady).toHaveBeenCalledOnce();
    expect(room.phase).toBe('question');
    expect(room.state().answeringStartsAtMs).toBe(now.value);
    expect(spoken.join(' ')).toMatch(/Question 1.*choices are One, .*Two, .*Three, .*Four,/i);
  });

  it.each(['interim', 'semantic', 'speech'] as const)(
    'keeps a voted caller on the category menu during their %s follow-up', async stage => {
    const runtime = await harness();
    const code = `CATEGORY-${stage.toUpperCase()}`;
    runtime.trivia.getOrCreateRoom(code);
    expect(runtime.trivia.voiceConfigureStandaloneSeats(code, 2)).toBe(true);
    const internal = server as unknown as {
      llm: LlmClient;
      makeTriviaSession(
        say: (text: string, isCurrent?: () => boolean) => Promise<'played'>,
      ): TriviaVoiceSession;
    };
    let finishIntent: ((reply: LlmReply) => void) | undefined;
    if (stage === 'semantic') internal.llm = {
      enabled: true,
      respond: () => new Promise(resolve => { finishIntent = resolve; }),
    };
    let holdFollowUp = false;
    let answerGuard: (() => boolean) | undefined;
    let finishAnswer!: (outcome: 'played') => void;
    let finishGraceVote!: (outcome: 'played') => void;
    const ada = internal.makeTriviaSession((text, isCurrent) => {
      if (holdFollowUp && (text.startsWith('Choose a category:')
        || text.startsWith('Science is a trivia category'))) {
        answerGuard = isCurrent;
        return new Promise(resolve => { finishAnswer = resolve; });
      }
      return Promise.resolve('played');
    });
    const grace = internal.makeTriviaSession(text => text === 'Science selected.'
      ? new Promise(resolve => { finishGraceVote = resolve; })
      : Promise.resolve('played'));
    for (const [session, name] of [[ada, 'Ada'], [grace, 'Grace']] as const) {
      session.setAuthoritativeName(name);
      session.handleMessage(JSON.stringify({ type: 'setup', callSid: `CA-${name.toUpperCase()}-CATEGORY`,
        customParameters: { roomCode: code, game: 'trivia', commandLocale: 'en-US' } }));
    }
    const room = runtime.trivia.findRoom(code)!;
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
    await Promise.all([ada.whenSpeechSettled(), grace.whenSpeechSettled()]);
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    await ada.whenSpeechSettled();
    grace.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    expect(room.state().players.find(player => player.playerId === grace.boundPlayerId)?.setupStatus).toBe('phone');

    holdFollowUp = true;
    if (stage === 'interim') {
      ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'What does Science', last: false }));
      finishGraceVote('played');
      await waitFor(() => room.state().players.find(player => player.playerId === grace.boundPlayerId)
        ?.setupStatus === 'ready' ? true : undefined);
      expect(room.phase).toBe('category_select');
      expect(room.state().players.find(player => player.playerId === ada.boundPlayerId)?.setupStatus).toBe('phone');
    }
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'What does Science cover?', last: true }));
    if (stage === 'semantic') {
      await waitFor(() => finishIntent ? true : undefined);
      finishGraceVote('played');
      await waitFor(() => room.state().players.find(player => player.playerId === grace.boundPlayerId)
        ?.setupStatus === 'ready' ? true : undefined);
      expect(room.phase).toBe('category_select');
      finishIntent!({ say: '', toolCalls: [{ name: 'resolve_voice_turn',
        args: { kind: 'answer', factId: 'category:science' } }] });
    }
    await waitFor(() => answerGuard ? true : undefined);
    expect(room.phase).toBe('category_select');
    if (stage === 'speech') {
      finishGraceVote('played');
      await waitFor(() => room.state().players.find(player => player.playerId === grace.boundPlayerId)
        ?.setupStatus === 'ready' ? true : undefined);
    }
    expect(room.phase).toBe('category_select');
    expect(answerGuard?.()).toBe(true);

    finishAnswer('played');
    await waitFor(() => room.phase === 'loading' ? true : undefined);
  });

  it('transfers a category caller from an AI turn to a DTMF revision before loading', async () => {
    const runtime = await harness();
    const code = 'CATEGORY-DTMF-REVISION';
    runtime.trivia.getOrCreateRoom(code);
    expect(runtime.trivia.voiceConfigureStandaloneSeats(code, 2)).toBe(true);
    const internal = server as unknown as {
      llm: LlmClient;
      makeTriviaSession(say: (text: string) => Promise<'played'>): TriviaVoiceSession;
    };
    let intentStarted = false;
    internal.llm = { enabled: true, respond: (_system, _history, _tools, options) => new Promise(resolve => {
      intentStarted = true;
      options?.signal?.addEventListener('abort', () => resolve({ say: '', toolCalls: [] }), { once: true });
    }) };
    let finishRevision!: (outcome: 'played') => void;
    const ada = internal.makeTriviaSession(text => text === 'History selected.'
      ? new Promise(resolve => { finishRevision = resolve; })
      : Promise.resolve('played'));
    const grace = internal.makeTriviaSession(async () => 'played');
    for (const [session, name] of [[ada, 'Ada'], [grace, 'Grace']] as const) {
      session.setAuthoritativeName(name);
      session.handleMessage(JSON.stringify({ type: 'setup', callSid: `CA-${name.toUpperCase()}-DTMF`,
        customParameters: { roomCode: code, game: 'trivia', commandLocale: 'en-US' } }));
    }
    const room = runtime.trivia.findRoom(code)!;
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
    await Promise.all([ada.whenSpeechSettled(), grace.whenSpeechSettled()]);
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    await ada.whenSpeechSettled();
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'What does Science cover?', last: true }));
    await waitFor(() => intentStarted ? true : undefined);
    grace.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    await grace.whenSpeechSettled();
    expect(room.phase).toBe('category_select');

    ada.handleMessage(JSON.stringify({ type: 'dtmf', digit: '4' }));
    expect(room.phase).toBe('category_select');
    expect(room.categoryVoteFor(ada.boundPlayerId!)).toBe('history');
    expect(room.state().players.find(player => player.playerId === ada.boundPlayerId)?.setupStatus).toBe('phone');
    finishRevision('played');
    await waitFor(() => room.phase === 'loading' ? true : undefined);
  });

  it('repeats a category confirmation after an unsupported phone digit', async () => {
    const runtime = await harness();
    const code = 'CATEGORY-BAD-DTMF';
    runtime.trivia.getOrCreateRoom(code);
    runtime.trivia.voiceConfigureStandaloneSeats(code, 2);
    const internal = server as unknown as {
      makeTriviaSession(say: (text: string) => Promise<'played'>): TriviaVoiceSession;
    };
    let confirmationCount = 0;
    let finishFirstConfirmation!: (outcome: 'played') => void;
    const ada = internal.makeTriviaSession(text => {
      if (text === 'Science selected.' && ++confirmationCount === 1) {
        return new Promise(resolve => { finishFirstConfirmation = resolve; });
      }
      return Promise.resolve('played');
    });
    const grace = internal.makeTriviaSession(async () => 'played');
    for (const [session, name] of [[ada, 'Ada'], [grace, 'Grace']] as const) {
      session.setAuthoritativeName(name);
      session.handleMessage(JSON.stringify({ type: 'setup', callSid: `CA-${name.toUpperCase()}-BAD-DTMF`,
        customParameters: { roomCode: code, game: 'trivia', commandLocale: 'en-US' } }));
    }
    const room = runtime.trivia.findRoom(code)!;
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
    await Promise.all([ada.whenSpeechSettled(), grace.whenSpeechSettled()]);
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    grace.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    await grace.whenSpeechSettled();
    expect(room.phase).toBe('category_select');
    expect(confirmationCount).toBe(1);

    ada.handleMessage(JSON.stringify({ type: 'dtmf', digit: '0' }));
    await waitFor(() => confirmationCount === 2 ? true : undefined);
    await waitFor(() => room.phase === 'loading' ? true : undefined);
    finishFirstConfirmation('played');
  });

  it('repeats a result recap after an unsupported phone digit', async () => {
    const now = { value: 0 };
    const runtime = await harness({ now, manualTriviaClock: true });
    const code = 'RESULT-BAD-DTMF';
    runtime.trivia.getOrCreateRoom(code);
    runtime.trivia.voiceConfigureStandaloneSeats(code, 2);
    const internal = server as unknown as {
      makeTriviaSession(say: (text: string) => Promise<'played'>): TriviaVoiceSession;
    };
    let recapCount = 0;
    let finishFirstRecap!: (outcome: 'played') => void;
    const ada = internal.makeTriviaSession(text => {
      if (/wins with a leaderboard score/i.test(text) && ++recapCount === 1) {
        return new Promise(resolve => { finishFirstRecap = resolve; });
      }
      return Promise.resolve('played');
    });
    const grace = internal.makeTriviaSession(async () => 'played');
    for (const [session, name] of [[ada, 'Ada'], [grace, 'Grace']] as const) {
      session.setAuthoritativeName(name);
      session.handleMessage(JSON.stringify({ type: 'setup', callSid: `CA-${name.toUpperCase()}-RESULT-DTMF`,
        customParameters: { roomCode: code, game: 'trivia', commandLocale: 'en-US' } }));
    }
    const room = runtime.trivia.findRoom(code)!;
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
    await Promise.all([ada.whenSpeechSettled(), grace.whenSpeechSettled()]);
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    grace.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    await waitFor(() => room.phase === 'loading' ? true : undefined);
    room.ready(room.state().loadingGeneration);
    now.value = room.state().countdownEndsAtMs!;
    room.tick();
    for (let index = 0; index < 8; index++) {
      settleRoomQuestionAudio(room, [ada.boundPlayerId!, grace.boundPlayerId!]);
      now.value = room.state().answeringStartsAtMs!;
      room.answer(ada.boundPlayerId!, correctChoiceId(room.state().question!.id));
      room.answer(grace.boundPlayerId!, correctChoiceId(room.state().question!.id));
      now.value = room.state().revealEndsAtMs!;
      room.tick();
    }
    expect(room.phase).toBe('results');
    ada.onStateChanged();
    grace.onStateChanged();
    await waitFor(() => recapCount === 1 ? true : undefined);
    ada.handleMessage(JSON.stringify({ type: 'dtmf', digit: '0' }));
    await waitFor(() => recapCount === 2 ? true : undefined);
    await ada.whenSpeechSettled();
    expect(room.phase).toBe('results');
    expect(room.state().players.find(player => player.playerId === ada.boundPlayerId)?.setupStatus).toBe('replay');
    finishFirstRecap('played');
  });

  it('holds the shared lobby while a caller speaks and hears a gameplay answer', async () => {
    const runtime = await harness();
    const code = 'LOBBY-CONVERSATION';
    runtime.trivia.getOrCreateRoom(code);
    expect(runtime.trivia.voiceConfigureStandaloneSeats(code, 2)).toBe(true);
    const internal = server as unknown as {
      llm: LlmClient;
      makeTriviaSession(
        say: (text: string, isCurrent?: () => boolean) => Promise<'played'>,
      ): TriviaVoiceSession;
    };
    internal.llm = { enabled: true, respond: async () => ({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'answer', factId: 'gameplay' } },
    ] }) };
    let holdFollowUp = false;
    let answerGuard: (() => boolean) | undefined;
    let finishAnswer!: (outcome: 'played') => void;
    let finishGraceIntro!: (outcome: 'played') => void;
    const ada = internal.makeTriviaSession((text, isCurrent) => {
      if (holdFollowUp && text.startsWith('I will ask each question')) {
        answerGuard = isCurrent;
        return new Promise(resolve => { finishAnswer = resolve; });
      }
      return Promise.resolve('played');
    });
    const grace = internal.makeTriviaSession(text => text.startsWith('I will ask each question')
      ? new Promise(resolve => { finishGraceIntro = resolve; })
      : Promise.resolve('played'));
    for (const [session, name] of [[ada, 'Ada'], [grace, 'Grace']] as const) {
      session.setAuthoritativeName(name);
      session.handleMessage(JSON.stringify({ type: 'setup', callSid: `CA-${name.toUpperCase()}-LOBBY`,
        customParameters: { roomCode: code, game: 'trivia', commandLocale: 'en-US' } }));
    }
    const room = runtime.trivia.findRoom(code)!;
    await ada.whenSpeechSettled();
    expect(room.phase).toBe('lobby');
    expect(room.state().players.find(player => player.playerId === grace.boundPlayerId)?.setupStatus).toBe('phone');

    holdFollowUp = true;
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'How does this', last: false }));
    finishGraceIntro('played');
    await grace.whenSpeechSettled();
    expect(room.phase).toBe('lobby');
    expect(room.state().players.find(player => player.playerId === ada.boundPlayerId)?.setupStatus).toBe('phone');

    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'How does this game work?', last: true }));
    await waitFor(() => answerGuard ? true : undefined);
    expect(answerGuard?.()).toBe(true);
    expect(room.phase).toBe('lobby');
    finishAnswer('played');
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
  });

  it.each(['settles', 'disconnects'] as const)(
    'saves a peer replay vote while another caller hears a standings answer and %s', async end => {
    const now = { value: 0 };
    const runtime = await harness({ now, manualTriviaClock: true });
    const code = 'RESULT-CONVERSATION';
    runtime.trivia.getOrCreateRoom(code);
    expect(runtime.trivia.voiceConfigureStandaloneSeats(code, 2)).toBe(true);
    const internal = server as unknown as {
      llm: LlmClient;
      makeTriviaSession(
        say: (text: string, isCurrent?: () => boolean) => Promise<'played'>,
      ): TriviaVoiceSession;
    };
    internal.llm = { enabled: true, respond: async () => ({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'answer', factId: 'standings' } },
    ] }) };
    let answerGuard: (() => boolean) | undefined;
    let finishStandings!: (outcome: 'played') => void;
    const ada = internal.makeTriviaSession((text, isCurrent) => {
      if (text.includes('Ada:') && text.includes('Grace:')) {
        answerGuard = isCurrent;
        return new Promise(resolve => { finishStandings = resolve; });
      }
      return Promise.resolve('played');
    });
    const grace = internal.makeTriviaSession(async () => 'played');
    for (const [session, name] of [[ada, 'Ada'], [grace, 'Grace']] as const) {
      session.setAuthoritativeName(name);
      session.handleMessage(JSON.stringify({ type: 'setup', callSid: `CA-${name.toUpperCase()}-RESULT`,
        customParameters: { roomCode: code, game: 'trivia', commandLocale: 'en-US' } }));
    }
    const room = runtime.trivia.findRoom(code)!;
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
    await Promise.all([ada.whenSpeechSettled(), grace.whenSpeechSettled()]);
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    grace.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    await waitFor(() => room.phase === 'loading' ? true : undefined);
    room.ready(room.state().loadingGeneration);
    now.value = room.state().countdownEndsAtMs!;
    room.tick();
    for (let index = 0; index < 8; index++) {
      settleRoomQuestionAudio(room, [ada.boundPlayerId!, grace.boundPlayerId!]);
      now.value = room.state().answeringStartsAtMs!;
      room.answer(ada.boundPlayerId!, correctChoiceId(room.state().question!.id));
      room.answer(grace.boundPlayerId!, correctChoiceId(room.state().question!.id));
      now.value = room.state().revealEndsAtMs!;
      room.tick();
    }
    expect(room.phase).toBe('results');
    ada.onStateChanged();
    grace.onStateChanged();
    await Promise.all([ada.whenSpeechSettled(), grace.whenSpeechSettled()]);
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'play again', last: true }));
    await ada.whenSpeechSettled();
    expect(room.state().players.find(player => player.playerId === ada.boundPlayerId)?.replayReady).toBe(true);

    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'What were the standings?', last: true }));
    await waitFor(() => answerGuard ? true : undefined);
    grace.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'play again', last: true }));
    await grace.whenSpeechSettled();
    expect(room.phase).toBe('results');
    expect(room.state().players.find(player => player.playerId === grace.boundPlayerId)?.replayReady).toBe(true);
    expect(answerGuard?.()).toBe(true);
    if (end === 'disconnects') {
      const adaId = ada.boundPlayerId;
      ada.handleClose();
      expect(room.phase).toBe('results');
      expect(room.state().players.find(player => player.playerId === adaId)?.setupStatus)
        .toBe('reconnecting');
      finishStandings('played');
      return;
    }
    finishStandings('played');
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
  });

  it('replays a pending category confirmation on a replacement phone transport', async () => {
    const runtime = await harness();
    const code = 'CATEGORY-REPLACED';
    runtime.trivia.getOrCreateRoom(code);
    runtime.trivia.voiceConfigureStandaloneSeats(code, 2);
    const internal = server as unknown as {
      makeTriviaSession(say: (text: string) => Promise<'played'>): TriviaVoiceSession;
    };
    let finishOldConfirmation!: (outcome: 'played') => void;
    const first = internal.makeTriviaSession(text => text === 'Science selected.'
      ? new Promise(resolve => { finishOldConfirmation = resolve; })
      : Promise.resolve('played'));
    const grace = internal.makeTriviaSession(async () => 'played');
    for (const [session, name] of [[first, 'Ada'], [grace, 'Grace']] as const) {
      session.setAuthoritativeName(name);
      session.handleMessage(JSON.stringify({ type: 'setup', callSid: `CA-${name.toUpperCase()}-REPLACED`,
        customParameters: { roomCode: code, game: 'trivia', commandLocale: 'en-US' } }));
    }
    const room = runtime.trivia.findRoom(code)!;
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
    await Promise.all([first.whenSpeechSettled(), grace.whenSpeechSettled()]);
    first.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    grace.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    await grace.whenSpeechSettled();
    expect(room.phase).toBe('category_select');
    expect(room.state().players.find(player => player.playerId === first.boundPlayerId)?.setupStatus).toBe('phone');

    const replacementSpeech: string[] = [];
    const replacement = internal.makeTriviaSession(async text => {
      replacementSpeech.push(text);
      return 'played';
    });
    replacement.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-ADA-REPLACED',
      customParameters: { roomCode: code, game: 'trivia', commandLocale: 'en-US' } }));
    await replacement.whenSpeechSettled();
    expect(replacement.boundPlayerId).toBe(first.boundPlayerId ?? room.state().players[0]?.playerId);
    expect(replacementSpeech).toContain('Science selected.');
    expect(room.phase).toBe('loading');
    finishOldConfirmation('played');
  });

  it('releases an interrupted category reply before the next caller finishes voting', async () => {
    const runtime = await harness();
    const code = 'CATEGORY-INTERRUPTED';
    runtime.trivia.getOrCreateRoom(code);
    runtime.trivia.voiceConfigureStandaloneSeats(code, 2);
    const internal = server as unknown as {
      makeTriviaSession(say: (text: string, isCurrent?: () => boolean) => Promise<'played' | 'interrupted'>): TriviaVoiceSession;
    };
    let answerCount = 0;
    let finishOldReply!: (outcome: 'played' | 'interrupted') => void;
    let oldGuard: (() => boolean) | undefined;
    let finishGraceVote!: (outcome: 'played' | 'interrupted') => void;
    const ada = internal.makeTriviaSession((text, isCurrent) => {
      if (text.startsWith('Choose a category:') && ++answerCount > 1) {
        if (answerCount === 2) {
          oldGuard = isCurrent;
          return new Promise(resolve => { finishOldReply = resolve; });
        }
      }
      return Promise.resolve('played');
    });
    const grace = internal.makeTriviaSession(text => text === 'Science selected.'
      ? new Promise(resolve => { finishGraceVote = resolve; })
      : Promise.resolve('played'));
    for (const [session, name] of [[ada, 'Ada'], [grace, 'Grace']] as const) {
      session.setAuthoritativeName(name);
      session.handleMessage(JSON.stringify({ type: 'setup', callSid: `CA-${name.toUpperCase()}-INTERRUPTED`,
        customParameters: { roomCode: code, game: 'trivia', commandLocale: 'en-US' } }));
    }
    const room = runtime.trivia.findRoom(code)!;
    await waitFor(() => room.phase === 'category_select' ? true : undefined);
    await Promise.all([ada.whenSpeechSettled(), grace.whenSpeechSettled()]);
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    await ada.whenSpeechSettled();
    grace.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'What does Science cover?', last: true }));
    await waitFor(() => oldGuard ? true : undefined);
    ada.handleMessage(JSON.stringify({ type: 'interrupt' }));
    expect(oldGuard?.()).toBe(false);
    ada.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'What does Science cover?', last: true }));
    await ada.whenSpeechSettled();
    finishGraceVote('played');
    await grace.whenSpeechSettled();
    expect(room.phase).toBe('loading');
    finishOldReply('interrupted');
  });

  it('protects ETag content replacement and keeps an active room on its creation-time bank', async () => {
    const now = { value: 10_000 };
    const runtime = await harness({ editorToken: 'editor-secret', now });
    expect((await fetch(`${runtime.base}/api/trivia-questions`)).status).toBe(401);
    const authorized = await fetch(`${runtime.base}/api/trivia-questions`, {
      headers: { 'x-editor-token': 'editor-secret' },
    });
    const etag = authorized.headers.get('etag')!;
    const bank = parseTriviaQuestionBankJson(await authorized.text());
    expect(etag).toMatch(/^"trivia-questions-/);
    expect((await fetch(`${runtime.base}/api/trivia-questions`, {
      method: 'POST',
      headers: { 'x-editor-token': 'editor-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(bank),
    })).status).toBe(428);

    const oldPlayer = runtime.trivia.voiceJoin('OLD-BANK', 'Ada')!;
    const beforeInvalid = await readFile(path.join(directory!, 'trivia-questions.json'), 'utf8');
    expect((await fetch(`${runtime.base}/api/trivia-questions`, {
      method: 'POST',
      headers: { 'x-editor-token': 'editor-secret', 'Content-Type': 'application/json', 'If-Match': etag },
      body: '{"version":1,"questions":[]}',
    })).status).toBe(400);
    expect(await readFile(path.join(directory!, 'trivia-questions.json'), 'utf8')).toBe(beforeInvalid);

    const idSwap = mutableBank(bank);
    [idSwap.questions[0]!.id, idSwap.questions[1]!.id] = [
      idSwap.questions[1]!.id,
      idSwap.questions[0]!.id,
    ];
    const provenanceChange = mutableBank(bank);
    provenanceChange.questions[0]!.review.provenance = 'human-authored';
    for (const attack of [idSwap, provenanceChange]) {
      const rejected = await fetch(`${runtime.base}/api/trivia-questions`, {
        method: 'POST',
        headers: { 'x-editor-token': 'editor-secret', 'Content-Type': 'application/json', 'If-Match': etag },
        body: JSON.stringify(attack),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toBe('Trivia question IDs and provenance are immutable');
      expect(await readFile(path.join(directory!, 'trivia-questions.json'), 'utf8')).toBe(beforeInvalid);
      expect((await fetch(`${runtime.base}/api/trivia-questions`, {
        headers: { 'x-editor-token': 'editor-secret', 'If-None-Match': etag },
      })).status).toBe(304);
    }

    const replacement = changedBank(bank);
    const saved = await fetch(`${runtime.base}/api/trivia-questions`, {
      method: 'POST',
      headers: { 'x-editor-token': 'editor-secret', 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify(replacement),
    });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('etag')).not.toBe(etag);
    expect((await fetch(`${runtime.base}/api/trivia-questions`, {
      method: 'POST',
      headers: { 'x-editor-token': 'editor-secret', 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify(replacement),
    })).status).toBe(412);

    const newPlayer = runtime.trivia.voiceJoin('NEW-BANK', 'Grace')!;
    for (const [code, playerId] of [['OLD-BANK', oldPlayer], ['NEW-BANK', newPlayer]] as const) {
      runtime.trivia.voiceAdvance(code, playerId);
      runtime.trivia.voiceVoteCategory(code, playerId, 'science');
      runtime.trivia.voiceAdvance(code, playerId);
      const room = runtime.trivia.findRoom(code)!;
      room.ready(room.state().loadingGeneration);
      now.value = room.state().countdownEndsAtMs!;
      room.tick();
    }
    expect(runtime.trivia.findRoom('OLD-BANK')!.state().question!.prompt.startsWith('UPDATED ')).toBe(false);
    expect(runtime.trivia.findRoom('NEW-BANK')!.state().question!.prompt.startsWith('UPDATED ')).toBe(true);
  });

  it('records only accepted Trivia commands, reports health, and cleanly stops live sockets', async () => {
    const runtime = await harness();
    const internal = server as unknown as {
      analyticsObserver: AnalyticsObserver;
      makeTriviaSession(say: () => Promise<'played'>): TriviaVoiceSession;
      abortStationEngine(game: 'trivia', roomCode: string): void;
    };
    const command = vi.spyOn(internal.analyticsObserver, 'voiceCommand');
    const state = vi.spyOn(internal.analyticsObserver, 'triviaState');
    const aborted = vi.spyOn(internal.analyticsObserver, 'triviaAborted');
    const session = internal.makeTriviaSession(async () => 'played' as const);
    session.handleMessage(JSON.stringify({
      type: 'setup', callSid: 'CA-ANALYTICS', customParameters: { roomCode: 'ANALYTICS', game: 'trivia' },
    }));
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'help', last: true }));
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'Ada', last: true }));
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'not a category', last: true }));
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'science', last: true }));
    expect(command.mock.calls).toEqual([['trivia'], ['trivia']]);
    expect(state).toHaveBeenCalled();
    internal.abortStationEngine('trivia', 'ANALYTICS');
    expect(aborted).toHaveBeenCalledWith('ANALYTICS');

    const health = await (await fetch(`${runtime.base}/healthz`)).json() as Record<string, any>;
    expect(health).toMatchObject({
      status: 'ok', triviaRooms: 0,
      triviaContent: { state: 'ready', questionCount: 200 },
      triviaLeaderboard: { state: 'ready' },
    });
    const display = await connect(runtime.port, '/trivia?display=1');
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: DEFAULT_ROOM }));
    await waitFor(() => display.messages.find(message => message.type === 'trivia_state'));
    const standalone = await fetch(`${runtime.base}/voice/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'CallSid=CA-TRIVIA-STANDALONE&From=%2B14155550199',
    });
    expect(await standalone.text()).toContain('<Parameter name="game" value="trivia"');
    await server!.stop();
    server = undefined;
    await waitFor(() => display.ws.readyState === WebSocket.CLOSED ? true : undefined);
  });
});

function changedBank(bank: TriviaQuestionBank): TriviaQuestionBank {
  const changed = mutableBank(bank);
  for (const question of changed.questions) {
    question.locales['en-US'].prompt = `UPDATED ${question.locales['en-US'].prompt.slice(0, 230)}`;
    question.source.accessed = '2026-08-30';
    question.review.reviewedBy = 'Integration Reviewer';
    question.review.reviewedAt = '2026-08-30';
  }
  return parseTriviaQuestionBankJson(JSON.stringify(changed));
}

function mutableBank(bank: TriviaQuestionBank): {
  version: number;
  questions: Array<{
    id: string;
    locales: { 'en-US': { prompt: string } };
    source: { accessed: string };
    review: {
      reviewedBy: string;
      reviewedAt: string;
      provenance: 'human-authored' | 'ai-assisted-draft';
    };
  }>;
} {
  return JSON.parse(JSON.stringify(bank));
}

function persistenceResult(resultId: string, completedAtMs: number, name: string): TriviaResult {
  const rawScore = 4_000;
  return Object.freeze({
    resultId,
    generation: 1,
    category: 'science',
    contentRevision: 'integration-v1',
    players: Object.freeze([Object.freeze({
      playerId: 't1',
      name,
      playerOrder: 0,
      rank: 1,
      rawScore,
      normalizedScore: normalizeTriviaScore(rawScore),
      correctCount: 4,
      bestStreak: 2,
      cumulativeCorrectTimeMs: 4_000,
    })]),
    completedAtMs,
  });
}

interface FakeRelayCaller {
  readonly participant: StationTriviaParticipant;
  readonly ws: WebSocket;
  readonly messages: Record<string, any>[];
  readonly speech: string[];
  readonly acknowledgements: string[];
  readonly held: Array<{ token: string; text: string }>;
  holdText: ((text: string) => boolean) | null;
}

async function signedVoicePost(
  port: number,
  pathname: string,
  params: Record<string, string>,
): Promise<Response> {
  const signature = twilio.getExpectedTwilioSignature(
    VOICE_AUTH_TOKEN,
    `${VOICE_PUBLIC_BASE_URL}${pathname}`,
    params,
  );
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body: new URLSearchParams(params),
  });
}

function relayParameters(xml: string): Record<string, string> {
  return Object.fromEntries(
    [...xml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)" \/>/g)]
      .map(match => [match[1]!, match[2]!]),
  );
}

function relayAttribute(xml: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(xml)?.[1] ?? '';
}

async function connectRelayCaller(port: number, input: {
  participant: StationTriviaParticipant;
  parameters: Record<string, string>;
  signature: string;
}): Promise<FakeRelayCaller> {
  const connection = await connect(port, '/voice', {
    Origin: VOICE_PUBLIC_BASE_URL,
    'X-Twilio-Signature': input.signature,
  });
  const caller: FakeRelayCaller = {
    participant: input.participant,
    ws: connection.ws,
    messages: connection.messages,
    speech: [],
    acknowledgements: [],
    held: [],
    holdText: null,
  };
  caller.ws.on('message', data => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    if (message.type !== 'text') return;
    const token = String(message.token);
    const text = relayPlainText(token);
    caller.speech.push(text);
    const hold = caller.holdText;
    if (hold?.(text)) {
      caller.holdText = null;
      caller.held.push({ token, text });
      return;
    }
    acknowledgeRelayText(caller, token);
  });
  caller.ws.send(JSON.stringify({
    type: 'setup',
    callSid: input.participant.callSid,
    from: input.participant.from,
    customParameters: input.parameters,
  }));
  return caller;
}

function acknowledgeRelayText(caller: FakeRelayCaller, token: string): void {
  caller.acknowledgements.push(token);
  caller.ws.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: token }));
}

function relayPlainText(token: string): string {
  return token
    .replace(/[\u200B\u2060]/g, '')
    .replace(/<phoneme\b[^>]*>(.*?)<\/phoneme>/g, '$1');
}

function waitForRelaySpeech(
  caller: FakeRelayCaller,
  offset: number,
  predicate: (text: string) => boolean,
): Promise<string> {
  return waitFor(() => caller.speech.slice(offset).find(predicate));
}

function relaySpeechCount(caller: FakeRelayCaller, pattern: RegExp): number {
  return caller.speech.filter(text => pattern.test(text)).length;
}

async function paintTriviaView(
  display: { ws: WebSocket; messages: Record<string, any>[] },
  trivia: TriviaServer,
  room: TriviaRoom,
  phase: 'question_prompt' | 'answer_cue',
  playerId: string,
): Promise<void> {
  const current = room.state();
  expect(current.phase).toBe(phase);
  const view = await waitFor(() => display.messages.find(message => (
    message.type === 'trivia_state' && message.phase === phase
      && message.question?.id === current.question?.id
      && message.questionAttemptId === current.questionAttemptId
      && message.renderRevision === current.renderRevision
  )));
  display.ws.send(JSON.stringify({
    type: 'view_rendered', phase,
    questionId: view.question.id,
    questionAttemptId: view.questionAttemptId,
    renderRevision: view.renderRevision,
  }));
  const nextPhase = phase === 'question_prompt' ? 'answer_cue' : 'question';
  await waitFor(() => room.phase === nextPhase
    || trivia.voiceSnapshot(room.code, playerId)?.displayViewReady ? true : undefined);
}

async function finishTrustedQuestionAudio(
  trivia: TriviaServer,
  room: TriviaRoom,
  display: { ws: WebSocket; messages: Record<string, any>[] },
  playerIds: readonly string[],
): Promise<void> {
  await paintTriviaView(display, trivia, room, 'question_prompt', playerIds[0]!);
  const prompt = room.state();
  for (const playerId of playerIds) {
    const generation = trivia.voiceBeginPromptDelivery(room.code, playerId,
      prompt.question!.id, prompt.questionAttemptId!);
    expect(generation).not.toBeNull();
    expect(trivia.voiceQuestionPromptReady(room.code, playerId, prompt.question!.id,
      prompt.questionAttemptId!, generation!)).toBe(true);
  }
  expect(room.phase).toBe('answer_cue');
  expect(room.state().answeringStartsAtMs).not.toBeNull();
  await paintTriviaView(display, trivia, room, 'answer_cue', playerIds[0]!);
  const cue = room.state();
  for (const playerId of playerIds) {
    const generation = trivia.voiceBeginAnswerCueDelivery(room.code, playerId,
      cue.question!.id, cue.questionAttemptId!);
    expect(generation).not.toBeNull();
    expect(trivia.voiceQuestionAnswerCueReady(room.code, playerId, cue.question!.id,
      cue.questionAttemptId!, generation!)).toBe(true);
  }
  expect(room.phase).toBe('question');
}

function settleRoomQuestionAudio(room: TriviaRoom, playerIds: readonly string[]): void {
  const prompt = room.state();
  expect(prompt.phase).toBe('question_prompt');
  for (const playerId of playerIds) {
    const generation = room.beginPromptDelivery(playerId, prompt.question!.id, prompt.questionAttemptId!);
    expect(generation).not.toBeNull();
    expect(room.questionPromptReady(playerId, prompt.question!.id, prompt.questionAttemptId!, generation!)).toBe(true);
  }
  const cue = room.state();
  expect(cue.phase).toBe('answer_cue');
  for (const playerId of playerIds) {
    const generation = room.beginAnswerCueDelivery(playerId, cue.question!.id, cue.questionAttemptId!);
    expect(generation).not.toBeNull();
    expect(room.questionAnswerCueReady(playerId, cue.question!.id, cue.questionAttemptId!, generation!)).toBe(true);
  }
  expect(room.phase).toBe('question');
}

function sendFinalTranscript(caller: FakeRelayCaller, voicePrompt: string): void {
  caller.ws.send(JSON.stringify({ type: 'prompt', voicePrompt, last: true }));
}

function sendRelayAnswer(
  caller: FakeRelayCaller,
  question: { choices: readonly { id: string; text: string }[] },
  choiceId: string,
  dtmf: boolean,
): void {
  const choiceIndex = question.choices.findIndex(choice => choice.id === choiceId);
  if (choiceIndex < 0) throw new Error(`choice ${choiceId} is not visible`);
  if (dtmf) caller.ws.send(JSON.stringify({ type: 'dtmf', digit: String(choiceIndex + 1) }));
  else sendFinalTranscript(caller, question.choices[choiceIndex]!.text);
}

function correctChoiceId(questionId: string): string {
  const question = bundledBank.questions.find(candidate => candidate.id === questionId);
  if (!question) throw new Error(`missing bundled Trivia question ${questionId}`);
  return question.correctChoiceId;
}

async function closeRelayCaller(caller: FakeRelayCaller): Promise<void> {
  if (caller.ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>(resolve => caller.ws.once('close', () => resolve()));
  caller.ws.close();
  await closed;
}

function accelerateRelayChunkGaps(): void {
  const nativeSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (typeof delay === 'number' && delay > 500 && delay <= 700) {
      const timer = { unref() { return timer; } };
      queueMicrotask(() => callback(...args));
      return timer as unknown as ReturnType<typeof setTimeout>;
    }
    return nativeSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
}
