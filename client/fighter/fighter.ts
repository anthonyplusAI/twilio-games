import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { FighterActor } from './fighter-actor';
import { FighterActorLoadCoordinator, FighterWarmupRetryBudget, fighterActorLoadContext, fighterShouldRetainActor, fighterWarmupCandidates, type FighterActorLoadContext } from './fighter-actor-loading';
import { FIGHTERS, FIGHTER_ASSET_VERSION, fighterAssetFirstAttemptMs, loadAnimationSources, preferProceduralFighterAssets } from './fighter-assets';
import { FighterAtmosphere, fighterAtmosphereSpec, type FighterAtmosphereSpec } from './fighter-atmosphere';
import { FighterConnection, type FighterConnectionState } from './fighter-net';
import { fighterResultActionState, fighterSharedSeatStatus, isInteractiveShortcutTarget, resolveNumericSelection } from './fighter-client-utils';
import { frameStaticPortraitArena, proceduralFallbackCamera, responsiveVerticalFov, shouldUseLivePortraitArena } from './fighter-camera';
import { getSoundEffectsManager } from '../sound-effects';
import { getMusicManager } from '../music-manager';
import { injectMusicToggle } from '../music-toggle';
import { injectFullscreenToggle } from '../fullscreen-toggle';
import { commonText, locale } from '../i18n';
import { isCountdownSoundCue } from '../../shared/countdown';
import { DEFAULT_ROOM } from '../../shared/constants';
import { FIGHTER_RUN_BACKWARD_DURATION, FIGHTER_RUN_FORWARD_DURATION,
  FIGHTER_ACTION_PLAYBACK_SPEED, FIGHTER_JUMP_TWEEN_SECONDS,
  FIGHTER_REACTION_PLAYBACK_SPEED,
  type FighterCommand, type FighterEvent, type FighterId, type FighterWorld } from '../../shared/fighter-world';
import type { FighterMapEntry, FighterRosterEntry } from '../../shared/fighter-roster';
import { fighterIntroStage, type FighterLobbyPlayer, type FighterState } from '../../shared/fighter-protocol';
import { FIGHTER_MESSAGES, type FighterMessageKey } from '../../shared/i18n/fighter';
import { createTranslator } from '../../shared/i18n/translate';
import { fighterName as translatedFighterName } from '../../shared/i18n/content';
import { createStationDisplay } from '../station-display';
import { resultTechHtml } from '../result-tech';
import { watchVoiceNumber } from '../station-client';
import QRCode from 'qrcode';

const t = createTranslator(locale, FIGHTER_MESSAGES);
const COMMAND_MESSAGE_KEYS: Record<FighterCommand, FighterMessageKey> = {
  back: 'command.back', forward: 'command.forward', jump: 'command.jump',
  punch: 'command.punch', kick: 'command.kick', block: 'command.block',
};
const FIGHTER_TITLE_KEYS: Record<string, FighterMessageKey> = {
  nyx: 'content.fighter.nyx', wraith: 'content.fighter.wraith', 'remy-riot': 'content.fighter.remy-riot',
  'cinder-capone': 'content.fighter.cinder-capone', 'rune-warden': 'content.fighter.rune-warden',
  'shroom-boom': 'content.fighter.shroom-boom', 'gran-slam': 'content.fighter.gran-slam',
  'bass-nova': 'content.fighter.bass-nova', 'velvet-thunder': 'content.fighter.velvet-thunder',
  'iron-oni': 'content.fighter.iron-oni', bulkhead: 'content.fighter.bulkhead', 'sir-knockout': 'content.fighter.sir-knockout',
};
const MAP_BLURB_KEYS: Record<string, FighterMessageKey> = {
  foundry: 'content.map.foundry', void: 'content.map.void', 'cyberpunk-city': 'content.map.cyberpunk-city',
  inakaya: 'content.map.inakaya', rain: 'content.map.rain',
};
const MAP_NAME_KEYS: Record<string, FighterMessageKey> = {
  foundry: 'content.mapName.foundry', void: 'content.mapName.void', 'cyberpunk-city': 'content.mapName.cyberpunk-city',
  inakaya: 'content.mapName.inakaya', rain: 'content.mapName.rain',
};
const SERVER_ERROR_KEYS: Record<string, FighterMessageKey> = {
  already_joined: 'error.alreadyJoined', bad_display_auth: 'error.invalidDisplay', select_rejected: 'error.selectionRejected',
  not_ready: 'error.notReady', stale_ready: 'error.staleReady', forbidden: 'error.displayControl', room_full: 'error.roomFull',
  bad_json: 'error.invalidResponse',
};
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const arena = $('arena'), overlay = $('overlay'), loading = $('loading');
const loadingLabel = $('loading-label'), loadingFill = $('loading-fill'), loadingPercent = $('loading-percent');
const voiceCommand = $('voice-command'), voiceFeed = document.querySelector('.voice-feed')!;
const p1Health = $('p1-health'), p2Health = $('p2-health');
const p1Meter = p1Health.parentElement!, p2Meter = p2Health.parentElement!;
const result = $('result'), resultTitle = $('result-title'), rematch = $('rematch');
const resultChampion = $('result-champion'), resultExit = $<HTMLAnchorElement>('result-exit');
const resultStationNext = $('result-station-next'), resultActionStatus = $('result-action-status'), resultTechSlot = $('result-tech-slot');
const fightCall = $('fight-call'), errorBox = $('error');
const connectionStatus = $('connection-status');
const p1FighterName = $('p1-fighter-name'), p2FighterName = $('p2-fighter-name');
const p1PlayerName = $('p1-player-name'), p2PlayerName = $('p2-player-name');
const commandButtons = [...document.querySelectorAll<HTMLElement>('[data-command]')];
injectMusicToggle('music-toggle-container');
injectFullscreenToggle('music-toggle-container', {
  enter: commonText('fullscreen.enter'), exit: commonText('fullscreen.exit'),
});
const stationDisplay = createStationDisplay();
resultTechSlot.innerHTML = resultTechHtml('fighter', locale, { stationManaged: stationDisplay.active });

const pageUrl = new URL(location.href);
if (pageUrl.searchParams.has('hostToken')) {
  pageUrl.searchParams.delete('hostToken');
  history.replaceState(history.state, '', `${pageUrl.pathname}${pageUrl.search}${pageUrl.hash}`);
}
const params = pageUrl.searchParams;
const isDisplay = params.get('display') === '1';
document.body.classList.toggle('event-display', isDisplay);
const roomCode = params.get('room') || DEFAULT_ROOM;
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const connection = new FighterConnection(`${wsProtocol}//${location.host}/fighter${isDisplay?'?display=1':''}`, locale);
connection.setDisplayAuth(roomCode, isDisplay ? stationDisplay.displayToken : null);
let keyboardPlayerConn: FighterConnection | null = null;

const arenaSize = () => ({ width: Math.max(1, arena.clientWidth || innerWidth), height: Math.max(1, arena.clientHeight || innerHeight) });
const initialArenaSize = arenaSize();
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setSize(initialArenaSize.width, initialArenaSize.height);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12;
arena.appendChild(renderer.domElement);
renderer.domElement.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  console.error('Fighter WebGL context was lost; reloading the display.');
  setTimeout(() => location.reload(), 0);
}, { once: true });
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x05060a); scene.fog = new THREE.FogExp2(0x08090e, 0.06);
const camera = new THREE.PerspectiveCamera(36, initialArenaSize.width / initialArenaSize.height, 0.05, 5000);
camera.position.set(0, 2.15, 10.5); camera.lookAt(0, 1.05, 0);
const theme = buildArena();

let loadedActors = new Map<string, FighterActor>();
let actors: Record<FighterId, FighterActor> | null = null;
let actorKey = '';
let state: FighterState | null = null;
let playerId: string | null = null;
let touchTargetPlayerId: string | null = null;
let roster: FighterRosterEntry[] = [];
let maps: FighterMapEntry[] = [];
let phoneNumber = t('phone.fallback');
const FIGHTER_ACTOR_TIMEOUT_MS = 30_000;
// The selected authored assets get a real first attempt before the display tells the
// server it is ready. The procedural stage remains visible while those bytes arrive.
const FIGHTER_ACTOR_FALLBACK_MS = fighterAssetFirstAttemptMs(browserConnection());
const FIGHTER_MAP_TIMEOUT_MS = fighterAssetFirstAttemptMs(browserConnection());
let phoneQr = '/brand/join-qr.png?v=2';
let movement: Partial<Record<FighterId, { from: number; to: number; elapsed: number; jump: boolean; duration: number }>> = {};
const actionDurations: Record<FighterId, number> = { p1: FIGHTER_RUN_FORWARD_DURATION, p2: FIGHTER_RUN_FORWARD_DURATION };
let lastTime = performance.now();
let lastOverlayKey = '';
let lastPhase = '';
let loadedMapId = '';
let mapReadyId = '';
let failedMapKey = '';
let readySentFor = '';
let readyTimer: ReturnType<typeof setTimeout> | null = null;
const actorLoadCoordinator = new FighterActorLoadCoordinator(FIGHTER_ACTOR_FALLBACK_MS);
let mapModel: THREE.Object3D | null = null;
let mapBackdrop: THREE.WebGLRenderTarget | null = null;
let mapAtmosphere: FighterAtmosphere | null = null;
let mapLoadAttempt = 0;
let mapLoadController: AbortController | null = null;
let customMapStatic = false;
let usingProceduralFallback = false;
let mapPlane = { origin: [0, 0, 0] as [number, number, number], rotationY: 0 };
let mapBoundsCenter = 0;
const displayX: Record<FighterId, number> = { p1: -2.5, p2: 2.5 };
const displayHeight: Record<FighterId, number> = { p1: 0, p2: 0 };
let cameraBase = { pos: [0, 2.15, 10.5] as [number, number, number], lookAt: [0, 1.25, 0] as [number, number, number], fov: 36 };
const cameraAxis = new THREE.Vector3(), cameraTarget = new THREE.Vector3(), cameraView = new THREE.Vector3(), cameraDesired = new THREE.Vector3();
let flowMessage = '';
let animationSources: Awaited<ReturnType<typeof loadAnimationSources>> | null = null;
let animationLoadController: AbortController | null = null;
let animationLoadPromise: Promise<Awaited<ReturnType<typeof loadAnimationSources>>> | null = null;
const actorLoads = new Map<string, Promise<FighterActor>>();
const actorLoadControllers = new Map<string, AbortController>();
const actorWarmupRetries = new FighterWarmupRetryBudget();
const actorWarmupRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const fallbackActorIds = new Set<string>();
const deferredRealActors = new Map<string, FighterActor>();
let preparedFightKey = '';
let fightStartedKey = '';
let bufferedEvents: FighterEvent[] = [];
let initializationAttempt = 0;
let initializationFailed = false;
let numericBuffer = '';
let numericTimer: ReturnType<typeof setTimeout> | null = null;
let focusBeforeError: HTMLElement | null = null;
let isHost = false;
let fighterConnectionState: FighterConnectionState = 'connecting';
let resultRevealAt = 0;
let resultTimer: ReturnType<typeof setTimeout> | null = null;
let forcedResultGeneration: number | null = null;
let introSegment = '';
let countdownSoundPlayed = false;
let assetRetryGeneration: number | null = null;
let assetRetryTimer: ReturnType<typeof setTimeout> | null = null;
let presentationEpoch=0;
let pendingFightReceipt='';
let sentFightReceipt='';
let pendingResultReceipt='';
let sentResultReceipt='';

// Static labels include result-button state, which reads the initialized host/connection fields.
localizeStaticUi();

