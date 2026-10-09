import { applyFighterCommand, createFighterWorld, tickFighterWorld, type FighterCommand, type FighterEvent, type FighterId, type FighterWorld } from '../shared/fighter-world';
import { FIGHTER_MAPS, FIGHTER_ROSTER, type FighterMapEntry } from '../shared/fighter-roster';
import { FIGHTER_INTRO_SECONDS, type FighterLobbyPlayer, type FighterPhase, type FighterState } from '../shared/fighter-protocol';

interface Player { playerId: string; name: string; nameConfirmed: boolean; fighterId: string | null; side: FighterId; }
interface VoiceMenuState {
  connected: boolean;
  phase: FighterPhase;
  pending: number;
  turns: Set<symbol>;
  prompted: boolean;
  /** Failed cues map to the newest replacement that was already queued when they failed. */
  failedCues: Map<number, number>;
  generation: number;
  cueSequence: number;
  latestPlayedCueSequence: number;
}
interface QueuedFighterCommand { command: FighterCommand; queuedAt: number; requestId: string; sequenceId: string | null; }
export interface FighterVoiceCommandOutcome {
  requestId: string;
  command: FighterCommand;
  status: 'executed' | 'queued' | 'rejected';
  reason?: 'not_fighting' | 'not_player' | 'superseded' | 'expired' | 'match_over' | 'player_left';
}

export const FIGHTER_LOADING_TIMEOUT_SECONDS = 150;
export const FIGHTER_VICTORY_SECONDS = 10.5;
export const FIGHTER_RESULTS_PRESENTATION_TIMEOUT_MS=15_000;
export const MAX_VOICE_COMMAND_QUEUE = 2;
export const FIGHTER_VOICE_COMMAND_TTL_SECONDS = 2.25;
const SOLO_AI_FIGHTERS = ['cinder-capone', 'gran-slam', 'iron-oni', 'shroom-boom', 'sir-knockout', 'velvet-thunder', 'nyx'];

export class FighterRoom {
  phase: FighterPhase = 'lobby';
  private players: Player[] = [];
  private world: FighterWorld | null = null;
  private events: FighterEvent[] = [];
  private selectedMap: string | null = null;
  private mapVotes=new Map<string,string>();
  private advanceReady = new Set<string>();
  private backReady = new Set<string>();
  private voiceMenus = new Map<string, VoiceMenuState>();
  private nextPlayer = 1;
  private aiNext = 0;
  private aiFighterId: string | null = null;
  private countdown = 0;
  private intro = 0;
  private loadingElapsed = 0;
  private loadingGeneration = 0;
  private victory = 0;
  private _hudPresented=false;
  private _resultsPresented=false;
  private resultsPresentationDeadline=0;
  private resultPlayers: FighterLobbyPlayer[] | null = null;
  private resultWinnerName: string | null = null;
  private voiceCommands = new Map<string, QueuedFighterCommand[]>();
  private voiceCommandOutcomes: FighterVoiceCommandOutcome[] = [];
  private nextVoiceRequestId = 0;
  private expectedHumanPlayers = 1;
  private automaticSetup=false;
  private fixedExpectedHumanPlayers=false;
  private rng: number;
  private readonly mapTieSeed: number;

  constructor(readonly code: string, seed = 0x12345678, private maps: FighterMapEntry[] = FIGHTER_MAPS,
    private readonly now:()=>number=Date.now) { this.rng = seed >>> 0; this.mapTieSeed = seed >>> 0; }
  setMaps(maps: FighterMapEntry[]): void { if (maps.length) this.maps = maps; }

