import { RaceWorld } from '../shared/race-world';
import { Lobby } from '../shared/lobby';
import { MAX_PLAYERS, LANES } from '../shared/constants';
import type { Intent, WorldSnapshot, Phase, GameEvent, LobbyPlayer, RaceResult } from '../shared/types';

const COLORS = ['#36d1dc','#f22f46','#ffcf5c','#36e08a','#a06bff','#ff8a5c','#5c8aff','#ff5ca8'];
const SETUP_CROSSTALK_MS = 1_000;

/** Accept only a safe CSS color (hex or simple rgb/hsl), else fall back. Colors are interpolated
 *  into style="..." on the display, so an unvalidated value is a stored-XSS vector — reject anything
 *  that isn't an obvious color literal. */
function safeColor(color: string | undefined, fallback: string): string {
  if (typeof color !== 'string') return fallback;
  const c = color.trim();
  if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c)) return c;            // #rgb / #rrggbb
  if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(c)) return c;
  if (/^hsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\)$/.test(c)) return c;
  return fallback;
}

export interface RoomConfig { carCount: number; maps: string[]; carNames?: string[]; }

/**
 * A game room. Owns the pre-race flow (Lobby: lobby → car_select → map_select) and, once started,
 * a RaceWorld (countdown → racing → finished). After a race it holds the standings in 'results'
 * until someone advances back to the lobby. The server (GameServer) drives transitions via the
 * public methods; broadcasting/persistence live in the server.
 */
export class Room {
  readonly code: string;
  private seed: number;
  private lobby: Lobby;
  private world: RaceWorld | null = null;
  private _phase: Phase = 'lobby';
  private nextId = 1;
  private lastResults: RaceResult[] = [];
  private raceMap: string | null = null;
  private carNames: string[] = [];
  private expectedHumanPlayers = 1;
  private stationManaged = false;
  private stationSlots = new Map<number, string>();
  private confirmedPlayerNames = new Set<string>();
  /** A caller joining after the finish waits for the current roster to replay. Their slot is
   * reserved without replacing the results that the players are still looking at. */
  private nextRoundPlayers = new Map<string, { name: string; color: string }>();
  private recentSetupChoice: {
    phase: 'car_select' | 'map_select'; choice: string; playerId: string; at: number;
  } | null = null;

  constructor(code: string, seed: number, config?: RoomConfig) {
    this.code = code;
    this.seed = seed;
    this.lobby = new Lobby({ carCount: config?.carCount ?? 0, maps: config?.maps ?? [] });
    this.carNames = config?.carNames ?? [];
  }

  /** Friendly display name for a car index (for voice/announcer callouts), or a generic fallback. */
  carName(index: number): string {
    return this.carNames[index] ?? `car ${index + 1}`;
  }

  /** Late-bind the selectable cars/maps once the server has loaded the manifest + map list. */
  configure(config: RoomConfig): void {
    if (config.carNames) this.carNames = config.carNames;
    // Rebuild the lobby with the real choices, preserving the current roster.
    const roster = this.lobby.players();
    this.lobby = new Lobby(config);
    for (const p of roster) this.lobby.addPlayer(p.id, p.name, p.color);
  }

  get phase(): Phase { return this._phase; }
  get playerCount(): number { return this.lobby.playerCount + this.nextRoundPlayers.size; }
  get isEmpty(): boolean { return this.playerCount === 0; }
  get selectedMap(): string | null { return this.raceMap ?? this.lobby.selectedMap; }
  get mapChoices(): string[] { return this.lobby.mapChoices; }
  get usesStationSetup():boolean{return this.stationManaged;}
  private get requiredHumanPlayers():number { return Math.max(this.expectedHumanPlayers,Math.min(2,this.lobby.playerCount)); }
  canControlSetup(playerId: string): boolean {
    return this.lobby.players().some(player=>player.id===playerId);
  }
  isWaitingForNextRound(playerId: string): boolean { return this.nextRoundPlayers.has(playerId); }
  hasMapVote(playerId:string):boolean { return this.lobby.hasPlayerVoted(playerId); }
  canSelectCar(playerId:string,allowRevision=false):boolean {
    if(!this.stationManaged)return this.lobby.players().some(player=>player.id===playerId);
    if(allowRevision&&this.lobby.players().some(player=>player.id===playerId&&player.carIndex!==null))return true;
    return this.lobby.players().find(player=>player.carIndex===null)?.id===playerId;
  }
  canSelectMap(playerId:string,allowRevision=false):boolean {
    if(!this.stationManaged)return this.lobby.players().some(player=>player.id===playerId);
    if(allowRevision&&this.lobby.hasPlayerVoted(playerId))return true;
    return this.lobby.players().find(player=>!this.lobby.hasPlayerVoted(player.id))?.id===playerId;
  }
  /** The only caller seat a shared-screen selection currently represents. A station display
   * stops accepting selection taps once everyone has chosen; callers can still revise by voice. */
  touchSelectionTarget(): string | null {
    const players = this.lobby.players();
    if (this._phase === 'car_select')
      return players.find(player => player.carIndex === null)?.id
        ?? (this.stationManaged ? null : players[0]?.id ?? null);
    if (this._phase === 'map_select')
      return players.find(player => !this.lobby.hasPlayerVoted(player.id))?.id
        ?? (this.stationManaged ? null : players[0]?.id ?? null);
    return null;
  }
  get allCarChoicesComplete():boolean { return this.lobby.playerCount >= this.expectedHumanPlayers && this.lobby.allPicked(); }
  get allMapVotesComplete():boolean { return this.lobby.playerCount >= this.expectedHumanPlayers && this.lobby.allPlayersVoted(); }

