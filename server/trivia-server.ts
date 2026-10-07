import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import {
  parseTriviaQuestionBankJson,
  resolveTriviaChoiceId,
  TRIVIA_MAX_PLAYERS,
  TRIVIA_MIN_PLAYERS,
  type TriviaQuestionBank,
  type TriviaRoundCategoryId,
} from '../shared/trivia';
import {
  parseTriviaClientMessage,
  type TriviaEvent,
  type TriviaServerMessage,
} from '../shared/trivia-protocol';
import type { TriviaAudioRetryResult, TriviaVoiceSnapshot } from './trivia-voice';
import { TriviaRoom, type TriviaRoomOptions } from './trivia-room';

export interface TriviaVoiceJoinOptions {
  readonly stationFixed?: boolean;
  readonly allowReplay?: boolean;
  readonly participantIndex?: number;
}

interface Connection {
  ws: WebSocket;
  roomCode?: string;
  playerId?: string;
  sessionId?: string;
  display?: boolean;
  hostAuthorized?: boolean;
  displayAuthenticated?: boolean;
  keyboardTester?: boolean;
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
  keyboardTester: boolean;
}

export const TRIVIA_RECONNECT_GRACE_MS = 30_000;
export const TRIVIA_RESULT_RECONNECT_GRACE_MS = 60_000;
export const TRIVIA_STANDALONE_AUDIO_RETRY_LIMIT = 2;
export const TRIVIA_HEARTBEAT_MS = 30_000;
export const TRIVIA_TICK_MS = 100;
export const TRIVIA_MAX_CONNECTIONS = 64;
export const TRIVIA_MAX_ROOMS = 64;
export const TRIVIA_MAX_PAYLOAD_BYTES = 16 * 1024;

export interface TriviaServerOptions {
  server?: HttpServer;
  displayToken?: string;
  heartbeatMs?: number;
  reconnectGraceMs?: number;
  tickMs?: number;
  now?: () => number;
  seed?: string | number;
  bank?: TriviaQuestionBank;
  contentRevision?: string;
  webSocketServer?: WebSocketServer;
  roomFactory?: (code: string, options: TriviaRoomOptions) => TriviaRoom;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  maxConnections?: number;
  maxRooms?: number;
}

/** Authoritative Voice Trivia WebSocket and trusted voice adapter. */
export class TriviaServer {
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Connection>();
  private readonly rooms = new Map<string, TriviaRoom>();
  private readonly sessions = new Map<string, Session>();
  private readonly hosts = new Map<string, Connection>();
  private readonly resultReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly standaloneAudioRetries = new Map<string, { questionKey: string; count: number }>();
  private timingLoop: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly displayToken: string;
  private readonly heartbeatMs: number;
  private readonly reconnectGraceMs: number;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly seed: string | number;
  private roomSequence = 0;
  private bank: TriviaQuestionBank;
  private contentRevision?: string;
  private readonly roomBanks = new Map<string, TriviaQuestionBank>();
  private readonly voiceRuntime = new Map<string, {
    promptReady: Set<string>;
    answerCueReady: Set<string>;
    questionPoints: Map<string, number>;
  }>();
  private readonly localKeyboardPlayerIds = new Map<string, Set<string>>();
  private readonly paintedQuestionViews = new Map<string, { key: string; host: Connection }>();
  private readonly roomFactory: (code: string, options: TriviaRoomOptions) => TriviaRoom;
  private readonly scheduleInterval: typeof setInterval;
  private readonly cancelInterval: typeof clearInterval;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;
  private readonly maxConnections: number;
  private readonly maxRooms: number;
  private onRoomEvents: ((code: string, events: TriviaEvent[]) => void) | null = null;
  private onRoomState: ((code: string) => void) | null = null;
  private onDisplayAuthenticated: ((ws: WebSocket) => void) | null = null;
  private onDisplayRegistered: ((ws: WebSocket, roomCode: string) => void) | null = null;
  private allowBrowserPlayer: (roomCode: string) => boolean = () => true;
  private requiresDisplayAuth: (roomCode: string) => boolean = () => false;

