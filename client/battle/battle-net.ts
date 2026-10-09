// Client WebSocket for Voice Monsters (/battle). Mirrors net.ts (GameConnection): auto-reconnect with
// backoff + identity replay, typed callbacks. Turn-based, so it just relays battle_state / roster /
// battle_events rather than a snapshot stream.
import type { BattleServerMessage, RosterEntry, BattleLobbyPlayer } from '../../shared/battle-protocol';
import type { BattleSnapshot, BattleEvent, BattleAction } from '../../shared/battle-world';
import type { SupportedLocale } from '../../shared/i18n/locales';
import { withDisplaySession } from '../display-session';

export interface BattleStateMsg {
  roomCode: string; phase: string; players: BattleLobbyPlayer[];
  expectedPlayerCount?: number;
  snapshot: BattleSnapshot | null; result: { winner: string; winnerName: string } | null;
  generation: number; resultsPresented: boolean;
  canAdvanceLobby: boolean; canStartBattle: boolean;
  activeSide?: 'a' | 'b' | null; activeMenu?: 'root' | 'fight';
  canRematch?: boolean;
}

interface KeyboardSessionContext {
  displaySessionId: string | null;
  memoryIds: Map<string, string>;
  pendingRelease: PendingKeyboardRelease | null;
}

interface PendingKeyboardRelease {
  sessionId: string;
  completed: Promise<void>;
  confirm: () => void;
}

export class BattleConnection {
  private ws!: WebSocket;
  private closed = false;
  private backoff = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingReleaseSessionId: string | null = null;
  private pendingKeyboardJoin: { roomCode: string; name: string } | null = null;
  private joinSent = false;
  private closingRelease: PendingKeyboardRelease | null = null;
  private releaseRetryTimer: ReturnType<typeof setInterval> | null = null;
  private releaseAttempts = 0;
  private displayPlayerCount: 1 | 2 | null = null;
  private hostIdentity: boolean | null = null;
  private stateGeneration: number | null = null;
  private eventGeneration: number | null = null;
  private deliveredEventIds = new Set<number>();
  private futureEventFrames: {generation:number;eventIds:number[];events:BattleEvent[]}[] = [];
  private identity: { type: 'join'; roomCode: string; name: string; sessionId: string; locale?: SupportedLocale } | { type: 'spectate'; roomCode: string; locale?: SupportedLocale; displayToken?: string; playerCount?: 1 | 2 } | null = null;

  private onRosterCb?: (m: RosterEntry[]) => void;
  private onStateCb?: (m: BattleStateMsg) => void;
  private onEventsCb?: (e: BattleEvent[], eventIds: number[], generation: number) => void;
  private onShowResultsCb?: (generation: number) => void;
  private onConnectedCb?: () => void;
  private onDisconnectedCb?: () => void;
  private onJoinedCb?: (playerId: string) => void;
  private onErrorCb?: (code: string, message: string) => void;
  private keyboardSessionContext: KeyboardSessionContext | null;

  constructor(private url: string, private locale?: SupportedLocale, keyboardSessionContext?: KeyboardSessionContext) {
    this.keyboardSessionContext = keyboardSessionContext ?? null;
    this.connect();
  }

