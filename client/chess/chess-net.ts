import type { ChessEvent, ChessMode, ChessServerMessage, ChessState } from '../../shared/chess-protocol';
import { WIZARD_CHESS_DIALOGUE } from '../../shared/wizard-chess-scene';
import { withDisplaySession } from '../display-session';

export type ChessConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

/** Every standalone launch names its mode so a previous match cannot supply a stale default. */
export function chessModeForLaunch(query: URLSearchParams, stationManaged: boolean): ChessMode | null {
  if (stationManaged) return null;
  return query.get('players') === '2' ? 'pvp' : 'solo';
}

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
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private pendingWizardSkip: number | null = null;
  private pendingWizardProgress: { sceneId: number; cursor: number } | null = null;
  private stateListener?: (state: ChessState) => void;
  private eventListener?: (events: readonly ChessEvent[]) => void;
  private errorListener?: (code: string, message: string) => void;
  private connectionListener?: (status: ChessConnectionState) => void;
  private clockListener?: (offsetMs: number) => void;

  constructor(private readonly url: string, private readonly roomCode: string,
    private readonly displayToken: string | null, private readonly locale: string,
    private readonly preferredMode: ChessMode | null = null) {
    this.connect();
  }

  onState(listener: (state: ChessState) => void): void { this.stateListener = listener; }
  onEvents(listener: (events: readonly ChessEvent[]) => void): void { this.eventListener = listener; }
  onError(listener: (code: string, message: string) => void): void { this.errorListener = listener; }
  onConnection(listener: (status: ChessConnectionState) => void): void { this.connectionListener = listener; }
  onClockOffset(listener: (offsetMs: number) => void): void { this.clockListener = listener; }

  /** A result-menu tap is discarded while disconnected; replay must match the visible game ID. */
  replay(gameId: number): void {
    if (!Number.isSafeInteger(gameId) || gameId < 1 || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'display_replay', roomCode: this.roomCode, gameId }));
  }

  /** Keep this idempotent scene request until a server state confirms it. */
  skipWizard(sceneId: number): void {
    if (!Number.isSafeInteger(sceneId) || sceneId < 1 || this.stopped) return;
    this.pendingWizardSkip = sceneId;
    this.sendPendingWizardSkip();
  }

  /** Keep the latest finished line until a server snapshot confirms it. */
  reportWizardProgress(sceneId: number, cursor: number): void {
    if (!Number.isSafeInteger(sceneId) || sceneId < 1 || !Number.isSafeInteger(cursor)
      || cursor < 0 || cursor > WIZARD_CHESS_DIALOGUE.length || this.stopped) return;
    const pending = this.pendingWizardProgress;
    if (pending?.sceneId === sceneId && pending.cursor >= cursor) return;
    this.pendingWizardProgress = { sceneId, cursor };
    this.sendPendingWizardProgress();
  }

  close(): void {
    this.stopped = true;
    this.pendingWizardSkip = null;
    this.pendingWizardProgress = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    try { this.socket?.close(); } catch { /* Connection may already be closed. */ }
    this.connectionListener?.('closed');
  }

  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    const socket = this.socket = new WebSocket(withDisplaySession(this.url));
    let preferredModeReceived = this.preferredMode === null;
    this.connectionListener?.(generation === 1 ? 'connecting' : 'reconnecting');
    socket.onopen = () => {
      if (this.stopped || generation !== this.generation) return;
      this.backoffMs = 500;
      // Display authorization must be sent before room subscription on station launches.
      if (this.displayToken) socket.send(JSON.stringify({ type: 'display_auth', roomCode: this.roomCode, token: this.displayToken }));
      const synchronize = () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
          type: 'clock_sync', clientSentAtMs: Date.now(),
        }));
      };
      // WebSocket frames are ordered. Synchronize before subscribing so a
      // reconnecting display can time the scene before its first snapshot.
      synchronize();
      // Commit standalone mode in the subscription itself, before the room can accept a phone call.
      socket.send(JSON.stringify({ type: 'spectate', roomCode: this.roomCode,
        locale: this.locale, ...(this.preferredMode ? { mode: this.preferredMode } : {}) }));
      this.sendPendingWizardSkip(socket);
      this.sendPendingWizardProgress(socket);
      if (this.clockTimer) clearInterval(this.clockTimer);
      this.clockTimer = setInterval(synchronize, 30_000);
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
      if (message.type === 'chess_state' && Array.isArray(message.pieces)) {
        // Keep a state from an older or incompatible mode off this display.
        if (this.preferredMode && message.mode !== this.preferredMode) return;
        preferredModeReceived = true;
        const pending = this.pendingWizardSkip;
        if (pending !== null && (message.wizardScene?.id !== pending
          || message.wizardScene.phase !== 'story')) this.pendingWizardSkip = null;
        const progress = this.pendingWizardProgress;
        if (progress && (message.wizardScene?.id !== progress.sceneId
          || message.wizardScene.phase !== 'story'
          || (message.wizardScene.dialogueCursor ?? 0) >= progress.cursor)) {
          this.pendingWizardProgress = null;
        }
        this.stateListener?.(message);
      }
      else if (message.type === 'chess_events' && Array.isArray(message.events)
        && preferredModeReceived) this.eventListener?.(message.events);
      else if (message.type === 'error') this.errorListener?.(message.code, message.message);
      else if (message.type === 'clock_sync'
        && Number.isFinite(message.clientSentAtMs) && Number.isFinite(message.serverNowMs)) {
        const receivedAt = Date.now();
        const elapsed = receivedAt - message.clientSentAtMs;
        if (elapsed >= 0 && elapsed <= 5_000) {
          this.clockListener?.(message.serverNowMs - (message.clientSentAtMs + elapsed / 2));
        }
      }
      // chess_capabilities is informational; the display has already sent its token first.
    };
    socket.onclose = event => {
      if (this.stopped || generation !== this.generation) return;
      if (this.clockTimer) clearInterval(this.clockTimer);
      this.clockTimer = null;
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

  private sendPendingWizardSkip(socket = this.socket): void {
    if (this.pendingWizardSkip === null || socket?.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: 'display_wizard_skip',
        roomCode: this.roomCode, sceneId: this.pendingWizardSkip }));
    } catch { /* Keep the request for the next connection. */ }
  }

  private sendPendingWizardProgress(socket = this.socket): void {
    const progress = this.pendingWizardProgress;
    if (!progress || socket?.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: 'display_wizard_progress',
        roomCode: this.roomCode, sceneId: progress.sceneId, cursor: progress.cursor }));
    } catch { /* Keep the checkpoint for the next connection. */ }
  }
}
