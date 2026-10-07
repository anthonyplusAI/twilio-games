import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import twilio from 'twilio';
import WebSocket from 'ws';
import type { ArcadeApi } from '../server/arcade-api';
import {
  handleRelayPlaybackEvent,
  HttpServer,
  isSecureKaraokeMediaRequest,
  sendRelayTextOutcome,
} from '../server/http-server';
import type { KaraokeServer } from '../server/karaoke-server';
import { KaraokeVoiceSession, type KaraokeVoiceSnapshot } from '../server/karaoke-voice';
import { DEFAULT_ROOM } from '../shared/constants';
import { KARAOKE_SONG_DURATION_MS } from '../shared/karaoke';
import { KARAOKE_COUNTDOWN_MS } from '../shared/karaoke-protocol';

const AUTH_TOKEN = 'karaoke-http-auth-token';
const DISPLAY_TOKEN = 'karaoke-display-token';
const PUBLIC_BASE_URL = 'https://games.example';
// Standalone inbound calls are intentionally bound to the public default room.
const ROOM = DEFAULT_ROOM;
const CALL_SID = 'CAkaraokecall';
const ACCOUNT_SID = 'ACkaraokeaccount';

let server: HttpServer | undefined;
let directory: string;
const sockets: WebSocket[] = [];

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'karaoke-http-')); });

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.stop();
  await rm(directory, { recursive: true, force: true });
  server = undefined;
  vi.restoreAllMocks();
});