  addPlayer(name: string, preferredSide?: FighterId, nameConfirmed = true): { playerId: string } | { error: string } {
    // Direct room callers retain the legacy solo reset. The server separately permits
    // a fixed standalone display to start its next group without resetting station results.
    if (!this.fixedExpectedHumanPlayers) this.prepareForNewStandaloneCaller();
    if (this.players.length >= 2
      || (this.fixedExpectedHumanPlayers && this.players.length >= this.expectedHumanPlayers)
      || !['lobby', 'fighter_select'].includes(this.phase)) return { error: 'room_full' };
    const side: FighterId = preferredSide ?? (this.players.some(player => player.side === 'p1') ? 'p2' : 'p1');
    if (this.players.some(player => player.side === side)) return { error: 'room_full' };
    const player = { playerId: `f${this.nextPlayer++}`, name: cleanName(name), nameConfirmed, fighterId: null, side };
    this.players.push(player);this.players.sort((left,right)=>left.side.localeCompare(right.side));
    this.clearSetupVotes();
    return { playerId: player.playerId };
  }
  /** Keep the final screen until the first caller of a fresh standalone group joins. */
  prepareForNewStandaloneCaller(): boolean {
    if ((this.phase !== 'victory' && this.phase !== 'results')
      || this.players.length !== 0 || !this.world?.winner) return false;
    this.resetResultsForNewRound();
    return true;
  }
  expectHumanPlayers(count: number, fixed = true): void {
    // A display or station can reserve two seats before the first call arrives. Ordinary
    // name confirmation and join updates must not silently shrink that reservation.
    if (this.fixedExpectedHumanPlayers && !fixed && count < this.expectedHumanPlayers) return;
    const target = count >= 2 ? 2 : 1;
    if (target !== this.expectedHumanPlayers) this.clearSetupVotes();
    this.expectedHumanPlayers = target;
    if (fixed) this.fixedExpectedHumanPlayers = true;
    this.automaticSetup=true;
    if (this.expectedHumanPlayers !== 1 || this.players.length !== 1) this.aiFighterId = null;
    else if (this.phase === 'map_select' && !this.aiFighterId && this.players[0]?.fighterId)
      this.aiFighterId = this.chooseSoloAiFighter();
    if (this.expectedHumanPlayers === 1 && this.players.length === 1
      && (this.phase === 'lobby' || this.phase === 'fighter_select' || this.phase === 'map_select')) {
      this.players[0]!.side = 'p1';
    }
  }
  /** The local display chooses its caller count before setup leaves the lobby. */
  configureStandaloneSeats(count: 1 | 2): boolean {
    if (this.expectedHumanPlayers === count) {
      if (!this.fixedExpectedHumanPlayers && this.phase === 'lobby') this.expectHumanPlayers(count, true);
      else this.fixedExpectedHumanPlayers = true;
      return true;
    }
    if (this.phase !== 'lobby' && !this.prepareForNewStandaloneCaller()) return false;
    if (this.players.length > count) return false;
    this.expectHumanPlayers(count, true);
    return true;
  }
  /** Keep a reconnecting caller's seat, but require a fresh menu or rematch decision. */
  suspendPlayer(id: string): void {
    if (!this.hasPlayer(id)) return;
    this.advanceReady.delete(id);
    this.backReady.delete(id);
    const menu = this.voiceMenus.get(id);
    if (menu) {
      menu.connected = false;
      menu.pending = 0;
      menu.turns.clear();
      menu.prompted = false;
      menu.failedCues.clear();
      menu.generation++;
    }
    this.rejectPendingVoiceCommands(id, 'player_left');
  }
  /** Every connected phone must finish its current menu cue before shared votes move the display. */
  registerVoicePlayer(id: string): void {
    if (!this.hasPlayer(id)) return;
    const previous = this.voiceMenus.get(id);
    this.voiceMenus.set(id, { connected: true, phase: this.phase, pending: 0,
      turns: new Set(), prompted: false, failedCues: new Map(),
      generation: (previous?.generation ?? 0) + 1,
      cueSequence: 0, latestPlayedCueSequence: 0 });
  }
  private menuForPhase(id: string, phase: FighterPhase): VoiceMenuState | null {
    const menu = this.voiceMenus.get(id);
    if (!menu?.connected || !this.isSharedMenuPhase(phase) || phase !== this.phase) return null;
    if (menu.phase !== phase) {
      menu.phase = phase;
      menu.pending = 0;
      menu.turns.clear();
      menu.prompted = false;
      menu.failedCues.clear();
      menu.generation++;
      menu.cueSequence = 0;
      menu.latestPlayedCueSequence = 0;
    }
    return menu;
  }
  beginMenuAudio(id: string, phase: FighterPhase, recovery = false): (played?: boolean) => void {
    const menu = this.menuForPhase(id, phase);
    if (!menu) return () => {};
    menu.pending++;
    menu.prompted = true;
    const generation = menu.generation;
    const cueSequence = ++menu.cueSequence;
    let finished = false;
    return (played = true) => {
      if (finished) return;
      finished = true;
      if (menu.generation !== generation) return;
      menu.pending = Math.max(0, menu.pending - 1);
      if (!played) {
        // A stale queued cue may report an interruption after a newer cue has
        // already played. That older failure no longer describes the phone.
        if (cueSequence > menu.latestPlayedCueSequence)
          menu.failedCues.set(cueSequence, menu.cueSequence);
      } else {
        menu.latestPlayedCueSequence = Math.max(menu.latestPlayedCueSequence, cueSequence);
        for (const [failedSequence, queuedThrough] of menu.failedCues) {
          // A normal cue replaces only older audio that was already in flight
          // when it failed. A genuinely failed current cue still needs replay.
          if (cueSequence > failedSequence && (recovery || cueSequence <= queuedThrough))
            menu.failedCues.delete(failedSequence);
        }
      }
    };
  }
  /** Reserve the caller's partial/final ASR and AI turn before a peer's vote can advance. */
  beginMenuTurn(id: string, phase: FighterPhase): () => void {
    const menu = this.menuForPhase(id, phase);
    if (!menu) return () => {};
    const token = Symbol('fighter menu turn');
    const generation = menu.generation;
    menu.turns.add(token);
    return () => {
      if (menu.generation === generation) menu.turns.delete(token);
    };
  }
  /** Called when Relay playback or a pending menu interpretation settles. */
  completeSharedDecisionIfReady(): boolean {
    if (!this.requiresSharedSetupConsent || !this.isSharedMenuPhase(this.phase)
      || this.players.length < this.expectedHumanPlayers
      || !this.players.every(player => this.voiceMenuReady(player.playerId))) return false;
    const previousPhase = this.phase;
    const voter = this.players[0]?.playerId;
    if (!voter) return false;
    if (this.players.every(player => this.advanceReady.has(player.playerId))) this.advance(voter);
    else if (this.players.every(player => this.backReady.has(player.playerId))) this.back(voter);
    return this.phase !== previousPhase;
  }
  removePlayer(id: string): void {
    if (!this.hasPlayer(id)) return;
    if ((this.phase === 'victory' || this.phase === 'results') && this.world?.winner) this.captureResult();
    this.rejectPendingVoiceCommands(id, 'player_left');
    this.players = this.players.filter((player) => player.playerId !== id);
    this.voiceMenus.delete(id);
    this.clearSetupVotes();
    this.mapVotes.delete(id);if(this.phase==='map_select')this.selectedMap=this.mapVoteWinner();
    if (!this.players.length) {
      if ((this.phase === 'victory' || this.phase === 'results') && this.world?.winner) return;
      this.phase = 'lobby'; this.world = null; this.selectedMap = null;this.mapVotes.clear();this.aiFighterId = null;
      if (!this.fixedExpectedHumanPlayers) { this.automaticSetup=false;this.expectedHumanPlayers=1; }
      this.invalidatePresentation();this.resultsPresentationDeadline=0;
    }
    else {
      if(!this.fixedExpectedHumanPlayers)this.expectedHumanPlayers=this.players.length;
      if(this.phase==='map_select'&&this.players.length<this.expectedHumanPlayers){
        this.phase='fighter_select';this.selectedMap=null;this.aiFighterId=null;
      }
      else if (this.phase === 'loading' || this.phase === 'intro' || this.phase === 'fight' || this.phase === 'countdown') {
        this.rejectAllPendingVoiceCommands('match_over');
        this.phase = 'fighter_select'; this.world = null; this.selectedMap = null;this.mapVotes.clear();this.aiFighterId = null;
        this.invalidatePresentation();
      }
      if (this.phase === 'map_select' && this.players.length === 1
        && this.expectedHumanPlayers === 1 && !this.aiFighterId && this.players[0]?.fighterId)
        this.aiFighterId = this.chooseSoloAiFighter();
    }
  }
  setName(id: string, name: string): void { const player = this.players.find(p => p.playerId === id); if (player) {
    if (!player.nameConfirmed || player.name !== cleanName(name)) this.clearSetupVotes();
    player.name = cleanName(name);player.nameConfirmed=true;
  } }
  hasConfirmedName(id:string):boolean{return this.players.find(player=>player.playerId===id)?.nameConfirmed===true;}
  selectFighter(id: string, fighterId: string): boolean {
    if (this.phase !== 'fighter_select' || !FIGHTER_ROSTER.some(f => f.id === fighterId)) return false;
    const player = this.players.find(p => p.playerId === id);
    if (!player || this.players.some(p => p !== player && p.fighterId === fighterId)) return false;
    if (player.fighterId !== fighterId) this.clearSetupVotes();
    player.fighterId=fighterId;this.aiFighterId=null;return true;
  }
  nextUnselectedPlayerId(): string | null { return this.players.find(player => !player.fighterId)?.playerId ?? null; }
  selectMap(playerId:string,mapId: string): boolean {
    if (this.phase !== 'map_select' || !this.maps.some(map => map.id === mapId)) return false;
    if(!this.players.some(player=>player.playerId===playerId))return false;
    if (this.mapVotes.get(playerId) !== mapId) this.clearSetupVotes();
    this.mapVotes.set(playerId,mapId);this.selectedMap=this.mapVoteWinner();return true;
  }
  advance(playerId?: string): boolean {
    if(this.automaticSetup&&['lobby','fighter_select','map_select'].includes(this.phase)
      &&(!playerId||!this.hasPlayer(playerId)))return false;
    if (this.phase === 'lobby' && this.players.length >= this.expectedHumanPlayers
      && this.players.every(player=>player.nameConfirmed)) {
      if (!this.confirmSharedAdvance(playerId)) return this.hasAdvanceVote(playerId);
      this.phase = 'fighter_select'; this.clearSetupVotes(); return true;
    }
    if (this.phase === 'fighter_select' && this.players.length >= this.expectedHumanPlayers && this.players.every(p => p.fighterId)) {
      if (!this.confirmSharedAdvance(playerId)) return this.hasAdvanceVote(playerId);
      this.aiFighterId=this.players.length===1?this.chooseSoloAiFighter():null;
      this.phase = 'map_select';this.selectedMap=this.mapVoteWinner();this.clearSetupVotes();return true;
    }
    if (this.phase === 'map_select' && this.selectedMap && this.players.length >= this.expectedHumanPlayers
      && (!this.automaticSetup||this.players.every(player=>this.mapVotes.has(player.playerId)))) {
      if (!this.confirmSharedAdvance(playerId)) return this.hasAdvanceVote(playerId);
      this.clearSetupVotes(); return this.beginLoading();
    }
    if (this.phase === 'results') {
      if (playerId && !this.hasPlayer(playerId)) return false;
      if (!this.resultsPresented && !this.resultsPresentationTimedOut) return false;
      if (!this.confirmSharedAdvance(playerId)) return this.hasAdvanceVote(playerId);
      this.resetResultsForNewRound();
      return true;
    }
    return false;
  }
  back(playerId?: string): boolean {
    if(this.automaticSetup && (!playerId || !this.hasPlayer(playerId)))return false;
    if (this.phase === 'fighter_select') {
      if (!this.confirmSharedBack(playerId)) return this.hasBackVote(playerId);
      this.phase = 'lobby'; this.clearSetupVotes(); return true;
    }
    if (this.phase === 'map_select') {
      if (!this.confirmSharedBack(playerId)) return this.hasBackVote(playerId);
      this.phase = 'fighter_select'; this.selectedMap = null;this.mapVotes.clear();this.aiFighterId=null;
      this.clearSetupVotes(); return true;
    }
    if (this.phase === 'loading' && !this.requiresSharedSetupConsent) {
      this.phase = 'map_select'; this.world = null; this.countdown = 0; this.loadingElapsed = 0; this.invalidatePresentation(); return true;
    }
    return false;
  }
  ready(generation: number): boolean {
    if (this.phase !== 'loading' || generation !== this.loadingGeneration) return false;
    this.phase = 'intro'; this.intro = FIGHTER_INTRO_SECONDS; return true;
  }
  /** Solo callers may skip the optional visual introduction after the display confirms loading. */
  skipIntro(playerId: string): boolean {
    if (!this.hasPlayer(playerId) || this.players.length !== 1 || this.phase !== 'intro' || !this.world) return false;
    this.intro = 0; this.phase = 'countdown'; this.countdown = 6;
    return true;
  }
  /** A solo caller's explicit start-now also skips the remaining countdown; PvP stays synchronized. */
  startNow(playerId: string): boolean {
    if (!this.hasPlayer(playerId) || this.players.length !== 1 || !this.world
      || (this.phase !== 'intro' && this.phase !== 'countdown')) return false;
    this.intro = 0; this.countdown = 0; this.phase = 'fight';
    return true;
  }
  /** A participant may shorten the optional victory celebration, but never start a rematch here. */
  revealResults(playerId:string):boolean{
    if(!this.hasPlayer(playerId)||!this.world?.winner||
      (this.phase!=='victory'&&this.phase!=='results'))return false;
    if(this.phase==='victory'){
      this.phase='results';this.victory=0;
      this.resultsPresentationDeadline=this.now()+FIGHTER_RESULTS_PRESENTATION_TIMEOUT_MS;
    }
    return true;
  }
  invalidateDisplayReady(): boolean {
    if (this.phase !== 'intro' && this.phase !== 'countdown') return false;
    this.phase = 'loading'; this.intro = 0; this.countdown = 0; this.loadingElapsed = 0; this.loadingGeneration += 1;
    this.invalidatePresentation();
    return true;
  }

