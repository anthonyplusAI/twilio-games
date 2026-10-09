// Server-side game room for Voice Monsters: lobby → monster_select → battle → results. Wraps the pure
// BattleWorld and owns joining, per-player monster picks, single-player (1 human vs AI) vs 2-player,
// and the AI's auto-responses. Mirrors Room's public shape so the GameServer wiring is familiar. No
// ws/http here — fully unit-testable.
import { BattleWorld, type BattleSnapshot, type BattleEvent, type Side, type BattleAction } from '../shared/battle-world';
import { ROSTER, monsterById, type Monster } from '../shared/monster-roster';
import { pickAiAction } from '../shared/battle-ai';
import { Rng } from '../shared/rng';
import { dwellForEvent, HANDOFF_PAUSE_MS } from '../shared/battle-timing';

export type BattlePhase = 'lobby' | 'monster_select' | 'battle' | 'results';

interface Slot { id: string; name: string; nameConfirmed: boolean; monsterId: string | null; setupReady: boolean; isAi: boolean; side: Side; }
type BattleMenuPhase = 'lobby' | 'monster_select' | 'results';
interface VoiceMenuSpeech { phase: BattleMenuPhase; generation: number; latestCue: number; pending: number; delivered: boolean; }

/** Roster row for the lobby / monster-select screens. */
export interface BattlePlayer { playerId: string; side: Side; name: string; nameConfirmed: boolean; monsterId: string | null; setupReady: boolean; phonePending: boolean; isAi: boolean; }

export interface BattleResult { winner: Side; winnerName: string; }

const AI_ID = 'cpu';
const AI_NAME = 'Rival';

export class BattleRoom {
  readonly code: string;
  private seed: number;
  private _phase: BattlePhase = 'lobby';
  private slots: Slot[] = [];       // human players (max 2)
  private nextId = 1;
  private world: BattleWorld | null = null;
  private ai: { side: Side; monster: Monster } | null = null;   // set in single-player battles
  private _result: BattleResult | null = null;
  private events: BattleEvent[] = [];
  private aiRng: Rng;
  private menu: Record<Side, 'root' | 'fight'> = { a: 'root', b: 'root' };
  private active: Side | null = null;
  private battleGeneration = 0;
  private resultsReadyAt = 0;
  private _resultsPresented = false;
  private presentationReadyAt = 0;
  private lastPresentedActionSide: Side | null = null;
  private expectedHumanPlayers = 1;
  private automaticSetup=false;
  private fixedExpectedHumanPlayers=false;
  private displayConfiguredPlayers: 1 | 2 | null = null;
  private voiceMenus = new Map<string, VoiceMenuSpeech>();

  constructor(code: string, seed: number) {
    this.code = code;
    this.seed = seed >>> 0;
    this.aiRng = new Rng(this.seed ^ 0x5bd1e995);
  }

