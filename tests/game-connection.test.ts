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