connection.onRoster((fighters, mapEntries) => { roster = fighters; maps = mapEntries; renderFlow(); });
connection.onJoined(id => { if (!keyboardPlayerConn) { playerId = id; renderFlow(); } });
connection.onEvents(handleEvents);
connection.onShowResults(generation => {
  if (state && generation < state.loadingGeneration) return;
  forcedResultGeneration = generation;
  resultRevealAt = 0;
  if (resultTimer) { clearTimeout(resultTimer); resultTimer = null; }
  if (state?.phase === 'results' && state.loadingGeneration === generation && state.result) showResult(state.result.winner);
});
connection.onError((code, message) => { console.error(`[fighter] ${code}: ${message}`); flowMessage = localizedServerError(code) ?? t('error.invalidResponse'); lastOverlayKey = ''; renderFlow(); });
connection.onHostIdentity(host => {
  if(isHost!==host){presentationEpoch++;pendingFightReceipt='';pendingResultReceipt='';
    if(host){sentFightReceipt='';sentResultReceipt='';}}
  isHost = host; lastOverlayKey = ''; renderFlow();
  syncResultActions();
  scheduleFightReceipt();
  scheduleResultReceipt();
});
connection.onConnectionState(status => {
  fighterConnectionState = status;
  connectionStatus.dataset.state = status;
  connectionStatus.textContent = commonText(status === 'closed' ? 'connection.closed' : `connection.${status}`);
  if (status !== 'connected') {
    isHost = false;
    presentationEpoch++;pendingFightReceipt='';pendingResultReceipt='';
    sentFightReceipt='';sentResultReceipt='';
    readySentFor = '';
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  }
  syncResultActions();
});
connection.onState(next => {
  if (forcedResultGeneration !== null && next.loadingGeneration > forcedResultGeneration) forcedResultGeneration = null;
  if (next.phase === 'results' && next.loadingGeneration === forcedResultGeneration) {
    resultRevealAt = 0;
    if (resultTimer) { clearTimeout(resultTimer); resultTimer = null; }
  }
  if (assetRetryGeneration !== null && next.loadingGeneration > assetRetryGeneration) {
    if (assetRetryTimer) clearTimeout(assetRetryTimer);
    location.reload(); return;
  }
  const previousPhase = state?.phase;
  const phaseChanged = next.phase !== previousPhase;
  const choiceChanged = next.selectedMap !== state?.selectedMap
    || next.players.map(player => player.fighterId ?? '').join('|') !== state?.players.map(player => player.fighterId ?? '').join('|');
  const selectionChanged = choiceChanged
    || next.aiFighterId !== state?.aiFighterId
    || next.players.map(player => `${player.playerId}:${player.fighterId ?? ''}`).join('|') !== state?.players.map(player => `${player.playerId}:${player.fighterId ?? ''}`).join('|');
  if (state && choiceChanged && (next.phase === 'fighter_select' || next.phase === 'map_select')) getSoundEffectsManager().playSelect();
  if (phaseChanged || selectionChanged) {
    flowMessage = ''; numericBuffer = ''; if (numericTimer) { clearTimeout(numericTimer); numericTimer = null; }
  }
  updateTouchTarget(next,state);
  if (phaseChanged) {
    if (next.phase === 'loading') { preparedFightKey = ''; fightStartedKey = ''; bufferedEvents = []; }
    if (next.phase === 'lobby' || next.phase === 'fighter_select') resetFallbackActors();
    if (next.phase === 'lobby' || next.phase === 'fighter_select') {
      actorWarmupRetries.clear();
      clearActorWarmupRetryTimers();
    }
    if (next.phase === 'loading' || next.phase === 'intro') countdownSoundPlayed = false;
    if (next.phase !== 'results' && resultTimer) { clearTimeout(resultTimer); resultTimer = null; resultRevealAt = 0; }
    if (['lobby', 'fighter_select', 'map_select', 'loading'].includes(next.phase)) getMusicManager().switchContext('lobby');
  }
  state = next;
  if (phaseChanged || selectionChanged) retainActorWarmupRetries(new Set(fighterWarmupCandidates(next)));
  if ((selectionChanged || phaseChanged) && (next.phase === 'fighter_select' || next.phase === 'map_select'))
    cancelActorLoads(new Set(fighterWarmupCandidates(next)));
  if (phaseChanged && next.phase === 'lobby') cancelActorLoads();
  if (phaseChanged && next.phase === 'fight') cancelOptionalFightDownloads();
  if (!fighterActorLoadContext(next)) actorLoadCoordinator.clear();
  if (next.phase === 'countdown') {
    const count = Math.ceil(next.countdown ?? 0);
    if (locale === 'en-US' && isCountdownSoundCue(count) && !countdownSoundPlayed) { countdownSoundPlayed = true; getSoundEffectsManager().playCountdown(); }
  }
  if (phaseChanged && next.phase === 'map_select') { readySentFor = ''; if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; } }
  document.body.dataset.phase = next.phase;
  if (next.world) {
    p1Health.style.width = `${next.world.p1.health}%`; p2Health.style.width = `${next.world.p2.health}%`;
    p1Meter.setAttribute('aria-valuenow', String(next.world.p1.health)); p2Meter.setAttribute('aria-valuenow', String(next.world.p2.health));
    syncAuthoritativePositions(next.world);
  }
  updateNames(next);
  for (const id of fighterWarmupCandidates(next)) preloadFighterActor(id);
  // Start the selected arena while callers are still deciding whether to begin.
  if (next.selectedMap && ['map_select', 'loading', 'intro', 'countdown', 'fight', 'victory', 'results'].includes(next.phase)) applyMapTheme(next.selectedMap);
  if (fighterActorLoadContext(next) && (phaseChanged || selectionChanged || !actors)) prepareFight(next);
  if (phaseChanged && next.phase === 'intro') beginIntro(next);
  if (previousPhase === 'intro' && next.phase === 'countdown') endIntro(next);
  if (next.phase === 'loading') maybeSignalReady();
  if (phaseChanged && next.phase === 'fight') beginFight(next);
  if (next.phase === 'results' && next.result) showResult(next.result.winner);
  else if (next.phase !== 'results') { result.hidden = true; setFightControlsEnabled(next.phase === 'fight'); }
  renderFlow();
  scheduleFightReceipt();
});
connection.spectate(roomCode);
if (!stationDisplay.active && (params.get('players') === '1' || params.get('players') === '2'))
  connection.setStandaloneSeats(roomCode, params.get('players') === '2' ? 2 : 1);
let phoneQrGeneration = 0;
const stopVoiceNumberUpdates = watchVoiceNumber(locale, async number => {
  const generation = ++phoneQrGeneration;
  phoneNumber = number || t('phone.fallback');
  if (!number) { phoneQr = '/brand/join-qr.png?v=2'; renderFlow(); return; }
  try {
    const qr = await QRCode.toDataURL(`tel:${number}`, {
      width: 520, margin: 1, color: { dark: '#000D25', light: '#FFFFFF' }, errorCorrectionLevel: 'M',
    });
    if (generation !== phoneQrGeneration) return;
    phoneQr = qr;
  } catch {
    if (generation !== phoneQrGeneration) return;
    phoneQr = '/brand/join-qr.png?v=2';
  }
  renderFlow();
});
addEventListener('pagehide', () => {
  stopVoiceNumberUpdates(); actorLoadCoordinator.clear();
  clearActorWarmupRetryTimers();
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  releaseKeyboardPlayer();
}, { once: true });

function setLoading(progress: number, label: string): void {
  const value = Math.round(progress * 100); loadingLabel.textContent = label;
  loadingFill.style.width = `${value}%`; loadingPercent.textContent = `${value}%`;
  loadingFill.parentElement?.setAttribute('aria-valuenow', String(value));
}

async function initialize(): Promise<void> {
  const attempt = ++initializationAttempt;
  animationLoadController?.abort();
  animationLoadController = null;
  animationLoadPromise = null;
  initializationFailed = false;
  // Render the lobby immediately. Match readiness waits for selected authored assets
  // for a bounded period, while the procedural actors/stage cover true failures.
  animationSources = new Map();
  loading.classList.remove('done'); loading.setAttribute('aria-busy', 'true'); hideAssetError();
  setLoading(.05, t('loading.openingLobby'));
  setTimeout(() => {
    if (attempt !== initializationAttempt) return;
    loading.classList.add('done'); loading.setAttribute('aria-busy', 'false'); renderFlow();
    scheduleFightReceipt();scheduleResultReceipt();
  }, 250);
  setLoading(1, t('loading.ready'));
  if (!preferProceduralFighterAssets(browserConnection()) && state?.phase !== 'fight') {
    const controller = new AbortController();
    animationLoadController = controller;
    animationLoadPromise = loadAnimationSources(undefined, controller.signal).then(realSources => {
      if (controller.signal.aborted || attempt !== initializationAttempt) return new Map();
      animationSources = realSources;
      // Character choices may already have arrived before the clip bank completed.
      for (const id of fighterWarmupCandidates(state)) preloadFighterActor(id);
      return realSources;
    }, error => {
      if (!controller.signal.aborted) console.warn('Fighter animations failed to load; procedural actors stay active.', error);
      return new Map();
    }).finally(() => {
      if (animationLoadController === controller) {
        animationLoadController = null;
        animationLoadPromise = null;
      }
    });
  }
  for (const id of fighterWarmupCandidates(state)) preloadFighterActor(id);
  if (state?.phase === 'loading' || state?.phase === 'intro' || state?.phase === 'countdown' || state?.phase === 'fight') prepareFight(state);
  maybeSignalReady(); renderFlow();
}

