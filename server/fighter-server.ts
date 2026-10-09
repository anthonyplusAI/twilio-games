import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { FighterRoom, type FighterVoiceCommandOutcome } from './fighter-room';
import { FIGHTER_MAPS, FIGHTER_ROSTER } from '../shared/fighter-roster';
import { parseFighterClientMessage, type FighterServerMessage } from '../shared/fighter-protocol';
import type { FighterCommand, FighterEvent, FighterId } from '../shared/fighter-world';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';

interface Conn { ws: WebSocket; roomCode?: string; playerId?: string; sessionId?: string; display?: boolean; hostAuthorized?: boolean; displayAuthenticated?: boolean; authorizedRoomCode?:string; locale?: SupportedLocale; requestedStandaloneSeats?: 1 | 2; isAlive: boolean; }
interface Session {
  roomCode: string; playerId: string; sessionId: string; conn: Conn | null; timer: ReturnType<typeof setTimeout> | null;
  display: boolean; wasHost: boolean;
}
const RECONNECT_MS = 30_000;
const HEARTBEAT_MS = 30_000;
const RELEASE_TOMBSTONE_MS = 120_000;
const MAX_RELEASE_TOMBSTONES = 4_096;
export const FIGHTER_RESULT_RECONNECT_GRACE_MS = 60_000;

export class FighterServer {
  private wss: WebSocketServer;
  private conns = new Set<Conn>();
  private rooms = new Map<string, FighterRoom>();
  private sessions = new Map<string, Session>();
  private releasedBrowserSessions = new Map<string, number>();
  private hosts = new Map<string, Conn>();
  private loop: ReturnType<typeof setInterval>;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatMs: number;
  private lastTick = Date.now();
  private seed = 0x65ab12ef;
  private maps = FIGHTER_MAPS;
  private onRoomEvents: ((code: string, events: FighterEvent[]) => void) | null = null;
  private onRoomState: ((code: string) => void) | null = null;
  private onVoiceCommandOutcomes: ((code: string, outcomes: FighterVoiceCommandOutcome[]) => void) | null = null;
  private resultsFallbackTimers=new Map<string,{timer:ReturnType<typeof setTimeout>;generation:number}>();
  private resultReconnectTimers=new Map<string,ReturnType<typeof setTimeout>>();
  private readonly resultReconnectGraceMs:number;
  private allowBrowserPlayer: (roomCode: string) => boolean = () => true;

  private readonly displayToken: string;
  private onDisplayAuthenticated: ((ws: WebSocket) => void) | null = null;