  get phase(): BattlePhase { return this._phase; }
  get playerCount(): number { return this.slots.length; }
  get expectedPlayerCount(): number { return this.expectedHumanPlayers; }
  get requiresIndividualSetupReady(): boolean { return this.requiresIndividualReadiness(); }
  get requiresIndividualRematchReady(): boolean { return this.requiresBothRematchVotes(); }
  /** The display cannot accept a replay for either caller of a finished human duel, even if one leaves. */
  get requiresCallerRematchControl(): boolean {
    return this._phase === 'results' && (this.requiresBothRematchVotes()
      || Boolean(this.world && this.world.snapshot().b.id !== AI_ID));
  }
  get isEmpty(): boolean { return this.slots.length === 0; }
  get generation(): number { return this.battleGeneration; }
  get resultsPresented():boolean{return this._phase==='results'&&this._resultsPresented;}
  get resultsPresentationTimedOut():boolean{return this._phase==='results'&&!this._resultsPresented
    &&this.resultsReadyAt>0&&Date.now()>=this.resultsReadyAt;}
  get canRematch(): boolean { return this._phase === 'results' && (this._resultsPresented || Date.now() >= this.resultsReadyAt); }
  get rematchReadyInMs(): number { return this._phase === 'results'&&!this._resultsPresented ? Math.max(0, this.resultsReadyAt - Date.now()) : 0; }
  isFinishedBattleParticipant(playerId:string):boolean{
    return this._phase==='results'&&this.slots.some(slot=>slot.id===playerId)
      &&this.isBattleParticipant(playerId);
  }
  /** Both current callers can consent to replay. A lone late caller can also take over
   * after the finished battle's original participants have left. */
  canStartNextRound(playerId:string):boolean{
    if(this._phase!=='results'||!this.canRematch||!this.slots.some(slot=>slot.id===playerId))return false;
    return this.requiresBothRematchVotes() || this.isBattleParticipant(playerId)
      || !this.slots.some(slot=>this.isBattleParticipant(slot.id));
  }
  acknowledgeResultsPresented(generation:number):boolean{
    if(this._phase!=='results'||!this._result||generation!==this.battleGeneration||this._resultsPresented)return false;
    this._resultsPresented=true;return true;
  }
  invalidateResultsPresentation():boolean{
    if(!this._resultsPresented)return false;
    this._resultsPresented=false;return true;
  }
  get canAdvanceLobby(): boolean {
    return this._phase === 'lobby' && this.slots.length >= this.expectedHumanPlayers
      && this.slots.every(slot => slot.nameConfirmed);
  }

  /** Roster for the shared-display lobby + monster-select screens. */
  lobbyPlayers(): BattlePlayer[] {
    return this.slots.map(s => ({ playerId: s.id, side: s.side, name: s.name, nameConfirmed: s.nameConfirmed,
      monsterId: s.monsterId, setupReady: s.setupReady, phonePending: this.isPhonePending(s.id), isAi: s.isAi }));
  }

  /** Each voice cue is bound to the caller and current menu; a superseded cue cannot release it. */
  beginVoiceMenuSpeech(playerId: string, phase: BattleMenuPhase): ((delivered: boolean) => void) | null {
    if (this._phase !== phase || !this.slots.some(slot => slot.id === playerId)) return null;
    let menu = this.voiceMenus.get(playerId);
    if (!menu || menu.phase !== phase) {
      menu = { phase, generation: (menu?.generation ?? 0) + 1, latestCue: 0, pending: 0, delivered: false };
      this.voiceMenus.set(playerId, menu);
    }
    menu.pending++;
    menu.latestCue++;
    menu.delivered = false;
    const cue = menu.latestCue;
    const generation = menu.generation;
    let settled = false;
    return delivered => {
      if (settled) return;
      settled = true;
      if (this.voiceMenus.get(playerId) !== menu || menu.generation !== generation
        || this._phase !== phase || !this.slots.some(slot => slot.id === playerId)) return;
      menu.pending = Math.max(0, menu.pending - 1);
      if (cue === menu.latestCue) menu.delivered = delivered;
      this.progressReadyMenu();
    };
  }

  private isPhonePending(playerId: string): boolean {
    const menu = this.voiceMenus.get(playerId);
    return Boolean(menu && menu.phase === this._phase && (menu.pending > 0 || !menu.delivered));
  }

  private voiceMenuReady(playerId: string): boolean { return !this.isPhonePending(playerId); }

  isSetupReady(playerId: string): boolean {
    return (this._phase === 'lobby' || this._phase === 'monster_select' || this._phase === 'results')
      && this.slots.find(slot => slot.id === playerId)?.setupReady === true;
  }

  /** A caller who lost their phone session must confirm the current shared menu again on return. */
  clearSetupReady(playerId: string): boolean {
    const slot = this.slots.find(candidate => candidate.id === playerId);
    if (!slot || (this._phase !== 'lobby' && this._phase !== 'monster_select'
      && this._phase !== 'results')) return false;
    const wasReady = slot.setupReady;
    slot.setupReady = false;
    const menu = this.voiceMenus.get(playerId);
    if (menu) {
      menu.generation++;
      menu.pending = 0;
      menu.delivered = false;
    }
    return wasReady || Boolean(menu);
  }