  private connect(): void {
    this.hostIdentity = null;
    this.stateGeneration = null;
    this.eventGeneration = null;
    this.deliveredEventIds.clear();
    this.futureEventFrames = [];
    this.ws = new WebSocket(withDisplaySession(this.url));
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as BattleServerMessage;
      if (m.type === 'session_released') {
        if (this.closingRelease?.sessionId === m.sessionId) this.finishRelease();
        return;
      }
      if (m.type === 'roster') this.onRosterCb?.(m.monsters);
      else if (m.type === 'battle_state') {
        this.stateGeneration = m.generation;
        this.onStateCb?.(m);
        const ready = this.futureEventFrames.filter(frame => frame.generation === m.generation);
        this.futureEventFrames = this.futureEventFrames.filter(frame => frame.generation > m.generation);
        for (const frame of ready) this.deliverEventFrame(frame);
      }
      else if (m.type === 'battle_events') {
        if (m.events.length !== m.eventIds.length) return;
        if (this.stateGeneration === null || m.generation > this.stateGeneration) {
          this.futureEventFrames.push(m);
          if (this.futureEventFrames.length > 64) this.futureEventFrames.shift();
        } else if (m.generation === this.stateGeneration) this.deliverEventFrame(m);
      }
      else if (m.type === 'show_results') this.onShowResultsCb?.(m.generation);
      else if (m.type === 'joined') this.onJoinedCb?.(m.playerId);
      else if (m.type === 'host_identity' && this.identity?.roomCode === m.roomCode) {
        const wasHost = this.hostIdentity;
        this.hostIdentity = m.isHost;
        if (wasHost === false && m.isHost && this.identity.type === 'spectate') this.sendDisplayPlayerCount();
      }
      else if (m.type === 'error') this.onErrorCb?.(m.code, m.message);
    };
    this.ws.onopen = () => {
      this.backoff = 500;
      this.onConnectedCb?.();
      if (this.closingRelease) { this.sendClosingRelease(); return; }
      if (this.pendingReleaseSessionId) {
        this.rawSend({ type: 'leave', sessionId: this.pendingReleaseSessionId });
        this.pendingReleaseSessionId = null;
      }
      if (this.identity) {
        this.sendIdentity();
        if (this.identity.type === 'spectate') this.sendDisplayPlayerCount();
      }
    };
    this.ws.onclose = (ev) => {
      this.onDisconnectedCb?.();
      if (ev.code === 4001 && !this.closingRelease) { this.closed = true; return; }
      this.releaseAttempts = 0;
      if (!this.closed) this.scheduleReconnect();
    };
    this.ws.onerror = () => { /* onclose drives retry */ };
  }
  private deliverEventFrame(frame:{generation:number;eventIds:number[];events:BattleEvent[]}):void{
    if (frame.generation !== this.eventGeneration) {
      this.eventGeneration = frame.generation;
      this.deliveredEventIds.clear();
    }
    const events: BattleEvent[] = [], eventIds: number[] = [];
    for (let index = 0; index < frame.eventIds.length; index++) {
      const eventId = frame.eventIds[index]!;
      if (this.deliveredEventIds.has(eventId)) continue;
      this.deliveredEventIds.add(eventId);
      events.push(frame.events[index]!); eventIds.push(eventId);
    }
    if (events.length) this.onEventsCb?.(events, eventIds, frame.generation);
  }
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.backoff; this.backoff = Math.min(this.backoff * 2, 8000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }
  private rawSend(o: unknown): void { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
  private send(o: unknown): void { this.rawSend(o); }
  private sendIdentity(): void {
    if (!this.identity || this.ws.readyState !== WebSocket.OPEN) return;
    this.rawSend(this.identity);
    if (this.identity.type === 'join') this.joinSent = true;
  }
  private sendClosingRelease(): void {
    if (!this.closingRelease || this.ws.readyState !== WebSocket.OPEN) return;
    this.rawSend({ type: 'leave', sessionId: this.closingRelease.sessionId });
    this.releaseAttempts++;
    if (this.releaseRetryTimer) return;
    this.releaseRetryTimer = setInterval(() => {
      if (!this.closingRelease || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.releaseAttempts >= 3) {
        this.releaseAttempts = 0;
        try { this.ws.close(); } catch { /* onclose drives reconnect */ }
      } else this.sendClosingRelease();
    }, 500);
  }

  /** A keyboard player gets its own socket; the display keeps its spectator/host identity. */
  createKeyboardPlayerConnection(): BattleConnection {
    const url = new URL(this.url);
    url.searchParams.delete('display');
    url.searchParams.delete('displaySessionId');
    const displaySessionId = new URL(this.ws.url).searchParams.get('displaySessionId');
    if (!this.keyboardSessionContext || this.keyboardSessionContext.displaySessionId !== displaySessionId)
      this.keyboardSessionContext = { displaySessionId, memoryIds: new Map(), pendingRelease: null };
    return new BattleConnection(url.toString(), this.locale, this.keyboardSessionContext);
  }

  // join/spectate set the IDENTITY (the single source of truth, replayed on every (re)connect by
  // onopen). If the socket is already open, send it once now; otherwise onopen will. Do NOT also go
  // through send()'s open-listener queue, or the join fires TWICE → two player slots → a room stuck
  // waiting on a phantom 2nd player (the "stuck on waiting…" bug).
  join(roomCode: string, name: string) {
    this.pendingReleaseSessionId = null;
    const release = this.keyboardSessionContext?.pendingRelease;
    if (release) {
      this.pendingKeyboardJoin = { roomCode, name };
      void release.completed.then(() => {
        if (this.closed || this.pendingKeyboardJoin?.roomCode !== roomCode
          || this.pendingKeyboardJoin.name !== name) return;
        this.pendingKeyboardJoin = null;
        this.join(roomCode, name);
      });
      return;
    }
    this.joinSent = false;
    this.identity = { type: 'join', roomCode, name, sessionId: sessionIdFor(roomCode, this.keyboardSessionContext),
      ...(this.locale ? { locale: this.locale } : {}) };
    this.sendIdentity();
  }
  spectate(roomCode: string, displayToken?: string, playerCount?: 1 | 2) {
    if (playerCount) this.displayPlayerCount = playerCount;
    if (this.identity?.roomCode !== roomCode) this.hostIdentity = null;
    this.identity = { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}),
      ...(displayToken ? { displayToken } : {}),
      ...(this.displayPlayerCount ? { playerCount: this.displayPlayerCount } : {}) };
    this.rawSend(this.identity);
    // Keep the follow-up for older servers; host promotion also reapplies this count.
    this.sendDisplayPlayerCount();
  }
  private sendDisplayPlayerCount(): void {
    if (this.displayPlayerCount) this.rawSend({ type: 'configure_players', count: this.displayPlayerCount });
  }
  /** Release a keyboard player even if its socket is reconnecting. A display that wants to keep
   * watching uses the default; a separate keyboard socket waits for a receipt before closing. */
  leave(roomCode: string, keepWatching = true) {
    if (this.closingRelease) return;
    const sessionId = this.identity?.type === 'join' ? this.identity.sessionId : null;
    const joinSent = this.joinSent;
    this.joinSent = false;
    if (sessionId) clearSessionId(roomCode, this.keyboardSessionContext);
    this.pendingKeyboardJoin = null;
    this.identity = keepWatching ? { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}),
      ...(this.displayPlayerCount ? { playerCount: this.displayPlayerCount } : {}) } : null;
    if (keepWatching) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.rawSend({ type: 'leave', ...(sessionId ? { sessionId } : {}) });
        this.sendIdentity();
        this.sendDisplayPlayerCount();
      } else this.pendingReleaseSessionId = sessionId;
      return;
    }
    if (!sessionId || !joinSent) { this.finishRelease(); return; }
    let confirm!: () => void;
    const completed = new Promise<void>(resolve => { confirm = resolve; });
    const release: PendingKeyboardRelease = { sessionId, completed, confirm };
    this.closingRelease = release;
    if (this.keyboardSessionContext) this.keyboardSessionContext.pendingRelease = release;
    if (this.ws.readyState === WebSocket.OPEN) this.sendClosingRelease();
    else this.scheduleReconnect();
  }
  private finishRelease(): void {
    const release = this.closingRelease;
    this.closingRelease = null;
    if (release && this.keyboardSessionContext?.pendingRelease === release)
      this.keyboardSessionContext.pendingRelease = null;
    if (this.releaseRetryTimer) { clearInterval(this.releaseRetryTimer); this.releaseRetryTimer = null; }
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    setTimeout(() => { try { ws.close(); } catch { /* already closed */ } }, 40);
    release?.confirm();
  }
  selectMonster(monsterId: string) { this.send({ type: 'select_monster', monsterId }); }
  displaySelectMonster(playerId: string, monsterId: string) { this.send({ type: 'display_select_monster', playerId, monsterId }); }
  /** Receipts are valid only for the socket that rendered them; never queue across reconnects. */
  ackEvent(generation: number, eventId: number) { this.rawSend({ type: 'ack_event', generation, eventId }); }
  ackResults(generation: number) { this.rawSend({ type: 'ack_results', generation }); }
  openFight() { this.send({ type: 'open_fight' }); }
  backMenu() { this.send({ type: 'back_menu' }); }
  chooseMove(moveId: string) { this.send({ type: 'choose_move', moveId }); }
  chooseAction(action: BattleAction) { this.send({ type: 'choose_action', action }); }
  advance() { this.send({ type: 'advance' }); }
  back() { this.send({ type: 'back' }); }

  onRoster(cb: (m: RosterEntry[]) => void) { this.onRosterCb = cb; }
  onState(cb: (m: BattleStateMsg) => void) { this.onStateCb = cb; }
  onEvents(cb: (e: BattleEvent[], eventIds: number[], generation: number) => void) { this.onEventsCb = cb; }
  onShowResults(cb: (generation: number) => void) { this.onShowResultsCb = cb; }
  onConnected(cb: () => void) { this.onConnectedCb = cb; }
  onDisconnected(cb: () => void) { this.onDisconnectedCb = cb; }
  onJoined(cb: (playerId: string) => void) { this.onJoinedCb = cb; }
  onError(cb: (code: string, message: string) => void) { this.onErrorCb = cb; }

  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.releaseRetryTimer) clearInterval(this.releaseRetryTimer);
    try { this.ws.close(); } catch { /* already closing */ }
  }
}

