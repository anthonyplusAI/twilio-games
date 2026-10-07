import { parseCrMessage } from './conversation-relay';
import { isAdvanceWord as isEnglishAdvanceWord } from './battle-voice';
import { matchFighterCommands } from '../shared/fighter-intent';
import type { FighterCommand, FighterEvent } from '../shared/fighter-world';
import { FIGHTER_INTRO_SECONDS, fighterIntroStage, type FighterIntroStage, type FighterPhase } from '../shared/fighter-protocol';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { FIGHTER_MESSAGES, type FighterMessageKey } from '../shared/i18n/fighter';
import { createTranslator, formatNumber, normalizeForMatching } from '../shared/i18n/translate';
import { isExplicitSpokenName, parseFirstName } from '../shared/spoken-name';
import type { FighterVoiceCommandOutcome } from './fighter-room';
import type { VoiceInterpretAction, VoiceInterpretFact, VoiceInterpretRequest, VoiceInterpretResult } from './voice-interpreter';

const REPEATED_FINAL_FRAME_MS = 180;

export interface FighterVoiceSnapshot {
  phase: FighterPhase;
  myName: string | null;
  nameConfirmed?: boolean;
  myFighterId: string | null;
  myFighterName: string | null;
  foeName: string | null;
  foeFighterId: string | null;
  foeFighterName: string | null;
  selectedMap: string | null;
  myMapVote:string|null;
  allMapVotes:boolean;
  mySide: 'p1' | 'p2';
  myHealth: number | null;
  foeHealth: number | null;
  countdown: number | null;
  intro: number | null;
  winnerName: string | null;
  winnerSide: 'p1' | 'p2' | null;
  playerOneName: string | null;
  playerOneFighterName: string | null;
  playerTwoName: string | null;
  playerTwoFighterName: string | null;
  playerCount: number;
  hasExpectedPlayers?: boolean;
  automaticSetup:boolean;
  allFightersSelected: boolean;
  isController: boolean;
  fighters: { id: string; name: string }[];
  maps: { id: string; name: string }[];
  /** True only after an authenticated display paint receipt for the current health bars. */
  hudPresented?: boolean;
  /** True only after the results overlay has actually appeared on the paired display. */
  resultsPresented?: boolean;
  /** True after bounded display-loss recovery, without claiming the result appeared on screen. */
  resultsPresentationTimedOut?: boolean;
  /** Match/loading generation, so a reloaded intro cannot revive an old queued cue. */
  loadingGeneration?: number;
}
export interface FighterVoiceDeps {
  join(code: string, name: string, callSid: string, side?: 'p1' | 'p2', expectedPlayers?: number, nameConfirmed?: boolean): { playerId: string; resumed: boolean } | null;
  leave(code: string, id: string, callSid: string): void;
  setName(code: string, id: string, name: string): void;
  selectFighter(code: string, id: string, fighterId: string): boolean;
  selectMap(code: string, id: string, mapId: string): boolean;
  advance(code: string, id: string): boolean;
  command(code: string, id: string, command: FighterCommand, requestId?: string): boolean | FighterVoiceCommandOutcome;
  commandSequence?(code: string, id: string, commands: readonly [FighterCommand,FighterCommand],
    requestIds: readonly [string,string]): readonly FighterVoiceCommandOutcome[];
  back?(code: string, id: string): boolean;
  skipIntro?(code: string, id: string): boolean;
  startNow?(code: string, id: string): boolean;
  showResults?(code:string,id:string):boolean;
  interpret?(request: VoiceInterpretRequest): Promise<VoiceInterpretResult>;
  snapshot(code: string, id: string, locale?: SupportedLocale): FighterVoiceSnapshot | null;
  say(text: string, isCurrent?: () => boolean): void;
}

export class FighterVoiceSession {
  private code: string | null = null;
  private playerId: string | null = null;
  get boundPlayerId(): string | null { return this.playerId; }
  get boundRoomCode(): string | null { return this.code; }
  private callSid: string | null = null;
  private lastPhase: FighterPhase | null = null;
  private lastCountdown = -1;
  private lastFoeFighterId: string | null = null;
  private lastFoeName: string | null = null;
  private lastMyFighterId:string|null=null;
  private lastMyMapVote:string|null=null;
  private lastCombatCueAt = 0;
  private lastIntroStage: FighterIntroStage | null = null;
  private interimCandidate: FighterCommand | null = null;
  private interimCount = 0;
  private interimFiredCommand: FighterCommand | null = null;
  private lastWaitCue = '';
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private authoritativeName: string | null = null;
  private stationManaged=false;
  private stationAssignment: { side: 'p1' | 'p2'; expectedPlayers: number } | null = null;
  private applyingSelection=false;
  private applyingName=false;
  private awaitingName=false;
  private lastLobbyReady=false;
  private lastFighterChoicesReady=false;
  private lastMapVotesReady=false;
  private lastResultsPresented=false;
  private lastResultsPresentationTimedOut=false;
  private lastFinalText:{text:string;beforeContext:string;afterContext:string;at:number;boundary:number}|null=null;
  private utteranceBoundary=0;
  private speechEpoch=0;
  private semanticEpoch=0;
  private semanticController:AbortController|null=null;
  private semanticScopeAtRequest:string|null=null;
  private nextCommandId=0;
  private pendingCommandIds=new Set<string>();
  private t = createTranslator(this.commandLocale, FIGHTER_MESSAGES);
  constructor(private deps: FighterVoiceDeps) {}
  setAuthoritativeName(name: string | null): void {
    this.authoritativeName = name?.trim().slice(0, 50) || null;
  }
  setStationManaged(active:boolean):void{
    if(this.stationManaged!==active)this.lastFinalText=null;
    this.stationManaged=active;
  }
  setStationAssignment(index: number, count: number): void {
    this.stationAssignment = { side: index === 1 ? 'p2' : 'p1', expectedPlayers: count >= 2 ? 2 : 1 };
  }
  get locale(): SupportedLocale { return this.commandLocale; }

  /** Keep queued Relay speech tied to the screen and caller turn that produced it. */
  private sayCurrent(text:string, extra?:()=>boolean):void{
    const code=this.code,playerId=this.playerId;
    const snapshot=code&&playerId?this.deps.snapshot(code,playerId,this.commandLocale):null;
    if(!code||!playerId||!snapshot)return;
    // Completion retires a paid station room immediately. The terminal line is already
    // authorized by this results snapshot and must survive that intentional teardown.
    if(this.stationManaged&&snapshot.phase==='results'
      &&(snapshot.resultsPresented===true||snapshot.resultsPresentationTimedOut===true)){
      this.deps.say(text);return;
    }
    const guard=this.phaseGuard(snapshot.phase,this.isNameConfirmed(snapshot));
    this.deps.say(text,()=>guard()&&(!extra||extra()));
  }