  participantResults(): Array<{
    enginePlayerId: string;
    rank: number | null;
    completed: boolean;
    won: boolean | null;
    score: number | null;
    durationSeconds: number | null;
  }> {
    if (this._phase !== 'results' || !this._result) return [];
    const battleIds = new Set([this.world?.snapshot().a.id, this.world?.snapshot().b.id]);
    return this.slots.filter(slot => battleIds.has(slot.id)).map(slot => ({
      enginePlayerId: slot.id,
      rank: slot.side === this._result!.winner ? 1 : 2,
      completed: true,
      won: slot.side === this._result!.winner,
      score: null,
      durationSeconds: null,
    }));
  }

  /** Add a human player. Battles are 1v1, so at most 2 humans. A late second player may join while
   *  results remain visible, but the finished battle stays intact until an explicit rematch. */
  addPlayer(name: string, preferredSide?: Side, nameConfirmed = true): { playerId: string } | { error: string } {
    // Keep the final screen after the last caller leaves. A new standalone caller explicitly begins
    // the next session; a late station caller must not erase the previous match's result.
    if (this._phase === 'results' && this.slots.length === 0) {
      if (this.fixedExpectedHumanPlayers && this.displayConfiguredPlayers === null) return { error: 'round_complete' };
      this.reset();
      // The prior duel may have required two callers and player-bound station-style setup.
      // A new standalone caller starts with the same solo policy as a fresh room.
      this.expectedHumanPlayers = this.displayConfiguredPlayers ?? 1;
      this.automaticSetup = this.displayConfiguredPlayers !== null;
      this.fixedExpectedHumanPlayers = this.displayConfiguredPlayers !== null;
    }
    if (this.displayConfiguredPlayers === 1 && this.slots.length >= 1) return { error: 'room_full' };
    if (this._phase === 'results' && this.slots.length >= 2) return { error: 'room_full' };
    if (this._phase === 'battle' && this.slots.length >= 2) return { error: 'battle_in_progress' };
    if (this.slots.length >= 2) return { error: 'room_full' };
    const side = preferredSide ?? (this.slots.some(slot => slot.side === 'a') ? 'b' : 'a');
    if (this.slots.some(slot => slot.side === side)) return { error: 'room_full' };
    const id = `p${this.nextId++}`;
    this.slots.push({ id, name: name || `Player ${this.slots.length + 1}`, nameConfirmed,
      monsterId: null, setupReady: false, isAi: false, side });
    this.slots.sort((left, right) => left.side.localeCompare(right.side));
    return { playerId: id };
  }

  expectHumanPlayers(count: number, fixed = true): void {
    this.expectedHumanPlayers = count >= 2 ? 2 : 1;
    if (fixed) this.fixedExpectedHumanPlayers = true;
    this.automaticSetup=true;
    if (this.expectedHumanPlayers === 1 && this.slots.length === 1 && this._phase !== 'battle') {
      this.slots[0]!.side = 'a';
    }
  }

  /** A standalone shared display can make its first choice while callers are still in the lobby.
   *  This closes the ordering gap where a phone or keyboard socket joins before the display socket. */
  configureDisplayPlayers(count: 1 | 2): boolean {
    if (this.displayConfiguredPlayers === count) return true;
    if (this._phase === 'battle') return false;
    if (this.slots.length > 0 && (this.displayConfiguredPlayers !== null || this._phase !== 'lobby'
      || this.slots.length > count || this.expectedHumanPlayers > count)) return false;
    this.displayConfiguredPlayers = count;
    this.expectedHumanPlayers = count;
    this.automaticSetup = true;
    this.fixedExpectedHumanPlayers = true;
    return true;
  }
  playerSide(playerId: string): Side | null { return this.slots.find(slot => slot.id === playerId)?.side ?? null; }
  canControlSetup(playerId: string): boolean {
    return this.playerSide(playerId)!==null;
  }

