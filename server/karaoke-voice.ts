import { parseCrMessage } from './conversation-relay';
import { KARAOKE_SONG_DURATION_MS, type KaraokeSong } from '../shared/karaoke';
import type { KaraokePhase, KaraokeResult } from '../shared/karaoke-protocol';
import { KARAOKE_MESSAGES, type KaraokeMessageKey } from '../shared/i18n/karaoke';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import {
  createTranslator,
  formatList,
  formatNumber,
  normalizeForMatching,
  type MessageValues,
} from '../shared/i18n/translate';
import { parseFirstName } from '../shared/spoken-name';
import type { KaraokeAnalyticsSetupAction } from './analytics-observer';

const FINAL_DUPLICATE_FRAME_MS = 160;
type KaraokeVoiceSong = Pick<KaraokeSong, 'id' | 'title' | 'locale'>
  & Partial<Pick<KaraokeSong, 'durationMs'>>;
type KaraokeVoiceResult = Pick<KaraokeResult, 'generation' | 'score' | 'bestCombo'>;
export type KaraokeSpeechOutcome = 'played' | 'estimated' | 'interrupted' | 'failed';
export interface KaraokeIntentRequest {
  game: 'karaoke';
  phase: KaraokePhase;
  locale: SupportedLocale;
  transcript: string;
  actions: readonly { id: string; description: string; targetIds?: readonly string[] }[];
  choices: readonly { id: string; label: string; aliases?: readonly string[] }[];
  facts: readonly { id: string; text: string }[];
  signal?: AbortSignal;
}
export type KaraokeIntentResult =
  | { kind: 'action'; actionId: string; targetId?: string }
  | { kind: 'answer'; factId: string }
  | { kind: 'clarify'; reason?: string }
  | { kind: 'none' };

/** The Karaoke room fields needed to route one singer's setup and result speech. */
export interface KaraokeVoiceSnapshot {
  phase: KaraokePhase;
  myName: string | null;
  nameConfirmed: boolean;
  catalog: readonly KaraokeVoiceSong[];
  selectedSong: KaraokeVoiceSong | null;
  selectedByPlayerId: string | null;
  selectionGeneration: number;
  loadingGeneration: number;
  displayReady: boolean;
  score: number;
  bestCombo: number;
  result: KaraokeVoiceResult | null;
}

export interface KaraokeVoiceEndHandoff {
  type: 'end';
  handoffData: string;
}

export interface KaraokeVoiceDeps {
  /** Binds a new caller or resumes the existing call/player binding. */
  bind(
    code: string,
    name: string,
    callSid: string,
    locale: SupportedLocale,
    nameConfirmed: boolean,
  ): { playerId: string; resumed: boolean } | null;
  leave(code: string, playerId: string, callSid: string): void;
  setName(code: string, playerId: string, name: string): boolean;
  selectSong(code: string, playerId: string, songId: string): boolean;
  advance(code: string, playerId: string): boolean;
  snapshot(code: string, playerId: string, locale?: SupportedLocale): KaraokeVoiceSnapshot | null;
  say(text: string, isCurrent?: () => boolean): Promise<KaraokeSpeechOutcome>;
  resolveIntent?(request: KaraokeIntentRequest): Promise<KaraokeIntentResult>;
  /** The host sends this envelope to Conversation Relay and owns the subsequent media path. */
  requestMediaHandoff(handoff: KaraokeVoiceEndHandoff): void;
  onSetupAction?(action: KaraokeAnalyticsSetupAction): void;
}

export class KaraokeVoiceSession {
  private code: string | null = null;
  private playerId: string | null = null;
  private callSid: string | null = null;
  private introEpoch = 0;
  private introExpired = false;
  private introPhase: KaraokePhase | null = null;
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private authoritativeName: string | null = null;
  private stationManaged = false;
  private awaitingName = false;
  private applyingChange = false;
  private lastPhase: KaraokePhase | null = null;
  private lastSelectionGeneration = 0;
  private lastFinal: { text: string; beforeContext: string; afterContext: string; at: number } | null = null;
  private readonly handedOffGenerations = new Set<number>();
  private readonly announcedResultGenerations = new Set<number>();
  private readonly pendingResultSpeech = new Set<Promise<void>>();
  private readonly preparationAnnouncedGenerations = new Set<number>();
  private semanticController: AbortController | null = null;
  private semanticContext: string | null = null;
  private semanticEpoch = 0;
  private text: (key: KaraokeMessageKey, values?: MessageValues) => string =
    createTranslator(DEFAULT_LOCALE, KARAOKE_MESSAGES);

  constructor(private readonly deps: KaraokeVoiceDeps) {}

  get boundRoomCode(): string | null { return this.code; }
  get boundPlayerId(): string | null { return this.playerId; }
  get locale(): SupportedLocale { return this.commandLocale; }

  async whenResultSpeechSettled(): Promise<void> {
    while (this.pendingResultSpeech.size) await Promise.allSettled([...this.pendingResultSpeech]);
  }

