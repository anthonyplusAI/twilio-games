import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import { KaraokeServer, KARAOKE_RECONNECT_GRACE_MS } from '../server/karaoke-server';
import { KaraokeRoom } from '../server/karaoke-room';
import { NEVER_GONNA_GIVE_YOU_UP, PT_BR_ORIGINAL_DEVELOPMENT_SONG } from '../shared/karaoke-songs';
import { KARAOKE_SONG_DURATION_MS, parseKaraokeSong } from '../shared/karaoke';
import { KARAOKE_COUNTDOWN_MS } from '../shared/karaoke-protocol';

type Message = Record<string, unknown>;
interface Client { ws: WebSocket; messages: Message[]; }

let http: Server | undefined;
let karaoke: KaraokeServer | undefined;
const clients: Client[] = [];
const serverSockets: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  serverSockets.length = 0;
  karaoke?.stopLoopOnly();
  karaoke = undefined;
  if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
  http = undefined;
});

async function start(options: ConstructorParameters<typeof KaraokeServer>[0] = {}): Promise<number> {
  http = createServer();
  karaoke = new KaraokeServer({ server: http, ...options });
  http.on('upgrade', (request, socket, head) => karaoke!.handleUpgrade(request, socket, head,
    ws => serverSockets.push(ws)));
  await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return address.port;
}

async function connect(port: number): Promise<Client> {
  const client: Client = { ws: new WebSocket(`ws://127.0.0.1:${port}/karaoke`), messages: [] };
  client.ws.on('message', data => client.messages.push(JSON.parse(data.toString()) as Message));
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.ws.once('open', resolve);
    client.ws.once('error', reject);
  });
  return client;
}

function send(client: Client, message: unknown): void {
  client.ws.send(JSON.stringify(message));
}

async function waitFor(client: Client, predicate: (message: Message) => boolean, timeoutMs = 1_500): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = client.messages.length - 1; index >= 0; index--) {
      const message = client.messages[index]!;
      if (predicate(message)) return message;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`message not received: ${JSON.stringify(client.messages)}`);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

async function finishVoiceRound(code: string, singer: string, display: Client, now: { value: number }): Promise<void> {
  expect(karaoke!.voiceAdvance(code, singer)).toBe(true);
  expect(karaoke!.voiceSelectSong(code, singer, NEVER_GONNA_GIVE_YOU_UP.id)).toBe(true);
  expect(karaoke!.voiceAdvance(code, singer)).toBe(true);
  const generation = karaoke!.findRoom(code)!.state().loadingGeneration;
  send(display, { type: 'ready', loadingGeneration: generation });
  await waitFor(display, message => message.type === 'karaoke_state'
    && message.phase === 'loading' && message.displayReady === true);
  expect(karaoke!.markMediaReady(code, singer, NEVER_GONNA_GIVE_YOU_UP.id,
    generation, KARAOKE_COUNTDOWN_MS)).toBe(true);
  now.value = KARAOKE_COUNTDOWN_MS + KARAOKE_SONG_DURATION_MS;
  const hits = NEVER_GONNA_GIVE_YOU_UP.chart.words.map((word, index) => ({
    wordId: word.id, judgment: index === 0 ? 'perfect' as const : 'miss' as const,
    points: index === 0 ? 1_000 : 0,
  }));
  expect(karaoke!.finalizeMediaScore(code, singer, 1_000, hits)).toBe(true);
  await waitFor(display, message => message.type === 'karaoke_state' && message.phase === 'results');
}

