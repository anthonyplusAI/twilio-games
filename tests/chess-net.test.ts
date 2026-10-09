import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChessConnection } from '../client/chess/chess-net';
import type { ChessState, WizardChessSceneSnapshot } from '../shared/chess-protocol';
import { WIZARD_CHESS_DIALOGUE } from '../shared/wizard-chess-scene';

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
  disconnect(): void { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

let sockets: MockWebSocket[];
let originalWebSocket: typeof WebSocket;
const sent = (socket: MockWebSocket) => socket.sent
  .map(value => JSON.parse(value) as { type: string })
  .filter(value => value.type !== 'clock_sync');

function chessState(wizardScene: WizardChessSceneSnapshot | null): { type: 'chess_state' } & ChessState {
  return {
    type: 'chess_state', roomCode: 'ROOM', gameId: 1, phase: 'playing',
    playerConnected: true, humanColor: 'w', computerColor: 'b', turn: 'w',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1', pieces: [], revision: 1, ply: 0,
    selection: null, pendingMove: null, hintsRemaining: 3, hint: null,
    lastMove: null, result: null, feedback: null, wizardScene,
  };
}

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

describe('ChessConnection wizard scene control', () => {
  it('chooses an explicit solo mode for a one-caller relaunch after PvP', async () => {
    const net = await import('../client/chess/chess-net') as {
      chessModeForLaunch?: (query: URLSearchParams, stationManaged: boolean) => 'solo' | 'pvp' | null;
    };
    expect(net.chessModeForLaunch?.(new URLSearchParams('players=2'), false)).toBe('pvp');
    expect(net.chessModeForLaunch?.(new URLSearchParams('players=1'), false)).toBe('solo');
    expect(net.chessModeForLaunch?.(new URLSearchParams(), false)).toBe('solo');
    expect(net.chessModeForLaunch?.(new URLSearchParams('players=2'), true)).toBeNull();

    const connection = new ChessConnection('ws://chess', 'ROOM', null, 'en-US', 'solo');
    sockets[0]!.open();
    expect(sent(sockets[0]!)).toContainEqual({ type: 'spectate', roomCode: 'ROOM',
      locale: 'en-US', mode: 'solo' });
    connection.close();
  });

  it('requests the chosen shared-screen Chess mode atomically on subscribe and reconnect', () => {
    const connection = new ChessConnection('ws://chess', 'ROOM', null, 'en-US', 'pvp');
    sockets[0]!.open();
    expect(sent(sockets[0]!)).toEqual([
      { type: 'spectate', roomCode: 'ROOM', locale: 'en-US', mode: 'pvp' },
    ]);
    sockets[0]!.disconnect();
    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    expect(sent(sockets[1]!)).toEqual([
      { type: 'spectate', roomCode: 'ROOM', locale: 'en-US', mode: 'pvp' },
    ]);
    connection.close();
  });

  it('waits for the selected two-caller mode before showing its first board', () => {
    const connection = new ChessConnection('ws://chess', 'ROOM', null, 'en-US', 'pvp');
    const states: ChessState[] = [];
    const events: unknown[] = [];
    connection.onState(state => states.push(state));
    connection.onEvents(items => events.push(...items));
    sockets[0]!.open();
    sockets[0]!.message({ ...chessState(null), mode: 'solo', ply: 1 });
    sockets[0]!.message({ type: 'chess_events', events: [{ type: 'feedback', feedback: {
      code: 'waiting', text: 'Old solo board', sequence: 1,
    } }] });
    expect(states).toEqual([]);
    expect(events).toEqual([]);
    sockets[0]!.message({ ...chessState(null), mode: 'pvp', phase: 'waiting', ply: 0 });
    expect(states).toMatchObject([{ mode: 'pvp', phase: 'waiting', ply: 0 }]);
    connection.close();
  });

  it('resends the highest finished dialogue cursor after reconnect until server state confirms it', () => {
    const connection = new ChessConnection('ws://chess', 'ROOM', 'display-token', 'en-US');
    connection.reportWizardProgress(7, 1);
    connection.reportWizardProgress(7, 2);
    connection.reportWizardProgress(7, 1);
    expect(sent(sockets[0]!)).toEqual([]);

    sockets[0]!.open();
    expect(sent(sockets[0]!)).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'display-token' },
      { type: 'spectate', roomCode: 'ROOM', locale: 'en-US' },
      { type: 'display_wizard_progress', roomCode: 'ROOM', sceneId: 7, cursor: 2 },
    ]);

    sockets[0]!.disconnect();
    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    expect(sent(sockets[1]!).at(-1)).toEqual({
      type: 'display_wizard_progress', roomCode: 'ROOM', sceneId: 7, cursor: 2,
    });
    sockets[1]!.message(chessState({ id: 7, phase: 'story', dialogueCursor: 1,
      startedAt: 0, readyAt: null, resolvedAt: null }));
    sockets[1]!.disconnect();
    vi.advanceTimersByTime(500);
    sockets[2]!.open();
    expect(sent(sockets[2]!).at(-1)).toEqual({
      type: 'display_wizard_progress', roomCode: 'ROOM', sceneId: 7, cursor: 2,
    });
    sockets[2]!.message(chessState({ id: 7, phase: 'story', dialogueCursor: 2,
      startedAt: 0, readyAt: null, resolvedAt: null }));
    sockets[2]!.disconnect();
    vi.advanceTimersByTime(500);
    sockets[3]!.open();
    expect(sent(sockets[3]!)).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'display-token' },
      { type: 'spectate', roomCode: 'ROOM', locale: 'en-US' },
    ]);
    connection.close();
  });

  it('drops stale progress when the server has moved to another Wizard scene', () => {
    const connection = new ChessConnection('ws://chess', 'ROOM', 'display-token', 'en-US');
    connection.reportWizardProgress(7, 4);
    sockets[0]!.open();
    sockets[0]!.message(chessState({ id: 8, phase: 'story', dialogueCursor: 0,
      startedAt: 0, readyAt: null, resolvedAt: null }));
    sockets[0]!.disconnect();
    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    expect(sent(sockets[1]!)).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'display-token' },
      { type: 'spectate', roomCode: 'ROOM', locale: 'en-US' },
    ]);
    connection.close();
  });

  it('does not transmit malformed dialogue progress', () => {
    const connection = new ChessConnection('ws://chess', 'ROOM', 'display-token', 'en-US');
    sockets[0]!.open();
    connection.reportWizardProgress(0, 1);
    connection.reportWizardProgress(7, -1);
    connection.reportWizardProgress(7, 1.5);
    connection.reportWizardProgress(7, WIZARD_CHESS_DIALOGUE.length + 1);
    connection.reportWizardProgress(Number.MAX_SAFE_INTEGER + 1, 1);
    expect(sent(sockets[0]!)).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'display-token' },
      { type: 'spectate', roomCode: 'ROOM', locale: 'en-US' },
    ]);
    connection.close();
  });

  it('queues a disconnected Skip, resends it after reconnect, and clears it after server acknowledgement', () => {
    const connection = new ChessConnection('ws://chess', 'ROOM', 'display-token', 'en-US');
    connection.skipWizard(7);
    expect(sent(sockets[0]!)).toEqual([]);

    sockets[0]!.open();
    expect(sent(sockets[0]!)).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'display-token' },
      { type: 'spectate', roomCode: 'ROOM', locale: 'en-US' },
      { type: 'display_wizard_skip', roomCode: 'ROOM', sceneId: 7 },
    ]);

    sockets[0]!.disconnect();
    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    expect(sent(sockets[1]!).at(-1)).toEqual({ type: 'display_wizard_skip', roomCode: 'ROOM', sceneId: 7 });

    sockets[1]!.message(chessState({ id: 7, phase: 'ready', startedAt: 0, readyAt: 1, resolvedAt: null }));
    sockets[1]!.disconnect();
    vi.advanceTimersByTime(500);
    sockets[2]!.open();
    expect(sent(sockets[2]!)).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'display-token' },
      { type: 'spectate', roomCode: 'ROOM', locale: 'en-US' },
    ]);
    connection.close();
  });

  it('discards a pending Skip when the server has moved to a different scene', () => {
    const connection = new ChessConnection('ws://chess', 'ROOM', 'display-token', 'en-US');
    connection.skipWizard(7);
    sockets[0]!.open();
    sockets[0]!.message(chessState({ id: 8, phase: 'story', startedAt: 0, readyAt: null, resolvedAt: null }));
    sockets[0]!.disconnect();
    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    expect(sent(sockets[1]!)).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'display-token' },
      { type: 'spectate', roomCode: 'ROOM', locale: 'en-US' },
    ]);
    connection.close();
  });
});
