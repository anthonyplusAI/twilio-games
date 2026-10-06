import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { ChessRoom } from './chess-room';

type ChessEvents = ReturnType<ChessRoom['drainEvents']>;
type ChessCommandResult = ReturnType<ChessRoom['handleVoiceCommand']>;

interface DisplayConnection {
  ws: WebSocket;
  roomCode: string | null;
  locale: SupportedLocale;
  authenticatedRoomCode: string | null;
  alive: boolean;
}

interface VoiceBinding {
  callSid: string;
  playerId: string;
  connected: boolean;
}

export interface ChessServerOptions {
  displayToken?: string;
  random?: () => number;
  computerDelayMs?: number;
  maxRooms?: number;
  maxConnections?: number;
  webSocketServer?: WebSocketServer;
}

/** The only writer of a Voice Chess room; browser sockets are display-only. */
export class ChessServer {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, ChessRoom>();
  private readonly displays = new Set<DisplayConnection>();
  private readonly voiceBindings = new Map<string, VoiceBinding>();
  private readonly previouslyBoundRooms = new Set<string>();
  private readonly computerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly displayToken: string;
  private readonly random: () => number;
  private readonly computerDelayMs: number;
  private readonly maxRooms: number;
  private readonly maxConnections: number;
  private requiresDisplayAuth: (roomCode: string) => boolean = () => false;
  private onDisplayRegistered: ((ws: WebSocket, roomCode: string) => void) | null = null;
  private onDisplayAuthenticated: ((ws: WebSocket) => void) | null = null;
  private onRoomState: ((roomCode: string) => void) | null = null;
  private onRoomEvents: ((roomCode: string, events: ChessEvents) => void) | null = null;

  constructor(options: ChessServerOptions = {}) {
    this.displayToken = options.displayToken?.trim() ?? '';
    this.random = options.random ?? Math.random;
    this.computerDelayMs = options.computerDelayMs ?? 900;
    this.maxRooms = options.maxRooms ?? 64;
    this.maxConnections = options.maxConnections ?? 64;
    this.wss = options.webSocketServer ?? new WebSocketServer({
      noServer: true,
      maxPayload: 8 * 1024,
      perMessageDeflate: false,
    });
  }

  get connectionCount(): number { return this.displays.size; }
  get roomCount(): number { return this.rooms.size; }

  setDisplayAuthenticationRequirement(fn: (roomCode: string) => boolean): void {
    this.requiresDisplayAuth = fn;
  }
  setOnDisplayRegistered(fn: (ws: WebSocket, roomCode: string) => void): void {
    this.onDisplayRegistered = fn;
  }
  setOnDisplayAuthenticated(fn: (ws: WebSocket) => void): void {
    this.onDisplayAuthenticated = fn;
  }
  setOnRoomState(fn: (roomCode: string) => void): void { this.onRoomState = fn; }
  setOnRoomEvents(fn: (roomCode: string, events: ChessEvents) => void): void {
    this.onRoomEvents = fn;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, connected?: (ws: WebSocket) => void): void {
    if (this.displays.size >= this.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, ws => {
      connected?.(ws);
      this.onConnection(ws);
    });
  }

  getOrCreateRoom(rawCode: string): ChessRoom | null {
    const code = chessRoomCode(rawCode);
    if (!code) return null;
    let room = this.rooms.get(code);
    if (room) return room;
    if (this.rooms.size >= this.maxRooms) return null;
    room = new ChessRoom(code, { random: this.random });
    this.rooms.set(code, room);
    return room;
  }

  findRoom(rawCode: string): ChessRoom | undefined {
    const code = chessRoomCode(rawCode);
    return code ? this.rooms.get(code) : undefined;
  }

  preferredLocale(rawCode: string, fallback: SupportedLocale = DEFAULT_LOCALE): SupportedLocale {
    const code = chessRoomCode(rawCode);
    return [...this.displays].find(display => display.roomCode === code)?.locale ?? fallback;
  }

  hasAuthenticatedDisplay(rawCode: string): boolean {
    const code = chessRoomCode(rawCode);
    return Boolean(code && [...this.displays].some(display => display.roomCode === code
      && display.authenticatedRoomCode === code && display.ws.readyState === WebSocket.OPEN));
  }

