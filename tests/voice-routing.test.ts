import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ArcadeApi } from '../server/arcade-api';
import type { StationMatchParticipantsChangedHandler } from '../server/arcade-station-runtime';
import { GoogleAnalyticsAuth } from '../server/google-analytics-auth';
import {
  HttpServer,
  karaokeBrowserTestingAllowed,
  resolveVoiceRelayToken,
  triviaLocalKeyboardTestingAllowed,
} from '../server/http-server';
import type { SupportedLocale } from '../shared/i18n/locales';
import { monsterName } from '../shared/i18n/content';
import { rosterEntries } from '../shared/monster-roster';

type StationVoiceRoute = Awaited<ReturnType<ArcadeApi['stationVoiceRoute']>>;

let server: HttpServer | undefined;
let directory: string | undefined;
const DISPLAY_TOKEN = 'test-standalone-display-token';

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.restoreAllMocks();
});

async function harness(options: {
  active: boolean;
  activeChecks?: readonly boolean[];
  locale?: SupportedLocale;
  route?: StationVoiceRoute;
  routeError?: Error;
  standaloneVoiceEnabled?: boolean;
  voiceAvailable?: boolean;
  authToken?: string;
  additionalAuthTokens?: readonly string[];
  analyticsAuth?: GoogleAnalyticsAuth;
  standaloneGameEnabled?: boolean;
  stationRoomCode?: string;
  stationPhase?: 'LAUNCHING' | 'PLAYING' | null;
}) {
  directory = await mkdtemp(path.join(tmpdir(), 'voice-routing-'));
  const stationVoiceRoute = vi.fn(async () => {
    if (options.routeError) throw options.routeError;
    return options.route ?? null;
  });
  const voiceLocaleForNumber = vi.fn(() => options.locale ?? 'en-US');
  let activeCheck = 0;
  const stationEngineStarted = vi.fn();
  const stationEngineCompleted = vi.fn();
  const stationEngineAbandoned = vi.fn();
  let stationParticipantCountHandler: StationMatchParticipantsChangedHandler | null = null;
  const arcadeApi = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    activateMessagingDelivery: vi.fn(async () => undefined),
    getHealthStatus: vi.fn(() => ({ degraded: false })),
    isStationEngineRoom: vi.fn((code: string) => code === options.stationRoomCode),
    stationEnginePhase: vi.fn((game: string, code: string) => game === 'chess' && code === options.stationRoomCode
      ? options.stationPhase === undefined ? 'PLAYING' : options.stationPhase : null),
    requiresStationVoiceAssignment: vi.fn(() => {
      const checks = options.activeChecks;
      return checks?.[Math.min(activeCheck++, checks.length - 1)] ?? options.active;
    }),
    voiceLocaleForNumber,
    stationVoiceRoute,
    resolveStationVoiceSetup: vi.fn(async () => options.stationRoomCode
      ? { firstName: 'Ada', terminal: false, participantIndex: 0, participantCount: 1 } : null),
    stationVoiceParticipantConnected: vi.fn(),
    stationVoiceParticipantDisconnected: vi.fn(),
    stationVoiceSetupActivity: vi.fn(),
    stationVoiceCallEnded: vi.fn(),
    stationEngineStarted,
    stationEngineCompleted,
    stationEngineAbandoned,
    setStationParticipantCountHandler: vi.fn((handler: StationMatchParticipantsChangedHandler) => {
      stationParticipantCountHandler = handler;
    }),
    standaloneVoiceAvailable:vi.fn(()=>options.voiceAvailable??true),
    standaloneGameEnabled:vi.fn(()=>options.standaloneGameEnabled ?? true),
  } as unknown as ArcadeApi;
  server = new HttpServer({
    port: 0,
    publicBaseUrl: 'http://localhost',
    authToken: options.authToken,
    additionalAuthTokens: options.additionalAuthTokens,
    validateSignatures: Boolean(options.authToken),
    analyticsAuth: options.analyticsAuth,
    arcadeApi,
    standaloneVoiceEnabled: options.standaloneVoiceEnabled ?? false,
    fighterDisplayToken: DISPLAY_TOKEN,
    analyticsPath: path.join(directory, 'analytics.json'),
    manifestPath: path.join(directory, 'manifest.json'),
    mapsPath: path.join(directory, 'maps.json'),
    arenaPath: path.join(directory, 'arena.json'),
    leaderboardPath: path.join(directory, 'leaderboard.json'),
    fighterMapsPath: path.join(directory, 'fighter-maps.json'),
    fighterPreviewDir: path.join(directory, 'fighter-previews'),
    clientDir: path.join(directory, 'client'),
  });
  const port = await server.start();
  const reconcileStationParticipants = (...args: Parameters<StationMatchParticipantsChangedHandler>) => {
    if (!stationParticipantCountHandler) throw new Error('station participant handler was not registered');
    stationParticipantCountHandler(...args);
  };
  return { port, stationVoiceRoute, voiceLocaleForNumber, stationEngineStarted,
    stationEngineCompleted, stationEngineAbandoned, reconcileStationParticipants };
}

