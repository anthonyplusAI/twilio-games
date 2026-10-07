import { applyFighterCommand, createFighterWorld, tickFighterWorld, type FighterCommand, type FighterEvent, type FighterId, type FighterWorld } from '../shared/fighter-world';
import { FIGHTER_MAPS, FIGHTER_ROSTER, type FighterMapEntry } from '../shared/fighter-roster';
import { FIGHTER_INTRO_SECONDS, type FighterLobbyPlayer, type FighterPhase, type FighterState } from '../shared/fighter-protocol';

interface Player { playerId: string; name: string; nameConfirmed: boolean; fighterId: string | null; side: FighterId; }
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
  private voiceCommands = new Map<string, QueuedFighterCommand[]>();
  private voiceCommandOutcomes: FighterVoiceCommandOutcome[] = [];
  private nextVoiceRequestId = 0;
  private expectedHumanPlayers = 1;
  private automaticSetup=false;
  private fixedExpectedHumanPlayers=false;
  private rng: number;

  constructor(readonly code: string, seed = 0x12345678, private maps: FighterMapEntry[] = FIGHTER_MAPS,
    private readonly now:()=>number=Date.now) { this.rng = seed >>> 0; }
  setMaps(maps: FighterMapEntry[]): void { if (maps.length) this.maps = maps; }

  addPlayer(name: string, preferredSide?: FighterId, nameConfirmed = true): { playerId: string } | { error: string } {
    if (this.players.length >= 2 || !['lobby', 'fighter_select'].includes(this.phase)) return { error: 'room_full' };
    const side: FighterId = preferredSide ?? (this.players.some(player => player.side === 'p1') ? 'p2' : 'p1');
    if (this.players.some(player => player.side === side)) return { error: 'room_full' };
    const player = { playerId: `f${this.nextPlayer++}`, name: cleanName(name), nameConfirmed, fighterId: null, side };
    this.players.push(player);this.players.sort((left,right)=>left.side.localeCompare(right.side));
    if (!nameConfirmed && this.phase === 'fighter_select') this.phase = 'lobby';
    return { playerId: player.playerId };
  }
  expectHumanPlayers(count: number, fixed = true): void {
    this.expectedHumanPlayers = count >= 2 ? 2 : 1;
    if (fixed) this.fixedExpectedHumanPlayers = true;
    this.automaticSetup=true;
    if (this.expectedHumanPlayers === 1 && this.players.length === 1
      && (this.phase === 'lobby' || this.phase === 'fighter_select' || this.phase === 'map_select')) {
      this.players[0]!.side = 'p1';
    }
  }
  removePlayer(id: string): void {
    this.rejectPendingVoiceCommands(id, 'player_left');
    this.players = this.players.filter((player) => player.playerId !== id);
    this.mapVotes.delete(id);if(this.phase==='map_select')this.selectedMap=this.mapVoteWinner();
    if (!this.players.length) { this.phase = 'lobby'; this.world = null; this.selectedMap = null;this.mapVotes.clear();this.aiFighterId = null;this.automaticSetup=false;this.expectedHumanPlayers=1;this.fixedExpectedHumanPlayers=false;this.invalidatePresentation();this.resultsPresentationDeadline=0; }
    else {
      if(!this.fixedExpectedHumanPlayers)this.expectedHumanPlayers=this.players.length;
      if(this.phase==='map_select'&&this.players.length<this.expectedHumanPlayers){
        this.phase='fighter_select';this.selectedMap=null;
      }
      else if (this.phase === 'loading' || this.phase === 'intro' || this.phase === 'fight' || this.phase === 'countdown' || this.phase === 'victory') {
        this.rejectAllPendingVoiceCommands('match_over');
        this.phase = 'fighter_select'; this.world = null; this.selectedMap = null;this.mapVotes.clear();this.aiFighterId = null;
        this.invalidatePresentation();
      }
    }
  }
  setName(id: string, name: string): void { const player = this.players.find(p => p.playerId === id); if (player) { player.name = cleanName(name);player.nameConfirmed=true; } }
  hasConfirmedName(id:string):boolean{return this.players.find(player=>player.playerId===id)?.nameConfirmed===true;}
  selectFighter(id: string, fighterId: string): boolean {
    if (this.phase !== 'fighter_select' || !FIGHTER_ROSTER.some(f => f.id === fighterId)) return false;
    const player = this.players.find(p => p.playerId === id);
    if (!player || this.players.some(p => p !== player && p.fighterId === fighterId)) return false;
    player.fighterId=fighterId;return true;
  }
  nextUnselectedPlayerId(): string | null { return this.players.find(player => !player.fighterId)?.playerId ?? null; }
  selectMap(playerId:string,mapId: string): boolean {
    if (this.phase !== 'map_select' || !this.maps.some(map => map.id === mapId)) return false;
    if(!this.players.some(player=>player.playerId===playerId))return false;
    this.mapVotes.set(playerId,mapId);this.selectedMap=this.mapVoteWinner();return true;
  }
  advance(playerId?: string): boolean {
    if(this.automaticSetup&&['lobby','fighter_select','map_select'].includes(this.phase)
      &&(!playerId||!this.hasPlayer(playerId)))return false;
    if (this.phase === 'lobby' && this.players.length >= this.expectedHumanPlayers
      && this.players.every(player=>player.nameConfirmed)) { this.phase = 'fighter_select'; return true; }
    if (this.phase === 'fighter_select' && this.players.length >= this.expectedHumanPlayers && this.players.every(p => p.fighterId)) {
      this.phase = 'map_select';this.selectedMap=this.mapVoteWinner();return true;
    }
    if (this.phase === 'map_select' && this.selectedMap && this.players.length >= this.expectedHumanPlayers
      && (!this.automaticSetup||this.players.every(player=>this.mapVotes.has(player.playerId))))return this.beginLoading();
    if (this.phase === 'results') {
      if (playerId && !this.hasPlayer(playerId)) return false;
      if (!this.resultsPresented && !this.resultsPresentationTimedOut) return false;
      this.phase = 'fighter_select'; this.world = null; this.selectedMap = null;this.mapVotes.clear();
      this.aiFighterId = null;
      this.invalidatePresentation();
      this.resultsPresentationDeadline=0;
      for (const player of this.players) player.fighterId = null;
      return true;
    }
    return false;
  }
  back(playerId?: string): boolean {
    if(this.automaticSetup && (!playerId || !this.hasPlayer(playerId)))return false;
    if (this.phase === 'fighter_select') { this.phase = 'lobby'; return true; }
    if (this.phase === 'map_select') { this.phase = 'fighter_select'; this.selectedMap = null;this.mapVotes.clear();return true; }
    if (this.phase === 'loading') { this.phase = 'map_select'; this.world = null; this.countdown = 0; this.loadingElapsed = 0; this.invalidatePresentation(); return true; }
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
    if (this.players.length === 1 && this.world.now >= this.aiNext) {
      const command = this.aiCommand();
      this.events.push(...applyFighterCommand(this.world, this.players[0]!.side === 'p1' ? 'p2' : 'p1', command));
      // Leave room for a spoken command to arrive between rival decisions.
      this.aiNext = this.world.now + 1.0 + this.random() * 0.55;
    }
    const resolved = tickFighterWorld(this.world, delta);
    this.events.push(...resolved);
    if (this.world.status === 'fighting') {
      for (const [playerId] of this.voiceCommands) {
        const active=this.activeVoiceCommands(playerId),next=active[0];if(!next)continue;
        const events = this.command(playerId, next.command);
        if (events.length) {
          active.shift();
          this.voiceCommandOutcomes.push({ requestId: next.requestId, command: next.command, status: 'executed' });
        }
        if (!active.length) this.voiceCommands.delete(playerId);
      }
    } else this.rejectAllPendingVoiceCommands('match_over');
    if (this.world.status === 'finished') { this.phase = 'victory'; this.victory = FIGHTER_VICTORY_SECONDS; }
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
    return { roomCode: this.code, phase: this.phase, players: this.lobbyPlayers(), selectedMap: this.selectedMap,
      mapVotesByPlayerId:Object.fromEntries(this.mapVotes),
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

  private activeVoiceCommands(playerId:string):QueuedFighterCommand[]{
    const queued=this.voiceCommands.get(playerId)??[];
    if(!this.world)return queued;
    if (queued.some(entry => this.now()-entry.queuedAt >= FIGHTER_VOICE_COMMAND_TTL_SECONDS*1000)) {
      this.rejectPendingVoiceCommands(playerId, 'expired');
      return [];
    }
    return queued;
  }

  private nameForSide(side: FighterId): string { return this.lobbyPlayers().find(p => p.side === side)?.name ?? 'Rival'; }
  private mapVoteWinner():string|null {
    const counts=new Map<string,number>();
    for(const mapId of this.mapVotes.values())counts.set(mapId,(counts.get(mapId)??0)+1);
    const ranked=[...counts].sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0]));
    return ranked[0]?.[0]??null;
  }
  private beginLoading():boolean {
    if(!this.selectedMap)return false;
    const bounds=this.maps.find(map=>map.id===this.selectedMap)?.bounds??[-9,9];
    if(this.players.length===1){
      const choices=FIGHTER_ROSTER.filter(fighter=>SOLO_AI_FIGHTERS.includes(fighter.id)&&fighter.id!==this.players[0]!.fighterId);
      this.aiFighterId=choices[Math.floor(this.random()*choices.length)]?.id??'cinder-capone';
    }else this.aiFighterId=null;
    this.rejectAllPendingVoiceCommands('match_over');
    this.invalidatePresentation();
    this.resultsPresentationDeadline=0;
    this.phase='loading';this.world=createFighterWorld(bounds);this.countdown=0;this.aiNext=0.8;
    this.loadingElapsed=0;this.loadingGeneration++;return true;
  }
  private aiCommand(): FighterCommand {
    const world = this.world!;
    const distance = Math.abs(world.p1.x - world.p2.x);
    const roll = this.random();
    if (distance > 1.75) return 'forward';
    if (roll < 0.12) return 'jump';
    if (roll < 0.28) return 'block';
    if (roll < 0.65) return 'punch';
    if (roll < 0.92) return 'kick';
    return 'back';
  }
  private random(): number { this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0; return this.rng / 0x100000000; }
}

function cleanName(name: string): string { return name.trim().slice(0, 20) || 'Fighter'; }