  voiceJoin(rawCode: string, name: string, callSid: string, _locale: SupportedLocale,
    trustedStationAssignment = false):
    { playerId: string; resumed: boolean } | null {
    const code = chessRoomCode(rawCode);
    const sid = callSid.trim();
    if (!code || !sid || !name.trim()) return null;
    const current = this.voiceBindings.get(code);
    if (current && current.callSid !== sid) return null;
    if (!current && !trustedStationAssignment
      && this.requiresDisplayAuth(code) && !this.hasAuthenticatedDisplay(code)) return null;
    const room = this.getOrCreateRoom(code);
    if (!room) return null;
    if (current) {
      current.connected = true;
      room.setPlayerConnected(true);
      this.pushState(code);
      this.maybeScheduleComputer(code, room);
      return { playerId: current.playerId, resumed: true };
    }
    if (this.previouslyBoundRooms.has(code)) {
      this.cancelComputer(code);
      room.reset();
    }
    this.previouslyBoundRooms.add(code);
    const playerId = 'c1';
    this.voiceBindings.set(code, { callSid: sid, playerId, connected: true });
    room.setPlayerConnected(true);
    this.flush(room);
    this.pushState(code);
    this.maybeScheduleComputer(code, room);
    return { playerId, resumed: false };
  }

  hasVoiceBinding(rawCode: string, callSid: string): boolean {
    const code = chessRoomCode(rawCode);
    return Boolean(code && this.voiceBindings.get(code)?.callSid === callSid.trim());
  }

  voiceSetConnected(rawCode: string, callSid: string, connected: boolean): boolean {
    const code = chessRoomCode(rawCode);
    if (!code) return false;
    const binding = this.voiceBindings.get(code);
    const room = this.rooms.get(code);
    if (!binding || binding.callSid !== callSid.trim() || !room) return false;
    if (binding.connected === connected) return true;
    binding.connected = connected;
    if (!connected) this.cancelComputer(code);
    room.setPlayerConnected(connected);
    this.pushState(code);
    if (connected) this.maybeScheduleComputer(code, room);
    return true;
  }

  voiceCommand(rawCode: string, callSid: string, text: string, locale: SupportedLocale): ChessCommandResult | null {
    const code = chessRoomCode(rawCode);
    if (!code) return null;
    const room = this.rooms.get(code);
    const binding = this.voiceBindings.get(code);
    if (!room || !binding?.connected || binding.callSid !== callSid.trim()) return null;
    const result = room.handleVoiceCommand(text, locale);
    this.flush(room);
    this.pushState(code);
    if (result.code === 'confirmed') this.maybeScheduleComputer(code, room);
    return result;
  }

  voiceRestart(rawCode: string, callSid: string): boolean {
    const code = chessRoomCode(rawCode);
    if (!code) return false;
    const room = this.rooms.get(code);
    const binding = this.voiceBindings.get(code);
    if (!room || !binding?.connected || binding.callSid !== callSid.trim()
      || room.state().phase !== 'finished') return false;
    this.cancelComputer(code);
    room.reset();
    room.setPlayerConnected(true);
    this.flush(room);
    this.pushState(code);
    this.maybeScheduleComputer(code, room);
    return true;
  }

  voiceLeave(rawCode: string, callSid: string): void {
    const code = chessRoomCode(rawCode);
    if (!code) return;
    const binding = this.voiceBindings.get(code);
    if (!binding || binding.callSid !== callSid.trim()) return;
    this.voiceBindings.delete(code);
    this.cancelComputer(code);
    const room = this.rooms.get(code);
    room?.setPlayerConnected(false);
    if (room) this.pushState(code);
    this.reap(code);
  }

  abortRoom(rawCode: string): boolean {
    const code = chessRoomCode(rawCode);
    if (!code || !this.rooms.has(code)) return false;
    this.cancelComputer(code);
    for (const display of this.displays) {
      if (display.roomCode !== code) continue;
      display.roomCode = null;
      display.ws.close(4002, 'station recovery');
    }
    this.rooms.delete(code);
    this.voiceBindings.delete(code);
    this.previouslyBoundRooms.delete(code);
    return true;
  }