function renderFlow(): void {
  if (!state || !loading.classList.contains('done')) return;
  const previousScroll = overlay.scrollTop;
  const focusKey = focusedControlKey();
  const phaseBeforeRender = lastPhase;
  const countdownKey = state.countdown === null ? null : Math.ceil(state.countdown) > 3 ? 'ready' : Math.ceil(state.countdown);
  const introKey = state.intro === null ? null : fighterIntroStage(state.intro);
  const key = JSON.stringify([state.phase, state.players, state.selectedMap, state.mapVotesByPlayerId,
    state.expectedPlayerCount, state.automaticSetup, state.hasExpectedPlayers,
    state.advanceReadyPlayerIds, state.backReadyPlayerIds,
    state.phonePendingPlayerIds, state.phoneDisconnectedPlayerIds,
    state.phoneTurnPendingPlayerIds, state.phoneRetryPlayerIds,
    introKey, countdownKey, playerId, touchTargetPlayerId, isHost, roster, maps, phoneNumber, flowMessage]);
  if (key === lastOverlayKey || state.phase === 'fight' || state.phase === 'victory' || state.phase === 'results') {
    if (state.phase === 'fight' || state.phase === 'victory' || state.phase === 'results') overlay.replaceChildren();
    return;
  }
  lastOverlayKey = key;
  lastPhase = state.phase;
  if (state.phase === 'lobby') {
    const sharedStatus = sharedMenuStatus(state);
    const lobbyAdvance = isSharedSetup(state) && !playerId ? ''
      : `<button id="flow-next" ${state.hasExpectedPlayers && isHost ? '' : 'disabled'}>${t('lobby.chooseFighters')}</button>`;
    const joinCard=stationDisplay.active
      ? `<div class="station-call-card"><strong>${t('lobby.stationTitle')}</strong><span>${t('lobby.stationBody')}</span></div>`
      : `<div class="qr-card">${phoneQr ? `<img src="${escapeHtml(phoneQr)}" alt="${t('lobby.qrAlt')}">` : ''}<strong>${t('lobby.scanToJoin')}</strong><span>${escapeHtml(phoneNumber)}</span></div>`;
    const steps=stationDisplay.active
      ? ['lobby.stationStep1','lobby.stationStep2','lobby.stationStep3'] as const
      : ['lobby.step1','lobby.step2','lobby.step3'] as const;
    const localAction=isDisplay
      ? stationDisplay.active?'':`<p class="phone-play-notice">${t('lobby.phonePlay')}</p>`
      : `<button id="local-join">${t('lobby.playingHere')}</button>`;
    overlay.innerHTML = `<section class="flow-panel lobby-panel"><div class="lobby-head"><h1>${t('app.title')}</h1><p>${t(stationDisplay.active?'lobby.stationTagline':'lobby.tagline')}</p></div><div class="lobby-layout">${joinCard}<div class="lobby-center"><h2>${t('lobby.getStarted')}</h2><ol class="join-steps">${steps.map((step,index)=>`<li><b>${index+1}</b><span>${t(step)}</span></li>`).join('')}</ol><div class="player-list"><h2>${t(state.players.length ? 'lobby.challengers' : 'lobby.title')}</h2>${state.players.length ? state.players.map(playerChip).join('') : `<p>${t('lobby.waitingFirst')}</p>`}</div>${sharedStatus}</div><aside class="how-to"><h2>${t('lobby.howToFight')}</h2><p>${t('lobby.rules')}</p><div class="instruction-grid"><span><b>${t('command.forward')}</b> ${t('instruction.forward')}</span><span><b>${t('command.back')}</b> ${t('instruction.back')}</span><span><b>${t('command.jump')}</b> ${t('instruction.jump')}</span><span><b>${t('command.punch')}</b> ${t('instruction.punch')}</span><span><b>${t('command.kick')}</b> ${t('instruction.kick')}</span><span><b>${t('command.block')}</b> ${t('instruction.block')}</span></div><p class="voice-tip">${t('lobby.voiceTip')}</p></aside></div><div class="flow-actions lobby-actions">${localAction}${lobbyAdvance}</div>${isHost||isDisplay ? '' : `<p class="flow-hint">${t('lobby.viewOnly')}</p>`}</section>`;
  } else if (state.phase === 'fighter_select') {
    const allPicked = state.hasExpectedPlayers && state.players.length > 0 && state.players.every(player => player.fighterId);
    const target=activeTouchPlayer(state);
    overlay.innerHTML = selectScreen(t('select.fighterTitle'), t('select.fighterDescription'), roster.map((fighter, index) => {
      const owner = state!.players.find(player => player.fighterId === fighter.id);
      return { id: fighter.id, name: localizedFighterName(fighter), detail: owner ? t('select.selectedBy', { name: owner.name }) : localizedFighterTitle(fighter), color: fighter.color, number: index + 1,
        selected:owner?.playerId===target?.playerId,taken:Boolean(owner&&owner.playerId!==target?.playerId) };
    }), 'fighter', allPicked && isHost,touchPicker(state,target,'fighter'),sharedMenuStatus(state));
  } else if (state.phase === 'map_select') {
    const target=activeTouchPlayer(state);
    const allVotes=state.hasExpectedPlayers&&state.players.filter(player=>!player.isAi)
      .every(player=>Boolean(state!.mapVotesByPlayerId[player.playerId]));
    const drawnMap=maps.find(map=>map.id===state!.selectedMap);
    const description=state.mapVoteTied&&drawnMap
      ? `${t('select.arenaDescription')} ${t('shared.arenaTie',{name:localizedMapName(drawnMap)})}`
      :t('select.arenaDescription');
    overlay.innerHTML = selectScreen(t('select.arenaTitle'), description, maps.map((map, index) => ({ id: map.id, name: localizedMapName(map), detail: localizedMapBlurb(map), color: map.color, number: index + 1,
      selected:state!.mapVotesByPlayerId[target?.playerId??'']===map.id,taken:false })), 'map', allVotes && isHost,touchPicker(state,target,'map'),sharedMenuStatus(state));
  } else if (state.phase === 'loading') {
    overlay.innerHTML = `<section class="countdown-screen loading-arena"><span>${t('loading.preparingStage')}</span><strong>${t('loading.loading')}</strong><small>${escapeHtml(localizedMapName(maps.find(map => map.id === state!.selectedMap)))}</small></section>`;
  } else if (state.phase === 'intro') {
    overlay.innerHTML = introHtml(state);
  } else if (state.phase === 'countdown') {
    const count = Math.ceil(state.countdown ?? 0);
    overlay.innerHTML = `<section class="countdown-screen"><span>${t(count > 3 ? 'loading.loadingArena' : 'loading.matchBeginsIn')}</span><strong>${count > 3 ? t('loading.readyCall') : count}</strong><small>${state.selectedMap ? escapeHtml(localizedMapName(maps.find(map => map.id === state!.selectedMap))) : ''}</small></section>`;
  }
  if (flowMessage && state.phase !== 'countdown') overlay.insertAdjacentHTML('beforeend', `<div class="flow-error" role="alert">${escapeHtml(flowMessage)}</div>`);
  wireFlowButtons();
  requestAnimationFrame(() => {
    overlay.scrollTop = previousScroll;
    const replacement = focusKey ? overlay.querySelector<HTMLElement>(focusKey) : null;
    if (replacement) replacement.focus();
    else if (phaseBeforeRender && phaseBeforeRender !== state?.phase) overlay.querySelector<HTMLElement>('h1, [tabindex="-1"]')?.focus();
  });
}

function isSharedSetup(current: FighterState): boolean {
  return current.automaticSetup && current.expectedPlayerCount === 2;
}

function sharedMenuStatus(current: FighterState): string {
  if (!isSharedSetup(current)) return '';
  const prompt = current.phase === 'map_select' ? 'shared.startPrompt' : 'shared.nextPrompt';
  const seats = (['p1', 'p2'] as const).map(side => {
    const player = current.players.find(candidate => candidate.side === side && !candidate.isAi);
    const ready = Boolean(player && current.advanceReadyPlayerIds.includes(player.playerId)
      && !current.phonePendingPlayerIds.includes(player.playerId)
      && !current.phoneDisconnectedPlayerIds.includes(player.playerId));
    const status = fighterSharedSeatStatus(current, player);
    return `<div class="shared-setup-seat ${ready ? 'is-ready' : ''}"><b>${side.toUpperCase()}</b><strong>${escapeHtml(player?.name ?? t('shared.waitingSeat'))}</strong><span>${t(status)}</span></div>`;
  }).join('');
  return `<div class="shared-setup-state" role="status" aria-live="polite"><p>${t(prompt)}</p><div class="shared-setup-seats">${seats}</div></div>`;
}

function selectScreen(title: string, description: string, cards: { id: string; name: string; detail: string; color: string; number: number; selected: boolean; taken: boolean }[], kind: 'fighter'|'map', ready: boolean,picker='',sharedStatus=''): string {
  const shared = Boolean(state && isSharedSetup(state));
  const localControls = !shared || Boolean(playerId);
  const actions = localControls
    ? `<div class="flow-actions"><button id="flow-back" class="secondary">${t('select.back')}</button><button id="flow-next" ${ready ? '' : 'disabled'}>${t(kind === 'map' ? 'select.startFight' : 'select.chooseArena')}</button></div>`
    : '';
  return `<section class="flow-panel selection-panel"><span class="flow-kicker">${t('app.title')}</span><h1 tabindex="-1">${title}</h1><p>${description}</p>${picker}${sharedStatus}<div class="select-grid ${kind}-grid">${cards.map(card => { const preview = kind === 'fighter' ? roster.find(entry => entry.id === card.id)?.preview : maps.find(map => map.id === card.id)?.preview; return `<button class="select-card ${card.selected ? 'selected' : ''} ${card.taken ? 'taken' : ''}" data-${kind}="${card.id}" data-state-label="${t(kind === 'map' ? 'select.voted' : 'select.locked')}" aria-pressed="${card.selected}" aria-label="${String(card.number).padStart(2, '0')}, ${escapeHtml(card.name)}, ${escapeHtml(card.detail)}" style="--card-color:${card.color}" ${card.taken && kind === 'fighter' ? 'disabled' : ''}><div class="card-preview" aria-hidden="true" ${preview ? `style="background-image:url('${preview}')"` : ''}></div><span class="number">${String(card.number).padStart(2, '0')}</span><strong>${escapeHtml(card.name)}</strong><span>${escapeHtml(card.detail)}</span></button>`; }).join('')}</div>${actions}<div class="flow-hint">${t(shared ? 'shared.backPrompt' : 'select.hint')}</div></section>`;
}

function activeTouchPlayer(current:FighterState):FighterLobbyPlayer|null{
  const humans=current.players.filter(player=>!player.isAi);
  if(!isHost&&playerId)return humans.find(player=>player.playerId===playerId)??null;
  const assigned=humans.find(player=>player.playerId===touchTargetPlayerId);
  if(assigned)return assigned;
  const waiting=current.phase==='fighter_select'
    ?humans.find(player=>!player.fighterId)
    :humans.find(player=>!current.mapVotesByPlayerId[player.playerId]);
  const target=waiting??humans[0]??null;
  touchTargetPlayerId=target?.playerId??null;
  return target;
}

function updateTouchTarget(next:FighterState,previous:FighterState|null):void{
  if(next.phase!==previous?.phase){touchTargetPlayerId=null;return;}
  if(!touchTargetPlayerId||!previous)return;
  const before=previous.players.find(player=>player.playerId===touchTargetPlayerId);
  const after=next.players.find(player=>player.playerId===touchTargetPlayerId);
  if(!after){touchTargetPlayerId=null;return;}
  const choiceChanged=next.phase==='fighter_select'&&before?.fighterId!==after.fighterId&&Boolean(after.fighterId);
  const voteChanged=next.phase==='map_select'
    &&previous.mapVotesByPlayerId[touchTargetPlayerId]!==next.mapVotesByPlayerId[touchTargetPlayerId]
    &&Boolean(next.mapVotesByPlayerId[touchTargetPlayerId]);
  if(choiceChanged||voteChanged){
    const waiting=next.players.filter(player=>!player.isAi).find(player=>next.phase==='fighter_select'
      ?!player.fighterId:!next.mapVotesByPlayerId[player.playerId]);
    if(waiting)touchTargetPlayerId=waiting.playerId;
  }
}

function touchPicker(current:FighterState,target:FighterLobbyPlayer|null,kind:'fighter'|'map'):string{
  if(!isHost||!target)return '';
  const humans=current.players.filter(player=>!player.isAi);
  return `<div class="touch-player-picker"><div class="touch-player-options">${humans.map(player=>{
    const chosen=kind==='fighter'?Boolean(player.fighterId):Boolean(current.mapVotesByPlayerId[player.playerId]);
    return `<button type="button" data-touch-player="${escapeHtml(player.playerId)}" aria-pressed="${player.playerId===target.playerId}" class="${player.playerId===target.playerId?'active':''}">${escapeHtml(player.name)}${chosen?' ✓':''}</button>`;
  }).join('')}</div></div>`;
}

function focusedControlKey(): string | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !overlay.contains(active)) return null;
  if (active.id) return `#${CSS.escape(active.id)}`;
  if (active.dataset.fighter) return `[data-fighter="${CSS.escape(active.dataset.fighter)}"]`;
  if (active.dataset.map) return `[data-map="${CSS.escape(active.dataset.map)}"]`;
  if (active.dataset.touchPlayer) return `[data-touch-player="${CSS.escape(active.dataset.touchPlayer)}"]`;
  return null;
}

interface ErrorAction { label: string; secondary?: boolean; action: () => void }
function showAssetError(title: string, error: unknown, actions: ErrorAction[]): void {
  if (errorBox.hidden) focusBeforeError = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  errorBox.replaceChildren();
  const heading = document.createElement('strong'); heading.textContent = title;
  const detail = document.createElement('p'); detail.textContent = t('error.assetDetail');
  console.error(error);
  const controls = document.createElement('div'); controls.className = 'error-actions';
  for (const item of actions) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label;
    if (item.secondary) button.className = 'secondary'; button.addEventListener('click', item.action); controls.appendChild(button);
  }
  errorBox.append(heading, detail, controls); errorBox.hidden = false;
  requestAnimationFrame(() => controls.querySelector('button')?.focus());
}
function hideAssetError(): void {
  if (errorBox.hidden) return;
  errorBox.hidden = true; errorBox.replaceChildren();
  const target = focusBeforeError?.isConnected ? focusBeforeError : overlay.querySelector<HTMLElement>('button:not(:disabled), h1');
  focusBeforeError = null; requestAnimationFrame(() => target?.focus());
}
function reloadForAssetRetry(): void {
  if (state?.phase !== 'loading') { location.reload(); return; }
  assetRetryGeneration = state.loadingGeneration;
  connection.retryLoading();
  if (assetRetryTimer) clearTimeout(assetRetryTimer);
  assetRetryTimer = setTimeout(() => location.reload(), 10_000);
}

function wireFlowButtons(): void {
  $('flow-next')?.addEventListener('click', () => { flowMessage = ''; advanceMenu(); });
  $('flow-back')?.addEventListener('click', () => { if (isHost) backMenu(); });
  $('local-join')?.addEventListener('click', toggleLocalPlayer);
  for(const button of overlay.querySelectorAll<HTMLElement>('[data-touch-player]'))button.addEventListener('click',()=>{
    touchTargetPlayerId=button.dataset.touchPlayer??null;lastOverlayKey='';renderFlow();
  });
  for (const button of overlay.querySelectorAll<HTMLElement>('[data-fighter]')) button.addEventListener('click', () => {
    if(!state)return;flowMessage='';
    if(isHost){const target=activeTouchPlayer(state);if(target){
      if(target.playerId===playerId&&keyboardPlayerConn)keyboardPlayerConn.selectFighter(button.dataset.fighter!);
      else connection.displaySelectFighter(target.playerId,button.dataset.fighter!);
    }}
    else if(playerId)(keyboardPlayerConn ?? connection).selectFighter(button.dataset.fighter!);
  });
  for (const button of overlay.querySelectorAll<HTMLElement>('[data-map]')) button.addEventListener('click', () => {
    if(!state)return;flowMessage='';
    if(isHost){const target=activeTouchPlayer(state);if(target){
      if(target.playerId===playerId&&keyboardPlayerConn)keyboardPlayerConn.selectMap(button.dataset.map!);
      else connection.displaySelectMap(target.playerId,button.dataset.map!);
    }}
    else if(playerId)(keyboardPlayerConn ?? connection).selectMap(button.dataset.map!);
  });
}