  get hudPresented():boolean{return this.phase==='fight'&&this._hudPresented;}
  get resultsPresented():boolean{return this.phase==='results'&&this._resultsPresented;}
  get resultsPresentationTimedOut():boolean{return this.phase==='results'&&this.resultsPresentationDeadline>0
    &&!this._resultsPresented&&this.now()>=this.resultsPresentationDeadline;}
  get resultsPresentationRemainingMs():number{return this.phase==='results'&&this.resultsPresentationDeadline>0
    &&!this._resultsPresented?Math.max(0,this.resultsPresentationDeadline-this.now()):0;}
  /** Only the current host display's generation-bound paint receipt may set these flags. */
  acknowledgePresentation(kind:'fight'|'results',generation:number):boolean{
    if(generation!==this.loadingGeneration||this.phase!==kind)return false;
    if(kind==='fight'){
      if(!this.world||this._hudPresented)return false;
      this._hudPresented=true;return true;
    }
    if(!this.world?.winner||this._resultsPresented)return false;
    this._resultsPresented=true;return true;
  }
  invalidatePresentation():void{this._hudPresented=false;this._resultsPresented=false;}
  retryLoading(generation: number): boolean {
    if (this.phase !== 'loading' || generation !== this.loadingGeneration) return false;
    this.loadingElapsed = 0;
    this.loadingGeneration += 1;
    return true;
  }
  command(playerId: string, command: FighterCommand): FighterEvent[] {
    if (this.phase !== 'fight' || !this.world) return [];
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player) return [];
    const events = applyFighterCommand(this.world, player.side, command);
    this.events.push(...events); return events;
  }
  voiceCommand(playerId: string, command: FighterCommand): boolean;
  voiceCommand(playerId: string, command: FighterCommand, requestId: string): FighterVoiceCommandOutcome;
  voiceCommand(playerId: string, command: FighterCommand, requestId?: string): boolean | FighterVoiceCommandOutcome {
    const outcome = this.submitVoiceCommand(playerId, command, requestId ?? `legacy-${++this.nextVoiceRequestId}`);
    return requestId === undefined ? outcome.status !== 'rejected' : outcome;
  }
  private submitVoiceCommand(playerId: string, command: FighterCommand, requestId: string): FighterVoiceCommandOutcome {
    const rejected = this.invalidVoiceCommand(playerId, command, requestId);
    if (rejected) return rejected;
    this.rejectPendingVoiceCommands(playerId, 'superseded');
    if (this.command(playerId, command).length) return { requestId, command, status: 'executed' };
    this.voiceCommands.set(playerId, [{ command, queuedAt: this.now(), requestId, sequenceId: null }]);
    return { requestId, command, status: 'queued' };
  }
  voiceSequence(playerId: string, commands: readonly [FighterCommand, FighterCommand],
    requestIds: readonly [string, string]): readonly FighterVoiceCommandOutcome[] {
    const invalid = this.invalidVoiceCommand(playerId, commands[0], requestIds[0]);
    if (invalid) return [invalid, { ...invalid, requestId: requestIds[1], command: commands[1] }];
    this.rejectPendingVoiceCommands(playerId, 'superseded');
    const queuedAt = this.now();
    const first: QueuedFighterCommand = { command: commands[0], queuedAt, requestId: requestIds[0], sequenceId: requestIds[0] };
    const second: QueuedFighterCommand = { command: commands[1], queuedAt, requestId: requestIds[1], sequenceId: requestIds[0] };
    const executed = this.command(playerId, first.command).length > 0;
    this.voiceCommands.set(playerId, executed ? [second] : [first, second]);
    return [
      { requestId: first.requestId, command: first.command, status: executed ? 'executed' : 'queued' },
      { requestId: second.requestId, command: second.command, status: 'queued' },
    ];
  }
  drainVoiceCommandOutcomes(): FighterVoiceCommandOutcome[] {
    const outcomes = this.voiceCommandOutcomes;
    this.voiceCommandOutcomes = [];
    return outcomes;
  }
  private invalidVoiceCommand(playerId: string, command: FighterCommand, requestId: string): FighterVoiceCommandOutcome | null {
    if (!this.hasPlayer(playerId)) return { requestId, command, status: 'rejected', reason: 'not_player' };
    if (this.phase !== 'fight' || !this.world || this.world.status !== 'fighting')
      return { requestId, command, status: 'rejected', reason: 'not_fighting' };
    return null;
  }
  private rejectPendingVoiceCommands(playerId: string, reason: FighterVoiceCommandOutcome['reason']): void {
    const pending = this.voiceCommands.get(playerId);
    if (!pending) return;
    for (const entry of pending) this.voiceCommandOutcomes.push({
      requestId: entry.requestId, command: entry.command, status: 'rejected', reason,
    });
    this.voiceCommands.delete(playerId);
  }
  private rejectAllPendingVoiceCommands(reason: FighterVoiceCommandOutcome['reason']): void {
    for (const playerId of this.voiceCommands.keys()) this.rejectPendingVoiceCommands(playerId, reason);
  }
  tick(delta: number): void {
    if (this.phase === 'loading') {
      this.loadingElapsed += delta;
      if (this.loadingElapsed >= FIGHTER_LOADING_TIMEOUT_SECONDS) {
        this.phase = 'map_select'; this.world = null; this.countdown = 0; this.loadingElapsed = 0;
      }
      return;
    }
    if (this.phase === 'intro') {
      this.intro = Math.max(0, this.intro - delta);
      if (this.intro === 0) { this.phase = 'countdown'; this.countdown = 6; }
      return;
    }
    if (this.phase === 'countdown') {
      this.countdown = Math.max(0, this.countdown - delta);
      if (this.countdown === 0) this.phase = 'fight';
      return;
    }
    if (this.phase === 'victory') {
      this.rejectAllPendingVoiceCommands('match_over');
      this.victory = Math.max(0, this.victory - delta);
      if (this.victory === 0) {
        this.phase = 'results';
        this.resultsPresentationDeadline=this.now()+FIGHTER_RESULTS_PRESENTATION_TIMEOUT_MS;
      }
      return;
    }
    if (this.phase !== 'fight' || !this.world) return;
    const resolved = tickFighterWorld(this.world, delta);
    this.events.push(...resolved);
    if (this.world.status === 'fighting') {
      // A spoken action already waiting for recovery gets the first ready slot. Otherwise the
      // solo AI can win the same 50 ms tick and make a valid caller command feel ignored.
      for (const [playerId] of this.voiceCommands) {
        const active=this.activeVoiceCommands(playerId),next=active[0];if(!next)continue;
        const events = this.command(playerId, next.command);
        if (events.length) {
          active.shift();
          this.voiceCommandOutcomes.push({ requestId: next.requestId, command: next.command, status: 'executed' });
        }
        if (!active.length) this.voiceCommands.delete(playerId);
      }
      if (this.players.length === 1 && this.world.status === 'fighting' && this.world.now >= this.aiNext) {
        const command = this.aiCommand();
        this.events.push(...applyFighterCommand(this.world, this.players[0]!.side === 'p1' ? 'p2' : 'p1', command));
        // Voice commands include listening and ASR time. Give a solo caller a full
        // spoken turn between rival decisions instead of trading at keyboard speed.
        this.aiNext = this.world.now + 1.30 + this.random() * 0.70;
      }
    } else this.rejectAllPendingVoiceCommands('match_over');
    if (this.world.status === 'finished') { this.captureResult(); this.phase = 'victory'; this.victory = FIGHTER_VICTORY_SECONDS; }
  }
  drainEvents(): FighterEvent[] { const events = this.events; this.events = []; return events; }
  lobbyPlayers(): FighterLobbyPlayer[] {
    const rows = this.players.map((player): FighterLobbyPlayer => ({ ...player, isAi: false }));
    if (this.players.length === 1 && (this.phase === 'loading' || this.phase === 'intro' || this.phase === 'countdown' || this.phase === 'fight' || this.phase === 'victory' || this.phase === 'results')) {
      const chosen = this.players[0]!.fighterId;
      rows.push({ playerId: 'ai', name: 'Rival', fighterId: this.aiFighterId ?? FIGHTER_ROSTER.find(f => f.id !== chosen)?.id ?? 'wraith', side: this.players[0]!.side === 'p1' ? 'p2' : 'p1', isAi: true });
    }
    return rows;
  }
  state(): FighterState {
    const winner = this.world?.winner ?? null;
    const sharedMenu = this.isSharedMenuPhase(this.phase);
    return { roomCode: this.code, phase: this.phase,
      players: (this.phase === 'victory' || this.phase === 'results') && this.resultPlayers ? this.resultPlayers : this.lobbyPlayers(),
      aiFighterId: this.players.length === 1 ? this.aiFighterId : null,
      selectedMap: this.selectedMap,
      mapVotesByPlayerId:Object.fromEntries(this.mapVotes),
      mapVoteTied: this.mapVoteTied,
      advanceReadyPlayerIds: [...this.advanceReady], backReadyPlayerIds: [...this.backReady],
      phonePendingPlayerIds: sharedMenu ? this.players.filter(player => {
        const menu = this.voiceMenus.get(player.playerId);
        return menu?.connected && !this.voiceMenuReady(player.playerId);
      }).map(player => player.playerId) : [],
      phoneTurnPendingPlayerIds: sharedMenu ? this.players.filter(player =>
        (this.voiceMenus.get(player.playerId)?.turns.size ?? 0) > 0)
        .map(player => player.playerId) : [],
      phoneRetryPlayerIds: sharedMenu ? this.players.filter(player => {
        const menu = this.voiceMenus.get(player.playerId);
        return menu?.connected && menu.phase === this.phase && menu.failedCues.size > 0;
      }).map(player => player.playerId) : [],
      phoneDisconnectedPlayerIds: sharedMenu ? this.players.filter(player => {
        const menu = this.voiceMenus.get(player.playerId);
        return menu && !menu.connected;
      }).map(player => player.playerId) : [],
      world:this.world,expectedPlayerCount:this.expectedHumanPlayers,hasExpectedPlayers:this.hasExpectedPlayers,automaticSetup:this.automaticSetup,
      loadingGeneration: this.loadingGeneration, intro: this.phase === 'intro' ? this.intro : null,
      countdown: this.phase === 'countdown' ? this.countdown : null,
      hudPresented:this.hudPresented,resultsPresented:this.resultsPresented,
      result: winner ? { winner, winnerName: this.nameForSide(winner) } : null };
  }
  hasPlayer(id: string): boolean { return this.players.some(player => player.playerId === id); }
  canControlSetup(id: string): boolean { return this.hasPlayer(id); }
  get playerCount(): number { return this.players.length; }
  get expectedPlayerCount(): number { return this.expectedHumanPlayers; }
  get hasExpectedPlayers(): boolean { return this.players.length >= this.expectedHumanPlayers; }
  get isEmpty(): boolean { return this.players.length === 0; }

  private get requiresSharedSetupConsent(): boolean {
    return this.automaticSetup && this.expectedHumanPlayers === 2;
  }
  private isSharedMenuPhase(phase: FighterPhase): boolean {
    return phase === 'lobby' || phase === 'fighter_select' || phase === 'map_select'
      || phase === 'results';
  }
  private voiceMenuReady(id: string): boolean {
    const menu = this.voiceMenus.get(id);
    return !menu || (menu.connected && menu.phase === this.phase
      && menu.prompted && menu.pending === 0 && menu.turns.size === 0 && menu.failedCues.size === 0);
  }
  private clearSetupVotes(): void { this.advanceReady.clear(); this.backReady.clear(); }
  private hasAdvanceVote(id?: string): boolean { return Boolean(id && this.advanceReady.has(id)); }
  private hasBackVote(id?: string): boolean { return Boolean(id && this.backReady.has(id)); }
  private confirmSharedAdvance(id?: string): boolean {
    if (!this.requiresSharedSetupConsent) return true;
    if (!id || !this.hasPlayer(id)) return false;
    this.backReady.clear();
    this.advanceReady.add(id);
    return this.players.every(player => this.advanceReady.has(player.playerId)
      && this.voiceMenuReady(player.playerId));
  }
  private confirmSharedBack(id?: string): boolean {
    if (!this.requiresSharedSetupConsent) return true;
    if (!id || !this.hasPlayer(id)) return false;
    this.advanceReady.clear();
    this.backReady.add(id);
    return this.players.every(player => this.backReady.has(player.playerId)
      && this.voiceMenuReady(player.playerId));
  }

  private activeVoiceCommands(playerId:string):QueuedFighterCommand[]{
    const queued=this.voiceCommands.get(playerId)??[];
    if(!this.world)return queued;
    if (queued.some(entry => this.now()-entry.queuedAt >= FIGHTER_VOICE_COMMAND_TTL_SECONDS*1000)) {
      this.rejectPendingVoiceCommands(playerId, 'expired');
      return [];
    }
    return queued;
  }

  private captureResult(): void {
    if (this.resultPlayers || !this.world?.winner) return;
    this.resultPlayers = this.lobbyPlayers().map(player => ({ ...player }));
    this.resultWinnerName = this.resultPlayers.find(player => player.side === this.world!.winner)?.name ?? 'Rival';
  }
  private resetResultsForNewRound(): void {
    this.rejectAllPendingVoiceCommands('match_over');
    this.clearSetupVotes();
    this.phase = this.players.length ? 'fighter_select' : 'lobby';
    this.world = null; this.selectedMap = null; this.mapVotes.clear(); this.aiFighterId = null;
    this.resultPlayers = null; this.resultWinnerName = null;
    this.events = [];
    this.intro = 0; this.countdown = 0; this.victory = 0; this.loadingElapsed = 0;
    if (!this.players.length && !this.fixedExpectedHumanPlayers) { this.automaticSetup = false; this.expectedHumanPlayers = 1; }
    this.invalidatePresentation(); this.resultsPresentationDeadline = 0;
    for (const player of this.players) player.fighterId = null;
  }
  private nameForSide(side: FighterId): string {
    if (this.world?.winner === side && this.resultWinnerName) return this.resultWinnerName;
    return (this.resultPlayers ?? this.lobbyPlayers()).find(player => player.side === side)?.name ?? 'Rival';
  }
  private mapVoteWinner():string|null {
    const ranked=[...this.mapVoteCounts()].sort((left,right)=>right[1]-left[1]
      ||this.mapTiePriority(left[0])-this.mapTiePriority(right[0])||left[0].localeCompare(right[0]));
    return ranked[0]?.[0]??null;
  }
  private mapVoteCounts():Map<string,number>{
    const counts=new Map<string,number>();
    for(const mapId of this.mapVotes.values())counts.set(mapId,(counts.get(mapId)??0)+1);
    return counts;
  }
  private get mapVoteTied():boolean{
    const counts=[...this.mapVoteCounts().values()];
    const lead=Math.max(0,...counts);
    return lead>0&&counts.filter(count=>count===lead).length>1;
  }
  private mapTiePriority(mapId:string):number{
    let value=this.mapTieSeed;
    for(const char of mapId)value=Math.imul(value^char.charCodeAt(0),16777619)>>>0;
    return value;
  }
  private chooseSoloAiFighter(): string {
    const human = this.players[0]?.fighterId;
    const choices = FIGHTER_ROSTER.filter(fighter => SOLO_AI_FIGHTERS.includes(fighter.id) && fighter.id !== human);
    return choices[Math.floor(this.random() * choices.length)]?.id ?? 'cinder-capone';
  }
  private beginLoading():boolean {
    if(!this.selectedMap)return false;
    const bounds=this.maps.find(map=>map.id===this.selectedMap)?.bounds??[-9,9];
    if(this.players.length===1){
      if (!this.aiFighterId || this.aiFighterId === this.players[0]!.fighterId)
        this.aiFighterId = this.chooseSoloAiFighter();
    }else this.aiFighterId=null;
    this.rejectAllPendingVoiceCommands('match_over');
    this.invalidatePresentation();
    this.resultsPresentationDeadline=0;
    this.phase='loading';this.world=createFighterWorld(bounds);this.countdown=0;this.aiNext=1.0;
    this.loadingElapsed=0;this.loadingGeneration++;return true;
  }
  private aiCommand(): FighterCommand {
    const world = this.world!;
    const distance = Math.abs(world.p1.x - world.p2.x);
    const roll = this.random();
    if (distance > 1.75) return 'forward';
    if (roll < 0.12) return 'jump';
    if (roll < 0.32) return 'block';
    if (roll < 0.61) return 'punch';
    if (roll < 0.79) return 'kick';
    return 'back';
  }
  private random(): number { this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0; return this.rng / 0x100000000; }
}

function cleanName(name: string): string { return name.trim().slice(0, 20) || 'Fighter'; }