  private speechScope(snapshot:FighterVoiceSnapshot):string{
    return JSON.stringify([
      snapshot.phase,snapshot.loadingGeneration,snapshot.myName,this.isNameConfirmed(snapshot),
      snapshot.myFighterId,snapshot.foeName,snapshot.foeFighterId,snapshot.selectedMap,snapshot.myMapVote,
      snapshot.allMapVotes,snapshot.playerCount,snapshot.hasExpectedPlayers,snapshot.automaticSetup,
      snapshot.allFightersSelected,snapshot.isController,
      snapshot.phase==='intro'?fighterIntroStage(snapshot.intro??FIGHTER_INTRO_SECONDS):null,
      snapshot.phase==='countdown'?Math.ceil(snapshot.countdown??0):null,
      snapshot.phase==='fight'?snapshot.myHealth:null,
      snapshot.phase==='fight'?snapshot.foeHealth:null,
      snapshot.winnerSide,snapshot.winnerName,snapshot.resultsPresented,snapshot.resultsPresentationTimedOut,
    ]);
  }

  handleMessage(raw: string): void {
    const message = parseCrMessage(raw);
    if (message.type === 'setup') {
      const code = message.customParameters['roomCode']?.trim().toUpperCase(); if (!code || this.playerId) return;
      this.commandLocale = resolveLocale(message.customParameters['commandLocale'] ?? message.customParameters['locale']);
      this.t = createTranslator(this.commandLocale, FIGHTER_MESSAGES);
      const joined=this.deps.join(code,this.authoritativeName??this.t('voice.callerPlaceholder'),message.callSid,
        this.stationAssignment?.side,this.stationAssignment?.expectedPlayers??(this.authoritativeName?1:undefined),
        this.authoritativeName!==null);
      if (!joined) { this.deps.say(this.t('voice.arenaFull')); return; }
      this.code = code; this.playerId = joined.playerId; this.callSid = message.callSid;
      const snapshot = this.deps.snapshot(code, joined.playerId, this.commandLocale); this.lastPhase = snapshot?.phase ?? null;
      this.awaitingName=!this.authoritativeName&&!(snapshot?.nameConfirmed??!this.isPlaceholderName(snapshot?.myName??null));
      this.lastLobbyReady=snapshot?this.isLobbyReady(snapshot):false;
      this.lastFighterChoicesReady=snapshot?this.areFighterChoicesReady(snapshot):false;
      this.lastMapVotesReady=snapshot?this.areMapVotesReady(snapshot):false;
      this.lastResultsPresented=snapshot?.resultsPresented===true;
      this.lastResultsPresentationTimedOut=snapshot?.resultsPresentationTimedOut===true;
      this.lastFoeFighterId = snapshot?.foeFighterId ?? null;
      this.lastFoeName = snapshot?.foeName ?? null;
      this.lastMyFighterId=snapshot?.myFighterId??null;
      this.lastMyMapVote=snapshot?.myMapVote??null;
      if (joined.resumed && snapshot) {
        this.sayCurrent(!this.isPlaceholderName(snapshot.myName)
          ? this.t('voice.returnedName', { name: snapshot.myName ?? '' }) : this.t('voice.returned'));
        this.speakContext(snapshot);
      } else {
        if(this.authoritativeName&&snapshot){
          this.sayCurrent(this.t('voice.welcomeName',{name:this.authoritativeName}));
          this.sayCurrent(this.t('voice.greetingRelay'));
          this.sayCurrent(this.t('voice.controlsIntro'));
          this.sayCurrent(this.t('voice.fightHelp'));
          this.speakContext(snapshot);
        }else{
          this.sayCurrent(this.t('voice.welcome'));
          this.sayCurrent(this.t('voice.greetingRelay'));
          this.sayCurrent(this.t('voice.tellName'),this.phaseGuard('lobby',false));
        }
      }
      return;
    }
    if (message.type === 'dtmf' && this.code && this.playerId) {
      const snapshot = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
      if (!snapshot || !/^[0-9*#]$/.test(message.digit)) return;
      this.speechEpoch++;
      const fightCommands = ['forward', 'back', 'jump', 'punch', 'kick', 'block'];
      const spoken = snapshot.phase === 'fight'
        ? fightCommands[Number(message.digit) - 1]
        : message.digit === '0' ? '10' : message.digit === '*' ? '11' : message.digit === '#' ? '12' : message.digit;
      if (spoken) this.handleUtterance(spoken);
      return;
    }
    if (message.type === 'interrupt') { this.speechEpoch++;this.resetInterim(); this.lastFinalText=null;this.utteranceBoundary++;this.abortSemantic(); return; }
    if (message.type === 'prompt' && this.code && this.playerId) {
      const snapshot = this.deps.snapshot(this.code, this.playerId, this.commandLocale);
      if (!message.last) {
        // Interim hypotheses can be revised. Never mutate fighter state until the final transcript.
        this.speechEpoch++;this.resetInterim();this.utteranceBoundary++;this.abortSemantic();
        return;
      }
      this.resetInterim();
      const normalized=normalizeForMatching(message.voicePrompt,this.commandLocale),now=Date.now();
      const beforeContext=this.finalContext(snapshot);
      if(this.lastFinalText?.text===normalized && this.lastFinalText.boundary===this.utteranceBoundary
        &&this.lastFinalText.afterContext===beforeContext && now-this.lastFinalText.at<REPEATED_FINAL_FRAME_MS)return;
      this.speechEpoch++;
      this.abortSemantic();
      this.handleUtterance(message.voicePrompt);
      this.lastFinalText={text:normalized,beforeContext,
        afterContext:this.finalContext(this.deps.snapshot(this.code,this.playerId,this.commandLocale)),at:now,boundary:this.utteranceBoundary};
    }
  }

  private handleUtterance(spoken: string): void {
    const snapshot = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale); if (!snapshot) return;
    const unnamed = !this.isNameConfirmed(snapshot);
    if(!unnamed)this.awaitingName=false;
    if(this.awaitingName&&unnamed){
      const name=parseFighterSpokenName(spoken,this.commandLocale);
      if(name&&!isFighterAdvanceWord(spoken,this.commandLocale)&&!isFighterStarAlias(spoken,this.commandLocale)){
        this.awaitingName=false;this.applyingName=true;this.deps.setName(this.code!,this.playerId!,name);this.applyingName=false;
        const next=this.deps.snapshot(this.code!,this.playerId!,this.commandLocale)??snapshot;
        this.sayCurrent(this.t('voice.welcomeName',{name}));
        this.sayCurrent(this.t('voice.controlsIntro'));this.sayCurrent(this.t('voice.fightHelp'));
        this.speakContext(next);return;
      }
      this.sayCurrent(this.t('voice.tellName'),this.phaseGuard(snapshot.phase,false));return;
    }
    if (isHelpRequest(spoken, this.commandLocale)) {
      if (snapshot.phase === 'fight') this.sayCurrent(this.t('voice.fightHelp'));
      else this.speakContext(snapshot);
      return;
    }
    const phaseChoices = snapshot.phase === 'fighter_select' ? snapshot.fighters : snapshot.phase === 'map_select' ? snapshot.maps : [];
    const looksLikeChoice = phaseChoices.length > 0 && !!matchChoice(spoken, phaseChoices, this.commandLocale);
    if (unnamed && (snapshot.phase === 'lobby' || isExplicitName(spoken, this.commandLocale) || !looksLikeChoice)) {
      const name = parseFighterSpokenName(spoken, this.commandLocale);
      if (name && !isFighterAdvanceWord(spoken, this.commandLocale) && !isFighterStarAlias(spoken, this.commandLocale)) {
        if(snapshot.phase==='lobby'){
          this.applyingName=true;this.deps.setName(this.code!,this.playerId!,name);this.applyingName=false;
          this.sayCurrent(this.t('voice.welcomeName',{name}));
          this.sayCurrent(this.t('voice.controlsIntro'));
          this.sayCurrent(this.t('voice.fightHelp'));
          const next=this.deps.snapshot(this.code!,this.playerId!,this.commandLocale)??snapshot;
          this.speakContext(next);return;
        }
        this.applyingName=true;this.deps.setName(this.code!, this.playerId!, name);this.applyingName=false;
        const next = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale) ?? snapshot;
        this.sayCurrent(this.t('voice.welcomeName',{name}));this.speakContext(next);
        return;
      }
    }
    if (snapshot.phase === 'fighter_select') {
      if (isFighterSetupBack(spoken, this.commandLocale)) { this.backOrExplain(snapshot); return; }
      const fighter = matchChoice(spoken, snapshot.fighters, this.commandLocale);
      if (fighter) {
        this.applyingSelection=true;
        const selected=this.deps.selectFighter(this.code!,this.playerId!,fighter.id);
        this.applyingSelection=false;
        if(!selected)this.sayCurrent(this.t('voice.fighterUnavailable',{name:fighter.name}));
        else {
          const next = this.deps.snapshot(this.code!, this.playerId!, this.commandLocale) ?? snapshot;
          const namePrompt = unnamed ? this.t('voice.namePromptSuffix') : '';
          const values = { name: fighter.name, namePrompt };
           if (!this.hasExpectedPlayers(next)) this.sayCurrent(this.t('voice.fighterLockedWaitingPlayerTwo', values));
           else if(this.areFighterChoicesReady(next))this.sayCurrent(this.t('voice.fighterLockedNext',values));
           else this.sayCurrent(this.t('voice.fighterLockedWaiting',values));
        }
        return;
      }
      if (isFighterAdvanceWord(spoken, this.commandLocale)) { this.advanceOrExplain(snapshot); return; }
      if(this.interpret(spoken,snapshot))return;
      this.sayCurrent(this.t('voice.fighterUnknown', { prompt: this.t('voice.choiceFighter') })); return;
    }
    if (snapshot.phase === 'map_select') {
      if(!snapshot.automaticSetup&&!snapshot.isController){this.sayWaitOnce(this.t('voice.playerOneChoosingArena'));return;}
      if (isFighterSetupBack(spoken, this.commandLocale)) { this.backOrExplain(snapshot); return; }
      const map = matchChoice(spoken, snapshot.maps, this.commandLocale);
      if (map) {
        this.applyingSelection=true;const selected=this.deps.selectMap(this.code!,this.playerId!,map.id);this.applyingSelection=false;
        const next=this.deps.snapshot(this.code!,this.playerId!,this.commandLocale);
        const key=snapshot.automaticSetup&&(next?this.areMapVotesReady(next):false)?'voice.mapVote':'voice.mapVoteWait';
        this.sayCurrent(selected
          ? this.t(snapshot.automaticSetup?key:'voice.mapSelected',{name:this.localizedMapName(map)})
          :this.t('voice.mapUnavailable',{name:this.localizedMapName(map)}));
        return;
      }
      if(isFighterAdvanceWord(spoken,this.commandLocale)||isFighterFightAlias(spoken,this.commandLocale)||isFighterStarAlias(spoken,this.commandLocale)){
        this.advanceOrExplain(snapshot);return;
      }
      if(this.interpret(spoken,snapshot))return;
      this.sayCurrent(this.t('voice.arenaUnknown', { prompt: this.t('voice.choiceArena') })); return;
    }
    if (snapshot.phase === 'fight') {
      const commands=matchFighterCommands(spoken,this.commandLocale);
      if(!commands.length){if(!this.interpret(spoken,snapshot))this.sayCurrent(this.t('voice.fightHelp'));return;}
      this.submitCommands(commands);
      return;
    }
    if (snapshot.phase === 'intro' || snapshot.phase === 'countdown') {
      if (isFighterStartNow(spoken,this.commandLocale)) {
        if (!this.deps.startNow?.(this.code!,this.playerId!))this.sayCurrent(this.t('voice.waitTogether'));
        return;
      }
      if(snapshot.phase==='intro'&&isFighterSkipIntro(spoken,this.commandLocale)){
        if(!this.deps.skipIntro?.(this.code!,this.playerId!))this.sayCurrent(this.t('voice.waitTogether'));
        return;
      }
    }
    if(snapshot.phase==='loading'&&isFighterSetupBack(spoken,this.commandLocale)){
      this.backOrExplain(snapshot);return;
    }
    if((snapshot.phase==='victory'||snapshot.phase==='results')
      &&(isFighterShowResultsWord(spoken,this.commandLocale)
        ||snapshot.phase==='victory'&&isFighterContinueResultWord(spoken,this.commandLocale)
        ||snapshot.phase==='results'&&snapshot.resultsPresented===false
          &&snapshot.resultsPresentationTimedOut!==true
          &&isFighterAdvanceWord(spoken,this.commandLocale))){
      if(snapshot.resultsPresented===true){this.speakContext(snapshot);return;}
      if(!this.deps.showResults?.(this.code!,this.playerId!))
        this.sayCurrent(this.contextText(snapshot));
      return;
    }
    if (isFighterAdvanceWord(spoken, this.commandLocale) || isFighterStarAlias(spoken, this.commandLocale)) {
      if(snapshot.phase==='results'&&this.stationManaged)
        this.sayCurrent(this.contextText(snapshot));
      else this.advanceOrExplain(snapshot);
      return;
    }
    if(this.interpret(spoken,snapshot))return;
    this.speakContext(snapshot);
  }