  setStationManaged(active: boolean): void { this.stationManaged = active; }
  setAuthoritativeName(name: string | null): void {
    this.authoritativeName = name?.trim().slice(0, 40) || null;
  }

  handleMessage(raw: string): void {
    const message = parseCrMessage(raw);
    if (message.type === 'setup') {
      this.handleSetup(message.callSid, message.customParameters);
      return;
    }
    if (!this.code || !this.playerId) return;
    if (message.type === 'interrupt' || message.type === 'dtmf' || message.type === 'prompt') {
      this.introEpoch++; // caller barge-in may skip the short technology introduction
    }

    if (message.type === 'interrupt') {
      this.cancelSemantic();
      this.lastFinal = null;
      return;
    }
    if (message.type === 'dtmf') {
      this.cancelSemantic();
      this.handleDtmf(message.digit);
      return;
    }
    if (message.type === 'prompt' && !message.last) {
      this.cancelSemantic();
      this.lastFinal = null;
      return;
    }
    if (message.type !== 'prompt') return;

    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    if (snapshot.phase === 'loading') return;
    if (isRelaySilentPhase(snapshot.phase)) return;
    const normalized = normalizeForMatching(message.voicePrompt, this.commandLocale);
    if (!normalized) return;
    const beforeContext = this.finalContext(snapshot);
    const now = Date.now();
    if (this.lastFinal?.text === normalized && this.lastFinal.afterContext === beforeContext
      && now - this.lastFinal.at < FINAL_DUPLICATE_FRAME_MS
      && !(snapshot.phase === 'song_select' && isExplicitStart(message.voicePrompt, this.commandLocale))) return;

    this.cancelSemantic();
    this.handleFinalPrompt(message.voicePrompt, snapshot);
    this.lastFinal = {
      text: normalized,
      beforeContext,
      afterContext: this.finalContext(this.currentSnapshot()),
      at: now,
    };
  }

  onStateChanged(): void {
    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    if (snapshot.phase !== this.introPhase) this.introExpired = true;
    if (this.semanticContext !== null && this.semanticContext !== this.finalContext(snapshot)) this.cancelSemantic();
    if (snapshot.phase === 'loading') this.acknowledgeLoading(snapshot);

    if (this.applyingChange || isRelaySilentPhase(snapshot.phase)) {
      this.remember(snapshot);
      return;
    }
    if (snapshot.phase === 'results') {
      this.announceResult(snapshot);
    } else if (snapshot.phase !== this.lastPhase) {
      this.speakContext(snapshot);
    } else if (snapshot.phase === 'song_select'
      && snapshot.selectedSong
      && snapshot.selectionGeneration !== this.lastSelectionGeneration
      && snapshot.selectedByPlayerId === this.playerId) {
      this.deps.say(this.text('voice.songSelected', { title: snapshot.selectedSong.title }),
        this.selectedGuard(selectionKey(snapshot)));
      this.speakStartConsent();
    }
    this.remember(snapshot);
  }

  handleClose(): void {
    if (this.code && this.playerId) {
      const phase = this.currentSnapshot()?.phase;
      const preserveForMedia = phase === 'loading' || phase === 'countdown'
        || phase === 'performing' || phase === 'finalizing';
      if (!preserveForMedia && !(this.stationManaged && phase === 'results')) {
        this.deps.leave(this.code, this.playerId, this.callSid ?? '');
      }
    }
    this.clearBinding();
  }

  handleReplaced(): void { this.clearBinding(); }

  announceLoadingTimeout(): void {
    if (this.code && this.playerId) this.deps.say(this.text('voice.loadingTimeout'), this.songSelectGuard());
  }

  private handleSetup(callSid: string, parameters: Record<string, string>): void {
    if (this.playerId) return;
    const code = parameters['roomCode']?.trim().toUpperCase();
    if (!code) return;
    this.commandLocale = resolveLocale(parameters['commandLocale'] ?? parameters['locale']);
    this.text = createTranslator(this.commandLocale, KARAOKE_MESSAGES);
    const binding = this.deps.bind(
      code,
      this.authoritativeName ?? this.text('voice.callerPlaceholder'),
      callSid,
      this.commandLocale,
      this.authoritativeName !== null,
    );
    if (!binding) {
      this.deps.say(this.text('voice.roomUnavailable'));
      return;
    }

    this.code = code;
    this.playerId = binding.playerId;
    this.callSid = callSid;
    this.introExpired = false;
    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    this.introPhase = snapshot.phase;
    if (!this.isCallIntroPhase(snapshot.phase)) this.introExpired = true;
    this.awaitingName = !snapshot.nameConfirmed;
    this.remember(snapshot);

    if (snapshot.phase === 'loading') {
      this.acknowledgeLoading(snapshot);
      return;
    }
    if (snapshot.phase === 'countdown' || snapshot.phase === 'performing') return;
    if (snapshot.phase === 'results') {
      this.announceResult(snapshot);
      return;
    }

    if (binding.resumed) {
      this.deps.say(snapshot.nameConfirmed && snapshot.myName
        ? this.text('voice.returnedName', { name: snapshot.myName })
        : this.text('voice.returned'), snapshot.nameConfirmed ? this.setupGuard() : this.nameGuard());
      this.speakContext(snapshot);
      return;
    }

    this.deps.say(this.text('voice.welcome'), this.callIntroGuard());
    if (!snapshot.nameConfirmed) {
      this.deps.say(this.text('voice.askName'), this.nameGuard());
      return;
    }
    this.finishIntroduction(snapshot);
  }

