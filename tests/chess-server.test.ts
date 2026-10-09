import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ChessServer, CHESS_RESULT_RECONNECT_GRACE_MS } from '../server/chess-server';
import { ChessRoom } from '../server/chess-room';

let httpServer: HttpServer | null = null;
let chessServer: ChessServer | null = null;
let display: WebSocket | null = null;

afterEach(async () => {
  display?.terminate();
  display = null;
  chessServer?.stopLoopOnly();
  chessServer = null;
  if (httpServer) await new Promise<void>(resolve => httpServer!.close(() => resolve()));
  httpServer = null;
});

async function hostChess(roomFactory?: (code: string) => ChessRoom): Promise<{ port: number; chess: ChessServer }> {
  const chess = new ChessServer({ displayToken: 'wizard-display-secret', random: () => 0,
    computerDelayMs: 20, roomFactory });
  chess.setDisplayAuthenticationRequirement(code => code === 'MAGE');
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on('upgrade', (request, socket, head) => chess.handleUpgrade(request, socket, head));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an IPv4 test socket');
  httpServer = server;
  chessServer = chess;
  return { port: address.port, chess };
}

describe('Voice Chess display transport', () => {
  it('converts a waiting station PvP seat to a playable solo seat after a no-show', () => {
    const chess = new ChessServer({ random: () => 0 });
    chessServer = chess;
    expect(chess.configureMatch('NO-SHOW', 2)).toBe(true);
    expect(chess.voiceJoin('NO-SHOW', 'Ben', 'CA-black', 'en-US', true, 1, true))
      .toEqual({ playerId: 'c2', resumed: false });
    expect(chess.findRoom('NO-SHOW')?.state()).toMatchObject({ mode: 'pvp', phase: 'waiting' });

    const reconcile = (chess as ChessServer & {
      reconcileStationMatch?: (roomCode: string, expectedHumans: 1 | 2) => boolean;
    }).reconcileStationMatch;
    expect(reconcile?.call(chess, 'NO-SHOW', 1)).toBe(true);
    expect(chess.findRoom('NO-SHOW')?.state()).toMatchObject({ mode: 'solo', phase: 'playing',
      players: [expect.objectContaining({ playerId: 'c2', name: 'Ben', connected: true })] });
    expect(chess.voiceLegalMoves('NO-SHOW', 'CA-black', 'en-US'))
      .toContainEqual(expect.objectContaining({ id: 'e2e4' }));
  });

  it('never changes a live station Chess match into solo play', () => {
    const chess = new ChessServer({ random: () => 0 });
    chessServer = chess;
    chess.configureMatch('LIVE-DUEL', 2);
    chess.voiceJoin('LIVE-DUEL', 'Ada', 'CA-white', 'en-US', true, 0, true);
    chess.voiceJoin('LIVE-DUEL', 'Ben', 'CA-black', 'en-US', true, 1, true);
    chess.voiceBeginWelcome('LIVE-DUEL', 'CA-white')(true);
    chess.voiceBeginWelcome('LIVE-DUEL', 'CA-black')(true);
    const room = chess.findRoom('LIVE-DUEL')!;
    const gameId = room.state().gameId;

    const reconcile = (chess as ChessServer & {
      reconcileStationMatch?: (roomCode: string, expectedHumans: 1 | 2) => boolean;
    }).reconcileStationMatch;
    expect(reconcile?.call(chess, 'LIVE-DUEL', 1)).toBe(false);
    expect(room.state()).toMatchObject({ mode: 'pvp', phase: 'playing', gameId });
  });

  it('ignores a welcome completion from a replaced call socket', () => {
    const chess = new ChessServer({ random: () => 0 });
    chessServer = chess;
    chess.configureMatch('DUEL', 2);
    chess.voiceJoin('DUEL', 'Ada', 'CA-white', 'en-US');
    chess.voiceJoin('DUEL', 'Ben', 'CA-black', 'en-US');
    const staleWhiteWelcome = chess.voiceBeginWelcome('DUEL', 'CA-white');
    chess.voiceBeginWelcome('DUEL', 'CA-black')(true);
    expect(chess.findRoom('DUEL')?.state()).toMatchObject({ phase: 'waiting',
      phonePendingPlayerIds: ['c1'] });

    chess.voiceSetConnected('DUEL', 'CA-white', false);
    chess.voiceJoin('DUEL', 'Ada', 'CA-white', 'en-US');
    staleWhiteWelcome(true);
    expect(chess.findRoom('DUEL')?.state()).toMatchObject({ phase: 'waiting',
      phonePendingPlayerIds: ['c1'] });
    chess.voiceBeginWelcome('DUEL', 'CA-white')(true);
    expect(chess.findRoom('DUEL')?.state()).toMatchObject({ phase: 'playing',
      phonePendingPlayerIds: [] });
  });

  it('does not start PvP after failed audio and ignores an older superseded welcome', () => {
    const chess = new ChessServer({ random: () => 0 });
    chessServer = chess;
    chess.configureMatch('DUEL', 2);
    chess.voiceJoin('DUEL', 'Ada', 'CA-white', 'en-US');
    chess.voiceJoin('DUEL', 'Ben', 'CA-black', 'en-US');
    const firstWhiteWelcome = chess.voiceBeginWelcome('DUEL', 'CA-white');
    chess.voiceBeginWelcome('DUEL', 'CA-black')(true);
    firstWhiteWelcome(false);
    expect(chess.snapshot('DUEL')).toMatchObject({ phase: 'waiting',
      phoneRetryPlayerIds: ['c1'] });

    const retryWhiteWelcome = chess.voiceBeginWelcome('DUEL', 'CA-white');
    firstWhiteWelcome(true);
    expect(chess.snapshot('DUEL')).toMatchObject({ phase: 'waiting',
      phonePendingPlayerIds: ['c1'], phoneRetryPlayerIds: [] });
    retryWhiteWelcome(true);
    expect(chess.snapshot('DUEL')).toMatchObject({ phase: 'playing',
      phonePendingPlayerIds: [] });
  });

  it('needs both rematch votes and both result phone recaps before resetting the shared board', async () => {
    const chess = new ChessServer({ roomFactory: code => new ChessRoom(code, { mode: 'pvp',
      initialFen: '7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1' }) });
    chessServer = chess;
    let finishRecaps!: () => void;
    const recaps = new Promise<void>(resolve => { finishRecaps = resolve; });
    chess.setPvpRematchSpeechBarrier(() => recaps);
    chess.voiceJoin('DUEL', 'Ada', 'CA-white', 'en-US');
    chess.voiceJoin('DUEL', 'Ben', 'CA-black', 'en-US');
    chess.voiceBeginWelcome('DUEL', 'CA-white')(true);
    chess.voiceBeginWelcome('DUEL', 'CA-black')(true);
    chess.voiceCommand('DUEL', 'CA-white', 'queen to G7', 'en-US');
    chess.voiceCommand('DUEL', 'CA-white', 'confirm', 'en-US');
    const finished = chess.findRoom('DUEL')!.state();
    expect(finished.phase).toBe('finished');

    expect(chess.voiceRequestPvpRematch('DUEL', 'CA-white')).toBe('waiting');
    expect(chess.snapshot('DUEL')).toMatchObject({ rematchReadyPlayerIds: ['c1'],
      rematchWaitingForPhone: false, gameId: finished.gameId });
    expect(chess.voiceRequestPvpRematch('DUEL', 'CA-black')).toBe('ready');
    await Promise.resolve();
    expect(chess.snapshot('DUEL')).toMatchObject({ phase: 'finished', gameId: finished.gameId,
      rematchReadyPlayerIds: ['c1', 'c2'], rematchWaitingForPhone: true });

    finishRecaps();
    await vi.waitFor(() => expect(chess.snapshot('DUEL')).toMatchObject({
      gameId: finished.gameId + 1, phase: 'waiting', result: null,
      phonePendingPlayerIds: ['c1', 'c2'],
    }));
    chess.voiceBeginWelcome('DUEL', 'CA-white')(true);
    expect(chess.findRoom('DUEL')!.state().phase).toBe('waiting');
    chess.voiceBeginWelcome('DUEL', 'CA-black')(true);
    expect(chess.findRoom('DUEL')!.state().phase).toBe('playing');
  });

  it('cancels an in-flight rematch when a caller disconnects and waits for their fresh vote', async () => {
    const chess = new ChessServer({ roomFactory: code => new ChessRoom(code, { mode: 'pvp',
      initialFen: '7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1' }) });
    chessServer = chess;
    const settle: Array<() => void> = [];
    chess.setPvpRematchSpeechBarrier(() => new Promise<void>(resolve => settle.push(resolve)));
    chess.voiceJoin('DUEL', 'Ada', 'CA-white', 'en-US');
    chess.voiceJoin('DUEL', 'Ben', 'CA-black', 'en-US');
    chess.voiceBeginWelcome('DUEL', 'CA-white')(true);
    chess.voiceBeginWelcome('DUEL', 'CA-black')(true);
    chess.voiceCommand('DUEL', 'CA-white', 'queen to G7', 'en-US');
    chess.voiceCommand('DUEL', 'CA-white', 'confirm', 'en-US');
    const finishedGameId = chess.findRoom('DUEL')!.state().gameId;

    chess.voiceRequestPvpRematch('DUEL', 'CA-white');
    chess.voiceRequestPvpRematch('DUEL', 'CA-black');
    await vi.waitFor(() => expect(settle).toHaveLength(1));
    chess.voiceSetConnected('DUEL', 'CA-black', false);
    settle[0]!();
    await Promise.resolve();
    expect(chess.snapshot('DUEL')).toMatchObject({ gameId: finishedGameId,
      phase: 'finished', rematchReadyPlayerIds: ['c1'], rematchWaitingForPhone: false });

    chess.voiceJoin('DUEL', 'Ben', 'CA-black', 'en-US');
    expect(chess.voiceRequestPvpRematch('DUEL', 'CA-black')).toBe('ready');
    await vi.waitFor(() => expect(settle).toHaveLength(2));
    expect(chess.findRoom('DUEL')!.state().gameId).toBe(finishedGameId);
    settle[1]!();
    await vi.waitFor(() => expect(chess.findRoom('DUEL')!.state().gameId).toBe(finishedGameId + 1));
  });

  it('lets an unnamed standalone solo caller play immediately while preserving the optional name flag for PvP', () => {
    const chess = new ChessServer({ random: () => 0 });
    chessServer = chess;
    expect(chess.voiceJoin('SOLO', 'Wizard', 'CA-solo', 'en-US', false, undefined, false))
      .toEqual({ playerId: 'c1', resumed: false });
    expect(chess.findRoom('SOLO')?.state()).toMatchObject({ mode: 'solo', phase: 'playing',
      players: [{ name: 'Wizard', nameConfirmed: true }] });
  });

  it('binds station callers to assigned White and Black seats even when Black arrives first', async () => {
    vi.useFakeTimers();
    const chess = new ChessServer({ random: () => 0.99, computerDelayMs: 20 });
    chessServer = chess;
    try {
      expect(chess.configureMatch('DUEL', 2)).toBe(true);
      expect(chess.findRoom('DUEL')?.state()).toMatchObject({ mode: 'pvp', ply: 0, phase: 'waiting' });
      expect(chess.voiceJoin('DUEL', 'Ben', 'CA-black', 'en-US', true, 1)).toEqual({ playerId: 'c2', resumed: false });
      expect(chess.voiceJoin('DUEL', 'Ada', 'CA-white', 'en-US', true, 0)).toEqual({ playerId: 'c1', resumed: false });
      chess.voiceBeginWelcome('DUEL', 'CA-black')(true);
      chess.voiceBeginWelcome('DUEL', 'CA-white')(true);
      expect(chess.voiceJoin('DUEL', 'Extra', 'CA-third', 'en-US', true)).toBeNull();
      expect(chess.findRoom('DUEL')?.state()).toMatchObject({ phase: 'playing', players: [
        { playerId: 'c1', color: 'w', name: 'Ada', connected: true },
        { playerId: 'c2', color: 'b', name: 'Ben', connected: true },
      ] });
      expect(chess.voiceLegalMoves('DUEL', 'CA-black', 'en-US')).toEqual([]);
      expect(chess.voiceCommand('DUEL', 'CA-black', 'E7 to E5', 'en-US')?.code).toBe('not_your_turn');
      expect(chess.voiceCommand('DUEL', 'CA-white', 'E2 to E4', 'en-US')?.code).toBe('proposed');
      expect(chess.voiceCommand('DUEL', 'CA-black', 'confirm', 'en-US')?.code).toBe('not_your_turn');
      expect(chess.voiceCommand('DUEL', 'CA-white', 'confirm', 'en-US')?.code).toBe('confirmed');
      vi.advanceTimersByTime(1_000);
      expect(chess.findRoom('DUEL')?.state()).toMatchObject({ ply: 1, turn: 'b' });
      expect(chess.voiceLegalMoves('DUEL', 'CA-black', 'en-US'))
        .toContainEqual(expect.objectContaining({ id: 'e7e5' }));
      expect(chess.voiceSetConnected('DUEL', 'CA-black', false)).toBe(true);
      expect(chess.findRoom('DUEL')?.state().phase).toBe('waiting');
      expect(chess.voiceJoin('DUEL', 'Ben', 'CA-black', 'en-US', true, 1))
        .toEqual({ playerId: 'c2', resumed: true });
      chess.voiceBeginWelcome('DUEL', 'CA-black')(true);
      expect(chess.findRoom('DUEL')?.state().phase).toBe('playing');
      chess.voiceLeave('DUEL', 'CA-black');
      expect(chess.findRoom('DUEL')?.state()).toMatchObject({
        phase: 'finished', result: { reason: 'forfeit', winner: 'w' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a viewing screen select two-player mode before calls and locks the mode after join', () => {
    const chess = new ChessServer({ random: () => 0 });
    chessServer = chess;
    const frames: Array<Record<string, any>> = [];
    const ws = { readyState: WebSocket.OPEN,
      send: (text: string) => frames.push(JSON.parse(text)), terminate: () => {} };
    const watched = { ws, roomCode: 'DUEL', locale: 'en-US', authenticatedRoomCode: null, alive: true };
    (chess as unknown as { displays: Set<unknown> }).displays.add(watched);
    const send = (message: Record<string, unknown>) =>
      (chess as unknown as { onMessage: (display: unknown, raw: string) => void })
        .onMessage(watched, JSON.stringify(message));
    chess.getOrCreateRoom('DUEL');
    send({ type: 'display_set_mode', roomCode: 'DUEL', mode: 'pvp' });
    expect(chess.findRoom('DUEL')?.state()).toMatchObject({ mode: 'pvp', ply: 0 });
    expect(chess.voiceJoin('DUEL', 'Ada', 'CA-white', 'en-US', false, undefined, false))
      .toMatchObject({ playerId: 'c1' });
    expect(chess.findRoom('DUEL')?.state()).toMatchObject({ phase: 'waiting', players: [
      { name: 'Ada', nameConfirmed: false },
    ] });
    expect(chess.voiceConfirmName('DUEL', 'CA-white', 'Ada')).toBe(true);
    send({ type: 'display_set_mode', roomCode: 'DUEL', mode: 'solo' });
    expect(frames.some(frame => frame.code === 'mode_locked')).toBe(true);
    expect(chess.findRoom('DUEL')?.state().mode).toBe('pvp');
  });

  it('locks the requested standalone mode before registering a display for phone calls', () => {
    const chess = new ChessServer({ random: () => 0 });
    chessServer = chess;
    const frames: Array<Record<string, any>> = [];
    const ws = { readyState: WebSocket.OPEN,
      send: (value: string) => frames.push(JSON.parse(value)), terminate: () => {} };
    const displayConnection = { ws, roomCode: null, locale: 'en-US',
      authenticatedRoomCode: null, alive: true };
    (chess as unknown as { displays: Set<unknown> }).displays.add(displayConnection);
    let modeAtRegistration: string | undefined;
    chess.setOnDisplayRegistered(() => {
      modeAtRegistration = chess.findRoom('DUEL')?.mode;
      chess.voiceJoin('DUEL', 'Ada', 'CA-white', 'en-US', false, undefined, false);
    });

    (chess as unknown as { onMessage: (display: unknown, raw: string) => void })
      .onMessage(displayConnection, JSON.stringify({ type: 'spectate', roomCode: 'DUEL',
        mode: 'pvp', locale: 'en-US' }));

    expect(modeAtRegistration).toBe('pvp');
    expect(chess.findRoom('DUEL')?.state()).toMatchObject({ mode: 'pvp',
      phase: 'waiting', players: [{ name: 'Ada', nameConfirmed: false }] });
    expect(frames).toContainEqual(expect.objectContaining({ type: 'chess_state', mode: 'pvp' }));
    expect(frames.filter(frame => frame.type === 'chess_state').every(frame => frame.mode === 'pvp'))
      .toBe(true);
  });

  it('does not register a two-player display against an already joined solo match', () => {
    const chess = new ChessServer({ random: () => 0 });
    chessServer = chess;
    chess.voiceJoin('DUEL', 'Ada', 'CA-solo', 'en-US');
    const frames: Array<Record<string, any>> = [];
    const ws = { readyState: WebSocket.OPEN,
      send: (value: string) => frames.push(JSON.parse(value)), terminate: () => {} };
    const displayConnection = { ws, roomCode: null, locale: 'en-US',
      authenticatedRoomCode: null, alive: true };
    (chess as unknown as { displays: Set<unknown> }).displays.add(displayConnection);
    let registered = false;
    chess.setOnDisplayRegistered(() => { registered = true; });

    (chess as unknown as { onMessage: (display: unknown, raw: string) => void })
      .onMessage(displayConnection, JSON.stringify({ type: 'spectate', roomCode: 'DUEL',
        mode: 'pvp' }));

    expect(frames).toContainEqual(expect.objectContaining({ type: 'error', code: 'mode_locked' }));
    expect(displayConnection.roomCode).toBeNull();
    expect(registered).toBe(false);
    expect(chess.findRoom('DUEL')?.mode).toBe('solo');
  });

  it('keeps a finished standalone two-caller result until the remaining caller leaves', () => {
    const chess = new ChessServer({ random: () => 0 });
    chessServer = chess;
    const ws = { readyState: WebSocket.OPEN, send: () => {}, terminate: () => {} };
    (chess as unknown as { displays: Set<unknown> }).displays.add({ ws, roomCode: 'DUEL',
      locale: 'en-US', authenticatedRoomCode: null, alive: true });
    chess.configureMatch('DUEL', 2);
    chess.voiceJoin('DUEL', 'Ada', 'CA-white', 'en-US');
    chess.voiceJoin('DUEL', 'Ben', 'CA-black', 'en-US');
    chess.voiceLeave('DUEL', 'CA-black');
    expect(chess.findRoom('DUEL')?.state()).toMatchObject({
      phase: 'finished', result: { reason: 'forfeit', winner: 'w' },
    });
    expect(chess.voiceJoin('DUEL', 'Charlie', 'CA-third', 'en-US')).toBeNull();
    expect(chess.findRoom('DUEL')?.state().players).toHaveLength(2);
    chess.voiceLeave('DUEL', 'CA-white');
    expect(chess.voiceJoin('DUEL', 'Charlie', 'CA-new', 'en-US'))
      .toEqual({ playerId: 'c1', resumed: false });
    expect(chess.findRoom('DUEL')?.state()).toMatchObject({
      phase: 'waiting', ply: 0, players: [{ playerId: 'c1', name: 'Charlie' }],
    });
  });

  it('keeps the solo caller authorized after a replay assigns the other color', () => {
    const chess = new ChessServer({ roomFactory: code => new ChessRoom(code, {
      humanColor: 'w', initialFen: '7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1',
      random: () => 0.99,
    }) });
    chessServer = chess;
    chess.voiceJoin('SOLO', 'Ada', 'CA-solo', 'en-US');
    chess.voiceCommand('SOLO', 'CA-solo', 'queen to G7', 'en-US');
    chess.voiceCommand('SOLO', 'CA-solo', 'confirm', 'en-US');
    expect(chess.findRoom('SOLO')?.state().phase).toBe('finished');
    expect(chess.voiceRestart('SOLO', 'CA-solo')).toBe(true);
    expect(chess.findRoom('SOLO')?.state()).toMatchObject({ humanColor: 'b', turn: 'b' });
    expect(chess.voiceLegalMoves('SOLO', 'CA-solo', 'en-US').length).toBeGreaterThan(0);
  });

  it('recognizes only a bound standalone display in its current room', async () => {
    const { port, chess } = await hostChess();
    chess.setDisplayAuthenticationRequirement(code => code === 'MAGE' || code === 'ALT');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chess?display=1`);
    display = socket;
    const frames: Array<Record<string, any>> = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const serverSocket = [...(chess as unknown as { displays: Set<{ ws: WebSocket }> }).displays][0]!.ws;
    expect(chess.hasStandaloneDisplay(serverSocket, 'SOLO')).toBe(false);

    socket.send(JSON.stringify({ type: 'spectate', roomCode: 'SOLO' }));
    await vi.waitFor(() => expect(chess.hasStandaloneDisplay(serverSocket, 'SOLO')).toBe(true));
    socket.send(JSON.stringify({ type: 'spectate', roomCode: 'OTHER' }));
    await vi.waitFor(() => expect(chess.hasStandaloneDisplay(serverSocket, 'OTHER')).toBe(true));
    expect(chess.hasStandaloneDisplay(serverSocket, 'SOLO')).toBe(false);

    socket.send(JSON.stringify({ type: 'leave' }));
    await vi.waitFor(() => expect(chess.hasStandaloneDisplay(serverSocket, 'OTHER')).toBe(false));

    socket.send(JSON.stringify({ type: 'display_auth', roomCode: 'ALT', token: 'wizard-display-secret' }));
    socket.send(JSON.stringify({ type: 'spectate', roomCode: 'ALT' }));
    await vi.waitFor(() => expect(chess.hasStandaloneDisplay(serverSocket, 'ALT')).toBe(true));
    expect(chess.voiceJoin('ALT', 'Ada', 'CA-alt', 'en-US')).toMatchObject({ playerId: 'c1' });
    expect(chess.hasStandaloneDisplay(serverSocket, 'ALT')).toBe(true);

    socket.send(JSON.stringify({ type: 'display_auth', roomCode: 'MAGE', token: 'wizard-display-secret' }));
    await vi.waitFor(() => expect(chess.hasStandaloneDisplay(serverSocket, 'ALT')).toBe(false));
    socket.send(JSON.stringify({ type: 'spectate', roomCode: 'MAGE' }));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'chess_state' && frame.roomCode === 'MAGE')).toBe(true));
    expect(chess.voiceJoin('MAGE', 'Wizard', 'CA-station', 'en-US', true)).toMatchObject({ playerId: 'c1' });
    expect(chess.hasStandaloneDisplay(serverSocket, 'MAGE')).toBe(false);

    socket.close();
    await new Promise<void>(resolve => socket.once('close', () => resolve()));
    expect(chess.hasStandaloneDisplay(serverSocket, 'MAGE')).toBe(false);
  });

  it('offers a replay selector only for a live standalone finished match and rejects a stale game ID', async () => {
    const { port, chess } = await hostChess(code => new ChessRoom(code, {
      humanColor: 'w', random: () => 0, initialFen: '7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1',
    }));
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chess?display=1`);
    display = socket;
    const frames: Array<Record<string, any>> = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'spectate', roomCode: 'SOLO', locale: 'en-US' }));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'chess_state')).toBe(true));
    expect(chess.voiceJoin('SOLO', 'Ada', 'CA-solo', 'en-US')).toMatchObject({ playerId: 'c1' });
    expect(chess.voiceCommand('SOLO', 'CA-solo', 'queen to G7', 'en-US')?.code).toBe('proposed');
    expect(chess.voiceCommand('SOLO', 'CA-solo', 'confirm', 'en-US')?.code).toBe('confirmed');
    const finished = chess.findRoom('SOLO')!.state();
    expect(finished.phase).toBe('finished');
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'chess_state'
      && frame.gameId === finished.gameId && frame.phase === 'finished'
      && frame.canReplayOnDisplay === true)).toBe(true));
    socket.send(JSON.stringify({ type: 'display_replay', roomCode: 'SOLO', gameId: finished.gameId - 1 }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(chess.findRoom('SOLO')!.state().gameId).toBe(finished.gameId);
    socket.send(JSON.stringify({ type: 'display_replay', roomCode: 'SOLO', gameId: finished.gameId }));
    await vi.waitFor(() => expect(chess.findRoom('SOLO')!.state()).toMatchObject({
      gameId: finished.gameId + 1, phase: 'playing', result: null,
    }));
  });

  it('keeps a finished chess result on the shared display after the caller hangs up', async () => {
    const { port, chess } = await hostChess(code => new ChessRoom(code, {
      humanColor: 'w', random: () => 0, initialFen: '7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1',
    }));
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chess?display=1`);
    display = socket;
    const frames: Array<Record<string, any>> = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'spectate', roomCode: 'SOLO' }));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'chess_state')).toBe(true));
    expect(chess.voiceJoin('SOLO', 'Ada', 'CA-solo', 'en-US')).toMatchObject({ playerId: 'c1' });
    expect(chess.voiceCommand('SOLO', 'CA-solo', 'queen to G7', 'en-US')?.code).toBe('proposed');
    expect(chess.voiceCommand('SOLO', 'CA-solo', 'confirm', 'en-US')?.code).toBe('confirmed');
    const finished = chess.findRoom('SOLO')!.state();
    expect(finished).toMatchObject({ phase: 'finished', result: { winner: 'w' } });

    chess.voiceLeave('SOLO', 'CA-solo');
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'chess_state'
      && frame.gameId === finished.gameId && frame.phase === 'finished'
      && frame.playerConnected === false && frame.result?.winner === finished.result?.winner)).toBe(true));
    expect(chess.findRoom('SOLO')!.state()).toMatchObject({ phase: 'finished', result: finished.result });
    expect(frames.at(-1)?.phase).toBe('finished');
    const displayClosed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    socket.close();
    await displayClosed;
    expect(chess.findRoom('SOLO')?.state()).toMatchObject({ phase: 'finished', result: finished.result });
    const reopened = new WebSocket(`ws://127.0.0.1:${port}/chess?display=1`);
    display = reopened;
    const restoredFrames: Array<Record<string, any>> = [];
    reopened.on('message', data => restoredFrames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { reopened.once('open', resolve); reopened.once('error', reject); });
    reopened.send(JSON.stringify({ type: 'spectate', roomCode: 'SOLO' }));
    await vi.waitFor(() => expect(restoredFrames.some(frame => frame.type === 'chess_state'
      && frame.phase === 'finished' && frame.result?.winner === finished.result?.winner)).toBe(true));
    expect(chess.voiceJoin('SOLO', 'Grace', 'CA-new', 'en-US')).toMatchObject({ playerId: 'c1' });
    expect(chess.findRoom('SOLO')!.state()).toMatchObject({ phase: 'playing', result: null });
  });

  it('reaps an unattended standalone result after its display reconnect grace', () => {
    vi.useFakeTimers();
    const chess = new ChessServer({ roomFactory: code => new ChessRoom(code, {
      humanColor: 'w', random: () => 0, initialFen: '7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1',
    }) });
    try {
      expect(chess.voiceJoin('SOLO', 'Ada', 'CA-solo', 'en-US')).not.toBeNull();
      expect(chess.voiceCommand('SOLO', 'CA-solo', 'queen to G7', 'en-US')?.code).toBe('proposed');
      expect(chess.voiceCommand('SOLO', 'CA-solo', 'confirm', 'en-US')?.code).toBe('confirmed');
      chess.voiceLeave('SOLO', 'CA-solo');
      expect(chess.findRoom('SOLO')?.state().phase).toBe('finished');
      vi.advanceTimersByTime(CHESS_RESULT_RECONNECT_GRACE_MS - 1);
      expect(chess.roomCount).toBe(1);
      vi.advanceTimersByTime(1);
      expect(chess.findRoom('SOLO')).toBeUndefined();
      expect(chess.roomCount).toBe(0);
    } finally {
      chess.stopLoopOnly();
      vi.useRealTimers();
    }
  });

  it('offers replay for an authenticated non-default standalone match', async () => {
    const { port, chess } = await hostChess(code => new ChessRoom(code, {
      humanColor: 'w', random: () => 0, initialFen: '7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1',
    }));
    chess.setDisplayAuthenticationRequirement(code => code === 'MAGE' || code === 'ALT');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chess?display=1`);
    display = socket;
    const frames: Array<Record<string, any>> = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'display_auth', roomCode: 'ALT', token: 'wizard-display-secret' }));
    socket.send(JSON.stringify({ type: 'spectate', roomCode: 'ALT' }));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'chess_state' && frame.roomCode === 'ALT')).toBe(true));
    expect(chess.voiceJoin('ALT', 'Ada', 'CA-alt-replay', 'en-US')).toMatchObject({ playerId: 'c1' });
    expect(chess.voiceCommand('ALT', 'CA-alt-replay', 'queen to G7', 'en-US')?.code).toBe('proposed');
    expect(chess.voiceCommand('ALT', 'CA-alt-replay', 'confirm', 'en-US')?.code).toBe('confirmed');
    const finished = chess.findRoom('ALT')!.state();
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'chess_state'
      && frame.phase === 'finished' && frame.canReplayOnDisplay === true)).toBe(true));
    socket.send(JSON.stringify({ type: 'display_replay', roomCode: 'ALT', gameId: finished.gameId }));
    await vi.waitFor(() => expect(chess.findRoom('ALT')!.state().gameId).toBe(finished.gameId + 1));
  });

  it('does not offer or accept a replay tap for a station match', async () => {
    const { port, chess } = await hostChess(code => new ChessRoom(code, {
      humanColor: 'w', random: () => 0, initialFen: '7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1',
    }));
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chess?display=1`);
    display = socket;
    const frames: Array<Record<string, any>> = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'display_auth', roomCode: 'MAGE', token: 'wizard-display-secret' }));
    socket.send(JSON.stringify({ type: 'spectate', roomCode: 'MAGE', locale: 'en-US' }));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'chess_state')).toBe(true));
    expect(chess.voiceJoin('MAGE', 'Ada', 'CA-station', 'en-US', true)).toMatchObject({ playerId: 'c1' });
    expect(chess.voiceCommand('MAGE', 'CA-station', 'queen to G7', 'en-US')?.code).toBe('proposed');
    expect(chess.voiceCommand('MAGE', 'CA-station', 'confirm', 'en-US')?.code).toBe('confirmed');
    const finished = chess.findRoom('MAGE')!.state();
    expect(finished.phase).toBe('finished');
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'chess_state'
      && frame.phase === 'finished' && frame.canReplayOnDisplay === false)).toBe(true));
    socket.send(JSON.stringify({ type: 'display_replay', roomCode: 'MAGE', gameId: finished.gameId }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(chess.findRoom('MAGE')!.state().gameId).toBe(finished.gameId);
    expect(chess.voiceRestart('MAGE', 'CA-station')).toBe(false);
    expect(chess.voiceCommand('MAGE', 'CA-station', 'play again', 'en-US')?.code).toBe('finished');
    expect(chess.findRoom('MAGE')!.state().gameId).toBe(finished.gameId);
    chess.voiceLeave('MAGE', 'CA-station');
    expect(chess.voiceJoin('MAGE', 'Late caller', 'CA-late', 'en-US')).toBeNull();
    expect(chess.voiceJoin('MAGE', 'Late assignment', 'CA-late-station', 'en-US', true)).toBeNull();
    expect(chess.findRoom('MAGE')!.state()).toMatchObject({ phase: 'finished', result: finished.result });
  });

  it('keeps the browser display read-only and publishes only confirmed phone moves', async () => {
    const { port, chess } = await hostChess();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chess?display=1`);
    display = socket;
    const frames: Array<Record<string, any>> = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const waitFor = async (predicate: (frame: Record<string, any>) => boolean) => {
      await vi.waitFor(() => expect(frames.some(predicate)).toBe(true), { timeout: 2_000 });
      return frames.find(predicate)!;
    };

    socket.send(JSON.stringify({ type: 'spectate', roomCode: 'MAGE' }));
    expect((await waitFor(frame => frame.code === 'bad_display_auth')).type).toBe('error');
    expect(chess.voiceJoin('MAGE', 'Wizard', 'CA-chess', 'en-US')).toBeNull();
    socket.send(JSON.stringify({ type: 'display_auth', roomCode: 'MAGE', token: 'wizard-display-secret' }));
    socket.send(JSON.stringify({ type: 'spectate', roomCode: 'MAGE', locale: 'en-US' }));
    const waiting = await waitFor(frame => frame.type === 'chess_state');
    expect(waiting).toMatchObject({ roomCode: 'MAGE', humanColor: 'w', phase: 'waiting', ply: 0 });
    const openingFen = waiting.fen;

    socket.send(JSON.stringify({ type: 'move', from: 'e2', to: 'e4' }));
    expect((await waitFor(frame => frame.code === 'voice_only')).type).toBe('error');
    expect(chess.findRoom('MAGE')?.state().fen).toBe(openingFen);

    expect(chess.voiceJoin('MAGE', 'Wizard', 'CA-chess', 'en-US')).toEqual({ playerId: 'c1', resumed: false });
    expect(chess.voiceJoin('MAGE', 'Other', 'CA-other', 'en-US')).toBeNull();
    expect(chess.voiceLegalMoves('MAGE', 'CA-other', 'en-US')).toEqual([]);
    expect(chess.voiceLegalMoves('MAGE', 'CA-chess', 'en-US'))
      .toContainEqual(expect.objectContaining({ id: 'e2e4' }));
    const hint = chess.voiceCommand('MAGE', 'CA-chess', 'hint', 'en-US');
    expect(hint?.code).toBe('hint');
    expect(hint?.state).toMatchObject({ fen: openingFen, hintsRemaining: 2,
      hint: { revision: 0 } });
    await waitFor(frame => frame.type === 'chess_state' && frame.hintsRemaining === 2
      && frame.hint?.revision === 0);
    const proposed = chess.voiceCommand('MAGE', 'CA-chess', 'pawn from E two to E four', 'en-US');
    expect(proposed?.code).toBe('proposed');
    expect(proposed?.state.fen).toBe(openingFen);
    expect(proposed?.state.pendingMove?.to).toBe('e4');
    const confirmed = chess.voiceCommand('MAGE', 'CA-chess', 'confirm', 'en-US');
    expect(confirmed?.code).toBe('confirmed');
    expect(confirmed?.state.pendingMove).toBeNull();
    expect(confirmed?.state.fen).not.toBe(openingFen);
    expect(confirmed?.state.lastMove?.actor).toBe('human');
    await waitFor(frame => frame.type === 'chess_events'
      && frame.events.some((event: { type: string; move?: { actor: string } }) => event.type === 'move'
        && event.move?.actor === 'computer'));
    expect(chess.findRoom('MAGE')?.state().ply).toBe(2);
  });
});
