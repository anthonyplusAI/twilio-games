import { DEFAULT_ROOM } from '../../shared/constants';
import type { TriviaEvent, TriviaState } from '../../shared/trivia-protocol';
import QRCode from 'qrcode';
import { createStationDisplay } from '../station-display';
import { rejectDisplayToken, watchVoiceNumber } from '../station-client';
import { commonText, injectLanguagePicker, locale } from '../i18n';
import { injectFullscreenToggle } from '../fullscreen-toggle';
import { getMusicManager } from '../music-manager';
import { injectMusicToggle } from '../music-toggle';
import { getSoundEffectsManager } from '../sound-effects';
import { wireThemeToggle } from '../theme';
import {
  TriviaCountdownSoundCue,
  TriviaServerClock,
  isInteractiveTriviaShortcutTarget,
  resolveTriviaWebSocketUrl,
  triviaCountdownCount,
  triviaDisplayPairingRequired,
  triviaLocalKeyboardCommand,
  triviaLocalKeyboardTestingAllowed,
  triviaQuestionTiming,
} from './trivia-client-utils';
import { TriviaConnection, type TriviaConnectionState } from './trivia-net';
import {
  renderTriviaView,
  triviaDisplayCopy,
  type TriviaAnswerResultView,
} from './trivia-view';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stage = element('trivia-stage');
const announcer = element('announcer');
const connectionStatus = element('connection-status');
const copy = triviaDisplayCopy(locale);
const serverClock = new TriviaServerClock(Date.now(), performance.now());
const musicManager = getMusicManager();
const soundEffects = getSoundEffectsManager();
const countdownSound = new TriviaCountdownSoundCue();

const pageUrl = new URL(location.href);
if (pageUrl.searchParams.has('hostToken')) {
  pageUrl.searchParams.delete('hostToken');
  history.replaceState(history.state, '', `${pageUrl.pathname}${pageUrl.search}${pageUrl.hash}`);
}
const params = pageUrl.searchParams;
const roomCode = params.get('room') || DEFAULT_ROOM;
const stationDisplay = createStationDisplay();
const stationLaunchRequested = params.has('station') || params.has('match') || params.has('launchGeneration');
const stationMode = stationDisplay.active || stationLaunchRequested;
const requestedSeats = Number(params.get('players'));
const standaloneSeatTarget = !stationMode && params.has('players')
  && Number.isSafeInteger(requestedSeats) && requestedSeats >= 1 && requestedSeats <= 4
  ? requestedSeats as 1 | 2 | 3 | 4 : null;
let pairingRequired = triviaDisplayPairingRequired(location.hostname, stationLaunchRequested, stationDisplay.displayToken);
const localKeyboardTestingAllowed = triviaLocalKeyboardTestingAllowed(
  location.hostname, stationMode, roomCode,
);

let connection: TriviaConnection | null = null;
let connectionState: TriviaConnectionState = 'connecting';
let state: TriviaState | null = null;
let isHost = false;
let localTester = false;
let localTesterPending = false;
let playerId: string | null = null;
let audioUnlocked = false;
let essentialStageReady = false;
let readySentGeneration = 0;
let rejectedReadyContext = '';
let stageError = '';
let lastAnnouncementKey = '';
let countdownAnnouncement = '';
let questionTimeAnnouncement = '';
let lastTimeUiFrame = 0;
let pendingAnnouncementFrame: number | null = null;
let lastPaintAckKey = '';
let pendingPaintAckKey = '';
let pendingCategoryVoteSeat: string | null = null;
let pendingCategoryVoteTimer: ReturnType<typeof setTimeout> | null = null;
let callNumber = '';
let callQrCode: string | null = null;
let callQrLoading = false;
let callQrGeneration = 0;
const answerResults = new Map<string, TriviaAnswerResultView>();