  private handleFinalPrompt(spoken: string, snapshot: KaraokeVoiceSnapshot): void {
    if (!snapshot.nameConfirmed) {
      this.captureName(spoken);
      return;
    }
    if (snapshot.phase === 'lobby') {
      this.finishIntroduction(snapshot);
      return;
    }
    if (snapshot.phase === 'song_select') {
      if (isScoringConsentQuestion(spoken, this.commandLocale)) {
        this.deps.say(this.text('voice.scoringInfo'), this.songSelectGuard());
        return;
      }
      if (isKaraokeInformationRequest(spoken, this.commandLocale)) {
        const mentioned = matchKaraokeSongReference(spoken, this.catalogForLocale(snapshot), this.commandLocale);
        if (mentioned) this.deps.say(this.songInfo(mentioned), this.songSelectGuard());
        else this.resolveSemantic(spoken, snapshot, true);
        return;
      }
      const song = matchKaraokeSong(spoken, this.catalogForLocale(snapshot), this.commandLocale);
      if (song) {
        this.selectSong(song, snapshot);
        return;
      }
      if (isExplicitStart(spoken, this.commandLocale)) {
        this.startSelectedSong(snapshot);
        return;
      }
      if (isHelpRequest(spoken, this.commandLocale)) {
        this.speakSongSelection(snapshot);
        return;
      }
      this.resolveSemantic(spoken, snapshot);
      return;
    }
    if (snapshot.phase === 'results') {
      if (isExplicitRematch(spoken, this.commandLocale)) {
        this.applyingChange = true;
        const advanced = this.deps.advance(this.code!, this.playerId!);
        this.applyingChange = false;
        const next = this.currentSnapshot();
        if (advanced && next?.phase === 'song_select') {
          this.remember(next);
          this.speakSongSelection(next);
        } else this.announceResult(snapshot);
      } else if (isRepeatResult(spoken, this.commandLocale)) {
        if (snapshot.result) this.announcedResultGenerations.delete(snapshot.result.generation);
        this.announceResult(snapshot);
      } else this.resolveSemantic(spoken, snapshot);
    }
  }

  private captureName(spoken: string): void {
    const name = parseKaraokeName(spoken, this.commandLocale);
    if (!name) {
      this.deps.say(this.text('voice.invalidName'), this.nameGuard());
      return;
    }
    this.applyingChange = true;
    const accepted = this.deps.setName(this.code!, this.playerId!, name);
    this.applyingChange = false;
    const snapshot = this.currentSnapshot();
    if (!accepted || !snapshot?.nameConfirmed) {
      this.deps.say(this.text('voice.invalidName'), this.nameGuard());
      return;
    }
    this.awaitingName = false;
    this.deps.onSetupAction?.('confirm_name');
    this.deps.say(this.text('voice.welcomeName', { name: snapshot.myName ?? name }), this.introGuard());
    this.deps.say(this.text('voice.gameplay'), this.introGuard());
    this.advanceConfirmedLobby(snapshot);
  }

  private finishIntroduction(snapshot: KaraokeVoiceSnapshot): void {
    if (!snapshot.nameConfirmed) {
      this.awaitingName = true;
      this.deps.say(this.text('voice.askName'), this.nameGuard());
      return;
    }
    if (snapshot.myName) this.deps.say(this.text('voice.welcomeName', { name: snapshot.myName }), this.introGuard());
    this.deps.say(this.text('voice.gameplay'), this.introGuard());
    this.advanceConfirmedLobby(snapshot);
  }

  private advanceConfirmedLobby(snapshot: KaraokeVoiceSnapshot): void {
    if (snapshot.phase === 'lobby' && snapshot.nameConfirmed) {
      this.applyingChange = true;
      const advanced = this.deps.advance(this.code!, this.playerId!);
      this.applyingChange = false;
      if (advanced) this.deps.onSetupAction?.('open_song_selection');
    }
    const next = this.currentSnapshot() ?? snapshot;
    this.remember(next);
    if (next.phase === 'song_select') this.speakSongSelection(next);
  }

