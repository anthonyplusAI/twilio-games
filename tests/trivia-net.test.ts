import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TriviaConnection } from '../client/trivia/trivia-net';

class MockWebSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

let sockets: MockWebSocket[];
let originalWebSocket: typeof WebSocket;

const messages = (socket: MockWebSocket): Record<string, unknown>[] => socket.sent
  .map(value => JSON.parse(value) as Record<string, unknown>);
const commands = (socket: MockWebSocket): Record<string, unknown>[] => messages(socket)
  .filter(message => message.type !== 'clock_sync');

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
});

describe('TriviaConnection', () => {
  it('authenticates before registering the display and emits generation-scoped readiness', () => {
    const connection = new TriviaConnection('ws://trivia', 'pt-BR');
    connection.setDisplayAuth('ROOM', 'display-secret');
    connection.spectate('ROOM');
    sockets[0]!.open();
    expect(commands(sockets[0]!)).toEqual([]);

    sockets[0]!.message({ type: 'trivia_capabilities', displayAuth: true });
    connection.displayReady(7);
    expect(commands(sockets[0]!)).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'display-secret' },
      { type: 'spectate', roomCode: 'ROOM', locale: 'pt-BR' },
      { type: 'ready', loadingGeneration: 7 },
    ]);
    expect('answer' in connection).toBe(false);
    expect('score' in connection).toBe(false);
    expect('join' in connection).toBe(true);
    expect('selectCategory' in connection).toBe(true);
    expect('advance' in connection).toBe(true);
    expect('keyboardAnswer' in connection).toBe(true);
    connection.close();
  });

  it('reauthenticates and restores display identity after reconnect', () => {
    const connection = new TriviaConnection('ws://trivia');
    connection.setDisplayAuth('ROOM', 'secret');
    connection.spectate('ROOM');
    sockets[0]!.open();
    sockets[0]!.message({ type: 'trivia_capabilities', displayAuth: true });
    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: 1006 });

    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    expect(commands(sockets[1]!)).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'secret' },
      { type: 'spectate', roomCode: 'ROOM' },
    ]);
    connection.close();
  });

  it('registers the standalone display with its seat target on each connection', () => {
    const connection = new TriviaConnection('ws://trivia');
    connection.configureSeats('ROOM', 3);
    connection.spectate('ROOM');
    sockets[0]!.open();
    expect(commands(sockets[0]!)).toEqual([
      { type: 'spectate', roomCode: 'ROOM', count: 3 },
    ]);
    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    expect(commands(sockets[1]!)).toEqual([
      { type: 'spectate', roomCode: 'ROOM', count: 3 },
    ]);
    connection.displayReplay('t2');
    expect(commands(sockets[1]!).at(-1)).toEqual({ type: 'display_replay', playerId: 't2' });
    connection.close();
  });

  it('reapplies the selected seats when an overlapping display becomes host', () => {
    const connection = new TriviaConnection('ws://trivia');
    connection.configureSeats('ROOM', 3); connection.spectate('ROOM'); sockets[0]!.open();
    sockets[0]!.message({ type: 'host_identity', roomCode: 'ROOM', isHost: false, loadingGeneration: 0 });
    expect(commands(sockets[0]!)).toEqual([
      { type: 'spectate', roomCode: 'ROOM', count: 3 },
    ]);
    sockets[0]!.message({ type: 'host_identity', roomCode: 'ROOM', isHost: true, loadingGeneration: 0 });
    sockets[0]!.message({ type: 'host_identity', roomCode: 'ROOM', isHost: true, loadingGeneration: 0 });
    expect(commands(sockets[0]!)).toEqual([
      { type: 'spectate', roomCode: 'ROOM', count: 3 },
      { type: 'configure_seats', roomCode: 'ROOM', count: 3 },
    ]);
    connection.close();
  });

  it('reports clock responses with the browser receipt timestamp', () => {
    vi.setSystemTime(20_200);
    const connection = new TriviaConnection('ws://trivia');
    const synced = vi.fn();
    connection.onClockSync(synced);
    sockets[0]!.open();
    sockets[0]!.message({ type: 'clock_sync', clientSentAtMs: 20_000, serverNowMs: 30_100 });
    expect(synced).toHaveBeenCalledWith({
      clientSentAtMs: 20_000,
      clientReceivedAtMs: 20_200,
      serverNowMs: 30_100,
    });
    connection.close();
  });

  it('joins, controls, leaves, and restores the local display-player session on reconnect', () => {
    const connection = new TriviaConnection('ws://trivia', 'en-US');
    const joined = vi.fn();
    connection.onJoined(joined);
    connection.spectate('4821');
    sockets[0]!.open();
    connection.join('4821', 'Local Player');
    const join = commands(sockets[0]!).at(-1)!;
    expect(join).toMatchObject({
      type: 'join', roomCode: '4821', name: 'Local Player', locale: 'en-US', sessionId: expect.any(String),
    });
    sockets[0]!.message({ type: 'joined', playerId: 't1', roomCode: '4821' });
    expect(joined).toHaveBeenCalledWith('t1');
    connection.selectCategory('science');
    connection.advance();
    connection.keyboardAnswer('c');
    expect(commands(sockets[0]!).slice(-3)).toEqual([
      { type: 'select_category', category: 'science' },
      { type: 'advance' },
      { type: 'keyboard_answer', choiceId: 'c' },
    ]);

    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    expect(commands(sockets[1]!).at(-1)).toEqual(join);
    connection.leave('4821');
    expect(commands(sockets[1]!).at(-1)).toMatchObject({ type: 'leave', sessionId: join.sessionId });
    connection.close();
  });
});