  onStateChanged(): void {
    if (!this.code || !this.playerId) return;
    const snapshot = this.deps.snapshot(this.code, this.playerId, this.commandLocale); if (!snapshot) return;
    if(this.isNameConfirmed(snapshot))this.awaitingName=false;
    if(this.semanticScopeAtRequest!==null&&this.semanticScopeAtRequest!==this.semanticScope(snapshot))this.abortSemantic();
    const lobbyReady=this.isLobbyReady(snapshot);
    const fighterChoicesReady=this.areFighterChoicesReady(snapshot);
    const mapVotesReady=this.areMapVotesReady(snapshot);
    const myFighterChanged=snapshot.phase==='fighter_select'&&snapshot.myFighterId!==this.lastMyFighterId;
    const myMapVoteChanged=snapshot.phase==='map_select'&&snapshot.myMapVote!==this.lastMyMapVote;
    if(this.applyingSelection||this.applyingName){
      this.lastPhase=snapshot.phase;this.lastFoeFighterId=snapshot.foeFighterId;this.lastFoeName=snapshot.foeName;
      this.lastMyFighterId=snapshot.myFighterId;this.lastMyMapVote=snapshot.myMapVote;
      this.lastLobbyReady=lobbyReady;this.lastFighterChoicesReady=fighterChoicesReady;this.lastMapVotesReady=mapVotesReady;return;
    }
    if (snapshot.phase === 'countdown') {
      const count = Math.ceil(snapshot.countdown ?? 0);
      if (count > 0 && count <= 3 && count !== this.lastCountdown) { this.lastCountdown = count; this.sayCurrent(String(count), this.phaseGuard('countdown')); }
    }
    if (snapshot.phase === 'intro') {
      const stage = fighterIntroStage(snapshot.intro ?? FIGHTER_INTRO_SECONDS);
      if (stage !== this.lastIntroStage) { this.lastIntroStage = stage; this.speakIntroCue(snapshot, stage); }
    } else this.lastIntroStage = null;
    if (snapshot.phase !== this.lastPhase) {
      this.lastWaitCue = '';
      if (snapshot.phase === 'map_select' && this.lastPhase === 'loading') this.sayCurrent(this.t('voice.arenaLoadFailed'));
      else if (snapshot.phase === 'intro') { /* synchronized segment cue emitted above */ }
      else this.speakContext(snapshot);
    } else if(snapshot.phase==='results'
      &&(snapshot.resultsPresented===true&&!this.lastResultsPresented
        ||snapshot.resultsPresentationTimedOut===true&&!this.lastResultsPresentationTimedOut)){
      this.speakContext(snapshot);
    } else if(myFighterChanged||myMapVoteChanged){
      // A shared display may make a setup selection for this caller. Replace any
      // queued "choose" prompt with the newly selected name and next step.
      this.speakContext(snapshot);
    } else if (snapshot.foeName && !this.isPlaceholderName(snapshot.foeName) && snapshot.foeName !== this.lastFoeName) {
      this.sayCurrent(snapshot.foeFighterName
        ? this.t('voice.opponentJoinedFighter', { name: snapshot.foeName, fighter: snapshot.foeFighterName })
        : this.t('voice.opponentJoined', { name: snapshot.foeName }));
    } else if (snapshot.phase === 'fighter_select' && !this.isPlaceholderName(snapshot.foeName) && snapshot.foeFighterId && snapshot.foeFighterId !== this.lastFoeFighterId) {
      const values = {
        name: snapshot.foeName ?? this.t('voice.opponentFallback'),
        fighter: snapshot.foeFighterName ?? this.t('voice.fighterFallback'),
      };
      this.sayCurrent(this.t('voice.opponentLocked',values));
    }
    if(snapshot.phase==='lobby'&&lobbyReady&&!this.lastLobbyReady)this.sayCurrent(this.t('voice.sayStart'));
    if(snapshot.phase===this.lastPhase&&snapshot.phase==='fighter_select'&&fighterChoicesReady&&!this.lastFighterChoicesReady&&!myFighterChanged)
      this.sayCurrent(this.t('voice.fightersReadyNext'),this.phaseGuard('fighter_select'));
    if(snapshot.phase===this.lastPhase&&snapshot.phase==='map_select'&&mapVotesReady&&!this.lastMapVotesReady&&!myMapVoteChanged)
      this.sayCurrent(this.t('voice.mapVotesReadyStart'),this.phaseGuard('map_select'));
    this.lastFoeFighterId = snapshot.foeFighterId;
    this.lastFoeName = snapshot.foeName;
    this.lastMyFighterId=snapshot.myFighterId;
    this.lastMyMapVote=snapshot.myMapVote;
    this.lastPhase = snapshot.phase;
    this.lastLobbyReady=lobbyReady;
    this.lastFighterChoicesReady=fighterChoicesReady;
    this.lastMapVotesReady=mapVotesReady;
    this.lastResultsPresented=snapshot.resultsPresented===true;
    this.lastResultsPresentationTimedOut=snapshot.resultsPresentationTimedOut===true;
  }

