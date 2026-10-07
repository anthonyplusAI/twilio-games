import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ChessServer } from '../server/chess-server';
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
