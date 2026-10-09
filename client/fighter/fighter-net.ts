import type { FighterCommand, FighterEvent } from '../../shared/fighter-world';
import type { FighterMapEntry, FighterRosterEntry } from '../../shared/fighter-roster';
import type { FighterServerMessage, FighterState } from '../../shared/fighter-protocol';
import type { SupportedLocale } from '../../shared/i18n/locales';
import { navigationDisplaySessionId, withDisplaySession } from '../display-session';

export type FighterConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

interface PendingRelease {
  roomCode: string;
  sessionId: string;
  completed: Promise<void>;
  confirm: () => void;
}

const pendingReleases = new Map<string, PendingRelease>();
const releaseKey = (roomCode: string) => roomCode.trim().toUpperCase();

export class FighterConnection {
  private ws!: WebSocket;
  private closed = false;
  private backoff = 500;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identity: { type: 'join'; roomCode: string; name: string; sessionId: string; locale?: SupportedLocale; initialSeatCount?: 1 | 2 } | { type: 'spectate'; roomCode: string; locale?: SupportedLocale } | null = null;
  private displayAuth: { roomCode: string; token: string } | null = null;
  private displayAuthSupported = false;
  private displayAuthSentGeneration = 0;
  private sessionSentGeneration = 0;
  private seatConfiguration: { roomCode: string; count: 1 | 2 } | null = null;
  private keyboardInitialSeats: { roomCode: string; count: 1 | 2 } | null = null;
  private hostIdentity: boolean | null = null;
  private stateCb?: (state: FighterState) => void;
  private eventsCb?: (events: FighterEvent[]) => void;
  private rosterCb?: (fighters: FighterRosterEntry[], maps: FighterMapEntry[]) => void;
  private joinedCb?: (id: string) => void;
  private errorCb?: (code: string, message: string) => void;
  private connectionCb?: (state: FighterConnectionState) => void;
  private hostCb?: (isHost: boolean) => void;
  private showResultsCb?: (loadingGeneration: number) => void;
  private pendingReleaseSession: { roomCode: string; sessionId: string } | null = null;
  private closingRelease: PendingRelease | null = null;
  private joinBarrier: PendingRelease | null = null;
  private joinSent = false;
  private loadingGeneration = 0;