  stopLoopOnly(): void {
    for (const timer of this.computerTimers.values()) clearTimeout(timer);
    this.computerTimers.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const display of this.displays) display.ws.terminate();
    this.displays.clear();
    this.voiceBindings.clear();
    this.rooms.clear();
    this.previouslyBoundRooms.clear();
    this.wss.close();
  }

  private onConnection(ws: WebSocket): void {
    const display: DisplayConnection = {
      ws, roomCode: null, locale: DEFAULT_LOCALE, authenticatedRoomCode: null, alive: true,
    };
    this.displays.add(display);
    this.ensureHeartbeat();
    ws.on('pong', () => { display.alive = true; });
    this.send(display, { type: 'chess_capabilities', displayAuth: Boolean(this.displayToken) });
    ws.on('message', data => this.onMessage(display, data.toString()));
    ws.on('close', () => {
      this.displays.delete(display);
      if (display.roomCode) this.reap(display.roomCode);
      if (!this.displays.size && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    });
    ws.on('error', () => {});
  }

  private onMessage(display: DisplayConnection, raw: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad json');
      message = parsed as Record<string, unknown>;
    } catch {
      this.send(display, { type: 'error', code: 'bad_json', message: 'Invalid display message.' });
      return;
    }
    if (message.type === 'display_auth') {
      const code = chessRoomCode(message.roomCode);
      if (!this.displayToken || message.token !== this.displayToken || !code) {
        this.send(display, { type: 'error', code: 'bad_display_auth', message: 'Invalid display token.' });
        return;
      }
      display.authenticatedRoomCode = code;
      if (display.roomCode === code) this.onDisplayAuthenticated?.(display.ws);
      return;
    }
    if (message.type === 'spectate') {
      const code = chessRoomCode(message.roomCode);
      if (!code) {
        this.send(display, { type: 'error', code: 'bad_room', message: 'Invalid room code.' });
        return;
      }
      if (this.requiresDisplayAuth(code) && display.authenticatedRoomCode !== code) {
        this.send(display, { type: 'error', code: 'bad_display_auth', message: 'Display authentication required.' });
        return;
      }
      const room = this.getOrCreateRoom(code);
      if (!room) {
        this.send(display, { type: 'error', code: 'room_capacity', message: 'Chess room capacity exhausted.' });
        return;
      }
      const previousCode = display.roomCode;
      display.roomCode = code;
      display.locale = resolveLocale(message.locale, DEFAULT_LOCALE);
      if (previousCode && previousCode !== code) this.reap(previousCode);
      if (display.authenticatedRoomCode === code) this.onDisplayAuthenticated?.(display.ws);
      this.onDisplayRegistered?.(display.ws, code);
      this.flush(room);
      this.send(display, { type: 'chess_state', ...room.state() });
      this.onRoomState?.(code);
      return;
    }
    if (message.type === 'clock_sync' && typeof message.clientSentAtMs === 'number'
      && Number.isFinite(message.clientSentAtMs)) {
      this.send(display, { type: 'clock_sync', clientSentAtMs: message.clientSentAtMs, serverNowMs: Date.now() });
      return;
    }
    this.send(display, { type: 'error', code: 'voice_only', message: 'Chess moves must be spoken on the phone.' });
  }

  private flush(room: ChessRoom): void {
    const events = room.drainEvents();
    if (!events.length) return;
    for (const display of this.displays) {
      if (display.roomCode === room.state().roomCode) this.send(display, { type: 'chess_events', events });
    }
    this.onRoomEvents?.(room.state().roomCode, events);
  }

  private pushState(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    for (const display of this.displays) {
      if (display.roomCode === code) this.send(display, { type: 'chess_state', ...room.state() });
    }
    this.onRoomState?.(code);
  }

  private maybeScheduleComputer(code: string, room: ChessRoom): void {
    const state = room.state();
    if (!state.playerConnected || state.phase === 'finished' || state.turn !== state.computerColor
      || this.computerTimers.has(code)) return;
    const revision = state.revision;
    const timer = setTimeout(() => {
      if (this.computerTimers.get(code) !== timer) return;
      this.computerTimers.delete(code);
      if (this.rooms.get(code) !== room || !this.voiceBindings.get(code)?.connected) return;
      room.playComputerMove(revision);
      this.flush(room);
      this.pushState(code);
    }, this.computerDelayMs);
    timer.unref?.();
    this.computerTimers.set(code, timer);
  }

  private cancelComputer(code: string): void {
    const timer = this.computerTimers.get(code);
    if (!timer) return;
    clearTimeout(timer);
    this.computerTimers.delete(code);
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const display of this.displays) {
        if (!display.alive) { display.ws.terminate(); continue; }
        display.alive = false;
        try { display.ws.ping(); } catch { display.ws.terminate(); }
      }
    }, 30_000);
    this.heartbeat.unref?.();
  }

  private reap(code: string): void {
    if (this.voiceBindings.has(code) || [...this.displays].some(display => display.roomCode === code)) return;
    this.cancelComputer(code);
    this.rooms.delete(code);
    this.previouslyBoundRooms.delete(code);
  }

  private send(display: DisplayConnection, message: unknown): void {
    if (display.ws.readyState === WebSocket.OPEN) display.ws.send(JSON.stringify(message));
  }
}

export function chessRoomCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9](?:[A-Z0-9-]{0,62}[A-Z0-9])?$/.test(code) ? code : null;
}