  /** True while the room is in a pre-race selection phase (lobby/car_select/map_select). */
  private get inPreRace(): boolean {
    return this._phase === 'lobby' || this._phase === 'car_select' || this._phase === 'map_select';
  }

  /** Roster for the shared-display lobby + selection screens (includes car/ready state). */
  lobbyPlayers(): LobbyPlayer[] {
    // Lane is assigned by join order (mod LANES) for the sim; surface it for color/positioning.
    return this.lobby.players().map((p, i) => ({
      playerId: p.id, name: p.name, color: p.color, lane: i % LANES,
      carIndex: p.carIndex, ready: p.ready,
    }));
  }

  addPlayer(name: string, color?: string, preferredIndex?: number, nameConfirmed = true): { playerId: string; lane: number } | { error: string } {
    // A fresh caller must not erase the previous group's results, even if the room is full.
    if (this.playerCount >= MAX_PLAYERS) return { error: 'room_full' };
    if (this.stationManaged && (this._phase === 'finished' || this._phase === 'results')) return { error: 'room_full' };
    const stationIndex = preferredIndex === 0 || preferredIndex === 1 ? preferredIndex : undefined;
    if (stationIndex !== undefined && this.stationSlots.has(stationIndex)) return { error: 'room_full' };
    const lane = stationIndex ?? (this.lobby.playerCount % LANES);
    const id = `p${this.nextId++}`;
    const palette = COLORS[(stationIndex ?? this.lobby.playerCount) % COLORS.length]!;
    const color2 = safeColor(color, palette);   // reject unsafe colors (stored-XSS guard)
    if (this._phase === 'finished' || this._phase === 'results') {
      this.nextRoundPlayers.set(id, { name, color: color2 });
      if (nameConfirmed) this.confirmedPlayerNames.add(id);
      return { playerId: id, lane };
    }
    this.lobby.addPlayer(id, name, color2, stationIndex);
    if (nameConfirmed) this.confirmedPlayerNames.add(id);
    if (stationIndex !== undefined) this.stationSlots.set(stationIndex, id);
    // If a race is already running, slot this player into the live world so they get a car.
    if (this.world && (this._phase === 'countdown' || this._phase === 'racing')) {
      this.world.addCar({ id, name, color: color2 }, stationIndex);
    }
    return { playerId: id, lane };
  }

  removePlayer(playerId: string): void {
    if (this.nextRoundPlayers.delete(playerId)) {
      this.confirmedPlayerNames.delete(playerId);
      return;
    }
    this.lobby.removePlayer(playerId);
    this.confirmedPlayerNames.delete(playerId);
    for (const [index, id] of this.stationSlots) if (id === playerId) this.stationSlots.delete(index);
    if (this.recentSetupChoice?.playerId === playerId) this.recentSetupChoice = null;
    this.world?.removeCar(playerId);
    if (!this.stationManaged && this.lobby.playerCount > 0) this.expectedHumanPlayers = this.lobby.playerCount;
    // Keep the completed scoreboard on a connected display after the final caller hangs up.
    // The display or the next caller can then start a fresh round without losing the result.
    // A room with no display is still reaped by GameServer when its last caller leaves.
    if (this.lobby.playerCount === 0 && this._phase !== 'lobby'
      && this._phase !== 'results' && this._phase !== 'finished') this.reset();
    else this.lobby.retainMapVotes(new Set(this.lobby.players().map(player=>player.id)));
  }

