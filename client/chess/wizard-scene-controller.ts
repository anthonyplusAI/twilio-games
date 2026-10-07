import type { WizardChessSceneSnapshot } from '../../shared/chess-protocol';
import type { SupportedLocale } from '../../shared/i18n/locales';
import {
  WIZARD_CHESS_DIALOGUE, WIZARD_CHESS_RESOLVED_DURATION_MS,
  WIZARD_CHESS_SEQUENCE, WIZARD_CHESS_STORY_DURATION_MS, WIZARD_CHESS_VICTORY_AT_MS,
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
const VOICE_END_GUARD_MS = 500;
const BROWSER_SPEECH_RATE = 1.3;

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
  private readonly audioDurations = new Map<string, Promise<number | null>>();
  private readonly prefetchedLines = new Set<string>();
  private readonly shownLines = new Set<string>();
  private board: ChessBoardScene | null = null;
  private snapshot: WizardChessSceneSnapshot | null = null;
  private currentPosition: BoardPiece[] = wizardPositionAfterMoves(0);
  private latestLine: WizardChessDialogueLine | null = null;
  private audioSourceLine: WizardChessDialogueLine | null = null;
  private browserUtterance: SpeechSynthesisUtterance | null = null;
  private queuedLine: WizardChessDialogueLine | null = null;
  private activeAudio = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private soundEnabled = true;
  private soundNeedsGesture = false;
  private speechToken = 0;
  private storySkipped = false;
  private resolutionStarted = false;
  private resolutionNextIndex = 0;
  private clockOffsetMs = 0;
  private audioUnavailable = false;
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

  /** Warm only Ron's opening line while the join QR is displayed. */
  prefetchOpeningVoice(): void {
    if (!this.disposed) this.prefetchLine(WIZARD_CHESS_DIALOGUE[0]!);
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
    if (snapshot.phase !== 'story') this.rebuildCaptions(snapshot);
    if (snapshot.phase === 'ready') {
      if (previousPhase !== 'ready') {
        this.storySkipped = true;
        this.stopVoice();
      }
      this.revealMoveHint();
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
    this.audioDurations.clear();
  }

  private enter(snapshot: WizardChessSceneSnapshot): void {
    this.stopVoice();
    this.snapshot = snapshot;
    this.storySkipped = false;
    this.resolutionStarted = false;
    this.resolutionNextIndex = 0;
    this.shownLines.clear();
    this.latestLine = null;
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
    const elapsed = Math.max(0, Math.min(WIZARD_CHESS_STORY_DURATION_MS,
      this.serverNow() - scene.startedAt));
    const due = WIZARD_CHESS_DIALOGUE.filter(line => line.atMs <= elapsed);
    const upcoming = WIZARD_CHESS_DIALOGUE[due.length];
    if (upcoming) this.prefetchLine(upcoming);
    for (const line of due) {
      if (this.shownLines.has(line.id)) continue;
      this.appendLine(line);
      this.latestLine = line;
    }
    // A reconnect should rebuild captions, not play every missed line in quick succession.
    const newest = due.at(-1);
    if (newest && !this.shownLines.has(`spoken:${newest.id}`)
      && elapsed - newest.atMs < 1_900) {
      this.shownLines.add(`spoken:${newest.id}`);
      this.queueVoice(newest);
    }
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

  private rebuildCaptions(scene: WizardChessSceneSnapshot): void {
    const transitionAt = scene.readyAt ?? scene.resolvedAt ?? scene.startedAt;
    const elapsed = Math.max(0, Math.min(WIZARD_CHESS_STORY_DURATION_MS,
      transitionAt - scene.startedAt));
    for (const line of WIZARD_CHESS_DIALOGUE) {
      if (line.atMs <= elapsed && !this.shownLines.has(line.id)) {
        this.appendLine(line);
        this.latestLine = line;
      }
    }
  }

  private revealMoveHint(focus = false): void {
    const copy = this.locale === 'pt-BR'
      ? 'Dica: diga no telefone “mova o cavalo do Ron para H3”. Você pode falar a qualquer momento.'
      : 'Hint: say “move Ron’s knight to H3” on the phone. You can speak at any time.';
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
    if (!this.snapshot || this.snapshot.phase === 'resolved') {
      this.board?.setHint(null, null);
      return;
    }
    this.board?.setHint('g5', 'h3');
  }

  private serverNow(): number { return Date.now() + this.clockOffsetMs; }

  private prefetchAudio(): void {
    if (this.snapshot?.phase === 'story' && !this.storySkipped) {
      this.prefetchLine(WIZARD_CHESS_DIALOGUE[0]!);
    }
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
          return null;
        }
        const blob = await response.blob();
        if (blob.size === 0 || this.disposed) return null;
        const url = URL.createObjectURL(blob);
        this.audioUrls.set(line.id, url);
        // Decode metadata while the next caption is still approaching. Blob
        // URLs are local, so this does not consume another network request.
        void this.audioDuration(line, url);
        return url;
      }).catch(() => null).finally(() => this.audioRequests.delete(line.id));
    this.audioRequests.set(line.id, request);
    return request;
  }

  private queueVoice(line: WizardChessDialogueLine): void {
    if (!this.soundEnabled || this.storySkipped || this.snapshot?.phase !== 'story') return;
    this.queuedLine = line;
    const token = ++this.speechToken;
    if (!this.activeAudio && !this.browserUtterance) void this.playQueuedLine(line, token);
  }

  private async playQueuedLine(line: WizardChessDialogueLine, token: number): Promise<void> {
    if (!this.canSpeak(line, token)) return;
    const cached = this.audioUrls.get(line.id);
    const url = cached ?? await Promise.race([
      this.fetchAudio(line), new Promise<null>(resolve => setTimeout(() => resolve(null), 2_400)),
    ]);
    if (!this.canSpeak(line, token)) return;
    if (this.activeAudio || this.browserUtterance) return;
    if (url) {
      const durationMs = await this.audioDuration(line, url);
      if (!this.canSpeak(line, token)) return;
      if (this.activeAudio || this.browserUtterance) return;
      if (durationMs !== null) {
        this.queuedLine = null;
        if (this.fitsVoiceWindow(line, durationMs)) this.startAudio(url, line);
        return;
      }
    }
    this.queuedLine = null;
    this.speakBrowser(line);
  }

  private canSpeak(line: WizardChessDialogueLine, token: number): boolean {
    return token === this.speechToken && this.queuedLine?.id === line.id
      && this.soundEnabled && !this.storySkipped && this.snapshot?.phase === 'story'
      && this.remainingVoiceWindowMs(line) > VOICE_END_GUARD_MS;
  }

  private remainingVoiceWindowMs(line: WizardChessDialogueLine): number {
    const scene = this.snapshot;
    if (!scene || scene.phase !== 'story') return 0;
    const index = WIZARD_CHESS_DIALOGUE.findIndex(candidate => candidate.id === line.id);
    if (index < 0) return 0;
    const nextCue = WIZARD_CHESS_DIALOGUE[index + 1]?.atMs ?? WIZARD_CHESS_STORY_DURATION_MS;
    const deadline = Math.min(scene.startedAt + nextCue, scene.readyAt ?? Infinity);
    return deadline - this.serverNow();
  }

  private fitsVoiceWindow(line: WizardChessDialogueLine, durationMs: number): boolean {
    return Number.isFinite(durationMs) && durationMs > 0
      && durationMs + VOICE_END_GUARD_MS <= this.remainingVoiceWindowMs(line);
  }

  private audioDuration(line: WizardChessDialogueLine, url: string): Promise<number | null> {
    const existing = this.audioDurations.get(line.id);
    if (existing) return existing;
    const duration = new Promise<number | null>(resolve => {
      const probe = new Audio();
      probe.preload = 'metadata';
      let finished = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (measured: number | null) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        probe.removeEventListener('loadedmetadata', read);
        probe.removeEventListener('durationchange', read);
        probe.removeEventListener('error', fail);
        probe.pause();
        probe.removeAttribute('src');
        probe.load();
        resolve(measured);
      };
      const read = () => {
        const seconds = Number.isFinite(probe.duration) ? probe.duration
          : probe.seekable?.length ? probe.seekable.end(probe.seekable.length - 1) : NaN;
        if (Number.isFinite(seconds) && seconds > 0) finish(seconds * 1_000);
      };
      const fail = () => finish(null);
      probe.addEventListener('loadedmetadata', read);
      probe.addEventListener('durationchange', read);
      probe.addEventListener('error', fail);
      timeout = setTimeout(fail, 1_200);
      probe.src = url;
      probe.load();
      read();
    });
    this.audioDurations.set(line.id, duration);
    return duration;
  }

  private startAudio(url: string, line: WizardChessDialogueLine): void {
    this.audioSourceLine = line;
    this.activeAudio = true;
    this.audio.src = url;
    void this.audio.play().catch((reason: unknown) => {
      if (this.audioSourceLine?.id !== line.id) return;
      const name = reason && typeof reason === 'object' && 'name' in reason ? reason.name : null;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.soundNeedsGesture = true;
        this.soundEnabled = false;
        this.renderSoundToggle();
        this.stopVoice();
      } else this.onAudioError();
    });
  }

  private speakBrowser(line: WizardChessDialogueLine): void {
    if (!this.soundEnabled || this.storySkipped || this.snapshot?.phase !== 'story'
      || !('speechSynthesis' in window)) return;
    // SpeechSynthesis has no duration metadata. Estimate conservatively and
    // keep it playing through a later caption cue if this browser runs slower.
    const words = line.text[this.locale].match(/\p{L}+(?:['’]\p{L}+)?/gu)?.length ?? 0;
    const pauses = line.text[this.locale].match(/[,.!?;:]/g)?.length ?? 0;
    if (!this.fitsVoiceWindow(line, 100 + words * 315 + pauses * 150)) return;
    try {
      const utterance = new SpeechSynthesisUtterance(line.text[this.locale]);
      utterance.lang = this.locale;
      utterance.rate = BROWSER_SPEECH_RATE;
      utterance.onend = utterance.onerror = () => {
        if (this.browserUtterance !== utterance) return;
        this.browserUtterance = null;
        this.flushQueuedVoice();
      };
      this.browserUtterance = utterance;
      window.speechSynthesis.speak(utterance);
    } catch {
      this.browserUtterance = null;
      // Captions remain available without screen audio.
    }
  }

  private flushQueuedVoice(): void {
    if (this.queuedLine && !this.activeAudio && !this.browserUtterance) {
      void this.playQueuedLine(this.queuedLine, this.speechToken);
    }
  }

  private stopVoice(): void {
    this.speechToken += 1;
    this.queuedLine = null;
    this.audioSourceLine = null;
    this.activeAudio = false;
    this.browserUtterance = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  private readonly onAudioError = (): void => {
    const failedLine = this.audioSourceLine;
    if (!failedLine) return;
    this.audioSourceLine = null;
    this.activeAudio = false;
    if (!this.queuedLine && this.latestLine?.id === failedLine.id) this.speakBrowser(failedLine);
    this.flushQueuedVoice();
  };

  private readonly onAudioEnded = (): void => {
    if (!this.activeAudio || !this.audio.ended) return;
    this.audioSourceLine = null;
    this.activeAudio = false;
    this.flushQueuedVoice();
  };

  private readonly onSoundToggle = (): void => {
    this.soundEnabled = !this.soundEnabled;
    this.soundNeedsGesture = false;
    this.renderSoundToggle();
    if (!this.soundEnabled) this.stopVoice();
    else if (this.latestLine && this.snapshot?.phase === 'story' && !this.storySkipped)
      this.queueVoice(this.latestLine);
  };

  private readonly onSkip = (event: MouseEvent): void => {
    if (!this.snapshot || this.snapshot.phase !== 'story') return;
    this.storySkipped = true;
    this.stopVoice();
    this.revealMoveHint(event.detail === 0);
    this.hooks.requestSkip(this.snapshot.id);
  };

  private renderSoundToggle(): void {
    this.soundToggle.setAttribute('aria-pressed', String(this.soundEnabled));
    this.soundToggle.dataset.state = this.soundNeedsGesture ? 'blocked'
      : this.soundEnabled ? 'on' : 'off';
    const label = this.locale === 'pt-BR'
      ? this.soundNeedsGesture ? 'Toque para ativar as vozes' : this.soundEnabled ? 'Vozes na tela' : 'Ativar vozes'
      : this.soundNeedsGesture ? 'Tap to enable voices' : this.soundEnabled ? 'Screen voices on' : 'Enable screen voices';
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