  removePlayer(playerId: string): void {
    const previousCount = this.slots.length;
    const wasInBattle = this.isBattleParticipant(playerId);
    this.slots = this.slots.filter(s => s.id !== playerId);
    if (this.slots.length === previousCount) return;
    this.voiceMenus.delete(playerId);
    this.clearAllSetupReady();
    if (this.slots.length === 0) {
      if (this._phase !== 'results') {
        this.reset();
        this.automaticSetup = this.displayConfiguredPlayers !== null;
        this.expectedHumanPlayers = this.displayConfiguredPlayers ?? 1;
        this.fixedExpectedHumanPlayers = this.displayConfiguredPlayers !== null;
      }
    }
    else {
      if (!this.fixedExpectedHumanPlayers) this.expectedHumanPlayers = this.slots.length;
      if (wasInBattle && this._phase === 'battle') {
        this.interruptBattle();
        if (this.automaticSetup && !this.fixedExpectedHumanPlayers) for (const slot of this.slots) slot.monsterId = null;
      }
    }
  }

  setPlayerInfo(playerId: string, info: { name?: string }): void {
    const s = this.slots.find(x => x.id === playerId);
    if (s && info.name) {
      const name = info.name.slice(0, 20);
      if (name !== s.name || !s.nameConfirmed) s.setupReady = false;
      s.name = name; s.nameConfirmed = true;
    }
  }
  hasConfirmedName(playerId: string): boolean { return this.slots.find(slot => slot.id === playerId)?.nameConfirmed === true; }

  anonymizePlayer(playerId: string): void {
    const index = this.slots.findIndex(slot => slot.id === playerId);
    if (index < 0) return;
    this.slots[index]!.name = 'PLAYER';
    if (this._result?.winner === (index === 0 ? 'a' : 'b')) {
      this._result = { ...this._result, winnerName: 'PLAYER' };
    }
  }

  /** Pick a monster during monster_select (validated against the roster). */
  selectMonster(playerId: string, monsterId: string): boolean {
    if (this._phase !== 'monster_select') return false;
    if (!monsterById(monsterId)) return false;
    const s = this.slots.find(x => x.id === playerId);
    if (!s) return false;
    if (this.requiresIndividualReadiness() && !s.nameConfirmed) return false;
    if (s.monsterId !== monsterId) s.setupReady = false;
    s.monsterId=monsterId;
    return true;
  }

  /** Host advances the flow: lobby → monster_select → battle. From results, "advance" = rematch
   *  (keep the roster, back to monster_select). Starting the battle fills an AI opponent when solo. */
  advance(playerId?: string): boolean {
    if (this._phase === 'results') {
      if (!this.slots.length || !this.canRematch || (playerId && !this.canStartNextRound(playerId))) return false;
      if (this.requiresCallerRematchControl) {
        const slot = this.slots.find(candidate => candidate.id === playerId);
        if (!slot) return false;
        slot.setupReady = true;
        this.progressReadyMenu();
        return true;
      }
      this.startRematch();
      return true;
    }
    if(this.automaticSetup&&(!playerId||!this.canControlSetup(playerId)))return false;
    if (this._phase === 'lobby') {
      if (this.requiresIndividualReadiness()) {
        const slot = this.slots.find(candidate => candidate.id === playerId);
        if (!slot?.nameConfirmed) return false;
        slot.setupReady = true;
        this.progressReadyMenu();
        return true;
      } else if (!this.canAdvanceLobby) {
        return false;
      }
      this.clearAllSetupReady();
      this._phase = 'monster_select';return true;
    }
    if (this._phase === 'monster_select') {
      if (this.requiresIndividualReadiness()) {
        const slot = this.slots.find(candidate => candidate.id === playerId);
        if (!slot?.nameConfirmed || !slot.monsterId) return false;
        slot.setupReady = true;
        this.progressReadyMenu();
        return true;
      } else if (!this.canStart()) {
        return false;
      }
      this.start();return true;
    }
    return false;
  }