  onFighterEvent(event: FighterEvent): void {
    if (!this.code || !this.playerId) return;
    const snapshot = this.deps.snapshot(this.code, this.playerId, this.commandLocale); if (!snapshot) return;
    if (event.type === 'hit' && Date.now() - this.lastCombatCueAt > 1200) {
      this.lastCombatCueAt = Date.now();
      const damage = formatNumber(this.commandLocale, event.damage);
      if (event.defender === snapshot.mySide) this.sayCurrent(event.blocked ? this.t('voice.selfBlocked') : this.t('voice.tookDamage', { damage }),this.phaseGuard('fight'));
      else if (event.attacker === snapshot.mySide) this.sayCurrent(event.blocked ? this.t('voice.theyBlocked') : this.t('voice.hitDamage', { damage }),this.phaseGuard('fight'));
    } else if (event.type === 'miss' && event.attacker === snapshot.mySide && Date.now() - this.lastCombatCueAt > 1200) {
      this.lastCombatCueAt = Date.now(); this.sayCurrent(this.t('voice.missed'),this.phaseGuard('fight'));
    }
  }

  /** Final resolution arrives from the same server loop that publishes the world event. */
  onVoiceCommandOutcomes(outcomes: readonly FighterVoiceCommandOutcome[]): void {
    for(const outcome of outcomes){
      if(!this.pendingCommandIds.delete(outcome.requestId))continue;
      if(outcome.status==='rejected')this.reportRejectedCommand(outcome);
    }
  }

  private submitCommands(commands: readonly FighterCommand[]): void {
    if(!this.code||!this.playerId||!commands.length)return;
    if(commands.length>=2&&this.deps.commandSequence){
      const pair:[FighterCommand,FighterCommand]=[commands[0]!,commands[1]!];
      const ids:[string,string]=[this.commandRequestId(),this.commandRequestId()];
      const outcomes=this.deps.commandSequence(this.code,this.playerId,pair,ids);
      outcomes.forEach(outcome=>this.trackCommandOutcome(outcome));
      return;
    }
    for(const command of commands){
      const requestId=this.commandRequestId();
      const outcome=this.deps.command(this.code,this.playerId,command,requestId);
      if(typeof outcome==='boolean'){
        if(!outcome)this.reportRejectedCommand({requestId,command,status:'rejected',reason:'not_fighting'});
      }else this.trackCommandOutcome(outcome);
    }
  }
  private commandRequestId():string{return `fighter:${this.callSid??'call'}:${++this.nextCommandId}`;}
  private trackCommandOutcome(outcome:FighterVoiceCommandOutcome):void{
    if(outcome.status==='queued')this.pendingCommandIds.add(outcome.requestId);
    else if(outcome.status==='rejected')this.reportRejectedCommand(outcome);
  }
  private reportRejectedCommand(outcome:FighterVoiceCommandOutcome):void{
    if(outcome.reason==='superseded'||outcome.reason==='match_over'||outcome.reason==='player_left')return;
    const key=outcome.reason==='expired'?'voice.commandExpired':'voice.commandNotReady';
    this.sayCurrent(this.t(key),this.phaseGuard('fight'));
  }

  private backOrExplain(snapshot:FighterVoiceSnapshot):void{
    if(!this.deps.back?.(this.code!,this.playerId!))this.sayCurrent(this.t('voice.roomNotReady'));
    else this.awaitingName=false;
  }

