import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ArcadeApi } from '../server/arcade-api';
import { HttpServer } from '../server/http-server';
import type { ChessState } from '../shared/chess-protocol';

const ROOM_CODE = 'CHESS-PVP-HTTP';
const DISPLAY_TOKEN = 'chess-pvp-http-display-token';
let server: HttpServer | null = null;
let directory: string | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
  await server?.stop();
  server = null;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

async function startServer(): Promise<number> {
  directory = await mkdtemp(path.join(tmpdir(), 'chess-pvp-http-'));
  const arcadeApi = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    activateMessagingDelivery: vi.fn(async () => {}),
    getHealthStatus: vi.fn(() => ({ degraded: false })),
    isStationEngineRoom: vi.fn(() => false),
    requiresStationVoiceAssignment: vi.fn(() => false),
    stationVoiceRoute: vi.fn(async () => null),
    resolveStationVoiceSetup: vi.fn(async () => null),
    voiceLocaleForNumber: vi.fn(() => 'en-US'),
    standaloneVoiceAvailable: vi.fn(() => true),
    standaloneGameEnabled: vi.fn(() => true),
  } as unknown as ArcadeApi;
  server = new HttpServer({
    port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
    standaloneVoiceEnabled: true, chessDisplayToken: DISPLAY_TOKEN, arcadeApi,
    analyticsPath: path.join(directory, 'analytics.json'),
    manifestPath: path.join(directory, 'manifest.json'),
    mapsPath: path.join(directory, 'maps.json'),
    arenaPath: path.join(directory, 'arena.json'),
    leaderboardPath: path.join(directory, 'leaderboard.json'),
    fighterMapsPath: path.join(directory, 'fighter-maps.json'),
    fighterPreviewDir: path.join(directory, 'fighter-previews'),
    clientDir: path.join(directory, 'client'),
  });
  return server.start();
}

async function openSocket(url: string, options?: WebSocket.ClientOptions): Promise<WebSocket> {
  const socket = new WebSocket(url, options);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

type DisplayState = ChessState & { type: 'chess_state' };

async function openDisplay(port: number): Promise<{ socket: WebSocket; states: DisplayState[] }> {
  const socket = await openSocket(`ws://127.0.0.1:${port}/chess?display=1`, {
    headers: { Origin: 'http://localhost' },
  });
  const states: DisplayState[] = [];
  socket.on('message', data => {
    const frame = JSON.parse(data.toString()) as { type?: string };
    if (frame.type === 'chess_state') states.push(frame as DisplayState);
  });
  socket.send(JSON.stringify({ type: 'display_auth', roomCode: ROOM_CODE, token: DISPLAY_TOKEN }));
  socket.send(JSON.stringify({ type: 'spectate', roomCode: ROOM_CODE }));
  await vi.waitFor(() => expect(states.length).toBeGreaterThan(0), { timeout: 4_000 });
  return { socket, states };
}

async function openCaller(port: number, callSid: string,
  shouldAcknowledge: (token: string, last: boolean) => boolean = () => true): Promise<{ socket: WebSocket; spoken: string[] }> {
  const socket = await openSocket(`ws://127.0.0.1:${port}/voice`);
  const spoken: string[] = [];
  socket.on('message', data => {
    const frame = JSON.parse(data.toString()) as { type?: string; token?: string; last?: boolean };
    if (frame.type !== 'text') return;
    const token = frame.token ?? '';
    spoken.push(token);
    if (shouldAcknowledge(token, frame.last === true))
      socket.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: token }));
  });
  socket.send(JSON.stringify({ type: 'setup', callSid,
    customParameters: { game: 'chess', roomCode: ROOM_CODE, locale: 'en-US' } }));
  return { socket, spoken };
}

function prompt(socket: WebSocket, words: string): void {
  socket.send(JSON.stringify({ type: 'prompt', voicePrompt: words, last: true }));
}

async function waitState(states: DisplayState[], predicate: (state: DisplayState) => boolean): Promise<DisplayState> {
  await vi.waitFor(() => expect(states.some(predicate)).toBe(true), { timeout: 4_000 });
  return [...states].reverse().find(predicate)!;
}

