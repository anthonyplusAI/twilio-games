import QRCode from 'qrcode';
import type { KaraokeLane, KaraokeSong } from '../../shared/karaoke';
import type { KaraokeEvent, KaraokeState } from '../../shared/karaoke-protocol';
import { KARAOKE_MAX_SCORE } from '../../shared/karaoke-protocol';
import { DEFAULT_ROOM } from '../../shared/constants';
import { createStationDisplay } from '../station-display';
import { rejectDisplayToken, watchVoiceNumber } from '../station-client';
import { injectMusicToggle } from '../music-toggle';
import { injectFullscreenToggle } from '../fullscreen-toggle';
import { getMusicManager } from '../music-manager';
import { getSoundEffectsManager } from '../sound-effects';
import { commonText, injectLanguagePicker, locale } from '../i18n';
import { wireThemeToggle } from '../theme';
import { KaraokeAssetLoader, fetchKaraokeVenueConfig, karaokeAssetManifest } from './karaoke-assets';
import { KaraokeAudioTransport } from './karaoke-audio';
import {
  KARAOKE_VISUAL_OFFSET_LIMIT_MS,
  KARAOKE_VISUAL_OFFSET_STEP_MS,
  KARAOKE_VISUAL_OFFSET_STORAGE_KEY,
  KaraokeCountdownAnnouncer,
  KaraokeServerClock,
  clampKaraokeVisualOffsetMs,
  karaokeAudioPreflightRequired,
  karaokeClientAudioUrl,
  karaokeCountdownSongTimeMs,
  karaokeCountdownCount,
  karaokeGuideModeAllowed,
  karaokeDisplayMode,
  karaokeDisplayPairingRequired,
  karaokeLocalTestingAllowed,
  karaokeVisualTimeMs,
  resolveKaraokeWebSocketUrl,
} from './karaoke-client-utils';
import { karaokeCopy, karaokeSongCredit } from './karaoke-copy';
import { KaraokeConnection, type KaraokeConnectionState } from './karaoke-net';
import { KaraokeStage } from './karaoke-stage';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const flowOverlay = element('flow-overlay');
const connectionStatus = element('connection-status');
const audioRecovery = element<HTMLButtonElement>('audio-recovery');
const stageLoading = element('stage-loading');
const stageLoadingProgress = element('stage-loading-progress');
const stage = new KaraokeStage(element('arena'), element('stage-fallback'));
const audio = new KaraokeAudioTransport();
const soundEffects = getSoundEffectsManager();
const countdownAnnouncer = new KaraokeCountdownAnnouncer();
const serverClock = new KaraokeServerClock(Date.now(), performance.now());
const copy = karaokeCopy(locale);

const pageUrl = new URL(location.href);
if (pageUrl.searchParams.has('hostToken')) {
  pageUrl.searchParams.delete('hostToken');
  history.replaceState(history.state, '', `${pageUrl.pathname}${pageUrl.search}${pageUrl.hash}`);
}
const params = pageUrl.searchParams;
const roomCode = params.get('room') || DEFAULT_ROOM;
const stationDisplay = createStationDisplay();
const stationLaunchRequested = params.has('station') || params.has('match') || params.has('launchGeneration');
let displayPairingRequired = karaokeDisplayPairingRequired(
  location.hostname, stationLaunchRequested, stationDisplay.displayToken,
);
const isDisplay = karaokeDisplayMode(
  location.hostname, params.get('display') === '1', stationDisplay.active,
);
document.body.classList.toggle('event-display', isDisplay);
const guideMode = karaokeGuideModeAllowed(
  params.get('guide') === '1', locale, location.hostname, isDisplay,
);
const localTestingAllowed = karaokeLocalTestingAllowed(location.hostname, stationDisplay.active);
document.body.classList.toggle('karaoke-guide', guideMode);
document.body.dataset.karaokeGuide = guideMode ? '1' : '0';
element('guide-calibration-rail').hidden = !guideMode;
element('guide-mode-label').hidden = !guideMode;
element('guide-instructions').hidden = !guideMode;
const musicManager = getMusicManager();
let visualOffsetMs = readVisualOffset();

injectMusicToggle('music-toggle-container');
injectFullscreenToggle('karaoke-controls', {
  enter: commonText('fullscreen.enter'), exit: commonText('fullscreen.exit'),
}, 'round-control');
injectLanguagePicker('karaoke-controls');
wireThemeToggle(element('theme-toggle'), { light: copy.lightTheme, dark: copy.darkTheme });
audio.setMuted(musicManager.getIsMuted());
localizeStaticUi();
wireCalibrationControls();

