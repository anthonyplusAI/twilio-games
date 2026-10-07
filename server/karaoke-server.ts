import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { KARAOKE_DEVELOPMENT_SONGS } from '../shared/karaoke-songs';
import type { KaraokeSong } from '../shared/karaoke';
import {
  parseKaraokeClientMessage,
  type KaraokeEvent,
  type KaraokeJudgment,
  type KaraokeServerMessage,
} from '../shared/karaoke-protocol';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import { KaraokeRoom, type KaraokeHit, type KaraokeRoomOptions } from './karaoke-room';

interface Connection {
  ws: WebSocket;
  roomCode?: string;
  playerId?: string;
  sessionId?: string;
  display?: boolean;
  hostAuthorized?: boolean;
  displayAuthenticated?: boolean;
  locale?: SupportedLocale;
  isAlive: boolean;
}

interface Session {
  roomCode: string;
  playerId: string;
  conn: Connection | null;
  timer: ReturnType<typeof setTimeout> | null;
  display: boolean;
  wasHost: boolean;
  hostAuthorized: boolean;
  displayAuthenticated: boolean;
}

export const KARAOKE_RECONNECT_GRACE_MS = 30_000;
export const KARAOKE_RESULT_RECONNECT_GRACE_MS = 60_000;
export const KARAOKE_HEARTBEAT_MS = 30_000;
export const KARAOKE_TICK_MS = 100;
export const KARAOKE_MAX_CONNECTIONS = 64;
export const KARAOKE_MAX_ROOMS = 64;
export const KARAOKE_MAX_PAYLOAD_BYTES = 16 * 1024;

export interface KaraokeServerOptions {
  server?: HttpServer;
  displayToken?: string;
  heartbeatMs?: number;
  reconnectGraceMs?: number;
  resultReconnectGraceMs?: number;
  tickMs?: number;
  now?: () => number;
  songs?: readonly KaraokeSong[];
  webSocketServer?: WebSocketServer;
  roomFactory?: (code: string, options: KaraokeRoomOptions) => KaraokeRoom;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  maxConnections?: number;
  maxRooms?: number;
}

/** Isolated WebSocket/voice adapter. Mounting it on an HTTP path is intentionally left to the host. */
export class KaraokeServer {
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Connection>();
  private readonly rooms = new Map<string, KaraokeRoom>();
  private readonly sessions = new Map<string, Session>();
  private readonly hosts = new Map<string, Connection>();
  private timingLoop: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly displayToken: string;
  private readonly heartbeatMs: number;
  private readonly reconnectGraceMs: number;
  private readonly resultReconnectGraceMs: number;
  private readonly resultReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tickMs: number;
  private readonly now: () => number;
  private songs: readonly KaraokeSong[];
  private readonly roomFactory: (code: string, options: KaraokeRoomOptions) => KaraokeRoom;
  private readonly scheduleInterval: typeof setInterval;
  private readonly cancelInterval: typeof clearInterval;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;
  private readonly maxConnections: number;
  private readonly maxRooms: number;
  private onRoomEvents: ((code: string, events: KaraokeEvent[]) => void) | null = null;
  private onRoomState: ((code: string) => void) | null = null;
  private onDisplayAuthenticated: ((ws: WebSocket) => void) | null = null;
  private onDisplayRegistered: ((ws: WebSocket, roomCode: string) => void) | null = null;
  private allowBrowserPlayer: (roomCode: string) => boolean = () => true;
  private requiresDisplayAuth: (roomCode: string) => boolean = () => false;