  constructor(opts: { server: HttpServer; displayToken?: string; heartbeatMs?: number;
    resultReconnectGraceMs?: number }) {
    this.displayToken = opts.displayToken?.trim() ?? '';
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.resultReconnectGraceMs=opts.resultReconnectGraceMs??FIGHTER_RESULT_RECONNECT_GRACE_MS;
    this.wss = new WebSocketServer({ noServer: true });
    this.loop = setInterval(() => this.tick(), 50);
    (this.loop as { unref?: () => void }).unref?.();
  }
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, connected?: (ws:WebSocket)=>void): void {
    this.wss.handleUpgrade(req, socket, head, ws => {connected?.(ws);this.onConnection(ws);});
  }
  get connectionCount(): number { return this.conns.size; }
  /** A socket is a display only after it binds to this room and passes its room’s display policy. */
  hasStandaloneDisplay(ws:WebSocket,roomCode:string):boolean{
    const code=canonicalRoomCode(roomCode);
    return [...this.conns].some(conn=>conn.ws===ws&&conn.ws.readyState===WebSocket.OPEN
      &&conn.roomCode===code&&this.allowBrowserPlayer(code)
      &&conn.display===true&&conn.hostAuthorized===true);
  }
  setOnDisplayAuthenticated(fn: (ws: WebSocket) => void): void { this.onDisplayAuthenticated = fn; }
  preferredLocale(roomCode?: string, fallback: SupportedLocale = DEFAULT_LOCALE): SupportedLocale {
    const matching = [...this.conns].filter(conn => (!roomCode || conn.roomCode === roomCode) && conn.locale);
    return matching.find(conn => conn.display)?.locale ?? matching[0]?.locale ?? fallback;
  }
  getOrCreateRoom(code: string): FighterRoom { return this.room(canonicalRoomCode(code)); }
  findRoom(code: string): FighterRoom | undefined { return this.rooms.get(canonicalRoomCode(code)); }
  anonymizePlayer(code: string, playerId: string): void {
    code=canonicalRoomCode(code);const room=this.rooms.get(code);if(!room)return;room.setName(playerId,'PLAYER');this.pushState(code);
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
      if (session.timer) clearTimeout(session.timer);
      this.sessions.delete(key);
    }
    this.hosts.delete(code);
    this.clearResultsFallback(code);
    this.rooms.delete(code);
    return true;
  }
  setOnRoomEvents(fn: (code: string, events: FighterEvent[]) => void): void { this.onRoomEvents = fn; }
  setOnRoomState(fn: (code: string) => void): void { this.onRoomState = fn; }
  setOnVoiceCommandOutcomes(fn: (code: string, outcomes: FighterVoiceCommandOutcome[]) => void): void {
    this.onVoiceCommandOutcomes = fn;
  }
  setBrowserPlayerAdmission(fn: (roomCode: string) => boolean): void { this.allowBrowserPlayer = fn; }
  setMaps(maps: typeof FIGHTER_MAPS): void {
    if (!maps.length) return;
    this.maps = maps; for (const room of this.rooms.values()) room.setMaps(maps);
    for (const conn of this.conns) this.send(conn, { type: 'fighter_roster', fighters: FIGHTER_ROSTER, maps: this.maps });
  }

  private room(code: string): FighterRoom {
    let room = this.rooms.get(code);
    if (!room) { room = new FighterRoom(code, this.seed = (this.seed + 0x9e3779b9) >>> 0, this.maps); this.rooms.set(code, room); }
    return room;
  }
  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws, isAlive: true };
    this.conns.add(conn);
    this.ensureHeartbeat();
    ws.on('pong', () => { conn.isAlive = true; });
    this.send(conn, { type: 'fighter_capabilities', displayAuth: Boolean(this.displayToken) });
    this.send(conn, { type: 'fighter_roster', fighters: FIGHTER_ROSTER, maps: this.maps });
    ws.on('message', data => { conn.isAlive = true; this.onMessage(conn, data.toString()); });
    ws.on('error', () => {});
    ws.on('close', () => {
      const code = conn.roomCode;
      if (conn.playerId && code && !this.holdSession(conn)) {
        const room=this.rooms.get(code);room?.removePlayer(conn.playerId);if(room)this.flushVoiceCommandOutcomes(code);
      }
      this.conns.delete(conn);
      if (code) {
        if (this.hosts.get(code) === conn) {
          this.hosts.delete(code);
          this.rooms.get(code)?.invalidatePresentation();
          this.invalidateDisplayReady(code, 'host connection closed');
          this.designateHost(code);
        }
        this.pushState(code); this.reap(code);
      }
    });
  }
  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const conn of this.conns) {
        if (!conn.isAlive) { conn.ws.terminate(); continue; }
        conn.isAlive = false;
        try { conn.ws.ping(); } catch { /* close handler performs cleanup */ }
      }
    }, this.heartbeatMs);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }
  private onMessage(conn: Conn, raw: string): void {
    const msg = parseFighterClientMessage(raw);
    if (msg.type === 'error') { this.send(conn, msg); return; }
    if (msg.type === 'release_session') {
      const code = canonicalRoomCode(msg.roomCode);
      if (conn.playerId && (conn.roomCode !== code || conn.sessionId !== msg.sessionId)) {
        this.rejectAuthority(conn); return;
      }
      this.releaseBrowserSession(code, msg.sessionId);
      this.send(conn, { type: 'session_released', roomCode: code, sessionId: msg.sessionId });
      return;
    }
    if (msg.type === 'join') {
      if (msg.locale) conn.locale = msg.locale;
      const code = canonicalRoomCode(msg.roomCode);
      if (!this.allowBrowserPlayer(code)) {
        this.send(conn, { type: 'error', code: 'station_voice_only', message: 'station_voice_only' }); return;
      }
      // A release can overtake the original join on a different socket or HTTP request.
      // Remember it briefly so that late join cannot reclaim the seat after P-on proceeds.
      if (msg.sessionId && this.wasBrowserSessionReleased(sessionKey(code, msg.sessionId))) {
        this.send(conn, { type: 'error', code: 'session_released', message: 'This browser session already left.' }); return;
      }
      if (conn.playerId && conn.roomCode) { this.send(conn, { type: 'joined', playerId: conn.playerId, roomCode: conn.roomCode }); return; }
      if (conn.roomCode && conn.roomCode !== code) this.detachDisplay(conn);
      if (msg.sessionId && this.resume(code, msg.sessionId, conn)) {
        this.send(conn, { type: 'joined', playerId: conn.playerId!, roomCode: code }); this.pushHostIdentity(code); this.pushState(code); return;
      }
      const room = this.room(code);
      room.prepareForNewStandaloneCaller();
      if (msg.initialSeatCount !== undefined && !this.hosts.has(code) && !room.state().automaticSetup
        && (room.playerCount === 0 || (room.phase === 'lobby' && msg.initialSeatCount > room.expectedPlayerCount))) {
        if (!room.configureStandaloneSeats(msg.initialSeatCount)) {
          this.send(conn, { type: 'error', code: 'not_ready', message: 'Choose the caller count before selecting fighters.' }); return;
        }
      }
      const result = room.addPlayer(msg.name);
      if ('error' in result) { this.send(conn, { type: 'error', code: result.error, message: result.error }); return; }
      this.clearResultReconnectTimer(code);
      conn.roomCode = code; conn.playerId = result.playerId; conn.sessionId = msg.sessionId;
      const currentHost = this.hosts.get(code);
      if (conn.display && conn.hostAuthorized && this.allowBrowserPlayer(code) && (!currentHost || !currentHost.playerId)) {
        this.hosts.set(code, conn);
      }
      if (msg.sessionId) this.sessions.set(sessionKey(code, msg.sessionId), {
        roomCode: code, playerId: result.playerId, sessionId: msg.sessionId, conn, timer: null,
        display: conn.display === true, wasHost: this.hosts.get(code) === conn,
      });
      this.send(conn, { type: 'joined', playerId: result.playerId, roomCode: code }); this.pushHostIdentity(code); this.pushState(code); return;
    }
    if (msg.type === 'display_auth') {
      const code = canonicalRoomCode(msg.roomCode);
      if (!this.displayToken || msg.token !== this.displayToken) {
        this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'Invalid display token.' }); return;
      }
      if(conn.roomCode&&conn.roomCode!==code){
        this.send(conn,{type:'error',code:'bad_display_auth',message:'Display authentication is scoped to one room.'});return;
      }
      conn.authorizedRoomCode=code;
      conn.displayAuthenticated = true;
      if (conn.roomCode === code && conn.display) {
        conn.hostAuthorized=true;
        if(!this.hosts.has(code)){this.hosts.set(code, conn);this.pushHostIdentity(code);}
      }
      return;
    }
    if (msg.type === 'spectate') {
      if (msg.locale) conn.locale = msg.locale;
      if (conn.playerId) { this.send(conn, { type: 'error', code: 'already_joined', message: 'Leave before spectating.' }); return; }
      const code = canonicalRoomCode(msg.roomCode);
      if (conn.roomCode && conn.roomCode !== code) this.detachDisplay(conn);
      const stationDisplay = !this.allowBrowserPlayer(code);
      if (stationDisplay && conn.authorizedRoomCode!==code) {
        this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'Invalid display token.' }); return;
      }
      if (stationDisplay && msg.initialSeatCount !== undefined) {
        this.rejectAuthority(conn); return;
      }
      const room = this.room(code);
      if (msg.initialSeatCount !== undefined && (!this.hosts.has(code) || this.hosts.get(code) === conn)
        && !room.configureStandaloneSeats(msg.initialSeatCount)) {
        this.send(conn, { type: 'error', code: 'not_ready', message: 'Choose the caller count before selecting fighters.' }); return;
      }
      conn.roomCode = code; conn.display = true; conn.hostAuthorized = !stationDisplay || conn.authorizedRoomCode===code;
      conn.requestedStandaloneSeats = stationDisplay ? undefined : msg.initialSeatCount;
      this.clearResultReconnectTimer(code);
      if (conn.displayAuthenticated&&conn.authorizedRoomCode===code) this.onDisplayAuthenticated?.(conn.ws);
      if (!this.hosts.has(code) && conn.hostAuthorized) this.hosts.set(code, conn);
      this.pushHostIdentity(code); this.pushState(code); return;
    }
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    if (!room) return;
    const isHost = this.hosts.get(room.code) === conn;
    switch (msg.type) {
      case 'configure_seats':
        if (!isHost || !conn.display || !this.allowBrowserPlayer(room.code)
          || canonicalRoomCode(msg.roomCode) !== room.code) this.rejectAuthority(conn);
        else if (!room.configureStandaloneSeats(msg.count))
          this.send(conn, { type: 'error', code: 'not_ready', message: 'Choose the caller count before selecting fighters.' });
        else conn.requestedStandaloneSeats = msg.count;
        break;
      case 'select_fighter': {
        // Fighter choice belongs to the joined caller. A spectator display must never overwrite a
        // phone player's personal selection.
        const target = conn.playerId;
        if (!target) { this.rejectAuthority(conn); break; }
        if (target && !room.selectFighter(target, msg.fighterId)) this.send(conn, { type: 'error', code: 'select_rejected', message: 'That fighter is unavailable.' });
        break;
      }
      case 'display_select_fighter':
        if (!isHost || !conn.display) this.rejectAuthority(conn);
        else if (!room.selectFighter(msg.playerId, msg.fighterId))
          this.send(conn, { type: 'error', code: 'select_rejected', message: 'That fighter or player is unavailable.' });
        break;
      case 'select_map':
        {const voter=conn.playerId??(isHost&&!room.state().automaticSetup?room.lobbyPlayers().find(player=>!player.isAi)?.playerId:undefined);
        if(!voter)this.rejectAuthority(conn);
        else if(!room.selectMap(voter,msg.mapId))this.send(conn,{type:'error',code:'select_rejected',message:'That map is unavailable.'});}
        break;
      case 'display_select_map':
        if (!isHost || !conn.display) this.rejectAuthority(conn);
        else if (!room.selectMap(msg.playerId, msg.mapId))
          this.send(conn, { type: 'error', code: 'select_rejected', message: 'That map or player is unavailable.' });
        break;
      case 'ack_display':
        if(!isHost||!conn.display){this.rejectAuthority(conn);break;}
        if(room.acknowledgePresentation(msg.phase,msg.loadingGeneration))this.pushState(room.code);
        return;
      case 'command': if (conn.playerId) room.command(conn.playerId, msg.command); else this.rejectAuthority(conn); break;
      case 'advance':
        if (!isHost && !conn.playerId) this.rejectAuthority(conn);
        else if (!this.allowBrowserPlayer(room.code) && room.phase === 'results') {
          this.send(conn, { type:'error',code:'station_requeue_required',message:'Join the queue again for another match.' });
        }
        else if (!room.advance(conn.playerId ?? (conn.display && isHost && room.expectedPlayerCount === 1
          ? room.lobbyPlayers().find(player => !player.isAi)?.playerId : undefined)))
          this.send(conn, { type: 'error', code: 'not_ready', message: 'Complete the current selection first.' });
        break;
      case 'ready':
        if (!isHost) this.rejectAuthority(conn);
        else if (!room.ready(msg.loadingGeneration)) this.send(conn, { type: 'error', code: 'stale_ready', message: 'The arena is not awaiting this ready signal.' });
        break;
      case 'retry_loading':
        if (!isHost) this.rejectAuthority(conn);
        else if (!room.retryLoading(msg.loadingGeneration)) this.send(conn, { type: 'error', code: 'stale_ready', message: 'The arena is not awaiting this retry.' });
        break;
      case 'back':
        if (!isHost && !conn.playerId) this.rejectAuthority(conn);
        else if (!room.back(conn.playerId ?? (conn.display && isHost && room.expectedPlayerCount === 1
          ? room.lobbyPlayers().find(player => !player.isAi)?.playerId : undefined)))
          this.send(conn, { type: 'error', code: 'not_ready', message: 'There is no earlier selection to return to.' });
        break;
      case 'leave':
        if (conn.playerId) {
          room.removePlayer(conn.playerId);
          if (conn.sessionId) this.dropSession(room.code, conn.sessionId, conn);
          conn.playerId = undefined; conn.sessionId = undefined;
        }
        this.flush(room);
        this.detachDisplay(conn);
        return;
      default: break;
    }
    this.flush(room);
    if (room.phase === 'loading') this.pushHostIdentity(room.code);
    this.pushState(room.code); this.reap(room.code);
  }
  private tick(): void {
    const now = Date.now(); const delta = Math.min((now - this.lastTick) / 1000, 0.1); this.lastTick = now;
    for (const room of this.rooms.values()) {
      if (room.phase !== 'loading' && room.phase !== 'intro' && room.phase !== 'fight' && room.phase !== 'countdown' && room.phase !== 'victory') continue;
      room.tick(delta); this.flush(room); this.pushState(room.code);
    }
  }
  private flush(room: FighterRoom): void {
    const events = room.drainEvents();
    if (events.length) {
      for (const conn of this.conns) if (conn.roomCode === room.code) this.send(conn, { type: 'fighter_events', events });
      this.onRoomEvents?.(room.code, events);
    }
    this.flushVoiceCommandOutcomes(room.code);
  }
  flushVoiceCommandOutcomes(code: string): void {
    code = canonicalRoomCode(code);
    const outcomes = this.rooms.get(code)?.drainVoiceCommandOutcomes() ?? [];
    if (outcomes.length) this.onVoiceCommandOutcomes?.(code, outcomes);
  }
  private pushState(code: string): void {
    const room = this.rooms.get(code); if (!room) return;
    const msg: FighterServerMessage = { type: 'fighter_state', ...room.state() };
    for (const conn of this.conns) if (conn.roomCode === code) this.send(conn, msg);
    this.onRoomState?.(code);
    this.scheduleResultsFallback(room);
  }
  private clearResultsFallback(code:string):void{
    const current=this.resultsFallbackTimers.get(code);
    if(current)clearTimeout(current.timer);
    this.resultsFallbackTimers.delete(code);
  }
  /** Wake the host once if no result overlay receipt arrives, so paid matches can recover. */
  private scheduleResultsFallback(room:FighterRoom):void{
    const code=room.code;
    if(room.phase!=='results'||room.resultsPresented||room.resultsPresentationTimedOut){
      this.clearResultsFallback(code);return;
    }
    const remaining=room.resultsPresentationRemainingMs;
    if(remaining<=0)return;
    const generation=room.state().loadingGeneration;
    const current=this.resultsFallbackTimers.get(code);
    if(current?.generation===generation)return;
    this.clearResultsFallback(code);
    const timer=setTimeout(()=>{
      if(this.resultsFallbackTimers.get(code)?.timer!==timer)return;
      this.resultsFallbackTimers.delete(code);
      if(this.rooms.get(code)!==room||room.state().loadingGeneration!==generation||room.phase!=='results')return;
      this.pushState(code);
    },remaining+5);
    (timer as {unref?:()=>void}).unref?.();
    this.resultsFallbackTimers.set(code,{timer,generation});
  }
  private send(conn: Conn, message: FighterServerMessage): void { if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(message)); }

  private resume(code: string, id: string, conn: Conn): boolean {
    const key = sessionKey(code, id); const session = this.sessions.get(key);
    if (!session) return false;
    if (!this.rooms.get(code)?.hasPlayer(session.playerId)) { this.sessions.delete(key); return false; }
    if (session.timer) clearTimeout(session.timer);
    conn.display = session.display;
    if (session.conn && session.conn !== conn) {
      const old = session.conn;
      if (this.hosts.get(code) === old) this.hosts.set(code, conn);
      old.playerId = undefined; old.sessionId = undefined; old.ws.close(4001, 'session replaced');
    }
    if (session.wasHost && !this.hosts.has(code)) this.hosts.set(code, conn);
    session.conn = conn; session.timer = null; conn.roomCode = code; conn.playerId = session.playerId; conn.sessionId = id; return true;
  }
  private holdSession(conn: Conn): boolean {
    if (!conn.sessionId || !conn.roomCode) return false;
    const key = sessionKey(conn.roomCode, conn.sessionId); const session = this.sessions.get(key); if (!session || session.conn !== conn) return false;
    this.rooms.get(conn.roomCode)?.suspendPlayer(session.playerId);
    session.conn = null; session.display = conn.display === true; session.wasHost = this.hosts.get(conn.roomCode) === conn;
    session.timer = setTimeout(() => this.release(key), RECONNECT_MS);
    (session.timer as { unref?: () => void }).unref?.(); return true;
  }
  private release(key: string): void {
    const session = this.sessions.get(key); if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(key);
    if (session.conn?.roomCode === session.roomCode && session.conn.playerId === session.playerId
      && session.conn.sessionId === session.sessionId) {
      session.conn.playerId = undefined;
      session.conn.sessionId = undefined;
    }
    const room=this.rooms.get(session.roomCode);
    room?.removePlayer(session.playerId);
    if(room)this.flushVoiceCommandOutcomes(session.roomCode);
    this.pushState(session.roomCode); this.reap(session.roomCode);
  }

  private dropSession(code: string, id: string, owner: Conn): void {
    const key = sessionKey(code, id); const session = this.sessions.get(key);
    if (!session || session.conn !== owner) return;
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(key);
  }

  private rejectAuthority(conn: Conn): void { this.send(conn, { type: 'error', code: 'forbidden', message: 'This connection cannot control the display.' }); }
  private detachDisplay(conn: Conn): void {
    const code = conn.roomCode; if (!code) return;
    conn.roomCode = undefined; conn.display = false;conn.hostAuthorized=false;conn.requestedStandaloneSeats=undefined;
    if (this.hosts.get(code) === conn) {
      this.hosts.delete(code);
      this.rooms.get(code)?.invalidatePresentation();
      this.invalidateDisplayReady(code, 'host changed rooms');
      this.designateHost(code);
    }
    this.pushState(code); this.reap(code);
  }
  private designateHost(code: string): void {
    for (const candidate of this.conns) {
      if (candidate.roomCode !== code || !candidate.display
        || (!this.allowBrowserPlayer(code) && candidate.authorizedRoomCode !== code)
        || candidate.ws.readyState !== WebSocket.OPEN) continue;
      const requestedSeats = candidate.requestedStandaloneSeats;
      if (this.allowBrowserPlayer(code) && requestedSeats !== undefined
        && !this.rooms.get(code)?.configureStandaloneSeats(requestedSeats)) {
        // A standby with a conflicting count cannot become an eligible voice destination.
        candidate.roomCode = undefined;
        candidate.display = false;
        candidate.hostAuthorized = false;
        candidate.requestedStandaloneSeats = undefined;
        this.send(candidate, { type: 'error', code: 'not_ready',
          message: 'Choose the caller count before selecting fighters.' });
        continue;
      }
      this.hosts.set(code, candidate);
      break;
    }
    this.pushHostIdentity(code);
  }
  private invalidateDisplayReady(code: string, reason: string): void {
    const room = this.rooms.get(code);
    if (!room?.invalidateDisplayReady()) return;
    console.warn(`[fighter] ${reason}; returning room ${code} to loading generation ${room.state().loadingGeneration}`);
  }
  private pushHostIdentity(code: string): void {
    const loadingGeneration = this.rooms.get(code)?.state().loadingGeneration ?? 0;
    for (const candidate of this.conns) if (candidate.roomCode === code) {
      this.send(candidate, { type: 'host_identity', roomCode: code, isHost: this.hosts.get(code) === candidate, loadingGeneration });
    }
  }
  private clearResultReconnectTimer(code:string):void{
    const timer=this.resultReconnectTimers.get(code);
    if(timer)clearTimeout(timer);
    this.resultReconnectTimers.delete(code);
  }
  private reap(code: string,graceExpired=false): void {
    const room = this.rooms.get(code); if (!room?.isEmpty) return;
    if ([...this.conns].some(conn => conn.roomCode === code)) return;
    if ([...this.sessions.values()].some(session => session.roomCode === code)) return;
    if(room.phase==='results'||(room.phase==='victory'&&room.state().result)){
      if(!this.allowBrowserPlayer(code))return;
      if(!graceExpired){
        if(!this.resultReconnectTimers.has(code)){
          const timer=setTimeout(()=>{
            this.resultReconnectTimers.delete(code);
            if(this.rooms.get(code)===room)this.reap(code,true);
          },this.resultReconnectGraceMs);
          (timer as {unref?:()=>void}).unref?.();
          this.resultReconnectTimers.set(code,timer);
        }
        return;
      }
    }
    this.clearResultReconnectTimer(code);
    this.hosts.delete(code);this.clearResultsFallback(code);this.rooms.delete(code);
  }

  voiceJoin(code: string, name: string, preferredSide?: FighterId, expectedPlayers?:number, nameConfirmed = true): string | null {
    code=canonicalRoomCode(code);const room=this.room(code);const hadPlayer=room.playerCount>=1;
    if (!this.allowBrowserPlayer(code) && (room.phase === 'victory' || room.phase === 'results')) return null;
    if (this.allowBrowserPlayer(code)) room.prepareForNewStandaloneCaller();
    const result = room.addPlayer(name, preferredSide, nameConfirmed); if ('error' in result) return null;
    if(expectedPlayers!==undefined)room.expectHumanPlayers(expectedPlayers,preferredSide!==undefined);
    else if(hadPlayer)room.expectHumanPlayers(2,false);
    this.clearResultReconnectTimer(code);this.pushState(code); return result.playerId;
  }
  voiceLeave(code: string, id: string): void { code = canonicalRoomCode(code); const room=this.rooms.get(code);room?.removePlayer(id);if(room)this.flush(room);this.pushState(code); this.reap(code); }
  voiceSuspend(code: string, id: string): void {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return;
    room.suspendPlayer(id);
    this.flushVoiceCommandOutcomes(code);
    this.pushState(code);
  }
  voiceRegisterMenuSession(code: string, id: string): void {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return;
    room.registerVoicePlayer(id);
    this.pushState(code);
  }
  voiceBeginMenuAudio(code: string, id: string, phase: FighterRoom['phase'],
    recovery = false): (played?: boolean) => void {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    const release = room?.beginMenuAudio(id, phase, recovery) ?? (() => {});
    const shared = room?.state().automaticSetup && room.expectedPlayerCount === 2;
    if (shared) queueMicrotask(() => {
      if (this.rooms.get(code) === room && room.phase === phase) this.pushState(code);
    });
    let finished = false;
    return played => {
      if (finished) return;
      finished = true;
      release(played);
      queueMicrotask(() => {
        if (!room || this.rooms.get(code) !== room) return;
        const changed = room.completeSharedDecisionIfReady();
        if (changed && room.phase === 'loading') this.pushHostIdentity(code);
        if (changed || shared) this.pushState(code);
      });
    };
  }
  voiceBeginMenuTurn(code: string, id: string, phase: FighterRoom['phase']): () => void {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    const release = room?.beginMenuTurn(id, phase) ?? (() => {});
    const shared = room?.state().automaticSetup && room.expectedPlayerCount === 2;
    if (shared) queueMicrotask(() => {
      if (this.rooms.get(code) === room && room.phase === phase) this.pushState(code);
    });
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      release();
      queueMicrotask(() => {
        if (!room || this.rooms.get(code) !== room) return;
        const changed = room.completeSharedDecisionIfReady();
        if (changed && room.phase === 'loading') this.pushHostIdentity(code);
        if (changed || shared) this.pushState(code);
      });
    };
  }
  voiceSetName(code:string,id:string,name:string):void {
    code=canonicalRoomCode(code);const room=this.rooms.get(code);if(!room)return;
    room.setName(id,name);room.expectHumanPlayers(Math.max(1,room.playerCount),false);this.pushState(code);
  }
  voiceExpectHumanPlayers(code:string,count:number,activeEnginePlayerIds?:readonly string[]):void {
    code=canonicalRoomCode(code);const room=this.rooms.get(code);if(!room)return;
    if(activeEnginePlayerIds){const retained=new Set(activeEnginePlayerIds);for(const player of room.lobbyPlayers())if(!player.isAi&&!retained.has(player.playerId))room.removePlayer(player.playerId);}
    room.expectHumanPlayers(count,true);this.pushState(code);
  }
  voiceSelectFighter(code: string, id: string, fighterId: string): boolean { code = canonicalRoomCode(code); const ok = this.rooms.get(code)?.selectFighter(id, fighterId) ?? false; this.pushState(code); return ok; }
  voiceSelectMap(code: string, id: string, mapId: string): boolean {
    code = canonicalRoomCode(code); const room = this.rooms.get(code);
    const ok=room?.selectMap(id,mapId)??false;this.pushState(code);return ok;
  }
  voiceAdvance(code: string, id: string): boolean {
    code = canonicalRoomCode(code); const room = this.rooms.get(code);
    if (!this.allowBrowserPlayer(code) && room?.phase === 'results') return false;
    const ok=room?.advance(id)??false;
    if (room?.phase === 'loading') this.pushHostIdentity(code);
    this.pushState(code); return ok;
  }
  voiceBack(code: string, id: string): boolean {
    code=canonicalRoomCode(code);const room=this.rooms.get(code);
    const ok=room?.back(id)??false;if(ok)this.pushState(code);return ok;
  }
  voiceSkipIntro(code: string, id: string): boolean {
    code=canonicalRoomCode(code);const room=this.rooms.get(code);
    const ok=room?.skipIntro(id)??false;if(ok)this.pushState(code);return ok;
  }
  voiceStartNow(code: string, id: string): boolean {
    code=canonicalRoomCode(code);const room=this.rooms.get(code);
    const ok=room?.startNow(id)??false;if(ok)this.pushState(code);return ok;
  }
  voiceShowResults(code:string,id:string):boolean{
    code=canonicalRoomCode(code);
    const room=this.rooms.get(code);
    const host=this.hosts.get(code);
    if(!room||!host?.display||host.ws.readyState!==WebSocket.OPEN||!room.revealResults(id))return false;
    this.send(host,{type:'show_results',loadingGeneration:room.state().loadingGeneration});
    this.pushState(code);
    return true;
  }
  voiceCommand(code: string, id: string, command: FighterCommand): boolean;
  voiceCommand(code: string, id: string, command: FighterCommand, requestId: string): FighterVoiceCommandOutcome;
  voiceCommand(code: string, id: string, command: FighterCommand, requestId?: string): boolean | FighterVoiceCommandOutcome {
    code = canonicalRoomCode(code); const room = this.rooms.get(code);
    if (!room) return requestId === undefined ? false : {requestId, command, status:'rejected', reason:'not_player'};
    const outcome=room.voiceCommand(id,command,requestId??`legacy-${Date.now()}`);
    this.flush(room);if(outcome.status==='executed')this.pushState(code);
    return requestId===undefined ? outcome.status!=='rejected' : outcome;
  }
  voiceSequence(code: string, id: string, commands: readonly [FighterCommand,FighterCommand],
    requestIds: readonly [string,string]): readonly FighterVoiceCommandOutcome[] {
    code=canonicalRoomCode(code);const room=this.rooms.get(code);
    if(!room)return commands.map((command,index)=>({requestId:requestIds[index]!,command,status:'rejected' as const,reason:'not_player' as const}));
    const outcomes=room.voiceSequence(id,commands,requestIds);
    this.flush(room);if(outcomes.some(outcome=>outcome.status==='executed'))this.pushState(code);
    return outcomes;
  }
  releaseBrowserSession(code: string, sessionId: string): boolean {
    if (!code.trim() || code.trim().length > 16 || !sessionId || sessionId.length > 128) return false;
    const key = sessionKey(canonicalRoomCode(code), sessionId);
    this.rememberReleasedBrowserSession(key);
    if (!this.sessions.has(key)) return false;
    this.release(key); return true;
  }

  private rememberReleasedBrowserSession(key: string): void {
    const now = Date.now();
    for (const [oldKey, expiresAt] of this.releasedBrowserSessions) {
      if (expiresAt <= now) this.releasedBrowserSessions.delete(oldKey);
    }
    this.releasedBrowserSessions.delete(key);
    this.releasedBrowserSessions.set(key, now + RELEASE_TOMBSTONE_MS);
    while (this.releasedBrowserSessions.size > MAX_RELEASE_TOMBSTONES) {
      const oldest = this.releasedBrowserSessions.keys().next().value;
      if (oldest === undefined) break;
      this.releasedBrowserSessions.delete(oldest);
    }
  }

  private wasBrowserSessionReleased(key: string): boolean {
    const expiresAt = this.releasedBrowserSessions.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt > Date.now()) return true;
    this.releasedBrowserSessions.delete(key);
    return false;
  }

  stopLoopOnly(): void {
    clearInterval(this.loop); if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    for(const code of this.resultReconnectTimers.keys())this.clearResultReconnectTimer(code);
    for (const session of this.sessions.values()) if (session.timer) clearTimeout(session.timer);
    this.sessions.clear(); this.hosts.clear();
    for(const code of this.resultsFallbackTimers.keys())this.clearResultsFallback(code);
    for (const conn of this.conns) conn.ws.close(); this.conns.clear();
  }
}

function canonicalRoomCode(code: string): string { return code.trim().toUpperCase(); }
function sessionKey(code: string, id: string): string { return `${code}\u0000${id}`; }