let state: KaraokeState | null = null;
let catalog: readonly KaraokeSong[] = [];
let playerId: string | null = null;
let isHost = false;
let localTester = false;
let connection: KaraokeConnection | null = null;
let connectionState: KaraokeConnectionState = 'connecting';
let flowMessage = '';
let phoneNumber = copy.phoneFallback;
let phoneQr = '';
let lastFlowKey = '';
let preparationKey = '';
let preparedGeneration = 0;
let readySentGeneration = 0;
let audioProgress = 0;
let preparationError = '';
let audioSyncKey = '';
let stationResultsMarked = false;
let interactionUnlocked = false;
let sceneSettled = false;
let leaderboardKey = '';
let leaderboardLoading = false;
let leaderboardEntries: KaraokeLeaderboardEntry[] = [];

interface KaraokeLeaderboardEntry {
  name: string;
  songId: string;
  score: number;
  bestCombo: number;
  at: number;
}

if (!displayPairingRequired) connect();

const stopVoiceNumber = watchVoiceNumber(locale, number => {
  phoneNumber = number || copy.phoneFallback;
  if (!number) { phoneQr = ''; renderFlow(true); return; }
  void QRCode.toDataURL(`tel:${number}`, {
    width: 420, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000D25', light: '#FFFFFF' },
  }).then(value => { phoneQr = value; renderFlow(true); }).catch(() => { phoneQr = ''; renderFlow(true); });
});

audio.onAutoplayBlocked(blocked => { audioRecovery.hidden = !blocked; renderFlow(true); });
audio.onRunningStateChange(() => { maybeSignalReady(); renderFlow(true); });
audioRecovery.addEventListener('click', () => void enableConcertAudio());
document.addEventListener('pointerdown', () => {
  unlockInteraction();
  void recoverAudio();
}, { passive: true });
document.addEventListener('keydown', () => {
  unlockInteraction();
  void recoverAudio();
}, { passive: true });

element('music-toggle')?.addEventListener('click', () => {
  audio.setMuted(musicManager.getIsMuted());
  void recoverAudio();
});
addEventListener('storage', event => {
  if (event.key === 'twilio-games-music-muted') audio.setMuted(event.newValue === 'true');
});

if (!localTestingAllowed) void recoverAudio();

addEventListener('resize', () => stage.resize());
addEventListener('keydown', event => {
  if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey
    || interactiveTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if (key === 'p' && localTestingAllowed) {
    toggleLocalTester();
    event.preventDefault();
    return;
  }
  const lane = Number(event.key) - 1;
  if (state?.phase === 'performing' && localTester && Number.isInteger(lane) && lane >= 0 && lane < 4) {
    connection?.laneInput(lane as KaraokeLane);
    event.preventDefault();
  } else if (state?.phase === 'song_select' && localTester && Number.isInteger(lane) && lane >= 0) {
    const song = state.catalog[lane];
    if (song) connection?.selectSong(song.id);
    event.preventDefault();
  } else if (event.key === 'Enter' && localTester && isHost
    && state && ['lobby', 'song_select', 'results'].includes(state.phase)) {
    connection?.advance();
    event.preventDefault();
  }
});

element('arena').addEventListener('pointerdown', event => {
  if (!localTester || state?.phase !== 'performing') return;
  const bounds = element('arena').getBoundingClientRect();
  const lane = Math.max(0, Math.min(3, Math.floor((event.clientX - bounds.left) / bounds.width * 4)));
  connection?.laneInput(lane as KaraokeLane);
});

for (const home of document.querySelectorAll<HTMLAnchorElement>('.game-home')) {
  home.addEventListener('click', event => {
    if (stationDisplay.active) return;
    event.preventDefault();
    connection?.leaveAndClose(roomCode);
    setTimeout(() => { location.href = home.href; }, 60);
  });
}

addEventListener('pagehide', () => {
  stopVoiceNumber();
  audio.dispose();
  stage.dispose();
}, { once: true });

void initializeStage();
renderFlow();
requestAnimationFrame(renderFrame);

