import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { ChessRoom } from './chess-room';
import type { ChessVoiceMoveChoice } from './chess-room';
import { parseChessIntent } from '../shared/chess-intent';
import type { ChessCommandResult as ChessCommandResponse, ChessState, WizardChessSceneSnapshot } from '../shared/chess-protocol';
import {
  isWizardChessTrigger, parseWizardChessVoiceAction,
  WIZARD_CHESS_RESOLVED_DURATION_MS, WIZARD_CHESS_STORY_DURATION_MS,
} from '../shared/wizard-chess-scene';

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

interface WizardSceneRuntime {
  snapshot: WizardChessSceneSnapshot;
  room: ChessRoom;
  gameId: number;
  callSid: string;
  storyTimer: ReturnType<typeof setTimeout> | null;
  resolvedTimer: ReturnType<typeof setTimeout> | null;
  orphanTimer: ReturnType<typeof setTimeout> | null;
}

export const CHESS_RESULT_RECONNECT_GRACE_MS = 60_000;
export const CHESS_WIZARD_ORPHAN_READY_MS = 10_000;

export interface ChessServerOptions {
  displayToken?: string;
  random?: () => number;
  computerDelayMs?: number;
  maxRooms?: number;
  maxConnections?: number;
  webSocketServer?: WebSocketServer;
  roomFactory?: (code: string) => ChessRoom;
}