describe('KaraokeServer authority and lifecycle', () => {
  it('counts only a currently bound standalone display as voice-routing presence', async () => {
    const port = await start();
    const display = await connect(port);
    const serverWs = serverSockets.at(-1)!;
    expect(karaoke!.hasStandaloneDisplay(serverWs, '4821')).toBe(false);

    send(display, { type: 'spectate', roomCode: '4821' });
    await waitFor(display, message => message.type === 'karaoke_state' && message.roomCode === '4821');
    expect(karaoke!.hasStandaloneDisplay(serverWs, '4821')).toBe(true);

    send(display, { type: 'spectate', roomCode: 'OTHER' });
    await waitFor(display, message => message.type === 'karaoke_state' && message.roomCode === 'OTHER');
    expect(karaoke!.hasStandaloneDisplay(serverWs, '4821')).toBe(false);
    expect(karaoke!.hasStandaloneDisplay(serverWs, 'OTHER')).toBe(true);

    send(display, { type: 'leave' });
    for (let attempt = 0; attempt < 50 && karaoke!.hasStandaloneDisplay(serverWs, 'OTHER'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(karaoke!.hasStandaloneDisplay(serverWs, 'OTHER')).toBe(false);
  });

  it('counts an authenticated display only after it binds the requested room', async () => {
    const port = await start({ displayToken: 'secret' });
    karaoke!.setDisplayAuthenticationRequirement(() => true);
    const display = await connect(port);
    const serverWs = serverSockets.at(-1)!;

    send(display, { type: 'spectate', roomCode: '4821' });
    await waitFor(display, message => message.type === 'error' && message.code === 'bad_display_auth');
    expect(karaoke!.hasStandaloneDisplay(serverWs, '4821')).toBe(false);

    send(display, { type: 'display_auth', roomCode: '4821', token: 'secret' });
    expect(karaoke!.hasStandaloneDisplay(serverWs, '4821')).toBe(false);
    send(display, { type: 'spectate', roomCode: '4821' });
    await waitFor(display, message => message.type === 'karaoke_state' && message.roomCode === '4821');
    expect(karaoke!.hasStandaloneDisplay(serverWs, '4821')).toBe(true);
    expect(karaoke!.hasStandaloneDisplay(serverWs, 'OTHER')).toBe(false);
  });

  it('returns an RTT-compatible authoritative clock sample before room setup', async () => {
    const port = await start({ now: () => 30_100 });
    const client = await connect(port);
    send(client, { type: 'clock_sync', clientSentAtMs: 20_000 });

    await expect(waitFor(client, message => message.type === 'clock_sync')).resolves.toEqual({
      type: 'clock_sync', clientSentAtMs: 20_000, serverNowMs: 30_100,
    });
  });

  it('advertises display auth and sends a locale-appropriate catalog', async () => {
    const port = await start({ displayToken: 'secret' });
    const display = await connect(port);
    await waitFor(display, message => message.type === 'karaoke_capabilities' && message.displayAuth === true);
    send(display, { type: 'spectate', roomCode: 'BR', locale: 'pt-BR' });
    const catalog = await waitFor(display, message => message.type === 'karaoke_catalog'
      && message.locale === 'pt-BR');
    expect((catalog.songs as { id: string }[]).map(song => song.id)).toEqual([PT_BR_ORIGINAL_DEVELOPMENT_SONG.id]);
    expect(karaoke!.preferredLocale(' br ')).toBe('pt-BR');
  });

  it('accepts server-timed lanes only from a hidden local host tester', async () => {
    let now = 0;
    const port = await start({ now: () => now, songs: [NEVER_GONNA_GIVE_YOU_UP], tickMs: 5 });
    const host = await connect(port);
    send(host, { type: 'spectate', roomCode: 'KEYS' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(host, { type: 'join', roomCode: 'KEYS', name: 'Keyboard Singer', sessionId: 'keyboard-test' });
    const joined = await waitFor(host, message => message.type === 'joined');
    const playerId = joined.playerId as string;
    send(host, { type: 'advance' });
    await waitFor(host, message => message.type === 'karaoke_state' && message.phase === 'song_select');
    send(host, { type: 'select_song', songId: NEVER_GONNA_GIVE_YOU_UP.id });
    await waitFor(host, message => message.type === 'karaoke_state' && message.selectedSong !== null);
    send(host, { type: 'advance' });
    const loading = await waitFor(host, message => message.type === 'karaoke_state' && message.phase === 'loading');
    send(host, { type: 'ready', loadingGeneration: loading.loadingGeneration });
    const countdown = await waitFor(host, message => message.type === 'karaoke_state' && message.phase === 'countdown');
    now = countdown.countdownEndsAtMs as number;
    await waitFor(host, message => message.type === 'karaoke_state' && message.phase === 'performing');
    const first = NEVER_GONNA_GIVE_YOU_UP.chart.words[0]!;
    now = (countdown.countdownEndsAtMs as number) + first.startMs;
    send(host, { type: 'lane_input', lane: first.lane });
    const events = await waitFor(host, message => message.type === 'karaoke_events'
      && (message.events as { type: string }[]).some(event => event.type === 'word_judgment'));
    expect(events.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'word_judgment', wordId: first.id, judgment: 'perfect' }),
    ]));
    expect(karaoke!.findRoom('KEYS')!.state()).toMatchObject({
      singer: { playerId }, score: expect.any(Number), combo: 1,
    });
  });

  it('applies catalog timing changes to future selections without mutating an existing selection', async () => {
    await start({ songs: [NEVER_GONNA_GIVE_YOU_UP] });
    const singer = karaoke!.voiceJoin('OLD', 'Ada')!;
    expect(karaoke!.voiceAdvance('OLD', singer)).toBe(true);
    expect(karaoke!.voiceSelectSong('OLD', singer, NEVER_GONNA_GIVE_YOU_UP.id)).toBe(true);
    const originalStart = NEVER_GONNA_GIVE_YOU_UP.chart.words[0]!.startMs;
    const retimed = parseKaraokeSong({
      ...NEVER_GONNA_GIVE_YOU_UP,
      chart: {
        ...NEVER_GONNA_GIVE_YOU_UP.chart,
        words: NEVER_GONNA_GIVE_YOU_UP.chart.words.map((word, index) => (
          index === 0 ? { ...word, startMs: word.startMs + 20 } : word
        )),
      },
    });
    karaoke!.setSongs([retimed]);
    expect(karaoke!.findRoom('OLD')!.state().selectedSong!.chart.words[0]!.startMs).toBe(originalStart);

    const nextSinger = karaoke!.voiceJoin('NEW', 'Grace')!;
    expect(karaoke!.voiceAdvance('NEW', nextSinger)).toBe(true);
    expect(karaoke!.voiceSelectSong('NEW', nextSinger, retimed.id)).toBe(true);
    expect(karaoke!.findRoom('NEW')!.state().selectedSong!.chart.words[0]!.startMs).toBe(originalStart + 20);
  });

  it('lets an authenticated shared display select a song without granting caller consent', async () => {
    const port = await start({ displayToken: 'secret' });
    karaoke!.setBrowserPlayerAdmission(code => code !== 'PAID');
    karaoke!.setDisplayAuthenticationRequirement(code => code === 'PAID');
    const singer = karaoke!.voiceJoin('paid', 'Caller', 1, false)!;
    const display = await connect(port);
    send(display, { type: 'spectate', roomCode: 'PAID', locale: 'pt-BR' });
    await waitFor(display, message => message.type === 'error' && message.code === 'bad_display_auth');
    send(display, { type: 'display_auth', roomCode: 'PAID', token: 'wrong' });
    await waitFor(display, message => message.type === 'error' && message.code === 'bad_display_auth');
    send(display, { type: 'display_auth', roomCode: 'PAID', token: 'secret' });
    send(display, { type: 'spectate', roomCode: 'PAID', locale: 'pt-BR' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);

    expect(karaoke!.voiceAdvance('PAID', singer)).toBe(false);
    karaoke!.voiceSetName('PAID', singer, 'Ada');
    expect(karaoke!.voiceAdvance('PAID', singer)).toBe(true);
    send(display, { type: 'select_song', songId: PT_BR_ORIGINAL_DEVELOPMENT_SONG.id });
    await waitFor(display, message => message.type === 'karaoke_state'
      && (message.selectedSong as { id?: string } | null)?.id === PT_BR_ORIGINAL_DEVELOPMENT_SONG.id);
    expect(karaoke!.findRoom('PAID')!.state().selectedByPlayerId).toBe(singer);
    send(display, { type: 'advance' });
    await waitFor(display, message => message.type === 'error' && message.code === 'not_ready');
    expect(karaoke!.findRoom('PAID')!.state().phase).toBe('song_select');
    expect(karaoke!.voiceAdvance('PAID', singer)).toBe(true);
    const generation = karaoke!.findRoom('PAID')!.state().loadingGeneration;
    send(display, { type: 'ready', loadingGeneration: generation + 1 });
    await waitFor(display, message => message.type === 'error' && message.code === 'stale_ready');
    send(display, { type: 'ready', loadingGeneration: generation });
    await waitFor(display, message => message.type === 'karaoke_state'
      && message.phase === 'loading' && message.displayReady === true && message.mediaReady === false);
    expect(karaoke!.markMediaReady(
      'PAID', singer, PT_BR_ORIGINAL_DEVELOPMENT_SONG.id, generation, KARAOKE_COUNTDOWN_MS,
    )).toBe(true);
    await waitFor(display, message => message.type === 'karaoke_state' && message.phase === 'countdown');
  });

  it('lets only the elected standalone display replay a singer result without joining as a player', async () => {
    const now = { value: 0 };
    const port = await start({ now: () => now.value, tickMs: 5 });
    const singer = karaoke!.voiceJoin('TOUCH-REPLAY', 'Ada')!;
    const host = await connect(port);
    send(host, { type: 'spectate', roomCode: 'TOUCH-REPLAY' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    const nonhost = await connect(port);
    send(nonhost, { type: 'spectate', roomCode: 'TOUCH-REPLAY' });
    await waitFor(nonhost, message => message.type === 'host_identity' && message.isHost === false);
    await finishVoiceRound('TOUCH-REPLAY', singer, host, now);

    send(nonhost, { type: 'advance' });
    await waitFor(nonhost, message => message.type === 'error' && message.code === 'forbidden');
    expect(karaoke!.findRoom('TOUCH-REPLAY')!.phase).toBe('results');

    send(host, { type: 'advance' });
    await waitUntil(() => karaoke!.findRoom('TOUCH-REPLAY')!.phase === 'song_select');
    expect(karaoke!.findRoom('TOUCH-REPLAY')!.state().result).toBeNull();
  });

  it('keeps authenticated station result replay locked on the elected display', async () => {
    const now = { value: 0 };
    const port = await start({ displayToken: 'secret', now: () => now.value, tickMs: 5 });
    karaoke!.setDisplayAuthenticationRequirement(code => code === 'STATION-REPLAY');
    const singer = karaoke!.voiceJoin('STATION-REPLAY', 'Ada')!;
    const host = await connect(port);
    send(host, { type: 'display_auth', roomCode: 'STATION-REPLAY', token: 'secret' });
    send(host, { type: 'spectate', roomCode: 'STATION-REPLAY' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    await finishVoiceRound('STATION-REPLAY', singer, host, now);

    send(host, { type: 'advance' });
    await waitFor(host, message => message.type === 'error' && message.code === 'station_requeue_required');
    expect(karaoke!.findRoom('STATION-REPLAY')!.phase).toBe('results');
  });

  it('does not treat standalone host capability as station authentication', async () => {
    const port = await start({ displayToken: 'secret' });
    karaoke!.setBrowserPlayerAdmission(code => code !== 'PAID');
    karaoke!.setDisplayAuthenticationRequirement(code => code === 'PAID');
    const display = await connect(port);
    send(display, { type: 'spectate', roomCode: 'FREE' });
    await waitFor(display, message => message.type === 'host_identity'
      && message.roomCode === 'FREE' && message.isHost === true);
    send(display, { type: 'spectate', roomCode: 'PAID' });
    await waitFor(display, message => message.type === 'error' && message.code === 'bad_display_auth');
    expect(karaoke!.findRoom('PAID')).toBeUndefined();
  });

  it('allows an unauthenticated standalone display while browser singers remain disabled', async () => {
    const port = await start({ displayToken: 'secret' });
    karaoke!.setBrowserPlayerAdmission(() => false);
    karaoke!.setDisplayAuthenticationRequirement(code => code === 'PAID');
    const display = await connect(port);
    send(display, { type: 'spectate', roomCode: 'FREE' });
    await waitFor(display, message => message.type === 'host_identity'
      && message.roomCode === 'FREE' && message.isHost === true);
    send(display, { type: 'join', roomCode: 'FREE', name: 'Browser singer' });
    await waitFor(display, message => message.type === 'error' && message.code === 'station_voice_only');
  });

  it('atomically replaces an authenticated host without invalidating an active countdown', async () => {
    const port = await start({ displayToken: 'secret' });
    karaoke!.setBrowserPlayerAdmission(() => false);
    karaoke!.setDisplayAuthenticationRequirement(() => true);
    const singer = karaoke!.voiceJoin('LOSS', 'Ada')!;
    karaoke!.voiceAdvance('LOSS', singer);
    karaoke!.voiceSelectSong('LOSS', singer, NEVER_GONNA_GIVE_YOU_UP.id);
    karaoke!.voiceAdvance('LOSS', singer);
    const display = await connect(port);
    send(display, { type: 'display_auth', roomCode: 'LOSS', token: 'secret' });
    send(display, { type: 'spectate', roomCode: 'LOSS' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);
    const generation = karaoke!.findRoom('LOSS')!.state().loadingGeneration;
    send(display, { type: 'ready', loadingGeneration: generation });
    expect(karaoke!.markMediaReady(
      'LOSS', singer, NEVER_GONNA_GIVE_YOU_UP.id, generation, KARAOKE_COUNTDOWN_MS,
    )).toBe(true);
    await waitFor(display, message => message.type === 'karaoke_state' && message.phase === 'countdown');
    const replacement = await connect(port);
    send(replacement, { type: 'display_auth', roomCode: 'LOSS', token: 'secret' });
    send(replacement, { type: 'spectate', roomCode: 'LOSS' });
    await waitFor(replacement, message => message.type === 'host_identity' && message.isHost === true);
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === false);
    const closed = new Promise<void>(resolve => display.ws.once('close', () => resolve()));
    display.ws.close();
    await closed;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(karaoke!.findRoom('LOSS')!.state()).toMatchObject({
      phase: 'countdown', loadingGeneration: generation, displayReady: true, mediaReady: true,
    });
  });

  it('keeps absolute performance timing and singer identity across session reconnect', async () => {
    const port = await start({
      reconnectGraceMs: 250,
      tickMs: 5,
      roomFactory: (code, options) => new KaraokeRoom(code, { ...options, countdownMs: 20 }),
    });
    const first = await connect(port);
    send(first, { type: 'spectate', roomCode: 'STABLE' });
    await waitFor(first, message => message.type === 'host_identity' && message.isHost === true);
    send(first, { type: 'join', roomCode: 'STABLE', name: 'Ada', sessionId: 'stable-session' });
    const joined = await waitFor(first, message => message.type === 'joined');
    send(first, { type: 'advance' });
    await waitFor(first, message => message.type === 'karaoke_state' && message.phase === 'song_select');
    send(first, { type: 'select_song', songId: NEVER_GONNA_GIVE_YOU_UP.id });
    await waitFor(first, message => message.type === 'karaoke_state' && message.selectedByPlayerId === joined.playerId);
    send(first, { type: 'advance' });
    const loading = await waitFor(first, message => message.type === 'karaoke_state' && message.phase === 'loading');
    send(first, { type: 'ready', loadingGeneration: loading.loadingGeneration });
    const performing = await waitFor(first, message => message.type === 'karaoke_state' && message.phase === 'performing');
    const timing = {
      performanceStartedAtMs: performing.performanceStartedAtMs,
      performanceEndsAtMs: performing.performanceEndsAtMs,
    };
    const closed = new Promise<void>(resolve => first.ws.once('close', () => resolve()));
    first.ws.close();
    await closed;
    expect(karaoke!.findRoom('STABLE')?.hasPlayer(joined.playerId as string)).toBe(true);

    const resumed = await connect(port);
    send(resumed, { type: 'join', roomCode: 'STABLE', name: 'ignored', sessionId: 'stable-session' });
    expect((await waitFor(resumed, message => message.type === 'joined')).playerId).toBe(joined.playerId);
    const state = await waitFor(resumed, message => message.type === 'karaoke_state' && message.phase === 'performing');
    expect(state).toMatchObject(timing);
    await waitFor(resumed, message => message.type === 'host_identity' && message.isHost === true);
  });

  it('rejects browser score submissions while trusted score and hit APIs emit updates', async () => {
    const port = await start({
      tickMs: 5,
      roomFactory: (code, options) => new KaraokeRoom(code, { ...options, countdownMs: 20 }),
    });
    const host = await connect(port);
    send(host, { type: 'spectate', roomCode: 'SCORE' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(host, { type: 'join', roomCode: 'SCORE', name: 'Ada' });
    const joined = await waitFor(host, message => message.type === 'joined');
    send(host, { type: 'advance' });
    await waitFor(host, message => message.phase === 'song_select');
    send(host, { type: 'select_song', songId: NEVER_GONNA_GIVE_YOU_UP.id });
    await waitFor(host, message => message.selectedByPlayerId === joined.playerId);
    send(host, { type: 'advance' });
    const loading = await waitFor(host, message => message.phase === 'loading');
    send(host, { type: 'ready', loadingGeneration: loading.loadingGeneration });
    await waitFor(host, message => message.phase === 'performing');

    send(host, { type: 'score', score: 100_000 });
    await waitFor(host, message => message.type === 'error' && message.code === 'unknown_type');
    expect(karaoke!.findRoom('SCORE')!.state().score).toBe(0);
    expect(karaoke!.updateScore('SCORE', joined.playerId as string, 12_345)).toBe(true);
    const wordId = NEVER_GONNA_GIVE_YOU_UP.chart.words[0]!.id;
    expect(karaoke!.recordWordJudgment('SCORE', joined.playerId as string, wordId, 'perfect', 500)).toBe(true);
    expect(karaoke!.recordWordJudgment('SCORE', joined.playerId as string, wordId, 'perfect', 500)).toBe(false);
    await waitFor(host, message => message.type === 'karaoke_events'
      && (message.events as { type: string }[]).some(event => event.type === 'word_judgment'));
    expect(karaoke!.findRoom('SCORE')!.state()).toMatchObject({ score: 12_845, combo: 1 });
  });

  it('holds sessions for the 30-second production grace and releases an expired test session', async () => {
    expect(KARAOKE_RECONNECT_GRACE_MS).toBe(30_000);
    const port = await start({ reconnectGraceMs: 40 });
    const singer = await connect(port);
    send(singer, { type: 'join', roomCode: 'GRACE', name: 'Ada', sessionId: 'expires' });
    const joined = await waitFor(singer, message => message.type === 'joined');
    const closed = new Promise<void>(resolve => singer.ws.once('close', () => resolve()));
    singer.ws.close();
    await closed;
    expect(karaoke!.findRoom('GRACE')?.hasPlayer(joined.playerId as string)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(karaoke!.findRoom('GRACE')).toBeUndefined();
  });

  it('keeps idle displays alive, anonymizes callers, reconciles expected players, and aborts cleanly', async () => {
    const port = await start({ heartbeatMs: 15 });
    const display = await connect(port);
    send(display, { type: 'spectate', roomCode: 'HOOKS' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);
    const singer = karaoke!.voiceJoin('HOOKS', 'Ada')!;
    karaoke!.anonymizePlayer(' hooks ', singer);
    expect(karaoke!.findRoom('HOOKS')!.state().singer?.name).toBe('PLAYER');
    karaoke!.voiceExpectHumanPlayers('HOOKS', 1, []);
    expect(karaoke!.findRoom('HOOKS')!.state().singer).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(display.ws.readyState).toBe(WebSocket.OPEN);
    expect(karaoke!.abortRoom(' hooks ')).toBe(true);
    expect(karaoke!.findRoom('HOOKS')).toBeUndefined();
    expect(karaoke!.abortRoom('HOOKS')).toBe(false);
  });

  it('bounds public connections, rooms, payloads, and disables compression', async () => {
    const port = await start({ maxConnections: 2, maxRooms: 1 });
    const first = await connect(port);
    const second = await connect(port);
    expect(first.ws.extensions).toBe('');
    send(first, { type: 'spectate', roomCode: 'ONLY' });
    await waitFor(first, message => message.type === 'karaoke_state' && message.roomCode === 'ONLY');
    send(second, { type: 'spectate', roomCode: 'OVERFLOW' });
    await waitFor(second, message => message.type === 'error' && message.code === 'room_capacity');
    expect(karaoke!.findRoom('OVERFLOW')).toBeUndefined();

    const rejected = new WebSocket(`ws://127.0.0.1:${port}/karaoke`);
    await expect(new Promise<void>((resolve, reject) => {
      rejected.once('open', resolve);
      rejected.once('error', reject);
    })).rejects.toThrow();
    const payloadClosed = new Promise<number>(resolve => first.ws.once('close', code => resolve(code)));
    first.ws.send('x'.repeat(20_000));
    expect(await payloadClosed).toBe(1009);
  });
});