function connect(): void {
  try {
    connection = new KaraokeConnection(resolveKaraokeWebSocketUrl(location, params.get('ws'), isDisplay), locale);
  } catch (error) {
    connectionState = 'closed';
    flowMessage = error instanceof Error ? error.message : copy.closed;
    renderFlow(true);
    return;
  }
  connection.setDisplayAuth(roomCode, isDisplay ? stationDisplay.displayToken : null);
  connection.onConnectionState(next => {
    connectionState = next;
    connectionStatus.dataset.state = next;
    connectionStatus.textContent = copy[next];
    if (next !== 'connected') isHost = false;
    renderFlow(true);
  });
  connection.onCatalog((songs) => {
    catalog = songs;
    renderFlow(true);
  });
  connection.onClockSync(sample => { serverClock.observeSync(sample); });
  connection.onJoined(id => {
    playerId = id;
    flowMessage = '';
    renderFlow(true);
  });
  connection.onHostIdentity(host => {
    isHost = host;
    maybeSignalReady();
    renderFlow(true);
  });
  connection.onEvents(handleEvents);
  connection.onError((code, message) => {
    console.error(`[karaoke] ${code}: ${message}`);
    if (localTester && (code === 'station_voice_only' || code === 'room_full')) {
      localTester = false;
      playerId = null;
    }
    if (code === 'bad_display_auth' && !localTestingAllowed) {
      rejectDisplayToken(stationDisplay.displayToken);
      displayPairingRequired = stationLaunchRequested;
      flowMessage = '';
      if (displayPairingRequired) connection?.leaveAndClose(roomCode);
    } else flowMessage = localizedError(code);
    renderFlow(true);
  });
  connection.onState(applyState);
  connection.spectate(roomCode);
}

function toggleLocalTester(): void {
  if (!localTestingAllowed || !connection) return;
  if (localTester) {
    localTester = false;
    playerId = null;
    connection.leave(roomCode);
  } else {
    let name = locale === 'pt-BR' ? 'Cantor do teclado' : 'Keyboard Singer';
    try { name = localStorage.getItem('voice-karaoke-stage-name')?.trim() || name; } catch { /* best effort */ }
    localTester = true;
    connection.join(roomCode, name);
  }
  flowMessage = '';
  renderFlow(true);
}

async function initializeStage(): Promise<void> {
  try {
    stage.warm();
  } catch (error) {
    console.warn('Karaoke stage warm-up failed; the DOM stage remains active.', error);
  }
  try {
    const venue = await fetchKaraokeVenueConfig();
    stage.setVenueConfig(venue);
    await new KaraokeAssetLoader().loadOptional((loaded, total) => {
      stageLoadingProgress.style.width = `${loaded / total * 100}%`;
      stageLoadingProgress.parentElement?.setAttribute('aria-valuenow', String(loaded));
    }, karaokeAssetManifest(venue), undefined, asset => {
      stage.installAsset(asset);
    });
  } catch (error) {
    console.warn('Optional Karaoke scene preparation failed; procedural stage remains active.', error);
  }
  try { stage.warm(); }
  catch (error) { console.warn('Karaoke model warm-up failed; loaded roles remain active.', error); }
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  sceneSettled = true;
  stageLoading.classList.add('done');
  stageLoading.setAttribute('aria-busy', 'false');
  stationDisplay.markEngineReady();
  maybeSignalReady();
}

function applyState(next: KaraokeState): void {
  const previousPhase = state?.phase;
  state = next;
  if (guideMode) {
    (window as typeof window & { __karaokeSmokeChart?: KaraokeState['selectedSong'] })
      .__karaokeSmokeChart = next.selectedSong;
  }
  catalog = next.catalog.length ? next.catalog : catalog;
  document.body.dataset.phase = next.phase;
  stage.setSong(next.selectedSong);
  if (next.phase !== previousPhase) {
    flowMessage = '';
    updateMusicForPhase(next.phase);
  }
  if (next.phase === 'loading') void preparePerformance(next);
  else if (next.phase === 'countdown' && next.selectedSong && next.countdownEndsAtMs !== null) {
    void syncAudio(next.selectedSong, next.countdownEndsAtMs, currentServerNow());
  } else if (next.phase === 'performing' && next.selectedSong && next.performanceStartedAtMs !== null) {
    void syncAudio(next.selectedSong, next.performanceStartedAtMs, currentServerNow());
  } else if (next.phase !== 'results') {
    audioSyncKey = '';
    audio.stop();
  }
  if (next.phase === 'results' && !stationResultsMarked) {
    stationResultsMarked = true;
    stationDisplay.markEngineResultsReady();
  } else if (next.phase !== 'results') stationResultsMarked = false;
  updateLeaderboard(next);
  renderFlow(true);
}

function handleEvents(events: KaraokeEvent[]): void {
  const serverNow = currentServerNow();
  for (const event of events) {
    if (event.type === 'word_judgment') {
      stage.registerJudgment(event);
      if (serverNow - event.atMs < 1_200) showJudgment(judgmentLabel(event.judgment), event.judgment);
    } else if (event.type === 'start' && state?.selectedSong) {
      flowOverlay.replaceChildren();
      void syncAudio(state.selectedSong, event.startedAtMs, serverNow);
    } else if (event.type === 'result') {
      stationDisplay.markEngineResultsReady();
    }
  }
}

