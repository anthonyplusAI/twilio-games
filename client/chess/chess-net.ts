import type { ChessEvent, ChessServerMessage, ChessState } from '../../shared/chess-protocol';

export type ChessConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export function chessWebSocketUrl(page: Location): string {
  if (page.protocol !== 'http:' && page.protocol !== 'https:') {
    throw new Error('Voice Chess needs an HTTP or HTTPS page.');
  }
  return `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}/chess?display=1`;
}

export class ChessConnection {
  private socket: WebSocket | null = null;
  private generation = 0;
  private stopped = false;
  private backoffMs = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stateListener?: (state: ChessState) => void;
  private eventListener?: (events: readonly ChessEvent[]) => void;
  private errorListener?: (code: string, message: string) => void;
  private connectionListener?: (status: ChessConnectionState) => void;

  constructor(private readonly url: string, private readonly roomCode: string,
    private readonly displayToken: string | null, private readonly locale: string) {
    this.connect();
  }

  onState(listener: (state: ChessState) => void): void { this.stateListener = listener; }
  onEvents(listener: (events: readonly ChessEvent[]) => void): void { this.eventListener = listener; }
  onError(listener: (code: string, message: string) => void): void { this.errorListener = listener; }
  onConnection(listener: (status: ChessConnectionState) => void): void { this.connectionListener = listener; }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.socket?.close(); } catch { /* Connection may already be closed. */ }
    this.connectionListener?.('closed');
  }

  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    const socket = this.socket = new WebSocket(this.url);
    this.connectionListener?.(generation === 1 ? 'connecting' : 'reconnecting');
    socket.onopen = () => {
      if (this.stopped || generation !== this.generation) return;
      this.backoffMs = 500;
      // Display authorization must be sent before room subscription on station launches.
      if (this.displayToken) socket.send(JSON.stringify({ type: 'display_auth', roomCode: this.roomCode, token: this.displayToken }));
      socket.send(JSON.stringify({ type: 'spectate', roomCode: this.roomCode, locale: this.locale }));
      this.connectionListener?.('connected');
    };
    socket.onmessage = event => {
      if (this.stopped || generation !== this.generation) return;
      let value: unknown;
      try { value = JSON.parse(String(event.data)) as unknown; }
      catch {
        this.errorListener?.('bad_json', this.locale === 'pt-BR'
          ? 'A sala de xadrez enviou uma mensagem ilegível.'
          : 'The chess chamber sent an unreadable message.');
        return;
      }
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      const message = value as ChessServerMessage;
      if (message.type === 'chess_state' && Array.isArray(message.pieces)) this.stateListener?.(message);
      else if (message.type === 'chess_events' && Array.isArray(message.events)) this.eventListener?.(message.events);
      else if (message.type === 'error') this.errorListener?.(message.code, message.message);
      // chess_capabilities is informational; the display has already sent its token first.
    };
    socket.onclose = event => {
      if (this.stopped || generation !== this.generation) return;
      if (event.code === 4001) {
        this.connectionListener?.('closed');
        return;
      }
      this.connectionListener?.('reconnecting');
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 8_000);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
    socket.onerror = () => undefined;
  }
}