  private interpret(transcript:string,snapshot:FighterVoiceSnapshot):boolean{
    if(!this.deps.interpret)return false;
    const actions=this.semanticActions(snapshot),facts=this.semanticFacts(snapshot);
    if(!actions.length&&!facts.length)return false;
    const choices=(snapshot.phase==='fighter_select'?snapshot.fighters
      :snapshot.phase==='map_select'?snapshot.maps:[]).map(choice=>({id:choice.id,label:choice.name}));
    const epoch=++this.semanticEpoch,scope=this.semanticScope(snapshot);
    const controller=new AbortController();this.semanticController=controller;this.semanticScopeAtRequest=scope;
    const request:VoiceInterpretRequest={game:'fighter',phase:snapshot.phase,locale:this.commandLocale,
      transcript,actions,choices,facts,signal:controller.signal};
    void this.deps.interpret(request).then(result=>{
      if(!this.semanticCurrent(epoch,scope,controller))return;
      const current=this.deps.snapshot(this.code!,this.playerId!,this.commandLocale);if(!current)return;
      if(result.kind==='action')this.executeSemanticAction(result,current,actions);
      else if(result.kind==='answer'){
        const fact=this.semanticFacts(current).find(candidate=>candidate.id===result.factId);
        if(fact)this.sayCurrent(fact.text,()=>this.semanticCurrent(epoch,scope,controller));
      }else if(result.kind==='clarify')this.speakClarification(result.reason,current);
      else this.sayCurrent(this.t('voice.noAction'));
    }).catch(()=>{
      if(this.semanticCurrent(epoch,scope,controller)){
        const current=this.deps.snapshot(this.code!,this.playerId!,this.commandLocale);
        if(current)this.speakContext(current);
      }
    }).finally(()=>{if(this.semanticController===controller){this.semanticController=null;this.semanticScopeAtRequest=null;}});
    return true;
  }

  private speakClarification(reason:string,snapshot:FighterVoiceSnapshot):void{
    if(reason==='unsupported'){this.sayCurrent(this.t('voice.noAction'));return;}
    if(snapshot.phase==='fighter_select')this.sayCurrent(this.t('voice.clarifyFighter'));
    else if(snapshot.phase==='map_select')this.sayCurrent(this.t('voice.clarifyArena'));
    else if(snapshot.phase==='fight')this.sayCurrent(this.t('voice.clarifyCommand'));
    else this.speakContext(snapshot);
  }

  private semanticActions(snapshot:FighterVoiceSnapshot):VoiceInterpretAction[]{
    switch(snapshot.phase){
      case 'lobby': return this.isNameConfirmed(snapshot)&&this.hasExpectedPlayers(snapshot)
        ?[{id:'advance',description:'Continue to the fighter selection on the shared display.'}]:[];
      case 'fighter_select': return [
        {id:'select_fighter',description:'Choose or change this caller’s playable fighter.',
          targetIds:snapshot.fighters.filter(fighter=>fighter.id!==snapshot.foeFighterId).map(fighter=>fighter.id)},
        {id:'advance',description:'Continue to arena selection once every fighter is chosen.'},
        {id:'back_setup',description:'Go back to the previous setup screen.'},
      ];
      case 'map_select':return [
        {id:'select_map',description:'Choose or change this caller’s arena vote.',targetIds:snapshot.maps.map(map=>map.id)},
        {id:'advance',description:'Start the fight once every required arena vote is in.'},
        {id:'back_setup',description:'Go back to fighter selection.'},
      ];
      case 'loading':return [{id:'back_setup',description:'Cancel loading and return to arena selection.'}];
      case 'intro':return snapshot.playerCount===1?[
        {id:'start_now',description:'Skip the optional introduction and countdown; start this solo fight now.'},
        {id:'skip_intro',description:'Skip only the optional fighter introduction and begin the countdown.'},
      ]:[];
      case 'countdown':return snapshot.playerCount===1
        ?[{id:'start_now',description:'Skip the remaining countdown and start this solo fight now.'}]:[];
      case 'fight':return (['forward','back','jump','punch','kick','block'] as const).map(command=>({
        id:`command:${command}`,description:`Perform the ${command} fighting control now for this caller only.`,
      }));
      case 'victory':return this.deps.showResults
        ?[{id:'show_results',description:'Skip the optional victory celebration and reveal the result on the shared display now.'}]:[];
      case 'results':return snapshot.resultsPresented===false&&snapshot.resultsPresentationTimedOut!==true
        ?this.deps.showResults?[{id:'show_results',description:'Reveal the result on the shared display now.'}]:[]
        :this.stationManaged?[]
          :[{id:'rematch',description:'Replay by returning to fighter selection after the result is visible or display recovery has timed out.'}];
      default:return [];
    }
  }

  private semanticFacts(snapshot:FighterVoiceSnapshot):VoiceInterpretFact[]{
    const facts:VoiceInterpretFact[]=[{id:'help',text:snapshot.phase==='fight'
      ?this.t('voice.fightHelp'):this.contextText(snapshot)}];
    if(snapshot.phase==='fighter_select')facts.push({id:'fighters',text:
      this.t('voice.availableFighters',{names:snapshot.fighters.map(fighter=>fighter.name).join(', ')})});
    if(snapshot.phase==='map_select')facts.push({id:'arenas',text:
      this.t('voice.availableArenas',{names:snapshot.maps.map(map=>this.localizedMapName(map)).join(', ')})});
    if(snapshot.phase==='fight')facts.push({id:'health',text:snapshot.hudPresented
      ?this.t('voice.currentHealth',{mine:formatNumber(this.commandLocale,snapshot.myHealth??100),
        theirs:formatNumber(this.commandLocale,snapshot.foeHealth??100)})
      :this.t('voice.healthOnDisplay')});
    if((snapshot.phase==='victory'||snapshot.phase==='results'
      &&(snapshot.resultsPresented!==false||snapshot.resultsPresentationTimedOut===true))&&snapshot.winnerName)
      facts.push({id:'winner',text:snapshot.winnerSide===snapshot.mySide?this.t('voice.youWin')
        :this.t('voice.winnerWins',{name:snapshot.winnerName})});
    return facts;
  }

  private contextText(snapshot:FighterVoiceSnapshot):string{
    if(snapshot.phase==='fighter_select')return this.t('voice.choiceFighter');
    if(snapshot.phase==='map_select')return this.t('voice.choiceArena');
    if(snapshot.phase==='fight')return this.t('voice.fightHelp');
    if(snapshot.phase==='loading'||snapshot.phase==='intro'||snapshot.phase==='countdown')return this.t('voice.getReady');
    if(snapshot.phase==='victory')return this.t('voice.victoryPlaying');
    if(snapshot.phase==='results')return snapshot.resultsPresentationTimedOut===true&&!snapshot.resultsPresented
      ?this.t('voice.resultsDisplayTimeout',{winner:snapshot.winnerName??this.t('voice.winnerFallback')})
      :snapshot.resultsPresented===false?this.t('voice.waitResultsDisplay')
        :this.stationManaged?this.t('voice.waitOperator')
          :this.t(snapshot.isController?'voice.controllerRematch':'voice.playerOneRematch');
    return this.t('voice.sayStart');
  }