async function preparePerformance(target: KaraokeState): Promise<void> {
  const song = target.selectedSong;
  if (!song) return;
  const key = `${target.loadingGeneration}:${song.id}`;
  if (preparationKey === key) return;
  preparationKey = key;
  preparedGeneration = 0;
  readySentGeneration = 0;
  audioProgress = 0;
  preparationError = '';
  renderFlow(true);
  try {
    await audio.preload(audioSong(song), progress => {
      if (preparationKey !== key) return;
      audioProgress = progress;
      updateLoadingProgress();
    });
    if (!state || state.phase !== 'loading' || state.loadingGeneration !== target.loadingGeneration) return;
    stage.setSong(song);
    stage.warm();
    preparedGeneration = target.loadingGeneration;
    audioProgress = 1;
    updateLoadingProgress();
    await audio.recover(currentServerNow());
    maybeSignalReady();
  } catch (error) {
    if (preparationKey !== key) return;
    console.error('Karaoke backing track preparation failed.', error);
    preparationError = copy.audioError;
    renderFlow(true);
  }
}

function maybeSignalReady(): void {
  if (state?.phase === 'loading' && musicManager.getIsMuted()) {
    audioRecovery.hidden = false;
    return;
  }
  if (!sceneSettled || !state || state.phase !== 'loading' || !audio.isRunning()
    || preparedGeneration !== state.loadingGeneration) return;
  audioRecovery.hidden = true;
  if (!isHost
    || readySentGeneration === state.loadingGeneration) return;
  readySentGeneration = state.loadingGeneration;
  connection?.ready();
}

async function syncAudio(song: KaraokeSong, startedAtMs: number, serverNowMs: number): Promise<void> {
  const key = `${song.id}:${startedAtMs}`;
  if (audioSyncKey !== key) audioSyncKey = key;
  try { await audio.sync(audioSong(song), startedAtMs, serverNowMs); }
  catch (error) {
    console.error('Karaoke audio synchronization failed.', error);
    preparationError = copy.audioError;
    renderFlow(true);
  }
}

async function recoverAudio(): Promise<void> {
  audio.setMuted(musicManager.getIsMuted());
  try {
    await audio.recover(currentServerNow());
    maybeSignalReady();
  } catch (error) {
    console.error('Karaoke audio recovery failed.', error);
    preparationError = copy.audioError;
  } finally {
    renderFlow(true);
  }
}

async function enableConcertAudio(): Promise<void> {
  musicManager.unmute();
  audio.setMuted(false);
  unlockInteraction();
  await recoverAudio();
}

function concertAudioReady(): boolean {
  return audio.isRunning() && !musicManager.getIsMuted();
}

function updateMusicForPhase(phase: KaraokeState['phase']): void {
  if (interactionUnlocked && (phase === 'lobby' || phase === 'song_select' || phase === 'results')) musicManager.switchContext('lobby');
  else musicManager.stop();
}

function unlockInteraction(): void {
  if (interactionUnlocked) return;
  interactionUnlocked = true;
  if (state) updateMusicForPhase(state.phase);
}

function renderFlow(force = false): void {
  const flowKey = JSON.stringify([
    state?.phase, state?.singer, state?.selectedSong?.id, state?.selectionGeneration, state?.loadingGeneration, state?.result,
    catalog.map(song => song.id), playerId, localTester, isHost, connectionState, flowMessage, phoneNumber, phoneQr, preparationError,
    displayPairingRequired,
    concertAudioReady(),
  ]);
  if (!force && flowKey === lastFlowKey) return;
  lastFlowKey = flowKey;
  if (displayPairingRequired) {
    flowOverlay.innerHTML = `<section class="flow-panel compact loading-card">${kicker()}<h1>${escapeHtml(copy.displayAuthTitle)}</h1><p>${escapeHtml(copy.displayAuthBody)}</p><div class="flow-actions"><a class="primary-action" href="/operator">${escapeHtml(copy.displayAuthAction)}</a></div></section>`;
    return;
  }
  if (karaokeAudioPreflightRequired(
    localTestingAllowed, audio.isRunning(), musicManager.getIsMuted(), state?.phase,
  )) {
    flowOverlay.innerHTML = `<section class="flow-panel compact loading-card">${kicker()}<h1>${escapeHtml(copy.audioRecover)}</h1><p>${escapeHtml(copy.audioRecoverBody)}</p><div class="flow-actions"><button id="enable-concert-audio" class="primary-action" type="button">${escapeHtml(copy.audioRecover)}</button></div></section>`;
    element('enable-concert-audio').addEventListener('click', () => void enableConcertAudio());
    return;
  }
  if (!state) {
    flowOverlay.innerHTML = `<section class="flow-panel compact loading-card">${kicker()}<h1>${escapeHtml(copy.connecting)}</h1><p>${escapeHtml(copy.tagline)}</p></section>`;
    appendFlowError();
    return;
  }
  document.body.dataset.phase = state.phase;
  if (state.phase === 'lobby') renderLobby();
  else if (state.phase === 'song_select') renderSongSelection();
  else if (state.phase === 'loading') renderLoading();
  else if (state.phase === 'countdown') {
    const count = state.countdownEndsAtMs === null
      ? Math.max(1, state.countdown ?? 3)
      : karaokeCountdownCount(state.countdownEndsAtMs, currentServerNow());
    flowOverlay.innerHTML = `<section class="countdown-panel"><span>${escapeHtml(copy.countdown)}</span><strong id="countdown-number">${count}</strong></section>`;
  } else if (state.phase === 'performing') flowOverlay.replaceChildren();
  else if (state.phase === 'finalizing') {
    flowOverlay.innerHTML = `<section class="flow-panel compact loading-card">${kicker()}<h1>${escapeHtml(copy.finalizing)}</h1><p>${escapeHtml(copy.finalizingBody)}</p><div class="load-track finalizing-track" role="status" aria-label="${escapeHtml(copy.finalizing)}"><i></i></div></section>`;
  }
  else renderResults();
  appendFlowError();
  wireFlowControls();
}