document.title = copy.app;
document.body.dataset.phase = 'connecting';
const homeLink = document.querySelector<HTMLAnchorElement>('.game-home');
const homeText = homeLink?.querySelector<HTMLElement>('span');
if (homeText) homeText.textContent = copy.home;
homeLink?.setAttribute('aria-label', copy.homeLabel);
stage.setAttribute('aria-label', copy.stageLabel);
connectionStatus.textContent = copy.connection.connecting;
injectMusicToggle('music-toggle-container');
injectFullscreenToggle('trivia-controls', {
  enter: commonText('fullscreen.enter'), exit: commonText('fullscreen.exit'),
}, 'round-control');
injectLanguagePicker('trivia-controls');
wireThemeToggle(element('theme-toggle'), {
  light: copy.theme.light,
  dark: copy.theme.dark,
});
musicManager.switchContext('lobby');

const stopVoiceNumberUpdates = stationMode ? () => undefined : watchVoiceNumber(locale, async number => {
  const generation = ++callQrGeneration;
  callNumber = number.trim();
  callQrCode = null;
  callQrLoading = Boolean(callNumber);
  render();
  if (!callNumber) return;
  try {
    const qr = await QRCode.toDataURL(`tel:${callNumber}`, {
      width: 520, margin: 1, color: { dark: '#000D25', light: '#FFFFFF' }, errorCorrectionLevel: 'M',
    });
    if (generation !== callQrGeneration) return;
    callQrCode = qr;
  } catch {
    if (generation !== callQrGeneration) return;
    callQrCode = null;
  }
  callQrLoading = false;
  render();
});

if (!pairingRequired) connect();
void prepareEssentialStage();
render();
requestAnimationFrame(updateTimeDrivenUi);

addEventListener('pagehide', () => {
  callQrGeneration += 1;
  clearPendingCategoryVote();
  stopVoiceNumberUpdates();
  connection?.close();
  musicManager.stop();
}, { once: true });
addEventListener('pointerdown', resumeTriviaAudio, { passive: true });
addEventListener('keydown', event => {
  resumeTriviaAudio();
  if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || isInteractiveTriviaShortcutTarget(event.target) || !connection) return;
  const command = triviaLocalKeyboardCommand(event.key, {
    allowed: localKeyboardTestingAllowed,
    testerEnabled: localTester,
    joined: playerId !== null,
    connected: connectionState === 'connected',
    isHost,
    state,
  });
  if (!command) return;
  switch (command.type) {
    case 'join':
      localTester = true;
      localTesterPending = true;
      connection.join(roomCode, locale === 'pt-BR' ? 'Jogador local' : 'Local Player');
      break;
    case 'leave':
      localTester = false;
      localTesterPending = false;
      playerId = null;
      connection.leave(roomCode);
      break;
    case 'advance': connection.advance(); break;
    case 'select_category': connection.selectCategory(command.category); break;
    case 'keyboard_answer': connection.keyboardAnswer(command.choiceId); break;
  }
  event.preventDefault();
});
stage.addEventListener('click', event => {
  const category = (event.target as Element | null)?.closest?.<HTMLButtonElement>('[data-category][data-voter]');
  if (category && state?.phase === 'category_select' && isHost && connectionState === 'connected'
    && category.dataset.voter === state.categoryVotingSeat?.playerId) {
    const seat = category.dataset.voter!;
    if (pendingCategoryVoteSeat === seat) return;
    clearPendingCategoryVote();
    pendingCategoryVoteSeat = seat;
    pendingCategoryVoteTimer = setTimeout(() => {
      if (pendingCategoryVoteSeat !== seat) return;
      clearPendingCategoryVote();
      render();
    }, 5_000);
    connection?.displaySelectCategory(seat, category.dataset.category as NonNullable<TriviaState['category']>);
    render();
    return;
  }
  const replay = (event.target as Element | null)?.closest?.('#trivia-replay');
  if (!replay || !isHost || connectionState !== 'connected' || state?.phase !== 'results'
    || stationMode || !state.players.length) return;
  if (state.expectedPlayerCount > 1) {
    const seat = state.replayVotingSeat;
    if (seat) connection?.displayReplay(seat.playerId);
    else if (seat === undefined) connection?.advance();
  } else connection?.advance();
});

