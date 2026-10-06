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
  const replay = (event.target as Element | null)?.closest?.('#trivia-replay');
  if (!replay || !isHost || stationDisplay.active || stationLaunchRequested) return;
  connection?.advance();
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
    if (next !== 'connected') isHost = false;
    render();
  });
  connection.onClockSync(sample => serverClock.observeSync(sample));
  connection.onJoined(id => {
    playerId = id;
    localTester = true;
    localTesterPending = false;
  });
  connection.onHostIdentity(host => {
    isHost = host;
    maybeSignalDisplayReady();
  });
  connection.onEvents(handleEvents);
  connection.onError((code, message) => {
    console.error(`[trivia] ${code}: ${message}`);
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
  const previousQuestionId = state?.question?.id;
  const readinessChanged = next.phase === 'loading'
    && displayReadinessContext(next) !== rejectedReadyContext;
  state = next;
  if (next.question?.id !== previousQuestionId) answerResults.clear();
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
  const view = renderTriviaView(state, {
    locale,
    roomCode,
    serverNowMs: currentServerNow(),
    connectionState,
    answerResults,
    error: stageError,
    pairingRequired,
    canReplay: isHost && !stationDisplay.active && !stationLaunchRequested,
    stationMode,
    callEntry: stationMode ? undefined : { number: callNumber, qrCode: callQrCode, loading: callQrLoading },
  });
  stage.innerHTML = view.html;
  stage.setAttribute('aria-busy', String(!state || state.phase === 'loading'));
  if (state?.phase === 'countdown' && state.countdownEndsAtMs !== null) {
    countdownAnnouncement = `${state.loadingGeneration}:${triviaCountdownCount(state.countdownEndsAtMs, currentServerNow())}`;
  }
  if (view.announcementKey !== lastAnnouncementKey) {
    lastAnnouncementKey = view.announcementKey;
    announce(view.announcement);
  }
}

function updateTimeDrivenUi(): void {
  requestAnimationFrame(updateTimeDrivenUi);
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
  } else if (current?.phase === 'question' && current.answeringStartsAtMs !== null
    && current.questionEndsAtMs !== null) {
    const timing = triviaQuestionTiming(current.answeringStartsAtMs, current.questionEndsAtMs, now);
    const seconds = document.getElementById('question-seconds');
    const fill = document.getElementById('timer-fill');
    if (seconds) seconds.textContent = String(timing.remainingSeconds);
    if (fill) fill.style.width = `${timing.progress * 100}%`;
    fill?.parentElement?.setAttribute('aria-valuenow', String(Math.round(timing.progress * 100)));
    if (timing.remainingSeconds === 5 || timing.remainingSeconds === 0) {
      const key = `${current.question.id}:${timing.remainingSeconds}`;
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
  announcer.textContent = '';
  requestAnimationFrame(() => { announcer.textContent = message; });
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