async function incomingCall(port: number, input: {
  from?: string;
  to?: string;
  callSid?: string;
  signature?: string;
} = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/voice/incoming`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(input.signature ? { 'X-Twilio-Signature': input.signature } : {}),
    },
    body: new URLSearchParams({
      From: input.from ?? '+14155550199',
      To: input.to ?? '+18555993809',
      CallSid: input.callSid ?? 'CA-voice-routing',
    }),
  });
}

async function connectAuthenticatedChessDisplay(port: number, roomCode: string) {
  const display = new WebSocket(`ws://127.0.0.1:${port}/chess?display=1`, {
    headers: { Origin: 'http://localhost' },
  });
  const states: Array<Record<string, any>> = [];
  display.on('message', data => {
    const frame = JSON.parse(data.toString()) as Record<string, any>;
    if (frame.type === 'chess_state' && frame.roomCode === roomCode) states.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    display.once('open', resolve);
    display.once('error', reject);
  });
  display.send(JSON.stringify({ type: 'display_auth', roomCode, token: DISPLAY_TOKEN }));
  display.send(JSON.stringify({ type: 'spectate', roomCode }));
  await vi.waitFor(() => expect(states.length).toBeGreaterThan(0), { timeout: 2_000 });
  return { display, states };
}

async function connectChessVoice(port: number, callSid: string, customParameters: Record<string, string | number>) {
  const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
  const spoken: string[] = [];
  voice.on('message', data => {
    const message = JSON.parse(data.toString()) as { type: string; token?: string };
    if (message.type !== 'text') return;
    spoken.push(message.token ?? '');
    if (voice.readyState === WebSocket.OPEN) {
      voice.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: message.token }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    voice.once('open', resolve);
    voice.once('error', reject);
  });
  voice.send(JSON.stringify({ type: 'setup', callSid, customParameters }));
  return { voice, spoken };
}

async function connectStationChessVoice(port: number, roomCode: string, callSid: string) {
  expect(await (await incomingCall(port, { callSid })).text()).toContain('<Parameter name="game" value="chess"');
  return connectChessVoice(port, callSid, { game: 'chess', roomCode, readyEntryId: 'ready-chess',
    matchId: 'match-chess', launchGeneration: 2, locale: 'en-US' });
}

async function connectStationChessCall(port: number, roomCode: string, callSid: string) {
  const { display, states } = await connectAuthenticatedChessDisplay(port, roomCode);
  const { voice, spoken } = await connectStationChessVoice(port, roomCode, callSid);
  return { display, states, voice, spoken };
}

async function persistedChessSessions(): Promise<{ sessions: number; completed: number; abandoned: number }> {
  if (!directory) throw new Error('test directory was not created');
  const persisted = JSON.parse(await readFile(path.join(directory, 'analytics.json'), 'utf8')) as {
    days: Record<string, { games: { chess: { sessions: number; completed: number; abandoned: number } } }>;
  };
  return Object.values(persisted.days).reduce((total, day) => ({
    sessions: total.sessions + day.games.chess.sessions,
    completed: total.completed + day.games.chess.completed,
    abandoned: total.abandoned + day.games.chess.abandoned,
  }), { sessions: 0, completed: 0, abandoned: 0 });
}

function stationChessRoute(roomCode: string): NonNullable<StationVoiceRoute> {
  return {
    game: 'chess', roomCode, matchId: 'match-chess', launchGeneration: 2,
    admitted: true, readyEntryId: 'ready-chess', participantIndex: 0, participantCount: 1,
  };
}

