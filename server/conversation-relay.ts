import type { Intent, GameEvent, RaceResult } from '../shared/types';
import { intentsFromTranscript } from './voice-intent';
import { greetingLines, lineForEvent, isChattyEvent, raceOverLine, ordinal } from './voice-lines';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { RACER_MESSAGES } from '../shared/i18n/racer';
import { createTranslator, normalizeForMatching } from '../shared/i18n/translate';

export type CrMessage =
  | { type:'setup'; callSid:string; from?:string; customParameters: Record<string,string> }
  | { type:'prompt'; voicePrompt:string; last:boolean }
  | { type:'dtmf'; digit:string }
  | { type:'interrupt'; utteranceUntilInterrupt:string; durationUntilInterruptMs:number }
  | { type:'error'; description:string }
  | { type:'unknown' };

export function parseCrMessage(raw: string): CrMessage {
  let o: any;
  try { o = JSON.parse(raw); } catch { return { type:'unknown' }; }
  if (!o || typeof o.type !== 'string') return { type:'unknown' };
  switch (o.type) {
    case 'setup':
      return { type:'setup', callSid: String(o.callSid ?? ''),
        ...(typeof o.from === 'string' ? { from: o.from } : {}),
        customParameters: (o.customParameters && typeof o.customParameters === 'object')
          ? o.customParameters : {} };
    case 'prompt':
      if (typeof o.voicePrompt !== 'string') return { type:'unknown' };
      return { type:'prompt', voicePrompt: o.voicePrompt, last: o.last === true };
    case 'dtmf':
      return { type:'dtmf', digit: String(o.digit ?? '') };
    case 'interrupt':
      // Sent when the caller's speech (barge-in) cuts the TTS. utteranceUntilInterrupt = the part of
      // our reply that actually played; durationUntilInterruptMs = how long it played.
      return { type:'interrupt',
        utteranceUntilInterrupt: String(o.utteranceUntilInterrupt ?? ''),
        durationUntilInterruptMs: Number(o.durationUntilInterruptMs ?? 0) || 0 };
    case 'error':
      return { type:'error', description: String(o.description ?? '') };
    default:
      return { type:'unknown' };
  }
}

export type RoomLike = {
  addPlayer(name: string, color?: string, preferredIndex?: number, nameConfirmed?: boolean): { playerId: string; lane: number } | { error: string };
  expectHumanPlayers?(count:number,stationManaged?:boolean):void;
  applyIntent(id: string, intent: Intent): boolean|void;
  removePlayer(id: string): void;
  readonly playerCount?:number;
  hasConfirmedName?(playerId: string): boolean;
  isWaitingForNextRound?(playerId: string): boolean;
  canAdvance?(playerId?: string): boolean;
  results?(): readonly RaceResult[];
};

const DTMF_TO_INTENT: Record<string, Intent> = {
  '1': 'MOVE_LEFT', '2': 'BOOST', '3': 'MOVE_RIGHT', '4': 'BRAKE', '5': 'USE_POWER',
};

/** Min gap between mid-race "arcade" voice lines to a caller, so they stay fun (not spammy) and don't
 *  talk over the caller's spoken commands. 2s → snappy, reactive, still not a constant stream. */
const CHATTY_GAP_MS = 2000;

/** Everything the adapter needs from its host to TALK BACK to the caller + hook game events. All
 *  optional so existing callers/tests that only drive intents keep working unchanged. */
export interface AdapterDeps {
  findOrCreateRoom: (code: string) => RoomLike | null;
  /** Rebind a reconnecting Conversation Relay transport to its existing Racer player. */
  resumePlayer?: (callSid: string, roomCode: string) => { playerId: string; lane: number; resumed?: boolean; name?:string } | null;
  /** Speak a line to the caller (host wires this to a Relay `{type:'text'}` WS send). */
  say?: (text: string, isCurrent?: () => boolean) => unknown;
  /** Register/unregister this adapter to receive its room's game events (greeting/countdown/result). */
  register?: (roomCode: string, adapter: ConversationRelayAdapter) => void;
  unregister?: (adapter: ConversationRelayAdapter) => void;
  /** Drop the caller's player slot AND reap the room if now empty (a phone caller never hits the WS
   *  close/leave reap paths, so this avoids a voice-only room leaking). Falls back to plain
   *  removePlayer when absent (keeps existing tests/callers working). */
  leaveRoom?: (roomCode: string, playerId: string) => void;
  /** Run a conversational AI turn for this caller: given their utterance, return what the host should
   *  SAY back (having also executed any game actions), or null to fall back to scripted behavior.
   *  Wired to the LLM game-host. Absent → no conversational AI (scripted-only, current behavior).
   *  `phase` lets the caller decide command-vs-chat routing. */
  converse?: (roomCode: string, playerId: string, utterance: string, locale: SupportedLocale,
    isCurrent: () => boolean, readOnlyInquiry?: boolean) => Promise<string | { text: string; phase: string } | null>;
  /** Snapshot the authoritative finish and current-track leaderboard synchronously at race_over.
   *  A station can retire this room before an asynchronous host turn finishes. */
  resultRecap?: (roomCode: string, playerId: string, locale: SupportedLocale,
    stationManaged: boolean) => string | null;
  /** The room's current phase, so the adapter routes: race → fast commands; else → conversation. */
  phaseOf?: (roomCode: string) => string;
  hasPlayerName?: (roomCode: string, playerId: string) => boolean;
  onSetupChanged?: (roomCode:string,beforePhase:string) => void;
  handleSetupUtterance?: (roomCode:string,playerId:string,utterance:string,locale:SupportedLocale) => string|null;
  setupTurnFor?: (roomCode:string,playerId:string,phase:string) => 'active'|'waiting';
  /** Accepted semantic commands only; raw transcripts are deliberately never exposed to analytics. */
  onIntent?: (intent: Intent) => void;
}