  private executeSemanticAction(result:Extract<VoiceInterpretResult,{kind:'action'}>,snapshot:FighterVoiceSnapshot,
    permitted:readonly VoiceInterpretAction[]):void{
    const action=permitted.find(candidate=>candidate.id===result.actionId);
    if(!action)return;
    if(action.targetIds&&!action.targetIds.includes(result.targetId??''))return;
    if(result.actionId==='select_fighter'){
      const fighter=snapshot.fighters.find(candidate=>candidate.id===result.targetId);if(!fighter)return;
      this.applyingSelection=true;const selected=this.deps.selectFighter(this.code!,this.playerId!,fighter.id);this.applyingSelection=false;
      if(!selected)this.sayCurrent(this.t('voice.fighterUnavailable',{name:fighter.name}));
      else this.speakContext(this.deps.snapshot(this.code!,this.playerId!,this.commandLocale)??snapshot);
    }else if(result.actionId==='select_map'){
      const map=snapshot.maps.find(candidate=>candidate.id===result.targetId);if(!map)return;
      this.applyingSelection=true;const selected=this.deps.selectMap(this.code!,this.playerId!,map.id);this.applyingSelection=false;
      if(!selected)this.sayCurrent(this.t('voice.mapUnavailable',{name:this.localizedMapName(map)}));
      else this.speakContext(this.deps.snapshot(this.code!,this.playerId!,this.commandLocale)??snapshot);
    }else if(result.actionId==='advance'||result.actionId==='rematch'){
      if(snapshot.phase==='results'&&this.stationManaged)
        this.sayCurrent(this.contextText(snapshot));
      else this.advanceOrExplain(snapshot);
    }else if(result.actionId==='show_results'){
      if(!this.deps.showResults?.(this.code!,this.playerId!))this.sayCurrent(this.contextText(snapshot));
    }else if(result.actionId==='back_setup')this.backOrExplain(snapshot);
    else if(result.actionId==='start_now'){
      if(!this.deps.startNow?.(this.code!,this.playerId!))this.sayCurrent(this.t('voice.waitTogether'));
    }else if(result.actionId==='skip_intro'){
      if(!this.deps.skipIntro?.(this.code!,this.playerId!))this.sayCurrent(this.t('voice.waitTogether'));
    }else if(result.actionId.startsWith('command:'))this.submitCommands([result.actionId.slice(8) as FighterCommand]);
  }

  private semanticScope(snapshot:FighterVoiceSnapshot):string{
    return [snapshot.phase,this.isNameConfirmed(snapshot),snapshot.myFighterId,snapshot.foeFighterId,
      snapshot.myMapVote,snapshot.selectedMap,snapshot.winnerSide,snapshot.resultsPresented,
      snapshot.resultsPresentationTimedOut].join('|');
  }
  private semanticCurrent(epoch:number,scope:string,controller:AbortController):boolean{
    if(controller.signal.aborted||epoch!==this.semanticEpoch||!this.code||!this.playerId)return false;
    const snapshot=this.deps.snapshot(this.code,this.playerId,this.commandLocale);
    return Boolean(snapshot&&this.semanticScope(snapshot)===scope);
  }
  private abortSemantic():void{this.semanticEpoch++;this.semanticController?.abort();this.semanticController=null;this.semanticScopeAtRequest=null;}

  private finalContext(snapshot: FighterVoiceSnapshot | null): string {
    return `${snapshot?.phase??'unavailable'}:${snapshot?.nameConfirmed??''}:${snapshot?.myFighterId??''}:${snapshot?.myMapVote??''}`;
  }

  private advanceOrExplain(snapshot: FighterVoiceSnapshot): void {
    if(snapshot.phase==='results'&&snapshot.resultsPresented===false
      &&snapshot.resultsPresentationTimedOut!==true){
      this.sayCurrent(this.t('voice.waitResultsDisplay'));return;
    }
    if (!this.isNameConfirmed(snapshot) && snapshot.phase === 'lobby') { this.sayCurrent(this.t('voice.nameBeforeStart')); return; }
    if(snapshot.phase==='lobby'&&!this.hasExpectedPlayers(snapshot)){this.sayWaitOnce(this.t('voice.waitingLobbyPlayers'));return;}
    if (snapshot.phase === 'fighter_select' && !this.hasExpectedPlayers(snapshot)) { this.sayWaitOnce(this.t('voice.waitingPlayerTwo')); return; }
    if (!this.deps.advance(this.code!, this.playerId!)) {
      this.sayCurrent(this.t(snapshot.phase === 'fighter_select' ? (snapshot.myFighterId?'voice.waitingFighterChoices':'voice.chooseFighterFirst')
        : snapshot.phase === 'map_select' ? (snapshot.myMapVote?'voice.waitingMapVotes':'voice.chooseArenaFirst')
          : snapshot.phase === 'victory' ? 'voice.victoryPlaying' : 'voice.roomNotReady'));
    }
  }

  private speakContext(snapshot: FighterVoiceSnapshot): void {
    const confirmed=this.isNameConfirmed(snapshot);
    const say=(text:string)=>{
      const guard=this.phaseGuard(snapshot.phase,confirmed);
      this.sayCurrent(text,()=>guard()&&(snapshot.phase!=='results'
        ||(this.deps.snapshot(this.code!,this.playerId!,this.commandLocale)?.resultsPresented===snapshot.resultsPresented
          &&this.deps.snapshot(this.code!,this.playerId!,this.commandLocale)?.resultsPresentationTimedOut===snapshot.resultsPresentationTimedOut)));
    };
    if(!confirmed){say(this.t('voice.tellName'));return;}
    if (snapshot.phase === 'lobby') {
      if (!this.authoritativeName&&this.isPlaceholderName(snapshot.myName)) say(this.t('voice.tellName'));
      else if(snapshot.automaticSetup&&!this.hasExpectedPlayers(snapshot))say(this.t('voice.waitingLobbyPlayers'));
      else say(this.t('voice.sayStart'));
    } else if (snapshot.phase === 'fighter_select') {
      if (snapshot.myFighterName) say(!this.hasExpectedPlayers(snapshot) ? this.t('voice.waitingPlayerTwo')
        :this.t(this.areFighterChoicesReady(snapshot)?'voice.yourFighterNext':'voice.yourFighterWaiting',{name:snapshot.myFighterName}));
      else say(this.t('voice.choiceFighter'));
    } else if (snapshot.phase === 'map_select') {
      if(snapshot.automaticSetup&&snapshot.myMapVote){
        const choice=snapshot.maps.find(map=>map.id===snapshot.myMapVote);
        say(this.t(this.areMapVotesReady(snapshot)?'voice.mapVote':'voice.mapVoteWait',
          {name:choice?this.localizedMapName(choice):snapshot.myMapVote}));
      }else if(!snapshot.automaticSetup&&snapshot.selectedMap){
        const choice=snapshot.maps.find(map=>map.id===snapshot.selectedMap);
        say(this.t('voice.mapIsSelected',{name:choice?this.localizedMapName(choice):snapshot.selectedMap}));
      }else say(this.t('voice.choiceArena'));
    } else if (snapshot.phase === 'loading') say(this.t('voice.getReady'));
    else if (snapshot.phase === 'intro') {
      const stage = fighterIntroStage(snapshot.intro ?? FIGHTER_INTRO_SECONDS); this.lastIntroStage = stage; this.speakIntroCue(snapshot, stage);
    }
    else if (snapshot.phase === 'countdown') say(this.t('voice.getReady'));
    else if (snapshot.phase === 'fight') say(this.lastPhase === 'countdown' ? this.t('voice.fight')
      : snapshot.hudPresented===false ? this.t('voice.fightHelp')
        : this.t('voice.fightProgress', { health: formatNumber(this.commandLocale, snapshot.myHealth ?? 100) }));
    else if (snapshot.phase === 'victory') {
      say(snapshot.winnerSide === snapshot.mySide ? this.t('voice.youWin')
        : this.t('voice.winnerWins', { name: snapshot.winnerName ?? this.t('voice.winnerFallback') }));
    } else if (snapshot.phase === 'results') say(snapshot.resultsPresentationTimedOut===true&&!snapshot.resultsPresented
      ? this.contextText(snapshot)
      : snapshot.resultsPresented===false ? this.t('voice.waitResultsDisplay') : this.stationManaged
        ? this.t('voice.waitOperator')
        : this.t(snapshot.isController ? 'voice.controllerRematch' : 'voice.playerOneRematch'));
  }