  private selectSong(song: KaraokeVoiceSong, snapshot: KaraokeVoiceSnapshot): void {
    this.applyingChange = true;
    const selected = this.deps.selectSong(this.code!, this.playerId!, song.id);
    this.applyingChange = false;
    const next = this.currentSnapshot() ?? snapshot;
    this.remember(next);
    if (selected && next.selectedSong?.id === song.id && next.selectedByPlayerId === this.playerId) {
      this.deps.onSetupAction?.('select_song');
      this.deps.say(this.text('voice.songSelected', { title: next.selectedSong.title }),
        this.selectedGuard(selectionKey(next)));
      this.speakStartConsent();
    } else {
      this.deps.say(this.text('voice.unknownSong'), this.contextGuard(this.finalContext(snapshot)));
    }
  }

  private startSelectedSong(snapshot: KaraokeVoiceSnapshot): void {
    if (!snapshot.selectedSong || snapshot.selectedByPlayerId !== this.playerId) {
      this.deps.say(this.text('voice.chooseFirst'), this.menuGuard());
      return;
    }
    this.applyingChange = true;
    const advanced = this.deps.advance(this.code!, this.playerId!);
    this.applyingChange = false;
    const next = this.currentSnapshot() ?? snapshot;
    this.remember(next);
    if (!advanced || next.phase !== 'loading') {
      this.deps.say(this.text('voice.notReady'), this.selectedGuard(selectionKey(snapshot)));
      return;
    }
    this.deps.onSetupAction?.('start_song');
    this.acknowledgeLoading(next);
  }

  private handleDtmf(digit: string): void {
    const snapshot = this.currentSnapshot();
    if (!snapshot) return;
    if (snapshot.phase === 'loading') {
      this.acknowledgeLoading(snapshot);
      return;
    }
    if (isRelaySilentPhase(snapshot.phase)) return;
    if (snapshot.phase === 'results' && snapshot.result) {
      this.announcedResultGenerations.delete(snapshot.result.generation);
      this.announceResult(snapshot);
      return;
    }
    if (snapshot.phase !== 'song_select') {
      if (!snapshot.nameConfirmed) this.deps.say(this.text('voice.askName'), this.nameGuard());
      return;
    }
    if (digit === '*') {
      this.speakSongSelection(snapshot);
      return;
    }
    if (digit === '#') {
      if (!snapshot.selectedSong || snapshot.selectedByPlayerId !== this.playerId) {
        this.deps.say(this.text('voice.chooseFirst'), this.menuGuard());
      } else this.startSelectedSong(snapshot);
      return;
    }
    const index = digit === '0' ? 9 : /^[1-9]$/.test(digit) ? Number(digit) - 1 : -1;
    const song = this.catalogForLocale(snapshot)[index];
    if (song) this.selectSong(song, snapshot);
  }

  private speakContext(snapshot: KaraokeVoiceSnapshot): void {
    if (isRelaySilentPhase(snapshot.phase)) return;
    if (!snapshot.nameConfirmed) {
      this.awaitingName = true;
      this.deps.say(this.text('voice.askName'), this.nameGuard());
    } else if (snapshot.phase === 'lobby') {
      this.finishIntroduction(snapshot);
    } else if (snapshot.phase === 'song_select') {
      this.speakSongSelection(snapshot);
    } else if (snapshot.phase === 'results') {
      this.announceResult(snapshot);
    }
  }

  private speakSongSelection(snapshot: KaraokeVoiceSnapshot): void {
    if (snapshot.selectedSong && snapshot.selectedByPlayerId === this.playerId) {
      this.deps.say(this.text('voice.startRequired', { title: snapshot.selectedSong.title }),
        this.selectedGuard(selectionKey(snapshot)));
      this.speakStartConsent();
      return;
    }
    const catalog = this.catalogForLocale(snapshot);
    if (!catalog.length) {
      this.deps.say(this.text('voice.noSongs'), this.menuGuard());
      return;
    }
    const choices = catalog.map((song, index) => `${index + 1}, ${song.title}`);
    this.deps.say(this.text('voice.catalog', { songs: formatList(this.commandLocale, choices) }), this.menuGuard());
  }

  private speakStartConsent(): void {
    const snapshot = this.currentSnapshot();
    const selected = selectionKey(snapshot);
    if (!selected || snapshot?.selectedByPlayerId !== this.playerId) return;
    // Relay is interruptible; the caller's explicit Start is consent for this selection.
    // Do not tie the command to TTS completion, which would replay a barged-in disclosure.
    try {
      void Promise.resolve(this.deps.say(this.text('voice.startConsent'), this.selectedGuard(selected)))
        .catch(() => undefined);
    } catch { /* An optional spoken cue must not block an explicit start. */ }
  }

  private acknowledgeLoading(snapshot: KaraokeVoiceSnapshot): void {
    if (snapshot.phase !== 'loading' || snapshot.loadingGeneration < 1) return;
    const generation = snapshot.loadingGeneration;
    if (!this.preparationAnnouncedGenerations.has(generation)) {
      this.preparationAnnouncedGenerations.add(generation);
      this.deps.say(this.text('voice.preparing'), this.loadingGuard(generation));
    }
    this.requestHandoff(snapshot);
  }