describe('HTTP-hosted Voice Karaoke', () => {
  it('runs signed Relay handoff, dual readiness, authenticated media, and idempotent result reconnect', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));
    const stationEngineStarted = vi.fn();
    const stationEngineCompleted = vi.fn();
    const stationEngineAbandoned = vi.fn();
    const arcadeApi = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      activateMessagingDelivery: vi.fn(async () => undefined),
      getHealthStatus: vi.fn(() => ({ degraded: false })),
      isStationEngineRoom: vi.fn((code: string) => code === ROOM),
      requiresStationVoiceAssignment: vi.fn(() => false),
      setStationAbortHandler: vi.fn(),
      setStationParticipantCountHandler: vi.fn(),
      setPlayerResetCleanupHandler: vi.fn(),
      stationEngineStarted,
      stationEngineCompleted,
      stationEngineAbandoned,
      stationVoiceCallEnded: vi.fn(),
      voiceLocaleForNumber: vi.fn(() => 'en-US'),
      standaloneVoiceAvailable: vi.fn(() => true),
      standaloneGameEnabled: vi.fn(() => true),
    } as unknown as ArcadeApi;
    server = new HttpServer({
      port: 0,
      publicBaseUrl: PUBLIC_BASE_URL,
      authToken: AUTH_TOKEN,
      voiceRelayToken: AUTH_TOKEN,
      validateSignatures: true,
      arcadeApi,
      karaokeDisplayToken: DISPLAY_TOKEN,
      karaokeLeaderboardPath: join(directory, 'karaoke-leaderboard.json'),
    });
    const port = await server.start();
    const karaoke = (server as unknown as { karaoke: KaraokeServer }).karaoke;

    const display = await openSocket(`ws://127.0.0.1:${port}/karaoke?display=1`, {
      Origin: PUBLIC_BASE_URL,
    });
    display.send(JSON.stringify({ type: 'display_auth', roomCode: ROOM, token: DISPLAY_TOKEN }));
    display.send(JSON.stringify({ type: 'spectate', roomCode: ROOM }));
    await waitForSocketMessage(display, message => message.type === 'host_identity' && message.isHost === true);

    const incoming = await signedPost(port, '/voice/incoming', {
      AccountSid: ACCOUNT_SID,
      CallSid: CALL_SID,
      From: '+14155550199',
      To: '+18555993809',
    });
    const incomingXml = await incoming.text();
    expect(incomingXml).toContain('<Parameter name="game" value="karaoke"');
    expect(incomingXml).toContain(`<Parameter name="roomCode" value="${ROOM}"`);

    const voiceSignature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, 'wss://games.example/voice', {});
    const unregisteredVoice = await openSocket(`ws://127.0.0.1:${port}/voice`, {
      'X-Twilio-Signature': voiceSignature,
    });
    unregisteredVoice.send(JSON.stringify({
      type: 'setup', callSid: 'CAunregistered',
      customParameters: {
        roomCode: 'UNREGISTERED', game: 'karaoke', locale: 'en-US', commandLocale: 'en-US',
        relayToken: AUTH_TOKEN,
      },
    }));
    await waitForSocketMessage(unregisteredVoice, message => message.type === 'text');
    expect(karaoke.findRoom('UNREGISTERED')).toBeUndefined();
    unregisteredVoice.terminate();

    const voice = await openSocket(`ws://127.0.0.1:${port}/voice`, {
      'X-Twilio-Signature': voiceSignature,
    });
    const relayMessages: Record<string, unknown>[] = [];
    voice.on('message', data => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      relayMessages.push(message);
      if (message.type === 'text') {
        voice.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: message.token }));
      }
    });
    voice.send(JSON.stringify({
      type: 'setup', callSid: CALL_SID,
      customParameters: {
        roomCode: ROOM, game: 'karaoke', locale: 'en-US', commandLocale: 'en-US',
        relayToken: AUTH_TOKEN,
      },
    }));
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().singer).not.toBeNull());
    voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Ada', last: true }));
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().phase).toBe('song_select'));
    voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Never Gonna Give You Up', last: true }));
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().selectedSong?.title).toBe('Never Gonna Give You Up'));
    await waitForConsentPlayback(relayMessages);
    voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'start singing', last: true }));
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().phase).toBe('loading'));
    expect(relayMessages.filter(message => message.type === 'end')).toHaveLength(0);
    const generation = karaoke.findRoom(ROOM)!.state().loadingGeneration;
    display.send(JSON.stringify({ type: 'ready', loadingGeneration: generation }));
    await vi.waitFor(() => expect(relayMessages.filter(message => message.type === 'end')).toHaveLength(1));
    const handoffData = String(relayMessages.find(message => message.type === 'end')!.handoffData);
    expect(JSON.parse(handoffData)).toMatchObject({
      reasonCode: 'karaoke-media', roomCode: ROOM, songId: 'never-gonna-give-you-up', loadingGeneration: 1,
    });
    voice.close();
    await new Promise<void>(resolve => voice.once('close', () => resolve()));

    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state()).toMatchObject({
      phase: 'loading', displayReady: true, mediaReady: false,
    }));
    expect(stationEngineStarted).not.toHaveBeenCalled();

    const invalidData = JSON.stringify({ ...JSON.parse(handoffData), songId: 'wrong-song' });
    const invalidHandoff = await signedPost(port, '/voice/session-ended', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'in-progress',
      SessionStatus: 'completed', HandoffData: invalidData,
    });
    expect(await invalidHandoff.text()).toContain('<Hangup />');

    const handoff = await signedPost(port, '/voice/session-ended', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'in-progress',
      SessionStatus: 'completed', HandoffData: handoffData,
    });
    const mediaXml = await handoff.text();
    expect(mediaXml.indexOf('<Start>')).toBeLessThan(mediaXml.indexOf('<Pause'));
    expect(mediaXml.indexOf('<Pause')).toBeLessThan(mediaXml.indexOf('<Stop>'));
    expect(mediaXml.indexOf('<Stop>')).toBeLessThan(mediaXml.indexOf('<Redirect'));
    expect(mediaXml).toContain('url="wss://games.example/karaoke-media"');
    expect(mediaXml).not.toContain('wss://games.example/karaoke-media?');
    expect(mediaXml).toContain('track="inbound_track"');
    expect(mediaXml).toContain('<Pause length="53" />');
    const customParameters = streamParameters(mediaXml);
    expect(customParameters).toMatchObject({
      roomCode: ROOM, playerId: expect.any(String), songId: 'never-gonna-give-you-up', loadingGeneration: '1',
      attemptId: expect.any(String), attemptToken: expect.any(String),
    });
    const streamName = /<Stream name="([^"]+)"/.exec(mediaXml)?.[1];
    expect(streamName).toBeTruthy();

    const mismatchedNameStatus = await signedPost(port, '/voice/karaoke/stream-status', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, StreamSid: 'MZstale',
      StreamName: `${streamName}-stale`, StreamEvent: 'stream-started',
    });
    expect(mismatchedNameStatus.status).toBe(403);
    expect((server as unknown as { karaokeVoiceCallBindings: Map<string, { streamSid: string | null }> })
      .karaokeVoiceCallBindings.get(CALL_SID)?.streamSid).toBeNull();
    const startedStatus = await signedPost(port, '/voice/karaoke/stream-status', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, StreamSid: 'MZkaraoke',
      StreamName: streamName!, StreamEvent: 'stream-started',
    });
    expect(startedStatus.status).toBe(204);
    expect(karaoke.findRoom(ROOM)?.state()).toMatchObject({ phase: 'loading', mediaReady: false });
    expect((server as unknown as { karaokeVoiceCallBindings: Map<string, {
      lifecycle: string; mediaStarted: boolean; streamSid: string | null;
    }> }).karaokeVoiceCallBindings.get(CALL_SID)).toMatchObject({
      lifecycle: 'media-issued', mediaStarted: false, streamSid: 'MZkaraoke',
    });
    const mismatchedSidStatus = await signedPost(port, '/voice/karaoke/stream-status', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, StreamSid: 'MZdifferent',
      StreamName: streamName!, StreamEvent: 'stream-started',
    });
    expect(mismatchedSidStatus.status).toBe(403);
    const wrongStatus = await signedPost(port, '/voice/karaoke/stream-status', {
      AccountSid: 'ACwrongaccount', CallSid: CALL_SID, StreamSid: 'MZkaraoke',
      StreamName: streamName!, StreamEvent: 'stream-stopped',
    });
    expect(wrongStatus.status).toBe(403);

    const replay = await signedPost(port, '/voice/session-ended', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'in-progress',
      SessionStatus: 'completed', HandoffData: handoffData,
    });
    expect(await replay.text()).toBe(mediaXml);

    const mediaSignature = twilio.getExpectedTwilioSignature(
      AUTH_TOKEN,
      'wss://games.example/karaoke-media',
      {},
    );
    await expect(openSocket(`ws://127.0.0.1:${port}/karaoke-media`, {
      'X-Forwarded-Proto': 'https',
    })).rejects.toThrow();

    const wrongMedia = await openSocket(`ws://127.0.0.1:${port}/karaoke-media`, {
      'X-Forwarded-Proto': 'https',
      'X-Twilio-Signature': mediaSignature,
    });
    sendMediaStart(wrongMedia, customParameters, 'ACwrongaccount');
    await new Promise<void>(resolve => wrongMedia.once('close', () => resolve()));
    expect(karaoke.findRoom(ROOM)?.state()).toMatchObject({ phase: 'loading', mediaReady: false });

    const media = await openSocket(`ws://127.0.0.1:${port}/karaoke-media`, {
      'X-Forwarded-Proto': 'https',
      'X-Twilio-Signature': mediaSignature,
    });
    sendMediaStart(media, customParameters, ACCOUNT_SID);
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state()).toMatchObject({
      phase: 'countdown', displayReady: true, mediaReady: true, mediaSongStartTimestampMs: KARAOKE_COUNTDOWN_MS,
    }));
    expect(stationEngineStarted).toHaveBeenCalledTimes(1);
    expect(stationEngineStarted).toHaveBeenCalledWith('karaoke', ROOM);

    const preAuthStatus = await signedPost(port, '/voice/karaoke/stream-status', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, StreamSid: 'MZwrong',
      StreamName: streamName!, StreamEvent: 'stream-started',
    });
    expect(preAuthStatus.status).toBe(403);
    const authenticatedStatus = await signedPost(port, '/voice/karaoke/stream-status', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, StreamSid: 'MZkaraoke',
      StreamName: streamName!, StreamEvent: 'stream-started',
    });
    expect(authenticatedStatus.status).toBe(204);

    vi.setSystemTime(new Date(Date.now() + KARAOKE_COUNTDOWN_MS + KARAOKE_SONG_DURATION_MS + 1_000));
    const stopSequence = sendMediaCoverage(media);
    media.send(JSON.stringify({
      event: 'stop', sequenceNumber: String(stopSequence), streamSid: 'MZkaraoke',
      stop: { accountSid: ACCOUNT_SID, callSid: CALL_SID },
    }));
    await new Promise<void>(resolve => media.once('close', () => resolve()));
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().phase).toBe('results'));
    const leaderboard = await (await fetch(`http://127.0.0.1:${port}/api/karaoke/leaderboard?song=never-gonna-give-you-up`)).json() as { entries: Array<{ name: string; score: number }> };
    expect(leaderboard.entries).toEqual([expect.objectContaining({ name: 'Ada', score: 0 })]);
    expect(JSON.parse(await readFile(join(directory, 'karaoke-leaderboard.json'), 'utf8'))).toHaveLength(1);
    const stoppedStatus = await signedPost(port, '/voice/karaoke/stream-status', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, StreamSid: 'MZkaraoke',
      StreamName: streamName!, StreamEvent: 'stream-stopped',
    });
    expect(stoppedStatus.status).toBe(204);

    const completeParams = { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, Score: '100000' };
    const complete = await signedPost(port, '/voice/karaoke/complete', completeParams);
    const completeXml = await complete.text();
    expect(completeXml).toContain('<ConversationRelay');
    expect(completeXml).toContain('<Parameter name="game" value="karaoke"');
    expect(completeXml).toContain('<Parameter name="karaokeMode" value="result"');
    expect(karaoke.findRoom(ROOM)?.state().result?.score).toBe(0);
    expect(stationEngineCompleted).toHaveBeenCalledTimes(1);
    expect(stationEngineCompleted).toHaveBeenCalledWith('karaoke', ROOM, [expect.objectContaining({
      rank: 1, completed: true, score: 0, durationSeconds: 45,
    })]);
    expect(stationEngineAbandoned).not.toHaveBeenCalled();

    const completeReplay = await signedPost(port, '/voice/karaoke/complete', completeParams);
    expect(await completeReplay.text()).toContain('<ConversationRelay');
    expect(stationEngineCompleted).toHaveBeenCalledTimes(1);

    const lateError = await signedPost(port, '/voice/karaoke/stream-status', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, StreamSid: 'MZkaraoke',
      StreamName: streamName!, StreamEvent: 'stream-error', ErrorCode: 'late',
    });
    expect(lateError.status).toBe(204);
    expect(karaoke.findRoom(ROOM)?.state()).toMatchObject({ phase: 'results', result: { playerId: expect.any(String) } });
    expect(stationEngineCompleted).toHaveBeenCalledTimes(1);

    const ended = await signedPost(port, '/voice/session-ended', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'completed', SessionStatus: 'completed',
    });
    expect(await ended.text()).toContain('<Hangup />');
    const retryAfterCleanup = await signedPost(port, '/voice/session-ended', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'in-progress',
      SessionStatus: 'completed', HandoffData: handoffData,
    });
    expect(await retryAfterCleanup.text()).toBe(mediaXml);
  });

  it('cleans up when an authenticated stream error arrives before the media start frame', async () => {
    server = new HttpServer({
      port: 0,
      publicBaseUrl: PUBLIC_BASE_URL,
      authToken: AUTH_TOKEN,
      voiceRelayToken: AUTH_TOKEN,
      validateSignatures: true,
      standaloneVoiceEnabled: true,
      karaokeDisplayToken: DISPLAY_TOKEN,
      karaokeLeaderboardPath: join(directory, 'karaoke-leaderboard.json'),
    });
    const port = await server.start();
    const karaoke = (server as unknown as { karaoke: KaraokeServer }).karaoke;
    const { streamName } = await issueKaraokeMediaHandoff(port, karaoke);

    expect(karaoke.findRoom(ROOM)?.state()).toMatchObject({ phase: 'loading', mediaReady: false });
    const errorStatus = await signedPost(port, '/voice/karaoke/stream-status', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, StreamSid: 'MZearlyerror',
      StreamName: streamName, StreamEvent: 'stream-error', StreamError: 'WebSocket connection failed',
    });

    expect(errorStatus.status).toBe(204);
    expect(karaoke.findRoom(ROOM)).toBeUndefined();
    expect((server as unknown as { karaokeVoiceCallBindings: Map<string, unknown> })
      .karaokeVoiceCallBindings.has(CALL_SID)).toBe(false);
  });

  it('rejects a media start whose SID differs from the authenticated early callback', async () => {
    server = new HttpServer({
      port: 0,
      publicBaseUrl: PUBLIC_BASE_URL,
      authToken: AUTH_TOKEN,
      voiceRelayToken: AUTH_TOKEN,
      validateSignatures: true,
      standaloneVoiceEnabled: true,
      karaokeDisplayToken: DISPLAY_TOKEN,
      karaokeLeaderboardPath: join(directory, 'karaoke-leaderboard.json'),
    });
    const port = await server.start();
    const karaoke = (server as unknown as { karaoke: KaraokeServer }).karaoke;
    const { mediaXml, streamName } = await issueKaraokeMediaHandoff(port, karaoke);
    const startedStatus = await signedPost(port, '/voice/karaoke/stream-status', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, StreamSid: 'MZearly',
      StreamName: streamName, StreamEvent: 'stream-started',
    });
    expect(startedStatus.status).toBe(204);

    const media = await openSocket(`ws://127.0.0.1:${port}/karaoke-media`, {
      'X-Forwarded-Proto': 'https',
      'X-Twilio-Signature': twilio.getExpectedTwilioSignature(
        AUTH_TOKEN, 'wss://games.example/karaoke-media', {},
      ),
    });
    sendMediaStart(media, streamParameters(mediaXml), ACCOUNT_SID, 'MZdifferent');
    await new Promise<void>(resolve => media.once('close', () => resolve()));

    expect(karaoke.findRoom(ROOM)).toBeUndefined();
    expect((server as unknown as { karaokeVoiceCallBindings: Map<string, unknown> })
      .karaokeVoiceCallBindings.has(CALL_SID)).toBe(false);
  });

  it('trusts only direct TLS or an exact ACA HTTPS forward for an HTTPS public origin', () => {
    const request = (headers: Record<string, string>, encrypted = false) => ({
      headers,
      socket: { encrypted },
    }) as unknown as IncomingMessage;
    expect(isSecureKaraokeMediaRequest(request({}, true), 'https://games.example')).toBe(true);
    expect(isSecureKaraokeMediaRequest(request({ 'x-forwarded-proto': 'https' }), 'https://games.example')).toBe(true);
    expect(isSecureKaraokeMediaRequest(request({ 'x-forwarded-proto': 'https,http' }), 'https://games.example')).toBe(false);
    expect(isSecureKaraokeMediaRequest(request({ 'x-forwarded-proto': 'https' }), 'http://localhost')).toBe(false);
    expect(isSecureKaraokeMediaRequest(request({}), 'https://games.example')).toBe(false);
  });

  it('returns bounded retry TwiML when /complete arrives before media scoring finishes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));
    const arcadeApi = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      activateMessagingDelivery: vi.fn(async () => undefined),
      getHealthStatus: vi.fn(() => ({ degraded: false })),
      isStationEngineRoom: vi.fn(() => false),
      requiresStationVoiceAssignment: vi.fn(() => false),
      setStationAbortHandler: vi.fn(),
      setStationParticipantCountHandler: vi.fn(),
      setPlayerResetCleanupHandler: vi.fn(),
      stationEngineStarted: vi.fn(),
      stationEngineCompleted: vi.fn(),
      stationEngineAbandoned: vi.fn(),
      stationVoiceCallEnded: vi.fn(),
      voiceLocaleForNumber: vi.fn(() => 'en-US'),
      standaloneVoiceAvailable: vi.fn(() => true),
      standaloneGameEnabled: vi.fn(() => true),
    } as unknown as ArcadeApi;
    server = new HttpServer({
      port: 0,
      publicBaseUrl: PUBLIC_BASE_URL,
      authToken: AUTH_TOKEN,
      voiceRelayToken: AUTH_TOKEN,
      validateSignatures: true,
      standaloneVoiceEnabled: true,
      arcadeApi,
      karaokeDisplayToken: DISPLAY_TOKEN,
      karaokeLeaderboardPath: join(directory, 'karaoke-leaderboard.json'),
    });
    const port = await server.start();
    const karaoke = (server as unknown as { karaoke: KaraokeServer }).karaoke;
    const display = await openSocket(`ws://127.0.0.1:${port}/karaoke?display=1`, {
      Origin: PUBLIC_BASE_URL,
    });
    display.send(JSON.stringify({ type: 'display_auth', roomCode: ROOM, token: DISPLAY_TOKEN }));
    display.send(JSON.stringify({ type: 'spectate', roomCode: ROOM }));
    await waitForSocketMessage(display, message => message.type === 'host_identity' && message.isHost === true);
    const incoming = await signedPost(port, '/voice/incoming', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, From: '+14155550199', To: '+18555993809',
    });
    expect(await incoming.text()).toContain(`<Parameter name="roomCode" value="${ROOM}"`);

    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, 'wss://games.example/voice', {});
    const voice = await openSocket(`ws://127.0.0.1:${port}/voice`, { 'X-Twilio-Signature': signature });
    let handoffData = '';
    const relayMessages: Record<string, unknown>[] = [];
    voice.on('message', data => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      relayMessages.push(message);
      if (message.type === 'text') {
        voice.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: message.token }));
      } else if (message.type === 'end') handoffData = String(message.handoffData);
    });
    voice.send(JSON.stringify({
      type: 'setup', callSid: CALL_SID,
      customParameters: {
        roomCode: ROOM, game: 'karaoke', locale: 'en-US', commandLocale: 'en-US', relayToken: AUTH_TOKEN,
      },
    }));
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().phase).toBe('lobby'));
    voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Ada', last: true }));
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().phase).toBe('song_select'));
    voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Never Gonna Give You Up', last: true }));
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().selectedSong).not.toBeNull());
    await waitForConsentPlayback(relayMessages);
    voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'start', last: true }));
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().phase).toBe('loading'));
    display.send(JSON.stringify({
      type: 'ready', loadingGeneration: karaoke.findRoom(ROOM)!.state().loadingGeneration,
    }));
    await vi.waitFor(() => expect(handoffData).not.toBe(''));
    voice.close();
    await new Promise<void>(resolve => voice.once('close', () => resolve()));
    const handoff = await signedPost(port, '/voice/session-ended', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'in-progress',
      SessionStatus: 'completed', HandoffData: handoffData,
    });
    const mediaXml = await handoff.text();
    expect(mediaXml).toContain('<Start>');
    const media = await openSocket(`ws://127.0.0.1:${port}/karaoke-media`, {
      'X-Forwarded-Proto': 'https',
      'X-Twilio-Signature': twilio.getExpectedTwilioSignature(
        AUTH_TOKEN, 'wss://games.example/karaoke-media', {},
      ),
    });
    expect(karaoke.findRoom(ROOM)?.state()).toMatchObject({ phase: 'loading', displayReady: true });
    expect((server as unknown as { karaokeVoiceCallBindings: Map<string, { lifecycle: string }> })
      .karaokeVoiceCallBindings.get(CALL_SID)).toMatchObject({ lifecycle: 'media-issued' });
    sendMediaStart(media, streamParameters(mediaXml), ACCOUNT_SID);
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state()).toMatchObject({
      phase: 'countdown', mediaReady: true,
    }));
    vi.setSystemTime(new Date(Date.now() + KARAOKE_COUNTDOWN_MS + KARAOKE_SONG_DURATION_MS + 1_000));
    const stopSequence = sendMediaCoverage(media);

    const earlyComplete = await signedPost(port, '/voice/karaoke/complete', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID,
    });
    const retryXml = await earlyComplete.text();
    expect(retryXml).toContain('<Pause length="1" />');
    expect(retryXml).toContain('<Redirect method="POST">https://games.example/voice/karaoke/complete</Redirect>');
    expect(retryXml).not.toContain('<Hangup />');
    expect(karaoke.findRoom(ROOM)).toBeDefined();
    const earlyReplay = await signedPost(port, '/voice/karaoke/complete', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID,
    });
    expect(await earlyReplay.text()).toBe(retryXml);

    media.send(JSON.stringify({
      event: 'stop', sequenceNumber: String(stopSequence), streamSid: 'MZkaraoke',
      stop: { accountSid: ACCOUNT_SID, callSid: CALL_SID },
    }));
    await new Promise<void>(resolve => media.once('close', () => resolve()));
    await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().phase).toBe('results'));
    const complete = await signedPost(port, '/voice/karaoke/complete', {
      AccountSid: ACCOUNT_SID, CallSid: CALL_SID,
    });
    expect(await complete.text()).toContain('<ConversationRelay');
  });
});