export class ConversationRelayAdapter {
  private room: RoomLike | null = null;
  private playerId: string | null = null;
  private roomCode: string | null = null;
  // Partial transcripts are revisable, so only a final frame can mutate the race.
  // Turn epoch for barge-in: bumped on every new final utterance AND on every interrupt. An in-flight
  // conversational reply captures the epoch it was requested under; if the epoch has since moved
  // (caller interrupted or spoke again), the stale reply is DROPPED instead of spoken over them.
  private turnEpoch = 0;
  /** A spoken barge-in skips the short call introduction even if it was still queued. */
  private introEpoch = 0;
  private introExpired = false;
  private introPhase: string | null = null;
  /** Results audio may outlive station room retirement, but never a new caller utterance. */
  private resultSpeechEpoch = 0;
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private authoritativeName: string | null = null;
  private stationManaged=false;
  private stationParticipantIndex = 0;
  private stationParticipantCount = 1;
  private active=true;
  private callSid='';
  private setupPromptPhase:string|null=null;
  private lastFinalCommand:{text:string;at:number;source:'setup'|'race'}|null=null;
  private awaitingName=false;
  constructor(private deps: AdapterDeps) {}

  setAuthoritativeName(name: string | null): void {
    this.authoritativeName = name?.trim().slice(0, 50) || null;
  }
  setStationManaged(active:boolean):void{this.stationManaged=active;}
  setStationAssignment(index: number, count: number): void {
    this.stationParticipantIndex = index === 1 ? 1 : 0;
    this.stationParticipantCount = count >= 2 ? 2 : 1;
  }

  /** The caller's bound player id (null until setup binds them) — for event targeting. */
  get boundPlayerId(): string | null { return this.playerId; }
  /** The caller's room code (null until bound) — so the registry can route events. */
  get boundRoomCode(): string | null { return this.roomCode; }
  /** Language selected by Conversation Relay setup; defaults to English for legacy callers. */
  get locale(): SupportedLocale { return this.commandLocale; }

  /** Called by the voice registry when THIS caller's room emits a game event. Speaks the caller-
   *  relevant lines. Key moments (countdown/go/finish) always speak; mid-race "arcade" lines
   *  (hit-streak/fell-to-last/took-lead) are THROTTLED — at most one every CHATTY_GAP ms — so spoken
   *  audio never buries the caller's own left/right/boost. Safe no-op if no `say` sink. */
  private lineSeq = 0;
  private lastChattyAt = -1e9;
  private recapDone = false;   // one proactive results recap per race (reset on a new countdown/go)
  private resultRecapText: string | null = null;
  private resultWinnerName: string | null = null;
  private resultStandings: readonly RaceResult[] = [];
  private pendingSpeech = new Set<Promise<void>>();
  private lateRacingPromptUntil = 0;
  private lateRacingPromptActive = false;
  private myFinishPlace: number | null = null;
  private menuSpeechRevision = 0;
  private lastMenuPrompt: { kind: 'enter_car_select' | 'enter_map_select'; at: number } | null = null;
  onGameEvent(ev: GameEvent): void {
    const eventPhase = ev.kind === 'enter_car_select' || ev.kind === 'car_picked' ? 'car_select'
      : ev.kind === 'enter_map_select' || ev.kind === 'map_picked' ? 'map_select' : null;
    const currentPhase=this.roomCode?this.deps.phaseOf?.(this.roomCode):null;
    if ((currentPhase&&currentPhase!==this.introPhase) || eventPhase!==this.introPhase) this.introExpired=true;
    const now = Date.now();
    if (ev.kind === 'car_picked' || ev.kind === 'map_picked') {
      // A touch can revise the visible choice without changing the phase. Expire queued menu
      // guidance before emitting its replacement; a voice-origin pick keeps its own reply alive.
      this.menuSpeechRevision++;
      if (!('spokenReplyPlayerId' in ev && ev.spokenReplyPlayerId === this.playerId)) this.turnEpoch++;
    }
    if ('spokenReplyPlayerId' in ev && ev.spokenReplyPlayerId === this.playerId) return;
    if (ev.kind === 'go' || ev.kind === 'countdown') {
      this.recapDone = false;
      this.resultRecapText = null;
      this.resultWinnerName = null;
      this.resultStandings = [];
      this.resultSpeechEpoch++;
      this.myFinishPlace = null;
      this.lateRacingPromptUntil = 0;
      this.lateRacingPromptActive = false;
    }
    if (ev.kind === 'enter_car_select' || ev.kind === 'enter_map_select') {
      this.turnEpoch++;
      if (this.lastMenuPrompt?.kind === ev.kind && now - this.lastMenuPrompt.at < 1000) return;
      this.lastMenuPrompt = { kind: ev.kind, at: now };
      const phase=ev.kind==='enter_car_select'?'car_select':'map_select';
      if(this.stationManaged&&this.roomCode&&this.playerId
        &&this.deps.setupTurnFor?.(this.roomCode,this.playerId,phase)==='waiting'){
        this.deps.say?.(createTranslator(this.commandLocale,RACER_MESSAGES)('voice.waitingForPlayers'),
          this.phaseGuard(phase));
        return;
      }
    }
    if(this.stationManaged&&this.roomCode&&this.playerId
      &&((ev.kind==='car_picked'&&ev.playerId!==this.playerId)||
        (ev.kind==='map_picked'&&ev.playerId!==undefined&&ev.playerId!==this.playerId))){
      const phase=ev.kind==='car_picked'?'car_select':'map_select';
      if(this.deps.setupTurnFor?.(this.roomCode,this.playerId,phase)==='active'){
        this.deps.say?.(createTranslator(this.commandLocale,RACER_MESSAGES)(
          phase==='car_select'?'voice.helpCar':'voice.helpMap',
        ),this.phaseGuard(phase));
        return;
      }
    }
    if (isChattyEvent(ev.kind)) {
      if (now - this.lastChattyAt < CHATTY_GAP_MS) return;   // too soon → stay quiet
      const line = lineForEvent(ev, this.playerId, this.lineSeq, this.commandLocale);
      if (line) { this.lastChattyAt = now; this.lineSeq++; this.deps.say?.(line,this.phaseGuardAny('racing')); }
      return;
    }
    if (ev.kind === 'finish' && this.playerId && ev.playerId === this.playerId) {
      this.myFinishPlace = ev.place;
      // At the final finish, race_over follows in the same event batch. Speak the complete
      // standings there, without queueing a second place-only line ahead of it.
      if (this.stationManaged || (this.roomCode
        && ['results', 'finished'].includes(this.deps.phaseOf?.(this.roomCode) ?? ''))) return;
    }
    // The final recap waits for race_over so the room is on the results screen and hostContext has the
    // actual standings. A finish event can fire earlier while other racers are still driving.
    if (ev.kind === 'race_over' && this.playerId && !this.recapDone) {
      if (this.room?.isWaitingForNextRound?.(this.playerId)) return;
      this.requestResultRecap();
      return;
    }
    const line = lineForEvent(ev, this.playerId, this.lineSeq, this.commandLocale);
    if (line) {
      this.lineSeq++;
      const guard = ev.kind === 'enter_car_select' ? this.phaseGuard('car_select')
        : ev.kind === 'enter_map_select' || ev.kind === 'map_picked' ? this.phaseGuard('map_select')
          : ev.kind === 'car_picked' ? this.phaseGuard('car_select')
            : ev.kind === 'countdown' ? this.phaseGuard('countdown')
              : ev.kind === 'go' ? this.phaseGuard('racing')
                : ev.kind === 'finish' ? this.phaseGuardAny('racing','results') : undefined;
      this.deps.say?.(line, guard);
    }
  }