  private announceResult(snapshot: KaraokeVoiceSnapshot): void {
    const result = snapshot.result;
    if (!result || this.announcedResultGenerations.has(result.generation)) return;
    this.announcedResultGenerations.add(result.generation);
    const resultValues = {
      name: snapshot.myName ?? this.text('voice.callerPlaceholder'),
      score: formatNumber(this.commandLocale, result.score),
      combo: formatNumber(this.commandLocale, result.bestCombo),
    };
    // A station result has a short display deadline. Keep the score and replay step in one
    // compact Relay cue so both arrive before the call is retired, even with slow playback.
    if (this.stationManaged) this.sayResult(this.text('voice.stationResult', resultValues), result.generation);
    else {
      this.sayResult(this.text('voice.result', resultValues), result.generation);
      this.sayResult(this.text('voice.singAgain'), result.generation);
    }
  }

  private songInfo(song: KaraokeVoiceSong): string {
    const durationMs = song.durationMs ?? KARAOKE_SONG_DURATION_MS;
    return this.text('voice.songInfo', {
      title: song.title,
      seconds: formatNumber(this.commandLocale, Math.round(durationMs / 1_000)),
    });
  }

  private sayResult(line: string, generation: number, isCurrent = this.resultGuard(generation)): void {
    const delivery = this.deps.say(line, isCurrent);
    const settled = Promise.resolve(delivery).then(() => undefined, () => undefined);
    this.pendingResultSpeech.add(settled);
    void settled.then(() => this.pendingResultSpeech.delete(settled));
  }

  private requestHandoff(snapshot: KaraokeVoiceSnapshot): void {
    if (snapshot.phase !== 'loading' || !snapshot.displayReady || !snapshot.selectedSong || snapshot.loadingGeneration < 1
      || this.handedOffGenerations.has(snapshot.loadingGeneration)) return;
    this.handedOffGenerations.add(snapshot.loadingGeneration);
    this.deps.requestMediaHandoff({
      type: 'end',
      handoffData: JSON.stringify({
        reasonCode: 'karaoke-media',
        roomCode: this.code,
        playerId: this.playerId,
        songId: snapshot.selectedSong.id,
        loadingGeneration: snapshot.loadingGeneration,
        locale: this.commandLocale,
      }),
    });
  }

  private catalogForLocale(snapshot: KaraokeVoiceSnapshot): readonly KaraokeVoiceSong[] {
    const localized = snapshot.catalog.filter(song => song.locale === this.commandLocale);
    return localized.length ? localized : snapshot.catalog;
  }

