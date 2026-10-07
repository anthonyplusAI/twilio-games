import type { SupportedLocale } from '../../shared/i18n/locales';
import type { TriviaRoundCategoryId } from '../../shared/trivia';
import type { TriviaEvent, TriviaServerMessage, TriviaState } from '../../shared/trivia-protocol';
import type { TriviaClockSyncSample } from './trivia-client-utils';
import { withDisplaySession } from '../display-session';

export type TriviaConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

type Identity =
  | { type: 'join'; roomCode: string; name: string; sessionId: string; locale?: SupportedLocale }
  | { type: 'spectate'; roomCode: string; locale?: SupportedLocale };

export class TriviaConnection {
  private ws!: WebSocket;
  private closed = false;
  private backoffMs = 500;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private clockSyncTimer: ReturnType<typeof setInterval> | null = null;
  private identity: Identity | null = null;
  private displayAuth: { roomCode: string; token: string } | null = null;
  private displayAuthSupported = false;
  private displayAuthSentGeneration = 0;
  private identitySentGeneration = 0;
  private outbound: unknown[] = [];
  private pendingReleaseSessionId: string | null = null;
  private stateCallback?: (state: TriviaState) => void;
  private eventsCallback?: (events: readonly TriviaEvent[]) => void;
  private hostCallback?: (isHost: boolean) => void;
  private joinedCallback?: (playerId: string) => void;
  private errorCallback?: (code: string, message: string) => void;
  private connectionCallback?: (state: TriviaConnectionState) => void;
  private clockSyncCallback?: (sample: TriviaClockSyncSample) => void;

  constructor(private readonly url: string, private readonly locale?: SupportedLocale) {
    this.connect();
  }

  private connect(): void {
    const generation = ++this.generation;
    const ws = this.ws = new WebSocket(withDisplaySession(this.url));
    this.connectionCallback?.(generation === 1 ? 'connecting' : 'reconnecting');
    ws.onopen = () => {
      if (generation !== this.generation || this.closed) return;
      this.backoffMs = 500;
      this.connectionCallback?.('connected');
      this.startClockSync(ws);
      if (this.pendingReleaseSessionId) {
        this.sendNow(ws, { type: 'leave', sessionId: this.pendingReleaseSessionId });
        this.pendingReleaseSessionId = null;
      }
      if (!this.displayAuth || this.displayAuthSupported) this.flushIdentity(ws, generation);
    };
    ws.onmessage = event => {
      if (generation !== this.generation) return;
      const receivedAtMs = Date.now();
      let value: unknown;
      try { value = JSON.parse(event.data as string) as unknown; }
      catch { this.errorCallback?.('bad_json', 'The server sent an invalid response.'); return; }
      if (isClockSyncFrame(value)) {
        this.clockSyncCallback?.({
          serverNowMs: value.serverNowMs,
          clientSentAtMs: value.clientSentAtMs,
          clientReceivedAtMs: receivedAtMs,
        });
        return;
      }
      const message = value as TriviaServerMessage;
      if (message.type === 'trivia_capabilities') {
        this.displayAuthSupported = message.displayAuth;
        this.sendDisplayAuth(ws, generation);
        this.flushIdentity(ws, generation);
        return;
      }
      this.flushIdentity(ws, generation);
      if (message.type === 'trivia_state') this.stateCallback?.(message);
      else if (message.type === 'trivia_events') this.eventsCallback?.(message.events);
      else if (message.type === 'joined') this.joinedCallback?.(message.playerId);
      else if (message.type === 'host_identity') this.hostCallback?.(message.isHost);
      else if (message.type === 'error') this.errorCallback?.(message.code, message.message);
    };
    ws.onclose = event => {
      if (generation !== this.generation) return;
      this.stopClockSync();
      if (this.closed || event.code === 4001) {
        this.connectionCallback?.('closed');
        return;
      }
      this.connectionCallback?.('reconnecting');
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 8_000);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
    ws.onerror = () => undefined;
  }

  private sendNow(ws: WebSocket, value: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  }

  private send(value: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.sendNow(this.ws, value);
    else if (!this.closed) this.outbound.push(value);
  }

  private sendDisplayAuth(ws: WebSocket, generation: number): void {
    if (!this.displayAuthSupported || !this.displayAuth || this.displayAuthSentGeneration === generation) return;
    this.sendNow(ws, { type: 'display_auth', ...this.displayAuth });
    this.displayAuthSentGeneration = generation;
  }