  async whenSpeechSettled(): Promise<void> {
    // An in-flight model turn can enqueue actual playback as it resolves. Recheck the set so
    // station retirement waits for the resulting audio, rather than only for the model response.
    while (this.pendingSpeech.size) await Promise.allSettled([...this.pendingSpeech]);
  }

  private trackResultPlayback(delivery: unknown): void {
    if (!delivery || typeof (delivery as PromiseLike<unknown>).then !== 'function') return;
    let tracked!: Promise<void>;
    tracked = Promise.resolve(delivery as PromiseLike<unknown>).then(() => undefined, () => undefined)
      .finally(() => this.pendingSpeech.delete(tracked));
    this.pendingSpeech.add(tracked);
  }

  private speakResultRecap(text: string, asOneCue = false, guard?: () => boolean): void {
    const lines = asOneCue ? [text] : text.split(/(?<=[.!?])\s+/);
    for (const line of lines.map(part => part.trim()).filter(Boolean)) {
      this.trackResultPlayback(this.deps.say?.(line, guard ?? this.phaseGuardAny('results','finished')));
    }
  }

  private requestResultRecap(): void {
    if (!this.playerId || !this.roomCode || this.recapDone) return;
    if (this.room?.isWaitingForNextRound?.(this.playerId)) return;
    this.recapDone = true;
    const resultEpoch = ++this.resultSpeechEpoch;
    const resultCallSid = this.callSid;
    // The station deliberately tears down its room after the results hold. A committed factual
    // recap must survive that teardown while Relay drains its audio queue; a new caller utterance
    // still invalidates it through resultSpeechEpoch and the transport's queue generation.
    const resultGuard = this.stationManaged
      ? () => this.recapDone && this.resultSpeechEpoch === resultEpoch && this.callSid === resultCallSid
      : this.phaseGuardAny('results','finished');
    this.lateRacingPromptUntil = Date.now() + 10_000;
    // This path is immediate and factual. It can be queued for Relay before the station's
    // completion transition, unlike a model turn that might resolve after the room retires.
    const factual = this.deps.resultRecap?.(this.roomCode, this.playerId,
      this.commandLocale, this.stationManaged);
    this.resultRecapText = factual ?? null;
    this.resultStandings = [...(this.room?.results?.() ?? [])];
    this.resultWinnerName = this.resultStandings.find(result => result.place === 1 && result.finished)?.name ?? null;
    if (factual) { this.speakResultRecap(factual, true, resultGuard); return; }
    const fallback = () => this.stationManaged
      ? createTranslator(this.commandLocale, RACER_MESSAGES)('voice.waitOperator')
      : raceOverLine(this.myFinishPlace, this.commandLocale);
    if (!this.deps.converse) { this.speakResultRecap(fallback(), false, resultGuard); return; }
    const epoch = ++this.turnEpoch;
    const prompt = createTranslator(this.commandLocale, RACER_MESSAGES)('voice.raceOverPrompt');
    let speech!: Promise<void>;
    const isCurrent = () => epoch === this.turnEpoch && resultGuard();
    speech = this.deps.converse(this.roomCode, this.playerId, prompt, this.commandLocale, isCurrent)
      .then(reply => { if (isCurrent()) this.speakResultRecap((typeof reply==='string'?reply:reply?.text) || fallback(), false, resultGuard); })
      .catch(() => { if (isCurrent()) this.speakResultRecap(fallback(), false, resultGuard); })
      .finally(() => this.pendingSpeech.delete(speech));
    this.pendingSpeech.add(speech);
  }

  private answerResultQuestion(spoken: string): string | null {
    const rank=racerRequestedRank(spoken,this.commandLocale);
    if(rank!==null){
      if(!this.resultStandings.length)return this.resultRecapText;
      const standing=this.resultStandings.find(result=>result.place===rank);
      const text=createTranslator(this.commandLocale,RACER_MESSAGES);
      return standing
        ?text('voice.resultStanding',{name:standing.name,place:ordinal(rank,this.commandLocale)})
        :text('voice.resultPlaceUnavailable',{place:ordinal(rank,this.commandLocale)});
    }
    const kind = racerResultQuestionKind(spoken, this.commandLocale);
    if (!kind) return null;
    if (kind === 'winner' && this.resultWinnerName) return createTranslator(this.commandLocale, RACER_MESSAGES)(
      'commentary.finishWinner', { name: this.resultWinnerName },
    );
    return this.resultRecapText ?? (this.roomCode && this.playerId
      ? this.deps.resultRecap?.(this.roomCode, this.playerId, this.commandLocale, this.stationManaged) ?? null
      : null);
  }

  ignoreLateRacingPrompt(final: boolean): void {
    this.lateRacingPromptActive = !final;
  }

  acceptsLateRacingPrompt(): boolean {
    return Date.now() <= this.lateRacingPromptUntil;
  }