  back(playerId?:string): boolean {
    if(this.automaticSetup&&(!playerId||!this.canControlSetup(playerId)))return false;
    if (this._phase === 'monster_select') {
      if (this.requiresIndividualReadiness()) {
        const slot = this.slots.find(candidate => candidate.id === playerId);
        if (!slot || (!slot.monsterId && !slot.setupReady)) return false;
        slot.monsterId = null; slot.setupReady = false;
        return true;
      }
      this.clearAllSetupReady(); this._phase = 'lobby'; return true;
    }
    return false;
  }

  private requiresIndividualReadiness(): boolean {
    return this.automaticSetup && this.expectedHumanPlayers >= 2;
  }

  private requiresBothRematchVotes(): boolean {
    return this._phase === 'results' && this.slots.length === 2;
  }

  private progressReadyMenu(): boolean {
    if (this._phase === 'lobby' && this.requiresIndividualReadiness() && this.canAdvanceLobby
      && this.slots.every(slot => slot.setupReady && this.voiceMenuReady(slot.id))) {
      this.clearAllSetupReady();
      this._phase = 'monster_select';
      return true;
    }
    if (this._phase === 'monster_select' && this.requiresIndividualReadiness() && this.canStart()
      && this.slots.every(slot => slot.setupReady && this.voiceMenuReady(slot.id))) {
      this.start();
      return true;
    }
    if (this._phase === 'results' && this.requiresCallerRematchControl && this.canRematch
      && this.slots.length > 0
      && this.slots.every(slot => slot.setupReady && this.voiceMenuReady(slot.id))) {
      this.startRematch();
      return true;
    }
    return false;
  }

  private startRematch(): void {
    this.world = null; this.ai = null; this._result = null;
    this.resultsReadyAt = 0;
    this._resultsPresented = false;
    this.presentationReadyAt = 0;
    this.lastPresentedActionSide = null;
    for (const slot of this.slots) { slot.monsterId = null; slot.setupReady = false; }
    this._phase = this.slots.every(slot => slot.nameConfirmed) ? 'monster_select' : 'lobby';
  }

  private clearAllSetupReady(): void {
    for (const slot of this.slots) slot.setupReady = false;
  }

  /** Ready to battle when at least one human has picked a monster (the 2nd side is the other human
   *  if present + picked, else an AI). */
  canStart(): boolean {
    if (this._phase !== 'monster_select') return false;
    if (this.slots.length < this.expectedHumanPlayers) return false;
    const picked = this.slots.filter(s => s.monsterId);
    if (this.slots.length >= 2) return this.slots.every(s => s.nameConfirmed && s.monsterId); // 2P: both named + picked
    return picked.length === 1;                                              // 1P: the human picked
  }

  private start(): void {
    this.clearAllSetupReady();
    const humans = this.slots.filter(s => s.monsterId);
    const a = humans.find(slot => slot.side === 'a') ?? humans[0]!;
    let bId: string, bName: string, bMonster: string;
    if (this.slots.length >= 2) {
      const b = humans.find(slot => slot.side === 'b') ?? this.slots.find(s => s.id !== a.id)!;
      bId = b.id; bName = b.name; bMonster = b.monsterId!;
    } else {
      // Single-player: AI opponent gets a random DIFFERENT monster.
      bId = AI_ID; bName = AI_NAME; bMonster = this.pickAiMonster(a.monsterId!);
      this.ai = { side: 'b', monster: monsterById(bMonster)! };
    }
    this.world = new BattleWorld(
      { id: a.id, name: a.name, monsterId: a.monsterId! },
      { id: bId, name: bName, monsterId: bMonster },
      this.seed,
    );
    this.menu = { a: 'root', b: 'root' };
    // A solo caller always opens. Two humans alternate the seeded opener on rematches.
    this.active = this.ai ? 'a' : ((this.seed ^ this.battleGeneration) & 1) === 0 ? 'a' : 'b';
    this.battleGeneration++;
    this.resultsReadyAt = 0;
    this._resultsPresented = false;
    this.presentationReadyAt = 0;
    this.lastPresentedActionSide = null;
    this._phase = 'battle';
    this.captureEvents();
  }

