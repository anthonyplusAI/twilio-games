import type { WizardChessSceneSnapshot } from '../../shared/chess-protocol';
import type { SupportedLocale } from '../../shared/i18n/locales';
import {
  WIZARD_CHESS_AUDIO_MODEL_ID, WIZARD_CHESS_AUDIO_OUTPUT_FORMAT,
  WIZARD_CHESS_AUDIO_CUES, WIZARD_CHESS_DIALOGUE, WIZARD_CHESS_FINALE_CUES,
  WIZARD_CHESS_RESOLVED_DURATION_MS,
  WIZARD_CHESS_SEQUENCE, WIZARD_CHESS_VICTORY_AT_MS,
  WIZARD_CHESS_VOICE_IDS,
  type WizardChessDialogueLine, type WizardChessFinaleCue, type WizardChessVoiceCue,
} from '../../shared/wizard-chess-scene';
import type { ChessBoardScene, BoardPiece } from './chess-board';
import { wizardMoveAt, wizardPositionAfterMoves } from './wizard-scene-state';

const characters = { ron: 'Ron', harry: 'Harry', hermione: 'Hermione' } as const;
function audioVersion(locale: SupportedLocale): string {
  const content = JSON.stringify({ voices: WIZARD_CHESS_VOICE_IDS,
    model: WIZARD_CHESS_AUDIO_MODEL_ID, format: WIZARD_CHESS_AUDIO_OUTPUT_FORMAT,
    lines: WIZARD_CHESS_AUDIO_CUES.map(line => [line.id, line.speaker, line.text[locale]]) });
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
const lineUrl = (id: string, locale: SupportedLocale): string =>
  `/api/chess/wizard-audio/${encodeURIComponent(id)}?locale=${encodeURIComponent(locale)}&v=${audioVersion(locale)}`;
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const ESTABLISHING_HOLD_MS = 800;
// The server's story safety timeout is 90 seconds. A per-line wait of 2.5s
// leaves room for all fourteen caption fallbacks and their deliberate pauses.
const AUDIO_WAIT_MS = 2_500;
const FINALE_AUDIO_WAIT_MS = 2_000;
const SCREAM_REACTION_HOLD_MS = 4_000;
const FINALE_CAPTION_TAIL_MS = 450;
const CHECKMATE_VOICE_MAX_HOLD_MS = 4_000;
const CHECKMATE_MOVE_PAUSE_MS = 220;

type WizardShot = 'wide' | 'board' | 'harry' | 'ron' | 'hermione' | 'queen'
  | 'ron-impact' | 'king' | 'checkmate' | 'victory';
interface WizardShotBeat {
  atMs: number;
  shot: WizardShot;
  cut?: boolean;
  durationMs?: number;
  impact?: 'ron' | 'checkmate';
}

/** Each camera choice supports a story beat rather than mechanically following the speaker. */
const STORY_SHOTS: Readonly<Record<string, { shot: WizardShot; cut?: boolean; durationMs?: number }>> = {
  'harry-wait': { shot: 'harry', durationMs: 950 },
  'ron-sacrifice': { shot: 'ron', cut: true },
  'ron-queen-takes': { shot: 'queen', cut: true },
  'ron-check-king': { shot: 'king', durationMs: 900 },
  'harry-no': { shot: 'harry', cut: true },
  'hermione-asks': { shot: 'hermione', cut: true },
  'harry-realizes': { shot: 'harry', durationMs: 650 },
  'hermione-pleads': { shot: 'hermione', cut: true },
  'ron-final-appeal': { shot: 'ron', cut: true },
  'ron-harry-goes-on': { shot: 'harry', durationMs: 1_200 },
  'ron-knows': { shot: 'ron', cut: true },
  'ron-not-me': { shot: 'ron', durationMs: 750 },
  'ron-not-hermione': { shot: 'hermione', cut: true },
  'ron-you': { shot: 'harry', cut: true },
};

const finaleCueAt = (id: string): number => WIZARD_CHESS_FINALE_CUES.find(cue => cue.id === id)!.atMs;
const queenAt = WIZARD_CHESS_SEQUENCE[1]!.atMs;
const bishopAt = WIZARD_CHESS_SEQUENCE[2]!.atMs;
const queenBlockAt = WIZARD_CHESS_SEQUENCE[3]!.atMs;
const mateAt = WIZARD_CHESS_SEQUENCE[4]!.atMs;
const RESOLUTION_SHOTS: readonly WizardShotBeat[] = [
  { atMs: 0, shot: 'board', cut: true },
  { atMs: queenAt - 2_000, shot: 'board', durationMs: 1_200 },
  { atMs: queenAt - 850, shot: 'queen', cut: true },
  { atMs: finaleCueAt('ron-scream'), shot: 'ron-impact', cut: true, impact: 'ron' },
  { atMs: finaleCueAt('harry-ron'), shot: 'harry', cut: true },
  { atMs: bishopAt - 900, shot: 'board', durationMs: 850 },
  // Let Harry's bishop travel across the visible board before his closeup.
  { atMs: bishopAt + 850, shot: 'harry', cut: true },
  { atMs: queenBlockAt - 900, shot: 'king', cut: true },
  { atMs: queenBlockAt, shot: 'queen', durationMs: 950 },
  { atMs: finaleCueAt('harry-checkmate'), shot: 'harry', cut: true },
  { atMs: finaleCueAt('harry-checkmate') + 1_350, shot: 'king', cut: true },
  { atMs: mateAt, shot: 'checkmate', cut: true },
  { atMs: mateAt + 950, shot: 'checkmate', impact: 'checkmate' },
  { atMs: WIZARD_CHESS_VICTORY_AT_MS, shot: 'victory', durationMs: 1_450 },
];

interface WizardSceneHooks {
  renderPosition: (position: readonly BoardPiece[], scene: WizardChessSceneSnapshot) => void;
  onActiveChange: (active: boolean) => void;
  setMusicVolume: (volume: number) => void;
  requestSkip: (sceneId: number) => void;
  reportProgress?: (sceneId: number, dialogueCursor: number) => void;
}

/** The screen is a timed projection of server-owned scene state; it never changes the live chess game. */
export class WizardSceneController {
  private readonly overlay = element<HTMLElement>('wizard-scene');
  private readonly title = element<HTMLElement>('wizard-scene-title');
  private readonly transcript = element<HTMLElement>('wizard-transcript');
  private readonly soundToggle = element<HTMLButtonElement>('wizard-sound-toggle');
  private readonly soundLabel = this.soundToggle.querySelector('span')!;
  private readonly skipButton = element<HTMLButtonElement>('wizard-skip-button');
  private readonly moveHint = element<HTMLElement>('wizard-move-hint');
  private readonly victory = element<HTMLElement>('wizard-scene-victory');
  private readonly countdown = element<HTMLElement>('wizard-scene-countdown');
  private readonly audio = new Audio();
  private readonly audioUrls = new Map<string, string>();
  private readonly audioRequests = new Map<string, Promise<string | null>>();
  private readonly failedAudioLines = new Set<string>();
  private readonly prefetchedLines = new Set<string>();
  private readonly shownLines = new Set<string>();
  private board: ChessBoardScene | null = null;
  private snapshot: WizardChessSceneSnapshot | null = null;
  private currentPosition: BoardPiece[] = wizardPositionAfterMoves(0);
  private latestLine: WizardChessDialogueLine | null = null;
  private audioSourceLine: WizardChessVoiceCue | null = null;
  private audioMode: 'story' | 'finale' | null = null;
  private activeCaption: HTMLElement | null = null;
  private currentFinaleCue: WizardChessFinaleCue | null = null;
  private activeAudio = false;
  private linePending = false;
  private lineStartedAt = 0;
  private nextDialogueIndex = 0;
  private storyInitialized = false;
  private establishingHoldStarted = false;
  private storyCompletionRequested = false;
  private focusMoveHintWhenReady = false;
  private lineTimer: ReturnType<typeof setTimeout> | null = null;
  private finaleCaptionTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private soundEnabled = true;
  private soundNeedsGesture = false;
  private speechToken = 0;
  private storySkipped = false;
  private resolutionStarted = false;
  private resolutionNextIndex = 0;
  private resolutionCueIndex = 0;
  private resolutionShotIndex = 0;
  private finaleCuePendingAudio: string | null = null;
  private finaleCueShownAtMs = 0;
  private checkmateVoiceEndedAtMs: number | null = null;
  private finalMoveReleaseAtMs: number | null = null;
  private clockOffsetMs = 0;
  private audioUnavailable = false;
  private voiceFailed = false;
  private disposed = false;

  constructor(private readonly locale: SupportedLocale, private readonly hooks: WizardSceneHooks) {
    this.soundToggle.addEventListener('click', this.onSoundToggle);
    this.skipButton.addEventListener('click', this.onSkip);
    this.audio.addEventListener('error', this.onAudioError);
    this.audio.addEventListener('ended', this.onAudioEnded);
    this.audio.preload = 'auto';
    this.renderSoundToggle();
    this.localize();
  }

  get active(): boolean { return this.snapshot !== null; }

  /** Warm Harry's opening and Ron's reply while the join QR is displayed. */
  prefetchOpeningVoice(): void {
    if (this.disposed) return;
    this.prefetchLine(WIZARD_CHESS_DIALOGUE[0]!);
    this.prefetchLine(WIZARD_CHESS_DIALOGUE[1]!);
  }

  attachBoard(board: ChessBoardScene): void {
    this.board = board;
    if (!this.snapshot) return;
    board.setHumanColor('w');
    board.setWizardMode(true);
    board.setPosition(this.currentPosition);
    this.renderBoardHints();
    this.restoreCurrentShot();
  }

  setClockOffset(offsetMs: number): void {
    if (!Number.isFinite(offsetMs)) return;
    this.clockOffsetMs = offsetMs;
    this.tick();
  }

  update(snapshot: WizardChessSceneSnapshot | null | undefined): void {
    if (this.disposed) return;
    if (!snapshot) {
      if (this.snapshot) this.leave();
      return;
    }
    const previousPhase = this.snapshot?.id === snapshot.id ? this.snapshot.phase : null;
    if (this.snapshot?.id !== snapshot.id) this.enter(snapshot);
    this.snapshot = snapshot;
    if (snapshot.phase !== 'story' && previousPhase === null) this.rebuildCaptions();
    if (snapshot.phase === 'ready') {
      if (previousPhase !== 'ready') {
        this.storySkipped = true;
        // The server can also advance at its safety timeout. Stop any in-flight
        // line so the audible scene and the newly enabled phone move agree.
        this.stopVoice();
      }
      this.revealMoveHint(this.focusMoveHintWhenReady);
      this.focusMoveHintWhenReady = false;
    }
    if (snapshot.phase === 'resolved') {
      if (previousPhase !== 'resolved') {
        this.stopVoice();
        // The final story subtitle must not linger over Ron's first move.
        if (this.activeCaption) this.activeCaption.dataset.current = 'false';
        this.activeCaption = null;
        this.prefetchFinaleAudio();
      }
      this.moveHint.hidden = true;
      this.skipButton.hidden = true;
    }
    this.renderBoardHints();
    this.tick();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.leave();
    this.soundToggle.removeEventListener('click', this.onSoundToggle);
    this.skipButton.removeEventListener('click', this.onSkip);
    this.audio.removeEventListener('error', this.onAudioError);
    this.audio.removeEventListener('ended', this.onAudioEnded);
    this.audioUrls.forEach(url => URL.revokeObjectURL(url));
    this.audioUrls.clear();
  }

  private enter(snapshot: WizardChessSceneSnapshot): void {
    this.stopVoice();
    this.snapshot = snapshot;
    this.storySkipped = false;
    this.resolutionStarted = false;
    this.resolutionNextIndex = 0;
    this.resolutionCueIndex = 0;
    this.resolutionShotIndex = 0;
    this.finaleCueShownAtMs = 0;
    this.checkmateVoiceEndedAtMs = null;
    this.finalMoveReleaseAtMs = null;
    this.shownLines.clear();
    this.prefetchedLines.clear();
    this.failedAudioLines.clear();
    this.latestLine = null;
    this.currentFinaleCue = null;
    this.activeCaption = null;
    this.nextDialogueIndex = 0;
    this.storyInitialized = false;
    this.establishingHoldStarted = false;
    this.storyCompletionRequested = false;
    this.focusMoveHintWhenReady = false;
    this.audioUnavailable = false;
    this.voiceFailed = false;
    this.renderSoundToggle();
    this.currentPosition = wizardPositionAfterMoves(0);
    this.transcript.replaceChildren();
    this.overlay.hidden = false;
    this.overlay.dataset.phase = snapshot.phase;
    this.overlay.dataset.speaking = 'false';
    this.moveHint.hidden = true;
    this.victory.hidden = true;
    this.countdown.hidden = true;
    this.skipButton.hidden = false;
    this.title.textContent = this.locale === 'pt-BR' ? 'A câmara do xadrez bruxo' : 'The Wizard Chess chamber';
    this.board?.setHumanColor('w');
    this.board?.setWizardMode(true);
    this.board?.setPosition(this.currentPosition);
    this.setShot('wide', { cut: true });
    this.renderBoardHints();
    this.hooks.renderPosition(this.currentPosition, snapshot);
    this.hooks.setMusicVolume(0.17);
    this.hooks.onActiveChange(true);
    this.title.focus({ preventScroll: true });
    if (snapshot.phase === 'story') this.prefetchAudio();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), 120);
  }

  private leave(): void {
    this.stopVoice();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.snapshot = null;
    this.overlay.hidden = true;
    this.overlay.dataset.phase = '';
    this.overlay.dataset.shot = '';
    this.overlay.dataset.speaking = 'false';
    this.board?.restoreWizardCamera();
    this.board?.setWizardMode(false);
    this.hooks.setMusicVolume(0.52);
    this.hooks.onActiveChange(false);
  }

  private tick(): void {
    const scene = this.snapshot;
    if (!scene) return;
    this.overlay.dataset.phase = scene.phase;
    if (scene.phase === 'story' && !this.storySkipped) this.renderStory(scene);
    else if (scene.phase === 'resolved') this.renderResolution(scene);
  }

  private renderStory(scene: WizardChessSceneSnapshot): void {
    if (this.storyCompletionRequested || this.linePending || this.lineTimer) return;
    if (!this.storyInitialized) {
      this.storyInitialized = true;
      // Elapsed-time guesses can skip unheard lines when speech durations vary.
      // A reconnected screen resumes only after lines that the previous display
      // reported as fully finished; an older server safely replays from zero.
      this.nextDialogueIndex = Number.isSafeInteger(scene.dialogueCursor)
        ? Math.max(0, Math.min(WIZARD_CHESS_DIALOGUE.length, scene.dialogueCursor!)) : 0;
      for (let index = 0; index < this.nextDialogueIndex; index++) {
        const line = WIZARD_CHESS_DIALOGUE[index]!;
        this.appendLine(line);
        this.latestLine = line;
      }
      if (this.activeCaption) this.activeCaption.dataset.current = 'false';
    }
    if (!this.establishingHoldStarted && this.nextDialogueIndex === 0) {
      this.establishingHoldStarted = true;
      this.setShot('wide', { cut: true });
      this.lineTimer = setTimeout(() => {
        this.lineTimer = null;
        if (this.snapshot?.id === scene.id && this.snapshot.phase === 'story' && !this.storySkipped) {
          this.renderStory(scene);
        }
      }, ESTABLISHING_HOLD_MS);
      return;
    }
    if (this.nextDialogueIndex >= WIZARD_CHESS_DIALOGUE.length) {
      this.requestMoveCue(scene.id);
      return;
    }
    this.startNextLine();
  }

  private appendLine(line: WizardChessVoiceCue): void {
    this.shownLines.add(line.id);
    this.board?.setWizardSpeaker(line.speaker);
    if (this.activeCaption) this.activeCaption.dataset.current = 'false';
    const bubble = document.createElement('div');
    bubble.className = 'wizard-message';
    bubble.dataset.speaker = line.speaker;
    bubble.dataset.current = 'true';
    const speaker = document.createElement('strong');
    speaker.className = 'wizard-message-speaker';
    speaker.textContent = characters[line.speaker];
    const text = document.createElement('p');
    text.textContent = line.text[this.locale];
    bubble.append(speaker, text);
    this.transcript.append(bubble);
    this.activeCaption = bubble;
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  private rebuildCaptions(): void {
    // Dialogue timing follows real audio durations, so fixed atMs estimates
    // cannot reconstruct which lines were spoken on a reloaded ready display.
    // Show the complete scene script there, including Ron's final appeal.
    for (const line of WIZARD_CHESS_DIALOGUE) {
      if (!this.shownLines.has(line.id)) {
        this.appendLine(line);
        this.latestLine = line;
      }
    }
  }

  private revealMoveHint(focus = false): void {
    const becomingVisible = this.moveHint.hidden;
    const copy = this.locale === 'pt-BR'
      ? 'Sua vez: diga “cavalo para H3” no telefone agora.'
      : 'Your turn: say “Knight to H3” on the phone now.';
    if (this.moveHint.textContent !== copy) this.moveHint.textContent = copy;
    this.moveHint.hidden = false;
    this.skipButton.hidden = true;
    if (becomingVisible) this.setShot('board', { durationMs: 1_300 });
    if (focus) this.moveHint.focus({ preventScroll: true });
  }

  private renderResolution(scene: WizardChessSceneSnapshot): void {
    const elapsed = Math.max(0, this.serverNow() - (scene.resolvedAt ?? scene.startedAt));
    const firstFrame = !this.resolutionStarted;
    this.renderFinaleCues(elapsed);
    this.releaseFinalMoveWhenReady(elapsed);
    const completed = WIZARD_CHESS_SEQUENCE.filter((step, index) =>
      this.resolutionMoveAt(index) + (wizardMoveAt(index).move.captured ? 1_230 : 780) <= elapsed).length;
    if (!this.resolutionStarted || completed > this.resolutionNextIndex) {
      this.resolutionStarted = true;
      this.storySkipped = true;
      this.resolutionNextIndex = completed;
      this.currentPosition = wizardPositionAfterMoves(completed);
      this.board?.cancelAnimation();
      this.board?.setPosition(this.currentPosition);
      this.hooks.renderPosition(this.currentPosition, scene);
    }
    if (this.resolutionNextIndex < WIZARD_CHESS_SEQUENCE.length
      && this.resolutionMoveAt(this.resolutionNextIndex) <= elapsed) {
      const index = this.resolutionNextIndex++;
      // A background tab can pause requestAnimationFrame past the previous
      // move's finish time. Clear that stale animation before the next move,
      // so it cannot later restore an older board position.
      if (this.board?.isAnimating) {
        this.board.cancelAnimation();
        this.board.setPosition(wizardPositionAfterMoves(index));
      }
      const { move, next } = wizardMoveAt(index);
      this.currentPosition = next;
      void this.board?.animateTo(next, move);
      this.hooks.renderPosition(next, scene);
    }
    this.renderResolutionShots(elapsed, firstFrame);
    const victoryVisible = elapsed >= WIZARD_CHESS_VICTORY_AT_MS;
    if (victoryVisible && this.victory.hidden) {
      this.victory.hidden = false;
      this.board?.showResult(true);
      this.victory.focus({ preventScroll: true });
    }
    if (victoryVisible) {
      this.countdown.hidden = false;
      const seconds = Math.max(0, Math.ceil((WIZARD_CHESS_RESOLVED_DURATION_MS - elapsed) / 1000));
      const copy = this.locale === 'pt-BR'
        ? `Voltando ao Xadrez por Voz em ${seconds} s.`
        : `Returning to Voice Chess in ${seconds}s.`;
      if (this.countdown.textContent !== copy) this.countdown.textContent = copy;
    }
  }

  private renderResolutionShots(elapsed: number, firstFrame: boolean): void {
    if (firstFrame && elapsed > 1_000) {
      // Joining mid-finale must show the current shot, not replay every cut.
      let current = -1;
      for (let index = 0; index < RESOLUTION_SHOTS.length; index++) {
        if (this.resolutionShotAt(RESOLUTION_SHOTS[index]!) <= elapsed) current = index;
      }
      if (current >= 0) {
        this.resolutionShotIndex = current + 1;
        this.setShot(RESOLUTION_SHOTS[current]!.shot, { cut: true });
      }
      return;
    }
    while (this.resolutionShotIndex < RESOLUTION_SHOTS.length
      && this.resolutionShotAt(RESOLUTION_SHOTS[this.resolutionShotIndex]!) <= elapsed) {
      const beat = RESOLUTION_SHOTS[this.resolutionShotIndex++]!;
      this.setShot(beat.shot, { cut: beat.cut, durationMs: beat.durationMs });
      // Effects are not replayed after a background tab resumes or reconnects.
      if (beat.impact && elapsed - this.resolutionShotAt(beat) < 450) {
        this.board?.playWizardImpact(beat.impact);
      }
    }
  }

  private resolutionMoveAt(index: number): number {
    if (index === WIZARD_CHESS_SEQUENCE.length - 1) {
      return this.finalMoveReleaseAtMs ?? Number.POSITIVE_INFINITY;
    }
    return WIZARD_CHESS_SEQUENCE[index]!.atMs;
  }

  private resolutionShotAt(beat: WizardShotBeat): number {
    if (beat.atMs === finaleCueAt('harry-ron') && this.resolutionCueIndex < 2) {
      // Stay with Ron until his scream ends and Harry actually replies.
      return Number.POSITIVE_INFINITY;
    }
    if (beat.atMs >= mateAt && beat.atMs < WIZARD_CHESS_VICTORY_AT_MS) {
      return this.finalMoveReleaseAtMs === null ? Number.POSITIVE_INFINITY
        : beat.atMs + this.finalMoveReleaseAtMs - mateAt;
    }
    return beat.atMs;
  }

  /** Harry finishes saying "Checkmate" before his bishop moves. Slow audio may
   * hold the board briefly; a bounded release preserves the timed finale. */
  private releaseFinalMoveWhenReady(elapsed: number): void {
    if (this.finalMoveReleaseAtMs !== null || elapsed < mateAt) return;
    const checkmateInFlight = this.currentFinaleCue?.id === 'harry-checkmate'
      && (this.finaleCuePendingAudio === 'harry-checkmate'
        || this.activeAudio && this.audioSourceLine?.id === 'harry-checkmate');
    if (checkmateInFlight && elapsed < mateAt + CHECKMATE_VOICE_MAX_HOLD_MS) return;
    if (checkmateInFlight) {
      this.stopVoice();
      if (this.activeCaption) this.activeCaption.dataset.current = 'false';
      this.finalMoveReleaseAtMs = elapsed + CHECKMATE_MOVE_PAUSE_MS;
      return;
    }
    this.finalMoveReleaseAtMs = Math.max(mateAt,
      (this.checkmateVoiceEndedAtMs ?? 0) + CHECKMATE_MOVE_PAUSE_MS);
  }

  private renderFinaleCues(elapsed: number): void {
    while (this.resolutionCueIndex < WIZARD_CHESS_FINALE_CUES.length
      && WIZARD_CHESS_FINALE_CUES[this.resolutionCueIndex]!.atMs <= elapsed) {
      const cue = WIZARD_CHESS_FINALE_CUES[this.resolutionCueIndex]!;
      // Let the scream finish before Harry answers. A reaction shot can hold
      // while the vocal tail plays; an unexpectedly long clip is bounded so
      // it cannot swallow the rest of the fixed board finale.
      if (cue.id === 'harry-ron'
        && (this.finaleCuePendingAudio === 'ron-scream'
          || this.activeAudio && this.audioSourceLine?.id === 'ron-scream')
        && elapsed - cue.atMs < SCREAM_REACTION_HOLD_MS) break;
      this.resolutionCueIndex++;
      this.stopVoice();
      this.currentFinaleCue = cue;
      this.finaleCueShownAtMs = elapsed;
      this.appendLine(cue);
      const onTime = elapsed - cue.atMs < (cue.id === 'harry-ron' ? SCREAM_REACTION_HOLD_MS + 900 : 900);
      this.overlay.dataset.speaking = onTime && this.soundEnabled
        && !this.failedAudioLines.has(cue.id) ? 'true' : 'false';
      if (onTime && this.soundEnabled && !this.failedAudioLines.has(cue.id)) {
        void this.playFinaleCueAudio(cue, this.speechToken);
      } else if (onTime) this.scheduleFinaleCaptionFallback(cue, this.speechToken);
      else if (this.activeCaption) this.activeCaption.dataset.current = 'false';
    }
  }

  private scheduleFinaleCaptionFallback(cue: WizardChessFinaleCue, token: number): void {
    const elapsed = this.snapshot?.phase === 'resolved'
      ? this.serverNow() - (this.snapshot.resolvedAt ?? this.snapshot.startedAt) : cue.atMs;
    const readableUntil = this.finaleCueShownAtMs
      + (cue.id === 'ron-scream' ? 1_800 : 1_550);
    this.scheduleFinaleCaptionClear(cue, token, Math.max(100, readableUntil - elapsed));
  }

  private scheduleFinaleCaptionClear(cue: WizardChessFinaleCue, token: number,
    delayMs: number): void {
    if (this.finaleCaptionTimer) clearTimeout(this.finaleCaptionTimer);
    this.finaleCaptionTimer = setTimeout(() => {
      this.finaleCaptionTimer = null;
      if (this.isCurrentFinaleCue(cue, token) && this.activeCaption) {
        this.activeCaption.dataset.current = 'false';
      }
    }, delayMs);
  }

  private setShot(shot: WizardShot, options: { cut?: boolean; durationMs?: number } = {}): void {
    this.overlay.dataset.shot = shot;
    this.board?.setWizardShot(shot, options);
  }

  private restoreCurrentShot(): void {
    const scene = this.snapshot;
    if (!scene) return;
    if (scene.phase === 'story') {
      const chosen = this.latestLine ? STORY_SHOTS[this.latestLine.id] : null;
      this.setShot(chosen?.shot ?? 'wide', { cut: true });
    } else if (scene.phase === 'ready') this.setShot('board', { cut: true });
    else {
      const elapsed = Math.max(0, this.serverNow() - (scene.resolvedAt ?? scene.startedAt));
      const beat = RESOLUTION_SHOTS.filter(entry => entry.atMs <= elapsed).at(-1);
      this.setShot(beat?.shot ?? 'ron', { cut: true });
    }
  }

  private renderBoardHints(): void {
    if (this.snapshot?.phase !== 'ready') {
      this.board?.setHint(null, null);
      return;
    }
    this.board?.setHint('g5', 'h3');
  }

  private serverNow(): number { return Date.now() + this.clockOffsetMs; }

  private prefetchAudio(): void {
    if (this.snapshot?.phase === 'story' && !this.storySkipped) {
      this.prefetchAround(0, 4);
      this.prefetchFinaleAudio();
    }
  }

  private prefetchAround(index: number, count = 4): void {
    for (const line of WIZARD_CHESS_DIALOGUE.slice(index, index + count)) this.prefetchLine(line);
  }

  private prefetchFinaleAudio(): void {
    for (const cue of WIZARD_CHESS_FINALE_CUES) this.prefetchLine(cue);
  }

  private prefetchLine(line: WizardChessVoiceCue): void {
    if (this.failedAudioLines.has(line.id) || this.prefetchedLines.has(line.id)) return;
    this.prefetchedLines.add(line.id);
    void this.fetchAudio(line);
  }

  private fetchAudio(line: WizardChessVoiceCue): Promise<string | null> {
    const existing = this.audioUrls.get(line.id);
    if (existing) return Promise.resolve(existing);
    if (this.failedAudioLines.has(line.id)) return Promise.resolve(null);
    const pending = this.audioRequests.get(line.id);
    if (pending) return pending;
    const request = fetch(lineUrl(line.id, this.locale), { cache: 'force-cache' })
      .then(async response => {
        if (!response.ok || !response.headers.get('content-type')?.includes('audio/')) {
          if (response.status === 503) this.audioUnavailable = true;
          this.failedAudioLines.add(line.id);
          this.voiceFailed = true;
          this.renderSoundToggle();
          return null;
        }
        const blob = await response.blob();
        if (blob.size === 0 || this.disposed) {
          this.failedAudioLines.add(line.id);
          this.voiceFailed = true;
          this.renderSoundToggle();
          return null;
        }
        const url = URL.createObjectURL(blob);
        this.audioUrls.set(line.id, url);
        // A later cached line can still work after an earlier miss.
        this.renderSoundToggle();
        return url;
      }).catch(() => {
        this.failedAudioLines.add(line.id);
        this.voiceFailed = true;
        this.renderSoundToggle();
        return null;
      }).finally(() => this.audioRequests.delete(line.id));
    this.audioRequests.set(line.id, request);
    return request;
  }

  private startNextLine(): void {
    const line = WIZARD_CHESS_DIALOGUE[this.nextDialogueIndex++];
    if (!line) return;
    this.appendLine(line);
    this.latestLine = line;
    this.linePending = true;
    this.lineStartedAt = Date.now();
    const shot = STORY_SHOTS[line.id];
    this.setShot(shot?.shot ?? line.speaker, { cut: shot?.cut, durationMs: shot?.durationMs });
    this.overlay.dataset.speaking = 'true';
    this.prefetchAround(this.nextDialogueIndex);
    const token = ++this.speechToken;
    if (!this.soundEnabled || this.failedAudioLines.has(line.id)) this.scheduleCaptionEnd(line, token);
    else void this.playLineAudio(line, token);
  }

  private async waitForAudio(line: WizardChessVoiceCue, waitMs = AUDIO_WAIT_MS): Promise<string | null> {
    const cached = this.audioUrls.get(line.id);
    if (cached) return cached;
    return new Promise(resolve => {
      let settled = false;
      const finish = (url: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(url);
      };
      const timeout = setTimeout(() => finish(null), waitMs);
      void this.fetchAudio(line).then(finish, () => finish(null));
    });
  }

  private async playLineAudio(line: WizardChessDialogueLine, token: number): Promise<void> {
    const url = await this.waitForAudio(line);
    if (!this.isCurrentLine(line, token) || !this.soundEnabled) return;
    if (!url) {
      this.voiceFailed = true;
      this.renderSoundToggle();
      this.scheduleCaptionEnd(line, token);
      return;
    }
    this.audioSourceLine = line;
    this.audioMode = 'story';
    this.activeAudio = true;
    this.audio.src = url;
    void this.audio.play().catch((reason: unknown) => {
      if (!this.isCurrentLine(line, token) || this.audioSourceLine?.id !== line.id) return;
      const name = reason && typeof reason === 'object' && 'name' in reason ? reason.name : null;
      this.failCurrentAudio(line, token, name === 'NotAllowedError' || name === 'SecurityError');
    });
  }

  private async playFinaleCueAudio(cue: WizardChessFinaleCue, token: number): Promise<void> {
    this.finaleCuePendingAudio = cue.id;
    const url = await this.waitForAudio(cue, FINALE_AUDIO_WAIT_MS);
    if (this.finaleCuePendingAudio === cue.id) this.finaleCuePendingAudio = null;
    if (!this.isCurrentFinaleCue(cue, token) || !this.soundEnabled) return;
    if (!url) {
      this.voiceFailed = true;
      this.overlay.dataset.speaking = 'false';
      this.renderSoundToggle();
      this.scheduleFinaleCaptionFallback(cue, token);
      return;
    }
    this.audioSourceLine = cue;
    this.audioMode = 'finale';
    this.activeAudio = true;
    this.audio.src = url;
    void this.audio.play().catch((reason: unknown) => {
      if (!this.isCurrentFinaleCue(cue, token) || this.audioSourceLine?.id !== cue.id) return;
      const name = reason && typeof reason === 'object' && 'name' in reason ? reason.name : null;
      this.activeAudio = false;
      this.audioMode = null;
      this.audioSourceLine = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.soundNeedsGesture = true;
        this.soundEnabled = false;
      } else this.voiceFailed = true;
      this.overlay.dataset.speaking = 'false';
      this.renderSoundToggle();
      this.scheduleFinaleCaptionFallback(cue, token);
    });
  }

  private isCurrentFinaleCue(cue: WizardChessFinaleCue, token: number): boolean {
    return this.currentFinaleCue?.id === cue.id && token === this.speechToken
      && this.snapshot?.phase === 'resolved' && !this.disposed;
  }

  private isCurrentLine(line: WizardChessDialogueLine, token: number): boolean {
    return this.linePending && this.latestLine?.id === line.id && token === this.speechToken
      && this.snapshot?.phase === 'story' && !this.storySkipped;
  }

  private scheduleCaptionEnd(line: WizardChessDialogueLine, token: number): void {
    if (this.lineTimer) clearTimeout(this.lineTimer);
    const words = line.text[this.locale].match(/\p{L}+(?:['’]\p{L}+)?/gu)?.length ?? 0;
    const pauses = line.text[this.locale].match(/[,.!?;:]/g)?.length ?? 0;
    const readingMs = Math.max(1_100, 200 + words * 330 + pauses * 120);
    const remainingMs = Math.max(250, readingMs - (Date.now() - this.lineStartedAt));
    this.lineTimer = setTimeout(() => {
      this.lineTimer = null;
      if (this.isCurrentLine(line, token)) this.finishLine();
    }, remainingMs);
  }

  private finishLine(): void {
    this.linePending = false;
    this.audioSourceLine = null;
    this.audioMode = null;
    this.activeAudio = false;
    this.overlay.dataset.speaking = 'false';
    if (this.storySkipped || this.snapshot?.phase !== 'story') return;
    this.hooks.reportProgress?.(this.snapshot.id, this.nextDialogueIndex);
    this.lineTimer = setTimeout(() => {
      this.lineTimer = null;
      const scene = this.snapshot;
      if (!scene || scene.phase !== 'story' || this.storySkipped) return;
      if (this.nextDialogueIndex >= WIZARD_CHESS_DIALOGUE.length) this.requestMoveCue(scene.id);
      else this.renderStory(scene);
    }, this.latestLine?.pauseAfterMs ?? 450);
  }

  private requestMoveCue(sceneId: number): void {
    if (this.storyCompletionRequested || this.snapshot?.phase !== 'story') return;
    this.storyCompletionRequested = true;
    this.hooks.requestSkip(sceneId);
  }

  private failCurrentAudio(line: WizardChessDialogueLine, token: number, blocked: boolean): void {
    this.audioSourceLine = null;
    this.audioMode = null;
    this.activeAudio = false;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (blocked) {
      this.soundNeedsGesture = true;
      this.soundEnabled = false;
    } else this.voiceFailed = true;
    this.renderSoundToggle();
    this.scheduleCaptionEnd(line, token);
  }

  private stopVoice(): void {
    this.speechToken += 1;
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = null;
    if (this.finaleCaptionTimer) clearTimeout(this.finaleCaptionTimer);
    this.finaleCaptionTimer = null;
    this.linePending = false;
    this.finaleCuePendingAudio = null;
    this.audioSourceLine = null;
    this.audioMode = null;
    this.activeAudio = false;
    this.overlay.dataset.speaking = 'false';
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  private readonly onAudioError = (): void => {
    const failedLine = this.audioSourceLine;
    if (!failedLine) return;
    if (this.audioMode === 'story') {
      this.failCurrentAudio(failedLine as WizardChessDialogueLine, this.speechToken, false);
    } else {
      this.voiceFailed = true;
      this.renderSoundToggle();
      this.stopVoice();
      if (this.currentFinaleCue) {
        this.scheduleFinaleCaptionFallback(this.currentFinaleCue, this.speechToken);
      }
    }
  };

  private readonly onAudioEnded = (): void => {
    if (!this.activeAudio || !this.audio.ended) return;
    if (this.audioMode === 'story') this.finishLine();
    else {
      const cue = this.currentFinaleCue;
      if (cue?.id === 'harry-checkmate' && this.snapshot?.phase === 'resolved') {
        this.checkmateVoiceEndedAtMs = Math.max(0,
          this.serverNow() - (this.snapshot.resolvedAt ?? this.snapshot.startedAt));
      }
      this.activeAudio = false;
      this.audioSourceLine = null;
      this.audioMode = null;
      this.overlay.dataset.speaking = 'false';
      if (cue) this.scheduleFinaleCaptionClear(cue, this.speechToken, FINALE_CAPTION_TAIL_MS);
    }
  };

  private readonly onSoundToggle = (): void => {
    const retryFailed = this.audioUnavailable || this.voiceFailed;
    if (retryFailed) {
      this.audioUnavailable = false;
      this.voiceFailed = false;
      this.failedAudioLines.clear();
      this.prefetchedLines.clear();
      this.soundEnabled = true;
    } else this.soundEnabled = !this.soundEnabled;
    this.soundNeedsGesture = false;
    this.renderSoundToggle();
    if (this.snapshot?.phase === 'resolved') {
      if (!this.soundEnabled) {
        this.stopVoice();
        if (this.currentFinaleCue) {
          this.scheduleFinaleCaptionFallback(this.currentFinaleCue, this.speechToken);
        }
      }
      else if (this.currentFinaleCue) {
        const elapsed = this.serverNow() - (this.snapshot.resolvedAt ?? this.snapshot.startedAt);
        if (elapsed - this.currentFinaleCue.atMs < 3_500
          && (this.currentFinaleCue.id !== 'harry-checkmate'
            || this.finalMoveReleaseAtMs === null)) {
          this.stopVoice();
          if (this.activeCaption) this.activeCaption.dataset.current = 'true';
          this.overlay.dataset.speaking = 'true';
          void this.playFinaleCueAudio(this.currentFinaleCue, this.speechToken);
        }
      }
      return;
    }
    if (this.snapshot?.phase !== 'story' || !this.linePending || !this.latestLine) return;
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = null;
    if (this.activeAudio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audioSourceLine = null;
      this.activeAudio = false;
    }
    const token = ++this.speechToken;
    if (this.soundEnabled) {
      this.lineStartedAt = Date.now();
      void this.playLineAudio(this.latestLine, token);
    } else this.scheduleCaptionEnd(this.latestLine, token);
  };

  private readonly onSkip = (event: MouseEvent): void => {
    if (!this.snapshot || this.snapshot.phase !== 'story') return;
    this.storySkipped = true;
    this.focusMoveHintWhenReady = event.detail === 0;
    this.stopVoice();
    this.skipButton.hidden = true;
    this.hooks.requestSkip(this.snapshot.id);
  };

  private renderSoundToggle(): void {
    const hasFailures = this.audioUnavailable || this.voiceFailed;
    const partial = hasFailures && this.audioUrls.size > 0;
    this.soundToggle.setAttribute('aria-pressed', String(this.soundEnabled));
    this.soundToggle.dataset.state = this.soundNeedsGesture ? 'blocked'
      : partial ? 'partial' : hasFailures ? 'unavailable'
        : this.soundEnabled ? 'on' : 'off';
    const label = this.locale === 'pt-BR'
      ? this.soundNeedsGesture ? 'Toque para ativar as vozes dos personagens'
        : partial ? 'Algumas vozes precisam de nova tentativa'
          : hasFailures ? 'Vozes indisponíveis · tentar novamente'
          : this.soundEnabled ? 'Vozes dos personagens ativadas' : 'Ativar vozes dos personagens'
      : this.soundNeedsGesture ? 'Tap to enable character voices'
        : partial ? 'Some character voices need retry'
          : hasFailures ? 'Character voices unavailable · retry'
          : this.soundEnabled ? 'Character voices on' : 'Enable character voices';
    this.soundLabel.textContent = label;
    this.soundToggle.setAttribute('aria-label', label);
    this.soundToggle.title = label;
  }

  private localize(): void {
    this.title.textContent = this.locale === 'pt-BR' ? 'A câmara do xadrez bruxo' : 'The Wizard Chess chamber';
    this.transcript.setAttribute('aria-label', this.locale === 'pt-BR' ? 'Conversa dos personagens' : 'Character conversation');
    this.skipButton.textContent = this.locale === 'pt-BR' ? 'Pular história' : 'Skip story';
    const heading = this.victory.querySelector('h3');
    const detail = this.victory.querySelector('p');
    if (heading) heading.textContent = this.locale === 'pt-BR' ? 'A câmara foi vencida' : 'The chamber is won';
    if (detail) detail.textContent = this.locale === 'pt-BR' ? 'O caminho à frente está aberto.' : 'The path ahead is open.';
    this.countdown.textContent = this.locale === 'pt-BR'
      ? 'Voltando ao Xadrez por Voz em instantes.' : 'Returning to Voice Chess shortly.';
  }
}