  private resolveSemantic(spoken: string, snapshot: KaraokeVoiceSnapshot, informationOnly = false): void {
    const catalog = snapshot.phase === 'song_select' ? this.catalogForLocale(snapshot) : [];
    const informationFallback = () => this.text('voice.catalog', { songs: catalog.map(song => song.title).join(', ') });
    const resolve = this.deps.resolveIntent;
    if (!resolve) {
      if (snapshot.phase === 'song_select') {
        this.deps.say(informationOnly ? informationFallback() : this.text('voice.unknownSong'),
          this.contextGuard(this.finalContext(snapshot)));
      }
      return;
    }
    const context = this.finalContext(snapshot);
    const epoch = ++this.semanticEpoch;
    const controller = new AbortController();
    this.semanticController = controller;
    this.semanticContext = context;
    const actions = informationOnly ? [] : snapshot.phase === 'song_select'
      ? [
          { id: 'select_song', description: 'Choose one song shown on the current screen.', targetIds: catalog.map(song => song.id) },
          { id: 'start_with_consent', description: 'Start the currently selected song only when the caller explicitly asks to start now, consenting to scoring. An interrupted disclosure does not block this.' },
          { id: 'list_songs', description: 'Read the available songs.' },
        ]
      : snapshot.phase === 'results'
        ? [
            ...(!this.stationManaged ? [{ id: 'sing_again', description: 'Return to song selection for a new performance.' }] : []),
            { id: 'repeat_result', description: 'Repeat the current result without starting a new song.' },
          ]
        : [];
    const facts = snapshot.phase === 'song_select'
      ? [
          { id: 'catalog', text: catalog.map(song => song.title).join(', ') },
          { id: 'selected_song', text: snapshot.selectedSong?.title ?? 'No song is selected yet.' },
          { id: 'scoring', text: this.text('voice.scoringInfo') },
          ...catalog.map(song => ({ id: `song:${song.id}`, text: this.songInfo(song) })),
        ]
      : snapshot.phase === 'results' && snapshot.result
        ? [{ id: 'result', text: this.text('voice.result', {
            name: snapshot.myName ?? this.text('voice.callerPlaceholder'),
            score: formatNumber(this.commandLocale, snapshot.result.score),
            combo: formatNumber(this.commandLocale, snapshot.result.bestCombo),
          }) }]
        : [];
    const request: KaraokeIntentRequest = {
      game: 'karaoke', phase: snapshot.phase, locale: this.commandLocale, transcript: spoken,
      actions, choices: catalog.map(song => ({ id: song.id, label: song.title })), facts,
      signal: controller.signal,
    };
    void Promise.resolve().then(() => resolve(request)).then(result => {
      if (controller.signal.aborted || this.semanticEpoch !== epoch) return;
      this.semanticController = null;
      this.semanticContext = null;
      const current = this.currentSnapshot();
      if (!current || this.finalContext(current) !== context || !current.nameConfirmed) return;
      if (result.kind === 'action') {
        if(informationOnly){
          this.deps.say(informationFallback(), this.contextGuard(context));
          return;
        }
        if (current.phase === 'song_select') {
          if (result.actionId === 'select_song') {
            const song = this.catalogForLocale(current).find(candidate => candidate.id === result.targetId);
            if (song) this.selectSong(song, current);
          } else if (result.actionId === 'start_with_consent' && !isConsentQuestionOrNegation(spoken, this.commandLocale)) {
            this.startSelectedSong(current);
          }
          else if (result.actionId === 'list_songs') this.speakSongSelection(current);
        } else if (current.phase === 'results' && current.result) {
          if (result.actionId === 'repeat_result') {
            this.announcedResultGenerations.delete(current.result.generation);
            this.announceResult(current);
          } else if (result.actionId === 'sing_again' && !this.stationManaged) {
            this.applyingChange = true;
            const advanced = this.deps.advance(this.code!, this.playerId!);
            this.applyingChange = false;
            const next = this.currentSnapshot();
            if (advanced && next?.phase === 'song_select') {
              this.remember(next);
              this.speakSongSelection(next);
            }
          }
        }
      } else if (result.kind === 'answer') {
        const fact = facts.find(candidate => candidate.id === result.factId);
        if (fact && current.phase === 'results' && current.result) {
          this.sayResult(fact.text, current.result.generation,
            () => this.finalContext(this.currentSnapshot()) === context);
        } else if (fact) {
          this.deps.say(fact.text, () => this.finalContext(this.currentSnapshot()) === context);
        }
      } else if (current.phase === 'song_select') {
        this.deps.say(informationOnly ? informationFallback() : this.text('voice.unknownSong'),
          this.contextGuard(context));
      }
    }).catch(() => {
      if (controller.signal.aborted || this.semanticEpoch !== epoch) return;
      this.semanticController = null;
      this.semanticContext = null;
      if (this.finalContext(this.currentSnapshot()) === context && snapshot.phase === 'song_select') {
        this.deps.say(informationOnly ? informationFallback() : this.text('voice.unknownSong'),
          this.contextGuard(context));
      }
    });
  }

  private cancelSemantic(): void {
    this.semanticEpoch += 1;
    this.semanticController?.abort();
    this.semanticController = null;
    this.semanticContext = null;
  }

  private currentSnapshot(): KaraokeVoiceSnapshot | null {
    return this.code && this.playerId
      ? this.deps.snapshot(this.code, this.playerId, this.commandLocale)
      : null;
  }

  private nameGuard(): () => boolean {
    return () => {
      const snapshot = this.currentSnapshot();
      return Boolean(snapshot && !snapshot.nameConfirmed
        && (snapshot.phase === 'lobby' || snapshot.phase === 'song_select'));
    };
  }

  private setupGuard(): () => boolean {
    return () => {
      const snapshot = this.currentSnapshot();
      return Boolean(snapshot && (snapshot.phase === 'lobby'
        || (snapshot.phase === 'song_select' && !snapshot.selectedSong)));
    };
  }

  private callIntroGuard(): () => boolean {
    const code = this.code, playerId = this.playerId, callSid = this.callSid, epoch = this.introEpoch;
    return () => {
      const snapshot = this.currentSnapshot();
      if (snapshot && snapshot.phase !== this.introPhase) this.introExpired = true;
      return Boolean(code && playerId && callSid && snapshot && this.code === code
        && this.playerId === playerId && this.callSid === callSid && this.introEpoch === epoch
        && !this.introExpired);
    };
  }

  private isCallIntroPhase(phase: KaraokePhase): boolean {
    return phase === 'lobby' || phase === 'song_select';
  }

  private introGuard(): () => boolean {
    return () => Boolean(this.currentSnapshot()?.nameConfirmed && this.setupGuard()());
  }

  private songSelectGuard(): () => boolean {
    return () => this.currentSnapshot()?.phase === 'song_select';
  }

  private menuGuard(): () => boolean {
    return () => {
      const snapshot = this.currentSnapshot();
      return snapshot?.phase === 'song_select' && !snapshot.selectedSong;
    };
  }

  private selectedGuard(selection: string | null): () => boolean {
    return () => Boolean(selection && selectionKey(this.currentSnapshot()) === selection
      && this.currentSnapshot()?.selectedByPlayerId === this.playerId);
  }

  private loadingGuard(generation: number): () => boolean {
    return () => {
      const snapshot = this.currentSnapshot();
      return snapshot?.phase === 'loading' && snapshot.loadingGeneration === generation;
    };
  }