  hasActiveLateRacingPrompt(): boolean {
    return this.lateRacingPromptActive;
  }

  handleMessage(raw: string): void {
    if (!this.active) return;
    const msg = parseCrMessage(raw);
    switch (msg.type) {
      case 'setup': {
        if (this.playerId) return;
        const code = msg.customParameters['roomCode'];
        this.commandLocale = resolveLocale(msg.customParameters['commandLocale'] ?? msg.customParameters['locale'], DEFAULT_LOCALE);
        console.log(`[CR] setup callSid=${msg.callSid} roomCode=${code ?? '(none)'} commandLocale=${this.commandLocale}`);
        if (!code) { console.log('[CR] no roomCode → unbound'); return; }
        const room = this.deps.findOrCreateRoom(code);
        if (!room) { console.log(`[CR] room ${code} not found → unbound`); return; }
        const beforeJoinPhase=this.deps.phaseOf?.(code)??'lobby';
        this.introPhase=beforeJoinPhase;
        if(!this.isCallIntroPhase(beforeJoinPhase))this.introExpired=true;
        this.callSid=msg.callSid;
        if(this.stationManaged)room.expectHumanPlayers?.(this.stationParticipantCount,true);
        else if(this.authoritativeName)room.expectHumanPlayers?.(1,false);
        else if((room.playerCount??0)>=1)room.expectHumanPlayers?.(2,false);
        const resumed=this.deps.resumePlayer?.(msg.callSid,code)??null;
        const nameConfirmed = this.authoritativeName !== null;
        const res = resumed??room.addPlayer(this.authoritativeName ?? playerName(msg.from, this.commandLocale), undefined,
          this.stationManaged ? this.stationParticipantIndex : undefined, nameConfirmed);
        if ('error' in res) {
          console.log(`[CR] addPlayer rejected: ${res.error} → unbound (caller cannot drive)`);
          this.deps.say?.(createTranslator(this.commandLocale, RACER_MESSAGES)('voice.roomFull'));
          return;
        }
        const confirmed = room.hasConfirmedName?.(res.playerId) ?? this.deps.hasPlayerName?.(code, res.playerId);
        if(!this.authoritativeName&&resumed?.name&&confirmed===true)this.authoritativeName=resumed.name.slice(0,50);
        this.room = room; this.playerId = res.playerId; this.roomCode = code;
        this.awaitingName = !nameConfirmed && confirmed === false;
        console.log(`[CR] bound caller to player ${res.playerId} lane ${res.lane} in room ${code}`);
        // Register for this room's game events + greet the caller. Send each greeting SENTENCE as its
        // own utterance so Relay TTS pauses naturally between them (one long string read run-on).
        this.deps.register?.(code, this);
        this.deps.onSetupChanged?.(code,beforeJoinPhase);
        // A queued opening line belongs to this screen. Fast touch navigation expires it before
        // Relay can speak an obsolete greeting over another menu.
        if (resumed?.resumed !== true) {
          const introEpoch = this.introEpoch;
          this.deps.say?.(greetingLines(this.commandLocale)[0]!,
            () => {
              const phase=this.deps.phaseOf?.(code);
              if(phase&&phase!==this.introPhase)this.introExpired=true;
              return this.active && this.roomCode === code && this.playerId !== null
                && this.introEpoch === introEpoch && !this.introExpired;
            });
        }
        if(this.waitingForPreviousRacers()) {
          this.deps.say?.(createTranslator(this.commandLocale,RACER_MESSAGES)('voice.waitNextRound'),
            this.phaseGuard('results'));
        } else if(this.authoritativeName)this.speakNamedArrival(resumed?.resumed===true);
        else if(resumed?.resumed===true){const text=createTranslator(this.commandLocale,RACER_MESSAGES);this.deps.say?.(text('voice.returned'),this.phaseGuard(beforeJoinPhase));if((this.deps.phaseOf?.(code)??'lobby')==='lobby')this.deps.say?.(text('voice.helpLobby'),this.phaseGuard('lobby'));else this.speakPhaseGuidance();}
        else if((this.deps.phaseOf?.(code)??'lobby')==='lobby') {
          const lines=greetingLines(this.commandLocale);
          this.deps.say?.(lines[1]!,this.phaseGuard('lobby'));
          this.deps.say?.(lines[2]!,()=>this.phaseGuard('lobby')()&&!this.nameConfirmed());
        } else this.speakPhaseGuidance();
        break;
      }
      case 'prompt': {
        this.introEpoch++;
        this.resultSpeechEpoch++;
        const requestEpoch = ++this.turnEpoch;
        const phaseAtFrame=this.roomCode?this.deps.phaseOf?.(this.roomCode)??null:null;
        if(!msg.last&&phaseAtFrame&&['lobby','car_select','map_select'].includes(phaseAtFrame)
          &&this.setupPromptPhase===null)this.setupPromptPhase=phaseAtFrame;
        const originatingSetupPhase=msg.last?this.setupPromptPhase:null;
        if(msg.last)this.setupPromptPhase=null;
        if(this.nameConfirmed())this.awaitingName=false;
        if(msg.last&&isSilenceRequest(msg.voicePrompt,this.commandLocale))break;
        if (msg.last && this.awaitingName && this.roomCode && this.playerId
          && (phaseAtFrame==='lobby'||isExplicitNameRequest(msg.voicePrompt,this.commandLocale))) {
          const reply = this.deps.handleSetupUtterance?.(
            this.roomCode, this.playerId, msg.voicePrompt, this.commandLocale,
          ) ?? null;
          const confirmed = this.room?.hasConfirmedName?.(this.playerId)
            ?? this.deps.hasPlayerName?.(this.roomCode, this.playerId) ?? false;
          if (confirmed) this.awaitingName = false;
          const phase = this.deps.phaseOf?.(this.roomCode) ?? phaseAtFrame ?? 'lobby';
          if (reply) this.deps.say?.(reply, this.phaseGuard(phase));
          else this.deps.say?.(createTranslator(this.commandLocale, RACER_MESSAGES)('voice.greeting.2'), this.phaseGuard(phase));
          break;
        }
        if (msg.last && this.waitingForPreviousRacers()) {
          this.deps.say?.(createTranslator(this.commandLocale,RACER_MESSAGES)('voice.waitNextRound'),
            this.phaseGuardAny('results','finished'));
          break;
        }
        if(msg.last&&originatingSetupPhase&&phaseAtFrame!==originatingSetupPhase
          &&!isExplicitCurrentPhaseRequest(msg.voicePrompt,phaseAtFrame,this.commandLocale)){
          this.speakPhaseFallback(phaseAtFrame);
          break;
        }
        if(msg.last&&this.stationManaged&&this.roomCode&&['results','finished'].includes(this.deps.phaseOf?.(this.roomCode)??'')){
          if(!this.recapDone)this.requestResultRecap();
          else {
            const answer=this.answerResultQuestion(msg.voicePrompt);
            if(answer){
              const resultEpoch=this.resultSpeechEpoch,resultCallSid=this.callSid;
              this.speakResultRecap(answer,true,()=>this.recapDone&&this.resultSpeechEpoch===resultEpoch
                &&this.callSid===resultCallSid);
            }else this.deps.say?.(createTranslator(this.commandLocale,RACER_MESSAGES)('voice.waitOperator'));
          }
          break;
        }
        if (msg.last && isHelpRequest(msg.voicePrompt, this.commandLocale)) {
          const phase = this.roomCode ? this.deps.phaseOf?.(this.roomCode) : null;
          const waiting=this.stationManaged&&this.roomCode&&this.playerId&&phase
            &&['car_select','map_select'].includes(phase)
            &&this.deps.setupTurnFor?.(this.roomCode,this.playerId,phase)==='waiting';
          const key = waiting?'voice.waitingForPlayers'
            :phase === 'car_select' ? 'voice.helpCar'
            : phase === 'map_select' ? 'voice.helpMap'
              : phase === 'results' || phase === 'finished' ? 'voice.helpResults'
                : phase === 'racing' || phase === 'countdown' ? 'voice.help'
                  : this.authoritativeName || (this.roomCode && this.playerId && this.deps.hasPlayerName?.(this.roomCode,this.playerId)) ? 'voice.helpLobbyNamed' : 'voice.helpLobby';
          this.deps.say?.(createTranslator(this.commandLocale, RACER_MESSAGES)(key), phase ? this.phaseGuard(phase) : undefined);
          break;
        }
        const setupPhase=this.roomCode?this.deps.phaseOf?.(this.roomCode):null;
        if(msg.last&&this.roomCode&&this.playerId&&setupPhase&&['lobby','car_select','map_select'].includes(setupPhase)){
          const now=Date.now();
          if(this.isDuplicateFrame(msg.voicePrompt,'setup',now)){
            break;
          }
          const reply=this.deps.handleSetupUtterance?.(this.roomCode,this.playerId,msg.voicePrompt,this.commandLocale)??null;
          const currentPhase=this.deps.phaseOf?.(this.roomCode)??setupPhase;
          this.lastFinalCommand={text:msg.voicePrompt.trim().toLocaleLowerCase(this.commandLocale),at:now,source:'setup'};
          if(reply)this.deps.say?.(reply,this.phaseGuard(currentPhase));
          else if(this.deps.converse)this.requestConversation(msg.voicePrompt.trim(),requestEpoch,currentPhase);
          else this.speakPhaseFallback(currentPhase);
          break;
        }
        // During a live race, clear commands take the fast local path. Unresolved final speech can
        // use the same current-screen semantic interpreter as menus, with a phase/turn guard.
        const racing = this.deps.phaseOf && this.roomCode
          ? (this.deps.phaseOf(this.roomCode) === 'racing' || this.deps.phaseOf(this.roomCode) === 'countdown')
          : true;   // no phaseOf → behave as before (command path)

        if (racing || !this.deps.converse) {
          // Interim hypotheses are revisable. Mutate authoritative race state only from the final
          // transcript so a correction such as left -> right cannot execute both commands.
          if (!msg.last) break;
          const normalizedFinal=msg.voicePrompt.trim().toLocaleLowerCase(this.commandLocale);
          const now=Date.now();
          const commandPhase=this.roomCode?this.deps.phaseOf?.(this.roomCode)??'unknown':'unbound';
          if(this.isDuplicateFrame(msg.voicePrompt,'race',now)){
            console.log(`[CR] command call=${this.callSid.slice(0,8)||'unknown'} player=${this.playerId??'unbound'} phase=${commandPhase} duplicate-final=true`);
            break;
          }
          this.lastFinalCommand={text:normalizedFinal,at:now,source:'race'};
          // The command parser intentionally recognizes short ASR variants, but a word inside a
          // question or status remark is not permission to move the on-screen car.
          const { intents, readOnlyInquiry } = racerControlTurn(msg.voicePrompt, this.commandLocale);
          if (!intents.length) {
            const phase = this.roomCode ? this.deps.phaseOf?.(this.roomCode) ?? null : null;
            if (this.deps.converse && this.roomCode && this.playerId) {
              this.requestConversation(msg.voicePrompt.trim(), requestEpoch, phase, readOnlyInquiry);
            } else this.speakPhaseFallback(phase);
            break;
          }
          const accepted:Intent[]=[];
          if (this.room && this.playerId) for (const intent of intents) {
            if(this.room.applyIntent(this.playerId,intent)!==false){accepted.push(intent);this.deps.onIntent?.(intent);}
          }
          console.log(`[CR] command call=${this.callSid.slice(0,8)||'unknown'} player=${this.playerId??'unbound'} phase=${this.roomCode?this.deps.phaseOf?.(this.roomCode)??'unknown':'unbound'} requested=[${intents.join(',')}] accepted=[${accepted.join(',')}]`);
        } else if (msg.last && this.roomCode && this.playerId) {
          // Conversational path — only on the FINAL transcript (partials would spam the LLM). Fire and
          // forget; the reply is spoken via deps.say when it resolves — UNLESS the caller has spoken
          // again or barged in since (epoch moved), in which case the stale reply is dropped.
          const text = msg.voicePrompt.trim();
          if (text) this.requestConversation(text, requestEpoch, this.deps.phaseOf?.(this.roomCode) ?? null);
        }
        break;
      }
      case 'dtmf': {
        this.introEpoch++;
        this.resultSpeechEpoch++;
        console.log(`[CR] dtmf digit=${msg.digit}${this.playerId ? '' : ' (NOT BOUND)'}`);
        if (!this.room || !this.playerId) return;
        const phase = this.roomCode ? this.deps.phaseOf?.(this.roomCode) : null;
        if (phase === 'racing' || phase === 'countdown' || !this.deps.phaseOf) {
          const intent = DTMF_TO_INTENT[msg.digit];
          if (intent) {
            const accepted=this.room.applyIntent(this.playerId,intent)!==false;
            if(accepted)this.deps.onIntent?.(intent);
            console.log(`[CR] command call=${this.callSid.slice(0,8)||'unknown'} player=${this.playerId} phase=${phase??'unknown'} dtmf=${msg.digit} accepted=${accepted}`);
          }
        } else if (/^\d+$/.test(msg.digit)) {
          this.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: msg.digit, last: true }));
        }
        break;
      }
      case 'interrupt': {
        // Barge-in: the caller talked over the host. Conversation Relay already stopped the TTS on its
        // side; we bump the epoch so any in-flight conversational reply is dropped (not spoken late),
        // and clear the current utterance's fired-intents so their next words are read fresh.
        console.log(`[CR] interrupt after ${msg.durationUntilInterruptMs}ms`);
        this.turnEpoch++;
        this.introEpoch++;
        this.resultSpeechEpoch++;
        this.setupPromptPhase=null;
        break;
      }
      case 'error':
        console.log('[CR] provider error');
        return;
      case 'unknown':
        return;
    }
  }

  private speakNamedArrival(resumed:boolean):void{
    if(!this.authoritativeName||!this.roomCode)return;
    const text=createTranslator(this.commandLocale,RACER_MESSAGES);
    const phase=this.deps.phaseOf?.(this.roomCode)??'lobby';
    this.deps.say?.(text(resumed?'voice.returnedNamed':'voice.welcomeNamed',{name:this.authoritativeName}),this.phaseGuard(phase));
    if(!resumed){this.deps.say?.(text('voice.greeting.1'),this.phaseGuard(phase));this.deps.say?.(text('voice.controlsIntro'),this.phaseGuard(phase));}
    this.speakPhaseGuidance();
  }

  private speakPhaseGuidance():void{
    if(!this.roomCode)return;
    const text=createTranslator(this.commandLocale,RACER_MESSAGES);
    const phase=this.deps.phaseOf?.(this.roomCode)??'lobby';
    if(this.waitingForPreviousRacers()){
      this.deps.say?.(text('voice.waitNextRound'),this.phaseGuard(phase));return;
    }
    if(this.stationManaged&&['results','finished'].includes(phase)){this.requestResultRecap();return;}
    const waiting=this.stationManaged&&this.playerId&&['car_select','map_select'].includes(phase)
      &&this.deps.setupTurnFor?.(this.roomCode,this.playerId,phase)==='waiting';
    const key=waiting?'voice.waitingForPlayers'
      :phase==='car_select'?'voice.helpCar'
      :phase==='map_select'?'voice.helpMap'
      :phase==='racing'||phase==='countdown'?'voice.help'
      :phase==='results'||phase==='finished'?(this.stationManaged?'voice.waitOperator':'voice.helpResults')
      :'voice.helpLobbyNamed';
    this.deps.say?.(text(key), this.phaseGuard(phase));
  }

  handleClose(preservePlayer = false): void {
    this.active=false;this.turnEpoch++;
    this.deps.unregister?.(this);
    // Prefer leaveRoom (drops the slot AND reaps an empty room); fall back to plain removePlayer.
    if (this.playerId && !preservePlayer) {
      if (this.roomCode && this.deps.leaveRoom) this.deps.leaveRoom(this.roomCode, this.playerId);
      else this.room?.removePlayer(this.playerId);
    }
    this.room = null; this.playerId = null; this.roomCode = null;
  }

  private isCallIntroPhase(phase:string):boolean{
    return phase==='lobby'||phase==='car_select'||phase==='map_select';
  }

  private phaseGuard(expectedPhase:string):()=>boolean{
    return this.phaseGuardAny(expectedPhase);
  }

  private phaseGuardAny(...expectedPhases:string[]):()=>boolean{
    const menuRevision = expectedPhases.some(phase => phase === 'car_select' || phase === 'map_select')
      ? this.menuSpeechRevision : null;
    return()=>this.active&&Boolean(this.roomCode)
      &&(menuRevision === null || menuRevision === this.menuSpeechRevision)
      &&(!this.deps.phaseOf||expectedPhases.includes(this.deps.phaseOf(this.roomCode!)));
  }

  private nameConfirmed():boolean{
    if(!this.roomCode||!this.playerId)return Boolean(this.authoritativeName);
    return this.room?.hasConfirmedName?.(this.playerId)
      ?? this.deps.hasPlayerName?.(this.roomCode,this.playerId)
      ?? Boolean(this.authoritativeName);
  }

  /** A late caller waits while the prior racers still own results. If they all disconnect, the
   * authoritative room allows that caller to start a fresh round from the held scoreboard. */
  private waitingForPreviousRacers():boolean{
    return Boolean(this.playerId&&this.room?.isWaitingForNextRound?.(this.playerId)
      &&this.room.canAdvance?.(this.playerId)!==true);
  }

  private isDuplicateFrame(spoken:string,source:'setup'|'race',now:number):boolean{
    const previous=this.lastFinalCommand;
    return previous?.source===source
      &&previous.text===spoken.trim().toLocaleLowerCase(this.commandLocale)
      &&now-previous.at<60;
  }

  private requestConversation(text: string, epoch: number, requestPhase: string | null,
    readOnlyInquiry=false): void {
    if (!text || !this.deps.converse || !this.roomCode || !this.playerId) return;
    const roomCode = this.roomCode, playerId = this.playerId;
    const isActiveTurn = () => epoch === this.turnEpoch && this.active;
    const isCurrent = () => isActiveTurn() && (!requestPhase || !this.deps.phaseOf
      || this.deps.phaseOf(roomCode) === requestPhase);
    let speech!:Promise<void>;
    speech=this.deps.converse(roomCode, playerId, text, this.commandLocale, isCurrent, readOnlyInquiry)
      .then(result => {
        if (!isActiveTurn()) return;
        if (!result) { if (isCurrent()) this.speakBriefContextCue(requestPhase); return; }
        const reply=typeof result==='string'?result:result.text;
        const expectedPhase=typeof result==='string'?requestPhase:result.phase;
        if (expectedPhase && this.deps.phaseOf?.(roomCode) !== expectedPhase) return;
        this.deps.say?.(reply, expectedPhase ? this.phaseGuard(expectedPhase) : undefined);
      })
      .catch(() => { if (isCurrent()) this.speakBriefContextCue(requestPhase); })
      .finally(()=>this.pendingSpeech.delete(speech));
    this.pendingSpeech.add(speech);
  }

  private speakPhaseFallback(phase: string | null): void {
    const text = createTranslator(this.commandLocale, RACER_MESSAGES);
    if(this.waitingForPreviousRacers()){
      this.deps.say?.(text('voice.waitNextRound'),this.phaseGuardAny('results','finished'));
      return;
    }
    const waiting=this.stationManaged&&this.roomCode&&this.playerId&&phase
      &&['car_select','map_select'].includes(phase)
      &&this.deps.setupTurnFor?.(this.roomCode,this.playerId,phase)==='waiting';
    const key = waiting?'voice.waitingForPlayers'
      :phase === 'car_select' ? 'voice.helpCar'
      : phase === 'map_select' ? 'voice.helpMap'
        : phase === 'results' || phase === 'finished' ? 'voice.helpResults'
          : phase === 'racing' || phase === 'countdown' ? 'voice.help'
            : this.authoritativeName || (this.roomCode && this.playerId
              && this.deps.hasPlayerName?.(this.roomCode, this.playerId)) ? 'voice.helpLobbyNamed' : 'voice.helpLobby';
    this.deps.say?.(text(key), phase ? this.phaseGuard(phase) : undefined);
  }

  private speakBriefContextCue(phase:string|null):void {
    if(this.waitingForPreviousRacers()){
      this.deps.say?.(createTranslator(this.commandLocale,RACER_MESSAGES)('voice.waitNextRound'),
        this.phaseGuardAny('results','finished'));
      return;
    }
    const text=createTranslator(this.commandLocale,RACER_MESSAGES);
    const key=phase==='car_select'?'voice.briefCar'
      :phase==='map_select'?'voice.briefMap'
      :phase==='racing'||phase==='countdown'?'voice.briefRace'
      :phase==='results'||phase==='finished'?(this.stationManaged?'voice.waitOperator':'voice.briefResults')
      :'voice.briefLobby';
    this.deps.say?.(text(key),phase?this.phaseGuard(phase):undefined);
  }
}

