import type { WizardChessSceneSnapshot } from '../../shared/chess-protocol';
import type { SupportedLocale } from '../../shared/i18n/locales';
import {
  WIZARD_CHESS_DIALOGUE, WIZARD_CHESS_RESOLVED_DURATION_MS,
  WIZARD_CHESS_SEQUENCE, WIZARD_CHESS_VICTORY_AT_MS,
  WIZARD_CHESS_VOICE_IDS,
  type WizardChessDialogueLine,
} from '../../shared/wizard-chess-scene';
import type { ChessBoardScene, BoardPiece } from './chess-board';
import { wizardMoveAt, wizardPositionAfterMoves } from './wizard-scene-state';

const characters = { ron: 'Ron', harry: 'Harry', hermione: 'Hermione' } as const;
function audioVersion(locale: SupportedLocale): string {
  const content = JSON.stringify({ voices: WIZARD_CHESS_VOICE_IDS,
    lines: WIZARD_CHESS_DIALOGUE.map(line => [line.id, line.speaker, line.text[locale]]) });
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
const lineUrl = (id: string, locale: SupportedLocale): string =>
  `/api/chess/wizard-audio/${encodeURIComponent(id)}?locale=${encodeURIComponent(locale)}&v=${audioVersion(locale)}`;
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const BETWEEN_LINES_MS = 150;
const AUDIO_WAIT_MS = 6_000;
const RECONNECT_REPLAY_WINDOW_MS = 8_000;

interface WizardSceneHooks {
  renderPosition: (position: readonly BoardPiece[], scene: WizardChessSceneSnapshot) => void;
  onActiveChange: (active: boolean) => void;
  setMusicVolume: (volume: number) => void;
  requestSkip: (sceneId: number) => void;
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
  private readonly prefetchedLines = new Set<string>();
  private readonly shownLines = new Set<string>();
  private board: ChessBoardScene | null = null;
  private snapshot: WizardChessSceneSnapshot | null = null;
  private currentPosition: BoardPiece[] = wizardPositionAfterMoves(0);
  private latestLine: WizardChessDialogueLine | null = null;
  private audioSourceLine: WizardChessDialogueLine | null = null;
  private activeAudio = false;
  private linePending = false;
  private lineStartedAt = 0;
  private nextDialogueIndex = 0;
  private storyInitialized = false;
  private storyCompletionRequested = false;
  private focusMoveHintWhenReady = false;
  private lineTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private soundEnabled = true;
  private soundNeedsGesture = false;
  private speechToken = 0;
  private storySkipped = false;
  private resolutionStarted = false;
  private resolutionNextIndex = 0;
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
      this.stopVoice();
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
    this.shownLines.clear();
    this.prefetchedLines.clear();
    this.latestLine = null;
    this.nextDialogueIndex = 0;
    this.storyInitialized = false;
    this.storyCompletionRequested = false;
    this.focusMoveHintWhenReady = false;
    this.audioUnavailable = false;
    this.voiceFailed = false;
    this.renderSoundToggle();
    this.currentPosition = wizardPositionAfterMoves(0);
    this.transcript.replaceChildren();
    this.overlay.hidden = false;
    this.overlay.dataset.phase = snapshot.phase;
    this.moveHint.hidden = true;
    this.victory.hidden = true;
    this.countdown.hidden = true;
    this.skipButton.hidden = false;
    this.title.textContent = this.locale === 'pt-BR' ? 'A câmara do xadrez bruxo' : 'The Wizard Chess chamber';
    this.board?.setHumanColor('w');
    this.board?.setWizardMode(true);
    this.board?.setPosition(this.currentPosition);
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
      const elapsed = Math.max(0, this.serverNow() - scene.startedAt);
      if (elapsed > RECONNECT_REPLAY_WINDOW_MS) {
        const upcoming = WIZARD_CHESS_DIALOGUE.findIndex(line => line.atMs > elapsed);
        this.nextDialogueIndex = upcoming < 0 ? WIZARD_CHESS_DIALOGUE.length
          : Math.max(0, upcoming - 1);
        for (let index = 0; index < this.nextDialogueIndex; index++) {
          const line = WIZARD_CHESS_DIALOGUE[index]!;
          this.appendLine(line);
          this.latestLine = line;
        }
      }
    }
    if (this.nextDialogueIndex >= WIZARD_CHESS_DIALOGUE.length) {
      this.requestMoveCue(scene.id);
      return;
    }
    this.startNextLine();
  }

  private appendLine(line: WizardChessDialogueLine): void {
    this.shownLines.add(line.id);
    this.board?.setWizardSpeaker(line.speaker);
    const bubble = document.createElement('div');
    bubble.className = 'wizard-message';
    bubble.dataset.speaker = line.speaker;
    const speaker = document.createElement('strong');
    speaker.className = 'wizard-message-speaker';
    speaker.textContent = characters[line.speaker];
    const text = document.createElement('p');
    text.textContent = line.text[this.locale];
    bubble.append(speaker, text);
    this.transcript.append(bubble);
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
    const copy = this.locale === 'pt-BR'
      ? 'Sua vez: diga “cavalo para H3” no telefone agora.'
      : 'Your turn: say “Knight to H3” on the phone now.';
    if (this.moveHint.textContent !== copy) this.moveHint.textContent = copy;
    this.moveHint.hidden = false;
    this.skipButton.hidden = true;
    if (focus) this.moveHint.focus({ preventScroll: true });
  }

  private renderResolution(scene: WizardChessSceneSnapshot): void {
    const elapsed = Math.max(0, this.serverNow() - (scene.resolvedAt ?? scene.startedAt));
    const completed = WIZARD_CHESS_SEQUENCE.filter((step, index) =>
      step.atMs + (wizardMoveAt(index).move.captured ? 1_230 : 780) <= elapsed).length;
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
      && WIZARD_CHESS_SEQUENCE[this.resolutionNextIndex]!.atMs <= elapsed) {
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
      this.prefetchAround(0);
    }
  }

  private prefetchAround(index: number, count = 2): void {
    for (const line of WIZARD_CHESS_DIALOGUE.slice(index, index + count)) this.prefetchLine(line);
  }

  private prefetchLine(line: WizardChessDialogueLine): void {
    if (this.audioUnavailable || this.prefetchedLines.has(line.id)) return;
    this.prefetchedLines.add(line.id);
    void this.fetchAudio(line);
  }

  private fetchAudio(line: WizardChessDialogueLine): Promise<string | null> {
    const existing = this.audioUrls.get(line.id);
    if (existing) return Promise.resolve(existing);
    if (this.audioUnavailable) return Promise.resolve(null);
    const pending = this.audioRequests.get(line.id);
    if (pending) return pending;
    const request = fetch(lineUrl(line.id, this.locale), { cache: 'force-cache' })
      .then(async response => {
        if (!response.ok || !response.headers.get('content-type')?.includes('audio/')) {
          if (response.status === 503) this.audioUnavailable = true;
          this.voiceFailed = true;
          this.renderSoundToggle();
          return null;
        }
        const blob = await response.blob();
        if (blob.size === 0 || this.disposed) {
          this.voiceFailed = true;
          this.renderSoundToggle();
          return null;
        }
        const url = URL.createObjectURL(blob);
        this.audioUrls.set(line.id, url);
        return url;
      }).catch(() => {
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
    // Ron's first reply gives the four short exchanges time to synthesize
    // before their quick handoffs; the final long line warms a little later.
    this.prefetchAround(this.nextDialogueIndex, line.id === 'ron-sacrifice' ? 4 : 2);
    const token = ++this.speechToken;
    if (!this.soundEnabled || this.audioUnavailable) this.scheduleCaptionEnd(line, token);
    else void this.playLineAudio(line, token);
  }

  private async waitForAudio(line: WizardChessDialogueLine): Promise<string | null> {
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
      const timeout = setTimeout(() => finish(null), AUDIO_WAIT_MS);
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
    this.activeAudio = true;
    this.audio.src = url;
    void this.audio.play().catch((reason: unknown) => {
      if (!this.isCurrentLine(line, token) || this.audioSourceLine?.id !== line.id) return;
      const name = reason && typeof reason === 'object' && 'name' in reason ? reason.name : null;
      this.failCurrentAudio(line, token, name === 'NotAllowedError' || name === 'SecurityError');
    });
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
    this.activeAudio = false;
    if (this.storySkipped || this.snapshot?.phase !== 'story') return;
    this.lineTimer = setTimeout(() => {
      this.lineTimer = null;
      const scene = this.snapshot;
      if (!scene || scene.phase !== 'story' || this.storySkipped) return;
      if (this.nextDialogueIndex >= WIZARD_CHESS_DIALOGUE.length) this.requestMoveCue(scene.id);
      else this.renderStory(scene);
    }, BETWEEN_LINES_MS);
  }

  private requestMoveCue(sceneId: number): void {
    if (this.storyCompletionRequested || this.snapshot?.phase !== 'story') return;
    this.storyCompletionRequested = true;
    this.hooks.requestSkip(sceneId);
  }

  private failCurrentAudio(line: WizardChessDialogueLine, token: number, blocked: boolean): void {
    this.audioSourceLine = null;
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
    this.linePending = false;
    this.audioSourceLine = null;
    this.activeAudio = false;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  private readonly onAudioError = (): void => {
    const failedLine = this.audioSourceLine;
    if (failedLine) this.failCurrentAudio(failedLine, this.speechToken, false);
  };

  private readonly onAudioEnded = (): void => {
    if (!this.activeAudio || !this.audio.ended) return;
    this.finishLine();
  };

  private readonly onSoundToggle = (): void => {
    const retryFailed = this.audioUnavailable || this.voiceFailed;
    if (retryFailed) {
      this.audioUnavailable = false;
      this.voiceFailed = false;
      this.prefetchedLines.clear();
      this.soundEnabled = true;
    } else this.soundEnabled = !this.soundEnabled;
    this.soundNeedsGesture = false;
    this.renderSoundToggle();
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
    this.soundToggle.setAttribute('aria-pressed', String(this.soundEnabled));
    this.soundToggle.dataset.state = this.soundNeedsGesture ? 'blocked'
      : this.audioUnavailable || this.voiceFailed ? 'unavailable'
        : this.soundEnabled ? 'on' : 'off';
    const label = this.locale === 'pt-BR'
      ? this.soundNeedsGesture ? 'Toque para ativar as vozes dos personagens'
        : this.audioUnavailable || this.voiceFailed ? 'Vozes indisponíveis · tentar novamente'
          : this.soundEnabled ? 'Vozes dos personagens ativadas' : 'Ativar vozes dos personagens'
      : this.soundNeedsGesture ? 'Tap to enable character voices'
        : this.audioUnavailable || this.voiceFailed ? 'Character voices unavailable · retry'
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