function introHtml(current: FighterState): string {
  const stage = fighterIntroStage(current.intro ?? 0);
  const p1 = current.players.find(player => player.side === 'p1'), p2 = current.players.find(player => player.side === 'p2');
  const p1Entry = roster.find(fighter => fighter.id === p1?.fighterId), p2Entry = roster.find(fighter => fighter.id === p2?.fighterId);
  const p1Fighter = p1Entry ? localizedFighterName(p1Entry) : t('intro.fighterOne');
  const p2Fighter = p2Entry ? localizedFighterName(p2Entry) : t('intro.fighterTwo');
  if (stage === 'versus') return `<section class="intro-screen versus-beat"><span>${t('intro.tonight')}</span><strong>${t('intro.versusMark')}</strong></section>`;
  if (stage === 'faceoff') return `<section class="intro-screen faceoff-beat"><div><small>${escapeHtml(p1?.name ?? t('hud.playerOne'))}</small><b>${escapeHtml(p1Fighter)}</b></div><strong>${t('intro.versusMark')}</strong><div><small>${escapeHtml(p2?.name ?? t('intro.rival'))}</small><b>${escapeHtml(p2Fighter)}</b></div></section>`;
  const player = stage === 'p1' ? p1 : p2, fighter = stage === 'p1' ? p1Fighter : p2Fighter;
  return `<section class="intro-screen fighter-beat ${stage}"><span>${t(stage === 'p1' ? 'intro.playerOne' : 'intro.challenger')}</span><strong>${escapeHtml(fighter)}</strong><small>${escapeHtml(player?.name ?? t('intro.rival'))}</small></section>`;
}

function beginIntro(current: FighterState): void {
  getMusicManager().switchContext('fighter');
  introSegment = '';
  updateIntroPresentation(current, true);
}

function updateIntroPresentation(current: FighterState, force = false): void {
  if (!actors || current.phase !== 'intro') return;
  const segment = fighterIntroStage(current.intro ?? 0), changed = force || segment !== introSegment;
  if (changed) {
    introSegment = segment;
    if (segment === 'p1') playIntroAttack(actors.p1);
    else if (segment === 'p2') playIntroAttack(actors.p2);
    else if (segment === 'faceoff') { actors.p1.playRandom('idle', { loop: true }); actors.p2.playRandom('idle', { loop: true }); }
  }
  if (segment === 'p1' || segment === 'p2') {
    const featured = segment === 'p1' ? actors.p1 : actors.p2, hidden = segment === 'p1' ? actors.p2 : actors.p1;
    featured.root.visible = true; hidden.root.visible = false;
    featured.root.position.set(0, 0, 0); featured.root.rotation.y = 0;
    camera.position.set(segment === 'p1' ? .35 : -.35, 1.2, 4.2); camera.lookAt(0, 1.1, 0);
  } else if (segment === 'versus') {
    actors.p1.root.visible = false; actors.p2.root.visible = false;
  } else {
    actors.p1.root.visible = true; actors.p2.root.visible = true;
    actors.p1.root.position.set(-1.15, 0, 0); actors.p1.root.rotation.y = Math.PI / 2;
    actors.p2.root.position.set(1.15, 0, 0); actors.p2.root.rotation.y = -Math.PI / 2;
    camera.position.set(0, 1.35, 6); camera.lookAt(0, 1.1, 0);
  }
}

function playIntroAttack(actor: FighterActor): void {
  const command = Math.random() < .5 ? 'punch' : 'kick';
  actor.playRandom(command, { speed: .85 });
  if (command === 'punch') getSoundEffectsManager().playFighterPunch();
  else getSoundEffectsManager().playFighterKick();
}

function endIntro(current: FighterState): void {
  if (!actors) return;
  introSegment = ''; actors.p1.root.visible = true; actors.p2.root.visible = true;
  actors.p1.playRandom('idle', { loop: true }); actors.p2.playRandom('idle', { loop: true });
  if (current.world) syncAuthoritativePositions(current.world, true);
  camera.position.set(...cameraBase.pos); updateCameraProjection(); camera.lookAt(...cameraBase.lookAt);
}

function prepareFight(next: FighterState): void {
  const context = fighterActorLoadContext(next);
  if (!context) return;
  const { p1Id, p2Id } = context;
  const key = `${p1Id}:${p2Id}`;
  if (!loadedActors.has(p1Id) || !loadedActors.has(p2Id)) { ensureFightActors(context); return; }
  if (key !== actorKey) {
    if (actors) { scene.remove(actors.p1.root, actors.p2.root); actors = null; }
    const left = loadedActors.get(p1Id), right = loadedActors.get(p2Id); if (!left || !right) return;
    actors = { p1: left, p2: right }; actorKey = key;
    scene.add(left.root, right.root);
    trimActorCache(new Set([p1Id, p2Id]));
  }
  if (!actors) return;
  actorLoadCoordinator.clear();
  const setupKey = `${key}:${next.selectedMap ?? ''}`;
  if (preparedFightKey !== setupKey) {
    preparedFightKey = setupKey; movement = {};
    actors.p1.playRandom('idle', { loop: true }); actors.p2.playRandom('idle', { loop: true });
    if (next.world) syncAuthoritativePositions(next.world, true);
  }
  replayBufferedEvents();
  if (next.phase === 'fight') startFightPresentation(setupKey);
}

function ensureFightActors(context: FighterActorLoadContext): void {
  if (!animationSources) return;
  // Save Data and a display joining mid-bout keep the immediate local actors.
  // During setup, an empty animation bank is not a reason to skip the selected FBX:
  // FighterActor can play its embedded idle and local action motions.
  if (preferProceduralFighterAssets(browserConnection())
    || state?.phase === 'fight' && !animationSources.size && !animationLoadPromise) {
    installFallbackActors(context); return;
  }
  const { p1Id, p2Id } = context;
  const load = (id: string) => {
    const existing = loadedActors.get(id); if (existing && !fallbackActorIds.has(id)) return Promise.resolve(existing);
    let pending = actorLoads.get(id);
    if (!pending) {
      const spec = FIGHTERS.find(fighter => fighter.id === id); if (!spec) return Promise.reject(new Error(t('error.unknownFighter', { id })));
      pending = loadFighterActor(spec); actorLoads.set(id, pending);
      const currentLoad = pending;
      void pending.then(actor => storeLoadedActor(id, actor, new Set([p1Id, p2Id])))
        .finally(() => { if (actorLoads.get(id) === currentLoad) actorLoads.delete(id); }).catch(() => {});
    }
    return pending;
  };
  actorLoadCoordinator.start(
    context.key,
    async () => {
      // Fetch the chosen FBX files while the shared animation bank is still in
      // flight. FighterActor combines them once both are available.
      await Promise.all([load(p1Id), load(p2Id)]);
    },
    () => fighterActorLoadContext(state)?.key === context.key,
    () => finishActorPreparation(context),
    error => {
      if (error) console.warn('Fighter model failed to load; using fallback actors.', error);
      else console.warn(`Fighter models were not ready after ${FIGHTER_ACTOR_FALLBACK_MS / 1000} seconds; using fallback actors.`);
      installFallbackActors(context);
    },
  );
}

function finishActorPreparation(context: FighterActorLoadContext): void {
  if (!state || fighterActorLoadContext(state)?.key !== context.key) return;
  prepareFight(state);
  if (state.phase === 'intro') beginIntro(state);
  maybeSignalReady();
}

function installFallbackActors(context: FighterActorLoadContext): void {
  for (const id of [context.p1Id, context.p2Id]) {
    if (loadedActors.has(id)) continue;
    const color = roster.find(fighter => fighter.id === id)?.color ?? '#ef223a';
    loadedActors.set(id, FighterActor.fallback(color, id));
    fallbackActorIds.add(id);
  }
  finishActorPreparation(context);
}

function storeLoadedActor(id: string, actor: FighterActor, keep: Set<string>): void {
  if (!fighterShouldRetainActor(state, id)) { actor.dispose(); return; }
  const existing = loadedActors.get(id);
  if (!existing) loadedActors.set(id, actor);
  else if (fallbackActorIds.has(id)) {
    if (actors && (actors.p1 === existing || actors.p2 === existing)) {
      deferredRealActors.get(id)?.dispose();
      deferredRealActors.set(id, actor);
    } else {
      loadedActors.set(id, actor); fallbackActorIds.delete(id); existing.dispose();
    }
  } else actor.dispose();
  trimActorCache(keep);
}

function resetFallbackActors(): void {
  if (!fallbackActorIds.size) return;
  if (actors) { scene.remove(actors.p1.root, actors.p2.root); actors = null; actorKey = ''; preparedFightKey = ''; }
  for (const id of fallbackActorIds) {
    const fallback = loadedActors.get(id);
    const replacement = deferredRealActors.get(id);
    if (!replacement) continue;
    loadedActors.set(id, replacement); deferredRealActors.delete(id);
    fallback?.dispose(); fallbackActorIds.delete(id);
  }
}

function preloadFighterActor(id: string): void {
  // The chosen FBX can download while the shared clip bank is still loading;
  // FighterActor.load joins the two once both are ready.
  if ((!animationSources && !animationLoadPromise) || preferProceduralFighterAssets(browserConnection())
    || loadedActors.has(id) && !fallbackActorIds.has(id) || actorLoads.has(id)
    || !actorWarmupRetries.canStart(id, performance.now())) return;
  const spec = FIGHTERS.find(fighter => fighter.id === id); if (!spec) return;
  clearActorWarmupRetryTimer(id);
  const pending = loadFighterActor(spec); actorLoads.set(id, pending);
  void pending.then(actor => {
    if (actorLoads.get(id) === pending) actorWarmupRetries.succeeded(id);
    storeLoadedActor(id, actor, new Set([id]));
  }, () => {
    // A cancelled or superseded selection must not consume the retry budget.
    if (actorLoads.get(id) !== pending || !fighterWarmupCandidates(state).includes(id)) return;
    const delay = actorWarmupRetries.failed(id, performance.now());
    if (delay === null) return;
    actorWarmupRetryTimers.set(id, setTimeout(() => {
      actorWarmupRetryTimers.delete(id);
      if (fighterWarmupCandidates(state).includes(id)) preloadFighterActor(id);
    }, delay));
  })
    .finally(() => { if (actorLoads.get(id) === pending) actorLoads.delete(id); }).catch(() => {});
}

function clearActorWarmupRetryTimer(id: string): void {
  const timer = actorWarmupRetryTimers.get(id);
  if (timer) clearTimeout(timer);
  actorWarmupRetryTimers.delete(id);
}

function clearActorWarmupRetryTimers(): void {
  for (const id of actorWarmupRetryTimers.keys()) clearActorWarmupRetryTimer(id);
}

function retainActorWarmupRetries(ids: ReadonlySet<string>): void {
  actorWarmupRetries.retainOnly(ids);
  for (const id of actorWarmupRetryTimers.keys()) if (!ids.has(id)) clearActorWarmupRetryTimer(id);
}

