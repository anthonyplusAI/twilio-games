import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { RoomManager } from './room-manager';
import { Room, type RoomConfig } from './room';
import { STEP } from '../shared/constants';
import { INTENTS } from '../shared/types';
import type { ClientMessage, ServerMessage, GameEvent, Phase, MenuTouchState } from '../shared/types';
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from '../shared/i18n/locales';

type ParseResult = ClientMessage | { type: 'error'; code: string; message: string };

export function parseClientMessage(raw: string): ParseResult {
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return err('bad_json', 'invalid JSON'); }
  if (!obj || typeof obj.type !== 'string') return err('bad_message', 'missing type');
  switch (obj.type) {
    case 'join':
      if (typeof obj.roomCode !== 'string' || typeof obj.name !== 'string')
        return err('bad_join', 'roomCode and name required');
      return { type: 'join', roomCode: obj.roomCode, name: obj.name,
               ...(typeof obj.color === 'string' ? { color: obj.color } : {}),
               ...(isSupportedLocale(obj.locale) ? { locale: obj.locale } : {}),
               ...(obj.rendererReadyGate === true ? { rendererReadyGate: true } : {}) };
    case 'intent':
      if (!INTENTS.includes(obj.intent)) return err('bad_intent', 'unknown intent');
      return { type: 'intent', intent: obj.intent };
    case 'ready':   return { type: 'ready' };
    case 'restart': return { type: 'restart' };
    case 'spectate':
      if (typeof obj.roomCode !== 'string') return err('bad_spectate', 'roomCode required');
      return { type: 'spectate', roomCode: obj.roomCode,
        ...(isSupportedLocale(obj.locale) ? { locale: obj.locale } : {}),
        ...(typeof obj.displayToken === 'string' ? { displayToken: obj.displayToken } : {}) };
    case 'leave':   return { type: 'leave' };
    case 'select_car':
      if (!Number.isInteger(obj.carIndex)) return err('bad_select_car', 'carIndex (int) required');
      return { type: 'select_car', carIndex: obj.carIndex };
    case 'select_map':
      if (typeof obj.map !== 'string') return err('bad_select_map', 'map required');
      return { type: 'select_map', map: obj.map };
    case 'advance': return { type: 'advance' };
    case 'back':    return { type: 'back' };
    case 'display_select_car':
      if (typeof obj.roomCode !== 'string' || obj.expectedPhase !== 'car_select'
        || typeof obj.forPlayerId !== 'string' || !/^p\d+$/.test(obj.forPlayerId)
        || !Number.isInteger(obj.carIndex)) return err('bad_display_action', 'invalid car selection');
      return { type: 'display_select_car', roomCode: obj.roomCode,
        expectedPhase: 'car_select', forPlayerId: obj.forPlayerId, carIndex: obj.carIndex };
    case 'display_select_map':
      if (typeof obj.roomCode !== 'string' || obj.expectedPhase !== 'map_select'
        || typeof obj.forPlayerId !== 'string' || !/^p\d+$/.test(obj.forPlayerId)
        || typeof obj.map !== 'string') return err('bad_display_action', 'invalid map selection');
      return { type: 'display_select_map', roomCode: obj.roomCode,
        expectedPhase: 'map_select', forPlayerId: obj.forPlayerId, map: obj.map };
    case 'display_advance':
      if (typeof obj.roomCode !== 'string'
        || !['lobby', 'car_select', 'map_select', 'results'].includes(obj.expectedPhase)
        || (obj.forPlayerId !== undefined && (typeof obj.forPlayerId !== 'string'
          || !/^p\d+$/.test(obj.forPlayerId)))) return err('bad_display_action', 'invalid advance');
      return { type: 'display_advance', roomCode: obj.roomCode, expectedPhase: obj.expectedPhase,
        ...(obj.forPlayerId ? { forPlayerId: obj.forPlayerId } : {}) };
    case 'display_back':
      if (typeof obj.roomCode !== 'string'
        || !['car_select', 'map_select'].includes(obj.expectedPhase)) return err('bad_display_action', 'invalid back');
      return { type: 'display_back', roomCode: obj.roomCode, expectedPhase: obj.expectedPhase };
    default:        return err('unknown_type', `unknown type ${obj.type}`);
  }
}
function err(code: string, message: string): ParseResult { return { type: 'error', code, message }; }

export const RACER_BROADCAST_HZ = 30;
export const RACER_RESULT_RECONNECT_GRACE_MS = 60_000;
export const RACER_STANDALONE_RENDER_READY_TIMEOUT_MS = 16_000;
const RACER_LOBBY_BROADCAST_HZ = 2;

interface Conn { ws: WebSocket; roomCode?: string; playerId?: string; locale?: SupportedLocale;
  stationDisplay?: boolean; hostAuthorized?: boolean; rendererReadyGate?: boolean; }