function connect(): void {
  try {
    connection = new TriviaConnection(resolveTriviaWebSocketUrl(location, params.get('ws'), true), locale);
  } catch (error) {
    connectionState = 'closed';
    stageError = error instanceof Error ? error.message : copy.connection.closed;
    render();
    return;
  }
  if (stationLaunchRequested) connection.setDisplayAuth(roomCode, stationDisplay.displayToken);
  connection.onConnectionState(next => {
    connectionState = next;
    connectionStatus.dataset.state = next;
    connectionStatus.textContent = copy.connection[next];
    if (next !== 'connected') {
      isHost = false;
      lastPaintAckKey = '';
      pendingPaintAckKey = '';
      clearPendingCategoryVote();
    }
    render();
  });
  connection.onClockSync(sample => serverClock.observeSync(sample));
  connection.onJoined(id => {
    playerId = id;
    localTester = true;
    localTesterPending = false;
    render();
  });
  connection.onHostIdentity(host => {
    isHost = host;
    maybeSignalDisplayReady();
    render();
  });
  connection.onEvents(handleEvents);
  connection.onError((code, message) => {
    console.error(`[trivia] ${code}: ${message}`);
    clearPendingCategoryVote();
    if (localTesterPending && ['station_voice_only', 'room_full', 'round_in_progress', 'forbidden'].includes(code)) {
      localTester = false;
      localTesterPending = false;
      playerId = null;
      connection?.leave(roomCode);
      return;
    }
    if (code === 'answer_rejected') return;
    if (code === 'not_ready') {
      if (state?.phase === 'loading' && readySentGeneration === state.loadingGeneration) {
        readySentGeneration = 0;
        rejectedReadyContext = displayReadinessContext(state);
      }
      return;
    }
    if (code === 'bad_display_auth') {
      rejectDisplayToken(stationDisplay.displayToken);
      pairingRequired = stationLaunchRequested;
      connection?.close();
    }
    stageError = localizedError(code);
    render();
  });
  connection.onState(applyState);
  if (standaloneSeatTarget) connection.configureSeats(roomCode, standaloneSeatTarget);
  connection.spectate(roomCode);
}

async function prepareEssentialStage(): Promise<void> {
  try {
    if (document.fonts) await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  } catch (error) {
    console.warn('Trivia font readiness failed; using the loaded fallback fonts.', error);
  } finally {
    essentialStageReady = true;
    stationDisplay.markEngineReady();
    maybeSignalDisplayReady();
    render();
  }
}

function applyState(next: TriviaState): void {
  serverClock.observeSync({ serverNowMs: next.serverNowMs, clientReceivedAtMs: Date.now() });
  const previousQuestionKey = `${state?.question?.id}:${state?.questionAttemptId}`;
  const phaseChanged = state?.phase !== next.phase;
  const readinessChanged = next.phase === 'loading'
    && displayReadinessContext(next) !== rejectedReadyContext;
  state = next;
  if (phaseChanged) stage.scrollTop = 0;
  if (next.phase !== 'category_select' || next.categoryVotingSeat?.playerId !== pendingCategoryVoteSeat) {
    clearPendingCategoryVote();
  }
  if (`${next.question?.id}:${next.questionAttemptId}` !== previousQuestionKey) answerResults.clear();
  stageError = '';
  document.body.dataset.phase = next.phase;
  if (next.phase !== 'loading') rejectedReadyContext = '';
  else if (readinessChanged) {
    rejectedReadyContext = '';
    maybeSignalDisplayReady();
  }
  if (next.phase === 'results') stationDisplay.markEngineResultsReady();
  render();
}

function handleEvents(events: readonly TriviaEvent[]): void {
  for (const event of events) {
    if ('questionAttemptId' in event && event.questionAttemptId !== state?.questionAttemptId) continue;
    if (event.type === 'question_started') answerResults.clear();
    else if (event.type === 'answer_result') {
      answerResults.set(event.playerId, {
        correct: event.correct,
        points: event.points,
        rawScore: event.rawScore,
      });
    } else if (event.type === 'round_finished') stationDisplay.markEngineResultsReady();
  }
  render();
}