/** The only writer of a Voice Chess room; browser sockets are display-only. */
export class ChessServer {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, ChessRoom>();
  private readonly displays = new Set<DisplayConnection>();
  private readonly voiceBindings = new Map<string, VoiceBinding>();
  private readonly stationRooms = new Set<string>();
  private readonly previouslyBoundRooms = new Set<string>();
  private readonly computerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly resultReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly wizardScenes = new Map<string, WizardSceneRuntime>();
  private readonly wizardUsedCallSids = new Map<string, Set<string>>();
  private nextWizardSceneId = 1;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly displayToken: string;
  private readonly random: () => number;
  private readonly computerDelayMs: number;
  private readonly maxRooms: number;
  private readonly maxConnections: number;
  private readonly roomFactory: (code: string) => ChessRoom;
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
    this.roomFactory = options.roomFactory ?? (code => new ChessRoom(code, { random: this.random }));
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
    room = this.roomFactory(code);
    this.rooms.set(code, room);
    return room;
  }

  findRoom(rawCode: string): ChessRoom | undefined {
    const code = chessRoomCode(rawCode);
    return code ? this.rooms.get(code) : undefined;
  }

  /** A complete screen/voice snapshot with the optional cinematic overlay. */
  snapshot(rawCode: string): ChessState | null {
    const code = chessRoomCode(rawCode);
    if (!code) return null;
    const room = this.rooms.get(code);
    if (!room) return null;
    const state = room.state();
    const scene = this.wizardScenes.get(code)?.snapshot ?? null;
    const binding = this.voiceBindings.get(code);
    return {
      ...state,
      wizardAvailable: Boolean(binding?.connected && this.canStartWizardScene(code, binding.callSid, state)),
      wizardScene: scene ? { ...scene } : null,
    };
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

  /** A standalone screen must have accepted spectate for this exact room and still be connected. */
  hasStandaloneDisplay(ws: WebSocket, rawCode: string): boolean {
    const code = chessRoomCode(rawCode);
    return Boolean(code && this.rooms.has(code) && !this.stationReplayForbidden(code)
      && [...this.displays].some(display => display.ws === ws
        && this.displayAuthorizedForRoom(display, code)));
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
    if (trustedStationAssignment) this.stationRooms.add(code);
    if (current) {
      current.connected = true;
      room.setPlayerConnected(true);
      this.pushState(code);
      this.maybeScheduleComputer(code, room);
      return { playerId: current.playerId, resumed: true };
    }
    // A fixed station result belongs to its current match until station handoff.
    if (this.stationRooms.has(code) && room.state().phase === 'finished') return null;
    this.cancelResultReconnect(code);
    this.clearWizardScene(code);
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
    const scene = this.wizardScenes.get(code);
    if (scene) return this.handleWizardSceneCommand(code, scene, text, locale);
    if (isWizardChessTrigger(text, locale) && this.canStartWizardScene(code, binding.callSid, room.state())) {
      return this.startWizardScene(code, room, binding.callSid, locale);
    }
    if (room.state().phase === 'finished' && this.stationReplayForbidden(code)
      && parseChessIntent(text, locale).kind === 'reset') {
      return { code: 'finished', state: room.state(),
        message: locale === 'pt-BR'
          ? 'A estação vai preparar a próxima partida. Aguarde a próxima rodada.'
          : 'The station will prepare the next match. Please wait for the next round.' };
    }
    const result = room.handleVoiceCommand(text, locale);
    this.flush(room);
    this.pushState(code);
    if (result.code === 'confirmed') this.maybeScheduleComputer(code, room);
    return { ...result, state: this.snapshot(code) ?? result.state };
  }

  voiceLegalMoves(rawCode: string, callSid: string, locale: SupportedLocale): ChessVoiceMoveChoice[] {
    const code = chessRoomCode(rawCode);
    if (!code) return [];
    if (this.wizardScenes.has(code)) return [];
    const binding = this.voiceBindings.get(code);
    if (!binding?.connected || binding.callSid !== callSid.trim()) return [];
    return this.rooms.get(code)?.legalVoiceMoves(locale) ?? [];
  }

  voiceRestart(rawCode: string, callSid: string): boolean {
    const code = chessRoomCode(rawCode);
    if (!code) return false;
    const room = this.rooms.get(code);
    const binding = this.voiceBindings.get(code);
    if (!room || !binding?.connected || binding.callSid !== callSid.trim()
      || this.wizardScenes.has(code) || room.state().phase !== 'finished'
      || this.stationReplayForbidden(code)) return false;
    this.cancelResultReconnect(code);
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
    const used = this.wizardUsedCallSids.get(code);
    used?.delete(binding.callSid);
    if (used?.size === 0) this.wizardUsedCallSids.delete(code);
    this.cancelComputer(code);
    const room = this.rooms.get(code);
    room?.setPlayerConnected(false);
    const scene = this.wizardScenes.get(code);
    if (scene?.snapshot.phase === 'ready') this.maybeScheduleWizardOrphan(code, scene);
    if (room) this.pushState(code);
    this.reap(code);
  }

  abortRoom(rawCode: string): boolean {
    const code = chessRoomCode(rawCode);
    if (!code || !this.rooms.has(code)) return false;
    this.cancelResultReconnect(code);
    this.cancelComputer(code);
    this.clearWizardScene(code);
    for (const display of this.displays) {
      if (display.roomCode !== code) continue;
      display.roomCode = null;
      display.ws.close(4002, 'station recovery');
    }
    this.rooms.delete(code);
    this.voiceBindings.delete(code);
    this.previouslyBoundRooms.delete(code);
    this.stationRooms.delete(code);
    this.wizardUsedCallSids.delete(code);
    return true;
  }

  stopLoopOnly(): void {
    for (const timer of this.computerTimers.values()) clearTimeout(timer);
    this.computerTimers.clear();
    for (const timer of this.resultReconnectTimers.values()) clearTimeout(timer);
    this.resultReconnectTimers.clear();
    for (const code of this.wizardScenes.keys()) this.clearWizardScene(code);
    this.wizardUsedCallSids.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const display of this.displays) display.ws.terminate();
    this.displays.clear();
    this.voiceBindings.clear();
    this.rooms.clear();
    this.previouslyBoundRooms.clear();
    this.stationRooms.clear();
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
      const previousCode = display.roomCode;
      if (previousCode && previousCode !== code) {
        display.roomCode = null;
        this.reap(previousCode);
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
      this.cancelResultReconnect(code);
      if (previousCode && previousCode !== code) this.reap(previousCode);
      if (display.authenticatedRoomCode === code) this.onDisplayAuthenticated?.(display.ws);
      this.onDisplayRegistered?.(display.ws, code);
      this.flush(room);
      this.send(display, this.displayState(display, room));
      this.onRoomState?.(code);
      return;
    }
    if (message.type === 'leave') {
      const code = display.roomCode;
      display.roomCode = null;
      display.authenticatedRoomCode = null;
      if (code) this.reap(code);
      return;
    }
    if (message.type === 'display_wizard_skip') {
      const code = chessRoomCode(message.roomCode);
      if (!code || !this.displayAuthorizedForRoom(display, code)) {
        this.send(display, { type: 'error', code: 'bad_display_auth', message: 'Display is not viewing this room.' });
        return;
      }
      const room = this.rooms.get(code);
      const scene = this.wizardScenes.get(code);
      if (!room) return;
      if (!scene || !Number.isSafeInteger(message.sceneId)
        || message.sceneId !== scene.snapshot.id || scene.snapshot.phase !== 'story') {
        this.send(display, this.displayState(display, room));
        return;
      }
      this.skipWizardScene(code, scene);
      return;
    }
    if (message.type === 'display_replay') {
      const code = chessRoomCode(message.roomCode);
      if (!code || display.roomCode !== code) {
        this.send(display, { type: 'error', code: 'bad_display_auth', message: 'Display is not viewing this room.' });
        return;
      }
      const room = this.rooms.get(code);
      if (!room || !this.canDisplayReplay(display, room)
        || !Number.isSafeInteger(message.gameId) || message.gameId !== room.state().gameId) {
        if (room) this.send(display, this.displayState(display, room));
        return;
      }
      this.cancelResultReconnect(code);
      this.cancelComputer(code);
      room.reset();
      room.setPlayerConnected(true);
      this.flush(room);
      this.pushState(code);
      this.maybeScheduleComputer(code, room);
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
      if (display.roomCode === code) this.send(display, this.displayState(display, room));
    }
    this.onRoomState?.(code);
  }

  private canDisplayReplay(display: DisplayConnection, room: ChessRoom): boolean {
    const code = room.code;
    const binding = this.voiceBindings.get(code);
    return this.displayAuthorizedForRoom(display, code)
      && room.state().phase === 'finished' && room.state().playerConnected
      && Boolean(binding?.connected) && !this.stationReplayForbidden(code);
  }

  private displayAuthorizedForRoom(display: DisplayConnection, code: string): boolean {
    return display.roomCode === code && display.ws.readyState === WebSocket.OPEN
      && (!this.requiresDisplayAuth(code) || display.authenticatedRoomCode === code);
  }

  private stationReplayForbidden(code: string): boolean {
    return this.stationRooms.has(code);
  }

  private displayState(display: DisplayConnection, room: ChessRoom): unknown {
    return { type: 'chess_state', ...this.snapshot(room.code),
      canReplayOnDisplay: this.canDisplayReplay(display, room) };
  }

  private canStartWizardScene(code: string, callSid: string, state: ChessState): boolean {
    const binding = this.voiceBindings.get(code);
    return Boolean(binding?.connected && binding.callSid === callSid && state.playerConnected
      && !state.result && state.turn === state.humanColor && !this.wizardScenes.has(code)
      && !this.wizardUsedCallSids.get(code)?.has(callSid)
      && (state.ply === 0 || (state.ply === 1 && state.lastMove?.actor === 'computer')));
  }

  private startWizardScene(code: string, room: ChessRoom, callSid: string,
    locale: SupportedLocale): ChessCommandResponse {
    // A proposed opening move has not changed chess.js. Clear only its temporary
    // confirmation so it cannot reappear when the cinematic overlay closes.
    const state = room.state();
    if (state.pendingMove || state.selection) {
      room.cancelMove(locale);
      this.flush(room);
    }
    this.cancelComputer(code);
    const now = Date.now();
    const scene: WizardSceneRuntime = {
      room, gameId: room.state().gameId, callSid,
      snapshot: { id: this.nextWizardSceneId++, phase: 'story', startedAt: now,
        readyAt: null, resolvedAt: null },
      storyTimer: null, resolvedTimer: null, orphanTimer: null,
    };
    let used = this.wizardUsedCallSids.get(code);
    if (!used) { used = new Set(); this.wizardUsedCallSids.set(code, used); }
    used.add(callSid);
    this.wizardScenes.set(code, scene);
    const timer = setTimeout(() => {
      this.skipWizardScene(code, scene);
    }, WIZARD_CHESS_STORY_DURATION_MS);
    timer.unref?.();
    scene.storyTimer = timer;
    this.pushState(code);
    return this.wizardResult(code, 'wizard_started', locale === 'pt-BR'
      ? 'O xadrez bruxo começou na tela. Anuncie a jogada do Ron quando quiser.'
      : 'Wizard chess is on screen. Call Ron’s move whenever you’re ready.');
  }

  private handleWizardSceneCommand(code: string, scene: WizardSceneRuntime, spoken: string,
    locale: SupportedLocale): ChessCommandResponse {
    const action = parseWizardChessVoiceAction(spoken, locale);
    if (scene.snapshot.phase === 'resolved') {
      if (action === 'exit') {
        this.completeWizardScene(code, scene);
        return this.wizardResult(code, 'wizard_exited', locale === 'pt-BR'
          ? 'A cena terminou. Uma nova partida de xadrez normal está pronta.'
          : 'The scene has ended. A fresh ordinary chess game is ready.');
      }
      return this.wizardResult(code, 'wizard_waiting', locale === 'pt-BR'
        ? 'O final da cena está passando. O tabuleiro normal voltará em instantes; diga sair para voltar agora.'
        : 'The finale is playing. The ordinary board will return shortly; say exit to return now.');
    }
    if (action === 'exit') {
      this.clearWizardScene(code);
      this.pushState(code);
      this.maybeScheduleComputer(code, scene.room);
      return this.wizardResult(code, 'wizard_exited', locale === 'pt-BR'
        ? 'A cena foi fechada. Continue sua partida de xadrez normal.'
        : 'The scene has closed. Continue your ordinary chess game.');
    }
    if (action === 'skip') {
      this.skipWizardScene(code, scene);
      return this.wizardResult(code, 'wizard_skipped', locale === 'pt-BR'
        ? 'A cena avançou até a jogada. Diga a jogada de Ron ou peça uma dica.'
        : 'The scene has skipped to the move. Call Ron’s move or ask for a hint.');
    }
    if (action === 'hint') {
      this.skipWizardScene(code, scene);
      return this.wizardResult(code, 'wizard_hint', locale === 'pt-BR'
        ? 'Dica: mova o cavalo de Ron de G cinco para H três. Diga cavalo para H três.'
        : 'Hint: move Ron’s knight from G five to H three. Say knight to H three.');
    }
    if (action === 'final') {
      if (scene.storyTimer) clearTimeout(scene.storyTimer);
      scene.storyTimer = null;
      const now = Date.now();
      scene.snapshot = { ...scene.snapshot, phase: 'resolved',
        readyAt: scene.snapshot.readyAt ?? now, resolvedAt: now };
      const timer = setTimeout(() => {
        if (!this.isCurrentWizardScene(code, scene) || scene.snapshot.phase !== 'resolved') return;
        this.completeWizardScene(code, scene);
      }, WIZARD_CHESS_RESOLVED_DURATION_MS);
      timer.unref?.();
      scene.resolvedTimer = timer;
      this.pushState(code);
      return this.wizardResult(code, 'wizard_resolved', locale === 'pt-BR'
        ? 'Cavalo de Ron para H três, xeque! Veja o tabuleiro.'
        : 'Ron’s knight to H three, check! Watch the board.');
    }
    this.skipWizardScene(code, scene);
    return this.wizardResult(code, 'wizard_waiting', locale === 'pt-BR'
      ? 'Nesta cena, você pode pedir uma dica, pular para a jogada, anunciar a jogada de Ron ou dizer sair.'
      : 'In this scene, you can ask for a hint, skip to the move, call Ron’s move, or say exit.');
  }

  private wizardResult(code: string, resultCode: ChessCommandResponse['code'],
    message: string): ChessCommandResponse {
    const state = this.snapshot(code);
    if (!state) throw new Error(`Chess room ${code} disappeared during a voice command`);
    return { code: resultCode, message, state };
  }

  private skipWizardScene(code: string, scene: WizardSceneRuntime): boolean {
    if (!this.isCurrentWizardScene(code, scene) || scene.snapshot.phase !== 'story') return false;
    if (scene.storyTimer) clearTimeout(scene.storyTimer);
    scene.storyTimer = null;
    scene.snapshot = { ...scene.snapshot, phase: 'ready', readyAt: Date.now() };
    this.maybeScheduleWizardOrphan(code, scene);
    this.pushState(code);
    return true;
  }

  private isCurrentWizardScene(code: string, scene: WizardSceneRuntime): boolean {
    const binding = this.voiceBindings.get(code);
    return this.wizardScenes.get(code) === scene && this.rooms.get(code) === scene.room
      && scene.room.state().gameId === scene.gameId
      && (!binding || binding.callSid === scene.callSid);
  }

  private maybeScheduleWizardOrphan(code: string, scene: WizardSceneRuntime): void {
    if (scene.snapshot.phase !== 'ready' || this.voiceBindings.has(code) || scene.orphanTimer) return;
    const timer = setTimeout(() => {
      if (!this.isCurrentWizardScene(code, scene) || this.voiceBindings.has(code)
        || scene.snapshot.phase !== 'ready') return;
      scene.orphanTimer = null;
      this.clearWizardScene(code);
      this.pushState(code);
    }, CHESS_WIZARD_ORPHAN_READY_MS);
    timer.unref?.();
    scene.orphanTimer = timer;
  }

  private completeWizardScene(code: string, scene: WizardSceneRuntime): void {
    if (!this.isCurrentWizardScene(code, scene)) return;
    this.clearWizardScene(code);
    this.cancelComputer(code);
    scene.room.reset();
    this.flush(scene.room);
    this.pushState(code);
    this.maybeScheduleComputer(code, scene.room);
  }

  private clearWizardScene(code: string): void {
    const scene = this.wizardScenes.get(code);
    if (!scene) return;
    if (scene.storyTimer) clearTimeout(scene.storyTimer);
    if (scene.resolvedTimer) clearTimeout(scene.resolvedTimer);
    if (scene.orphanTimer) clearTimeout(scene.orphanTimer);
    this.wizardScenes.delete(code);
  }

  private maybeScheduleComputer(code: string, room: ChessRoom): void {
    const state = room.state();
    if (!state.playerConnected || state.phase === 'finished' || state.turn !== state.computerColor
      || this.computerTimers.has(code) || this.wizardScenes.has(code)) return;
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
    const room = this.rooms.get(code);
    if (room?.state().phase === 'finished') {
      // Station handoff explicitly aborts the old match. A standalone display
      // can reconnect after a brief network drop without losing its result.
      if (this.stationRooms.has(code)) return;
      if (!this.resultReconnectTimers.has(code)) {
        const timer = setTimeout(() => {
          this.resultReconnectTimers.delete(code);
          if (this.rooms.get(code) !== room || this.voiceBindings.has(code)
            || [...this.displays].some(display => display.roomCode === code)
            || room.state().phase !== 'finished') return;
          this.deleteRoom(code);
        }, CHESS_RESULT_RECONNECT_GRACE_MS);
        timer.unref?.();
        this.resultReconnectTimers.set(code, timer);
      }
      return;
    }
    this.deleteRoom(code);
  }

  private cancelResultReconnect(code: string): void {
    const timer = this.resultReconnectTimers.get(code);
    if (!timer) return;
    clearTimeout(timer);
    this.resultReconnectTimers.delete(code);
  }

  private deleteRoom(code: string): void {
    this.cancelResultReconnect(code);
    this.cancelComputer(code);
    this.clearWizardScene(code);
    this.rooms.delete(code);
    this.previouslyBoundRooms.delete(code);
    this.stationRooms.delete(code);
    this.wizardUsedCallSids.delete(code);
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