  private finalContext(snapshot: KaraokeVoiceSnapshot | null): string {
    return `${snapshot?.phase ?? 'unavailable'}:${snapshot?.nameConfirmed ? 'named' : 'unnamed'}:`
      + `${snapshot?.selectedSong?.id ?? ''}:${snapshot?.selectedByPlayerId ?? ''}:`
      + `${snapshot?.selectionGeneration ?? 0}:`
      + `${snapshot?.loadingGeneration ?? 0}:${snapshot?.result?.generation ?? 0}`;
  }

  private contextGuard(context: string): () => boolean {
    return () => this.finalContext(this.currentSnapshot()) === context;
  }

  private remember(snapshot: KaraokeVoiceSnapshot): void {
    this.lastPhase = snapshot.phase;
    this.lastSelectionGeneration = snapshot.selectionGeneration;
  }

  private resultGuard(generation: number): () => boolean {
    return () => this.currentSnapshot()?.result?.generation === generation;
  }

  private clearBinding(): void {
    this.cancelSemantic();
    this.introEpoch++;
    this.code = null;
    this.playerId = null;
    this.callSid = null;
    this.awaitingName = false;
    this.applyingChange = false;
    this.lastPhase = null;
    this.lastSelectionGeneration = 0;
    this.lastFinal = null;
    this.preparationAnnouncedGenerations.clear();
  }
}

export function matchKaraokeSong(
  spoken: string,
  songs: readonly KaraokeVoiceSong[],
  locale: SupportedLocale = DEFAULT_LOCALE,
): KaraokeVoiceSong | null {
  if (isKaraokeInformationRequest(spoken, locale)) return null;
  return matchKaraokeSongReference(spoken, songs, locale);
}