function playerName(from: string | undefined, locale: SupportedLocale): string {
  const racer = createTranslator(locale, RACER_MESSAGES)('voice.playerName');
  if (from && from.length >= 4) return `${racer} ${from.slice(-4)}`;
  return racer;
}

function racerResultQuestionKind(spoken: string, locale: SupportedLocale): 'winner' | 'recap' | null {
  const text=normalizeForMatching(spoken,locale);
  if(!text)return null;
  const asking=locale==='pt-BR'
    ? /^(?:quem|qual|quais|quanto|como|onde|me diga|me fale|repita|leia|pode me dizer|voce pode me dizer|minha|meu|eu (?:ganhei|venci|fiquei|fui)|ganhei|venci|fiquei)\b/.test(text)
      || /[?？¿]/u.test(spoken)
    : /^(?:who|what|which|where|how|tell me|remind me|repeat|read|say|can you tell|could you tell|my|did i|did we|was i|were we|am i|are we|have i)\b/.test(text)
      || /[?？¿]/u.test(spoken);
  if(!asking)return null;
  if(locale==='pt-BR'){
    if(/\b(?:vencedor|vencedora|ganhou|ganhei|venceu|venci|primeiro lugar|primeira colocacao)\b/.test(text))return 'winner';
    return /\b(?:lugar|posicao|colocacao|classificacao|resultado|pontuacao|tempo|corrida|fui|fiquei|me sai|segundo|segunda|terceiro|terceira)\b/.test(text)
      ?'recap':null;
  }
  if(/\b(?:winner|win|won|first place|came first)\b/.test(text))return 'winner';
  return /\b(?:place|position|rank|ranking|leaderboard|standing|standings|result|score|time|race|finish|finished|came|come|first|second|third|did i do)\b/.test(text)
    ?'recap':null;
}