export class GameServer {
  private wss: WebSocketServer | null = null;
  private rooms = new RoomManager();
  private conns = new Set<Conn>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private broadcastAccum = 0;
  private roomAccum = new Map<Room, number>();
  private lobbyTick = 0;
  private readonly port: number | undefined;
  private readonly broadcastEvery: number;
  private readonly lobbyBroadcastEvery: number;
  /** Supplies the selectable cars/maps for newly created rooms (set by the http server, which owns
   *  the manifest + map list). Sync + cached so getOrCreate stays synchronous. */
  private roomConfig: (() => RoomConfig) | null = null;
  /** Fired once when a room's race finishes (transitions into results), for leaderboard persistence. */
  private onRaceFinished: ((room: Room) => void) | null = null;
  private onRaceStarted: ((room: Room) => void) | null = null;
  private onRaceAbandoned: ((room: Room) => void) | null = null;
  /** Fired with a room's drained game events each broadcast (countdown/go/finish/…), so the voice
   *  layer can speak the caller-relevant ones. Same events the screen gets; voice picks a subset. */
  private onRoomEvents: ((roomCode: string, events: GameEvent[]) => void) | null = null;
  /** Rooms whose finished race we've already reported (cleared when they leave results). */
  private reported = new WeakSet<Room>();
  private started = new WeakSet<Room>();
  private stationRendererReady = new WeakMap<Room, WebSocket | null>();
  private standaloneRendererGate = new WeakMap<Room, { deadline: number; released: boolean;
    source: 'display' | 'player' }>();
  private allowBrowserPlayer: (roomCode: string) => boolean = () => true;
  private readonly displayToken: string;
  private onDisplayAuthenticated: ((ws: WebSocket) => void) | null = null;
  private readonly resultReconnectGraceMs: number;
  private resultReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: { port?: number; server?: HttpServer; broadcastHz?: number; displayToken?: string;
    resultReconnectGraceMs?: number }) {
    this.port = opts.port;
    this.displayToken = opts.displayToken?.trim() ?? '';
    this.resultReconnectGraceMs = opts.resultReconnectGraceMs ?? RACER_RESULT_RECONNECT_GRACE_MS;
    const broadcastHz=opts.broadcastHz??RACER_BROADCAST_HZ;
    this.broadcastEvery = 1 / broadcastHz;
    this.lobbyBroadcastEvery=Math.max(1,Math.round(broadcastHz/RACER_LOBBY_BROADCAST_HZ));
    if (opts.server) this.attach(opts.server);
  }

  /** Register the room-config provider (car count + map list). Existing rooms are reconfigured too. */
  setRoomConfigProvider(fn: () => RoomConfig): void {
    this.roomConfig = fn;
  }

  /** Register a hook fired once when a room's race finishes (results phase) — for leaderboard saves. */
  setOnRaceFinished(fn: (room: Room) => void): void {
    this.onRaceFinished = fn;
  }
  setOnRaceStarted(fn: (room: Room) => void): void { this.onRaceStarted = fn; }
  setOnRaceAbandoned(fn: (room: Room) => void): void { this.onRaceAbandoned = fn; }
  setBrowserPlayerAdmission(fn: (roomCode: string) => boolean): void { this.allowBrowserPlayer = fn; }
  setOnDisplayAuthenticated(fn: (ws: WebSocket) => void): void { this.onDisplayAuthenticated = fn; }

  /** Register a hook fired with a room's game events each broadcast — for the voice talk-back layer. */
  setOnRoomEvents(fn: (roomCode: string, events: GameEvent[]) => void): void {
    this.onRoomEvents = fn;
  }

  /** Create-or-fetch a room, configuring brand-new rooms with the current car/map choices. */
  private room(code: string): Room {
    const existed = !!this.rooms.find(code);
    const room = this.rooms.getOrCreate(code);
    if (!existed && this.roomConfig) {
      try { room.configure(this.roomConfig()); } catch { /* config unavailable → empty choices */ }
    }
    return room;
  }

  /**
   * Mounted mode: attach to an externally-owned http.Server. The WebSocketServer
   * runs in noServer mode; the http layer routes upgrades via handleUpgrade().
   * The game loop starts immediately so mounted rooms tick without a separate start().
   */
  attach(_server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });
    this.startLoop();
  }

  /** Route a /game upgrade from the owning http server into this game's WebSocketServer. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, connected?: (ws:WebSocket)=>void): void {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/game') { socket.destroy(); return; }
    this.wss!.handleUpgrade(req, socket, head, (ws) => {connected?.(ws);this.onConnection(ws);});
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port }, () => {
        const addr = this.wss!.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : this.port!;
        this.startLoop();
        resolve(boundPort);
      });
      this.wss.on('connection', (ws) => this.onConnection(ws));
    });
  }

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws };
    this.conns.add(conn);
    ws.on('message', (data) => this.onMessage(conn, data.toString()));
    ws.on('error', () => { /* a socket error shouldn't crash the process; close handler cleans up */ });
    ws.on('close', () => {
      const roomCode = conn.roomCode;
      if (roomCode && conn.stationDisplay) {
        const room = this.rooms.find(roomCode);
        if (room?.phase === 'countdown' && this.stationRendererReady.get(room) === conn.ws) {
          this.stationRendererReady.delete(room);
        }
      }
      if (roomCode && conn.playerId) {
        const room=this.rooms.find(roomCode);if(room){const before=room.phase;room.removePlayer(conn.playerId);this.reportAbandonedIfReset(room);this.publishSetupMutation(room,before);}
      }
      this.conns.delete(conn);
      if (roomCode) {
        this.reapRoomIfEmpty(roomCode);
      }
    });
  }

  private onMessage(conn: Conn, raw: string): void {
    const msg = parseClientMessage(raw);
    if (msg.type === 'error') return this.send(conn, msg as ServerMessage);
    if (conn.stationDisplay && !conn.hostAuthorized && msg.type !== 'spectate' && msg.type !== 'leave') {
      return this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'bad_display_auth' });
    }
    switch (msg.type) {
      case 'join': {
        if (msg.locale) conn.locale = msg.locale;
        if (!this.allowBrowserPlayer(msg.roomCode)) {
          return this.send(conn, { type: 'error', code: 'station_voice_only', message: 'station_voice_only' });
        }
        const room = this.room(msg.roomCode);
        const res = room.addPlayer(msg.name, msg.color);
        if ('error' in res) return this.send(conn, { type: 'error', code: res.error, message: res.error });
        this.clearResultReconnectTimer(msg.roomCode);
        this.releasePreviousBinding(conn, msg.roomCode);
        conn.roomCode = msg.roomCode; conn.playerId = res.playerId;
        conn.rendererReadyGate = msg.rendererReadyGate === true;
        this.send(conn, { type: 'joined', playerId: res.playerId, lane: res.lane, roomCode: msg.roomCode });
        if(['countdown','racing'].includes(room.phase))this.send(conn,anyItems(room));
        this.pushLobby(msg.roomCode);   // update every conn's roster instantly
        break;
      }
      case 'ready': {
        // Start from the lobby OR after a finished race ("Enter to race again") — both reroll the
        // per-race seed for a fresh course. Mid-race Enter is ignored (race already running).
        if (conn.roomCode) {
          const room = this.rooms.find(conn.roomCode);
          if (conn.stationDisplay && room?.phase === 'countdown') {
            this.markStationRendererReady(conn.roomCode, conn.ws);
            break;
          }
          if (room?.phase === 'countdown' && !room.usesStationSetup) {
            const gate = this.standaloneRendererGate.get(room);
            const permitted = gate?.source === 'display'
              ? !conn.playerId && !conn.stationDisplay && conn.hostAuthorized
              : gate?.source === 'player' && !!conn.playerId && conn.rendererReadyGate;
            if (gate && permitted) { gate.released = true; this.roomAccum.delete(room); }
            break;
          }
          if(room?.usesStationSetup){
            this.send(conn,{type:'error',code:'station_voice_only',message:'station_voice_only'});
            break;
          }
          if (room && this.stationResultsLocked(room)) {
            this.send(conn, { type: 'error', code: 'station_requeue_required', message: 'station_requeue_required' });
            break;
          }
          if (room && (room.phase === 'lobby' || room.phase === 'finished')) {
            if (room.start()) {
              this.resetRendererPreparation(room);
              this.reportStartedOnce(room);
              this.broadcastItems(conn.roomCode);
            } else this.pushLobby(conn.roomCode);
          }
        }
        break;
      }
      case 'intent':
        if (conn.roomCode && conn.playerId)
          this.rooms.find(conn.roomCode)?.applyIntent(conn.playerId, msg.intent);
        break;
      case 'select_car': {
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room && conn.playerId) {
          const before=room.phase;
          if (!room.selectCar(conn.playerId, msg.carIndex)) break;
          // Playful host reaction to the pick (screen + the picking caller's phone).
          const who = room.lobbyPlayers().find(p => p.playerId === conn.playerId);
          this.emitEvent(conn.roomCode!, { kind: 'car_picked', playerId: conn.playerId,
            name: who?.name ?? 'Racer', car: room.carName(msg.carIndex) });
          this.publishSetupMutation(room,before);
        }
        break;
      }
      case 'select_map': {
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room) {
          const before=room.phase;
          // A player's WS pick counts as THEIR vote; the display (no playerId) uses the shared bucket.
          if (!room.selectMap(msg.map, conn.playerId)) break;
          this.emitEvent(conn.roomCode!, { kind:'map_picked',map:msg.map,playerId:conn.playerId });
          this.publishSetupMutation(room,before);
        }
        break;
      }
      case 'display_select_car': {
        const room = this.displayRoomFor(conn, msg.roomCode, msg.expectedPhase);
        if (!room) break;
        if (room.touchSelectionTarget() !== msg.forPlayerId) {
          this.pushLobby(room.code); break;
        }
        const before = room.phase;
        if (!room.selectCar(msg.forPlayerId, msg.carIndex, true)) break;
        const who = room.lobbyPlayers().find(player => player.playerId === msg.forPlayerId);
        this.emitEvent(room.code, { kind: 'car_picked', playerId: msg.forPlayerId,
          name: who?.name ?? 'Racer', car: room.carName(msg.carIndex) });
        this.publishSetupMutation(room, before);
        break;
      }
      case 'display_select_map': {
        const room = this.displayRoomFor(conn, msg.roomCode, msg.expectedPhase);
        if (!room) break;
        if (room.touchSelectionTarget() !== msg.forPlayerId) {
          this.pushLobby(room.code); break;
        }
        const before = room.phase;
        if (!room.selectMap(msg.map, msg.forPlayerId, true)) break;
        this.emitEvent(room.code, { kind: 'map_picked', map: msg.map, playerId: msg.forPlayerId });
        this.publishSetupMutation(room, before);
        break;
      }
      case 'display_advance': {
        const room = this.displayRoomFor(conn, msg.roomCode, msg.expectedPhase);
        if (!room) break;
        if (this.stationResultsLocked(room)) break;
        const first = room.lobbyPlayers()[0]?.playerId;
        if (msg.forPlayerId !== first) {
          // A display may advance a standalone results screen when only next-round callers remain.
          if (first || msg.forPlayerId) { this.pushLobby(room.code); break; }
        }
        const before = room.phase;
        if (!room.advance(msg.forPlayerId)) { this.pushLobby(room.code); break; }
        this.publishSetupMutation(room, before);
        break;
      }
      case 'display_back': {
        const room = this.displayRoomFor(conn, msg.roomCode, msg.expectedPhase);
        if (!room || room.usesStationSetup) break;
        room.back();
        this.pushLobby(room.code);
        break;
      }
      case 'advance': {
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room) {
          if (this.stationResultsLocked(room)) {
            this.send(conn, { type: 'error', code: 'station_requeue_required', message: 'station_requeue_required' });
            break;
          }
          if (!conn.playerId) {
            this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'bad_display_auth' });
            break;
          }
          const before = room.phase;
          room.advance(conn.playerId);
          const after = room.phase;
          if (after === 'countdown' && before !== 'countdown') this.resetRendererPreparation(room);
          if (after === 'countdown' || after === 'racing') this.reportStartedOnce(room);
          // Crossing into a race broadcasts items (with the chosen map) to EVERY conn in the room
          // so all displays/players load the right level; otherwise refresh the select screen.
          if (after === 'countdown' || after === 'racing') this.broadcastItems(conn.roomCode!);
          else this.pushLobby(conn.roomCode!);
          // Announce entering a NEW pre-race phase (the AI host guiding the menus).
          if (after !== before) {
            if (after === 'car_select') this.emitEvent(conn.roomCode!, { kind: 'enter_car_select' });
            else if (after === 'map_select') this.emitEvent(conn.roomCode!, { kind: 'enter_map_select' });
          }
        }
        break;
      }
      case 'back': {
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room) { room.back(); this.pushLobby(conn.roomCode!); }
        break;
      }
      case 'restart': {
        // The host display's explicit "new race" button (the 'r' key) — ALWAYS rebuilds a fresh
        // race for the current players. This is what evolves the per-race seed, so each restart
        // gets a NEW procedural course. Only the browser display can send this (phone callers via
        // Conversation Relay emit movement intents only), so it isn't a griefing vector — and a
        // host wanting to reroll the course mid-race is legitimate, not griefing.
        const room = conn.roomCode ? this.rooms.find(conn.roomCode) : undefined;
        if (room && !this.allowBrowserPlayer(room.code)) {
          this.send(conn, { type: 'error', code: 'station_requeue_required', message: 'station_requeue_required' });
        } else if (room) {
          if (room.start()) {
            if (room.phase === 'countdown') this.resetRendererPreparation(room);
            this.reportAbandonedOnce(room); this.reportStartedOnce(room); this.broadcastItems(conn.roomCode!);
          } else this.pushLobby(conn.roomCode!);
        }
        break;
      }
      case 'spectate': {
        if (msg.locale) conn.locale = msg.locale;
        const stationDisplay = !this.allowBrowserPlayer(msg.roomCode);
        if (stationDisplay && (!this.displayToken || msg.displayToken !== this.displayToken)) {
          return this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'bad_display_auth' });
        }
        const room = this.room(msg.roomCode);
        if (conn.roomCode !== msg.roomCode || conn.playerId || conn.stationDisplay !== stationDisplay) {
          this.releasePreviousBinding(conn, msg.roomCode);
        }
        conn.stationDisplay = stationDisplay;
        conn.rendererReadyGate = false;
        conn.hostAuthorized = !stationDisplay || msg.displayToken === this.displayToken;
        if (this.displayToken && msg.displayToken === this.displayToken) this.onDisplayAuthenticated?.(conn.ws);
        conn.roomCode = msg.roomCode;   // no playerId: receives broadcasts, occupies no slot
        this.clearResultReconnectTimer(msg.roomCode);
        this.pushLobby(msg.roomCode);   // send the display the current select/lobby state immediately
        if (['countdown', 'racing'].includes(room.phase)) this.send(conn, anyItems(room));
        break;
      }
      case 'leave': {
        // Drop this connection's PLAYER slot but keep it connected as a spectator (same roomCode).
        // Used by the shared screen toggling "I'm playing" → back to spectating, without reconnecting.
        if (conn.roomCode && conn.playerId) {
          const room=this.rooms.find(conn.roomCode);if(room){const before=room.phase;room.removePlayer(conn.playerId);this.reportAbandonedIfReset(room);this.publishSetupMutation(room,before);}
          conn.playerId = undefined;
          conn.hostAuthorized = false;
          conn.stationDisplay = false;
          conn.rendererReadyGate = false;
          this.reapRoomIfEmpty(conn.roomCode);
        } else if (conn.roomCode) {
          // A display leaving its room is no longer an eligible standalone voice destination.
          const roomCode = conn.roomCode;
          if (conn.stationDisplay) {
            const room = this.rooms.find(roomCode);
            if (room?.phase === 'countdown' && this.stationRendererReady.get(room) === conn.ws) {
              this.stationRendererReady.delete(room);
            }
          }
          conn.roomCode = undefined;
          conn.hostAuthorized = false;
          conn.stationDisplay = false;
          conn.rendererReadyGate = false;
          this.reapRoomIfEmpty(roomCode);
        }
        break;
      }
    }
  }

  getOrCreateRoom(code: string): Room { return this.room(code); }
  findRoom(code: string): Room | undefined { return this.rooms.find(code); }
  anonymizePlayer(roomCode: string, playerId: string): void {
    const room = this.rooms.find(roomCode);if(!room)return;room.anonymizePlayer(playerId);this.pushLobby(roomCode);
  }

  abortRoom(code: string): boolean {
    const room = this.rooms.find(code);
    if (!room) return false;
    this.clearResultReconnectTimer(code);
    for (const conn of this.conns) {
      if (conn.roomCode !== code) continue;
      conn.roomCode = undefined;
      conn.playerId = undefined;
      conn.ws.close(4002, 'station recovery');
    }
    this.roomAccum.delete(room);
    this.started.delete(room);
    this.reported.delete(room);
    this.rooms.remove(code);
    return true;
  }

  // ── Voice-host actions: the conversational AI drives the game for a caller. These mirror the WS
  //    handlers (select_car/select_map/advance) EXACTLY — same room mutation, same broadcasts + host
  //    events — so a voice-driven pick appears on the shared screen just like a texted/keyed one.
  voiceSelectCar(roomCode:string,playerId:string,carIndex:number,allowRevision=false):boolean {
    const room=this.rooms.find(roomCode);if(!room)return false;const before=room.phase;
    if(!room.selectCar(playerId,carIndex,allowRevision))return false;
    const who = room.lobbyPlayers().find(p => p.playerId === playerId);
    this.emitEvent(roomCode, { kind: 'car_picked', playerId, name: who?.name ?? 'Racer', car: room.carName(carIndex), spokenReplyPlayerId: playerId });
    this.publishSetupMutation(room,before,playerId);
    return true;
  }
  /** Set a caller's display name by voice (shows on the shared screen). */
  voiceSetName(roomCode: string, playerId: string, name: string): void {
    const room = this.rooms.find(roomCode); if (!room) return;
    const before=room.phase;
    room.setPlayerInfo(playerId, { name });
    if(!room.usesStationSetup)room.expectHumanPlayers(1,false);
    this.publishSetupMutation(room,before,playerId);
  }
  voiceSelectMap(roomCode:string,map:string,voterId?:string,allowRevision=false):boolean {
    const room=this.rooms.find(roomCode);if(!room)return false;const before=room.phase;
    if(!room.selectMap(map,voterId,allowRevision))return false;
    this.emitEvent(roomCode,{kind:'map_picked',map,
      ...(voterId?{playerId:voterId,spokenReplyPlayerId:voterId}:{})});
    this.publishSetupMutation(room,before,voterId);
    return true;
  }

  voiceSetupChanged(roomCode:string,before:Phase):void {
    const room=this.rooms.find(roomCode);if(!room)return;
    this.publishSetupMutation(room,before);
  }
  /** A voice caller left (hung up). Drop their slot, refresh the lobby, and REAP the room if now empty
   *  — the racer's WS close/leave paths reap, but a phone caller never takes those, so without this a
   *  voice-only room would leak in `this.rooms` forever. Mirrors BattleServer.voiceLeave. */
  voiceLeave(roomCode: string, playerId: string): void {
    const room = this.rooms.find(roomCode); if (!room) return;
    const before=room.phase;room.removePlayer(playerId);this.reportAbandonedIfReset(room);this.publishSetupMutation(room,before);
    this.reapRoomIfEmpty(roomCode);
  }
  voiceExpectHumanPlayers(roomCode:string,count:number,activeEnginePlayerIds?:readonly string[]):void {
    const room=this.rooms.find(roomCode);if(!room)return;
    const before=room.phase;
    if(activeEnginePlayerIds){
      const retained=new Set(activeEnginePlayerIds);
      for(const player of room.lobbyPlayers())if(!retained.has(player.playerId))room.removePlayer(player.playerId);
    }
    room.expectHumanPlayers(count);this.publishSetupMutation(room,before);
  }
  /** Advance the flow (lobby→car_select→map_select→race). Returns true if the phase actually changed. */
  voiceAdvance(roomCode: string, spokenReplyPlayerId: string): boolean {
    const room = this.rooms.find(roomCode); if (!room) return false;
    if (this.stationResultsLocked(room)) return false;
    const before = room.phase;
    room.advance(spokenReplyPlayerId);
    const after = room.phase;
    if (after === 'countdown' && before !== 'countdown') this.resetRendererPreparation(room);
    if (after === 'countdown' || after === 'racing') this.reportStartedOnce(room);
    if (after === 'countdown' || after === 'racing') this.broadcastItems(roomCode);
    else this.pushLobby(roomCode);
    if (after !== before) {
      if (after === 'car_select') this.emitEvent(roomCode, { kind: 'enter_car_select', spokenReplyPlayerId });
      else if (after === 'map_select') this.emitEvent(roomCode, { kind: 'enter_map_select', spokenReplyPlayerId });
    }
    return after !== before;
  }

  private publishSetupMutation(room:Room,before:Phase,spokenReplyPlayerId?:string):void {
    const after=room.phase;
    if(after!=='results'&&after!=='finished')this.clearResultReconnectTimer(room.code);
    if(after==='countdown'&&before!=='countdown')this.resetRendererPreparation(room);
    if(after==='countdown'||after==='racing'){
      this.reportStartedOnce(room);this.broadcastItems(room.code);
    }else this.pushLobby(room.code);
    if(after!==before){
      if(after==='car_select')this.emitEvent(room.code,{kind:'enter_car_select',spokenReplyPlayerId});
      else if(after==='map_select')this.emitEvent(room.code,{kind:'enter_map_select',spokenReplyPlayerId});
    }
  }

  private stationResultsLocked(room: Room): boolean {
    return !this.allowBrowserPlayer(room.code) && ['results', 'finished'].includes(room.phase);
  }

  /** A display tap is bound to the exact room and screen it saw. The caller seat is checked
   * separately against the room's current selector target before changing any game state. */
  private displayRoomFor(conn: Conn, roomCode: string, expectedPhase: Phase): Room | null {
    if (!conn.hostAuthorized || conn.playerId || !conn.roomCode || conn.roomCode !== roomCode) {
      this.send(conn, { type: 'error', code: 'bad_display_auth', message: 'bad_display_auth' });
      return null;
    }
    const room = this.rooms.find(roomCode);
    if (!room || room.phase !== expectedPhase) {
      if (room) this.pushLobby(roomCode);
      return null;
    }
    return room;
  }

  private menuTouchState(room: Room, viewer?: Conn): MenuTouchState {
    const advancePlayerId = room.lobbyPlayers()[0]?.playerId ?? null;
    // The display may advance for the active racers. A caller who joined while
    // their results are showing is waiting for the next round, so its own
    // Replay control must reflect its actual authority rather than the
    // display's (otherwise the tap looks enabled but the room rejects it).
    const replayActor = room.phase === 'results' && viewer?.playerId
      ? viewer.playerId : advancePlayerId ?? undefined;
    return {
      activePlayerId: room.touchSelectionTarget(), advancePlayerId,
      canAdvance: !this.stationResultsLocked(room) && room.canAdvance(replayActor),
      canBack: !room.usesStationSetup && (room.phase === 'car_select' || room.phase === 'map_select'),
    };
  }

  /** Test seam: advance one room's simulation by `dt` (drives the same stepRoom path the loop uses),
   *  so the racing→results→leaderboard reporting can be verified deterministically without real time. */
  stepRoomForTest(room: Room, dt: number): void { this.stepRoom(room, dt); }
  markStationRendererReady(roomCode: string, display: WebSocket | null = null): boolean {
    const room = this.rooms.find(roomCode);
    if (!room?.usesStationSetup || room.phase !== 'countdown') return false;
    this.stationRendererReady.set(room, display);
    this.roomAccum.delete(room);
    return true;
  }

  private resetRendererPreparation(room: Room): void {
    this.stationRendererReady.delete(room);
    this.standaloneRendererGate.delete(room);
  }

  /** A standalone display is already present during voice/menu selection. Give it one bounded
   * loading window so an authored map cannot replace a track after the cars start moving. */
  private rendererPreparationPending(room: Room): boolean {
    if (room.phase !== 'countdown') return false;
    if (room.usesStationSetup) return !this.stationRendererReady.has(room);
    if (!this.started.has(room) && !this.standaloneRendererGate.has(room)) {
      let displayReady = false;
      let playerReady = false;
      for (const conn of this.conns) {
        if (conn.roomCode !== room.code || conn.ws.readyState !== WebSocket.OPEN) continue;
        if (!conn.playerId && !conn.stationDisplay && conn.hostAuthorized) displayReady = true;
        else if (conn.playerId && conn.rendererReadyGate) playerReady = true;
        if (displayReady) break;
      }
      if (displayReady || playerReady) this.standaloneRendererGate.set(room, {
        deadline: Date.now() + RACER_STANDALONE_RENDER_READY_TIMEOUT_MS,
        released: false,
        source: displayReady ? 'display' : 'player',
      });
    }
    const gate = this.standaloneRendererGate.get(room);
    if (!gate || gate.released) return false;
    if (Date.now() >= gate.deadline) { gate.released = true; return false; }
    return true;
  }
  /** Number of live rooms (test/diagnostic hook for the room-leak fix). */
  get roomCount(): number { return this.rooms.count; }
  /** Live WS connections (displays + device players). Used by the voice router to auto-join a caller
   *  to whichever game currently has an open display. */
  get connectionCount(): number { return this.conns.size; }

  /** A standalone screen must have accepted spectate for this exact room and still be connected. */
  hasStandaloneDisplay(ws: WebSocket, roomCode: string): boolean {
    if (!this.allowBrowserPlayer(roomCode) || !this.rooms.find(roomCode)) return false;
    return [...this.conns].some(conn => conn.ws === ws && conn.roomCode === roomCode
      && !conn.playerId && !conn.stationDisplay && conn.hostAuthorized === true
      && conn.ws.readyState === WebSocket.OPEN);
  }

  /** Switching one socket's room or role must release its old roster/display binding first. */
  private releasePreviousBinding(conn: Conn, retainingRoomCode: string): void {
    const previousCode = conn.roomCode;
    if (!previousCode) return;
    const room = this.rooms.find(previousCode);
    if (conn.stationDisplay && room?.phase === 'countdown'
      && this.stationRendererReady.get(room) === conn.ws) this.stationRendererReady.delete(room);
    const previousPlayerId = conn.playerId;
    conn.roomCode = undefined;
    conn.playerId = undefined;
    conn.stationDisplay = false;
    conn.hostAuthorized = false;
    conn.rendererReadyGate = false;
    if (room && previousPlayerId) {
      const before = room.phase;
      room.removePlayer(previousPlayerId);
      this.reportAbandonedIfReset(room);
      this.publishSetupMutation(room, before);
    }
    if (previousCode !== retainingRoomCode) this.reapRoomIfEmpty(previousCode);
  }

  preferredLocale(roomCode?: string, fallback: SupportedLocale = DEFAULT_LOCALE): SupportedLocale {
    const matching = [...this.conns].filter(conn => (!roomCode || conn.roomCode === roomCode) && conn.locale);
    return matching.find(conn => !conn.playerId)?.locale ?? matching[0]?.locale ?? fallback;
  }

  /**
   * Drop a room once nothing references it — no players AND no connections (spectators included)
   * still pointing at it. Prevents the room + its accumulator from leaking for the life of the
   * process after an event's worth of one-off room codes.
   */
  private clearResultReconnectTimer(roomCode: string): void {
    const timer = this.resultReconnectTimers.get(roomCode);
    if (timer) clearTimeout(timer);
    this.resultReconnectTimers.delete(roomCode);
  }

  private reapRoomIfEmpty(roomCode: string, graceExpired = false): void {
    const room = this.rooms.find(roomCode);
    if (!room || !room.isEmpty) return;
    for (const c of this.conns) if (c.roomCode === roomCode) return;   // a spectator is still watching
    if (room.phase === 'results' || room.phase === 'finished') {
      // The station owns its handoff. A standalone result survives a brief display outage so a
      // reconnecting screen can show the score and technology explanation after the call ends.
      if (room.usesStationSetup) return;
      if (!graceExpired) {
        if (!this.resultReconnectTimers.has(roomCode)) {
          const timer = setTimeout(() => {
            this.resultReconnectTimers.delete(roomCode);
            if (this.rooms.find(roomCode) === room) this.reapRoomIfEmpty(roomCode, true);
          }, this.resultReconnectGraceMs);
          (timer as { unref?: () => void }).unref?.();
          this.resultReconnectTimers.set(roomCode, timer);
        }
        return;
      }
    }
    this.clearResultReconnectTimer(roomCode);
    this.roomAccum.delete(room);
    this.rooms.remove(roomCode);
  }

  private startLoop(): void {
    let last = process.hrtime.bigint();
    // Run the loop at ~120Hz target. The sim steps by real dt (frame-rate independent) so this only
    // affects the GRANULARITY at which the broadcast accumulator is checked: a faster loop means the
    // accumulator reaches broadcastEvery (~33ms) close to on-time even when the container starves the
    // timer. The tighter target keeps the effective broadcast rate near the intended 30Hz. The loop body is
    // cheap (one small room), so the extra wakeups cost almost nothing.
    this.loop = setInterval(() => {
      const now = process.hrtime.bigint();
      let dt = Number(now - last) / 1e9; last = now;
      dt = Math.min(dt, 0.1);
      // Voice callers are not browser connections. Step every room so a temporary display disconnect
      // cannot freeze an active race while both calls remain connected.
      for (const room of this.rooms.values()) this.stepRoom(room, dt);
      this.broadcastAccum += dt;
      if (this.broadcastAccum >= this.broadcastEvery) {
        // Reset to the REMAINDER (not 0) so timing errors don't accumulate — keeps the long-run rate
        // locked to broadcastEvery instead of slipping slower with each late tick.
        this.broadcastAccum = this.broadcastAccum % this.broadcastEvery;
        this.broadcastAll();
      }
    }, 1000 / 120);
  }

  private stepRoom(room: Room, dt: number): void {
    if (room.phase !== 'countdown' && room.phase !== 'racing') {
      // Not racing: nothing to simulate. Clear the "already reported" flag for non-results phases
      // so the NEXT race reports too. (A room sitting in results was reported the tick it finished.)
      this.roomAccum.delete(room);
      if (room.phase !== 'results') { this.reportAbandonedOnce(room); this.reported.delete(room); }
      else this.reportFinishedOnce(room);   // belt-and-suspenders if it slipped through
      return;
    }
    if (this.rendererPreparationPending(room)) {
      this.roomAccum.delete(room);
      return;
    }
    this.reportStartedOnce(room);
    let acc = (this.roomAccum.get(room) ?? 0) + dt;
    while (acc >= STEP) { room.tick(STEP); acc -= STEP; }
    this.roomAccum.set(room, acc);
    for(const event of room.drainEvents())this.emitEvent(room.code,event);
    // A tick may have flipped racing→results INSIDE this call. Report it NOW (same call as the
    // transition) so the standings persist even if the player disconnects this very tick and the
    // room gets reaped before the next stepRoom. (Read fresh — phase changed during tick().)
    const phaseAfter: string = room.phase;
    if (phaseAfter === 'results') {
      this.pushLobby(room.code);
      // Start station completion only after callers have received race_over and begun their recap.
      this.reportFinishedOnce(room);
    }
  }

  /** Fire onRaceFinished exactly once per finished race (the WeakSet clears when it leaves results). */
  private reportFinishedOnce(room: Room): void {
    if (this.reported.has(room)) return;
    this.reported.add(room);
    this.started.delete(room);
    this.onRaceFinished?.(room);
  }

  private reportStartedOnce(room: Room): void {
    if (this.started.has(room) || (room.phase !== 'countdown' && room.phase !== 'racing')) return;
    if (this.rendererPreparationPending(room)) return;
    this.started.add(room); this.onRaceStarted?.(room);
  }

  private reportAbandonedIfReset(room: Room): void {
    if (room.phase === 'lobby') this.reportAbandonedOnce(room);
  }

  private reportAbandonedOnce(room: Room): void {
    if (!this.started.has(room)) return;
    this.started.delete(room); this.reported.delete(room); this.onRaceAbandoned?.(room);
  }

  /** True for the non-racing phases that broadcast roster/selection/results rather than snapshots. */
  private static isPreOrPost(phase: string): boolean {
    return phase === 'lobby' || phase === 'car_select' || phase === 'map_select' || phase === 'results';
  }

  /** The right out-of-race message for a room's current phase (roster / car+map select / results). */
  private preRaceMessage(room: Room, viewer?: Conn): ServerMessage {
    const phase = room.phase;
    if (phase === 'results') {
      return { type: 'results', roomCode: room.code, map: room.selectedMap,
        results: room.results(), touch: this.menuTouchState(room, viewer) };
    }
    if (phase === 'car_select' || phase === 'map_select') {
      const votes = room.mapVotes();
      return { type: 'select_state', roomCode: room.code, phase, players: room.lobbyPlayers(),
        maps: room.mapChoices, selectedMap: room.selectedMap,
        mapVotes: votes.counts, mapTie: votes.tie, touch: this.menuTouchState(room, viewer) };
    }
    // lobby
    return { type: 'lobby', roomCode: room.code, players: room.lobbyPlayers(),
      phase, touch: this.menuTouchState(room, viewer) };
  }

  private broadcastAll(): void {
    const tick = this.lobbyTick++;   // once per broadcast call, not per connection
    for (const c of this.conns) {
      if (!c.roomCode) continue;
      const room = this.rooms.find(c.roomCode); if (!room) continue;
      // A room is EITHER pre/post-race (roster/select/results) OR racing per tick — send one kind.
      if (GameServer.isPreOrPost(room.phase)) {
        // Keep menus/results near 2Hz even when the live-race snapshot rate changes.
        if (tick % this.lobbyBroadcastEvery === 0) this.send(c, this.preRaceMessage(room, c));
        continue;
      }
      const snap = room.snapshot(); if (!snap) continue;
      // Static course items are delivered by the dedicated `items` message. Do not resend the whole
      // course 30 times per second; reconnecting displays receive `items` before their next snapshot.
      this.send(c, { type: 'snapshot', snapshot: { ...snap, items: [] } });
    }
  }

  /** Fan a single event to BOTH audiences in a room: the screen conns (as an `event` message → the
   *  screen announcer) AND the voice callers (via onRoomEvents → their TTS). Used for the PRE-RACE
   *  moments (car/map select) that don't flow through the racing broadcast loop, so the AI host
   *  talks during the menus too — not just the race. */
  private emitEvent(roomCode: string, event: GameEvent): void {
    for (const c of this.conns) if (c.roomCode === roomCode) this.send(c, { type: 'event', event });
    this.onRoomEvents?.(roomCode, [event]);
  }

  /** Immediately send the current pre/post-race state to every connection in a room. */
  private pushLobby(roomCode: string): void {
    const room = this.rooms.find(roomCode);
    if (!room || !GameServer.isPreOrPost(room.phase)) return;
    for (const c of this.conns) if (c.roomCode === roomCode) this.send(c, this.preRaceMessage(room, c));
  }

  /** Broadcast the items list (with the chosen map) to EVERY connection in a room at race start, so
   *  all displays/players load the same level + per-level scales — not just whoever pressed start. */
  private broadcastItems(roomCode: string): void {
    const room = this.rooms.find(roomCode);
    if (!room) return;
    const msg = anyItems(room);
    for (const c of this.conns) if (c.roomCode === roomCode) this.send(c, msg);
  }

  private send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  /** Clear the game loop. Used in standalone stop() and by the http server in mounted mode. */
  clearLoop(): void {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
  }

  /**
   * Mounted-mode shutdown: stop the loop and close client connections without
   * closing a port the game server no longer owns (the http server owns shutdown).
   */
  stopLoopOnly(): void {
    this.clearLoop();
    for (const code of this.resultReconnectTimers.keys()) this.clearResultReconnectTimer(code);
    for (const c of this.conns) c.ws.close();
    this.conns.clear();
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.clearLoop();
      for (const code of this.resultReconnectTimers.keys()) this.clearResultReconnectTimer(code);
      for (const c of this.conns) c.ws.close();
      this.conns.clear();
      if (this.wss) this.wss.close(() => resolve()); else resolve();
    });
  }
}

function anyItems(room: Room): ServerMessage {
  const snap = room.snapshot();
  // Carry the chosen level so the client loads the right map + per-level car/item scales for THIS
  // race (the lobby picks the map; the display has no ?map= URL param to fall back on).
  return { type: 'items', items: snap ? snap.items : [], map: room.selectedMap };
}