describe('station Karaoke result Relay retirement', () => {
  it('keeps score and requeue speech alive across station retirement until both lines play', async () => {
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      karaokeLeaderboardPath: join(directory, 'karaoke-leaderboard.json') });
    await server.start();
    const roomCode = 'KARAOKE-RESULT-DRAIN';
    const { karaoke, socket, messages, retire } = attachStationResultRelay(server, roomCode);

    await vi.waitFor(() => expect(messages.filter(message => message.type === 'text')).toHaveLength(1));
    retire(); // Called by the station after its RESULTS display deadline.
    expect(karaoke.findRoom(roomCode)).toBeDefined();

    const scoreToken = String(messages.find(message => message.type === 'text')?.token ?? '');
    expect(scoreToken).toContain('score is 900');
    expect(handleRelayPlaybackEvent(socket, JSON.stringify({
      type: 'info', name: 'tokensPlayed', value: scoreToken,
    }))).toBe(true);
    await vi.waitFor(() => expect(messages.filter(message => message.type === 'text')).toHaveLength(2));
    expect(karaoke.findRoom(roomCode)).toBeDefined();

    const requeueToken = String(messages.filter(message => message.type === 'text')[1]?.token ?? '');
    expect(requeueToken).toContain('check your messages');
    handleRelayPlaybackEvent(socket, JSON.stringify({
      type: 'info', name: 'tokensPlayed', value: requeueToken,
    }));
    await vi.waitFor(() => expect(karaoke.findRoom(roomCode)).toBeUndefined());
    await vi.waitFor(() => expect(messages.filter(message => message.type === 'end')).toHaveLength(1),
      { timeout: 2_000 });
  });

  it('caps stalled result speech, ends Relay, and cannot send old lines into a replacement room', async () => {
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      karaokeLeaderboardPath: join(directory, 'karaoke-leaderboard.json') });
    await server.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const roomCode = 'KARAOKE-RESULT-STALL';
    const { karaoke, socket, messages, retire } = attachStationResultRelay(server, roomCode);
    await flushMicrotasks();
    retire();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(karaoke.findRoom(roomCode)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(karaoke.findRoom(roomCode)).toBeUndefined();

    const textCount = messages.filter(message => message.type === 'text').length;
    const replacement = karaoke.getOrCreateRoom(roomCode);
    const oldToken = String(messages.find(message => message.type === 'text')?.token ?? '');
    handleRelayPlaybackEvent(socket, JSON.stringify({
      type: 'info', name: 'tokensPlayed', value: oldToken,
    }));
    await flushMicrotasks();
    expect(karaoke.findRoom(roomCode)).toBe(replacement);
    expect(messages.filter(message => message.type === 'text')).toHaveLength(textCount);

    await vi.advanceTimersByTimeAsync(750);
    expect(messages.filter(message => message.type === 'end')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(karaoke.findRoom(roomCode)).toBe(replacement);
    expect(messages.filter(message => message.type === 'text')).toHaveLength(textCount);
  });
});