function sessionStorageKey(roomCode: string, keyboard: KeyboardSessionContext | null): string | null {
  if (!keyboard) return `voice-monsters-session:${roomCode}`;
  return keyboard.displaySessionId
    ? `voice-monsters-keyboard-session:${keyboard.displaySessionId}:${roomCode}` : null;
}

function sessionIdFor(roomCode: string, keyboard: KeyboardSessionContext | null): string {
  const key = sessionStorageKey(roomCode, keyboard);
  const inMemory = keyboard?.memoryIds.get(roomCode);
  if (inMemory) return inMemory;
  try {
    const prior = key ? sessionStorage.getItem(key) : null;
    if (prior) { keyboard?.memoryIds.set(roomCode, prior); return prior; }
  } catch { /* An in-memory keyboard ID still survives P toggles when storage is unavailable. */ }
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  keyboard?.memoryIds.set(roomCode, id);
  if (key) try { sessionStorage.setItem(key, id); } catch { /* no storage */ }
  return id;
}

function clearSessionId(roomCode: string, keyboard: KeyboardSessionContext | null): void {
  keyboard?.memoryIds.delete(roomCode);
  const key = sessionStorageKey(roomCode, keyboard);
  if (!key) return;
  try { sessionStorage.removeItem(key); }
  catch { /* unavailable storage never blocks leaving */ }
}