  expectHumanPlayers(count:number,stationManaged=true):void {
    this.expectedHumanPlayers = count >= 2 ? 2 : 1;
    if(stationManaged){
      this.stationManaged=true;
      this.lobby.retainMapVotes(new Set(this.lobby.players().map(player=>player.id)));
    }
  }

  /** Concierge / client can fill in a player's display name + color after a bare join. */
  setPlayerInfo(playerId: string, info: { name?: string; color?: string }): void {
    const clean = { ...info, ...(info.color !== undefined ? { color: safeColor(info.color, '#36d1dc') } : {}) };
    const waiting = this.nextRoundPlayers.get(playerId);
    if (waiting) {
      if (info.name !== undefined) waiting.name = info.name;
      if (info.color !== undefined) waiting.color = clean.color!;
      if (info.name?.trim()) this.confirmedPlayerNames.add(playerId);
      return;
    }
    this.lobby.setPlayerInfo(playerId, clean);
    if (info.name?.trim()) this.confirmedPlayerNames.add(playerId);
  }
  hasConfirmedName(playerId: string): boolean { return this.confirmedPlayerNames.has(playerId); }
  private allNamesConfirmed(): boolean {
    const players = this.lobby.players();
    return players.length > 0 && players.every(player => this.confirmedPlayerNames.has(player.id));
  }

  anonymizePlayer(playerId: string): void {
    this.lobby.setPlayerInfo(playerId, { name: 'PLAYER' });
    this.lastResults = this.lastResults.map(result => (
      result.playerId === playerId ? { ...result, name: 'PLAYER' } : result
    ));
  }

  // ── Pre-race flow (delegates to Lobby) ─────────────────────────────────────────────────────────
  selectCar(playerId:string,carIndex:number,allowRevision=false):boolean {
    if(!this.canSelectCar(playerId,allowRevision))return false;
    if(!allowRevision&&this.isSetupCrosstalk('car_select',String(carIndex),playerId))return false;
    const selected=this.lobby.selectCar(playerId,carIndex);
    if(selected)this.rememberSetupChoice('car_select',String(carIndex),playerId);
    return selected;
  }
  /** Cast a map VOTE. voterId = the player casting it (so each player's vote is one; changing it
   *  replaces the prior). The winning map (selectedMap) is the vote leader, ties broken deterministically. */
  selectMap(map:string,voterId?:string,allowRevision=false):boolean {
    if(this.stationManaged&&(!voterId||!this.lobby.players().some(player=>player.id===voterId)))return false;
    if(voterId&&!this.canSelectMap(voterId,allowRevision))return false;
    if(voterId&&!allowRevision&&this.isSetupCrosstalk('map_select',map,voterId))return false;
    const selected=this.lobby.selectMap(map,voterId);
    if(selected&&voterId)this.rememberSetupChoice('map_select',map,voterId);
    return selected;
  }
  /** Live map-vote tallies + tie flag, for the selection-screen UI. */
  mapVotes(): { counts: Record<string, number>; tie: boolean } {
    return { counts: this.lobby.mapVoteCounts(), tie: this.lobby.mapWinnerIsTie };
  }

  /** Host advances the flow. lobby→car_select→map_select, then map_select→start the race.
   *  From a finished race (results/finished), "advance" means PLAY AGAIN: keep the roster, clear
   *  their picks, and jump straight to car-select so they just re-choose. */
  canAdvance(playerId?:string): boolean {
    const showingResults=this._phase==='results'||this._phase==='finished';
    // A caller who arrived during results cannot erase the current players' standings. Once those
    // players all leave, that waiting caller may start their own round by voice.
    const nextRoundCaller=showingResults&&!this.stationManaged&&this.lobby.playerCount===0
      &&Boolean(playerId&&this.nextRoundPlayers.has(playerId));
    if(playerId&&!this.canControlSetup(playerId)&&!nextRoundCaller)return false;
    if(this.stationManaged&&(!playerId||!this.canControlSetup(playerId)))return false;
    if(showingResults)return this.lobby.playerCount>0||this.nextRoundPlayers.size>0;
    if(this.stationManaged&&this.lobby.playerCount<this.expectedHumanPlayers)return false;
    if(this._phase==='lobby')return this.lobby.playerCount>0&&this.allNamesConfirmed();
    if(this._phase==='car_select')return this.lobby.anyPicked()
      &&(!this.stationManaged||this.lobby.allPicked())
      &&(this.requiredHumanPlayers<2
        ||(this.lobby.playerCount>=this.requiredHumanPlayers&&this.lobby.allPicked()));
    if(this._phase==='map_select')return this.lobby.canStart()
      &&(!this.stationManaged||this.lobby.allPlayersVoted())
      &&(this.requiredHumanPlayers<2||this.lobby.allPlayersVoted());
    return false;
  }
  advance(playerId?: string): boolean {
    const before = this._phase;
    if(!this.canAdvance(playerId))return false;
    if (this._phase === 'results' || this._phase === 'finished') {
      this.world = null; this.lastResults = []; this.raceMap = null;
      this.lobby.reset();           // back to lobby with cleared cars/map, same players
      const hadWaitingPlayers = this.nextRoundPlayers.size > 0;
      this.admitNextRoundPlayers();
      if (!hadWaitingPlayers && this.allNamesConfirmed()) this.lobby.advance(); // → car_select
      this._phase = this.lobby.phase;
      this.recentSetupChoice=null;
      return this._phase!==before;
    }
    if (this._phase === 'map_select' && this.lobby.canStart()) { this.start(); return this._phase!==before; }
    if (this.inPreRace) { this.lobby.advance(); this._phase = this.lobby.phase; }
    if(this._phase!==before)this.recentSetupChoice=null;
    return this._phase!==before;
  }

