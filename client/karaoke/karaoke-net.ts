import type { KaraokeSong } from '../../shared/karaoke';
import type {
  KaraokeEvent,
  KaraokeServerMessage,
  KaraokeState,
} from '../../shared/karaoke-protocol';
import type { SupportedLocale } from '../../shared/i18n/locales';
import { withDisplaySession } from '../display-session';
import type { KaraokeClockSyncSample } from './karaoke-client-utils';

export type KaraokeConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

type Identity =
  | { type: 'join'; roomCode: string; name: string; sessionId: string; locale?: SupportedLocale }
  | { type: 'spectate'; roomCode: string; locale?: SupportedLocale };

export class KaraokeConnection {
  private ws!: WebSocket;
  private closed = false;
  private backoffMs = 500;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private clockSyncTimer: ReturnType<typeof setInterval> | null = null;
  private outbound: unknown[] = [];
  private identity: Identity | null = null;
  private displayAuth: { roomCode: string; token: string } | null = null;
  private displayAuthSupported = false;
  private displayAuthSentGeneration = 0;
  private identitySentGeneration = 0;
  private loadingGeneration = 0;
  private pendingReleaseSessionId: string | null = null;
  private stateCallback?: (state: KaraokeState) => void;
  private eventsCallback?: (events: KaraokeEvent[]) => void;
  private catalogCallback?: (songs: readonly KaraokeSong[], locale: SupportedLocale) => void;
  private joinedCallback?: (playerId: string) => void;
  private hostCallback?: (isHost: boolean) => void;
  private errorCallback?: (code: string, message: string) => void;
  private connectionCallback?: (state: KaraokeConnectionState) => void;
  private clockSyncCallback?: (sample: KaraokeClockSyncSample) => void;

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
          ...(value.clientSentAtMs === undefined ? {} : { clientSentAtMs: value.clientSentAtMs }),
          clientReceivedAtMs: receivedAtMs,
        });
        return;
      }
      const message = value as KaraokeServerMessage;
      if (message.type === 'karaoke_capabilities' && message.displayAuth) {
        this.displayAuthSupported = true;
        this.sendDisplayAuth(ws, generation);
        this.flushIdentity(ws, generation);
        return;
      }
      this.flushIdentity(ws, generation);
      if (message.type === 'karaoke_state') {
        this.loadingGeneration = message.loadingGeneration;
        this.stateCallback?.(message);
      } else if (message.type === 'karaoke_events') this.eventsCallback?.(message.events);
      else if (message.type === 'karaoke_catalog') this.catalogCallback?.(message.songs, message.locale);
      else if (message.type === 'joined') this.joinedCallback?.(message.playerId);
      else if (message.type === 'host_identity') {
        this.loadingGeneration = message.loadingGeneration;
        this.hostCallback?.(message.isHost);
      } else if (message.type === 'error') this.errorCallback?.(message.code, message.message);
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

  private startClockSync(ws: WebSocket): void {
    this.stopClockSync();
    const send = () => this.sendNow(ws, { type: 'clock_sync', clientSentAtMs: Date.now() });
    send();
    this.clockSyncTimer = setInterval(send, 5_000);
  }

  private stopClockSync(): void {
    if (this.clockSyncTimer) clearInterval(this.clockSyncTimer);
    this.clockSyncTimer = null;
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
    if (this.ws.readyState === WebSocket.OPEN) this.sendNow(this.ws, { type: 'leave', ...(sessionId ? { sessionId } : {}) });
    else this.pendingReleaseSessionId = sessionId ?? null;
  }

  leaveAndClose(roomCode: string): void {
    this.leave(roomCode);
    this.closed = true;
    this.stopClockSync();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    setTimeout(() => { try { this.ws.close(); } catch { /* already closed */ } }, 40);
  }

  selectSong(songId: string): void { this.send({ type: 'select_song', songId }); }
  advance(): void { this.send({ type: 'advance' }); }
  ready(): void { if (this.loadingGeneration) this.send({ type: 'ready', loadingGeneration: this.loadingGeneration }); }
  retryLoading(): void { if (this.loadingGeneration) this.send({ type: 'retry_loading', loadingGeneration: this.loadingGeneration }); }
  laneInput(lane: 0 | 1 | 2 | 3): void { this.send({ type: 'lane_input', lane }); }
  onState(callback: (state: KaraokeState) => void): void { this.stateCallback = callback; }
  onEvents(callback: (events: KaraokeEvent[]) => void): void { this.eventsCallback = callback; }
  onCatalog(callback: (songs: readonly KaraokeSong[], locale: SupportedLocale) => void): void { this.catalogCallback = callback; }
  onJoined(callback: (playerId: string) => void): void { this.joinedCallback = callback; }
  onHostIdentity(callback: (isHost: boolean) => void): void { this.hostCallback = callback; }
  onError(callback: (code: string, message: string) => void): void { this.errorCallback = callback; }
  onConnectionState(callback: (state: KaraokeConnectionState) => void): void {
    this.connectionCallback = callback;
    callback(this.ws?.readyState === WebSocket.OPEN ? 'connected' : this.closed ? 'closed'
      : this.generation > 1 ? 'reconnecting' : 'connecting');
  }
  onClockSync(callback: (sample: KaraokeClockSyncSample) => void): void { this.clockSyncCallback = callback; }
}

function isClockSyncFrame(value: unknown): value is {
  type: 'clock_sync';
  serverNowMs: number;
  clientSentAtMs?: number;
} {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return frame.type === 'clock_sync' && typeof frame.serverNowMs === 'number'
    && Number.isFinite(frame.serverNowMs)
    && (frame.clientSentAtMs === undefined
      || (typeof frame.clientSentAtMs === 'number' && Number.isFinite(frame.clientSentAtMs)));
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

const sessionKey = (roomCode: string): string => `voice-karaoke-session:${roomCode}`;