function maybeSignalDisplayReady(): void {
  if (!essentialStageReady || !isHost || state?.phase !== 'loading'
    || readySentGeneration === state.loadingGeneration
    || rejectedReadyContext === displayReadinessContext(state)) return;
  readySentGeneration = state.loadingGeneration;
  connection?.displayReady(state.loadingGeneration);
}

function displayReadinessContext(loading: TriviaState): string {
  return `${loading.loadingGeneration}:${loading.expectedPlayerCount}:${loading.hasExpectedPlayers ? 1 : 0}:`
    + loading.players.map(player => `${player.playerId}:${player.connected ? 1 : 0}`).join(',');
}

function render(): void {
  const previousResult = stage.querySelector<HTMLElement>('.results-scene[data-result-id]');
  const sameResult = state?.phase === 'results'
    && previousResult?.dataset.resultId === (state.result?.resultId ?? 'pending');
  const previousScroll = sameResult ? { stage: stage.scrollTop, result: previousResult.scrollTop } : null;
  const previousOpenDetails = sameResult
    ? [...previousResult.querySelectorAll<HTMLDetailsElement>('details')].map(details => details.open) : [];
  const activeResultElement = sameResult && document.activeElement
    && previousResult.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusId = activeResultElement?.id ?? '';
  const focusHref = activeResultElement?.tagName === 'A'
    ? activeResultElement.getAttribute('href') : null;
  const focusWasSummary = activeResultElement?.tagName === 'SUMMARY';
  const view = renderTriviaView(state, {
    locale,
    roomCode,
    serverNowMs: currentServerNow(),
    connectionState,
    answerResults,
    error: stageError,
    pairingRequired,
    canReplay: isHost && connectionState === 'connected' && !stationMode && Boolean(state?.players.length),
    isHost,
    pendingCategoryVoteSeat,
    stationMode,
    callEntry: stationMode ? undefined : { number: callNumber, qrCode: callQrCode, loading: callQrLoading },
  });
  stage.innerHTML = view.html;
  if (previousScroll) {
    stage.scrollTop = previousScroll.stage;
    const currentResult = stage.querySelector<HTMLElement>('.results-scene[data-result-id]');
    if (currentResult) {
      currentResult.scrollTop = previousScroll.result;
      currentResult.querySelectorAll<HTMLDetailsElement>('details').forEach((details, index) => {
        details.open = previousOpenDetails[index] ?? false;
      });
      const nextFocus = focusId
        ? [...currentResult.querySelectorAll<HTMLElement>('[id]')].find(node => node.id === focusId)
        : focusHref
          ? [...currentResult.querySelectorAll<HTMLAnchorElement>('a[href]')].find(node => node.getAttribute('href') === focusHref)
          : focusWasSummary ? currentResult.querySelector<HTMLElement>('summary') : null;
      nextFocus?.focus({ preventScroll: true });
    }
  }
  maybeAcknowledgeQuestionPaint();
  stage.setAttribute('aria-busy', String(!state || state.phase === 'loading'));
  if (state?.phase === 'countdown' && state.countdownEndsAtMs !== null) {
    countdownAnnouncement = `${state.loadingGeneration}:${triviaCountdownCount(state.countdownEndsAtMs, currentServerNow())}`;
  }
  if (view.announcementKey !== lastAnnouncementKey) {
    lastAnnouncementKey = view.announcementKey;
    announce(view.announcement);
  }
}

function clearPendingCategoryVote(): void {
  if (pendingCategoryVoteTimer !== null) clearTimeout(pendingCategoryVoteTimer);
  pendingCategoryVoteTimer = null;
  pendingCategoryVoteSeat = null;
}

