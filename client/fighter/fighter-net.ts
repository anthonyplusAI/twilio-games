import type { FighterCommand, FighterEvent } from '../../shared/fighter-world';
import type { FighterMapEntry, FighterRosterEntry } from '../../shared/fighter-roster';
import type { FighterServerMessage, FighterState } from '../../shared/fighter-protocol';
import type { SupportedLocale } from '../../shared/i18n/locales';
import { withDisplaySession } from '../display-session';

export type FighterConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export class FighterConnection {
  private ws!: WebSocket;
  private closed = false;
  private backoff = 500;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identity: { type: 'join'; roomCode: string; name: string; sessionId: string; locale?: SupportedLocale } | { type: 'spectate'; roomCode: string; locale?: SupportedLocale } | null = null;
  private displayAuth: { roomCode: string; token: string } | null = null;
  private displayAuthSupported = false;
  private displayAuthSentGeneration = 0;
  private sessionSentGeneration = 0;
  private stateCb?: (state: FighterState) => void;
  private eventsCb?: (events: FighterEvent[]) => void;
  private rosterCb?: (fighters: FighterRosterEntry[], maps: FighterMapEntry[]) => void;
  private joinedCb?: (id: string) => void;
  private errorCb?: (code: string, message: string) => void;
  private connectionCb?: (state: FighterConnectionState) => void;
  private hostCb?: (isHost: boolean) => void;
  private showResultsCb?: (loadingGeneration: number) => void;
  private pendingReleaseSessionId: string | null = null;
  private loadingGeneration = 0;

  constructor(private url: string, private locale?: SupportedLocale) { this.connect(); }
  private connect(): void {
    const generation = ++this.generation;
    const ws = this.ws = new WebSocket(withDisplaySession(this.url));
    this.connectionCb?.(generation === 1 ? 'connecting' : 'reconnecting');
    ws.onopen = () => {
      if (generation !== this.generation || this.closed) return;
      this.backoff = 500;
      this.connectionCb?.('connected');
      if (this.pendingReleaseSessionId) { this.sendNow(ws, { type: 'leave', sessionId: this.pendingReleaseSessionId }); this.pendingReleaseSessionId = null; }
      // A configured display waits for the server's first frame so a future capability
      // advertisement can place authentication before room identity.
      if (!this.displayAuth || this.displayAuthSupported) this.flushSession(ws, generation);
    };
    ws.onmessage = event => {
      if (generation !== this.generation) return;
      let message: FighterServerMessage;
      try { message = JSON.parse(event.data as string) as typeof message; }
      catch { this.errorCb?.('bad_json', 'The server sent an invalid response.'); return; }
      if (message.type === 'fighter_capabilities' && message.displayAuth === true) {
        this.displayAuthSupported = true; this.sendDisplayAuth(ws, generation); this.flushSession(ws, generation); return;
      }
      this.flushSession(ws, generation);
      if (message.type === 'fighter_state') { this.loadingGeneration = message.loadingGeneration; this.stateCb?.(message); }
      else if (message.type === 'fighter_events') this.eventsCb?.(message.events);
      else if (message.type === 'fighter_roster') this.rosterCb?.(message.fighters, message.maps);
      else if (message.type === 'joined') this.joinedCb?.(message.playerId);
      else if (message.type === 'host_identity') { this.loadingGeneration = message.loadingGeneration; this.hostCb?.(message.isHost); }
      else if (message.type === 'show_results') this.showResultsCb?.(message.loadingGeneration);
      else if (message.type === 'error') this.errorCb?.(message.code, message.message);
    };
    ws.onclose = event => {
      if (generation !== this.generation) return;
      if (this.closed || event.code === 4001) { this.connectionCb?.('closed'); return; }
      this.connectionCb?.('reconnecting');
      const delay = this.backoff; this.backoff = Math.min(this.backoff * 2, 8000);
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
    };
    ws.onerror = () => {};
  }
  private sendNow(ws: WebSocket, value: unknown): void { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }
  private send(value: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.sendNow(this.ws, value);
  }
  private sendDisplayAuth(ws: WebSocket, generation: number): void {
    if (!this.displayAuthSupported || !this.displayAuth || this.displayAuthSentGeneration === generation) return;
    this.sendNow(ws, { type: 'display_auth', ...this.displayAuth });
    this.displayAuthSentGeneration = generation;
  }
  private flushSession(ws: WebSocket, generation: number): void {
    if (this.sessionSentGeneration === generation) return;
    this.sendDisplayAuth(ws, generation);
    if (this.identity) this.sendNow(ws, this.identity);
    this.sessionSentGeneration = generation;
  }
  join(roomCode: string, name: string): void {
    this.identity = { type: 'join', roomCode, name, sessionId: sessionIdFor(roomCode), ...(this.locale ? { locale: this.locale } : {}) };
    if (this.ws.readyState === WebSocket.OPEN) this.sendNow(this.ws, this.identity);
  }
  spectate(roomCode: string): void { this.identity = { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}) }; if (this.ws.readyState === WebSocket.OPEN) this.sendNow(this.ws, this.identity); }
  setDisplayAuth(roomCode: string, token: string | null): void {
    this.displayAuth = token ? { roomCode, token } : null;
    if (this.displayAuth) this.sendDisplayAuth(this.ws, this.generation);
  }
  leave(roomCode: string, keepWatching = true): void {
    const sessionId = this.identity?.type === 'join' ? this.identity.sessionId : undefined;
    this.identity = { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}) };
    clearSessionId(roomCode);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.sendNow(this.ws, { type: 'leave', ...(sessionId ? { sessionId } : {}) });
      if (keepWatching) this.sendNow(this.ws, this.identity);
    }
    else this.pendingReleaseSessionId = sessionId ?? null;
  }
  leaveAndClose(roomCode: string): void {
    const sessionId = this.identity?.type === 'join' ? this.identity.sessionId : null;
    if (sessionId) {
      const body = JSON.stringify({ roomCode, sessionId });
      const sent = navigator.sendBeacon?.('/api/fighter/leave', new Blob([body], { type: 'application/json' })) ?? false;
      if (!sent) void fetch('/api/fighter/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
    this.leave(roomCode,false); this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    setTimeout(() => { try { this.ws.close(); } catch {} }, 40);
  }
  selectFighter(fighterId: string): void { this.send({ type: 'select_fighter', fighterId }); }
  selectMap(mapId: string): void { this.send({ type: 'select_map', mapId }); }
  displaySelectFighter(playerId: string, fighterId: string): void {
    this.send({ type: 'display_select_fighter', playerId, fighterId });
  }
  displaySelectMap(playerId: string, mapId: string): void {
    this.send({ type: 'display_select_map', playerId, mapId });
  }
  /** A paint receipt belongs to the current socket; never replay it after reconnect. */
  ackDisplay(phase:'fight'|'results',loadingGeneration:number):void{
    this.sendNow(this.ws,{type:'ack_display',phase,loadingGeneration});
  }
  command(command: FighterCommand): void { this.send({ type: 'command', command }); }
  advance(): void { this.send({ type: 'advance' }); }
  ready(): void { if (this.loadingGeneration) this.send({ type: 'ready', loadingGeneration: this.loadingGeneration }); }
  retryLoading(): void { if (this.loadingGeneration) this.send({ type: 'retry_loading', loadingGeneration: this.loadingGeneration }); }
  back(): void { this.send({ type: 'back' }); }
  onState(cb: (state: FighterState) => void): void { this.stateCb = cb; }
  onEvents(cb: (events: FighterEvent[]) => void): void { this.eventsCb = cb; }
  onRoster(cb: (fighters: FighterRosterEntry[], maps: FighterMapEntry[]) => void): void { this.rosterCb = cb; }
  onJoined(cb: (id: string) => void): void { this.joinedCb = cb; }
  onError(cb: (code: string, message: string) => void): void { this.errorCb = cb; }
  onHostIdentity(cb: (isHost: boolean) => void): void { this.hostCb = cb; }
  onShowResults(cb: (loadingGeneration: number) => void): void { this.showResultsCb = cb; }
  onConnectionState(cb: (state: FighterConnectionState) => void): void {
    this.connectionCb = cb;
    cb(this.ws?.readyState === WebSocket.OPEN ? 'connected' : this.closed ? 'closed' : this.generation > 1 ? 'reconnecting' : 'connecting');
  }
}

function sessionIdFor(room: string): string {
  const key = sessionKey(room);
  try {
    const prior = sessionStorage.getItem(key); if (prior) return prior;
    const id = crypto.randomUUID(); sessionStorage.setItem(key, id); return id;
  } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}
function clearSessionId(room: string): void { try { sessionStorage.removeItem(sessionKey(room)); } catch {} }
const sessionKey = (room: string) => `voice-fighter-session:${room}`;