  /** Host steps back one selection phase (no-op once racing). */
  back(): void {
    if(this.stationManaged)return;
    if (this.inPreRace) { this.lobby.back(); this._phase = this.lobby.phase; }
  }

  reset(): void {
    this.world = null;
    this.lobby.reset();
    this.admitNextRoundPlayers();
    this.lastResults = [];
    this.raceMap = null;
    this._phase = 'lobby';
    this.recentSetupChoice = null;
  }

  private admitNextRoundPlayers(): void {
    for (const [id, player] of this.nextRoundPlayers) this.lobby.addPlayer(id, player.name, player.color);
    this.nextRoundPlayers.clear();
  }

  start(): boolean {
    // Lobby onboarding confirms names before its first advance. A later caller may join while
    // choices are already on screen, and their generated display name must not rewind the menu or
    // block a race after everyone has picked. They can still introduce themselves explicitly.
    if (this.lobby.playerCount < this.requiredHumanPlayers
      || (this._phase === 'lobby' && !this.allNamesConfirmed())) return false;
    // Evolve the seed each start so every race gets a NEW (deterministic-per-race) course.
    this.seed = (Math.imul(this.seed ^ (this.seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    this.raceMap = this.lobby.selectedMap;
    this.world = new RaceWorld(this.lobby.toRaceInits(), this.seed);
    this._phase = this.world.phase;
    return true;
  }

  applyIntent(playerId: string, intent: Intent): boolean {
    return this.world?.applyIntent(playerId, intent) ?? false;
  }

  tick(dt: number): void {
    if (!this.world) return;
    this.world.step(dt);
    const wp = this.world.phase;
    // When the race finishes, capture standings and move to the results screen (held until reset).
    if (wp === 'finished' && this._phase === 'racing') {
      this.lastResults = this.captureResults();
      this._phase = 'results';
    } else if (this._phase === 'racing' || this._phase === 'countdown') {
      this._phase = wp;
    }
  }

  /** Final standings from the finished world (placement order). */
  private captureResults(): RaceResult[] {
    const snap = this.world?.snapshot();
    if (!snap) return [];
    return [...snap.cars]
      .sort((a, b) => a.place - b.place)
      .map(c => ({ playerId: c.id, name: c.name, carIndex: c.carIndex,
        place: c.place, finishT: c.finishT, finished: c.finished }));
  }

  results(): RaceResult[] { return this.lastResults; }

  snapshot(): WorldSnapshot | null { return this.world ? this.world.snapshot() : null; }
  drainEvents(): GameEvent[] { return this.world ? this.world.drainEvents() : []; }
  private isSetupCrosstalk(
    phase:'car_select'|'map_select',choice:string,playerId:string,
  ):boolean {
    const recent=this.recentSetupChoice;
    return Boolean(this.stationManaged&&recent&&recent.phase===phase&&recent.choice===choice
      &&recent.playerId!==playerId&&Date.now()-recent.at<SETUP_CROSSTALK_MS);
  }

  private rememberSetupChoice(
    phase:'car_select'|'map_select',choice:string,playerId:string,
  ):void {
    if(this.stationManaged)this.recentSetupChoice={phase,choice,playerId,at:Date.now()};
  }
}