  private pickAiMonster(avoid: string): string {
    const pool = ROSTER.filter(m => m.id !== avoid);
    return pool[this.aiRng.int(pool.length)]!.id;
  }

  /** A player chooses a move. The active monster's action resolves immediately, then the room advances
   *  to the other side so the next phone prompt/screen menu is unambiguous. */
  chooseMove(playerId: string, moveId: string): boolean {
    if (this._phase !== 'battle' || !this.world) return false;
    if (!this.canChoose(playerId)) return false;
    if (!this.world.takeAction(playerId, { kind: 'fight', moveId })) return false;
    this.resetMenuFor(playerId);
    this.captureEvents();
    this.advanceActiveSide();
    return true;
  }

  /** A player commits a turn ACTION (fight/guard/item/taunt). Same resolution rules as chooseMove. */
  chooseAction(playerId: string, action: BattleAction): boolean {
    if (this._phase !== 'battle' || !this.world) return false;
    if (!this.canChoose(playerId)) return false;
    if (!this.world.takeAction(playerId, action)) return false;
    this.resetMenuFor(playerId);
    this.captureEvents();
    this.advanceActiveSide();
    return true;
  }

  /** The side whose command we are currently waiting for. In 2P this makes the phone UX sequential:
   *  side A opens the turn, then side B responds, alternating who starts each new turn. In single-player
   *  the human always opens the battle so the deferred AI beat can answer after the human acts. */
  activeSide(): Side | null {
    if (this._phase !== 'battle' || !this.world) return null;
    const s = this.world.snapshot();
    if (s.phase !== 'choosing') return null;
    return this.active;
  }

  activeMenu(): 'root' | 'fight' {
    const side = this.activeSide();
    return side ? this.menu[side] : 'root';
  }

  openFightMenu(playerId: string): boolean {
    const side = this.sideOfPlayer(playerId);
    if (side && this.activeSide() === side) { this.menu[side] = 'fight'; return true; }
    return false;
  }

  backMenu(playerId: string): boolean {
    const side = this.sideOfPlayer(playerId);
    if (side && this.activeSide() === side) { this.menu[side] = 'root'; return true; }
    return false;
  }

  /** True when it's single-player, we're mid-battle, and the active side is the AI. The server polls
   *  this after a human action to schedule the deferred AI beat. */
  aiPending(): boolean {
    if (!this.ai || this._phase !== 'battle' || !this.world) return false;
    if (this.world.phase !== 'choosing') return false;
    const s = this.world.snapshot();
    return this.activeSide() === this.ai.side;
  }

  /** Commit the AI's ACTION (type-aware: mostly FIGHT, but ITEM/GUARD/TAUNT when the situation calls
   *  for it) → resolves the turn. Called by the server after a short delay so the CPU takes a visible,
   *  separate turn. No-op if the AI doesn't owe a move. */
  resolveAiTurn(): void {
    if (!this.aiPending() || !this.ai || !this.world) return;
    const s = this.world.snapshot();
    const self = this.ai.side === 'b' ? s.b : s.a;         // the AI's own live state (hp / potions)
    const oppState = this.ai.side === 'b' ? s.a : s.b;
    const potionsLeft = this.ai.side === 'b' ? s.potions.b : s.potions.a;
    const action = pickAiAction(
      this.ai.monster, self.hp, self.maxHp,
      monsterById(oppState.monsterId)!, potionsLeft, this.aiRng,
    );
    this.world.takeAction(self.id, action);
    this.menu = { a: 'root', b: 'root' };
    this.captureEvents();
    this.advanceActiveSide();
  }

