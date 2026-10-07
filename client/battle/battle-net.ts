// Client WebSocket for Voice Monsters (/battle). Mirrors net.ts (GameConnection): auto-reconnect with
// backoff + identity replay, typed callbacks. Turn-based, so it just relays battle_state / roster /
// battle_events rather than a snapshot stream.
import type { BattleServerMessage, RosterEntry, BattleLobbyPlayer } from '../../shared/battle-protocol';
import type { BattleSnapshot, BattleEvent, BattleAction } from '../../shared/battle-world';
import type { SupportedLocale } from '../../shared/i18n/locales';
import { withDisplaySession } from '../display-session';

export interface BattleStateMsg {
  roomCode: string; phase: string; players: BattleLobbyPlayer[];
  snapshot: BattleSnapshot | null; result: { winner: string; winnerName: string } | null;
  generation: number; resultsPresented: boolean;
  canAdvanceLobby: boolean; canStartBattle: boolean;
  activeSide?: 'a' | 'b' | null; activeMenu?: 'root' | 'fight';
  canRematch?: boolean;
}

export class BattleConnection {
  private ws!: WebSocket;
  private closed = false;
  private backoff = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingReleaseSessionId: string | null = null;
  private stateGeneration: number | null = null;
  private eventGeneration: number | null = null;
  private deliveredEventIds = new Set<number>();
  private futureEventFrames: {generation:number;eventIds:number[];events:BattleEvent[]}[] = [];
  private identity: { type: 'join'; roomCode: string; name: string; sessionId: string; locale?: SupportedLocale } | { type: 'spectate'; roomCode: string; locale?: SupportedLocale; displayToken?: string } | null = null;

  private onRosterCb?: (m: RosterEntry[]) => void;
  private onStateCb?: (m: BattleStateMsg) => void;
  private onEventsCb?: (e: BattleEvent[], eventIds: number[], generation: number) => void;
  private onShowResultsCb?: (generation: number) => void;
  private onConnectedCb?: () => void;
  private onDisconnectedCb?: () => void;
  private onJoinedCb?: (playerId: string) => void;
  private onErrorCb?: (code: string, message: string) => void;

  constructor(private url: string, private locale?: SupportedLocale) { this.connect(); }

  private connect(): void {
    this.stateGeneration = null;
    this.eventGeneration = null;
    this.deliveredEventIds.clear();
    this.futureEventFrames = [];
    this.ws = new WebSocket(withDisplaySession(this.url));
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as BattleServerMessage;
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
      else if (m.type === 'error') this.onErrorCb?.(m.code, m.message);
    };
    this.ws.onopen = () => {
      this.backoff = 500;
      this.onConnectedCb?.();
      if (this.pendingReleaseSessionId) {
        this.rawSend({ type: 'leave', sessionId: this.pendingReleaseSessionId });
        this.pendingReleaseSessionId = null;
      }
      if (this.identity) this.rawSend(this.identity);
    };
    this.ws.onclose = (ev) => {
      this.onDisconnectedCb?.();
      if (ev.code === 4001) { this.closed = true; return; }
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

  // join/spectate set the IDENTITY (the single source of truth, replayed on every (re)connect by
  // onopen). If the socket is already open, send it once now; otherwise onopen will. Do NOT also go
  // through send()'s open-listener queue, or the join fires TWICE → two player slots → a room stuck
  // waiting on a phantom 2nd player (the "stuck on waiting…" bug).
  join(roomCode: string, name: string) {
    this.pendingReleaseSessionId = null;
    this.identity = { type: 'join', roomCode, name, sessionId: sessionIdFor(roomCode), ...(this.locale ? { locale: this.locale } : {}) };
    this.rawSend(this.identity);
  }
  spectate(roomCode: string, displayToken?: string) { this.identity = { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}), ...(displayToken ? { displayToken } : {}) }; this.rawSend(this.identity); }
  /** Drop this client's player slot but keep watching (the shared screen's P-toggle-off). Reverts the
   *  replayed identity to spectator so a reconnect doesn't silently rejoin as a player. */
  leave(roomCode: string) {
    const sessionId = this.identity?.type === 'join' ? this.identity.sessionId : null;
    this.identity = { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}) };
    if (this.ws.readyState === WebSocket.OPEN) {
      this.rawSend({ type: 'leave', ...(sessionId ? { sessionId } : {}) });
      this.rawSend(this.identity);
    }
    else this.pendingReleaseSessionId = sessionId;
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
    try { this.ws.close(); } catch { /* already closing */ }
  }
}

function sessionIdFor(roomCode: string): string {
  const key = `voice-monsters-session:${roomCode}`;
  try {
    const prior = sessionStorage.getItem(key);
    if (prior) return prior;
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