  constructor(options: TriviaServerOptions = {}) {
    this.displayToken = options.displayToken?.trim() ?? '';
    this.heartbeatMs = options.heartbeatMs ?? TRIVIA_HEARTBEAT_MS;
    this.reconnectGraceMs = options.reconnectGraceMs ?? TRIVIA_RECONNECT_GRACE_MS;
    this.tickMs = options.tickMs ?? TRIVIA_TICK_MS;
    this.now = options.now ?? Date.now;
    this.seed = options.seed ?? 'voice-trivia';
    this.bank = options.bank ?? loadDefaultTriviaBank();
    this.contentRevision = options.contentRevision;
    this.roomFactory = options.roomFactory ?? ((code, roomOptions) => new TriviaRoom(code, roomOptions));
    this.scheduleInterval = options.setInterval ?? setInterval;
    this.cancelInterval = options.clearInterval ?? clearInterval;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.maxConnections = positiveInteger(options.maxConnections ?? TRIVIA_MAX_CONNECTIONS, 'maxConnections');
    this.maxRooms = positiveInteger(options.maxRooms ?? TRIVIA_MAX_ROOMS, 'maxRooms');
    this.wss = options.webSocketServer ?? new WebSocketServer({
      noServer: true,
      maxPayload: TRIVIA_MAX_PAYLOAD_BYTES,
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
        ws.close(1013, 'trivia capacity');
        return;
      }
      connected?.(ws);
      this.onConnection(ws);
    });
  }

  get connectionCount(): number { return this.conns.size; }
  get roomCount(): number { return this.rooms.size; }
  get revision(): string | undefined { return this.contentRevision; }
  getOrCreateRoom(code: string): TriviaRoom { return this.room(canonicalRoomCode(code)); }
  findRoom(code: string): TriviaRoom | undefined { return this.rooms.get(canonicalRoomCode(code)); }
  setOnRoomEvents(fn: (code: string, events: TriviaEvent[]) => void): void { this.onRoomEvents = fn; }
  setOnRoomState(fn: (code: string) => void): void { this.onRoomState = fn; }
  setOnDisplayAuthenticated(fn: (ws: WebSocket) => void): void { this.onDisplayAuthenticated = fn; }
  setOnDisplayRegistered(fn: (ws: WebSocket, roomCode: string) => void): void { this.onDisplayRegistered = fn; }
  setBrowserPlayerAdmission(fn: (roomCode: string) => boolean): void { this.allowBrowserPlayer = fn; }
  setDisplayAuthenticationRequirement(fn: (roomCode: string) => boolean): void { this.requiresDisplayAuth = fn; }

  replaceQuestionBank(bank: TriviaQuestionBank, contentRevision: string): void {
    const parsed = parseTriviaQuestionBankJson(JSON.stringify(bank));
    const revision = contentRevision.trim();
    if (!revision || revision.length > 128 || /\p{Cc}/u.test(revision)) {
      throw new TypeError('contentRevision must be a bounded non-empty string');
    }
    this.bank = parsed;
    this.contentRevision = revision;
  }

  hasAuthenticatedDisplay(code: string): boolean {
    code = canonicalRoomCode(code);
    const host = this.hosts.get(code);
    return Boolean(host?.display && host.displayAuthenticated && host.ws.readyState === WebSocket.OPEN);
  }

  /** Checks the live socket binding, not an old `?display=1` upgrade hint. */
  hasStandaloneDisplay(ws: WebSocket, roomCode: string): boolean {
    const code = canonicalRoomCode(roomCode);
    if (!this.rooms.has(code) || ws.readyState !== WebSocket.OPEN) return false;
    return [...this.conns].some(conn => conn.ws === ws && conn.roomCode === code
      && conn.display === true && conn.hostAuthorized === true
      && (!this.requiresDisplayAuth(code) || conn.displayAuthenticated === true));
  }

  preferredLocale(roomCode?: string, fallback: SupportedLocale = DEFAULT_LOCALE): SupportedLocale {
    const code = roomCode ? canonicalRoomCode(roomCode) : undefined;
    const matching = [...this.conns].filter(conn => (!code || conn.roomCode === code) && conn.locale);
    return matching.find(conn => conn.display)?.locale ?? matching[0]?.locale ?? fallback;
  }

  anonymizePlayer(code: string, playerId: string): void {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.setName(playerId, 'PLAYER')) return;
    this.pushState(code);
  }

  anonymize(code: string, playerId: string): void { this.anonymizePlayer(code, playerId); }

  abortRoom(code: string): boolean {
    code = canonicalRoomCode(code);
    if (!this.rooms.has(code)) return false;
    this.cancelResultReconnect(code);
    for (const conn of this.conns) {
      if (conn.roomCode !== code) continue;
      this.untrackKeyboardPlayer(conn);
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
    this.roomBanks.delete(code);
    this.voiceRuntime.delete(code);
    this.localKeyboardPlayerIds.delete(code);
    this.paintedQuestionViews.delete(code);
    this.standaloneAudioRetries.delete(code);
    this.syncTimingLoop();
    return true;
  }

  abort(code: string): boolean { return this.abortRoom(code); }

  private room(code: string): TriviaRoom {
    let room = this.rooms.get(code);
    if (!room) {
      room = this.roomFactory(code, {
        bank: this.bank,
        now: this.now,
        seed: `${this.seed}:${code}:${this.roomSequence++}`,
        preferredLocale: this.preferredLocale(code),
        ...(this.contentRevision ? { contentRevision: this.contentRevision } : {}),
      });
      this.rooms.set(code, room);
      this.roomBanks.set(code, this.bank);
      this.voiceRuntime.set(code, {
        promptReady: new Set(), answerCueReady: new Set(), questionPoints: new Map(),
      });
    }
    return room;
  }

  private onConnection(ws: WebSocket): void {
    const conn: Connection = { ws, isAlive: true };
    this.conns.add(conn);
    this.ensureHeartbeat();
    ws.on('pong', () => { conn.isAlive = true; });
    this.send(conn, { type: 'trivia_capabilities', displayAuth: Boolean(this.displayToken) });
    ws.on('message', data => {
      conn.isAlive = true;
      this.onMessage(conn, data.toString());
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      const code = conn.roomCode;
      const room = code ? this.rooms.get(code) : undefined;
      if (conn.playerId && room) {
        const held = this.holdSession(conn);
        this.untrackKeyboardPlayer(conn);
        if (held) room.setPlayerConnected(conn.playerId, false);
        else this.permanentlyRemovePlayer(room, conn.playerId);
      }
      this.conns.delete(conn);
      if (code) {
        if (this.hosts.get(code) === conn) {
          this.hosts.delete(code);
          this.paintedQuestionViews.delete(code);
          this.invalidateDisplayReady(code);
          this.designateHost(code);
        }
        this.flush(room);
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
    const msg = parseTriviaClientMessage(raw);
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
        this.flush(this.rooms.get(code));
        this.pushHostIdentity(code);
        this.pushState(code);
        return;
      }
      if (!this.rooms.has(code) && this.rooms.size >= this.maxRooms) {
        this.send(conn, { type: 'error', code: 'room_capacity', message: 'Trivia room capacity is exhausted.' });
        return;
      }
      const room = this.room(code);
      room.setPreferredLocale(this.preferredLocale(code, msg.locale ?? DEFAULT_LOCALE));
      const result = room.addPlayer(msg.name);
      if ('error' in result) {
        this.send(conn, { type: 'error', code: result.error, message: result.error });
        return;
      }
      conn.roomCode = code;
      conn.playerId = result.playerId;
      conn.sessionId = msg.sessionId;
      const currentHost = this.hosts.get(code);
      if (conn.display && conn.hostAuthorized && (!currentHost || !currentHost.playerId)) this.hosts.set(code, conn);
      conn.keyboardTester = conn.display === true && this.isAuthorizedHost(code, conn);
      if (conn.keyboardTester) this.trackKeyboardPlayer(code, result.playerId);
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
          keyboardTester: conn.keyboardTester === true,
        });
      }
      this.send(conn, { type: 'joined', playerId: result.playerId, roomCode: code });
      this.flush(room);
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
        this.pushState(code);
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
      if (!this.rooms.has(code) && this.rooms.size >= this.maxRooms) {
        this.send(conn, { type: 'error', code: 'room_capacity', message: 'Trivia room capacity is exhausted.' });
        return;
      }
      conn.roomCode = code;
      conn.display = true;
      conn.hostAuthorized = !stationDisplay || conn.hostAuthorized === true;
      const room = this.room(code);
      this.cancelResultReconnect(code);
      room.setPreferredLocale(this.preferredLocale(code));
      if (conn.displayAuthenticated) this.onDisplayAuthenticated?.(conn.ws);
      this.onDisplayRegistered?.(conn.ws, code);
      if (conn.displayAuthenticated || (!this.hosts.has(code) && conn.hostAuthorized)) this.hosts.set(code, conn);
      this.pushHostIdentity(code);
      this.pushState(code);
      return;
    }

    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    if (!room) return;
    const isHost = this.isAuthorizedHost(room.code, conn);
    switch (msg.type) {
      case 'select_category':
        if (!conn.playerId) this.rejectAuthority(conn);
        else if (!room.voteCategory(conn.playerId, msg.category)) {
          this.send(conn, { type: 'error', code: 'select_rejected', message: 'That category vote is unavailable.' });
        }
        break;
      case 'display_select_category':
        if (!isHost) this.rejectAuthority(conn);
        else if (!room.voteCategoryFromDisplay(msg.playerId, msg.category)) {
          this.send(conn, { type: 'error', code: 'select_rejected', message: 'This voting seat already voted or changed.' });
        }
        break;
      case 'view_rendered': {
        const state = room.state();
        if (!isHost) this.rejectAuthority(conn);
        else if (state.phase !== msg.phase || state.question?.id !== msg.questionId
          || state.questionAttemptId !== msg.questionAttemptId || state.renderRevision !== msg.renderRevision) {
          this.send(conn, { type: 'error', code: 'stale_view', message: 'That question view is no longer current.' });
        } else {
          this.paintedQuestionViews.set(room.code, {
            key: `${msg.questionAttemptId}:${msg.phase}:${msg.renderRevision}`,
            host: conn,
          });
          for (const playerId of this.localKeyboardPlayerIds.get(room.code) ?? []) {
            if (room.phase !== msg.phase) break;
            if (msg.phase === 'question_prompt') {
              const generation = room.beginPromptDelivery(playerId, msg.questionId, msg.questionAttemptId);
              if (generation !== null) room.questionPromptReady(playerId, msg.questionId,
                msg.questionAttemptId, generation);
            } else {
              const generation = room.beginAnswerCueDelivery(playerId, msg.questionId, msg.questionAttemptId);
              if (generation !== null) room.questionAnswerCueReady(playerId, msg.questionId,
                msg.questionAttemptId, generation);
            }
          }
        }
        break;
      }
      case 'advance':
        if (!isHost) this.rejectAuthority(conn);
        else if (this.requiresDisplayAuth(room.code) && room.phase === 'results') {
          this.send(conn, { type: 'error', code: 'station_requeue_required', message: 'Join the queue again to play again.' });
        } else if (!room.advance(conn.playerId ?? (room.phase === 'results' && conn.display
          ? room.state().players[0]?.playerId : undefined))) {
          this.send(conn, { type: 'error', code: 'not_ready', message: 'Complete the current step first.' });
        }
        break;
      case 'keyboard_answer':
        if (!conn.playerId || !isHost || !conn.keyboardTester || !this.allowBrowserPlayer(room.code)
          || !this.localKeyboardPlayerIds.get(room.code)?.has(conn.playerId)) {
          this.rejectAuthority(conn);
        } else if (!room.answer(conn.playerId, msg.choiceId)) {
          this.send(conn, { type: 'error', code: 'answer_rejected', message: 'That answer is unavailable.' });
        }
        break;
      case 'ready': {
        const state = room.state();
        if (!isHost) this.rejectAuthority(conn);
        else if (!state.hasExpectedPlayers || state.players.some(player => !player.connected)) {
          this.send(conn, { type: 'error', code: 'not_ready', message: 'All admitted callers must be connected.' });
        }
        else if (!room.ready(msg.loadingGeneration)) {
          this.send(conn, { type: 'error', code: 'stale_ready', message: 'Trivia is not awaiting this ready signal.' });
        }
        break;
      }
      case 'retry_loading':
        if (!isHost) this.rejectAuthority(conn);
        else if (!room.retryLoading(msg.loadingGeneration)) {
          this.send(conn, { type: 'error', code: 'stale_ready', message: 'Trivia is not awaiting this retry.' });
        } else this.pushHostIdentity(room.code);
        break;
      case 'leave':
        if (conn.playerId) {
          if (conn.keyboardTester && room.phase !== 'lobby' && room.phase !== 'results') break;
          this.untrackKeyboardPlayer(conn);
          this.permanentlyRemovePlayer(room, conn.playerId);
          if (conn.sessionId) this.dropSession(room.code, conn.sessionId, conn);
          conn.playerId = undefined;
          conn.sessionId = undefined;
        }
        if (conn.display) this.detachDisplay(conn);
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

  private flush(room?: TriviaRoom): void {
    if (!room) return;
    const events: TriviaEvent[] = [];
    const runtime = this.voiceRuntime.get(room.code);
    for (let transitions = 0; transitions < 4; transitions++) {
      const batch = room.drainEvents();
      if (!batch.length) break;
      events.push(...batch);
      for (const event of batch) {
        if (runtime) {
          if (event.type === 'question_started') {
            runtime.promptReady.clear();
            runtime.answerCueReady.clear();
            runtime.questionPoints.clear();
          } else if (event.type === 'answer_result') {
            runtime.questionPoints.set(event.playerId, event.points);
          }
        }
      }
    }
    if (!events.length) return;
    const state = room.state();
    const visibleEvents = events.filter(event => !('questionAttemptId' in event)
      || event.questionAttemptId === state.questionAttemptId);
    for (const conn of this.conns) {
      if (conn.roomCode !== room.code) continue;
      // The corresponding state must arrive before any attempt-scoped result event.
      this.send(conn, { type: 'trivia_state', ...room.state(conn.locale ?? state.preferredLocale) });
      if (visibleEvents.length) this.send(conn, { type: 'trivia_events', events: visibleEvents });
    }
    this.onRoomEvents?.(room.code, events);
  }

  private pushState(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    for (const conn of this.conns) {
      if (conn.roomCode !== code) continue;
      this.send(conn, { type: 'trivia_state', ...room.state(conn.locale ?? room.state().preferredLocale) });
    }
    this.onRoomState?.(code);
  }

  private send(conn: Connection, message: TriviaServerMessage): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(message));
  }

  private resume(code: string, sessionId: string, conn: Connection): boolean {
    const key = sessionKey(code, sessionId);
    const session = this.sessions.get(key);
    if (!session) return false;
    const room = this.rooms.get(code);
    if (!room?.hasPlayer(session.playerId)) {
      this.sessions.delete(key);
      return false;
    }
    if (session.timer) this.cancelTimeout(session.timer);
    conn.display = session.display;
    conn.hostAuthorized = session.hostAuthorized;
    conn.displayAuthenticated = session.displayAuthenticated;
    conn.keyboardTester = session.keyboardTester;
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
    room.setPlayerConnected(session.playerId, true);
    if (conn.keyboardTester && this.isAuthorizedHost(code, conn)) {
      this.trackKeyboardPlayer(code, session.playerId);
    }
    if (conn.displayAuthenticated) this.onDisplayAuthenticated?.(conn.ws);
    if (conn.display) this.onDisplayRegistered?.(conn.ws, code);
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
    session.keyboardTester = conn.keyboardTester === true;
    session.timer = this.scheduleTimeout(() => this.release(key), this.reconnectGraceMs);
    (session.timer as { unref?: () => void }).unref?.();
    return true;
  }

  private release(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.timer) this.cancelTimeout(session.timer);
    this.sessions.delete(key);
    const room = this.rooms.get(session.roomCode);
    this.untrackKeyboardPlayer(session.roomCode, session.playerId);
    if (room) this.permanentlyRemovePlayer(room, session.playerId);
    this.flush(room);
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

  private trackKeyboardPlayer(code: string, playerId: string): void {
    let players = this.localKeyboardPlayerIds.get(code);
    if (!players) {
      players = new Set();
      this.localKeyboardPlayerIds.set(code, players);
    }
    players.add(playerId);
  }

  private untrackKeyboardPlayer(conn: Connection): void;
  private untrackKeyboardPlayer(code: string, playerId: string): void;
  private untrackKeyboardPlayer(codeOrConn: string | Connection, playerId?: string): void {
    let conn: Connection | undefined;
    let code: string | undefined;
    let id: string | undefined;
    if (typeof codeOrConn === 'string') {
      code = codeOrConn;
      id = playerId;
    } else {
      conn = codeOrConn;
      code = conn.roomCode;
      id = conn.playerId;
    }
    if (code && id) {
      const players = this.localKeyboardPlayerIds.get(code);
      players?.delete(id);
      if (!players?.size) this.localKeyboardPlayerIds.delete(code);
      this.voiceRuntime.get(code)?.promptReady.delete(id);
      this.voiceRuntime.get(code)?.answerCueReady.delete(id);
    }
    if (conn) conn.keyboardTester = false;
  }

  private permanentlyRemovePlayer(room: TriviaRoom, playerId: string): boolean {
    const removed = room.permanentlyRemovePlayer(playerId);
    if (!removed) return false;
    const runtime = this.voiceRuntime.get(room.code);
    runtime?.promptReady.delete(playerId);
    runtime?.answerCueReady.delete(playerId);
    runtime?.questionPoints.delete(playerId);
    return true;
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
    this.pushHostIdentity(code);
    this.syncTimingLoop();
  }

  private pushHostIdentity(code: string): void {
    const loadingGeneration = this.rooms.get(code)?.state().loadingGeneration ?? 0;
    for (const conn of this.conns) {
      if (conn.roomCode !== code) continue;
      this.send(conn, {
        type: 'host_identity',
        roomCode: code,
        isHost: this.isAuthorizedHost(code, conn),
        loadingGeneration,
      });
    }
  }

  private isAuthorizedHost(code: string, conn: Connection): boolean {
    return this.hosts.get(code) === conn
      && (!this.requiresDisplayAuth(code) || conn.displayAuthenticated === true);
  }

  private hasLiveHostDisplay(code: string): boolean {
    const host = this.hosts.get(code);
    return Boolean(host?.display && host.ws.readyState === WebSocket.OPEN
      && this.isAuthorizedHost(code, host));
  }

  private reap(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (!room.isEmpty && !room.isUnattendedResult) {
      this.cancelResultReconnect(code);
      return;
    }
    if ([...this.conns].some(conn => conn.roomCode === code)
      || [...this.sessions.values()].some(session => session.roomCode === code)) {
      this.cancelResultReconnect(code);
      return;
    }
    if (room.isUnattendedResult) {
      if (!this.resultReconnectTimers.has(code)) {
        const timer = this.scheduleTimeout(() => {
          this.resultReconnectTimers.delete(code);
          if (this.rooms.get(code) !== room || !room.isUnattendedResult
            || [...this.conns].some(conn => conn.roomCode === code)
            || [...this.sessions.values()].some(session => session.roomCode === code)) return;
          this.deleteRoom(code);
        }, TRIVIA_RESULT_RECONNECT_GRACE_MS);
        (timer as { unref?: () => void }).unref?.();
        this.resultReconnectTimers.set(code, timer);
      }
      return;
    }
    this.deleteRoom(code);
  }

  private cancelResultReconnect(code: string): void {
    const timer = this.resultReconnectTimers.get(code);
    if (!timer) return;
    this.cancelTimeout(timer);
    this.resultReconnectTimers.delete(code);
  }

  private deleteRoom(code: string): void {
    this.cancelResultReconnect(code);
    this.hosts.delete(code);
    this.rooms.delete(code);
    this.roomBanks.delete(code);
    this.voiceRuntime.delete(code);
    this.localKeyboardPlayerIds.delete(code);
    this.paintedQuestionViews.delete(code);
    this.standaloneAudioRetries.delete(code);
  }

  voiceJoin(code: string, name: string, expectedPlayers?: number, nameConfirmed = true,
    preferredLocale?: SupportedLocale, options: TriviaVoiceJoinOptions = {}): string | null {
    code = canonicalRoomCode(code);
    if (expectedPlayers !== undefined && (!Number.isSafeInteger(expectedPlayers)
      || expectedPlayers < TRIVIA_MIN_PLAYERS || expectedPlayers > TRIVIA_MAX_PLAYERS)) return null;
    if (options.participantIndex !== undefined
      && (!Number.isSafeInteger(options.participantIndex)
        || options.participantIndex < 0 || options.participantIndex > 3)) return null;
    if (!this.rooms.has(code) && this.rooms.size >= this.maxRooms) return null;
    const room = this.room(code);
    if (room.phase === 'results' && room.stationFixed) return null;
    if (room.prepareForNewCaller()) {
      this.cancelResultReconnect(code);
      this.standaloneAudioRetries.delete(code);
    }
    room.setPreferredLocale(preferredLocale ?? this.preferredLocale(code));
    const stationFixed = options.stationFixed ?? this.requiresDisplayAuth(code);
    const allowReplay = options.allowReplay ?? !stationFixed;
    if (expectedPlayers !== undefined && !room.expectHumanPlayers(expectedPlayers, true, {
      stationFixed,
      allowReplay,
    })) return null;
    if (expectedPlayers === undefined && !room.setRosterPolicy({ stationFixed, allowReplay })) return null;
    const result = room.addPlayer(name, nameConfirmed, options.participantIndex);
    if ('error' in result) return null;
    this.flush(room);
    this.pushState(code);
    return result.playerId;
  }

  voiceSetName(code: string, playerId: string, name: string): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.setName(playerId, name)) return false;
    this.pushState(code);
    return true;
  }

  voiceVoteCategory(code: string, playerId: string, category: TriviaRoundCategoryId): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.voteCategory(playerId, category)) return false;
    this.pushState(code);
    return true;
  }

  voiceAdvance(code: string, playerId: string): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room || (room.phase === 'results' && !room.allowReplay)) return false;
    const advanced = room.advance(playerId);
    this.flush(room);
    if (room.phase === 'loading') this.pushHostIdentity(code);
    this.pushState(code);
    this.syncTimingLoop();
    return advanced;
  }

  voiceBeginPromptDelivery(code: string, playerId: string, questionId: string,
    questionAttemptId: number, estimatedSpeechMs = 0): number | null {
    code = canonicalRoomCode(code);
    return this.rooms.get(code)?.beginPromptDelivery(playerId, questionId, questionAttemptId, estimatedSpeechMs) ?? null;
  }

  voiceQuestionPromptReady(code: string, playerId: string, questionId: string,
    questionAttemptId: number, deliveryGeneration: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return false;
    const accepted = room.questionPromptReady(playerId, questionId, questionAttemptId, deliveryGeneration);
    if (accepted) this.voiceRuntime.get(code)?.promptReady.add(playerId);
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return accepted;
  }

  voiceBeginAnswerCueDelivery(code: string, playerId: string, questionId: string,
    questionAttemptId: number): number | null {
    code = canonicalRoomCode(code);
    return this.rooms.get(code)?.beginAnswerCueDelivery(playerId, questionId, questionAttemptId) ?? null;
  }

  voiceQuestionAnswerCueReady(code: string, playerId: string, questionId: string,
    questionAttemptId: number, deliveryGeneration: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return false;
    const accepted = room.questionAnswerCueReady(playerId, questionId, questionAttemptId, deliveryGeneration);
    if (accepted) this.voiceRuntime.get(code)?.answerCueReady.add(playerId);
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return accepted;
  }

  voiceBeginRevealDelivery(code: string, playerId: string, questionId: string,
    questionAttemptId: number): number | null {
    code = canonicalRoomCode(code);
    return this.rooms.get(code)?.beginRevealDelivery(playerId, questionId, questionAttemptId) ?? null;
  }

  voiceQuestionRevealReady(code: string, playerId: string, questionId: string,
    questionAttemptId: number, deliveryGeneration: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.questionRevealReady(playerId, questionId, questionAttemptId, deliveryGeneration)) return false;
    const advanced = room.tick();
    this.flush(room);
    if (advanced) this.pushState(code);
    this.syncTimingLoop();
    return true;
  }

  voiceQuestionPromptSkipped(code: string, playerId: string, questionId: string,
    questionAttemptId: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.questionPromptSkipped(playerId, questionId, questionAttemptId)) return false;
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return true;
  }

  voiceQuestionAnswerCueSkipped(code: string, playerId: string, questionId: string,
    questionAttemptId: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.questionAnswerCueSkipped(playerId, questionId, questionAttemptId)) return false;
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return true;
  }

  voiceQueueEarlyAnswer(code: string, playerId: string, questionId: string,
    questionAttemptId: number, choiceId: string): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.queueEarlyAnswer(playerId, questionId, questionAttemptId, choiceId)) return false;
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return true;
  }

  voicePauseAudio(code: string, questionId: string, questionAttemptId: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.pauseAudio(questionId, questionAttemptId)) return false;
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return true;
  }

  retryQuestion(code: string, questionId: string, questionAttemptId: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.retryQuestion(questionId, questionAttemptId)) return false;
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return true;
  }

  /** A caller can recover only their current standalone question, at most twice. */
  voiceRetryQuestion(code: string, playerId: string, questionId: string,
    questionAttemptId: number): TriviaAudioRetryResult {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    const state = room?.state();
    if (!room || room.stationFixed || state?.phase !== 'audio_problem'
      || state.audioProblem.questionId !== questionId
      || state.audioProblem.questionAttemptId !== questionAttemptId
      || state.question?.id !== questionId || state.questionIndex === null
      || !state.players.some(player => player.playerId === playerId && player.connected)) return 'unavailable';
    const questionKey = `${state.loadingGeneration}:${state.questionIndex}:${questionId}`;
    const previous = this.standaloneAudioRetries.get(code);
    const used = previous?.questionKey === questionKey ? previous.count : 0;
    if (used >= TRIVIA_STANDALONE_AUDIO_RETRY_LIMIT) return 'limit';
    this.standaloneAudioRetries.set(code, { questionKey, count: used + 1 });
    if (!this.retryQuestion(code, questionId, questionAttemptId)) {
      if (previous) this.standaloneAudioRetries.set(code, previous);
      else this.standaloneAudioRetries.delete(code);
      return 'unavailable';
    }
    return 'retried';
  }

  /** Trusted voice/DTMF answer API. The local browser keyboard path is isolated in onMessage. */
  voiceAnswer(code: string, playerId: string, spokenOrChoiceId: string, final = true): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return false;
    const accepted = room.answer(playerId, spokenOrChoiceId, final);
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return accepted;
  }

  /** Trusted final API using an earlier matching interim/onset timestamp for scoring. */
  voiceAnswerAt(code: string, playerId: string, spokenOrChoiceId: string,
    final: boolean, answeredAtMs: number, semanticResolutionId?: number): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return false;
    const accepted = room.answerAt(playerId, spokenOrChoiceId, final, answeredAtMs, semanticResolutionId);
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return accepted;
  }

  voiceBeginAnswerResolution(code: string, playerId: string, questionId: string,
    questionAttemptId: number, onset?: { choiceId?: string; atMs: number }): number | null {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return null;
    const previousDeadline = room.state().questionEndsAtMs;
    const resolutionId = room.beginSemanticAnswerResolution(playerId, questionId,
      questionAttemptId, onset);
    if (room.state().questionEndsAtMs !== previousDeadline) {
      this.flush(room);
      this.pushState(code);
      this.syncTimingLoop();
    }
    return resolutionId;
  }

  voiceFinishAnswerResolution(code: string, playerId: string, questionId: string,
    questionAttemptId: number, resolutionId: number): boolean {
    code = canonicalRoomCode(code);
    return this.rooms.get(code)?.finishSemanticAnswerResolution(playerId, questionId,
      questionAttemptId, resolutionId) ?? false;
  }

  voiceLeave(code: string, playerId: string): void {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (room?.phase === 'results') {
      this.voiceTerminalCleanup(code, playerId);
      return;
    }
    this.untrackKeyboardPlayer(code, playerId);
    if (room) this.permanentlyRemovePlayer(room, playerId);
    this.flush(room);
    this.pushState(code);
    this.reap(code);
    this.syncTimingLoop();
  }

  /** Clears live voice state while preserving a completed result on connected displays. */
  voiceTerminalCleanup(code: string, playerId: string): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room || room.phase !== 'results' || !room.hasPlayer(playerId)) return false;
    room.setPlayerConnected(playerId, false);
    this.untrackKeyboardPlayer(code, playerId);
    const runtime = this.voiceRuntime.get(code);
    runtime?.promptReady.delete(playerId);
    runtime?.answerCueReady.delete(playerId);
    runtime?.questionPoints.delete(playerId);
    this.pushState(code);
    if (!room.stationFixed) this.reap(code);
    return true;
  }

  voiceSetConnected(code: string, playerId: string, connected: boolean): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.setPlayerConnected(playerId, connected)) return false;
    this.flush(room);
    this.pushState(code);
    this.syncTimingLoop();
    return true;
  }

  voiceSnapshot(
    code: string,
    playerId: string,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): TriviaVoiceSnapshot | null {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room?.hasPlayer(playerId)) return null;
    const state = room.state(locale);
    const me = state.players.find(player => player.playerId === playerId);
    if (!me) return null;
    const definition = state.question
      ? this.roomBanks.get(code)?.questions.find(question => question.id === state.question?.id)
      : undefined;
    const localizedChoices = definition?.locales[locale].choices ?? [];
    const question = state.question ? {
      id: state.question.id,
      prompt: state.question.prompt,
      choices: state.question.choices.map(choice => ({
        id: choice.id,
        text: choice.text,
        aliases: localizedChoices.find(candidate => candidate.id === choice.id)?.aliases ?? [],
      })),
    } : null;
    const runtime = this.voiceRuntime.get(code);
    return {
      phase: state.phase,
      myName: me.name,
      nameConfirmed: me.nameConfirmed,
      expectedPlayerCount: state.expectedPlayerCount,
      hasExpectedPlayers: state.hasExpectedPlayers,
      automaticSetup: state.automaticSetup,
      players: state.players.map(player => ({
        playerId: player.playerId,
        name: player.name,
        nameConfirmed: player.nameConfirmed,
        connected: player.connected,
        rawScore: player.rawScore,
        correctCount: player.correctCount,
      })),
      categoryVoteCounts: state.categoryVoteCounts,
      myCategoryVote: room.categoryVoteFor(playerId),
      loadingGeneration: state.loadingGeneration,
      questionIndex: state.questionIndex,
      questionAttemptId: state.questionAttemptId,
      answeringStartsAtMs: state.answeringStartsAtMs,
      questionEndsAtMs: state.questionEndsAtMs,
      question,
      reveal: state.reveal,
      standings: state.standings,
      result: state.result,
      myAnswered: me.answered,
      myPromptReady: room.promptReadyFor(playerId),
      myAnswerCueReady: room.answerCueReadyFor(playerId),
      displayViewReady: !this.requiresDisplayAuth(code) && !this.hasLiveHostDisplay(code)
        ? true : Boolean(this.paintedQuestionViews.get(code)?.host === this.hosts.get(code)
          && this.paintedQuestionViews.get(code)?.key === `${state.questionAttemptId}:${state.phase}:${state.renderRevision}`),
      myQuestionPoints: runtime?.questionPoints.get(playerId) ?? 0,
      audioRetryRemaining: room.stationFixed ? 0 : Math.max(0,
        TRIVIA_STANDALONE_AUDIO_RETRY_LIMIT - (
          this.standaloneAudioRetries.get(code)?.questionKey
            === `${state.loadingGeneration}:${state.questionIndex}:${state.question?.id}`
            ? this.standaloneAudioRetries.get(code)!.count : 0)),
    };
  }

  resolveVoiceAnswer(
    code: string,
    questionId: string,
    spoken: string,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): string | null {
    code = canonicalRoomCode(code);
    const question = this.roomBanks.get(code)?.questions.find(candidate => candidate.id === questionId);
    return question ? resolveTriviaChoiceId(question, locale, spoken) : null;
  }

  voiceReconcilePregameRoster(
    code: string,
    count: number,
    activeEnginePlayerIds: readonly string[],
    participantSlots: readonly (string | null)[],
  ): boolean {
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room) return false;
    const removedPlayerIds = room.state().players
      .filter(player => !activeEnginePlayerIds.includes(player.playerId))
      .map(player => player.playerId);
    if (!room.reconcilePregameRoster(count, activeEnginePlayerIds, participantSlots)) return false;
    for (const playerId of removedPlayerIds) {
      this.untrackKeyboardPlayer(code, playerId);
      for (const [key, session] of this.sessions) {
        if (session.roomCode !== code || session.playerId !== playerId) continue;
        if (session.timer) this.cancelTimeout(session.timer);
        if (session.conn) {
          session.conn.playerId = undefined;
          session.conn.sessionId = undefined;
        }
        this.sessions.delete(key);
      }
    }
    const runtime = this.voiceRuntime.get(code);
    runtime?.promptReady.clear();
    runtime?.answerCueReady.clear();
    runtime?.questionPoints.clear();
    this.flush(room);
    this.pushState(code);
    this.reap(code);
    this.syncTimingLoop();
    return true;
  }

  voiceExpectHumanPlayers(
    code: string,
    count: number,
    activeEnginePlayerIds?: readonly string[],
    participantSlots?: readonly (string | null)[],
  ): void {
    if (activeEnginePlayerIds) {
      if (participantSlots) this.voiceReconcilePregameRoster(code, count, activeEnginePlayerIds, participantSlots);
      return;
    }
    code = canonicalRoomCode(code);
    const room = this.rooms.get(code);
    if (!room || !room.expectHumanPlayers(count, true, { stationFixed: true, allowReplay: false })) return;
    this.pushState(code);
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
    this.timingLoop = null;
    this.heartbeat = null;
    for (const session of this.sessions.values()) if (session.timer) this.cancelTimeout(session.timer);
    for (const timer of this.resultReconnectTimers.values()) this.cancelTimeout(timer);
    this.resultReconnectTimers.clear();
    this.sessions.clear();
    this.hosts.clear();
    for (const conn of this.conns) conn.ws.terminate();
    this.conns.clear();
    this.rooms.clear();
    this.roomBanks.clear();
    this.voiceRuntime.clear();
    this.localKeyboardPlayerIds.clear();
    this.standaloneAudioRetries.clear();
    this.wss.close();
  }
}

let defaultBank: TriviaQuestionBank | null = null;

function loadDefaultTriviaBank(): TriviaQuestionBank {
  defaultBank ??= parseTriviaQuestionBankJson(
    readFileSync(new URL('../content/trivia/questions.json', import.meta.url), 'utf8'),
  );
  return defaultBank;
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