function renderLobby(): void {
  const singer = state!.singer;
  const ownsSinger = singer?.playerId === playerId;
  let content: string;
  if (localTester && ownsSinger) {
    content = `${singerChip(singer)}<div class="flow-actions">${isHost ? `<button id="advance-flow" class="primary-action">${escapeHtml(copy.chooseSongs)}</button>` : ''}<button id="leave-mic" class="secondary-action">${escapeHtml(copy.exit)}</button></div><p class="flow-note">${escapeHtml(isHost ? copy.singerReady : copy.hostWaiting)}</p>`;
  } else {
    content = `<div class="join-layout"><div class="join-signal">${phoneQr ? `<img src="${escapeHtml(phoneQr)}" alt="${escapeHtml(copy.scan)}">` : ''}<div><strong>${escapeHtml(copy.scan)}</strong><span>${escapeHtml(phoneNumber)}</span></div></div><div><h2>${escapeHtml(copy.stationTitle)}</h2><p>${escapeHtml(copy.stationBody)}</p>${singerChip(singer)}<p class="flow-note">${escapeHtml(singer ? copy.spectator : copy.waiting)}</p></div></div>`;
  }
  flowOverlay.innerHTML = `<section class="flow-panel">${kicker()}<h1>${escapeHtml(singer ? copy.nameTitle : copy.appTitle)}</h1><p>${escapeHtml(copy.tagline)}</p><div class="flow-card">${content}</div></section>`;
}

function renderSongSelection(): void {
  const songs = state!.catalog.length ? state!.catalog : catalog;
  const canSelect = isHost && connectionState === 'connected';
  flowOverlay.innerHTML = `<section class="flow-panel selection-panel">${kicker()}<h1>${escapeHtml(copy.songTitle)}</h1><p>${escapeHtml(copy.songBody)}</p><div class="song-grid">${songs.map((song, index) => {
    const selected = state!.selectedSong?.id === song.id;
    return `<button class="song-card${selected ? ' selected' : ''}" data-song="${escapeHtml(song.id)}" ${canSelect ? '' : 'disabled'} aria-pressed="${selected}"><span class="song-number">${String(index + 1).padStart(2, '0')}</span>${selected ? `<em>${escapeHtml(copy.selected)}</em>` : ''}<strong>${escapeHtml(song.title)}</strong><small>${escapeHtml(karaokeSongCredit(song))} · 0:45</small></button>`;
  }).join('')}</div><div class="flow-actions">${isHost && state!.selectedSong && localTester && !stationDisplay.active ? `<button id="advance-flow" class="primary-action">${escapeHtml(copy.start)}</button>` : ''}</div>${state!.selectedSong && !localTester ? `<p class="flow-note">${escapeHtml(copy.scoringDisclosure)}</p><p class="flow-note">${escapeHtml(copy.phoneStart)}</p>` : ''}</section>`;
}

function renderLoading(): void {
  flowOverlay.innerHTML = `<section class="flow-panel compact loading-card">${kicker()}<h1>${escapeHtml(copy.loading)}</h1><p>${escapeHtml(copy.loadingBody)}</p><div class="load-track" role="progressbar" aria-label="${escapeHtml(copy.loading)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(audioProgress * 100)}"><i id="loading-progress" style="width:${Math.round(audioProgress * 100)}%"></i></div>${preparationError ? `<div class="loading-error" role="alert">${escapeHtml(preparationError)}</div><div class="flow-actions"><button id="retry-loading" class="primary-action">${escapeHtml(copy.retry)}</button></div>` : ''}</section>`;
}

