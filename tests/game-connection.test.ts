import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameConnection } from '../client/net';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  private openListeners: Array<() => void> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  addEventListener(type: string, listener: () => void): void {
    if (type === 'open') this.openListeners.push(listener);
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
    for (const listener of this.openListeners.splice(0)) listener();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('GameConnection identity establishment', () => {
  it('restores spectating after the local P player leaves the shared display', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const connection = new GameConnection('ws://example.test/game');
    const socket = FakeWebSocket.instances[0]!;
    connection.spectate('4821');
    socket.open();
    connection.join('4821', 'Local tester');
    connection.leave();

    expect(socket.sent.map(value => JSON.parse(value)).slice(-3)).toEqual([
      { type: 'join', roomCode: '4821', name: 'Local tester' },
      { type: 'leave' },
      { type: 'spectate', roomCode: '4821' },
    ]);
    connection.dispose();
  });
  it('includes standalone seats in the first display identity and reconnect', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const connection = new GameConnection('ws://example.test/game');
    connection.configureSeats('4821', 2);
    connection.spectate('4821');
    const first = FakeWebSocket.instances[0]!;
    first.open();
    expect(first.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'spectate', roomCode: '4821', count: 2 },
    ]);
    first.close();
    vi.advanceTimersByTime(500);
    const replacement = FakeWebSocket.instances[1]!;
    replacement.open();
    expect(replacement.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'spectate', roomCode: '4821', count: 2 },
    ]);
    connection.dispose();
  });
  it('sends a pre-open join exactly once', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const connection = new GameConnection('ws://example.test/game', 'en-US');
    const socket = FakeWebSocket.instances[0]!;

    connection.join('4821', 'Ada');
    expect(socket.sent).toEqual([]);
    socket.open();

    expect(socket.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'join', roomCode: '4821', name: 'Ada', locale: 'en-US' },
    ]);
    connection.dispose();
  });

  it('labels a keyboard tester join with its page-owned session and toggle generation', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const connection = new GameConnection('ws://example.test/game');
    const socket = FakeWebSocket.instances[0]!;

    connection.join('4821', 'Keyboard', true, {
      id: '0123456789abcdef0123456789abcdef', generation: 2,
    });
    socket.open();

    expect(socket.sent.map(value => JSON.parse(value))).toEqual([{
      type: 'join', roomCode: '4821', name: 'Keyboard', rendererReadyGate: true,
      keyboardSession: { id: '0123456789abcdef0123456789abcdef', generation: 2 },
    }]);
    connection.dispose();
  });

  it('replays an unacknowledged keyboard release after the display reconnects', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const display = new GameConnection('ws://example.test/game?display=1');
    const first = FakeWebSocket.instances[0]!;
    display.spectate('4821');
    first.open();
    first.close();

    (display as unknown as { releaseKeyboardSession?: (roomCode: string,
      session: { id: string; generation: number }) => void }).releaseKeyboardSession?.('4821', {
      id: '0123456789abcdef0123456789abcdef', generation: 1,
    });
    vi.advanceTimersByTime(500);
    const replacement = FakeWebSocket.instances[1]!;
    replacement.open();
    expect(replacement.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'spectate', roomCode: '4821' },
      { type: 'release_keyboard_session', roomCode: '4821',
        keyboardSession: { id: '0123456789abcdef0123456789abcdef', generation: 1 } },
    ]);

    replacement.onmessage?.({ data: JSON.stringify({ type: 'keyboard_session_released',
      roomCode: '4821', keyboardSession: { id: '0123456789abcdef0123456789abcdef', generation: 1 } }) });
    replacement.close();
    vi.advanceTimersByTime(500);
    const next = FakeWebSocket.instances[2]!;
    next.open();
    expect(next.sent.map(value => JSON.parse(value))).toEqual([{ type: 'spectate', roomCode: '4821' }]);
    display.dispose();
  });

  it('replays the identity once on a replacement socket', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const connection = new GameConnection('ws://example.test/game');
    const first = FakeWebSocket.instances[0]!;
    connection.spectate('4821');
    first.open();
    first.close();

    vi.advanceTimersByTime(500);
    const replacement = FakeWebSocket.instances[1]!;
    replacement.open();

    expect(first.sent).toHaveLength(1);
    expect(replacement.sent.map(value => JSON.parse(value))).toEqual([{ type: 'spectate', roomCode: '4821' }]);
    connection.dispose();
  });

  it('drops menu actions spoken or tapped while disconnected instead of replaying stale commands', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const connection = new GameConnection('ws://example.test/game');
    const first = FakeWebSocket.instances[0]!;
    connection.join('4821', 'Ada');
    connection.advance();
    connection.selectCar(1);
    first.open();
    expect(first.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'join', roomCode: '4821', name: 'Ada' },
    ]);

    first.close();
    connection.advance();
    connection.selectMap('Silver Lake');
    vi.advanceTimersByTime(500);
    const replacement = FakeWebSocket.instances[1]!;
    replacement.open();
    expect(replacement.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'join', roomCode: '4821', name: 'Ada' },
    ]);
    connection.dispose();
  });
});