function attachStationResultRelay(http: HttpServer, roomCode: string) {
  const karaoke = (http as unknown as { karaoke: KaraokeServer }).karaoke;
  karaoke.getOrCreateRoom(roomCode);
  const messages: Record<string, unknown>[] = [];
  const socket = {
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    send: (data: string, callback?: (error?: Error) => void) => {
      messages.push(JSON.parse(data) as Record<string, unknown>);
      callback?.();
    },
    terminate: vi.fn(),
  } as unknown as WebSocket;
  const snapshot: KaraokeVoiceSnapshot = {
    phase: 'results', myName: 'Ada', nameConfirmed: true, catalog: [], selectedSong: null,
    selectedByPlayerId: 'singer', selectionGeneration: 1, loadingGeneration: 1,
    displayReady: true, score: 900, bestCombo: 3,
    result: { generation: 1, score: 900, bestCombo: 3 },
  };
  const session = new KaraokeVoiceSession({
    bind: () => ({ playerId: 'singer', resumed: false }),
    leave: vi.fn(), setName: vi.fn(() => false), selectSong: vi.fn(() => false),
    advance: vi.fn(() => false), snapshot: () => snapshot,
    say: (text, guard) => sendRelayTextOutcome(socket, text, 'en-US', guard),
    requestMediaHandoff: vi.fn(),
  });
  session.setStationManaged(true);
  session.handleMessage(JSON.stringify({
    type: 'setup', callSid: 'CA-result-relay',
    customParameters: { roomCode, commandLocale: 'en-US' },
  }));
  const internals = http as unknown as {
    karaokeVoice: Map<string, Set<KaraokeVoiceSession>>;
    voiceSockets: Map<WebSocket, () => { game: 'karaoke'; roomCode: string } | null>;
    retireStationEngine(game: 'karaoke', roomCode: string): void;
  };
  internals.karaokeVoice.set(roomCode, new Set([session]));
  internals.voiceSockets.set(socket, () => session.boundRoomCode ? { game: 'karaoke', roomCode } : null);
  return { karaoke, socket, messages,
    retire: () => internals.retireStationEngine('karaoke', roomCode) };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

async function openSocket(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function waitForSocketMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket message timeout')), 2_000);
    const listener = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off('message', listener);
      resolve(message);
    };
    socket.on('message', listener);
  });
}