  constructor(options: KaraokeServerOptions = {}) {
    this.displayToken = options.displayToken?.trim() ?? '';
    this.heartbeatMs = options.heartbeatMs ?? KARAOKE_HEARTBEAT_MS;
    this.reconnectGraceMs = options.reconnectGraceMs ?? KARAOKE_RECONNECT_GRACE_MS;
    this.resultReconnectGraceMs = options.resultReconnectGraceMs ?? KARAOKE_RESULT_RECONNECT_GRACE_MS;
    this.tickMs = options.tickMs ?? KARAOKE_TICK_MS;
    this.now = options.now ?? Date.now;
    this.songs = options.songs ?? KARAOKE_DEVELOPMENT_SONGS;
    this.roomFactory = options.roomFactory ?? ((code, roomOptions) => new KaraokeRoom(code, roomOptions));
    this.scheduleInterval = options.setInterval ?? setInterval;
    this.cancelInterval = options.clearInterval ?? clearInterval;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.maxConnections = positiveInteger(options.maxConnections ?? KARAOKE_MAX_CONNECTIONS, 'maxConnections');
    this.maxRooms = positiveInteger(options.maxRooms ?? KARAOKE_MAX_ROOMS, 'maxRooms');
    this.wss = options.webSocketServer ?? new WebSocketServer({
      noServer: true,
      maxPayload: KARAOKE_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    void options.server;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, connected?: (ws: WebSocket) => void): void {
    if (this.conns.size >= this.maxConnections) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, ws => {
      if (this.conns.size >= this.maxConnections) {
        ws.close(1013, 'karaoke capacity');
        return;
      }
      connected?.(ws);
      this.onConnection(ws);
    });
  }

  get connectionCount(): number { return this.conns.size; }
  get roomCount(): number { return this.rooms.size; }
  /** A connected, accepted display bound to this room, not merely an upgraded socket. */
  hasStandaloneDisplay(ws: WebSocket, roomCode: string): boolean {
    const code = canonicalRoomCode(roomCode);
    if (!this.rooms.has(code)) return false;
    return [...this.conns].some(conn => conn.ws === ws && conn.roomCode === code
      && conn.display === true && conn.hostAuthorized === true
      && (!this.requiresDisplayAuth(code) || conn.displayAuthenticated === true)
      && ws.readyState === WebSocket.OPEN);
  }
  getOrCreateRoom(code: string): KaraokeRoom { return this.room(canonicalRoomCode(code)); }
  findRoom(code: string): KaraokeRoom | undefined { return this.rooms.get(canonicalRoomCode(code)); }
  setOnRoomEvents(fn: (code: string, events: KaraokeEvent[]) => void): void { this.onRoomEvents = fn; }
  setOnRoomState(fn: (code: string) => void): void { this.onRoomState = fn; }
  setOnDisplayAuthenticated(fn: (ws: WebSocket) => void): void { this.onDisplayAuthenticated = fn; }
  setOnDisplayRegistered(fn: (ws: WebSocket, roomCode: string) => void): void { this.onDisplayRegistered = fn; }
  setBrowserPlayerAdmission(fn: (roomCode: string) => boolean): void { this.allowBrowserPlayer = fn; }
  setDisplayAuthenticationRequirement(fn: (roomCode: string) => boolean): void {
    this.requiresDisplayAuth = fn;
  }

  setSongs(songs: readonly KaraokeSong[]): void {
    if (!songs.length || new Set(songs.map(song => song.id)).size !== songs.length) {
      throw new TypeError('karaoke catalog must contain unique songs');
    }
    this.songs = Object.freeze([...songs]);
    for (const room of this.rooms.values()) room.setSongs(this.songs);
    for (const conn of this.conns) {
      if (!conn.roomCode) this.sendDefaultCatalog(conn);
    }
    for (const code of this.rooms.keys()) this.pushState(code);
  }

  preferredLocale(roomCode?: string, fallback: SupportedLocale = DEFAULT_LOCALE): SupportedLocale {
    const code = roomCode ? canonicalRoomCode(roomCode) : undefined;
    const matching = [...this.conns].filter(conn => (!code || conn.roomCode === code) && conn.locale);
    return matching.find(conn => conn.display)?.locale ?? matching[0]?.locale ?? fallback;
  }

  anonymizePlayer(code: string, playerId: string): void {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room || !room.setName(playerId, 'PLAYER')) return;
    this.pushState(code);
  }

  abortRoom(code: string): boolean {
    code = canonicalRoomCode(code);
    if (!this.rooms.has(code)) return false;
    this.clearResultReconnectTimer(code);
    for (const conn of this.conns) {
      if (conn.roomCode !== code) continue;
      conn.roomCode = undefined;
      conn.playerId = undefined;
      conn.sessionId = undefined;
      conn.ws.close(4002, 'station recovery');
    }
    for (const [key, session] of this.sessions) {
      if (session.roomCode !== code) continue;
      if (session.timer) this.cancelTimeout(session.timer);
      this.sessions.delete(key);
    }
    this.hosts.delete(code);
    this.rooms.delete(code);
    this.syncTimingLoop();
    return true;
  }