function browserConnection(): { saveData?: boolean; effectiveType?: string } | undefined {
  return (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
}

function cancelActorLoads(keep?: ReadonlySet<string>): void {
  for (const [id, controller] of actorLoadControllers) {
    if (keep?.has(id)) continue;
    actorLoads.delete(id);
    controller.abort(new Error(`fighter ${id} is no longer needed`));
    actorLoadControllers.delete(id);
  }
}

function cancelOptionalFightDownloads(): void {
  animationLoadController?.abort(new Error('fight started'));
  animationLoadController = null;
  cancelActorLoads();
  if (mapLoadController) {
    mapLoadController.abort(new Error('fight started'));
    mapLoadController = null;
    mapLoadAttempt++;
    if (state?.selectedMap) failedMapKey = `${state.loadingGeneration}:${state.selectedMap}`;
  }
}

function loadFighterActor(spec: (typeof FIGHTERS)[number]): Promise<FighterActor> {
  return new Promise((resolve, reject) => {
    const sources = animationSources?.size ? animationSources : animationLoadPromise ?? animationSources ?? new Map();
    const controller = new AbortController();
    actorLoadControllers.set(spec.id, controller);
    let settled = false;
    const clear = () => {
      clearTimeout(timer);
      if (actorLoadControllers.get(spec.id) === controller) actorLoadControllers.delete(spec.id);
    };
    controller.signal.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      clear();
      reject(controller.signal.reason ?? new DOMException('Fighter asset request aborted', 'AbortError'));
    }, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new Error(`fighter model timed out after ${FIGHTER_ACTOR_TIMEOUT_MS / 1000} seconds`));
    }, FIGHTER_ACTOR_TIMEOUT_MS);
    void FighterActor.load(spec, sources, undefined, controller.signal).then(actor => {
      if (settled) { actor.dispose(); return; }
      settled = true; clear(); resolve(actor);
    }, error => {
      if (settled) return;
      settled = true; clear(); reject(error);
    });
  });
}

function beginFight(next: FighterState): void {
  prepareFight(next);
  if (!actors) return;
  startFightPresentation(`${actorKey}:${next.selectedMap ?? ''}`);
}

function startFightPresentation(key: string): void {
  if (fightStartedKey === key) return;
  fightStartedKey = key; hideAssetError(); result.hidden = true; setFightControlsEnabled(true);
  fightCall.classList.remove('show'); void fightCall.offsetWidth; fightCall.classList.add('show'); announce(t('event.fight'));
  scheduleFightReceipt();
}

function scheduleFightReceipt():void{
  if(!state||state.phase!=='fight'||state.hudPresented||!isHost
    ||fighterConnectionState!=='connected'||!loading.classList.contains('done')||!actors||!fightStartedKey)return;
  const key=`${state.roomCode}:${state.loadingGeneration}`;
  if(sentFightReceipt===key||pendingFightReceipt===key)return;
  pendingFightReceipt=key;
  const epoch=presentationEpoch;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(pendingFightReceipt===key)pendingFightReceipt='';
    if(epoch!==presentationEpoch||!state||state.phase!=='fight'||state.hudPresented
      ||`${state.roomCode}:${state.loadingGeneration}`!==key||!isHost
      ||fighterConnectionState!=='connected'||!loading.classList.contains('done')||!actors||!fightStartedKey)return;
    sentFightReceipt=key;
    connection.ackDisplay('fight',state.loadingGeneration);
  }));
}

function handleEvents(events: FighterEvent[]): void {
  if (!actors) { bufferedEvents.push(...events); if (bufferedEvents.length > 200) bufferedEvents.splice(0, bufferedEvents.length - 200); return; }
  applyEvents(events);
}
function replayBufferedEvents(): void {
  if (!actors || !bufferedEvents.length) return;
  const pending = bufferedEvents; bufferedEvents = []; applyEvents(pending);
}
function applyEvents(events: FighterEvent[]): void {
  if (!actors) return;
  const mySide = state?.players.find(player => player.playerId === playerId)?.side;
  for (const event of events) {
    if (event.type === 'action') {
      const pool = event.command === 'forward' ? 'walk' : event.command === 'back' ? 'walk-back' : event.command;
      const actionDuration = actors[event.fighter].playRandom(pool, { speed: FIGHTER_ACTION_PLAYBACK_SPEED[event.command]??1 });
      if (event.command === 'punch') getSoundEffectsManager().playFighterPunch();
      else if (event.command === 'kick') getSoundEffectsManager().playFighterKick();
      if (event.command === 'forward' || event.command === 'back') {
        actionDurations[event.fighter] = actionDuration || (event.command === 'forward' ? FIGHTER_RUN_FORWARD_DURATION : FIGHTER_RUN_BACKWARD_DURATION);
      }
      const player = state?.players.find(candidate => candidate.side === event.fighter);
      if (player && !player.isAi) { announce(t('event.playerCommand', { name: player.name, command: commandLabel(event.command).toLocaleLowerCase(locale) })); flashButton(event.command); }
    } else if (event.type === 'move') movement[event.fighter] = { from: event.from, to: event.to, elapsed: 0, jump: event.jump === true, duration: event.jump ? FIGHTER_JUMP_TWEEN_SECONDS : actionDurations[event.fighter] };
    else if (event.type === 'hit') { if (!event.blocked) actors[event.defender].playRandom('reaction', { speed: FIGHTER_REACTION_PLAYBACK_SPEED }); showImpact(event.blocked ? t('event.blocked') : `-${event.damage}`, event.defender); }
    else if (event.type === 'miss' && event.attacker === mySide) announce(t('event.missed'));
    else if (event.type === 'ko') {
      actors[event.loser].playRandom('fall', { hold: true, lockFloor: true });
      getMusicManager().switchContext('fighter-victory');
      const celebrationSeconds = actors[event.winner].playRandom('celebration');
      resultRevealAt = performance.now() + Math.min(12000, Math.max(6000, celebrationSeconds * 1000 + 1500));
    }
  }
}

function trimActorCache(keep: Set<string>): void {
  // Setup warmup can complete while another chosen fighter is the oldest cached
  // actor. Keep both selections so a rematch does not download one again.
  for (const id of fighterWarmupCandidates(state)) keep.add(id);
  const current = fighterActorLoadContext(state);
  if (current) { keep.add(current.p1Id); keep.add(current.p2Id); }
  for (const [id, actor] of loadedActors) {
    if (loadedActors.size <= 4) break;
    if (keep.has(id) || actor === actors?.p1 || actor === actors?.p2) continue;
    loadedActors.delete(id); fallbackActorIds.delete(id); actor.dispose();
    const deferred = deferredRealActors.get(id); deferredRealActors.delete(id); deferred?.dispose();
  }
}

function syncAuthoritativePositions(world: FighterWorld, immediate = false): void {
  if (!actors) return;
  for (const id of ['p1', 'p2'] as const) {
    if (immediate || !movement[id]) displayX[id] = world[id].x;
    if (immediate) displayHeight[id] = 0;
  }
  applyActorTransforms();
}
function updateMovement(delta: number): void {
  if (!actors) return;
  for (const id of ['p1', 'p2'] as const) {
    const tween = movement[id]; if (!tween) continue; tween.elapsed += delta;
    const duration = tween.duration;
    const t = Math.min(1, tween.elapsed / duration); displayX[id] = THREE.MathUtils.lerp(tween.from, tween.to, t);
    displayHeight[id] = tween.jump ? Math.sin(Math.PI * t) * 2.5 : 0;
    if (t === 1) { displayHeight[id] = 0; delete movement[id]; }
  }
  applyActorTransforms();
}

function applyActorTransforms(): void {
  if (!actors) return;
  const angle = THREE.MathUtils.degToRad(mapPlane.rotationY), axisX = Math.cos(angle), axisZ = -Math.sin(angle);
  for (const id of ['p1', 'p2'] as const) {
    const actor = actors[id], localX = displayX[id];
    actor.root.position.set(mapPlane.origin[0] + axisX * localX, mapPlane.origin[1] + displayHeight[id], mapPlane.origin[2] + axisZ * localX);
    const other = id === 'p1' ? 'p2' : 'p1';
    const toward = Math.sign(displayX[other] - localX) || (id === 'p1' ? 1 : -1);
    actor.root.rotation.y = angle + (toward > 0 ? Math.PI / 2 : -Math.PI / 2);
  }
}