  /** Pull resolution events out of the world into the room's queue + detect battle end. */
  private captureEvents(): void {
    if (!this.world) return;
    const fresh = this.world.drainEvents();
    this.events.push(...fresh);
    if (fresh.length) {
      let firstActionSide: Side | null = null;
      let lastActionSide: Side | null = null;
      for (const ev of fresh) {
        const side = sideForActionEvent(ev);
        if (side) { firstActionSide ??= side; lastActionSide = side; }
      }
      const handoff = firstActionSide && this.lastPresentedActionSide && firstActionSide !== this.lastPresentedActionSide
        ? HANDOFF_PAUSE_MS : 0;
      this.presentationReadyAt = Math.max(Date.now(), this.presentationReadyAt)
        + handoff + fresh.reduce((ms, ev) => ms + dwellForEvent(ev), 0);
      if (lastActionSide) this.lastPresentedActionSide = lastActionSide;
    }
    const snap = this.world.snapshot();
    if (this.world.phase === 'finished' && this._phase === 'battle') {
      const winnerSide = snap.winner!;
      const winnerName = winnerSide === 'a' ? snap.a.name : snap.b.name;
      this._result = { winner: winnerSide, winnerName };
      this.active = null;
      this._phase = 'results';
      this.resultsReadyAt = this.presentationReadyAt;
      this._resultsPresented = false;
    }
  }

  reset(): void {
    this.world = null; this.ai = null; this._result = null; this.events = [];
    this.menu = { a: 'root', b: 'root' };
    this.active = null;
    this.resultsReadyAt = 0;
    this._resultsPresented = false;
    this.presentationReadyAt = 0;
    this.lastPresentedActionSide = null;
    for (const s of this.slots) { s.monsterId = null; s.setupReady = false; }
    this._phase = 'lobby';
  }

  snapshot(): BattleSnapshot | null { return this.world ? this.world.snapshot() : null; }
  result(): BattleResult | null { return this._result; }

  /** Drain queued battle events (renderer + commentator consume them; drained once). */
  drainEvents(): BattleEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private sideOfPlayer(playerId: string): Side | null {
    const snap = this.world?.snapshot();
    if (!snap) return null;
    if (snap.a.id === playerId) return 'a';
    if (snap.b.id === playerId) return 'b';
    return null;
  }

  private isBattleParticipant(playerId: string): boolean {
    const snap = this.world?.snapshot();
    return !!snap && (snap.a.id === playerId || snap.b.id === playerId);
  }

  private interruptBattle(): void {
    this.world = null; this.ai = null; this._result = null; this.events = [];
    this.menu = { a: 'root', b: 'root' };
    this.active = null;
    this.resultsReadyAt = 0;
    this._resultsPresented = false;
    this.presentationReadyAt = 0;
    this.lastPresentedActionSide = null;
    this.clearAllSetupReady();
    this._phase = this.slots.length > 0 && this.slots.every(slot => slot.nameConfirmed) ? 'monster_select' : 'lobby';
    // The survivor is back on a fresh setup menu even if it has the same phase name as
    // the pre-battle menu. Old audio receipts must not count as fresh guidance.
    this.voiceMenus.clear();
  }

  private canChoose(playerId: string): boolean {
    const side = this.sideOfPlayer(playerId);
    return !!side && this.activeSide() === side;
  }

  private resetMenuFor(playerId: string): void {
    const side = this.sideOfPlayer(playerId);
    if (side) this.menu[side] = 'root';
  }

  private advanceActiveSide(): void {
    if (this._phase !== 'battle' || !this.world) return;
    const snap = this.world.snapshot();
    if (snap.phase !== 'choosing') { this.active = null; return; }
    this.active = this.active === 'a' ? 'b' : 'a';
    this.menu = { a: 'root', b: 'root' };
  }
}

function sideForActionEvent(ev: BattleEvent): Side | null {
  return ev.kind === 'move_used' || ev.kind === 'guard' || ev.kind === 'item' || ev.kind === 'taunt'
    ? ev.by : null;
}