  private room(code: string): KaraokeRoom {
    let room = this.rooms.get(code);
    if (!room) {
      room = this.roomFactory(code, {
        now: this.now,
        songs: this.songs,
        preferredLocale: this.preferredLocale(code),
      });
      this.rooms.set(code, room);
    }
    return room;
  }

  private onConnection(ws: WebSocket): void {
    const conn: Connection = { ws, isAlive: true };
    this.conns.add(conn);
    this.ensureHeartbeat();
    ws.on('pong', () => { conn.isAlive = true; });
    this.send(conn, { type: 'karaoke_capabilities', displayAuth: Boolean(this.displayToken) });
    this.sendDefaultCatalog(conn);
    ws.on('message', data => {
      conn.isAlive = true;
      this.onMessage(conn, data.toString());
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      const code = conn.roomCode;
      if (conn.playerId && code && !this.holdSession(conn)) this.rooms.get(code)?.removePlayer(conn.playerId);
      this.conns.delete(conn);
      if (code) {
        if (this.hosts.get(code) === conn) {
          this.hosts.delete(code);
          this.invalidateDisplayReady(code);
          this.designateHost(code);
        }
        this.pushState(code);
        this.reap(code);
      }
      if (!this.conns.size && this.heartbeat) {
        this.cancelInterval(this.heartbeat);
        this.heartbeat = null;
      }
      this.syncTimingLoop();
    });
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = this.scheduleInterval(() => {
      for (const conn of this.conns) {
        if (!conn.isAlive) {
          conn.ws.terminate();
          continue;
        }
        conn.isAlive = false;
        try { conn.ws.ping(); } catch { /* close performs cleanup */ }
      }
    }, this.heartbeatMs);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private onMessage(conn: Connection, raw: string): void {
    const msg = parseKaraokeClientMessage(raw);
    if (msg.type === 'error') {
      this.send(conn, msg);
      return;
    }
    if (msg.type === 'clock_sync') {
      this.send(conn, { type: 'clock_sync', clientSentAtMs: msg.clientSentAtMs, serverNowMs: this.now() });
      return;
    }

    if (msg.type === 'join') {
      if (msg.locale) conn.locale = msg.locale;
      const code = canonicalRoomCode(msg.roomCode);
      if (!this.allowBrowserPlayer(code)) {
        this.send(conn, { type: 'error', code: 'station_voice_only', message: 'station_voice_only' });
        return;
      }
      if (conn.playerId && conn.roomCode) {
        this.send(conn, { type: 'joined', playerId: conn.playerId, roomCode: conn.roomCode });
        return;
      }
      if (conn.roomCode && conn.roomCode !== code) this.detachDisplay(conn);
      if (msg.sessionId && this.resume(code, msg.sessionId, conn)) {
        this.send(conn, { type: 'joined', playerId: conn.playerId!, roomCode: code });
        this.pushHostIdentity(code);
        this.sendCatalog(conn, this.rooms.get(code)!);
        this.pushState(code);
        return;
      }
      if (!this.rooms.has(code) && this.rooms.size >= this.maxRooms) {
        this.send(conn, { type: 'error', code: 'room_capacity', message: 'Karaoke room capacity is exhausted.' });
        return;
      }
      const room = this.room(code);
      const result = room.addPlayer(msg.name);
      if ('error' in result) {
        this.send(conn, { type: 'error', code: result.error, message: result.error });
        return;
      }
      this.clearResultReconnectTimer(code);
      room.setPreferredLocale(this.preferredLocale(code, msg.locale ?? DEFAULT_LOCALE));
      conn.roomCode = code;
      conn.playerId = result.playerId;
      conn.sessionId = msg.sessionId;
      const currentHost = this.hosts.get(code);
      if (conn.display && conn.hostAuthorized && (!currentHost || !currentHost.playerId)) this.hosts.set(code, conn);
      if (conn.display && this.allowBrowserPlayer(code)) {
        room.enableKeyboardScoring(result.playerId);
      }
      if (msg.sessionId) {
        this.sessions.set(sessionKey(code, msg.sessionId), {
          roomCode: code,
          playerId: result.playerId,
          conn,
          timer: null,
          display: conn.display === true,
          wasHost: this.hosts.get(code) === conn,
          hostAuthorized: conn.hostAuthorized === true,
          displayAuthenticated: conn.displayAuthenticated === true,
        });
      }
      this.send(conn, { type: 'joined', playerId: result.playerId, roomCode: code });
      this.sendCatalog(conn, room);
      this.pushHostIdentity(code);
      this.pushState(code);
      return;
    }

    if (msg.type === 'display_auth') {
      if (!this.displayToken || msg.token !== this.displayToken) {
        this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'Invalid display token.' });
        return;
      }
      conn.hostAuthorized = true;
      conn.displayAuthenticated = true;
      const code = canonicalRoomCode(msg.roomCode);
      if (conn.roomCode === code && conn.display) {
        this.hosts.set(code, conn);
        this.pushHostIdentity(code);
      }
      return;
    }