function updateNames(next: FighterState): void {
  for (const [side, fighterEl, playerEl] of [['p1', p1FighterName, p1PlayerName], ['p2', p2FighterName, p2PlayerName]] as const) {
    const player = next.players.find(row => row.side === side); const fighter = roster.find(row => row.id === player?.fighterId);
    fighterEl.textContent = fighter ? localizedFighterName(fighter) : side.toUpperCase(); playerEl.textContent = player?.isAi ? t('hud.cpuRival') : player?.name ?? t('hud.waiting');
  }
}
function playerChip(player: FighterState['players'][number]): string { return `<div class="player-chip"><strong>${escapeHtml(player.name)}</strong><span>${t(player.isAi ? 'status.cpu' : 'status.connected')}</span></div>`; }
function advanceMenu(): void {
  if (playerId && keyboardPlayerConn) keyboardPlayerConn.advance();
  else connection.advance();
}
function backMenu(): void {
  if (playerId && keyboardPlayerConn) keyboardPlayerConn.back();
  else connection.back();
}
function releaseKeyboardPlayer(): void {
  if (keyboardPlayerConn) {
    keyboardPlayerConn.leaveAndClose(roomCode);
    keyboardPlayerConn = null; playerId = null; touchTargetPlayerId = null;
  }
}
function toggleLocalPlayer(): void {
  if (stationDisplay.active) return;
  if (keyboardPlayerConn) releaseKeyboardPlayer();
  else {
    const playerConn = connection.createKeyboardPlayerConnection();
    keyboardPlayerConn = playerConn;
    playerConn.onJoined(id => {
      if (keyboardPlayerConn !== playerConn) return;
      playerId = id; touchTargetPlayerId = id; renderFlow(); syncResultActions();
    });
    playerConn.onConnectionState(status => {
      if (keyboardPlayerConn !== playerConn || status === 'connected') return;
      playerId = null; touchTargetPlayerId = null; renderFlow(); syncResultActions();
    });
    playerConn.onError((code, message) => {
      console.error(`[fighter keyboard] ${code}: ${message}`);
      if (keyboardPlayerConn !== playerConn) return;
      flowMessage = localizedServerError(code) ?? t('error.invalidResponse');
      if (code === 'room_full' || code === 'station_voice_only') {
        playerConn.leaveAndClose(roomCode);
        keyboardPlayerConn = null; playerId = null; touchTargetPlayerId = null;
      }
      lastOverlayKey = ''; renderFlow(); syncResultActions();
    });
    playerConn.join(roomCode, t('player.keyboard'));
  }
  renderFlow(); syncResultActions();
}
function announce(text: string): void { voiceCommand.textContent = text.replace('-', ' '); voiceFeed.classList.remove('heard'); void (voiceFeed as HTMLElement).offsetWidth; voiceFeed.classList.add('heard'); }
function flashButton(command: FighterCommand): void { const button = commandButtons.find(item => item.dataset.command === command); button?.classList.add('active'); setTimeout(() => button?.classList.remove('active'), 220); }
function showImpact(text: string, defender: FighterId): void { document.body.classList.remove('shake'); void document.body.offsetWidth; document.body.classList.add('shake'); const element = document.createElement('div'); element.className = 'impact'; element.style.left = defender === 'p1' ? '39%' : '61%'; element.textContent = text; document.body.appendChild(element); setTimeout(() => element.remove(), 600); }
function syncResultActions(): void {
  const action = fighterResultActionState(stationDisplay.active, isHost, fighterConnectionState, state?.phase);
  const shared = Boolean(state && isSharedSetup(state) && !stationDisplay.active);
  rematch.hidden = action !== 'rematch' || shared && !playerId;
  resultExit.hidden = action === 'station';
  resultStationNext.hidden = action !== 'station';
  resultActionStatus.hidden = !shared && action !== 'viewer' && action !== 'reconnecting';
  resultActionStatus.setAttribute('role', 'status');
  resultActionStatus.setAttribute('aria-live', 'polite');
  const summary = action === 'reconnecting' ? t('result.reconnecting')
    : shared && state?.phoneDisconnectedPlayerIds.length ? t('shared.rematchReconnect')
    : shared && state?.phoneRetryPlayerIds.length ? t('shared.rematchPhoneRetry')
    : shared && state?.phonePendingPlayerIds.length
      ? t('shared.rematchPhonePending', { count: state.advanceReadyPlayerIds.length })
    : shared ? t('shared.rematchReady', { count: state?.advanceReadyPlayerIds.length ?? 0 })
    : action === 'viewer' ? t('result.hostOnly') : '';
  if (shared && state && action === 'rematch') {
    const seats = (['p1', 'p2'] as const).map(side => {
      const player = state!.players.find(candidate => candidate.side === side && !candidate.isAi);
      const status = fighterSharedSeatStatus(state!, player);
      const ready = player && state!.advanceReadyPlayerIds.includes(player.playerId)
        && !state!.phonePendingPlayerIds.includes(player.playerId)
        && !state!.phoneDisconnectedPlayerIds.includes(player.playerId);
      return `<span class="result-setup-seat${ready ? ' is-ready' : ''}"><b>${side.toUpperCase()}</b> `
        + `<strong>${escapeHtml(player?.name ?? t('shared.waitingSeat'))}</strong> `
        + `<span>${escapeHtml(t(status))}</span></span>`;
    }).join(' ');
    const markup = `<span class="result-status-copy">${escapeHtml(summary)}</span>`
      + ` <span class="result-setup-seats">${seats}</span>`;
    if (resultActionStatus.innerHTML !== markup) resultActionStatus.innerHTML = markup;
  } else resultActionStatus.textContent = summary;
  if (rematch.hidden && document.activeElement === rematch && !resultExit.hidden) resultExit.focus();
}
function showResult(winner: FighterId): void {
  if(state?.phase!=='results'||state.result?.winner!==winner)return;
  if (resultTimer) clearTimeout(resultTimer);
  const delay = Math.max(0, resultRevealAt - performance.now());
  if (delay > 0) {
    result.hidden = true;
    resultTimer = setTimeout(() => { resultTimer = null; showResult(winner); }, delay);
    return;
  }
  const player = state?.players.find(row => row.side === winner); const fighter = roster.find(row => row.id === player?.fighterId);
  const wasHidden = result.hidden;
  syncResultActions();
  result.classList.toggle('station-result', stationDisplay.active);
  resultTitle.textContent = t('result.wins', { name: state.result?.winnerName ?? player?.name ?? winner });
  resultChampion.textContent = fighter ? t('result.champion', { fighter: localizedFighterName(fighter) }) : '';
  result.hidden = false; setFightControlsEnabled(false);
  scheduleResultReceipt();
  if (wasHidden && !stationDisplay.active) requestAnimationFrame(() => {
    if (result.hidden || result.contains(document.activeElement)) return;
    (rematch.hidden ? resultExit : rematch).focus();
  });
}
function scheduleResultReceipt():void{
  if(!state||state.phase!=='results'||!state.result||result.hidden||!loading.classList.contains('done'))return;
  const key=`${state.roomCode}:${state.loadingGeneration}`;
  if(pendingResultReceipt===key)return;
  if(sentResultReceipt===key)return;
  pendingResultReceipt=key;
  const epoch=presentationEpoch;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(pendingResultReceipt===key)pendingResultReceipt='';
    if(epoch!==presentationEpoch||!state||state.phase!=='results'||!state.result
      ||`${state.roomCode}:${state.loadingGeneration}`!==key||result.hidden||!loading.classList.contains('done'))return;
    stationDisplay.markEngineResultsReady();
    if(isHost&&fighterConnectionState==='connected'&&!state.resultsPresented&&sentResultReceipt!==key){
      sentResultReceipt=key;
      connection.ackDisplay('results',state.loadingGeneration);
    }
  }));
}
function setFightControlsEnabled(enabled: boolean): void { for (const label of commandButtons) label.classList.toggle('inactive', !enabled); }
function applyMapTheme(mapId: string): void {
  // Fight state arrives at 20 Hz. Reapplying the saved camera on every snapshot fights the smooth
  // tracking camera and produces a visible judder; map setup is a one-time phase transition.
  const loadKey = `${state?.loadingGeneration ?? 0}:${mapId}`;
  if (loadedMapId === mapId) {
    if (failedMapKey === loadKey) return;
    if (!failedMapKey) { maybeSignalReady(); return; }
  }
  const config = maps.find(map => map.id === mapId); if (!config) return;
  mapLoadController?.abort(new Error('arena selection changed'));
  mapLoadController = null;
  const attempt = ++mapLoadAttempt;
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  loadedMapId = mapId;
  mapReadyId = '';
  failedMapKey = '';
  usingProceduralFallback = false;
  if (!initializationFailed) hideAssetError();
  disposeCurrentMap();
  theme.ring.material.color.set(config.color); theme.red.color.set(config.color);
  theme.foundry.visible = mapId === 'foundry'; theme.voidStage.visible = mapId === 'void';
  for (const child of theme.procedural.children)
    if (child.name.startsWith('fallback:')) child.visible = child.name === `fallback:${mapId}`;
  theme.floor.material.color.set(mapId === 'void' ? 0x080d1c : 0x21171a);
  scene.background = new THREE.Color(mapId === 'void' ? 0x02040d : 0x0d080b);
  scene.fog = new THREE.FogExp2(mapId === 'void' ? 0x040817 : 0x16090c, .035);
  mapBoundsCenter = (config.bounds[0] + config.bounds[1]) / 2;
  const livePortraitMap = shouldUseLivePortraitArena(mapId, camera.aspect);
  const atmosphereSpec = fighterAtmosphereSpec(mapId);
  customMapStatic = false;
  renderer.shadowMap.enabled = true;
  const arenaFile = config.file;
  if (!arenaFile) {
    mapPlane = config.fightPlane ?? { origin: [0, config.floorY ?? 0, 0], rotationY: 0 };
    applyAtmosphereLighting(atmosphereSpec); applyActorTransforms(); applyCameraFraming(config);
    if (atmosphereSpec) mapAtmosphere = new FighterAtmosphere(atmosphereSpec, scene,
      new THREE.Vector3(...cameraBase.lookAt), new THREE.Vector3(...mapPlane.origin), THREE.MathUtils.degToRad(mapPlane.rotationY));
    theme.procedural.visible = true;
    mapReadyId = mapId; maybeSignalReady(); return;
  }
  // Show a themed local stage during loading, but let the selected authored arena
  // finish its bounded first attempt before the server starts the countdown.
  showProceduralMap(config, atmosphereSpec);
  if (preferProceduralFighterAssets(browserConnection())
    || state?.phase === 'fight' || state?.phase === 'victory' || state?.phase === 'results') {
    failedMapKey = loadKey;
    mapReadyId = mapId; maybeSignalReady();
    return;
  }
  const controller = new AbortController();
  mapLoadController = controller;
  const draco = new DRACOLoader(); draco.setDecoderPath('/draco/');
  const loader = new GLTFLoader(); loader.setDRACOLoader(draco);
  const fallbackTimer = setTimeout(() => {
    if (loadedMapId === mapId && attempt === mapLoadAttempt && !mapModel) {
      controller.abort(new Error(`arena timed out after ${FIGHTER_MAP_TIMEOUT_MS / 1000} seconds`));
      if (mapLoadController === controller) mapLoadController = null;
      handleMapLoadFailure(mapId, loadKey, new Error(`arena timed out after ${FIGHTER_MAP_TIMEOUT_MS / 1000} seconds`));
    }
  }, FIGHTER_MAP_TIMEOUT_MS);
  void (async () => {
    try {
      const response = await fetch(`/assets/fighters/maps/${encodeURIComponent(arenaFile)}?v=${FIGHTER_ASSET_VERSION}`,
        { signal: controller.signal });
      if (!response.ok) throw new Error(`arena request failed with HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (controller.signal.aborted) return;
      const gltf = await loader.parseAsync(buffer, '/assets/fighters/maps/');
      if (controller.signal.aborted || loadedMapId !== mapId || attempt !== mapLoadAttempt) {
        disposeObjectResources(gltf.scene); return;
      }
      if (!hasRenderableTriangle(gltf.scene)) {
        disposeObjectResources(gltf.scene);
        handleMapLoadFailure(mapId, loadKey, new Error('arena model has no renderable geometry'));
        return;
      }
      // Swapping a large decoded scene in the middle of combat causes an FPS spike and
      // moves the camera under the player's controls. Keep the local stage for this bout.
      if (state?.phase === 'fight' || state?.phase === 'victory' || state?.phase === 'results') {
        disposeObjectResources(gltf.scene); failedMapKey = loadKey; return;
      }
      usingProceduralFallback = false;
      theme.procedural.visible = false;
      mapPlane = config.fightPlane ?? { origin: [0, config.floorY ?? 0, 0], rotationY: 0 };
      applyAtmosphereLighting(atmosphereSpec); applyActorTransforms(); applyCameraFraming(config);
      if (mapAtmosphere) { mapAtmosphere.dispose(scene); mapAtmosphere = null; }
      if (atmosphereSpec) mapAtmosphere = new FighterAtmosphere(atmosphereSpec, scene,
        new THREE.Vector3(...cameraBase.lookAt), new THREE.Vector3(...mapPlane.origin), THREE.MathUtils.degToRad(mapPlane.rotationY));
      mapModel = gltf.scene;
      mapModel.position.set(...(config.pos ?? [0, 0, 0]));
      const rotation = config.rotDeg ?? [0, 0, 0]; mapModel.rotation.set(...rotation.map(value => THREE.MathUtils.degToRad(value)) as [number, number, number]);
      mapModel.scale.setScalar(config.scale ?? 1);
      // Environment geometry is static and often contains millions of triangles. It can receive fighter
      // shadows, but must not render into the shadow map itself every frame.
      mapModel.traverse(object => { if ((object as THREE.Mesh).isMesh) { (object as THREE.Mesh).receiveShadow = true; (object as THREE.Mesh).castShadow = false; } });
      scene.add(mapModel);
      if (livePortraitMap) { customMapStatic = false; renderer.shadowMap.enabled = true; }
      else try { captureMapBackdrop(); }
      catch (error) { console.warn('Unable to cache arena backdrop; using live rendering.', error); customMapStatic = false; renderer.shadowMap.enabled = true; }
      mapReadyId = mapId;
      failedMapKey = '';
      maybeSignalReady();
    } catch (error) {
      if (!controller.signal.aborted && loadedMapId === mapId && attempt === mapLoadAttempt)
        handleMapLoadFailure(mapId, loadKey, error);
    } finally {
      clearTimeout(fallbackTimer);
      draco.dispose();
      if (mapLoadController === controller) mapLoadController = null;
    }
  })();
}

function handleMapLoadFailure(mapId: string, _loadKey: string, error: unknown): void {
  console.warn(`Arena ${mapId} failed to load; using the procedural stage.`, error);
  mapLoadAttempt++;
  failedMapKey = _loadKey;
  mapReadyId = mapId; maybeSignalReady();
}

function showProceduralMap(config: FighterMapEntry, atmosphereSpec: FighterAtmosphereSpec | null): void {
  usingProceduralFallback = true;
  theme.procedural.visible = true; renderer.shadowMap.enabled = true; customMapStatic = false;
  mapPlane = { origin: [0, 0, 0], rotationY: 0 };
  applyProceduralFallbackFraming(config);
  applyActorTransforms();
  applyAtmosphereLighting(atmosphereSpec);
  if (atmosphereSpec) mapAtmosphere = new FighterAtmosphere(atmosphereSpec, scene,
    new THREE.Vector3(...cameraBase.lookAt), new THREE.Vector3(0, 0, 0), 0);
}

function disposeCurrentMap(): void {
  if (mapBackdrop) { if (scene.background === mapBackdrop.texture) scene.background = new THREE.Color(0x05060a); mapBackdrop.dispose(); mapBackdrop = null; }
  if (mapModel) { disposeObjectResources(mapModel); mapModel.removeFromParent(); mapModel = null; }
  if (mapAtmosphere) { mapAtmosphere.dispose(scene); mapAtmosphere = null; }
}

function applyAtmosphereLighting(spec: FighterAtmosphereSpec | null): void {
  const origin = new THREE.Vector3(...mapPlane.origin);
  theme.key.position.copy(origin).add(new THREE.Vector3(-4, 9, 6)); theme.key.target.position.copy(origin).add(new THREE.Vector3(0, 1, 0));
  theme.red.position.copy(origin).add(new THREE.Vector3(-5, 5, 1)); theme.red.target.position.copy(origin).add(new THREE.Vector3(-1, 1, 0));
  theme.cyan.position.copy(origin).add(new THREE.Vector3(5, 4, -1)); theme.cyan.target.position.copy(origin).add(new THREE.Vector3(1, 1, 0));
  theme.key.color.setHex(spec?.keyColor ?? 0xfff1e6); theme.key.intensity = spec?.keyIntensity ?? 4.4;
  theme.red.color.setHex(spec?.redColor ?? 0xef223a); theme.red.intensity = spec?.redIntensity ?? 70;
  theme.cyan.color.setHex(spec?.cyanColor ?? 0x2dd4bf); theme.cyan.intensity = spec?.cyanIntensity ?? 55;
  theme.ambient.color.setHex(spec?.skyColor ?? 0x9db7d4); theme.ambient.groundColor.setHex(spec?.groundColor ?? 0x11080d);
  theme.ambient.intensity = spec?.ambientIntensity ?? 1.5; renderer.toneMappingExposure = spec?.exposure ?? 1.12;
  if (spec) scene.fog = new THREE.FogExp2(spec.fogColor, spec.fogDensity);
}

function hasRenderableTriangle(root: THREE.Object3D): boolean {
  root.updateMatrixWorld(true);
  let renderable = false;
  root.traverse(object => {
    if (renderable) return;
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (let current: THREE.Object3D | null = mesh; current; current = current.parent) if (!current.visible) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    if (materials.length === 0 || materials.every(material => !material.visible)) return;
    const positions = mesh.geometry?.getAttribute('position');
    if (!positions || positions.count < 3) return;
    const index = mesh.geometry.getIndex();
    const elementCount = index?.count ?? positions.count;
    const start = Math.max(0, mesh.geometry.drawRange.start);
    const requested = mesh.geometry.drawRange.count;
    const end = Math.min(elementCount, Number.isFinite(requested) ? start + requested : elementCount);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3();
    for (let offset = start; offset + 2 < end; offset += 3) {
      const ai = index ? index.getX(offset) : offset;
      const bi = index ? index.getX(offset + 1) : offset + 1;
      const ci = index ? index.getX(offset + 2) : offset + 2;
      if (ai >= positions.count || bi >= positions.count || ci >= positions.count) continue;
      a.fromBufferAttribute(positions, ai).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(positions, bi).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(positions, ci).applyMatrix4(mesh.matrixWorld);
      if (ab.subVectors(b, a).cross(ac.subVectors(c, a)).lengthSq() > 1e-12) { renderable = true; break; }
    }
  });
  return renderable;
}

function disposeObjectResources(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh; mesh.geometry?.dispose();
    const values = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of values) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}

function maybeSignalReady(): void {
  if (fighterConnectionState !== 'connected' || !isHost || state?.phase !== 'loading' || !state.selectedMap || mapReadyId !== state.selectedMap) return;
  const p1Id = state.players.find(player => player.side === 'p1')?.fighterId;
  const p2Id = state.players.find(player => player.side === 'p2')?.fighterId;
  if (!p1Id || !p2Id || !loadedActors.has(p1Id) || !loadedActors.has(p2Id)) return;
  if (!actors || actorKey !== `${p1Id}:${p2Id}`
    || actors.p1 !== loadedActors.get(p1Id) || actors.p2 !== loadedActors.get(p2Id)) return;
  const readinessKey = `${state.loadingGeneration}:${state.selectedMap}`;
  if (readySentFor === readinessKey || readyTimer) return;
  const mapId = state.selectedMap;
  // Let the loading overlay paint and let any first-frame shader compilation block THIS timer. The
  // authoritative countdown begins only after the browser has actually become responsive.
  readyTimer = setTimeout(() => {
    readyTimer = null;
    if (fighterConnectionState !== 'connected' || !isHost || state?.phase !== 'loading' || state.selectedMap !== mapId
      || mapReadyId !== mapId || `${state.loadingGeneration}:${state.selectedMap}` !== readinessKey) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (fighterConnectionState !== 'connected' || !isHost || state?.phase !== 'loading' || state.selectedMap !== mapId || mapReadyId !== mapId || !actors
        || `${state.loadingGeneration}:${state.selectedMap}` !== readinessKey) return;
      readySentFor = readinessKey;
      stationDisplay.markEngineReady();
      connection.ready();
    }));
  }, 350);
}

/** Custom stages never move, so flatten millions of environment triangles into the authored camera
 * shot once. The live renderer then draws only the two animated fighters over this texture. */
function captureMapBackdrop(): void {
  if (!mapModel) return;
  const drawingSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  const scale = Math.min(1, 1920 / drawingSize.x, 1080 / drawingSize.y);
  mapBackdrop?.dispose();
  const backdropScale = scale;
  mapBackdrop = new THREE.WebGLRenderTarget(Math.max(1, Math.round(drawingSize.x * backdropScale)), Math.max(1, Math.round(drawingSize.y * backdropScale)), {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
  });
  const actorVisibility = actors ? [actors.p1.root.visible, actors.p2.root.visible] : null;
  if (actors) { actors.p1.root.visible = false; actors.p2.root.visible = false; }
  mapAtmosphere?.setEffectVisible(false);
  mapModel.visible = true;
  try { renderer.setRenderTarget(mapBackdrop); renderer.render(scene, camera); }
  finally {
    renderer.setRenderTarget(null);
    if (actors && actorVisibility) { actors.p1.root.visible = actorVisibility[0]!; actors.p2.root.visible = actorVisibility[1]!; }
    mapAtmosphere?.setEffectVisible(true);
  }
  const capturedModel = mapModel; capturedModel.visible = false; capturedModel.removeFromParent(); disposeObjectResources(capturedModel); mapModel = null;
  mapAtmosphere?.freezeStatic();
  scene.background = mapBackdrop.texture;
  customMapStatic = true;
  // The flattened backdrop cannot receive live shadows, so skip the animated shadow pass entirely.
  renderer.shadowMap.enabled = false;
}
function updateCameraProjection(): void {
  camera.fov = responsiveVerticalFov(cameraBase.fov, camera.aspect);
  camera.updateProjectionMatrix();
}
function applyCameraFraming(config: FighterMapEntry): void {
  const authoredCamera = config.camera
    ? { pos: config.camera.pos, lookAt: config.camera.lookAt, fov: config.camera.fov ?? 36 }
    : { pos: [0, 2.15, 10.5] as [number,number,number], lookAt: [0, 1.25, 0] as [number,number,number], fov: 36 };
  cameraBase = frameStaticPortraitArena(authoredCamera, config.bounds, mapPlane.origin, mapPlane.rotationY, camera.aspect);
  camera.position.set(...cameraBase.pos); updateCameraProjection(); camera.lookAt(...cameraBase.lookAt);
}
function applyProceduralFallbackFraming(config: FighterMapEntry | undefined): void {
  const bounds: [number, number] = config?.bounds ?? [-9, 9];
  mapBoundsCenter = (bounds[0] + bounds[1]) / 2;
  cameraBase = frameStaticPortraitArena(
    proceduralFallbackCamera(bounds),
    bounds, mapPlane.origin, mapPlane.rotationY, camera.aspect,
  );
  camera.position.set(...cameraBase.pos); updateCameraProjection(); camera.lookAt(...cameraBase.lookAt);
}
function commandLabel(command: FighterCommand): string { return t(COMMAND_MESSAGE_KEYS[command]); }
function localizedFighterTitle(fighter: FighterRosterEntry): string { const key = FIGHTER_TITLE_KEYS[fighter.id]; return key ? t(key) : fighter.title; }
function localizedFighterName(fighter: FighterRosterEntry): string { return translatedFighterName(locale, fighter.id, fighter.name); }
function localizedMapBlurb(map: FighterMapEntry): string { const key = MAP_BLURB_KEYS[map.id]; return key ? t(key) : map.blurb; }
function localizedMapName(map: FighterMapEntry | undefined): string { if (!map) return ''; const key = MAP_NAME_KEYS[map.id]; return key ? t(key) : map.name; }
function localizedServerError(code: string): string | null { const key = SERVER_ERROR_KEYS[code]; return key ? t(key) : null; }

function localizeStaticUi(): void {
  document.title = t('app.title');
  const loadingMark = document.querySelector<HTMLElement>('#loading .mark b'); if (loadingMark) loadingMark.textContent = t('app.initials');
  const loadingTitle = document.querySelector<HTMLElement>('#loading > span'); if (loadingTitle) loadingTitle.textContent = t('app.title');
  arena.setAttribute('aria-label', t('arena.aria'));
  connectionStatus.textContent = commonText('connection.connecting');
  const home = document.querySelector<HTMLAnchorElement>('.game-home');
  if (home) { home.setAttribute('aria-label', commonText('navigation.homeAria')); const label = home.querySelector('span'); if (label) label.textContent = commonText('navigation.home'); }
  p1PlayerName.textContent = t('hud.playerOne'); p2PlayerName.textContent = t('hud.cpuRival');
  p1Meter.setAttribute('aria-label', t('hud.playerOneHealth')); p2Meter.setAttribute('aria-label', t('hud.playerTwoHealth'));
  const round = document.querySelector('.round-hud');
  const roundLabel = round?.querySelector('span'), roundRule = round?.querySelector('small');
  if (roundLabel) roundLabel.textContent = t('hud.round'); if (roundRule) roundRule.textContent = t('hud.firstToKo');
  const feedLabel = voiceFeed.querySelector('span'); if (feedLabel) feedLabel.textContent = t('voiceFeed.channel');
  voiceCommand.textContent = t('voiceFeed.chooseMove');
  const deck = document.querySelector<HTMLElement>('.command-deck'); deck?.setAttribute('aria-label', t('commands.aria'));
  const deckTitle = deck?.querySelector('.deck-title');
  const deckLabel = deckTitle?.querySelector('span'), deckHint = deckTitle?.querySelector('small');
  if (deckLabel) deckLabel.textContent = t('commands.say'); if (deckHint) deckHint.textContent = t(isDisplay?'commands.phoneHint':'commands.keyboardHint');
  for (const button of commandButtons) {
    const label = button.querySelector('b'), command = button.dataset.command as FighterCommand;
    if (label) label.textContent = commandLabel(command);
  }
  fightCall.textContent = t('fight.call');
  $('result-kicker').textContent = t('result.knockout'); resultTitle.textContent = t('result.wins', { name: t('hud.playerOne') });
  rematch.textContent = t('result.rematch'); resultExit.textContent = t('result.exit');
  resultStationNext.textContent = t('result.stationNext');
  syncResultActions();
  loadingLabel.textContent = t('loading.combatSystem'); loadingFill.parentElement?.setAttribute('aria-label', t('loading.combatSystem'));
  const music = document.querySelector<HTMLButtonElement>('#music-toggle');
  const localizeMusic = () => {
    if (!music) return;
    music.title = commonText('music.toggleTitle'); music.setAttribute('aria-label', commonText('music.toggleAria'));
    const label = music.querySelector('.music-toggle-label'); if (label) label.textContent = commonText(music.getAttribute('aria-pressed') === 'true' ? 'music.on' : 'music.off');
  };
  localizeMusic(); music?.addEventListener('click', localizeMusic);
}
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!); }

function buildArena(): { ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; floor: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>; key: THREE.DirectionalLight; red: THREE.SpotLight; cyan: THREE.SpotLight; ambient: THREE.HemisphereLight; procedural: THREE.Group; foundry: THREE.Group; voidStage: THREE.Group } {
  const procedural = new THREE.Group(); scene.add(procedural);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(13, 8), new THREE.MeshStandardMaterial({ color: 0x171922, roughness: .72, metalness: .16 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const ring = new THREE.Mesh(new THREE.RingGeometry(10.2, 10.3, 8), new THREE.MeshBasicMaterial({ color: 0xef223a, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = .006; procedural.add(floor, ring);
  const grid = new THREE.GridHelper(25, 50, 0x3a1721, 0x141721); grid.position.y = .012; procedural.add(grid);
  const geometry = new THREE.BoxGeometry(.24, 4.8, .24), material = new THREE.MeshStandardMaterial({ color: 0x161923, metalness: .7, roughness: .35 });
  for (let i = -6; i <= 6; i++) { const pillar = new THREE.Mesh(geometry, material); pillar.position.set(i * 1.25, 2.3, -3.5 - Math.abs(i) * .08); pillar.rotation.z = i * .02; procedural.add(pillar); }
  const foundry = new THREE.Group(), voidStage = new THREE.Group(); procedural.add(foundry, voidStage); voidStage.visible = false;
  const steel = new THREE.MeshStandardMaterial({ color: 0x252a31, metalness: .9, roughness: .28 });
  const furnace = new THREE.MeshStandardMaterial({ color: 0x3a1014, emissive: 0xef223a, emissiveIntensity: 3.2, metalness: .4, roughness: .35 });
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(.55, .72, 3.5, 12), steel); tower.position.set(side * (5.5 + i * 1.35), 1.75, -2.5); foundry.add(tower);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(.34, .34, 2.1, 12), furnace); core.position.copy(tower.position); foundry.add(core);
  }
  for (let i = -4; i <= 4; i++) { const beam = new THREE.Mesh(new THREE.BoxGeometry(.16, .16, 8), steel); beam.position.set(i * 2.1, 4.3, -1.5); beam.rotation.z = i * .025; foundry.add(beam); }
  for (const z of [-1.6, 0, 1.6]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(18, .025, .08), furnace); strip.position.set(0, .035, z); foundry.add(strip);
  }
  const reactor = new THREE.Mesh(new THREE.TorusGeometry(2.2, .2, 12, 64), furnace); reactor.position.set(0, 2.5, -4.2); foundry.add(reactor);
  const reactorCore = new THREE.Mesh(new THREE.CircleGeometry(1.55, 48), new THREE.MeshBasicMaterial({ color: 0xff6b35, transparent: true, opacity: .75, side: THREE.DoubleSide })); reactorCore.position.set(0, 2.5, -4.18); foundry.add(reactorCore);
  const foundryLight = new THREE.PointLight(0xff3b1f, 55, 18, 1.7); foundryLight.position.set(0, 3.2, -1); foundry.add(foundryLight);
  const voidMetal = new THREE.MeshStandardMaterial({ color: 0x10172b, emissive: 0x163a55, emissiveIntensity: 1.2, metalness: .85, roughness: .22 });
  const holo = new THREE.MeshBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: .7, side: THREE.DoubleSide });
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
    const monolith = new THREE.Mesh(new THREE.BoxGeometry(.6, 3.5 + i * .4, .8), voidMetal); monolith.position.set(side * (4.6 + i * 1.55), 1.8 + i * .2, -2.8); monolith.rotation.z = side * .08; voidStage.add(monolith);
  }
  for (const radius of [4.2, 6.2, 8.2]) { const halo = new THREE.Mesh(new THREE.TorusGeometry(radius, .025, 6, 96), holo); halo.rotation.x = Math.PI / 2; halo.position.y = .03; voidStage.add(halo); }
  const starGeometry = new THREE.BufferGeometry(), starPositions = new Float32Array(900);
  for (let i = 0; i < starPositions.length; i += 3) { starPositions[i] = (Math.random() - .5) * 35; starPositions[i + 1] = Math.random() * 14 + 2; starPositions[i + 2] = -4 - Math.random() * 12; }
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  voidStage.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0xbcecff, size: .055, transparent: true, opacity: .85 })));
  // Small themed stages are bundled as geometry so a slow or missing GLB never leaves a
  // generic empty ring. Shared shapes/materials keep the fallback cheap to draw.
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const city = new THREE.Group(); city.name = 'fallback:cyberpunk-city'; city.visible = false; procedural.add(city);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x101025, roughness: .8 });
  const cityNeon = new THREE.MeshBasicMaterial({ color: 0xff35d1 });
  const cityBlue = new THREE.MeshBasicMaterial({ color: 0x40d8ff });
  for (let index = -5; index <= 5; index++) {
    const height = 3.3 + Math.abs(index * 7 % 5) * .58;
    const building = new THREE.Mesh(cube, concrete); building.scale.set(1.45, height, 1.2);
    building.position.set(index * 2.3, height / 2, -7.5); city.add(building);
    for (let row = 1; row < 4; row++) {
      const light = new THREE.Mesh(cube, row % 2 ? cityNeon : cityBlue);
      light.scale.set(.85, .045, .015); light.position.set(index * 2.3, row * .8 + .55, -6.88);
      city.add(light);
    }
  }
  const cityLane = new THREE.Mesh(cube, cityBlue); cityLane.scale.set(20, .014, .04); cityLane.position.set(0, .04, 2.8); city.add(cityLane);
  const restaurant = new THREE.Group(); restaurant.name = 'fallback:inakaya'; restaurant.visible = false; procedural.add(restaurant);
  const wood = new THREE.MeshStandardMaterial({ color: 0x40271d, roughness: .9 });
  const paper = new THREE.MeshStandardMaterial({ color: 0xe7cba5, roughness: 1, side: THREE.DoubleSide });
  const lantern = new THREE.MeshBasicMaterial({ color: 0xffba63 });
  for (let index = -5; index <= 5; index++) {
    const mat = new THREE.Mesh(cube, index % 2 ? paper : wood);
    mat.scale.set(1.8, .025, 3.1); mat.position.set(index * 1.9, .018, -.1); restaurant.add(mat);
  }
  for (let index = -4; index <= 4; index++) {
    const panel = new THREE.Mesh(cube, paper); panel.scale.set(1.5, 2.8, .08);
    panel.position.set(index * 1.9, 1.7, -5.4); restaurant.add(panel);
    const post = new THREE.Mesh(cube, wood); post.scale.set(.14, 3.7, .22);
    post.position.set(index * 1.9 + .9, 1.85, -5.3); restaurant.add(post);
  }
  for (const x of [-4.6, 0, 4.6]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(.28, 8, 6), lantern);
    lamp.position.set(x, 3.55, -4.5); restaurant.add(lamp);
  }
  const rainStage = new THREE.Group(); rainStage.name = 'fallback:rain'; rainStage.visible = false; procedural.add(rainStage);
  const wetStone = new THREE.MeshStandardMaterial({ color: 0x172b37, metalness: .34, roughness: .36 });
  const rainBlue = new THREE.MeshBasicMaterial({ color: 0x76d5ff, transparent: true, opacity: .78 });
  for (let index = -5; index <= 5; index++) {
    const slab = new THREE.Mesh(cube, wetStone); slab.scale.set(1.8, .06, 4.2);
    slab.position.set(index * 1.9, .03, 0); rainStage.add(slab);
  }
  for (const side of [-1, 1]) for (let index = 0; index < 4; index++) {
    const pylon = new THREE.Mesh(cube, wetStone); pylon.scale.set(.48, 2.5, .48);
    pylon.position.set(side * (5 + index * 1.7), 1.25, -3.6); rainStage.add(pylon);
    const glow = new THREE.Mesh(cube, rainBlue); glow.scale.set(.15, 1.65, .5);
    glow.position.set(pylon.position.x, 1.4, -3.33); rainStage.add(glow);
  }
  const key = new THREE.DirectionalLight(0xfff1e6, 4.4); key.position.set(-1, 7, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -6; key.shadow.camera.right = 6; key.shadow.camera.top = 5; key.shadow.camera.bottom = -1;
  const red = new THREE.SpotLight(0xef223a, 70, 14, .62, .8); red.position.set(-5, 5, 1); red.target.position.set(-1, 0, 0);
  const cyan = new THREE.SpotLight(0x2dd4bf, 55, 14, .62, .8); cyan.position.set(5, 4, -1); cyan.target.position.set(1, 0, 0);
  const ambient = new THREE.HemisphereLight(0x9db7d4, 0x11080d, 1.5);
  scene.add(key, key.target, red, red.target, cyan, cyan.target, ambient); return { ring, floor, key, red, cyan, ambient, procedural, foundry, voidStage };
}

const keyCommands: Record<string, FighterCommand> = { a: 'back', d: 'forward', w: 'jump', ' ': 'jump', j: 'punch', k: 'kick', l: 'block' };
addEventListener('keydown', event => {
  if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || isInteractiveShortcutTarget(event.target)) return;
  const key = event.key.toLowerCase(), command = keyCommands[key]; let handled = false;
  if (state?.phase === 'fight' && command) { if (playerId) (keyboardPlayerConn ?? connection).command(command); handled = true; }
  else if (key === 'p') { toggleLocalPlayer(); handled = true; }
  else if (key === 'enter' && isHost && fighterConnectionState === 'connected'
    && (state?.phase !== 'results' || fighterResultActionState(stationDisplay.active, isHost, fighterConnectionState, state?.phase) === 'rematch')) {
    advanceMenu(); handled = true;
  }
  else if (key === 'backspace' && isHost) { backMenu(); handled = true; }
  else if (/^\d$/.test(key) && (state?.phase === 'fighter_select' || state?.phase === 'map_select')) { handleNumericSelection(key); handled = true; }
  if (handled) event.preventDefault();
});
function handleNumericSelection(key: string): void {
  const entries = state?.phase === 'fighter_select' ? roster : maps;
  const next = resolveNumericSelection(numericBuffer, key, entries.length); numericBuffer = next.buffer;
  if (numericTimer) clearTimeout(numericTimer);
  const select = (number: number) => {
    const id = entries[number - 1]?.id; if (!id) return;
    if(isHost&&state){
      const target=activeTouchPlayer(state);if(!target)return;
      if(state.phase==='fighter_select'){
        if(target.playerId===playerId&&keyboardPlayerConn)keyboardPlayerConn.selectFighter(id);
        else connection.displaySelectFighter(target.playerId,id);
      }else if(state.phase==='map_select'){
        if(target.playerId===playerId&&keyboardPlayerConn)keyboardPlayerConn.selectMap(id);
        else connection.displaySelectMap(target.playerId,id);
      }
    }else if(state?.phase==='fighter_select'&&playerId)(keyboardPlayerConn??connection).selectFighter(id);
    else if(state?.phase==='map_select'&&playerId)(keyboardPlayerConn??connection).selectMap(id);
  };
  if (next.selection) select(next.selection);
  else if (next.waiting) numericTimer = setTimeout(() => {
    const value = Number(numericBuffer); numericBuffer = ''; numericTimer = null;
    if (value >= 1 && value <= entries.length) select(value);
  }, 450);
}
addEventListener('resize', () => {
  const size = arenaSize();
  camera.aspect = size.width / size.height; renderer.setSize(size.width, size.height);
  const config = maps.find(map => map.id === loadedMapId);
  if (usingProceduralFallback) { applyProceduralFallbackFraming(config); return; }
  if (config && !customMapStatic) applyCameraFraming(config);
  else updateCameraProjection();
});
rematch.addEventListener('click', () => {
  if (fighterResultActionState(stationDisplay.active, isHost, fighterConnectionState, state?.phase) === 'rematch') advanceMenu();
});
for (const link of document.querySelectorAll<HTMLAnchorElement>('.game-home, #result a[href="/"]')) {
  link.addEventListener('click', event => {
    if (stationDisplay.active) { event.preventDefault(); return; }
    event.preventDefault(); releaseKeyboardPlayer();
    connection.leaveAndClose(roomCode); setTimeout(() => { location.href = '/'; }, 60);
  });
}

function render(now: number): void {
  requestAnimationFrame(render); const delta = Math.min((now - lastTime) / 1000, .05); lastTime = now;
  mapAtmosphere?.update(delta); updateMovement(delta); if (actors) {
    actors.p1.update(delta); actors.p2.update(delta);
    if (state?.phase === 'intro') {
      updateIntroPresentation(state);
      const mapVisible = mapModel?.visible;
      if (mapModel) mapModel.visible = false;
      try { renderer.render(scene, camera); }
      finally { if (mapModel && mapVisible !== undefined) mapModel.visible = mapVisible; }
      return;
    }
    if (customMapStatic) { renderer.render(scene, camera); return; }
    const midpoint = (displayX.p1 + displayX.p2) / 2, separation = Math.abs(displayX.p1 - displayX.p2);
    const angle = THREE.MathUtils.degToRad(mapPlane.rotationY); cameraAxis.set(Math.cos(angle), 0, -Math.sin(angle));
    cameraTarget.set(...cameraBase.lookAt).addScaledVector(cameraAxis, midpoint - mapBoundsCenter);
    cameraView.set(cameraBase.pos[0] - cameraBase.lookAt[0], cameraBase.pos[1] - cameraBase.lookAt[1], cameraBase.pos[2] - cameraBase.lookAt[2]);
    const baseDistance = cameraView.length(), targetDistance = Math.max(baseDistance, Math.min(baseDistance + 9, baseDistance - 2 + separation * .72));
    cameraDesired.copy(cameraTarget).add(cameraView.normalize().multiplyScalar(targetDistance));
    camera.position.lerp(cameraDesired, Math.min(1, delta * 3)); camera.lookAt(cameraTarget);
  }
  renderer.render(scene, camera);
}
void initialize(); requestAnimationFrame(render);