  constructor(private url: string, private locale?: SupportedLocale) { this.connect(); }
  private connect(): void {
    this.hostIdentity = null;
    const generation = ++this.generation;
    const ws = this.ws = new WebSocket(withDisplaySession(this.url));
    this.connectionCb?.(generation === 1 ? 'connecting' : 'reconnecting');
    ws.onopen = () => {
      if (generation !== this.generation || this.closed) {
        try { ws.close(); } catch { /* the socket may already be closing */ }
        return;
      }
      this.backoff = 500;
      this.connectionCb?.('connected');
      if (this.closingRelease) { this.sendNow(ws, { type: 'release_session', roomCode: this.closingRelease.roomCode,
        sessionId: this.closingRelease.sessionId }); return; }
      if (this.pendingReleaseSession) this.sendNow(ws, { type: 'release_session', ...this.pendingReleaseSession });
      // A configured display waits for the server's first frame so a future capability
      // advertisement can place authentication before room identity.
      if (!this.displayAuth || this.displayAuthSupported) this.flushSession(ws, generation);
    };
    ws.onmessage = event => {
      if (generation !== this.generation) return;
      let message: FighterServerMessage;
      try { message = JSON.parse(event.data as string) as typeof message; }
      catch { this.errorCb?.('bad_json', 'The server sent an invalid response.'); return; }
      if (message.type === 'session_released') {
        if (this.closingRelease && releaseKey(message.roomCode) === releaseKey(this.closingRelease.roomCode)
          && message.sessionId === this.closingRelease.sessionId) this.completeRelease(this.closingRelease);
        if (this.pendingReleaseSession && releaseKey(message.roomCode) === releaseKey(this.pendingReleaseSession.roomCode)
          && message.sessionId === this.pendingReleaseSession.sessionId) this.pendingReleaseSession = null;
        return;
      }
      if (this.closingRelease) return;
      if (message.type === 'fighter_capabilities' && message.displayAuth === true) {
        this.displayAuthSupported = true; this.sendDisplayAuth(ws, generation); this.flushSession(ws, generation); return;
      }
      this.flushSession(ws, generation);
      if (message.type === 'fighter_state') { this.loadingGeneration = message.loadingGeneration; this.stateCb?.(message); }
      else if (message.type === 'fighter_events') this.eventsCb?.(message.events);
      else if (message.type === 'fighter_roster') this.rosterCb?.(message.fighters, message.maps);
      else if (message.type === 'joined') this.joinedCb?.(message.playerId);
      else if (message.type === 'host_identity') {
        this.loadingGeneration = message.loadingGeneration;
        if (this.identity?.roomCode === message.roomCode) {
          const wasHost = this.hostIdentity;
          this.hostIdentity = message.isHost;
          if (wasHost === false && message.isHost && this.identity.type === 'spectate'
            && this.seatConfiguration?.roomCode === message.roomCode) {
            this.sendNow(ws, { type: 'configure_seats', ...this.seatConfiguration });
          }
        }
        this.hostCb?.(message.isHost);
      }
      else if (message.type === 'show_results') this.showResultsCb?.(message.loadingGeneration);
      else if (message.type === 'error') this.errorCb?.(message.code, message.message);
    };
    ws.onclose = event => {
      if (generation !== this.generation) return;
      if (this.closed || (event.code === 4001 && !this.closingRelease)) { this.connectionCb?.('closed'); return; }
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
  private sendIdentity(ws: WebSocket): void {
    if (!this.identity || ws.readyState !== WebSocket.OPEN) return;
    if (this.identity.type === 'join') this.joinSent = true;
    const initialSeatCount = this.identity.type === 'spectate'
      && this.seatConfiguration && releaseKey(this.seatConfiguration.roomCode) === releaseKey(this.identity.roomCode)
      ? this.seatConfiguration.count : undefined;
    this.sendNow(ws, initialSeatCount === undefined ? this.identity : { ...this.identity, initialSeatCount });
  }
  private completeRelease(release: PendingRelease): void {
    if (this.closingRelease !== release) return;
    this.closingRelease = null;
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (pendingReleases.get(releaseKey(release.roomCode)) === release)
      pendingReleases.delete(releaseKey(release.roomCode));
    release.confirm();
    try { this.ws.close(); } catch { /* a reconnect may still be opening */ }
  }
  /** Keep the host display bound while a separate keyboard player joins and reconnects. */
  createKeyboardPlayerConnection(): FighterConnection {
    const url = new URL(this.url);
    url.searchParams.delete('display');
    url.searchParams.delete('displaySessionId');
    const player = new FighterConnection(url.toString(), this.locale);
    player.keyboardInitialSeats = this.seatConfiguration;
    return player;
  }
  private sendDisplayAuth(ws: WebSocket, generation: number): void {
    if (!this.displayAuthSupported || !this.displayAuth || this.displayAuthSentGeneration === generation) return;
    this.sendNow(ws, { type: 'display_auth', ...this.displayAuth });
    this.displayAuthSentGeneration = generation;
  }
  private flushSession(ws: WebSocket, generation: number): void {
    if (this.sessionSentGeneration === generation || this.closingRelease) return;
    this.sendDisplayAuth(ws, generation);
    if (this.identity?.type !== 'join' || !this.joinBarrier) this.sendIdentity(ws);
    this.sessionSentGeneration = generation;
  }
  join(roomCode: string, name: string): void {
    const initialSeatCount = this.keyboardInitialSeats
      && releaseKey(this.keyboardInitialSeats.roomCode) === releaseKey(roomCode)
      ? this.keyboardInitialSeats.count : undefined;
    this.identity = { type: 'join', roomCode, name, sessionId: sessionIdFor(roomCode),
      ...(this.locale ? { locale: this.locale } : {}),
      ...(initialSeatCount === undefined ? {} : { initialSeatCount }) };
    this.joinSent = false;
    const barrier = pendingReleases.get(releaseKey(roomCode)) ?? null;
    this.joinBarrier = barrier;
    if (barrier) void barrier.completed.then(() => {
      if (this.joinBarrier !== barrier) return;
      this.joinBarrier = null;
      if (!this.closed && this.identity?.type === 'join') this.sendIdentity(this.ws);
    });
    else this.sendIdentity(this.ws);
  }
  spectate(roomCode: string): void {
    if (this.identity?.roomCode !== roomCode) this.hostIdentity = null;
    this.identity = { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}) };
    if (this.ws.readyState === WebSocket.OPEN) {
      this.sendIdentity(this.ws);
    }
  }
  setStandaloneSeats(roomCode: string, count: 1 | 2): void {
    this.seatConfiguration = { roomCode, count };
    if (this.ws.readyState === WebSocket.OPEN && this.identity)
      this.sendNow(this.ws, { type: 'configure_seats', ...this.seatConfiguration });
  }
  setDisplayAuth(roomCode: string, token: string | null): void {
    this.displayAuth = token ? { roomCode, token } : null;
    if (this.displayAuth) this.sendDisplayAuth(this.ws, this.generation);
  }
  leave(roomCode: string, keepWatching = true): void {
    const sessionId = this.identity?.type === 'join' ? this.identity.sessionId : undefined;
    const joinSent = this.joinSent;
    this.joinBarrier = null;
    this.joinSent = false;
    this.identity = { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}) };
    clearSessionId(roomCode);
    if (this.ws.readyState === WebSocket.OPEN) {
      if (!sessionId || joinSent) this.sendNow(this.ws, { type: 'leave', ...(sessionId ? { sessionId } : {}) });
      if (keepWatching) this.sendIdentity(this.ws);
    }
    else if (sessionId && joinSent) this.pendingReleaseSession = { roomCode, sessionId };
  }
  leaveAndClose(roomCode: string): void {
    if (this.closed || this.closingRelease) return;
    const activeSessionId = this.identity?.type === 'join' ? this.identity.sessionId : null;
    const pending = this.pendingReleaseSession;
    const sessionId = this.joinSent ? activeSessionId : pending?.sessionId ?? null;
    const releaseRoomCode = this.joinSent ? roomCode : pending?.roomCode ?? roomCode;
    const joinSent = this.joinSent || Boolean(pending);
    this.pendingReleaseSession = null;
    this.identity = null; this.joinBarrier = null; this.joinSent = false;
    clearSessionId(roomCode);
    if (!sessionId || !joinSent) {
      if (this.ws.readyState === WebSocket.OPEN) this.sendNow(this.ws, { type: 'leave' });
      this.closed = true;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      setTimeout(() => { try { this.ws.close(); } catch {} }, 40);
      return;
    }

    let confirm!: () => void;
    const completed = new Promise<void>(resolve => { confirm = resolve; });
    const release: PendingRelease = { roomCode: releaseRoomCode, sessionId, completed, confirm };
    this.closingRelease = release;
    pendingReleases.set(releaseKey(releaseRoomCode), release);
    const body = JSON.stringify({ roomCode: releaseRoomCode, sessionId });
    try { navigator.sendBeacon?.('/api/fighter/leave', new Blob([body], { type: 'application/json' })); }
    catch { /* the acknowledged HTTP/WS attempts still release the seat */ }
    void fetch('/api/fighter/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body, keepalive: true }).then(response => { if (response.ok) this.completeRelease(release); }).catch(() => {});
    if (this.ws.readyState === WebSocket.OPEN) this.sendNow(this.ws, { type: 'release_session', roomCode: releaseRoomCode, sessionId });
    else if (this.ws.readyState !== WebSocket.CONNECTING) {
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.connect();
    }
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
  if (key) try {
    const prior = sessionStorage.getItem(key); if (prior) return prior;
    const id = crypto.randomUUID(); sessionStorage.setItem(key, id); return id;
  } catch { /* Without durable tab claims, keep the ID only on this connection. */ }
  try { return crypto.randomUUID(); }
  catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}
function clearSessionId(room: string): void {
  const key = sessionKey(room);
  if (key) try { sessionStorage.removeItem(key); } catch {}
}
function sessionKey(room: string): string | null {
  const displayId = navigationDisplaySessionId();
  return displayId ? `voice-fighter-session:${displayId}:${releaseKey(room)}` : null;
}