    if (msg.type === 'spectate') {
      if (msg.locale) conn.locale = msg.locale;
      if (conn.playerId) {
        this.send(conn, { type: 'error', code: 'already_joined', message: 'Leave before spectating.' });
        return;
      }
      const code = canonicalRoomCode(msg.roomCode);
      if (conn.roomCode && conn.roomCode !== code) this.detachDisplay(conn);
      const stationDisplay = this.requiresDisplayAuth(code);
      if (stationDisplay && !conn.displayAuthenticated) {
        this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'Invalid display token.' });
        return;
      }
      conn.roomCode = code;
      conn.display = true;
      conn.hostAuthorized = !stationDisplay || conn.hostAuthorized === true;
      if (!this.rooms.has(code) && this.rooms.size >= this.maxRooms) {
        this.send(conn, { type: 'error', code: 'room_capacity', message: 'Karaoke room capacity is exhausted.' });
        conn.roomCode = undefined;
        conn.display = false;
        return;
      }
      const room = this.room(code);
      this.clearResultReconnectTimer(code);
      room.setPreferredLocale(this.preferredLocale(code));
      if (conn.displayAuthenticated) this.onDisplayAuthenticated?.(conn.ws);
      this.onDisplayRegistered?.(conn.ws, code);
      if (conn.displayAuthenticated || (!this.hosts.has(code) && conn.hostAuthorized)) this.hosts.set(code, conn);
      this.sendCatalog(conn, room);
      this.pushHostIdentity(code);
      this.pushState(code);
      return;
    }

    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    if (!room) return;
    const isHost = this.isAuthorizedHost(room.code, conn);
    switch (msg.type) {
      case 'select_song':
        // A paired display may choose for the current singer, but never grants the
        // caller's separate permission to begin capturing their performance.
        if (!conn.playerId && !isHost) this.rejectAuthority(conn);
        else if (!room.selectSong(conn.playerId ?? room.state().singer?.playerId ?? '', msg.songId)) {
          this.send(conn, { type: 'error', code: 'select_rejected', message: 'That song is unavailable.' });
        }
        break;
      case 'advance': {
        if (!isHost) this.rejectAuthority(conn);
        else if (this.requiresDisplayAuth(room.code) && room.phase === 'results') {
          this.send(conn, { type: 'error', code: 'station_requeue_required', message: 'Join the queue again to sing again.' });
        } else if (room.phase === 'song_select' && !conn.playerId) {
          this.send(conn, { type: 'error', code: 'not_ready', message: 'The singer must say Start on their phone.' });
        } else {
          const disconnectedResult = room.phase === 'results' && conn.display && !room.state().singer;
          const playerId = conn.playerId ?? (room.phase === 'results' && conn.display
            ? room.state().singer?.playerId : undefined);
          const advanced = disconnectedResult ? room.restartAfterDisconnect() : room.advance(playerId);
          if (!advanced) this.send(conn, { type: 'error', code: 'not_ready', message: 'Complete the current step first.' });
        }
        break;
      }
      case 'ready':
        if (!isHost) this.rejectAuthority(conn);
        else if (!room.ready(msg.loadingGeneration)) {
          this.send(conn, { type: 'error', code: 'stale_ready', message: 'The song is not awaiting this ready signal.' });
        }
        break;
      case 'retry_loading':
        if (!isHost) this.rejectAuthority(conn);
        else if (!room.retryLoading(msg.loadingGeneration)) {
          this.send(conn, { type: 'error', code: 'stale_ready', message: 'The song is not awaiting this retry.' });
        } else this.pushHostIdentity(room.code);
        break;
      case 'lane_input':
        // Hidden local testing sends only a lane; the authoritative room owns timing and points.
        if (!conn.playerId || !isHost || !this.allowBrowserPlayer(room.code)) {
          this.rejectAuthority(conn);
        } else if (room.enableKeyboardScoring(conn.playerId)) room.keyboardLane(conn.playerId, msg.lane);
        break;
      case 'leave':
        if (conn.playerId) {
          room.removePlayer(conn.playerId);
          if (conn.sessionId) this.dropSession(room.code, conn.sessionId, conn);
          conn.playerId = undefined;
          conn.sessionId = undefined;
        } else if (conn.display) { this.detachDisplay(conn); return; }
        break;
      default:
        break;
    }
    this.flush(room);
    this.pushState(room.code);
    this.reap(room.code);
    this.syncTimingLoop();
  }

  private runTimingTick(): void {
    for (const room of this.rooms.values()) {
      if (!room.isTimingActive) continue;
      const changed = room.tick();
      this.flush(room);
      if (changed) this.pushState(room.code);
    }
    this.syncTimingLoop();
  }

  private syncTimingLoop(): void {
    const needed = [...this.rooms.values()].some(room => room.isTimingActive);
    if (needed && !this.timingLoop) {
      this.timingLoop = this.scheduleInterval(() => this.runTimingTick(), this.tickMs);
      (this.timingLoop as { unref?: () => void }).unref?.();
    } else if (!needed && this.timingLoop) {
      this.cancelInterval(this.timingLoop);
      this.timingLoop = null;
    }
  }

  private flush(room: KaraokeRoom): void {
    const events = room.drainEvents();
    if (!events.length) return;
    for (const conn of this.conns) {
      if (conn.roomCode === room.code) this.send(conn, { type: 'karaoke_events', events });
    }
    this.onRoomEvents?.(room.code, events);
  }

  private pushState(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const message: KaraokeServerMessage = { type: 'karaoke_state', ...room.state() };
    for (const conn of this.conns) if (conn.roomCode === code) this.send(conn, message);
    this.onRoomState?.(code);
  }

  private send(conn: Connection, message: KaraokeServerMessage): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(message));
  }

  private sendDefaultCatalog(conn: Connection): void {
    const locale = conn.locale ?? DEFAULT_LOCALE;
    const localized = this.songs.filter(song => song.locale === locale);
    this.send(conn, { type: 'karaoke_catalog', locale, songs: localized.length ? localized : this.songs });
  }

  private sendCatalog(conn: Connection, room: KaraokeRoom): void {
    const state = room.state();
    this.send(conn, { type: 'karaoke_catalog', locale: state.preferredLocale, songs: state.catalog });
  }

  private resume(code: string, sessionId: string, conn: Connection): boolean {
    const key = sessionKey(code, sessionId);
    const session = this.sessions.get(key);
    if (!session) return false;
    if (!this.rooms.get(code)?.hasPlayer(session.playerId)) {
      this.sessions.delete(key);
      return false;
    }
    if (session.timer) this.cancelTimeout(session.timer);
    conn.display = session.display;
    conn.hostAuthorized = session.hostAuthorized;
    conn.displayAuthenticated = session.displayAuthenticated;
    if (session.conn && session.conn !== conn) {
      const old = session.conn;
      if (this.hosts.get(code) === old) this.hosts.set(code, conn);
      old.playerId = undefined;
      old.sessionId = undefined;
      old.ws.close(4001, 'session replaced');
    }
    if (session.wasHost && !this.hosts.has(code)) this.hosts.set(code, conn);
    session.conn = conn;
    session.timer = null;
    conn.roomCode = code;
    conn.playerId = session.playerId;
    conn.sessionId = sessionId;
    return true;
  }

  private holdSession(conn: Connection): boolean {
    if (!conn.sessionId || !conn.roomCode) return false;
    const key = sessionKey(conn.roomCode, conn.sessionId);
    const session = this.sessions.get(key);
    if (!session || session.conn !== conn) return false;
    session.conn = null;
    session.display = conn.display === true;
    session.wasHost = this.hosts.get(conn.roomCode) === conn;
    session.hostAuthorized = conn.hostAuthorized === true;
    session.displayAuthenticated = conn.displayAuthenticated === true;
    session.timer = this.scheduleTimeout(() => this.release(key), this.reconnectGraceMs);
    (session.timer as { unref?: () => void }).unref?.();
    return true;
  }

  private release(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.timer) this.cancelTimeout(session.timer);
    this.sessions.delete(key);
    this.rooms.get(session.roomCode)?.removePlayer(session.playerId);
    this.pushState(session.roomCode);
    this.reap(session.roomCode);
    this.syncTimingLoop();
  }

  private dropSession(code: string, sessionId: string, owner: Connection): void {
    const key = sessionKey(code, sessionId);
    const session = this.sessions.get(key);
    if (!session || session.conn !== owner) return;
    if (session.timer) this.cancelTimeout(session.timer);
    this.sessions.delete(key);
  }

  private rejectAuthority(conn: Connection): void {
    this.send(conn, { type: 'error', code: 'forbidden', message: 'This connection cannot control the display.' });
  }

  private detachDisplay(conn: Connection): void {
    const code = conn.roomCode;
    if (!code) return;
    conn.roomCode = undefined;
    conn.display = false;
    if (this.hosts.get(code) === conn) {
      this.hosts.delete(code);
      this.invalidateDisplayReady(code);
      this.designateHost(code);
    }
    this.pushState(code);
    this.reap(code);
  }

  private designateHost(code: string): void {
    const next = [...this.conns].find(candidate => candidate.roomCode === code && candidate.display
      && (this.requiresDisplayAuth(code) ? candidate.displayAuthenticated : candidate.hostAuthorized)
      && candidate.ws.readyState === WebSocket.OPEN);
    if (next) this.hosts.set(code, next);
    this.pushHostIdentity(code);
  }

  private invalidateDisplayReady(code: string): void {
    const room = this.rooms.get(code);
    if (!room?.invalidateDisplayReady()) return;
    this.flush(room);
    this.syncTimingLoop();
  }

  private pushHostIdentity(code: string): void {
    const loadingGeneration = this.rooms.get(code)?.state().loadingGeneration ?? 0;
    for (const conn of this.conns) {
      if (conn.roomCode === code) {
        this.send(conn, {
          type: 'host_identity',
          roomCode: code,
          isHost: this.isAuthorizedHost(code, conn),
          loadingGeneration,
        });
      }
    }
  }

  private isAuthorizedHost(code: string, conn: Connection): boolean {
    return this.hosts.get(code) === conn
      && (!this.requiresDisplayAuth(code) || conn.displayAuthenticated === true);
  }

  private clearResultReconnectTimer(code: string): void {
    const timer = this.resultReconnectTimers.get(code);
    if (timer) this.cancelTimeout(timer);
    this.resultReconnectTimers.delete(code);
  }

  private reap(code: string, graceExpired = false): void {
    const room = this.rooms.get(code);
    if (!room?.isEmpty) return;
    if ([...this.conns].some(conn => conn.roomCode === code)) return;
    if ([...this.sessions.values()].some(session => session.roomCode === code)) return;
    if (room.phase === 'results') {
      // A fixed station result belongs to station handoff. For a standalone result, give the
      // display a short chance to reconnect after both it and the singer have disconnected.
      if (room.isFixedStationRound) return;
      if (!graceExpired) {
        if (!this.resultReconnectTimers.has(code)) {
          const timer = this.scheduleTimeout(() => {
            this.resultReconnectTimers.delete(code);
            if (this.rooms.get(code) === room) this.reap(code, true);
          }, this.resultReconnectGraceMs);
          (timer as { unref?: () => void }).unref?.();
          this.resultReconnectTimers.set(code, timer);
        }
        return;
      }
    }
    this.clearResultReconnectTimer(code);
    this.hosts.delete(code);
    this.rooms.delete(code);
  }

  voiceJoin(code: string, name: string, expectedPlayers?: number, nameConfirmed = true,
    preferredLocale?: SupportedLocale, stationManaged = false): string | null {
    code = canonicalRoomCode(code);
    if (!this.rooms.has(code) && this.rooms.size >= this.maxRooms) return null;
    const room = this.room(code);
    const result = room.addPlayer(name, nameConfirmed);
    if ('error' in result) return null;
    room.expectHumanPlayers(expectedPlayers ?? 1, stationManaged);
    this.clearResultReconnectTimer(code);
    room.setPreferredLocale(preferredLocale ?? this.preferredLocale(code));
    this.pushState(code);
    return result.playerId;
  }

  voiceSetName(code: string, playerId: string, name: string): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room || !room.setName(playerId, name)) return false;
    room.expectHumanPlayers(1, false);
    this.pushState(code);
    return true;
  }

  voiceSelectSong(code: string, playerId: string, songId: string): boolean {
    code = canonicalRoomCode(code);
    const accepted = this.rooms.get(code)?.selectSong(playerId, songId) ?? false;
    this.pushState(code);
    return accepted;
  }

  voiceAdvance(code: string, playerId: string): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room || (this.requiresDisplayAuth(code) && room.phase === 'results')) return false;
    const advanced = room.advance(playerId);
    if (room.phase === 'loading') this.pushHostIdentity(code);
    this.pushState(code);
    this.syncTimingLoop();
    return advanced;
  }

  voiceLeave(code: string, playerId: string): void {
    code = canonicalRoomCode(code);
    this.rooms.get(code)?.removePlayer(playerId);
    this.pushState(code);
    this.reap(code);
    this.syncTimingLoop();
  }

  voiceExpectHumanPlayers(code: string, count: number, activeEnginePlayerIds?: readonly string[]): void {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return;
    if (activeEnginePlayerIds) {
      const retained = new Set(activeEnginePlayerIds);
      const singer = room.state().singer;
      if (singer && !retained.has(singer.playerId)) room.removePlayer(singer.playerId);
    }
    room.expectHumanPlayers(count, true);
    this.pushState(code);
    this.syncTimingLoop();
  }

  /** Trusted scorer API; no equivalent browser protocol message exists. */
  updateScore(code: string, playerId: string, score: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return false;
    const accepted = room.updateScore(playerId, score);
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return accepted;
  }

  /** Authenticated Media Streams start seam. */
  markMediaReady(code: string, playerId: string, songId: string, generation: number,
    songStartTimestampMs: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room || !room.mediaReady(playerId, songId, generation, songStartTimestampMs)) return false;
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return true;
  }

  finalizeCurrentPerformance(code: string): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return false;
    const changed = room.tick();
    this.flush(room);
    if (changed) this.pushState(code);
    this.syncTimingLoop();
    return room.state().phase === 'results';
  }

  /** Commits one authenticated media score and publishes the immutable room result in one state update. */
  finalizeMediaScore(code: string, playerId: string, score: number, hits: readonly KaraokeHit[]): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room || !room.finalizeMediaScore(playerId, score, hits)) return false;
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return true;
  }

  /** Trusted scorer API; one chart word can be judged only once. */
  recordHit(code: string, playerId: string, hit: KaraokeHit): boolean;
  recordHit(code: string, playerId: string, wordId: string, judgment: KaraokeJudgment, points: number): boolean;
  recordHit(code: string, playerId: string, hitOrWordId: KaraokeHit | string,
    judgment?: KaraokeJudgment, points?: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return false;
    const accepted = typeof hitOrWordId === 'string'
      ? room.recordHit(playerId, hitOrWordId, judgment as KaraokeJudgment, points ?? Number.NaN)
      : room.recordHit(playerId, hitOrWordId);
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return accepted;
  }

  recordWordJudgment(code: string, playerId: string, wordId: string, judgment: KaraokeJudgment,
    points: number): boolean {
    return this.recordHit(code, playerId, wordId, judgment, points);
  }

  releaseBrowserSession(code: string, sessionId: string): boolean {
    const key = sessionKey(canonicalRoomCode(code), sessionId);
    if (!this.sessions.has(key)) return false;
    this.release(key);
    return true;
  }

  stopLoopOnly(): void {
    if (this.timingLoop) this.cancelInterval(this.timingLoop);
    if (this.heartbeat) this.cancelInterval(this.heartbeat);
    for (const code of this.resultReconnectTimers.keys()) this.clearResultReconnectTimer(code);
    this.timingLoop = null;
    this.heartbeat = null;
    for (const session of this.sessions.values()) if (session.timer) this.cancelTimeout(session.timer);
    this.sessions.clear();
    this.hosts.clear();
    for (const conn of this.conns) conn.ws.close();
    this.conns.clear();
  }
}

function canonicalRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

function sessionKey(code: string, sessionId: string): string {
  return `${code}\u0000${sessionId}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