function racerRequestedRank(spoken:string,locale:SupportedLocale):number|null{
  const text=normalizeForMatching(spoken,locale);
  const asksWho=locale==='pt-BR'
    ? /^(?:quem|qual (?:piloto|jogador))\b/.test(text)
    : /^(?:who|which (?:racer|player))\b/.test(text);
  if(!asksWho)return null;
  const ordinals=locale==='pt-BR'
    ? ['primeir[oa]|1', 'segund[oa]|2', 'terceir[oa]|3', 'quart[oa]|4', 'quint[oa]|5', 'sext[oa]|6', 'setim[oa]|7', 'oitav[oa]|8', 'non[oa]|9', 'decim[oa]|10']
    : ['first|1st|1', 'second|2nd|2', 'third|3rd|3', 'fourth|4th|4', 'fifth|5th|5', 'sixth|6th|6', 'seventh|7th|7', 'eighth|8th|8', 'ninth|9th|9', 'tenth|10th|10'];
  const index=ordinals.findIndex(form=>new RegExp(`\\b(?:${form})\\b`).test(text));
  return index>=0?index+1:null;
}

function isRacerInformationalSpeech(spoken:string,locale:SupportedLocale):boolean{
  const text=normalizeForMatching(spoken,locale);
  if(!text)return false;
  const status=locale==='pt-BR'
    ? /^(?:(?:(?:meu|o meu|o) )?(?:nitro|turbo|poder|impulso|freio) (?:esta|e|tem|acabou|parece|funciona)|(?:eu )?(?:tenho|estou com)|talvez|estou pensando em|penso em|se eu|e se)\b/.test(text)
    : /^(?:(?:(?:my|the|our|this) )?(?:nitro|power|boost|brakes?) (?:is|are|was|has|had|looks|seems|works|ran)|i(?:'ve| have)? got|i have|we (?:have|got)|i (?:might|may|am thinking about|wonder if)|maybe|perhaps|if|suppose|assuming)\b/.test(text);
  if(status)return true;
  const action=locale==='pt-BR'
    ? '(?:ir|mover|virar|trocar|mudar|acelerar|frear|reduzir|usar|ativar|soltar|nitro|esquerda|direita)'
    : '(?:go|move|steer|turn|switch|change|accelerate|boost|brake|slow|use|activate|fire|hit|nitro|left|right)';
  const direct=new RegExp(`^(?:(?:please|por favor) )?(?:(?:can|could|would|will) you (?:(?:please|por favor) )?|(?:voce )?pode (?:(?:please|por favor) )?)?${action}\\b`);
  if(direct.test(text))return false;
  const intended=new RegExp(locale==='pt-BR'
    ? `^(?:eu (?:quero|preciso|gostaria de) |vamos )${action}\\b`
    : `^(?:i (?:want|need|would like) to |lets |let's )${action}\\b`);
  if(intended.test(text))return false;
  return locale==='pt-BR'
    ? /^(?:o que|qual|quais|como|por que|porque|quem|onde|quando|devo|posso|me diga|me explique|pode me (?:dizer|explicar|falar)|voce pode me (?:dizer|explicar|falar)|eu tenho|meu carro tem|tenho|ha|existe)\b/.test(text)
      || /\b(?:o que|qual|quais|como|por que)\b/.test(text)
    : /^(?:what|which|how|why|who|where|when|should i|do i|does|is there|are there|can i|tell me|explain|describe|can you (?:tell|explain|describe)|could you (?:tell|explain|describe)|i have|my car has|there (?:is|are))\b/.test(text)
      || /\b(?:what|which|how|why|whether)\b/.test(text);
}

/** A mixed utterance can contain a status fact and a real command. Interpret each
 * clause separately so a mentioned nitro charge is never consumed by the later boost. */
function racerControlTurn(spoken:string,locale:SupportedLocale):{intents:Intent[];readOnlyInquiry:boolean}{
  const clauses=spoken.split(/[.!?;,]|\b(?:and then|then|e depois|entao)\b/iu)
    .map(part=>part.trim()).filter(Boolean);
  if(clauses.length>1){
    const informational=clauses.map(part=>isRacerInformationalSpeech(part,locale));
    if(informational.some(Boolean)){
      const intents=clauses.flatMap((part,index)=>informational[index]?[]:intentsFromTranscript(part,locale));
      return {intents,readOnlyInquiry:intents.length===0};
    }
  }
  const readOnlyInquiry=isRacerInformationalSpeech(spoken,locale);
  return {intents:readOnlyInquiry?[]:intentsFromTranscript(spoken,locale),readOnlyInquiry};
}

function isHelpRequest(spoken: string, locale: SupportedLocale): boolean {
  const text = spoken.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase(locale);
  return locale === 'pt-BR'
    ? /^(?:por favor\s+)?(?:ajuda|me ajuda|preciso de ajuda|quero ajuda|instrucoes|como jogar|o que posso dizer|quais (?:sao )?os comandos)\b/.test(text)
    : /^(?:please\s+)?(?:help(?: me)?|i (?:need|want) help|(?:can|could|would) you help(?: me)?|instructions|how do i play|what can i say|what are the (?:commands|controls))\b/.test(text);
}

function isSilenceRequest(spoken:string,locale:SupportedLocale):boolean{
  const text=spoken.normalize('NFD').replace(/\p{M}+/gu,'').toLocaleLowerCase(locale)
    .replace(/[^\p{L}\p{N}\s]+/gu,' ').replace(/\s+/g,' ').trim();
  return locale==='pt-BR'
    ? /^(?:por favor )?(?:(?:voce )?(?:pode|poderia) )?(?:por favor )?(?:pare de falar|para de falar|fique quiet[oa]|fica quiet[oa]|silencio)(?: por favor)?$/.test(text)
    : /^(?:please )?(?:(?:(?:can|could|would|will) you|i (?:need|want) you to) )?(?:please )?(?:stop (?:talking|speaking)|be quiet|quiet down|shut up)(?: please)?$/.test(text);
}

function isExplicitNameRequest(spoken:string,locale:SupportedLocale):boolean{
  const text=spoken.normalize('NFD').replace(/\p{M}+/gu,'').toLocaleLowerCase(locale).trim();
  return locale==='pt-BR'
    ? /^(?:meu nome e|eu sou|pode me chamar de)\b/.test(text)
    : /^(?:my name is|call me|i am|i'm|im)\b/.test(text);
}

/** If a menu moved while ASR was still transcribing, an unqualified number belongs to neither
 * menu. An explicit request for the new screen may be handled against its fresh room state. */
function isExplicitCurrentPhaseRequest(spoken:string,phase:string|null,locale:SupportedLocale):boolean{
  const text=spoken.normalize('NFD').replace(/\p{M}+/gu,'').toLocaleLowerCase(locale);
  if(phase==='racing'||phase==='countdown')return intentsFromTranscript(spoken,locale).length>0;
  if(phase==='lobby')return isExplicitNameRequest(spoken,locale);
  if(phase==='car_select')return locale==='pt-BR'
    ? /\b(?:carro|veiculo|automovel)\b/.test(text)
    : /\b(?:car|vehicle|ride)\b/.test(text);
  if(phase==='map_select')return locale==='pt-BR'
    ? /\b(?:pista|mapa|circuito)\b/.test(text)
    : /\b(?:track|map|course)\b/.test(text);
  return false;
}
