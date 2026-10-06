import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ChessServer } from '../server/chess-server';

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

async function hostChess(): Promise<{ port: number; chess: ChessServer }> {
  const chess = new ChessServer({ displayToken: 'wizard-display-secret', random: () => 0,
    computerDelayMs: 20 });
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