function updateTimeDrivenUi(frameNow: number): void {
  requestAnimationFrame(updateTimeDrivenUi);
  // The visible clock is based on server deadlines; 10 Hz is more than enough
  // for its text and composited bar, without a layout write on every frame.
  if (document.hidden || frameNow - lastTimeUiFrame < 100) return;
  lastTimeUiFrame = frameNow;
  const current = state;
  const now = currentServerNow();
  if (current?.phase === 'countdown' && current.countdownEndsAtMs !== null) {
    const count = triviaCountdownCount(current.countdownEndsAtMs, now);
    countdownSound.update(current.phase, current.loadingGeneration, locale, count, () => soundEffects.playCountdown());
    const node = document.getElementById('countdown-number');
    if (node && node.textContent !== String(count)) node.textContent = String(count);
    const key = `${current.loadingGeneration}:${count}`;
    if (countdownAnnouncement !== key) {
      countdownAnnouncement = key;
      announce(String(count));
    }
  } else if ((current?.phase === 'answer_cue' || current?.phase === 'question')
    && current.answeringStartsAtMs !== null
    && current.questionEndsAtMs !== null) {
    const timing = triviaQuestionTiming(current.answeringStartsAtMs, current.questionEndsAtMs, now);
    const seconds = document.getElementById('question-seconds');
    const fill = document.getElementById('timer-fill');
    if (seconds) seconds.textContent = String(timing.remainingSeconds);
    if (fill) fill.style.transform = `scaleX(${timing.progress})`;
    fill?.parentElement?.setAttribute('aria-valuenow', String(Math.round(timing.progress * 100)));
    document.getElementById('question-timer')?.classList.toggle('urgent', timing.remainingSeconds <= 5);
    if (timing.remainingSeconds === 5 || timing.remainingSeconds === 0) {
      const key = `${current.questionAttemptId}:${current.question.id}:${timing.remainingSeconds}`;
      if (questionTimeAnnouncement !== key) {
        questionTimeAnnouncement = key;
        announce(timing.remainingSeconds === 0
          ? (locale === 'pt-BR' ? 'Tempo esgotado.' : 'Time is up.')
          : `5 ${copy.seconds}.`);
      }
    }
  }
}

function resumeTriviaAudio(): void {
  if (audioUnlocked) return;
  audioUnlocked = true;
  if (musicManager.getCurrentContext() !== 'lobby') musicManager.switchContext('lobby');
  else musicManager.resume();
}

function currentServerNow(): number {
  return serverClock.now(performance.now());
}

function announce(message: string): void {
  if (pendingAnnouncementFrame !== null) cancelAnimationFrame(pendingAnnouncementFrame);
  announcer.textContent = '';
  pendingAnnouncementFrame = requestAnimationFrame(() => {
    pendingAnnouncementFrame = null;
    announcer.textContent = message;
  });
}

function maybeAcknowledgeQuestionPaint(): void {
  const current = state;
  if (!current || (current.phase !== 'question_prompt' && current.phase !== 'answer_cue')
    || !current.question || current.questionAttemptId === null || !isHost
    || connectionState !== 'connected') return;
  const key = `${current.questionAttemptId}:${current.phase}:${current.renderRevision}`;
  if (key === lastPaintAckKey || key === pendingPaintAckKey) return;
  pendingPaintAckKey = key;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (pendingPaintAckKey !== key) return;
    pendingPaintAckKey = '';
    const latest = state;
    if (!isHost || connectionState !== 'connected'
      || latest?.questionAttemptId !== current.questionAttemptId || latest.phase !== current.phase
      || latest.renderRevision !== current.renderRevision
      || !stage.querySelector(`[data-view="${current.phase}"]`)) return;
    lastPaintAckKey = key;
    connection?.viewRendered(current.question!.id, current.questionAttemptId!, current.phase,
      current.renderRevision);
  }));
}

function localizedError(code: string): string {
  const portuguese = locale === 'pt-BR';
  const messages: Record<string, string> = {
    bad_display_auth: portuguese ? 'A autorização desta tela falhou.' : 'Display authorization failed.',
    room_capacity: portuguese ? 'Não há uma sala de quiz disponível.' : 'No Trivia room is available.',
    stale_ready: portuguese ? 'A preparação da tela expirou. Reconectando.' : 'Display preparation expired. Reconnecting.',
    forbidden: portuguese ? 'Esta tela não tem permissão para controlar a rodada.' : 'This display cannot control the round.',
  };
  return messages[code] ?? (portuguese ? 'Não foi possível atualizar o palco.' : 'The quiz stage could not be updated.');
}