function renderResults(): void {
  const result = state!.result;
  const song = state!.selectedSong;
  const songResult = song
    ? `<span class="result-song"><b>${escapeHtml(song.title)}</b><small>${escapeHtml(karaokeSongCredit(song))}</small></span>`
    : '';
  const boardRows = leaderboardEntries.length
    ? leaderboardEntries.map((entry, index) => `<div class="karaoke-board-row"><span>${index + 1}</span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(copy.bestCombo)} ${entry.bestCombo}x</small><b>${formatScore(entry.score)}</b></div>`).join('')
    : `<p class="karaoke-board-empty">${escapeHtml(leaderboardLoading ? copy.leaderboardLoading : copy.noRecords)}</p>`;
  flowOverlay.innerHTML = `<section class="flow-panel results-panel">${kicker()}<h1>${escapeHtml(copy.results)}</h1><p>${escapeHtml(result?.name ?? state!.singer?.name ?? copy.appTitle)}</p><div class="results-grid"><div class="flow-card result-card"><div class="result-score">${formatScore(result?.score ?? state!.score)}</div><div class="result-meta"><span>${escapeHtml(copy.bestCombo)} <b>${result?.bestCombo ?? state!.bestCombo}x</b></span>${songResult}</div><div class="flow-actions">${isHost && !stationDisplay.active ? `<button id="advance-flow" class="primary-action">${escapeHtml(copy.again)}</button>` : ''}<a class="secondary-action" href="/">${escapeHtml(copy.exit)}</a></div></div><section class="flow-card karaoke-board" aria-label="${escapeHtml(copy.leaderboard)}"><h2>${escapeHtml(copy.leaderboard)}</h2>${song ? `<p>${escapeHtml(song.title)}</p>` : ''}<div class="karaoke-board-list">${boardRows}</div></section></div></section>`;
}

function updateLeaderboard(next: KaraokeState): void {
  if (next.phase !== 'results' || !next.result || !next.selectedSong) {
    leaderboardKey = '';
    leaderboardLoading = false;
    leaderboardEntries = [];
    return;
  }
  const key = `${next.roomCode}:${next.result.generation}:${next.result.completedAtMs}:${next.result.name}:${next.selectedSong.id}`;
  if (key === leaderboardKey) return;
  leaderboardKey = key;
  leaderboardLoading = true;
  leaderboardEntries = [];
  void fetch(`/api/karaoke/leaderboard?song=${encodeURIComponent(next.selectedSong.id)}&limit=10`, { cache: 'no-store' })
    .then(async response => response.ok ? await response.json() as { entries?: KaraokeLeaderboardEntry[] } : { entries: [] })
    .then(payload => {
      if (leaderboardKey !== key) return;
      leaderboardEntries = Array.isArray(payload.entries) ? payload.entries : [];
      leaderboardLoading = false;
      renderFlow(true);
    })
    .catch(() => {
      if (leaderboardKey !== key) return;
      leaderboardEntries = [];
      leaderboardLoading = false;
      renderFlow(true);
    });
}

function wireFlowControls(): void {
  for (const button of flowOverlay.querySelectorAll<HTMLButtonElement>('[data-song]')) {
    button.addEventListener('click', () => {
      const songId = button.dataset.song;
      if (!songId) return;
      connection?.selectSong(songId);
    });
  }
  element('advance-flow')?.addEventListener('click', () => {
    connection?.advance();
  });
  element('leave-mic')?.addEventListener('click', () => {
    localTester = false;
    playerId = null;
    connection?.leave(roomCode);
    renderFlow(true);
  });
  element('retry-loading')?.addEventListener('click', () => {
    preparationError = '';
    preparationKey = '';
    connection?.retryLoading();
  });
}