describe('two-caller Chess over HTTP and Conversation Relay', () => {
  it('replays on the same two calls only after both votes and their phone acknowledgements', async () => {
    const port = await startServer();
    const display = await openDisplay(port);
    display.socket.send(JSON.stringify({ type: 'display_set_mode', roomCode: ROOM_CODE, mode: 'pvp' }));
    await waitState(display.states, state => state.mode === 'pvp');
    const heldVotes: string[] = [];
    const white = await openCaller(port, 'CA-pvp-replay-white', token => {
      if (/Your play again request is saved/i.test(token)) { heldVotes.push(token); return false; }
      return true;
    });
    const black = await openCaller(port, 'CA-pvp-replay-black');
    await vi.waitFor(() => expect(white.spoken.join(' ')).toMatch(/first name/i));
    await vi.waitFor(() => expect(black.spoken.join(' ')).toMatch(/first name/i));
    prompt(white.socket, 'My name is Ada');
    prompt(black.socket, 'My name is Ben');
    await waitState(display.states, state => state.phase === 'playing'
      && state.players?.[0]?.name === 'Ada' && state.players?.[1]?.name === 'Ben');

    const play = async (socket: WebSocket, words: string, ply: number): Promise<void> => {
      prompt(socket, words);
      await waitState(display.states, state => state.phase === 'pending' && state.ply === ply - 1);
      prompt(socket, 'confirm');
      await waitState(display.states, state => state.ply === ply
        && state.lastMove?.ply === ply);
    };
    await play(white.socket, 'pawn from F two to F three', 1);
    await play(black.socket, 'pawn from E seven to E five', 2);
    await play(white.socket, 'pawn from G two to G four', 3);
    await play(black.socket, 'queen from D eight to H four', 4);
    const finished = await waitState(display.states, state => state.phase === 'finished'
      && state.result?.winner === 'b');

    prompt(white.socket, 'play again');
    await waitState(display.states, state => state.gameId === finished.gameId
      && state.rematchReadyPlayerIds?.includes('c1') === true);
    await vi.waitFor(() => expect(heldVotes).toHaveLength(1));
    prompt(black.socket, 'play again');
    await waitState(display.states, state => state.gameId === finished.gameId
      && state.rematchWaitingForPhone === true);
    expect(display.states.at(-1)).toMatchObject({ phase: 'finished',
      result: { winner: 'b' }, rematchReadyPlayerIds: ['c1', 'c2'] });

    white.socket.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: heldVotes[0] }));
    const replay = await waitState(display.states, state => state.gameId === finished.gameId + 1
      && state.phase === 'playing');
    expect(replay).toMatchObject({ mode: 'pvp', ply: 0, result: null,
      players: [
        { playerId: 'c1', color: 'w', name: 'Ada', connected: true },
        { playerId: 'c2', color: 'b', name: 'Ben', connected: true },
      ] });
  }, 20_000);

  it('waits for a replacement result cue after an unsupported DTMF key interrupts a rematch acknowledgement', async () => {
    const port = await startServer();
    const display = await openDisplay(port);
    display.socket.send(JSON.stringify({ type: 'display_set_mode', roomCode: ROOM_CODE, mode: 'pvp' }));
    await waitState(display.states, state => state.mode === 'pvp');
    let heldVote: string | null = null;
    let heldReplacement: string | null = null;
    let holdReplacement = false;
    const white = await openCaller(port, 'CA-pvp-dtmf-white', (token, last) => {
      if (/Your play again request is saved/i.test(token) && last) {
        heldVote = token;
        return false;
      }
      if (holdReplacement && heldReplacement === null && last) {
        heldReplacement = token;
        holdReplacement = false;
        return false;
      }
      return true;
    });
    const black = await openCaller(port, 'CA-pvp-dtmf-black');
    await vi.waitFor(() => expect(white.spoken.join(' ')).toMatch(/first name/i));
    await vi.waitFor(() => expect(black.spoken.join(' ')).toMatch(/first name/i));
    prompt(white.socket, 'My name is Ada');
    prompt(black.socket, 'My name is Ben');
    await waitState(display.states, state => state.phase === 'playing');

    const play = async (socket: WebSocket, words: string, ply: number): Promise<void> => {
      prompt(socket, words);
      await waitState(display.states, state => state.phase === 'pending' && state.ply === ply - 1);
      prompt(socket, 'confirm');
      await waitState(display.states, state => state.ply === ply);
    };
    await play(white.socket, 'pawn from F two to F three', 1);
    await play(black.socket, 'pawn from E seven to E five', 2);
    await play(white.socket, 'pawn from G two to G four', 3);
    await play(black.socket, 'queen from D eight to H four', 4);
    const finished = await waitState(display.states, state => state.phase === 'finished');

    prompt(white.socket, 'play again');
    await vi.waitFor(() => expect(heldVote).not.toBeNull());
    prompt(black.socket, 'play again');
    await waitState(display.states, state => state.gameId === finished.gameId
      && state.rematchWaitingForPhone === true);
    holdReplacement = true;
    const beforeDtmf = white.spoken.length;
    white.socket.send(JSON.stringify({ type: 'dtmf', digit: '2' }));
    await vi.waitFor(() => expect(heldReplacement).not.toBeNull(), { timeout: 4_000 });
    expect(white.spoken.slice(beforeDtmf).join(' ')).toMatch(/checkmate/i);
    expect(display.states.at(-1)).toMatchObject({ gameId: finished.gameId, phase: 'finished',
      rematchWaitingForPhone: true });

    white.socket.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: heldReplacement }));
    await waitState(display.states, state => state.gameId === finished.gameId + 1
      && state.phase === 'playing');
  }, 20_000);

  it('keeps both named callers on setup until the last phone welcome finishes', async () => {
    const port = await startServer();
    const display = await openDisplay(port);
    display.socket.send(JSON.stringify({ type: 'display_set_mode', roomCode: ROOM_CODE, mode: 'pvp' }));
    await waitState(display.states, state => state.mode === 'pvp' && state.phase === 'waiting');

    const white = await openCaller(port, 'CA-pvp-welcome-white');
    let heldWelcome: string | null = null;
    const black = await openCaller(port, 'CA-pvp-welcome-black', token => {
      if (/Ben, you play Black/i.test(token)) { heldWelcome = token; return false; }
      return true;
    });
    await vi.waitFor(() => expect(white.spoken.join(' ')).toMatch(/first name/i));
    await vi.waitFor(() => expect(black.spoken.join(' ')).toMatch(/first name/i));
    prompt(white.socket, 'My name is Ada');
    await waitState(display.states, state => state.players?.[0]?.name === 'Ada'
      && state.players[0].nameConfirmed);
    prompt(black.socket, 'My name is Ben');
    await vi.waitFor(() => expect(heldWelcome).toMatch(/Ben, you play Black/i), { timeout: 4_000 });

    const waiting = await waitState(display.states, state => state.players?.[1]?.name === 'Ben'
      && state.players[1].nameConfirmed && state.phonePendingPlayerIds?.includes('c2') === true);
    expect(waiting).toMatchObject({ phase: 'waiting', ply: 0,
      phonePendingPlayerIds: ['c2'] });
    prompt(white.socket, 'pawn from E two to E four');
    await vi.waitFor(() => expect(white.spoken.join(' ')).toMatch(/waiting for both players/i));
    expect(display.states.at(-1)).toMatchObject({ phase: 'waiting', ply: 0, pendingMove: null });

    black.socket.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: heldWelcome }));
    await waitState(display.states, state => state.phase === 'playing'
      && state.phonePendingPlayerIds?.length === 0);
    await vi.waitFor(() => expect(white.spoken.join(' ')).toMatch(/both players are ready.*your turn/i));
    await vi.waitFor(() => expect(black.spoken.join(' ')).toMatch(/both players are ready.*Ada moves first/i));
  });

  it('keeps two phone conversations and both shared displays on one authorized match', async () => {
    const port = await startServer();
    const firstDisplay = await openDisplay(port);
    firstDisplay.socket.send(JSON.stringify({ type: 'display_set_mode', roomCode: ROOM_CODE, mode: 'pvp' }));
    await waitState(firstDisplay.states, state => state.mode === 'pvp' && state.phase === 'waiting');
    const secondDisplay = await openDisplay(port);
    await waitState(secondDisplay.states, state => state.mode === 'pvp');

    const white = await openCaller(port, 'CA-pvp-white');
    const black = await openCaller(port, 'CA-pvp-black');
    await vi.waitFor(() => expect(white.spoken.join(' ')).toMatch(/first name/i), { timeout: 4_000 });
    await vi.waitFor(() => expect(black.spoken.join(' ')).toMatch(/first name/i), { timeout: 4_000 });
    const unnamed = await waitState(firstDisplay.states, state => state.players?.length === 2);
    expect(unnamed).toMatchObject({ phase: 'waiting', ply: 0, players: [
      { playerId: 'c1', color: 'w', nameConfirmed: false },
      { playerId: 'c2', color: 'b', nameConfirmed: false },
    ] });

    prompt(white.socket, 'My name is Ada');
    await waitState(firstDisplay.states, state => state.players?.[0]?.name === 'Ada'
      && state.players[0].nameConfirmed && state.phase === 'waiting');
    prompt(white.socket, 'pawn from E two to E four');
    await vi.waitFor(() => expect(white.spoken.join(' ')).toMatch(/waiting for both players/i), { timeout: 4_000 });
    expect(firstDisplay.states.at(-1)).toMatchObject({ phase: 'waiting', ply: 0, pendingMove: null });

    prompt(black.socket, 'My name is Ben');
    const ready = await waitState(firstDisplay.states, state => state.phase === 'playing'
      && state.players?.[1]?.name === 'Ben' && state.players[1].nameConfirmed);
    expect(ready.players).toMatchObject([
      { playerId: 'c1', color: 'w', name: 'Ada' },
      { playerId: 'c2', color: 'b', name: 'Ben' },
    ]);
    await waitState(secondDisplay.states, state => state.phase === 'playing' && state.players?.[1]?.name === 'Ben');

    const beforeWrongTurn = ready.feedback?.sequence ?? 0;
    prompt(black.socket, 'pawn from E seven to E five');
    const wrongTurn = await waitState(firstDisplay.states, state => state.feedback?.sequence! > beforeWrongTurn
      && state.feedback?.code === 'not_your_turn');
    expect(wrongTurn).toMatchObject({ ply: 0, turn: 'w', pendingMove: null });
    prompt(white.socket, 'pawn from E two to E four');
    const pending = await waitState(firstDisplay.states, state => state.phase === 'pending'
      && state.pendingMove?.to === 'e4');
    await waitState(secondDisplay.states, state => state.phase === 'pending' && state.pendingMove?.to === 'e4');

    const beforeWrongConfirm = pending.feedback?.sequence ?? 0;
    prompt(black.socket, 'confirm');
    const wrongConfirm = await waitState(firstDisplay.states, state => state.feedback?.sequence! > beforeWrongConfirm
      && state.feedback?.code === 'not_your_turn');
    expect(wrongConfirm).toMatchObject({ phase: 'pending', pendingMove: { to: 'e4' }, ply: 0 });
    prompt(white.socket, 'confirm');
    const whiteMove = await waitState(firstDisplay.states, state => state.mode === 'pvp'
      && state.ply === 1 && state.turn === 'b' && state.lastMove?.actor === 'human');
    expect(whiteMove.lastMove).toMatchObject({ color: 'w', actor: 'human', to: 'e4' });
    const mirroredWhiteMove = await waitState(secondDisplay.states, state => state.mode === 'pvp'
      && state.ply === 1 && state.lastMove?.actor === 'human');
    expect(mirroredWhiteMove.fen).toBe(whiteMove.fen);
    await vi.waitFor(() => expect(black.spoken.join(' ')).toMatch(/Ada moves a pawn.*your turn/i), { timeout: 4_000 });

    await new Promise(resolve => setTimeout(resolve, 1_050));
    expect(firstDisplay.states.at(-1)).toMatchObject({ ply: 1, turn: 'b' });
    prompt(black.socket, 'pawn from E seven to E five');
    await waitState(firstDisplay.states, state => state.phase === 'pending' && state.pendingMove?.to === 'e5');
    prompt(black.socket, 'confirm');
    const blackMove = await waitState(firstDisplay.states, state => state.mode === 'pvp'
      && state.ply === 2 && state.turn === 'w' && state.lastMove?.actor === 'human');
    expect(blackMove.lastMove).toMatchObject({ color: 'b', actor: 'human', to: 'e5' });
    const mirroredBlackMove = await waitState(secondDisplay.states, state => state.mode === 'pvp'
      && state.ply === 2 && state.lastMove?.actor === 'human');
    expect(mirroredBlackMove.fen).toBe(blackMove.fen);
    await vi.waitFor(() => expect(white.spoken.join(' ')).toMatch(/Ben moves a pawn.*your turn/i), { timeout: 4_000 });
  }, 15_000);
});