  private speakIntroCue(snapshot: FighterVoiceSnapshot, stage: FighterIntroStage): void {
    const say = (text: string) => this.sayCurrent(text, this.phaseGuard('intro'));
    if (stage === 'p1') say(this.t('voice.introPlayerOne', {
      name: snapshot.playerOneName ?? this.t('voice.playerOneFallback'), fighter: snapshot.playerOneFighterName ?? this.t('voice.theirFighter'),
    }));
    else if (stage === 'versus') say(this.t('voice.versus'));
    else if (stage === 'p2') say(this.t('voice.introPlayerTwo', {
      name: snapshot.playerTwoName ?? this.t('voice.rivalFallback'), fighter: snapshot.playerTwoFighterName ?? this.t('voice.theirFighter'),
    }));
    else say(this.t('voice.fightersReady'));
  }

  private localizedMapName(map: { id: string; name: string }): string {
    const key = FIGHTER_MAP_NAME_KEYS[map.id];
    return key ? this.t(key) : map.name;
  }

  private isPlaceholderName(name: string | null): boolean {
    return !name || name === 'Caller' || name === 'Jogador';
  }
  private isNameConfirmed(snapshot:FighterVoiceSnapshot):boolean{
    return Boolean(this.authoritativeName)||(snapshot.nameConfirmed??!this.isPlaceholderName(snapshot.myName));
  }

  private hasExpectedPlayers(snapshot: FighterVoiceSnapshot): boolean {
    return snapshot.hasExpectedPlayers ?? (this.stationAssignment
      ? snapshot.playerCount >= this.stationAssignment.expectedPlayers
      : true);
  }

  private isLobbyReady(snapshot:FighterVoiceSnapshot):boolean{
    return snapshot.phase==='lobby'&&this.hasExpectedPlayers(snapshot)
      &&(snapshot.nameConfirmed??!this.isPlaceholderName(snapshot.myName))
      &&(snapshot.playerCount<2||!this.isPlaceholderName(snapshot.foeName));
  }

  private areFighterChoicesReady(snapshot:FighterVoiceSnapshot):boolean{
    return snapshot.phase==='fighter_select'&&this.hasExpectedPlayers(snapshot)&&snapshot.allFightersSelected;
  }

  private areMapVotesReady(snapshot:FighterVoiceSnapshot):boolean{
    return snapshot.phase==='map_select'&&this.hasExpectedPlayers(snapshot)&&snapshot.allMapVotes;
  }

  private resetInterim(): void { this.interimCandidate = null; this.interimCount = 0; this.interimFiredCommand = null; }
  private sayWaitOnce(message:string):void{if(message===this.lastWaitCue)return;this.lastWaitCue=message;this.sayCurrent(message);}
  private phaseGuard(expected:FighterPhase,nameConfirmed?:boolean):()=>boolean{
    const code=this.code,playerId=this.playerId,epoch=this.speechEpoch;
    const initial=code&&playerId?this.deps.snapshot(code,playerId,this.commandLocale):null;
    const scope=initial&&initial.phase===expected?this.speechScope(initial):null;
    return()=>{
      if(!code||!playerId||this.code!==code||this.playerId!==playerId||this.speechEpoch!==epoch||scope===null)return false;
      const snapshot=this.deps.snapshot(code,playerId,this.commandLocale);
      return Boolean(snapshot&&snapshot.phase===expected&&this.speechScope(snapshot)===scope
        &&(nameConfirmed===undefined||this.isNameConfirmed(snapshot)===nameConfirmed));
    };
  }

  handleClose(): void {
    const preserve=this.stationManaged&&this.code&&this.playerId
      &&['victory','results'].includes(this.deps.snapshot(this.code,this.playerId,this.commandLocale)?.phase??'');
    if(this.code&&this.playerId&&!preserve)this.deps.leave(this.code,this.playerId,this.callSid??'');
    this.clear();
  }
  handleReplaced(): void { this.clear(); }
  private clear(): void { this.speechEpoch++;this.abortSemantic();this.pendingCommandIds.clear();this.code = null; this.playerId = null; this.callSid = null; }
}