describe('Arcade Voice routing', () => {
  it('keeps hidden Karaoke browser testing loopback-only and out of production', () => {
    expect(karaokeBrowserTestingAllowed('development', 'http://localhost:8081')).toBe(true);
    expect(karaokeBrowserTestingAllowed('test', 'http://127.0.0.1:8081')).toBe(true);
    expect(karaokeBrowserTestingAllowed('production', 'http://localhost:8081')).toBe(false);
    expect(karaokeBrowserTestingAllowed('development', 'https://games.example')).toBe(false);
  });
  it('keeps hidden Trivia keyboard testing on the standalone loopback default room only', () => {
    expect(triviaLocalKeyboardTestingAllowed('development', 'http://localhost:8081', '4821', false)).toBe(true);
    expect(triviaLocalKeyboardTestingAllowed('test', 'http://127.0.0.1:8081', '4821', false)).toBe(true);
    expect(triviaLocalKeyboardTestingAllowed('production', 'http://localhost:8081', '4821', false)).toBe(false);
    expect(triviaLocalKeyboardTestingAllowed('development', 'https://games.example', '4821', false)).toBe(false);
    expect(triviaLocalKeyboardTestingAllowed('development', 'http://localhost:8081', 'OTHER', false)).toBe(false);
    expect(triviaLocalKeyboardTestingAllowed('development', 'http://localhost:8081', '4821', true)).toBe(false);
  });
  it('never reuses the Twilio webhook secret as a Relay bearer outside loopback development', () => {
    expect(resolveVoiceRelayToken('https://games.example', undefined, 'twilio-secret', 'production')).toBe('');
    expect(resolveVoiceRelayToken('https://games.example', undefined, 'twilio-secret', 'test')).toBe('');
    expect(resolveVoiceRelayToken('http://localhost:8080', undefined, 'twilio-secret', 'test')).toBe('twilio-secret');
    expect(resolveVoiceRelayToken('https://games.example', 'relay-secret', 'twilio-secret', 'production'))
      .toBe('relay-secret');
  });

  it.each([
    ['en-US', 'Twilio Games voice play is unavailable right now. Please ask booth staff for help. Goodbye.'],
    ['pt-BR', 'Os jogos por voz do Twilio Games não estão disponíveis agora. Peça ajuda à equipe. Até logo.'],
  ] as const)('returns localized Say and Hangup while event mode is off (%s)', async (locale, message) => {
    const { port, stationVoiceRoute } = await harness({ active: false, locale });
    const response = await incomingCall(port);
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(xml).toContain(`<Say language="${locale}">${message}</Say>`);
    expect(xml).toContain('<Hangup />');
    expect(xml).not.toContain('<Connect');
    expect(xml).not.toContain('<ConversationRelay');
    expect(stationVoiceRoute).not.toHaveBeenCalled();
  });

  it('does not route a retained admitted match after the event is paused', async () => {
    const retainedRoute: NonNullable<StationVoiceRoute> = {
      game: 'racer', roomCode: 'STALE-ROOM', matchId: 'stale-match', launchGeneration: 2,
      admitted: true, readyEntryId: 'stale-ready-entry', participantIndex: 0, participantCount: 1,
    };
    const { port, stationVoiceRoute } = await harness({ active: false, route: retainedRoute });
    const xml = await (await incomingCall(port)).text();

    expect(stationVoiceRoute).not.toHaveBeenCalled();
    expect(xml).toContain('<Hangup />');
    expect(xml).not.toContain('STALE-ROOM');
    expect(xml).not.toContain('<ConversationRelay');
  });

  it('drops a station route if the event is paused while routing the call', async () => {
    const route: NonNullable<StationVoiceRoute> = {
      game: 'racer', roomCode: 'JUST-PAUSED', matchId: 'paused-match', launchGeneration: 3,
      admitted: true, readyEntryId: 'paused-ready-entry', participantIndex: 0, participantCount: 1,
    };
    const { port, stationVoiceRoute } = await harness({
      active: true, activeChecks: [true, false], route,
    });
    const xml = await (await incomingCall(port)).text();

    expect(stationVoiceRoute).toHaveBeenCalledOnce();
    expect(xml).toContain('<Hangup />');
    expect(xml).not.toContain('JUST-PAUSED');
    expect(xml).not.toContain('<ConversationRelay');
  });

  it('does not bypass disabled Voice when an event pauses during call routing', async () => {
    const route: NonNullable<StationVoiceRoute> = {
      game: 'racer', roomCode: 'JUST-PAUSED', matchId: 'paused-match', launchGeneration: 3,
      admitted: true, readyEntryId: 'paused-ready-entry', participantIndex: 0, participantCount: 1,
    };
    const { port } = await harness({
      active: true, activeChecks: [true, false], route,
      standaloneVoiceEnabled: true, voiceAvailable: false,
    });
    const display = new WebSocket(`ws://127.0.0.1:${port}/game`);
    await new Promise<void>((resolve, reject) => {
      display.once('open', resolve);
      display.once('error', reject);
    });
    display.send(JSON.stringify({ type: 'spectate', roomCode: '4821', displayToken: DISPLAY_TOKEN }));
    await new Promise(resolve => setTimeout(resolve, 20));

    const xml = await (await incomingCall(port)).text();
    expect(xml).toContain('<Hangup />');
    expect(xml).not.toContain('<ConversationRelay');
    display.close();
  });

  it('requires an open shared display before standalone Voice routing', async () => {
    const { port, stationVoiceRoute } = await harness({
      active: false, standaloneVoiceEnabled: true,
    });
    const xml = await (await incomingCall(port)).text();

    expect(stationVoiceRoute).not.toHaveBeenCalled();
    expect(xml).toContain('voice play is unavailable');
    expect(xml).not.toContain('<ConversationRelay');
  });

  it('registers Karaoke recency from an explicit standalone display without station credentials', async () => {
    const { port } = await harness({ active: false, standaloneVoiceEnabled: true });
    const rejectedStatus = new Promise<number>(resolve => {
      const rejected = new WebSocket(`ws://127.0.0.1:${port}/karaoke`, {
        headers: { Origin: 'https://attacker.example' },
      });
      rejected.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    });
    await expect(rejectedStatus).resolves.toBe(403);

    const spectator = new WebSocket(`ws://127.0.0.1:${port}/karaoke`, {
      headers: { Origin: 'http://localhost' },
    });
    await new Promise<void>((resolve, reject) => {
      spectator.once('open', resolve);
      spectator.once('error', reject);
    });
    spectator.send(JSON.stringify({ type: 'spectate', roomCode: '4821' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await (await incomingCall(port)).text()).not.toContain('<ConversationRelay');

    const display = new WebSocket(`ws://127.0.0.1:${port}/karaoke?display=1`, {
      headers: { Origin: 'http://localhost' },
    });
    await new Promise<void>((resolve, reject) => {
      display.once('open', resolve);
      display.once('error', reject);
    });
    display.send(JSON.stringify({ type: 'spectate', roomCode: '4821' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    const xml = await (await incomingCall(port)).text();
    expect(xml).toContain('<Parameter name="game" value="karaoke"');
    spectator.close();
    display.close();
  });

  it('routes a standalone call to the active Voice Chess display', async () => {
    const { port } = await harness({ active: false, standaloneVoiceEnabled: true });
    const display = new WebSocket(`ws://127.0.0.1:${port}/chess?display=1`, {
      headers: { Origin: 'http://localhost' },
    });
    await new Promise<void>((resolve, reject) => {
      display.once('open', resolve);
      display.once('error', reject);
    });
    display.send(JSON.stringify({ type: 'spectate', roomCode: '4821' }));
    await new Promise(resolve => setTimeout(resolve, 20));

    const xml = await (await incomingCall(port)).text();
    expect(xml).toContain('<Parameter name="game" value="chess"');
    display.close();
  });

  it('binds a validated station Chess caller before its display connects', async () => {
    const roomCode = 'STATION-CHESS-EARLY';
    const callSid = 'CA-station-chess-early';
    const { port } = await harness({
      active: true, stationRoomCode: roomCode, stationPhase: 'LAUNCHING', route: stationChessRoute(roomCode),
    });
    const { voice, spoken } = await connectStationChessVoice(port, roomCode, callSid);
    await vi.waitFor(() => expect(spoken.join(' ')).toContain('Welcome to Voice Chess'), { timeout: 2_000 });

    const { display, states } = await connectAuthenticatedChessDisplay(port, roomCode);
    expect(states.at(-1)?.playerConnected).toBe(true);
    voice.close();
    display.close();
  });

  it('still requires an authenticated display for a nonstation Chess caller in a nondefault room', async () => {
    const roomCode = 'NONSTATION-CHESS';
    const { port } = await harness({ active: false, standaloneVoiceEnabled: true });
    const { voice, spoken } = await connectChessVoice(port, 'CA-nonstation-chess', {
      game: 'chess', roomCode, locale: 'en-US',
    });
    await vi.waitFor(() => expect(spoken.join(' ')).toContain('Another caller already commands this chess board'),
      { timeout: 2_000 });

    const { display, states } = await connectAuthenticatedChessDisplay(port, roomCode);
    expect(states.at(-1)?.playerConnected).toBe(false);
    const admitted = await connectChessVoice(port, 'CA-nonstation-chess-admitted', {
      game: 'chess', roomCode, locale: 'en-US',
    });
    await vi.waitFor(() => expect(admitted.spoken.join(' ')).toContain('Welcome to Voice Chess'),
      { timeout: 2_000 });
    await vi.waitFor(() => expect(states.at(-1)?.playerConnected).toBe(true), { timeout: 2_000 });
    voice.close();
    admitted.voice.close();
    display.close();
  });

  it('plays Voice Chess from final phone prompts and resumes the same call without restarting', async () => {
    const { port } = await harness({ active: false, standaloneVoiceEnabled: true });
    const display = new WebSocket(`ws://127.0.0.1:${port}/chess?display=1`, {
      headers: { Origin: 'http://localhost' },
    });
    const boardFrames: Array<Record<string, any>> = [];
    display.on('message', data => boardFrames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      display.once('open', resolve);
      display.once('error', reject);
    });
    display.send(JSON.stringify({ type: 'spectate', roomCode: '4821' }));

    const connectVoice = async () => {
      const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
      const spoken: string[] = [];
      voice.on('message', data => {
        const message = JSON.parse(data.toString()) as { type: string; token?: string; text?: string };
        if (message.type !== 'text') return;
        spoken.push(message.token ?? '');
        voice.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: message.token }));
      });
      await new Promise<void>((resolve, reject) => {
        voice.once('open', resolve);
        voice.once('error', reject);
      });
      voice.send(JSON.stringify({ type: 'setup', callSid: 'CA-chess-integration',
        customParameters: { game: 'chess', roomCode: '4821', locale: 'en-US' } }));
      return { voice, spoken };
    };
    const waitForBoard = async (predicate: (frame: Record<string, any>) => boolean) => {
      await vi.waitFor(() => expect(boardFrames.some(predicate)).toBe(true), { timeout: 4_000 });
      return boardFrames.find(predicate)!;
    };
    try {
      const first = await connectVoice();
      await vi.waitFor(() => expect(first.spoken.join(' ')).toMatch(/Welcome to Voice Chess/), { timeout: 2_000 });
      const start = await waitForBoard(frame => frame.type === 'chess_state' && frame.playerConnected === true);
      const originalPly = start.ply as number;
      const move = start.humanColor === 'w' ? 'pawn from E two to E four' : 'pawn from E seven to E five';

      first.voice.send(JSON.stringify({ type: 'prompt', voicePrompt: move, last: false }));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(boardFrames.some(frame => frame.type === 'chess_state' && frame.phase === 'pending')).toBe(false);
      first.voice.send(JSON.stringify({ type: 'prompt', voicePrompt: move, last: true }));
      await waitForBoard(frame => frame.type === 'chess_state' && frame.phase === 'pending');
      expect(boardFrames.some(frame => frame.type === 'chess_events'
        && frame.events.some((event: { type: string; move?: { actor: string } }) => event.type === 'move'
          && event.move?.actor === 'human'))).toBe(false);

      first.voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'confirm', last: true }));
      await waitForBoard(frame => frame.type === 'chess_state'
        && frame.lastMove?.actor === 'human' && frame.ply === originalPly + 1);
      await waitForBoard(frame => frame.type === 'chess_events'
        && frame.events.some((event: { type: string; move?: { actor: string } }) => event.type === 'move'
          && event.move?.actor === 'computer'));
      await vi.waitFor(() => expect(first.spoken.join(' ')).toMatch(/rival|captures|moves/i), { timeout: 2_000 });

      first.voice.close();
      await new Promise<void>(resolve => first.voice.once('close', () => resolve()));
      const plyAfterFirstCall = (await waitForBoard(frame => frame.type === 'chess_state'
        && frame.playerConnected === false)).ply;
      const resumed = await connectVoice();
      await vi.waitFor(() => expect(resumed.spoken.join(' ')).toMatch(/Welcome back to Voice Chess/), { timeout: 2_000 });
      const resumedState = await waitForBoard(frame => frame.type === 'chess_state'
        && frame.playerConnected === true && frame.ply === plyAfterFirstCall);
      expect(resumedState.ply).toBe(plyAfterFirstCall);
      resumed.voice.close();
    } finally {
      display.close();
    }
  });

  it('abandons an unfinished station Chess match when its call ends', async () => {
    const roomCode = 'STATION-CHESS';
    const callSid = 'CA-station-chess';
    const { port, stationEngineStarted, stationEngineAbandoned } = await harness({
      active: true, stationRoomCode: roomCode, stationPhase: 'PLAYING', route: stationChessRoute(roomCode),
    });
    const { display, voice } = await connectStationChessCall(port, roomCode, callSid);
    await vi.waitFor(() => expect(stationEngineStarted).toHaveBeenCalledWith('chess', roomCode), { timeout: 2_000 });

    const ended = await fetch(`http://127.0.0.1:${port}/voice/session-ended`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: callSid, SessionStatus: 'completed', CallStatus: 'completed' }),
    });
    expect(ended.status).toBe(200);
    await vi.waitFor(() => expect(stationEngineAbandoned).toHaveBeenCalledWith('chess', roomCode), { timeout: 2_000 });
    expect(stationEngineAbandoned).toHaveBeenCalledTimes(1);
    voice.close();
    display.close();
  });

  it('keeps a launching station Chess match available for a replacement caller', async () => {
    const roomCode = 'STATION-CHESS-REPLACE';
    const callSid = 'CA-station-chess-original';
    const { port, stationEngineStarted, stationEngineCompleted, stationEngineAbandoned } = await harness({
      active: true, stationRoomCode: roomCode, stationPhase: 'LAUNCHING', route: stationChessRoute(roomCode),
    });
    const { display, states, voice } = await connectStationChessCall(port, roomCode, callSid);
    await vi.waitFor(() => expect(stationEngineStarted).toHaveBeenCalledWith('chess', roomCode), { timeout: 2_000 });

    const ended = await fetch(`http://127.0.0.1:${port}/voice/session-ended`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: callSid, SessionStatus: 'completed', CallStatus: 'completed' }),
    });
    expect(ended.status).toBe(200);
    await vi.waitFor(() => expect(states.at(-1)?.playerConnected).toBe(false), { timeout: 2_000 });
    expect(stationEngineAbandoned).not.toHaveBeenCalled();
    expect(stationEngineCompleted).not.toHaveBeenCalled();

    const replacement = await connectStationChessVoice(port, roomCode, 'CA-station-chess-replacement');
    await vi.waitFor(() => expect(replacement.spoken.join(' ')).toContain('Welcome to Voice Chess'),
      { timeout: 2_000 });
    await vi.waitFor(() => expect(states.at(-1)?.playerConnected).toBe(true), { timeout: 2_000 });
    expect(stationEngineAbandoned).not.toHaveBeenCalled();
    expect(stationEngineCompleted).not.toHaveBeenCalled();
    voice.close();
    replacement.voice.close();
    display.close();
  });

  it('records one abandoned Chess session when station reconciliation removes its caller', async () => {
    const roomCode = 'STATION-CHESS-ROSTER';
    const callSid = 'CA-station-chess-roster';
    const analyticsAuth = new GoogleAnalyticsAuth({
      redirectUri: 'http://localhost/auth/google/callback', adminPin: 'Chess!Roster#2026',
    });
    const cookie = analyticsAuth.issueSession('reporter@twilio.com').split(';')[0]!;
    const { port, stationEngineStarted, stationEngineCompleted, stationEngineAbandoned,
      reconcileStationParticipants } = await harness({
      active: true, stationRoomCode: roomCode, stationPhase: 'LAUNCHING',
      route: stationChessRoute(roomCode), analyticsAuth,
    });
    await connectStationChessCall(port, roomCode, callSid);
    await vi.waitFor(() => expect(stationEngineStarted).toHaveBeenCalledWith('chess', roomCode), { timeout: 2_000 });

    reconcileStationParticipants('chess', roomCode, 0, [], []);
    reconcileStationParticipants('chess', roomCode, 0, [], []);
    expect(stationEngineCompleted).not.toHaveBeenCalled();
    expect(stationEngineAbandoned).not.toHaveBeenCalled();
    const report = await fetch(`http://127.0.0.1:${port}/api/analytics?game=chess`, {
      headers: { cookie },
    });
    expect(report.status).toBe(200);
    expect((await report.json()).summary).toMatchObject({ sessions: 1, completed: 0, abandoned: 1 });

    const ended = await fetch(`http://127.0.0.1:${port}/voice/session-ended`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: callSid, SessionStatus: 'completed', CallStatus: 'completed' }),
    });
    expect(ended.status).toBe(200);
    await server!.stop(); server = undefined;
    expect(await persistedChessSessions()).toEqual({ sessions: 1, completed: 0, abandoned: 1 });
    expect(stationEngineCompleted).not.toHaveBeenCalled();
    expect(stationEngineAbandoned).not.toHaveBeenCalled();
  });

  it('persists an active Chess session as abandoned when the server stops', async () => {
    const roomCode = 'STATION-CHESS-SHUTDOWN';
    const callSid = 'CA-station-chess-shutdown';
    const { port, stationEngineStarted } = await harness({
      active: true, stationRoomCode: roomCode, route: stationChessRoute(roomCode),
    });
    await connectStationChessCall(port, roomCode, callSid);
    await vi.waitFor(() => expect(stationEngineStarted).toHaveBeenCalledWith('chess', roomCode), { timeout: 2_000 });

    await server!.stop(); server = undefined;
    expect(await persistedChessSessions()).toEqual({ sessions: 1, completed: 0, abandoned: 1 });
  });

  it('never promotes an authenticated station Trivia display to standalone recency after pause', async () => {
    const { port } = await harness({
      active: true,
      activeChecks: [true, false],
      standaloneVoiceEnabled: true,
    });
    const display = new WebSocket(`ws://127.0.0.1:${port}/trivia?display=1`, {
      headers: { Origin: 'http://localhost' },
    });
    await new Promise<void>((resolve, reject) => {
      display.once('open', resolve);
      display.once('error', reject);
    });
    display.send(JSON.stringify({ type: 'display_auth', roomCode: 'STATION-TRIVIA', token: DISPLAY_TOKEN }));
    display.send(JSON.stringify({ type: 'spectate', roomCode: 'STATION-TRIVIA' }));
    await new Promise(resolve => setTimeout(resolve, 20));

    const xml = await (await incomingCall(port)).text();
    expect(xml).toContain('voice play is unavailable');
    expect(xml).not.toContain('<ConversationRelay');
    display.close();
  });

  it('rejects direct nonstation Karaoke players while standalone mode is disabled', async () => {
    const { port } = await harness({ active: false, standaloneVoiceEnabled: false });
    const player = new WebSocket(`ws://127.0.0.1:${port}/karaoke`, {
      headers: { Origin: 'http://localhost' },
    });
    await new Promise<void>((resolve, reject) => {
      player.once('open', resolve);
      player.once('error', reject);
    });
    const rejected = new Promise<Record<string, unknown>>(resolve => player.on('message', data => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === 'error') resolve(message);
    }));
    player.send(JSON.stringify({ type: 'join', roomCode: 'BLOCKED', name: 'Ada' }));
    await expect(rejected).resolves.toMatchObject({ code: 'station_voice_only' });
    player.close();
  });

  it('allows direct Karaoke players only in explicit standalone mode', async () => {
    const { port } = await harness({ active: false, standaloneVoiceEnabled: true });
    const player = new WebSocket(`ws://127.0.0.1:${port}/karaoke?display=1`, {
      headers: { Origin: 'http://localhost' },
    });
    await new Promise<void>((resolve, reject) => {
      player.once('open', resolve);
      player.once('error', reject);
    });
    const joined = new Promise<Record<string, unknown>>(resolve => player.on('message', data => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === 'joined') resolve(message);
    }));
    player.send(JSON.stringify({ type: 'join', roomCode: 'LOCAL', name: 'Ada' }));
    await expect(joined).resolves.toMatchObject({ roomCode: 'LOCAL' });
    player.close();
  });

  it('respects the operator Voice channel setting in standalone play', async()=>{
    const {port}=await harness({active:false,standaloneVoiceEnabled:true,voiceAvailable:false});
    const xml=await(await incomingCall(port)).text();
    expect(xml).toContain('voice play is unavailable');
    expect(xml).not.toContain('<ConversationRelay');
  });

  it.each(['en-US', 'pt-BR'] as const)('keeps active-event admitted Monsters routing within Flux keyterm limits (%s)', async locale => {
    const route: NonNullable<StationVoiceRoute> = {
      game: 'monsters', roomCode: 'EVENT-ROOM', matchId: 'match-1', launchGeneration: 4,
      admitted: true, readyEntryId: 'ready-1', participantIndex: 0, participantCount: 2,
    };
    const { port, stationVoiceRoute } = await harness({ active: true, route, locale });
    const xml = await (await incomingCall(port, { callSid: 'CA-active' })).text();

    expect(stationVoiceRoute).toHaveBeenCalledWith('+14155550199', 'CA-active');
    expect(xml).toContain('<ConversationRelay');
    expect(xml).toContain('<Parameter name="roomCode" value="EVENT-ROOM"');
    expect(xml).toContain('<Parameter name="game" value="monsters"');
    expect(xml).toContain('<Parameter name="matchId" value="match-1"');
    expect(xml).toContain('<Parameter name="launchGeneration" value="4"');
    const hints = / hints="([^"]*)"/.exec(xml)?.[1] ?? '';
    const terms = hints.split(', ').filter(Boolean);
    expect(terms).toHaveLength(100);
    expect(new Set(terms.map(term => term.toLowerCase())).size).toBe(terms.length);
    expect(terms).toEqual(expect.arrayContaining(locale === 'pt-BR' ? ['lutar', 'dois'] : ['fight', 'two']));
    expect(terms).toEqual(expect.arrayContaining(locale === 'pt-BR'
      ? ['luta', 'lute', 'batalhar', 'combater']
      : ['fights', 'flight']));
    expect(terms).toEqual(expect.arrayContaining(rosterEntries().map(monster => monsterName(locale, monster.id))));
  });

  it('routes an admitted Karaoke station call with setup mode and song-title hints', async () => {
    const route: NonNullable<StationVoiceRoute> = {
      game: 'karaoke', roomCode: 'KARAOKE-ROOM', matchId: 'karaoke-match', launchGeneration: 2,
      admitted: true, readyEntryId: 'karaoke-ready', participantIndex: 0, participantCount: 1,
    };
    const { port } = await harness({ active: true, route, locale: 'en-US' });
    const xml = await (await incomingCall(port, { callSid: 'CA-karaoke-route' })).text();

    expect(xml).toContain('<ConversationRelay');
    expect(xml).toContain('<Parameter name="game" value="karaoke"');
    expect(xml).toContain('<Parameter name="karaokeMode" value="setup"');
    expect(xml).toContain('<Parameter name="roomCode" value="KARAOKE-ROOM"');
    expect(xml).toContain('Never Gonna Give You Up');
    expect(xml).not.toContain('Luz no Ritmo');
  });

  it('routes an admitted Trivia caller with quiz/category/answer hints', async () => {
    const route: NonNullable<StationVoiceRoute> = {
      game: 'trivia', roomCode: 'TRIVIA-ROOM', matchId: 'trivia-match', launchGeneration: 3,
      admitted: true, readyEntryId: 'trivia-ready', participantIndex: 2, participantCount: 4,
    };
    const { port } = await harness({ active: true, route, locale: 'en-US' });
    const xml = await (await incomingCall(port, { callSid: 'CA-trivia-route' })).text();

    expect(xml).toContain('<ConversationRelay');
    expect(xml).toContain('<Parameter name="game" value="trivia"');
    expect(xml).toContain('<Parameter name="roomCode" value="TRIVIA-ROOM"');
    expect(xml).toContain('quiz, trivia, category, mixed, answer, choice, option, number, letter');
    expect(xml).toContain('one, two, three, four');
    expect(xml).toContain('ay, aye, alpha');
    expect(xml).not.toMatch(/(?:^|, )(?:eh|hey)(?:,|$)/i);
    expect(xml).toContain('general knowledge');
    expect(xml).toContain('science');
  });

  it('keeps Portuguese Trivia hints useful without common letter stopwords', async () => {
    const route: NonNullable<StationVoiceRoute> = {
      game: 'trivia', roomCode: 'TRIVIA-PT', matchId: 'trivia-pt-match', launchGeneration: 4,
      admitted: true, readyEntryId: 'trivia-pt-ready', participantIndex: 0, participantCount: 1,
    };
    const { port } = await harness({ active: true, route, locale: 'pt-BR' });
    const xml = await (await incomingCall(port, { callSid: 'CA-trivia-pt-route' })).text();
    const hints = /\shints="([^"]*)"/.exec(xml)?.[1]?.split(', ') ?? [];

    expect(hints).toEqual(expect.arrayContaining(['um', 'dois', 'três', 'quatro', 'alfa', 'bravo', 'Delta']));
    expect(hints).not.toEqual(expect.arrayContaining(['be', 'ce', 'se', 'de', 'bê', 'cê', 'dê']));
  });

  it('returns unavailable TwiML when active station routing fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { port } = await harness({
      active: true, locale: 'pt-BR', routeError: new Error('state read failed'),
    });
    const response = await incomingCall(port);
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain('Os jogos por voz do Twilio Games não estão disponíveis agora.');
    expect(xml).toContain('<Hangup />');
    expect(xml).not.toContain('<ConversationRelay');
    expect(errorLog).toHaveBeenCalledWith('[voice] station routing failed:', 'state read failed');
  });

  it('rejects an invalid signature before locale or station routing', async () => {
    const { port, stationVoiceRoute, voiceLocaleForNumber } = await harness({
      active: true,
      authToken: 'primary-auth-token',
      additionalAuthTokens: ['secondary-auth-token'],
    });
    const response = await incomingCall(port, { signature: 'invalid-signature' });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('invalid signature');
    expect(voiceLocaleForNumber).not.toHaveBeenCalled();
    expect(stationVoiceRoute).not.toHaveBeenCalled();
  });
});