  private flushIdentity(ws: WebSocket, generation: number): void {
    if (this.identitySentGeneration === generation) return;
    this.sendDisplayAuth(ws, generation);
    if (this.identity) this.sendNow(ws, this.identity);
    for (const value of this.outbound.splice(0)) this.sendNow(ws, value);
    this.identitySentGeneration = generation;
  }

  private startClockSync(ws: WebSocket): void {
    this.stopClockSync();
    const sync = () => this.sendNow(ws, { type: 'clock_sync', clientSentAtMs: Date.now() });
    sync();
    this.clockSyncTimer = setInterval(sync, 5_000);
  }

  private stopClockSync(): void {
    if (this.clockSyncTimer) clearInterval(this.clockSyncTimer);
    this.clockSyncTimer = null;
  }

  setDisplayAuth(roomCode: string, token: string | null): void {
    this.displayAuth = token ? { roomCode, token } : null;
    if (this.displayAuth) this.sendDisplayAuth(this.ws, this.generation);
  }

  spectate(roomCode: string): void {
    this.identity = { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}) };
    if (this.ws.readyState === WebSocket.OPEN) this.sendNow(this.ws, this.identity);
  }

  join(roomCode: string, name: string): void {
    this.identity = {
      type: 'join', roomCode, name, sessionId: sessionIdFor(roomCode),
      ...(this.locale ? { locale: this.locale } : {}),
    };
    if (this.ws.readyState === WebSocket.OPEN) this.sendNow(this.ws, this.identity);
  }

  leave(roomCode: string): void {
    const sessionId = this.identity?.type === 'join' ? this.identity.sessionId : undefined;
    this.identity = { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}) };
    this.outbound = [];
    clearSessionId(roomCode);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.sendNow(this.ws, { type: 'leave', ...(sessionId ? { sessionId } : {}) });
    } else this.pendingReleaseSessionId = sessionId ?? null;
  }

  selectCategory(category: TriviaRoundCategoryId): void { this.send({ type: 'select_category', category }); }
  displaySelectCategory(playerId: string, category: TriviaRoundCategoryId): void {
    this.send({ type: 'display_select_category', playerId, category });
  }
  viewRendered(questionId: string, questionAttemptId: number,
    phase: 'question_prompt' | 'answer_cue', renderRevision: number): void {
    this.send({ type: 'view_rendered', questionId, questionAttemptId, phase, renderRevision });
  }
  advance(): void { this.send({ type: 'advance' }); }
  keyboardAnswer(choiceId: string): void { this.send({ type: 'keyboard_answer', choiceId }); }

  /** The protocol names display_ready as ready and scopes it to a loading generation. */
  displayReady(loadingGeneration: number): void {
    if (Number.isSafeInteger(loadingGeneration) && loadingGeneration > 0) {
      this.send({ type: 'ready', loadingGeneration });
    }
  }

  close(): void {
    this.closed = true;
    this.outbound = [];
    this.stopClockSync();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws.close(); } catch { /* already closed */ }
  }

  onState(callback: (state: TriviaState) => void): void { this.stateCallback = callback; }
  onEvents(callback: (events: readonly TriviaEvent[]) => void): void { this.eventsCallback = callback; }
  onJoined(callback: (playerId: string) => void): void { this.joinedCallback = callback; }
  onHostIdentity(callback: (isHost: boolean) => void): void { this.hostCallback = callback; }
  onError(callback: (code: string, message: string) => void): void { this.errorCallback = callback; }
  onClockSync(callback: (sample: TriviaClockSyncSample) => void): void { this.clockSyncCallback = callback; }
  onConnectionState(callback: (state: TriviaConnectionState) => void): void {
    this.connectionCallback = callback;
    callback(this.ws?.readyState === WebSocket.OPEN ? 'connected' : this.closed ? 'closed'
      : this.generation > 1 ? 'reconnecting' : 'connecting');
  }
}

function sessionIdFor(roomCode: string): string {
  const key = sessionKey(roomCode);
  try {
    const prior = sessionStorage.getItem(key);
    if (prior) return prior;
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function clearSessionId(roomCode: string): void {
  try { sessionStorage.removeItem(sessionKey(roomCode)); } catch { /* best effort */ }
}

const sessionKey = (roomCode: string): string => `voice-trivia-local-session:${roomCode}`;

function isClockSyncFrame(value: unknown): value is {
  type: 'clock_sync';
  serverNowMs: number;
  clientSentAtMs: number;
} {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return frame.type === 'clock_sync' && typeof frame.serverNowMs === 'number'
    && Number.isFinite(frame.serverNowMs) && typeof frame.clientSentAtMs === 'number'
    && Number.isFinite(frame.clientSentAtMs);
}
