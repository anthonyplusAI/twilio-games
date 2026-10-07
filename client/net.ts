import type { Intent, Item, WorldSnapshot, GameEvent, LobbyPlayer, Phase, RaceResult, MenuTouchState } from '../shared/types';
import type { SupportedLocale } from '../shared/i18n/locales';
import { withDisplaySession } from './display-session';

export interface LobbyMsg { roomCode: string; players: LobbyPlayer[]; phase: Phase; touch?: MenuTouchState }
export interface SelectStateMsg { roomCode: string; phase: Phase; players: LobbyPlayer[]; maps: string[]; selectedMap: string | null; mapVotes?: Record<string, number>; mapTie?: boolean; touch?: MenuTouchState }
export interface ResultsMsg { roomCode: string; map: string | null; results: RaceResult[]; touch?: MenuTouchState }

export class GameConnection {
  private ws!: WebSocket;
  private onItemsCb?: (items: Item[], map?: string | null) => void;
  private onSnapCb?: (s: WorldSnapshot) => void;
  private onEventCb?: (e: GameEvent) => void;
  private onJoinedCb?: (playerId: string, lane: number) => void;
  private onErrorCb?: (code: string, message: string) => void;
  private onLobbyCb?: (msg: LobbyMsg) => void;
  private onSelectCb?: (msg: SelectStateMsg) => void;
  private onResultsCb?: (msg: ResultsMsg) => void;
  // Reconnect state: the socket can drop (venue wifi, laptop sleep, server redeploy). We auto-
  // reconnect with capped exponential backoff and REPLAY the identity (join/spectate) so the room
  // membership re-establishes. The server issues a fresh playerId on rejoin — fine for a party game.
  private closed = false;                       // true once dispose() is called → stop reconnecting
  private backoff = 500;                        // ms; doubles per failed attempt, capped
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** The identity to replay on reconnect (last join or spectate), so we rejoin the same room. */
  private identity: { type: 'join'; roomCode: string; name: string; locale?: SupportedLocale;
    rendererReadyGate?: boolean } | { type: 'spectate'; roomCode: string; locale?: SupportedLocale; displayToken?: string } | null = null;

  constructor(private url: string, private locale?: SupportedLocale) {
    this.connect();
  }

  private connect(): void {
    this.ws = new WebSocket(withDisplaySession(this.url));
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'items') this.onItemsCb?.(m.items, m.map);
      else if (m.type === 'snapshot') this.onSnapCb?.(m.snapshot);
      else if (m.type === 'event') this.onEventCb?.(m.event);
      else if (m.type === 'joined') this.onJoinedCb?.(m.playerId, m.lane);
      else if (m.type === 'error') this.onErrorCb?.(m.code, m.message);
      else if (m.type === 'lobby') this.onLobbyCb?.(m);
      else if (m.type === 'select_state') this.onSelectCb?.(m);
      else if (m.type === 'results') this.onResultsCb?.(m);
    };
    this.ws.onopen = () => {
      this.backoff = 500;                       // reset backoff on a successful connect
      if (this.identity) this.rawSend(this.identity);   // re-establish room membership
    };
    this.ws.onclose = () => { if (!this.closed) this.scheduleReconnect(); };
    // onerror precedes onclose in browsers; let onclose drive the retry (avoid double-scheduling).
    this.ws.onerror = () => { /* handled by onclose */ };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 8000);   // cap at 8s
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  /** Send only if OPEN (no open-listener queueing — reconnect + identity replay handle drops). */
  private rawSend(o: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  /** Stop reconnecting and close (e.g. real race takes over / page teardown). */
  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws.close(); } catch { /* already closing */ }
  }

  /** A control belongs to the screen/round where it was entered. Identity is replayed
   * on reconnect; a delayed control must not change a later round. */
  private send(o: unknown) { this.rawSend(o); }
  join(roomCode: string, name: string, rendererReadyGate = false) {
    this.identity = { type: 'join', roomCode, name, ...(this.locale ? { locale: this.locale } : {}),
      ...(rendererReadyGate ? { rendererReadyGate: true } : {}) };
    this.rawSend(this.identity); // onopen sends it when the initial socket is still connecting
  }
  spectate(roomCode: string, displayToken?: string) {
    this.identity = { type: 'spectate', roomCode, ...(this.locale ? { locale: this.locale } : {}), ...(displayToken ? { displayToken } : {}) };
    this.rawSend(this.identity); // onopen sends it when the initial socket is still connecting
  }
  /** Drop this connection's player slot but stay connected as a spectator (shared-screen toggle). */
  leave() { if (this.identity?.type === 'join') this.identity = { type: 'spectate', roomCode: this.identity.roomCode, ...(this.locale ? { locale: this.locale } : {}) }; this.send({ type: 'leave' }); }
  ready() { this.send({ type: 'ready' }); }
  restart() { this.send({ type: 'restart' }); }
  sendIntent(i: Intent) { this.send({ type: 'intent', intent: i }); }
  // Smash-style flow
  selectCar(carIndex: number) { this.send({ type: 'select_car', carIndex }); }
  selectMap(map: string) { this.send({ type: 'select_map', map }); }
  advance() { this.send({ type: 'advance' }); }
  back() { this.send({ type: 'back' }); }
  /** Shared-screen taps are never queued over reconnects: their screen/seat context may expire. */
  displaySelectCar(roomCode: string, forPlayerId: string, carIndex: number) {
    this.rawSend({ type: 'display_select_car', roomCode, expectedPhase: 'car_select', forPlayerId, carIndex });
  }
  displaySelectMap(roomCode: string, forPlayerId: string, map: string) {
    this.rawSend({ type: 'display_select_map', roomCode, expectedPhase: 'map_select', forPlayerId, map });
  }
  displayAdvance(roomCode: string, expectedPhase: 'lobby' | 'car_select' | 'map_select' | 'results', forPlayerId: string | null) {
    this.rawSend({ type: 'display_advance', roomCode, expectedPhase,
      ...(forPlayerId ? { forPlayerId } : {}) });
  }
  displayBack(roomCode: string, expectedPhase: 'car_select' | 'map_select') {
    this.rawSend({ type: 'display_back', roomCode, expectedPhase });
  }

  onItems(cb: (items: Item[], map?: string | null) => void) { this.onItemsCb = cb; }
  onSnapshot(cb: (s: WorldSnapshot) => void) { this.onSnapCb = cb; }
  onEvent(cb: (e: GameEvent) => void) { this.onEventCb = cb; }
  onJoined(cb: (playerId: string, lane: number) => void) { this.onJoinedCb = cb; }
  onError(cb: (code: string, message: string) => void) { this.onErrorCb = cb; }
  onLobby(cb: (msg: LobbyMsg) => void) { this.onLobbyCb = cb; }
  onSelectState(cb: (msg: SelectStateMsg) => void) { this.onSelectCb = cb; }
  onResults(cb: (msg: ResultsMsg) => void) { this.onResultsCb = cb; }
}