function renderFrame(): void {
  requestAnimationFrame(renderFrame);
  const serverNow = currentServerNow();
  const current = state;
  const song = current?.selectedSong ?? null;
  const audioTimeline = audio.timeline(serverNow);
  let rawTimeMs = 0;
  let presentationTimeMs = 0;
  if (current?.phase === 'countdown' && song && current.countdownEndsAtMs !== null) {
    rawTimeMs = karaokeCountdownSongTimeMs(current.countdownEndsAtMs, serverNow);
    presentationTimeMs = rawTimeMs - audioTimeline.estimatedOutputLatencyMs;
  } else if (current?.phase === 'performing' && song && current.performanceStartedAtMs !== null) {
    rawTimeMs = audioTimeline.rawTimeMs;
    presentationTimeMs = audioTimeline.presentationTimeMs;
  } else if (current?.phase === 'results' && song) {
    rawTimeMs = song.durationMs;
    presentationTimeMs = song.durationMs;
  }
  const visualDelayMs = guideMode && (current?.phase === 'countdown' || current?.phase === 'performing')
    ? visualOffsetMs
    : 0;
  const songTimeMs = karaokeVisualTimeMs(presentationTimeMs, visualDelayMs);
  const arena = element('arena');
  arena.dataset.karaokeSongTimeMs = String(Math.round(songTimeMs));
  arena.dataset.karaokeRawSongTimeMs = String(Math.round(rawTimeMs));
  arena.dataset.karaokePresentationSongTimeMs = String(Math.round(presentationTimeMs));
  arena.dataset.karaokeOutputLatencyMs = String(Math.round(audioTimeline.estimatedOutputLatencyMs));
  arena.dataset.karaokeLatencySource = audioTimeline.latencySource;
  stage.update({
    song, phase: current?.phase ?? 'lobby', songTimeMs, serverNowMs: serverNow,
    score: current?.score ?? 0, combo: current?.combo ?? 0,
  });
  updateCountdown(serverNow);
  updateHud(presentationTimeMs);
  updateCalibrationReadout(audioTimeline.estimatedOutputLatencyMs, audioTimeline.latencySource);
}

function updateCountdown(serverNow: number): void {
  if (state?.phase !== 'countdown' || state.countdownEndsAtMs === null) return;
  const count = karaokeCountdownCount(state.countdownEndsAtMs, serverNow);
  const node = element('countdown-number');
  if (node && node.textContent !== String(count)) node.textContent = String(count);
  countdownAnnouncer.update('countdown', state.loadingGeneration, locale, count, () => soundEffects.playCountdown());
}

function updateHud(songTimeMs: number): void {
  const song = state?.selectedSong;
  if (!song) return;
  element('hud-singer').textContent = state?.singer?.name ?? copy.waiting;
  element('hud-song').textContent = song.title;
  element('hud-score').textContent = formatScore(state?.score ?? 0);
  element('hud-combo').textContent = String(state?.combo ?? 0);
  const progress = Math.min(1, Math.max(0, songTimeMs / song.durationMs));
  element('song-progress-fill').style.width = `${progress * 100}%`;
  const remaining = Math.max(0, Math.ceil((song.durationMs - songTimeMs) / 1000));
  element('song-time').textContent = `0:${String(remaining).padStart(2, '0')}`;
}

function updateLoadingProgress(): void {
  const fill = element('loading-progress');
  if (fill) fill.style.width = `${Math.round(audioProgress * 100)}%`;
  fill?.parentElement?.setAttribute('aria-valuenow', String(Math.round(audioProgress * 100)));
}

function currentServerNow(): number {
  return serverClock.now(performance.now());
}

function showJudgment(
  label: string,
  judgment: 'perfect' | 'great' | 'good' | 'early' | 'late' | 'miss' | 'wrong_lane',
  detail = '',
): void {
  const burst = document.createElement('div');
  burst.className = `judgment-burst ${judgment.replace('_', '-')}`;
  const title = document.createElement('strong');
  title.textContent = label;
  burst.append(title);
  if (detail) {
    const points = document.createElement('small');
    points.textContent = detail;
    burst.append(points);
  }
  element('judgment-layer').replaceChildren(burst);
  setTimeout(() => burst.remove(), 820);
}

function singerChip(singer: KaraokeState['singer']): string {
  return singer
    ? `<div class="singer-chip"><div><span>${escapeHtml(copy.singerReady)}</span><strong>${escapeHtml(singer.name)}</strong></div><i aria-hidden="true"></i></div>`
    : `<div class="singer-chip"><div><span>${escapeHtml(copy.waiting)}</span><strong>${escapeHtml(copy.appTitle)}</strong></div><i aria-hidden="true"></i></div>`;
}

function kicker(): string {
  return `<div class="flow-kicker"><img src="/brand/Twilio_Logo_Bug_White.svg" alt=""><span>${escapeHtml(copy.appKicker)}</span>${guideMode ? `<b class="guide-mode-label">${escapeHtml(copy.guideMode)}</b>` : ''}</div>`;
}

function appendFlowError(): void {
  if (!flowMessage) return;
  flowOverlay.insertAdjacentHTML('beforeend', `<div class="loading-error" role="alert">${escapeHtml(flowMessage)}</div>`);
}