async function signedPost(port: number, pathname: string, params: Record<string, string>): Promise<Response> {
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${pathname}`, params);
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: new URLSearchParams(params),
  });
}

function streamParameters(xml: string): Record<string, string> {
  return Object.fromEntries([...xml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)" \/>/g)]
    .map(match => [match[1]!, match[2]!]));
}

function sendMediaStart(
  socket: WebSocket,
  parameters: Record<string, string>,
  accountSid: string,
  streamSid = 'MZkaraoke',
): void {
  socket.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  socket.send(JSON.stringify({
    event: 'start', sequenceNumber: '1', streamSid,
    start: {
      accountSid, callSid: CALL_SID, streamSid, tracks: ['inbound'],
      customParameters: parameters,
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8_000, channels: 1 },
    },
  }));
}

function sendMediaCoverage(socket: WebSocket): number {
  const silence = Buffer.alloc(8_000, 0xff).toString('base64');
  const mediaSeconds = (KARAOKE_COUNTDOWN_MS + KARAOKE_SONG_DURATION_MS) / 1_000;
  for (let second = 0; second < mediaSeconds; second += 1) {
    socket.send(JSON.stringify({
      event: 'media', sequenceNumber: String(second + 2), streamSid: 'MZkaraoke',
      media: { track: 'inbound', chunk: String(second + 1), timestamp: String(second * 1_000), payload: silence },
    }));
  }
  return mediaSeconds + 2;
}

async function issueKaraokeMediaHandoff(
  port: number,
  karaoke: KaraokeServer,
): Promise<{ mediaXml: string; streamName: string }> {
  const display = await openSocket(`ws://127.0.0.1:${port}/karaoke?display=1`, { Origin: PUBLIC_BASE_URL });
  display.send(JSON.stringify({ type: 'display_auth', roomCode: ROOM, token: DISPLAY_TOKEN }));
  display.send(JSON.stringify({ type: 'spectate', roomCode: ROOM }));
  await waitForSocketMessage(display, message => message.type === 'host_identity' && message.isHost === true);
  const incoming = await signedPost(port, '/voice/incoming', {
    AccountSid: ACCOUNT_SID, CallSid: CALL_SID, From: '+14155550199', To: '+18555993809',
  });
  expect(await incoming.text()).toContain(`<Parameter name="roomCode" value="${ROOM}"`);

  const voice = await openSocket(`ws://127.0.0.1:${port}/voice`, {
    'X-Twilio-Signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, 'wss://games.example/voice', {}),
  });
  let handoffData = '';
  const relayMessages: Record<string, unknown>[] = [];
  voice.on('message', data => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    relayMessages.push(message);
    if (message.type === 'text') {
      voice.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: message.token }));
    } else if (message.type === 'end') handoffData = String(message.handoffData);
  });
  voice.send(JSON.stringify({
    type: 'setup', callSid: CALL_SID,
    customParameters: {
      roomCode: ROOM, game: 'karaoke', locale: 'en-US', commandLocale: 'en-US', relayToken: AUTH_TOKEN,
    },
  }));
  await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().phase).toBe('lobby'));
  voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Ada', last: true }));
  await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().phase).toBe('song_select'));
  voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Never Gonna Give You Up', last: true }));
  await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().selectedSong).not.toBeNull());
  await waitForConsentPlayback(relayMessages);
  voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'start', last: true }));
  await vi.waitFor(() => expect(karaoke.findRoom(ROOM)?.state().phase).toBe('loading'));
  display.send(JSON.stringify({
    type: 'ready', loadingGeneration: karaoke.findRoom(ROOM)!.state().loadingGeneration,
  }));
  await vi.waitFor(() => expect(handoffData).not.toBe(''));
  voice.close();
  await new Promise<void>(resolve => voice.once('close', () => resolve()));

  const handoff = await signedPost(port, '/voice/session-ended', {
    AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: 'in-progress',
    SessionStatus: 'completed', HandoffData: handoffData,
  });
  const mediaXml = await handoff.text();
  const streamName = /<Stream name="([^"]+)"/.exec(mediaXml)?.[1];
  expect(streamName).toBeTruthy();
  return { mediaXml, streamName: streamName! };
}

async function waitForConsentPlayback(messages: readonly Record<string, unknown>[]): Promise<void> {
  await vi.waitFor(() => expect(messages.some(message => message.type === 'text'
    && /consent/i.test(String(message.token ?? '')))).toBe(true), { timeout: 5_000 });
  await new Promise(resolve => setTimeout(resolve, 20));
}