function matchKaraokeSongReference(
  spoken: string,
  songs: readonly KaraokeVoiceSong[],
  locale: SupportedLocale,
): KaraokeVoiceSong | null {
  const normalized = normalizeForMatching(spoken, locale);
  const segments = normalized.split(locale === 'pt-BR'
    ? /\b(?:nao|na verdade|quer dizer|melhor|em vez disso)\b/
    : /\b(?:no|actually|rather|instead|i mean|make that)\b/).map(segment => segment.trim()).filter(Boolean);
  const text = segments.at(-1) ?? normalized;
  if (!text || /\b(?:don'?t|do not|not|nao|nunca|sem)\b/.test(text)) return null;
  const numberWords = locale === 'pt-BR'
    ? ['um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez']
    : ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const ordinalWords = locale === 'pt-BR'
    ? [/\bprimeir[oa]\b/, /\bsegund[oa]\b/]
    : [/\bfirst\b/, /\bsecond\b/];
  const matches = new Set<KaraokeVoiceSong>();
  const matchedOrdinals = ordinalWords.flatMap((pattern, index) => pattern.test(text) && songs[index] ? [songs[index]] : []);
  if (matchedOrdinals.length === 1) return matchedOrdinals[0]!;
  if (matchedOrdinals.length > 1) return null;
  for (const match of text.matchAll(/\b(10|[1-9])\b/g)) {
    const song = songs[Number(match[1]) - 1];
    if (song) matches.add(song);
  }
  numberWords.forEach((word, index) => {
    const boundedNumber = new RegExp(`(?:^|\\b(?:song|track|number|choice|option|musica|cancao|faixa|numero)\\s+)${word}\\b`);
    if ((text === word || boundedNumber.test(text)) && songs[index]) matches.add(songs[index]);
  });
  for (const song of songs) {
    const title = normalizeForMatching(song.title, locale);
    const titleWithoutArticle = locale === 'en-US' ? title.replace(/^(?:a|an|the)\s+/, '') : title;
    if (containsPhrase(text, title) || (titleWithoutArticle !== title && containsPhrase(text, titleWithoutArticle))) {
      matches.add(song);
    }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

function selectionKey(snapshot: KaraokeVoiceSnapshot | null): string | null {
  return snapshot?.phase === 'song_select' && snapshot.selectedSong
    ? `${snapshot.selectedSong.id}:${snapshot.selectionGeneration}` : null;
}

function parseKaraokeName(spoken: string, locale: SupportedLocale): string | null {
  const normalized = normalizeForMatching(spoken, locale);
  const setupWords = locale === 'pt-BR'
    ? /\b(?:ajuda|cancao|cancoes|cantar|karaoke|musica|musicas|regras)\b/
    : /\b(?:help|instructions|karaoke|music|rules|sing|singing|song|songs)\b/;
  return setupWords.test(normalized) ? null : parseFirstName(spoken, locale);
}

function isExplicitStart(spoken: string, locale: SupportedLocale): boolean {
  // A clear, affirmative start should not wait for a semantic model while the consent
  // disclosure is speaking. Ambiguous, negative, or conditional language still goes
  // through the contextual intent resolver; this fast path grants no inferred consent.
  if (isConsentQuestionOrNegation(spoken, locale)) return false;
  const text = normalizeForMatching(spoken, locale).replace(/['’]/g, '');
  if (!text || text.split(/\s+/).length > 16) return false;
  if (locale === 'pt-BR') {
    return /^(?:(?:sim|claro|ok|okay|por favor|vamos|bora|eu quero|quero|estou pront[oa] para|ja estou pront[oa] para)\s+)*(?:comecar|iniciar)(?:\s+(?:(?:a|esta|essa|minha)\s+)?musica)?(?:\s+a\s+cantar)?(?:\s+(?:agora|ja))?(?:\s+por favor)?$/.test(text);
  }
  return /^(?:(?:yes|yeah|yep|sure|ok|okay|alright|please|go ahead(?: and)?|lets|let s|let us|i want to|i wanna|id like to|i would like to|im ready to|i am ready to|were ready to|we are ready to|ready to)\s+)*(?:just\s+)?(?:start|begin)(?:\s+(?:(?:the|this|that|my)\s+)?song)?(?:\s+singing)?(?:\s+(?:right\s+)?now)?(?:\s+please)?$/.test(text);
}

function isKaraokeInformationRequest(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  if (!text) return false;
  if (locale === 'pt-BR'
    ? /^(?:comecar|iniciar|comece|inicie)\s+(?:por\s+)?(?:me\s+)?(?:dizendo|explicando|falando|contando)\b/.test(text)
    : /^(?:start|begin)\s+(?:by|with)\s+(?:tell|telling|explain|explaining|say|saying|describe|describing)\b/.test(text)) return true;
  // A polite request to choose a title is still an action. Questions about a title are not.
  if (locale === 'pt-BR'
    ? /^(?:pode|poderia)\s+(?:por favor\s+)?(?:tocar|escolher|selecionar)\b/.test(text)
    : /^(?:can|could|would)\s+(?:you|we)\s+(?:please\s+)?(?:play|choose|select|pick)\b/.test(text)) return false;
  return /[?？¿]/u.test(spoken) || (locale === 'pt-BR'
    ? /^(?:qual|quais|quanto|onde|quem|como|por que|porque|quando|me fale|fale|explique|compare|pode|posso|preciso|devo|quero saber)\b/.test(text)
    : /^(?:what|which|where|who|how|why|when|tell me|explain|describe|compare|can|could|would|should|do|does|is|are|i wonder|i want to know|i would like to know)\b/.test(text));
}

function isScoringConsentQuestion(spoken: string, locale: SupportedLocale): boolean {
  if (!isKaraokeInformationRequest(spoken, locale)) return false;
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /\b(?:pontuacao|consentimento|consentir|voz|audio|gravar|gravacao|servico|terceiro|terceirizado|dados|privacidade|esperar|espera|aguardar|comecar|iniciar)\b/.test(text)
    : /\b(?:score|scoring|consent|voice|audio|record|recording|service|third.party|data|privacy|wait|waiting|start|begin)\b/.test(text);
}

function isConsentQuestionOrNegation(spoken: string, locale: SupportedLocale): boolean {
  // ASR punctuation is imperfect, but an explicit question mark must never become
  // consent just because normalization strips it from the fast-path transcript.
  if (/[?？¿]/u.test(spoken)) return true;
  const text = normalizeForMatching(spoken, locale).replace(/['’]/g, '');
  return locale === 'pt-BR'
    ? /\b(?:nao|nunca|talvez|depois|mais tarde|espera|espere|aguarda|aguarde|ainda|se|quando|antes|posso|podemos|devo|como|qual|quais|quem|onde|porque|por que|explicar|explicando|dizendo|falando|amanha)\b/.test(text)
    : /\b(?:dont|do not|not|never|wait|hold|later|maybe|might|if|when|before|after|could|would|should|can|how|what|why|where|who|which|whether|telling|tell|explaining|explain|describing|describe|wont|tomorrow|minutes?)\b/.test(text);
}

function isHelpRequest(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /\b(?:ajuda|instrucoes|musicas|o que posso dizer)\b/.test(text)
    : /\b(?:help|instructions|songs|what can i say)\b/.test(text);
}

function isExplicitRematch(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /^(?:sim|cantar de novo|de novo|outra musica|outra cancao|escolher outra musica|revanche)$/.test(text)
    : /^(?:yes|sing again|again|another song|choose another song|rematch)$/.test(text);
}

function isRepeatResult(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  return locale === 'pt-BR'
    ? /\b(?:repita|repetir|qual foi|quanto fiz|minha pontuacao|meu resultado)\b/.test(text)
    : /\b(?:repeat|what was|what did i score|my score|my result|how did i do)\b/.test(text);
}

function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|\\b)${escaped}(?:$|\\b)`).test(text);
}

function isRelaySilentPhase(phase: KaraokePhase): boolean {
  return phase === 'loading' || phase === 'countdown' || phase === 'performing' || phase === 'finalizing';
}