function localizeStaticUi(): void {
  document.title = copy.appTitle;
  document.documentElement.lang = locale;
  const home = document.querySelector('.game-home span');
  if (home) home.textContent = copy.home;
  element('keyboard-guide').textContent = copy.keyboardGuide;
  element('stage-loading-label').textContent = locale === 'pt-BR' ? 'Preparando o palco' : 'Preparing the stage';
  element('guide-mode-label').textContent = copy.guideMode;
  element('guide-instructions').textContent = copy.guideInstructions;
  element('output-latency-label').textContent = copy.outputLatency;
  element('visual-offset-label').textContent = copy.visualOffset;
  element('visual-offset-help').textContent = copy.visualOffsetHelp;
  element('lyrics-earlier').textContent = copy.lyricsEarlier;
  element('lyrics-later').textContent = copy.lyricsLater;
  element('reset-lyrics-offset').textContent = copy.resetOffset;
  element('current-lyric-label').textContent = locale === 'pt-BR' ? 'Letra atual:' : 'Current lyric:';
  element('upcoming-lyric-label').textContent = locale === 'pt-BR' ? 'Próxima letra:' : 'Upcoming lyric:';
  audioRecovery.querySelector('span')!.textContent = copy.audioRecover;
  audioRecovery.querySelector('small')!.textContent = copy.audioRecoverBody;
  connectionStatus.textContent = copy.connecting;
  const hudLabels = document.querySelectorAll('.hud-score span,.hud-combo span');
  if (hudLabels[0]) hudLabels[0].textContent = copy.score;
  if (hudLabels[1]) hudLabels[1].textContent = copy.combo;
}

function localizedError(code: string): string {
  const errors: Record<string, string> = {
    bad_display_auth: locale === 'pt-BR' ? 'Autorização da tela inválida.' : 'Display authorization failed.',
    room_full: locale === 'pt-BR' ? 'O microfone já está em uso.' : 'The microphone is already taken.',
    station_voice_only: locale === 'pt-BR' ? 'Entre pelo telefone nesta estação.' : 'Join by phone at this station.',
    select_rejected: locale === 'pt-BR' ? 'Essa música não está disponível.' : 'That song is unavailable.',
    forbidden: copy.hostWaiting,
    stale_ready: copy.retry,
  };
  return errors[code] ?? (locale === 'pt-BR' ? 'Não foi possível concluir essa ação.' : 'That action could not be completed.');
}

function judgmentLabel(judgment: 'perfect' | 'good' | 'miss'): string {
  if (locale === 'pt-BR') return judgment === 'perfect' ? 'Perfeito' : judgment === 'good' ? 'Bom' : 'Perdeu';
  return judgment === 'perfect' ? 'Perfect' : judgment === 'good' ? 'Good' : 'Miss';
}

function formatScore(score: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.max(0, Math.min(KARAOKE_MAX_SCORE, score)));
}

function interactiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input,select,textarea,button,a,[contenteditable="true"]'));
}

function audioSong(song: KaraokeSong): KaraokeSong {
  const audioUrl = karaokeClientAudioUrl(song, guideMode);
  return audioUrl === song.audioUrl ? song : { ...song, audioUrl };
}

function readVisualOffset(): number {
  try { return clampKaraokeVisualOffsetMs(Number(localStorage.getItem(KARAOKE_VISUAL_OFFSET_STORAGE_KEY) ?? 0)); }
  catch { return 0; }
}

function wireCalibrationControls(): void {
  element<HTMLButtonElement>('lyrics-earlier').addEventListener('click', () => {
    setVisualOffset(visualOffsetMs - KARAOKE_VISUAL_OFFSET_STEP_MS);
  });
  element<HTMLButtonElement>('lyrics-later').addEventListener('click', () => {
    setVisualOffset(visualOffsetMs + KARAOKE_VISUAL_OFFSET_STEP_MS);
  });
  element<HTMLButtonElement>('reset-lyrics-offset').addEventListener('click', () => setVisualOffset(0));
  updateCalibrationReadout(0, 'none');
}

function setVisualOffset(value: number): void {
  visualOffsetMs = clampKaraokeVisualOffsetMs(value);
  try { localStorage.setItem(KARAOKE_VISUAL_OFFSET_STORAGE_KEY, String(visualOffsetMs)); } catch { /* best effort */ }
  updateCalibrationReadout(audio.estimatedOutputLatencyMs(), element('arena').dataset.karaokeLatencySource ?? 'none');
}

function updateCalibrationReadout(latencyMs: number, latencySource: string): void {
  const signedOffset = `${visualOffsetMs > 0 ? '+' : ''}${visualOffsetMs} ms`;
  const latency = element<HTMLOutputElement>('output-latency');
  latency.textContent = `${Math.max(0, Math.round(latencyMs))} ms`;
  latency.dataset.source = latencySource;
  element<HTMLOutputElement>('visual-offset').textContent = signedOffset;
  element<HTMLButtonElement>('lyrics-earlier').disabled = visualOffsetMs <= -KARAOKE_VISUAL_OFFSET_LIMIT_MS;
  element<HTMLButtonElement>('lyrics-later').disabled = visualOffsetMs >= KARAOKE_VISUAL_OFFSET_LIMIT_MS;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