export function matchVoiceChoice(spoken: string, maps: { id: string; name: string }[], locale: SupportedLocale = DEFAULT_LOCALE): { id: string; name: string } | null {
  const raw = normalizeForMatching(spoken, locale);
  if(/^(?:which|what|who|how|why|when|is|are|can you tell|tell me about|qual|quais|quem|como|quando|por que|o que)\b/.test(raw))return null;
  const correction=locale==='pt-BR'
    ? /\b(?:nao|quer dizer|na verdade|em vez de|melhor)\b/g
    : /\b(?:no|i mean|actually|instead|rather|wait)\b/g;
  const matches=[...raw.matchAll(correction)];
  const text=matches.length?raw.slice(matches.at(-1)!.index!+matches.at(-1)![0].length).trim():raw;
  if(!text||/\b(?:not|dont|do not|never|nao|nunca|sem|or|ou)\b/.test(text))return null;
  const numberWords = locale === 'pt-BR'
    ? ['(?:um|uma)', '(?:dois|duas)', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze']
    : ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const ordinals = locale === 'pt-BR'
    ? ['primeir[oa]', 'segund[oa]', 'terceir[oa]', 'quart[oa]', 'quint[oa]', 'sext[oa]', 'setim[oa]', 'oitav[oa]', 'non[oa]', 'decim[oa]']
    : ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
  const numericCue=/\b(?:number|option|choice|numero|opcao|escolha)\b/.test(text);
  const bareNumber=text.split(/\s+/).length<=2;
  const digit = numericCue||bareNumber?text.match(/\b(1[0-2]|[1-9])\b/):null;
  const wordIndex = numericCue||bareNumber
    ?numberWords.findIndex(word => new RegExp(`\\b${word}\\b`).test(text)):-1;
  const compoundOrdinal = locale === 'pt-BR' ? text.match(/\bdecim[oa] (primeir[oa]|segund[oa])\b/) : null;
  const ordinalIndex = compoundOrdinal ? (compoundOrdinal[1]!.startsWith('primeir') ? 10 : 11)
    : ordinals.findIndex(word => new RegExp(`\\b${word}\\b`).test(text));
  const choiceIndex = digit ? Number(digit[1]) - 1 : ordinalIndex >= 0 ? ordinalIndex : wordIndex;
  if (choiceIndex >= 0 && maps[choiceIndex]) return maps[choiceIndex];
  return maps.find(map => containsChoicePhrase(text,normalizeForMatching(map.id,locale)) || containsChoicePhrase(text,normalizeForMatching(map.name,locale)))
    ?? maps.find(map => (VOICE_CHOICE_ALIASES[map.id] ?? []).some(alias => containsChoicePhrase(text,normalizeForMatching(alias,locale))))
    ?? maps.find(map => {
      const first = normalizeForMatching(map.name, locale).split(' ')[0];
      return first && text === first && maps.filter(candidate => normalizeForMatching(candidate.name, locale).split(' ')[0] === first).length === 1;
    })
    ?? (text.includes('neon') ? maps.find(map => map.id === 'foundry') : text.includes('circuit') ? maps.find(map => map.id === 'void') : null)
    ?? null;
}

const matchChoice = matchVoiceChoice;
function containsChoicePhrase(text:string,phrase:string):boolean{
  if(!phrase)return false;
  const escaped=phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');
  return new RegExp(`(?:^|\\b)${escaped}(?:$|\\b)`).test(text);
}
const VOICE_CHOICE_ALIASES: Record<string, string[]> = {
  nyx: ['nix', 'nicks', 'nick'], wraith: ['wreath', 'raith', 'espectro'], 'remy-riot': ['remy', 'remi riot', 'remy revolta'],
  'cinder-capone': ['cinder', 'brasa capone'], 'rune-warden': ['rune', 'guardiao runico'], 'shroom-boom': ['shroom', 'mushroom', 'cogumelo bomba'],
  'gran-slam': ['grand slam', 'gran', 'vo pancada'], 'bass-nova': ['bass', 'grave nova'], 'velvet-thunder': ['velvet', 'trovao de veludo'],
  'iron-oni': ['iron', 'oni de ferro'], bulkhead: ['bulk head', 'blindado'], 'sir-knockout': ['knockout', 'sir nocaute'],
  foundry: ['fundição neon', 'fundicao neon'], void: ['circuito do vazio'],
  'cyberpunk-city': ['cidade cyberpunk'],
  inakaya: ['restaurante inakaya', 'inakaya restaurant', 'ina kaya', 'in a kaya', 'in akaya', 'innakaya', 'inikaya', 'izakaya'],
  rain: ['chuva'],
};
const FIGHTER_MAP_NAME_KEYS: Record<string, FighterMessageKey> = {
  foundry: 'content.mapName.foundry', void: 'content.mapName.void', 'cyberpunk-city': 'content.mapName.cyberpunk-city',
  inakaya: 'content.mapName.inakaya', rain: 'content.mapName.rain',
};

function isFighterAdvanceWord(spoken: string, locale: SupportedLocale): boolean {
  if (locale === 'en-US') return isEnglishAdvanceWord(spoken);
  const text = normalizeForMatching(spoken, locale);
  if(isFighterQuestionOrNegation(text,locale))return false;
  if (/\b(?:comecar|iniciar|avancar|proxim[oa]|continuar|lutar|luta|combater|pront[oa]|revanche|jogar de novo|jogar novamente|mais uma vez)\b/.test(text)) return true;
  return /\b(?:escolher|escolha|selecionar|selecione)\b/.test(text) && /\b(?:lutador|personagem|campeao)\b/.test(text);
}

function isFighterQuestionOrNegation(text:string,locale:SupportedLocale):boolean{
  return locale==='pt-BR'
    ? /\b(?:nao|nunca|sem|talvez)\b/.test(text)||/^(?:quando|como|por que|qual|quais|devo|posso)\b/.test(text)
    : /\b(?:not|dont|do not|never|maybe)\b/.test(text)||/^(?:when|how|why|which|what|should|can i|could i)\b/.test(text);
}

function isFighterSetupBack(spoken:string,locale:SupportedLocale):boolean{
  const text=normalizeForMatching(spoken,locale);
  if(isFighterQuestionOrNegation(text,locale))return false;
  return locale==='pt-BR'
    ? /^(?:voltar|volte|retornar|tela anterior|escolher de novo|mudar minha escolha)(?:\b|$)/.test(text)
    : /^(?:go back|back to|previous|return to|change my choice|choose again)(?:\b|$)/.test(text);
}

function isFighterStartNow(spoken:string,locale:SupportedLocale):boolean{
  const text=normalizeForMatching(spoken,locale);
  if(isFighterQuestionOrNegation(text,locale))return false;
  return locale==='pt-BR'
    ? /\b(?:comecar|iniciar|lutar|luta)\b/.test(text)&&/\b(?:agora|ja|direto)\b/.test(text)
    : /\b(?:start|fight|fighting|go)\b/.test(text)&&/\b(?:now|already|immediately|straight|skip)\b/.test(text);
}

function isFighterSkipIntro(spoken:string,locale:SupportedLocale):boolean{
  const text=normalizeForMatching(spoken,locale);
  if(isFighterQuestionOrNegation(text,locale))return false;
  return locale==='pt-BR'
    ? /\b(?:pular|saltar|ignorar)\b/.test(text)&&/\b(?:introducao|apresentacao|abertura)\b/.test(text)
    : /\b(?:skip|cut|bypass)\b/.test(text)&&/\b(?:intro|introduction|opening)\b/.test(text);
}

function isFighterShowResultsWord(spoken:string,locale:SupportedLocale):boolean{
  const text=normalizeForMatching(spoken,locale);
  if(isFighterQuestionOrNegation(text,locale))return false;
  return locale==='pt-BR'
    ? /^(?:pular|ignorar|mostrar|mostre|ver|quero ver)(?:\s+(?:a|o|os))?\s*(?:resultado|resultados|vitoria|comemoracao)?(?:\s+agora)?$/.test(text)
    : /^(?:skip|cut|bypass)(?:\s+(?:the|this))?\s*(?:celebration|result|results|victory)?$/.test(text)
      ||/^(?:show|see|reveal)(?:\s+me)?(?:\s+the)?\s+results?(?:\s+now)?$/.test(text);
}

function isFighterContinueResultWord(spoken:string,locale:SupportedLocale):boolean{
  const text=normalizeForMatching(spoken,locale);
  if(isFighterQuestionOrNegation(text,locale))return false;
  return locale==='pt-BR'
    ? /^(?:proxim[oa]|continuar|seguir|pode seguir)$/.test(text)
    : /^(?:next|continue|go on|keep going|move on)$/.test(text);
}

function isFighterFightAlias(spoken: string, locale: SupportedLocale): boolean {
  return locale === 'en-US' && /^(?:flight|fights)$/.test(normalizeForMatching(spoken, locale));
}

function isFighterStarAlias(spoken:string,locale:SupportedLocale):boolean{
  return locale==='en-US'&&normalizeForMatching(spoken,locale)==='star';
}

function parseFighterSpokenName(spoken: string, locale: SupportedLocale): string | null {
  return parseFirstName(spoken, locale);
}

function isExplicitName(spoken: string, locale: SupportedLocale): boolean {
  return isExplicitSpokenName(spoken, locale);
}

function isHelpRequest(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /\b(?:ajuda|instrucoes|o que posso dizer|onde estou|status)\b/.test(text)
    : /\b(?:help|instructions|what can i say|where am i|status)\b/.test(text);
}
