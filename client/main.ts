import { GameConnection } from './net';
import { KeyboardAdapter } from './input-keyboard';
import { Renderer } from './renderer';
import { InterpolationBuffer, RACER_INTERPOLATION_DELAY_MS } from './interpolation';
import { countdownDisplay, isCountdownSoundCue } from '../shared/countdown';
import { AssetLoader } from './asset-loader';
import { Screens } from './screens';
import { RacerResultBoardLoader, fetchRacerLeaderboardEntries } from './racer-result-board-loader';
import { renderCarThumbnailsAsync, renderMapThumbnail, renderBoostThumbnailAsync } from './thumbnails';
import { AttractMode } from './attract';
import { Announcer } from './announcer';
import QRCode from 'qrcode';
import { fetchMaps, loadMapWorld, disposeMapWorld, applyTrackTransform, CANONICAL_TRACK } from './map-world';
import { CurvedTrack } from './track-path';
import { surfaceOptsFromPath } from './track-surface';
import { mergeLevel, resolveCarScale, resolveItemScale, resolveCamera } from '../shared/level';
import type { GantryOffset } from '../shared/level';
import { hudStateFor } from './hud-state';
import { BOOST_MAX, BOOST_MIN, DEFAULT_ROOM } from '../shared/constants';
import { getMusicManager } from './music-manager';
import { injectMusicToggle } from './music-toggle';
import { injectFullscreenToggle } from './fullscreen-toggle';
import { getSoundEffectsManager } from './sound-effects';
import { commonText, locale } from './i18n';
import { RACER_MESSAGES, type RacerMessageKey } from '../shared/i18n/racer';
import { createTranslator } from '../shared/i18n/translate';
import { carName as localizedCarName } from '../shared/i18n/content';
import { createStationDisplay } from './station-display';
import { resolveStationQrImage, stationJoinUrl, stationQrAsset, watchVoiceNumber } from './station-client';

const text = createTranslator(locale, RACER_MESSAGES);

function setText(id: string, key: RacerMessageKey): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text(key);
}

function localizeStaticPage(): void {
  document.title = text('game.title');
  document.querySelector('.game-home')?.setAttribute('aria-label', commonText('navigation.homeAria'));
  const homeLabel = document.querySelector('.game-home > span');
  if (homeLabel) homeLabel.textContent = commonText('navigation.home');
  setText('veil-title', 'game.title');
  setText('hud-title', 'game.title');
  setText('hint-shout', 'hud.shout');
  setText('hint-left', 'hud.command.left');
  setText('hint-right', 'hud.command.right');
  setText('hint-boost', 'hud.command.boost');
  setText('hint-brake', 'hud.command.brake');
  setText('hint-nitro', 'hud.command.nitro');
  setText('gPowerLabel', 'hud.power.readyInitial');
  document.getElementById('split-role-1')!.textContent = text('hud.player', { number: 1 });
  document.getElementById('split-role-2')!.textContent = text('hud.player', { number: 2 });
  document.getElementById('gBoost')?.setAttribute('title', text('hud.boostBrakeTitle'));
}

localizeStaticPage();
const stationDisplay = createStationDisplay();
// Game WebSocket URL. Production is same-origin; local Vite proxies /game to GAME_SERVER_URL.
// An explicit ?ws= override still wins for edge setups.
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const pageParams = new URLSearchParams(location.search);
const isDisplay = pageParams.get('display') === '1';
const wsOverride = pageParams.get('ws');
const url = wsOverride ?? `${wsProto}://${location.host}/game${isDisplay?'?display=1':''}`;
const conn = new GameConnection(url, locale);
const input = new KeyboardAdapter();
const assets = new AssetLoader();
const renderer = new Renderer(document.getElementById('app')!, assets);
// Dev-only: expose the renderer for in-browser debugging / headless smoke introspection.
// Guarded to localhost so it never leaks onto a deployed display.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  (window as unknown as { __renderer?: unknown }).__renderer = renderer;
}
// At 30 snapshots/second, 100ms normally keeps about three samples available for smooth movement
// while avoiding the extra fixed latency of the previous 150ms buffer.
const buffer = new InterpolationBuffer(RACER_INTERPOLATION_DELAY_MS);
const big = document.getElementById('big')!;
const lobbyEl = document.getElementById('lobby')!;
const splitLabelsEl = document.getElementById('split-labels')!;
const splitNameEls = [document.getElementById('split-name-1')!, document.getElementById('split-name-2')!];

function paintSplitLabels(snap: import('../shared/types').WorldSnapshot | null): void {
  const show = snap?.cars.length === 2;
  splitLabelsEl.hidden = !show;
  if (!show || !snap) return;
  snap.cars.forEach((car, index) => {
    splitNameEls[index]!.textContent = car.name;
    splitNameEls[index]!.parentElement!.style.setProperty('--player-color', car.color);
  });
}

// Inject music toggle button
injectMusicToggle('music-toggle-container');
injectFullscreenToggle('music-toggle-container', {
  enter: commonText('fullscreen.enter'), exit: commonText('fullscreen.exit'),
});
const musicToggle = document.getElementById('music-toggle');
function localizeMusicToggle(): void {
  if (!musicToggle) return;
  musicToggle.title = commonText('music.toggleTitle');
  musicToggle.setAttribute('aria-label', commonText('music.toggleAria'));
  const label = musicToggle.querySelector<HTMLElement>('.music-toggle-label');
  if (label) label.textContent = commonText(musicToggle.getAttribute('aria-pressed') === 'true' ? 'music.on' : 'music.off');
}
localizeMusicToggle();
musicToggle?.addEventListener('click', localizeMusicToggle);

// ── Personal in-race gauge (power charge + boost/brake bar) ──────────────────────────────────────
// Painted each frame from the LOCAL player's car (hud-state.ts decides show/hide). On a shared
// spectator display there's no local car → hudStateFor returns {show:false} → the gauge stays hidden,
// so it's never an ambiguous "whose power?" distraction with several phone players watching.
const gaugeEl = document.getElementById('gauge')!;
const gPowerEl = document.getElementById('gPower')!;
const gPowerLabel = document.getElementById('gPowerLabel')!;
const gOrbEl = document.getElementById('gOrb') as HTMLElement;
const gBoostEl = document.getElementById('gBoost')!;
const gBoostFill = document.getElementById('gBoostFill') as HTMLElement;
/** Paint the rendered boost-orb model into the gauge's power chip (called once the thumbnail lands).
 *  Until then the chip has no icon and the label alone carries the meaning. */
function setOrbThumb(url: string): void {
  gOrbEl.style.backgroundImage = `url("${url}")`;
  gOrbEl.classList.add('has-orb');
}
function paintGauge(snap: import('../shared/types').WorldSnapshot | null): void {
  const h = hudStateFor(snap, renderer.myPlayerId());
  gaugeEl.classList.toggle('show', h.show);
  if (!h.show) return;
  // Power chip: READY (gold, armed) → ACTIVE (cyan, firing) → spent ("grab a pad"). The icon is the
  // real orb model (setOrbThumb), so the label doesn't need to describe it.
  gPowerEl.classList.toggle('ready', !!h.powerReady);
  gPowerEl.classList.toggle('active', !!h.powerActive);
  // ACTIVE = the invulnerable dash is firing ("SMASH!"); READY = one or more banked charges (show the
  // count + prompt to say "power"); else empty → go grab an orb.
  const charges = h.charges ?? 0;
  gPowerLabel.textContent = h.powerActive
    ? text('hud.power.active')
    : h.powerReady
      ? text('hud.power.ready', { charges })
      : text('hud.power.empty');
  // Boost bar: fill from center — right/green when boosting, left/red when braking. Normalize the
  // boost modifier against its sim bounds so the bar caps out exactly when the sim does.
  const b = h.boost ?? 0;
  const braking = b < 0;
  const frac = Math.min(1, Math.abs(b) / (braking ? Math.abs(BOOST_MIN) : BOOST_MAX));
  gBoostEl.classList.toggle('braking', braking);
  gBoostFill.style.width = `${(frac * 50).toFixed(1)}%`;   // half-width max (fills its side of center)
  gBoostFill.style.left = braking ? `${(50 - frac * 50).toFixed(1)}%` : '50%';
  if (h.stunned) { gaugeEl.classList.remove('stun'); void gaugeEl.offsetWidth; gaugeEl.classList.add('stun'); }
}
lobbyEl.style.display = 'none';   // legacy overlay retired; the Screens overlay handles pre/post-race
// SSB-style front-end (lobby → car grid → map select → results). Host actions go back to the server.
const screens = new Screens(document.getElementById('app')!, {
  // Shared displays may act for the current caller seat; a standalone player connection may only
  // act for itself. Sending display_* from a player gets rejected as bad_display_auth.
  onAdvance: (room, phase, playerId) => isDisplay
    ? conn.displayAdvance(room, phase, playerId) : conn.advance(),
  onBack: (room, phase) => isDisplay ? conn.displayBack(room, phase) : conn.back(),
  onSelectCar: (room, playerId, index) => isDisplay
    ? conn.displaySelectCar(room, playerId, index) : conn.selectCar(index),
  onSelectMap: (room, playerId, map) => isDisplay
    ? conn.displaySelectMap(room, playerId, map) : conn.selectMap(map),
}, locale, stationDisplay.active);

const roomCode = new URLSearchParams(location.search).get('room') ?? DEFAULT_ROOM;
const name = new URLSearchParams(location.search).get('name') ?? text('player.you');
const urlMap = new URLSearchParams(location.search).get('map');   // legacy/manual override (?map=)
// Garage / car viewer: ?garage=1 shows one car at a time (← → to cycle models) at its real
// per-level size, so you can inspect/test cars without starting a race. No server needed.
const isGarage = new URLSearchParams(location.search).get('garage') === '1';

let started = false;
let raceLive = false;
let countdownSoundPlayed = false;  // Track if countdown sound has been played this race
let lastLobbyPlayerCount = 0;     // Track player count to detect new joins
// Shared screen only: whether the operator has opted IN to also play on this keyboard (P toggle).
// Default false = pure spectator display.
let displayIsPlaying = false;
// Current pre-race phase + map choices, tracked from server messages so number-key input knows
// whether a typed digit means "pick car N" or "pick map N".
let flowPhase: 'lobby' | 'car_select' | 'map_select' | 'results' | 'other' = 'lobby';
let flowMaps: string[] = [];
let typedDigits = '';
let typedPhase: 'car_select' | 'map_select' | null = null;   // the phase when accumulation STARTED
let typedTimer: ReturnType<typeof setTimeout> | null = null;

/** Keyboard digit input → select_car / select_map by number (stands in for SMS car/map picks).
 *  Multi-digit aware (e.g. "15"): accumulates briefly, then commits on a short pause. The pick is
 *  bound to the phase that was active when typing started — so a digit typed during car_select can't
 *  misfire as a map pick if the phase flips before the 450ms commit. */
function bindFlowDigits(): void {
  addEventListener('keydown', (e) => {
    if (flowPhase !== 'car_select' && flowPhase !== 'map_select') return;
    if (!/^[0-9]$/.test(e.key)) return;
    if (typedPhase !== flowPhase) { typedDigits = ''; typedPhase = flowPhase; }   // phase changed → reset
    typedDigits += e.key;
    if (typedTimer) clearTimeout(typedTimer);
    typedTimer = setTimeout(commitTypedDigits, 450);
  });
}
function commitTypedDigits(): void {
  const n = parseInt(typedDigits, 10); const phase = typedPhase;
  typedDigits = ''; typedPhase = null;
  if (!Number.isFinite(n) || n < 1) return;
  if (phase !== flowPhase) return;                                // phase moved on — drop the stale pick
  if (phase === 'car_select') screens.selectCar(n - 1);             // tiles are 1-based on screen
  else if (phase === 'map_select') { const m = flowMaps[n - 1]; if (m) screens.selectMap(m); }
}

// Visual commentary ticker only. Browser speechSynthesis sounded robotic on the shared display;
// caller audio remains owned by Conversation Relay.
const tickerEl = document.getElementById('ticker')!;
function pushLine(text: string) {
  const div = document.createElement('div');
  div.textContent = text;
  div.style.cssText = 'background:rgba(16,22,40,.85);color:#e8ecf6;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;font-size:13px';
  tickerEl.prepend(div);
  while (tickerEl.children.length > 5) tickerEl.lastChild!.remove();
  setTimeout(() => div.remove(), 6000);
}
const announcer = new Announcer({ sink: null, onLine: pushLine, locale });

const resultBoardLoader = new RacerResultBoardLoader(fetchRacerLeaderboardEntries);
function leaveResults(): void {
  if (flowPhase === 'results') resultBoardLoader.clear();
}

// Boot veil: an opaque branded cover over the 3D scene ASSEMBLING (map load → camera settle → first
// attract frames), so the user never sees the connecting→world→top-down→cars cut sequence. We lift
// it only after attract has painted a few stable frames (scene + camera settled), with a safety
// timeout so it can never hang. Once lifted it stays gone.
const veilEl = document.getElementById('veil')!;
let veilLifted = false;
let assetsReady = false;    // optional manifest + backdrop map applied (set by loadAssetsInBackground)
let stationEngineStateReady = false;
let raceSceneReady = !stationDisplay.active;
function maybeMarkStationReady(): void {
  if (raceSceneReady && stationEngineStateReady) stationDisplay.markEngineReady();
}
let wantAttract = false;    // a menu screen wants the demo running
let attractFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let attractFrames = 0;
function liftVeil() { if (veilLifted) return; veilLifted = true; veilEl.classList.add('hide'); }
setTimeout(liftVeil, 8000);   // safety: never trap the user behind the veil

// Attract mode: live autopilot gameplay behind the glass menu. Runs whenever a menu screen is up
// and no real race is live; the renderer's spectator/field camera frames the AI pack automatically.
// Lift the veil only after attract has painted a few settled frames. On a slow connection, the
// procedural cars and track are a complete scene; optional models can arrive later.
const attract = new AttractMode((snap) => {
  renderer.render(snap);
  paintSplitLabels(null);
  // Keep the veil up through the renderer's stuttery warmup (shader compile, shadow-map init, first
  // dt spikes). ~30 smooth frames behind the veil → the reveal is a steady scene, not the jank.
  if (!veilLifted && ++attractFrames >= 30) liftVeil();
});
function startAttract() {
  if (stationDisplay.active && raceLive) return;
  wantAttract = true;
  if (assetsReady) { reallyStartAttract(); return; }
  if (!attractFallbackTimer) attractFallbackTimer = setTimeout(() => {
    attractFallbackTimer = null;
    if (wantAttract && !raceLive) reallyStartAttract();
  }, 1_200);
}
function reallyStartAttract() {
  if (raceLive || attract.isRunning) return;
  renderer.clearCars();          // drop any leftover real-race cars before the demo populates its own
  renderer.setSpectator(true);   // the demo has no "my car" → use the pack/field camera
  attract.start();
}
function stopAttract() {
  wantAttract = false;
  if (attractFallbackTimer) { clearTimeout(attractFallbackTimer); attractFallbackTimer = null; }
  if (attract.isRunning) { attract.stop(); renderer.clearCars(); }   // remove the demo cars so they
                                                                     // don't sit frozen during the race
  renderer.setSpectator(isDisplay);   // back to the player's chase cam (or stay spectator on a display)
}

let racePreparationGeneration = 0;
let raceAssetPrioritized = false;
let latestRaceSnapshot: import('../shared/types').WorldSnapshot | null = null;
let resolveRaceSnapshot: ((snapshot: import('../shared/types').WorldSnapshot) => void) | null = null;
let cancelRaceSnapshot: (() => void) | null = null;
function cancelPendingRaceSnapshot(): void {
  cancelRaceSnapshot?.();
  cancelRaceSnapshot = null;
  resolveRaceSnapshot = null;
}
conn.onItems((items, map) => {
  leaveResults();
  cancelPendingRaceSnapshot();
  activeMapPreviewController?.abort();
  activeMapPreviewController = null;
  const generation = ++racePreparationGeneration;
  raceAssetPrioritized = false;
  if (!stationDisplay.active) {
    buffer.clear(); raceLive = true; stopAttract();
    renderer.buildItems(items);
    void loadRaceLevelWithinBudget(map ?? urlMap, generation).then(applied => {
      if (applied && generation === racePreparationGeneration && raceLive) renderer.buildItems(items);
    });
    return;
  }
  raceSceneReady = false; raceLive = true; latestRaceSnapshot = null; buffer.clear(); stopAttract();
  veilLifted = false; veilEl.classList.remove('hide');
  void prepareRaceScene(items, map ?? urlMap, generation);
});
conn.onSnapshot((s) => {
  leaveResults();
  stationEngineStateReady = true; maybeMarkStationReady();
  if (!raceAssetPrioritized) {
    assets.prioritizeCarIndexes(s.cars.map(car => car.carIndex));
    raceAssetPrioritized = true;
  }
  latestRaceSnapshot = s;
  if (resolveRaceSnapshot) {
    const resolve = resolveRaceSnapshot;
    resolveRaceSnapshot = null; cancelRaceSnapshot = null; resolve(s);
  }
  raceLive = true; flowPhase = 'other';
  if (s.phase === 'racing' && !started) {
    getMusicManager().switchContext('racer');
  }
  started = true;
  if (raceSceneReady) buffer.push(s, performance.now());
  // The moment the game STARTS (countdown or racing), drop the menu overlay entirely so the 3-2-1
  // plays full-screen and unobstructed. The controls legend lives in the LOBBY (pre-start) only —
  // by the time the countdown runs, players have already read it; covering the countdown with it
  // was wrong. The big number is painted from the snapshot in the frame loop.
  if (raceSceneReady) { screens.hide(); if (s.phase !== 'countdown') big.textContent = ''; }
});
conn.onLobby((m) => {
  leaveResults();
  stationEngineStateReady = true; maybeMarkStationReady();
  if (raceLive) {
    racePreparationGeneration += 1; cancelPendingRaceSnapshot(); latestRaceSnapshot = null; buffer.clear(); raceLive = false;
    invalidateLevelLoad();
    liftVeil();
  }
  flowPhase = 'lobby'; big.textContent = '';
  getMusicManager().switchContext('lobby');
  // Play select sound when a new player joins
  if (m.players.length > lastLobbyPlayerCount && lastLobbyPlayerCount > 0) {
    getSoundEffectsManager().playSelect();
  }
  lastLobbyPlayerCount = m.players.length;
  screens.setMenuTouch(m.roomCode, m.touch);
  screens.renderLobby(m.roomCode, m.players); startAttract();
});
conn.onSelectState((m) => {
  leaveResults();
  stationEngineStateReady = true; maybeMarkStationReady();
  assets.prioritizeCarIndexes(m.players.flatMap(player => player.carIndex === null ? [] : [player.carIndex]));
  if (raceLive) {
    racePreparationGeneration += 1; cancelPendingRaceSnapshot(); latestRaceSnapshot = null; buffer.clear();
    invalidateLevelLoad();
    liftVeil();
  }
  raceLive = false; big.textContent = '';
  screens.setMenuTouch(m.roomCode, m.touch);
  if (m.phase === 'car_select') { flowPhase = 'car_select'; screens.renderCarSelect(m.players); }
  else if (m.phase === 'map_select') { flowPhase = 'map_select'; flowMaps = m.maps; screens.renderMapSelect(m.maps, m.selectedMap, m.players, { counts: m.mapVotes ?? {}, tie: m.mapTie ?? false }); }
  startAttract();
});
conn.onResults((m) => {
  racePreparationGeneration += 1; cancelPendingRaceSnapshot();
  if (raceLive) invalidateLevelLoad();
  stationDisplay.markEngineResultsReady();
  stationEngineStateReady = true; maybeMarkStationReady();
  raceLive = false; raceSceneReady = !stationDisplay.active; flowPhase = 'results'; big.textContent = '';
  getMusicManager().switchContext('leaderboard');
  startAttract();
  // A race's standings and room identify its result. Broadcasts for that result share one request;
  // a later round on the same map starts fresh after the intervening lobby/race clears the loader.
  const resultKey = JSON.stringify([m.roomCode, m.map, m.results]);
  screens.setMenuTouch(m.roomCode, m.touch);
  const board = resultBoardLoader.show(resultKey, m.map, loaded => {
    if (flowPhase === 'results') screens.renderResults(m.results, (i) => localizedCarName(locale, assets.carName(i)), loaded);
  });
  screens.renderResults(m.results, (i) => localizedCarName(locale, assets.carName(i)), board);
});
conn.onEvent((e) => {
  announcer.handle(e);
  const sfx = getSoundEffectsManager();

  if (e.kind === 'countdown') {
    big.textContent = countdownDisplay(e.n, locale);
    // The audio clip says "3, 2, 1, go", so start it on the visible numeric 3 beat,
    // not during the staged "On your mark / Get ready / Get set" lead-in.
    if (locale === 'en-US' && isCountdownSoundCue(e.n) && !countdownSoundPlayed) {
      countdownSoundPlayed = true;
      sfx.playCountdown();
    }
  } else if (e.kind === 'go') {
    big.textContent = text('hud.go');
    setTimeout(() => (big.textContent = ''), 900);
  } else if (e.kind === 'hit') {
    sfx.playCrash();
  } else if (e.kind === 'boost_taken') {
    sfx.playPowerUp();
  } else if (e.kind === 'car_picked' || e.kind === 'map_picked') {
    sfx.playSelect();
  } else if (e.kind === 'race_over') {
    big.textContent = isDisplay ? '' : '';
    countdownSoundPlayed = false;  // Reset for next race
  }
});
conn.onError((code, message) => {
  console.error(`Server error [${code}]: ${message}`);
  big.textContent = text(code === 'room_full' ? 'error.roomFull' : 'error.generic');
});

const GANTRY_FILES = { start: 'racer/track/starting_line.glb', finish: 'racer/track/finish_line.glb' };
const RACER_CONFIG_TIMEOUT_MS = 15_000;
const RACER_MAP_TIMEOUT_MS = 45_000;
const RACER_STANDALONE_MAP_TIMEOUT_MS = 15_000;
const RACER_RACE_SCENE_BUDGET_MS = 1_800;
/** The map currently loaded into the renderer, so applyLevel() can skip redundant reloads. */
let loadedMap: string | null = null;
let levelLoadGeneration = 0;
let levelLoadController: AbortController | null = null;
let activeMapPreviewController: AbortController | null = null;

function invalidateLevelLoad(): number {
  levelLoadGeneration += 1;
  levelLoadController?.abort();
  levelLoadController = null;
  return levelLoadGeneration;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout?.(); reject(new Error(`${label} timed out`)); }, timeoutMs);
    void promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/**
 * Load a level (map world + curve + per-level car/item scale + camera + lighting/effects + gantries)
 * into the renderer. Called at boot for a ?map= override AND on every race start with the map the
 * lobby chose (the server sends it on the `items` message) — the host display has no ?map= param, so
 * this is the ONLY way its chosen level + per-car scales get applied. Idempotent per map name.
 */
async function applyLevel(mapName: string | null | undefined, deadlineSignal?: AbortSignal): Promise<boolean> {
  // No map (or unchanged): just (re)place gantries on whatever track is current and bail.
  const generation = invalidateLevelLoad();
  if (!mapName) { void renderer.setStartFinishLines(GANTRY_FILES, {}); return true; }
  if (mapName === loadedMap) return true;
  const controller = new AbortController();
  levelLoadController = controller;
  const abortForDeadline = () => controller.abort();
  deadlineSignal?.addEventListener('abort', abortForDeadline, { once: true });
  if (deadlineSignal?.aborted) controller.abort();
  let gantryOffsets: { start?: GantryOffset; finish?: GantryOffset } = {};
  let applied = false;
  try {
    if (controller.signal.aborted) return false;
    const maps = await withTimeout(fetchMaps(controller.signal), RACER_CONFIG_TIMEOUT_MS, 'map catalog', () => controller.abort());
    if (controller.signal.aborted || generation !== levelLoadGeneration) return false;
    const cfg = maps[mapName];
    if (!cfg) throw new Error(`map ${mapName} is unavailable`);
    if (cfg) {
      // Normalize the saved config into a full level (fills defaults; optional lighting/effects/props).
      const level = mergeLevel(cfg);
      const world = stationDisplay.active
        ? await withTimeout(loadMapWorld(cfg, controller.signal), RACER_MAP_TIMEOUT_MS, `map ${mapName}`, () => controller.abort())
        : await withTimeout(loadMapWorld(cfg, controller.signal), RACER_STANDALONE_MAP_TIMEOUT_MS, `map ${mapName}`, () => controller.abort());
      if (controller.signal.aborted || generation !== levelLoadGeneration) {
        if (world) disposeMapWorld(world);
        return false;
      }
      if (!world) throw new Error(`map ${mapName} failed to load`);
      renderer.setMapWorld(world);
      // Race stays in canonical sim space; the map's saved transform places the scenery.
      applyTrackTransform(renderer.getTrackGroup(), CANONICAL_TRACK);
      // Render-only curved path: cars/items/camera follow the curve; the sim stays straight.
      renderer.setPath(level.path ? new CurvedTrack(level.path) : null, surfaceOptsFromPath(level.path));
      renderer.setLighting(level.lighting ?? null);
      renderer.setEffects(level.effects ?? null);
      const propsReady = renderer.setProps(level.props);
      // Per-level car sizing keyed by MODEL FILENAME (the editor Cars panel's key); per-item scale.
      renderer.setCarScale((i) => resolveCarScale(level, assets.carFile(i) ?? String(i)));
      renderer.setItemScale((kind) => resolveItemScale(level, kind));
      renderer.setCamera(resolveCamera(level));
      gantryOffsets = { start: level.startLine, finish: level.finishLine };
      void propsReady;
      if (controller.signal.aborted || generation !== levelLoadGeneration) return false;
      applied = true;
    }
  } catch (error) {
    if (deadlineSignal?.aborted || generation !== levelLoadGeneration) return false;
    console.warn('Using the generated Voice Racer scene because the selected map is unavailable.', error);
    renderer.setMapWorld(null); renderer.setPath(null); renderer.setCamera(null);
    applyTrackTransform(renderer.getTrackGroup(), CANONICAL_TRACK);
    renderer.resetLevelPresentation();
    renderer.setCarScale(() => 1); renderer.setItemScale(() => 1); void renderer.setProps([]);
    loadedMap = null;
  } finally {
    deadlineSignal?.removeEventListener('abort', abortForDeadline);
    if (levelLoadController === controller) levelLoadController = null;
  }
  if (deadlineSignal?.aborted || generation !== levelLoadGeneration) return false;
  // Bookend the track AFTER setPath so the gantry auto-fits the level's track width.
  const linesReady = renderer.setStartFinishLines(GANTRY_FILES, gantryOffsets);
  void linesReady;
  if (deadlineSignal?.aborted || generation !== levelLoadGeneration) return false;
  if (applied) loadedMap = mapName;
  return true;
}

function resetToGeneratedRaceScene(): void {
  invalidateLevelLoad(); // late map requests cannot replace a live fallback race
  loadedMap = null;
  renderer.setMapWorld(null);
  renderer.setPath(null);
  applyTrackTransform(renderer.getTrackGroup(), CANONICAL_TRACK);
  renderer.setCamera(null);
  renderer.resetLevelPresentation();
  renderer.setCarScale(() => 1);
  renderer.setItemScale(() => 1);
  void renderer.setProps([]);
  // The tiny authored gantries can upgrade the procedural race without waiting for a
  // map download; the branded primitive gantries remain visible until they arrive.
  void renderer.setStartFinishLines(GANTRY_FILES, {});
}

/** Give a cached or quickly loaded map a short window, then play on the complete generated track. */
async function loadRaceLevelWithinBudget(mapName: string | null | undefined, generation: number): Promise<boolean> {
  if (generation !== racePreparationGeneration) return false;
  if (!mapName) { resetToGeneratedRaceScene(); return true; }
  if (mapName === loadedMap) { invalidateLevelLoad(); return true; }
  resetToGeneratedRaceScene();
  const budgetController = new AbortController();
  try {
    const applied = await withTimeout(
      applyLevel(mapName, budgetController.signal), RACER_RACE_SCENE_BUDGET_MS, 'race map',
      () => budgetController.abort(),
    );
    if (!applied && generation === racePreparationGeneration) resetToGeneratedRaceScene();
  } catch {
    budgetController.abort();
    if (generation !== racePreparationGeneration) return false;
    resetToGeneratedRaceScene();
  }
  return generation === racePreparationGeneration;
}

async function prepareRaceScene(
  items: import('../shared/types').Item[],
  mapName: string | null | undefined,
  generation: number,
  retry = 0,
): Promise<void> {
  try {
    const first = latestRaceSnapshot ?? await new Promise<import('../shared/types').WorldSnapshot>((resolve, reject) => {
      resolveRaceSnapshot = resolve;
      cancelRaceSnapshot = () => reject(new Error('race preparation cancelled'));
    });
    // Car and scenery files are optional presentation assets. Waiting for them before ready() can
    // stall every caller's race for tens of seconds on a weak display connection.
    void assets.loadManifest().catch(() => { /* procedural cars remain playable */ });
    if (generation !== racePreparationGeneration) return;
    if (!await loadRaceLevelWithinBudget(mapName, generation) || generation !== racePreparationGeneration) return;
    renderer.buildItems(items);
    renderer.clearCars();
    const splitScreen = first.cars.length === 2;
    renderer.render(first, { splitScreen });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (generation !== racePreparationGeneration) return;
    renderer.render(latestRaceSnapshot ?? first, { splitScreen });
    buffer.clear();
    buffer.push(latestRaceSnapshot ?? first, performance.now());
    raceSceneReady = true;
    screens.hide(); big.textContent = '';
    liftVeil();
    if (stationDisplay.active) conn.ready();
    maybeMarkStationReady();
  } catch (error) {
    if (generation !== racePreparationGeneration) return;
    console.error('Unable to prepare the selected Voice Racer scene.', error);
    const title = document.getElementById('veil-title');
    if (title) title.textContent = locale === 'pt-BR' ? 'Não foi possível carregar a corrida' : 'Unable to load race';
    if (stationDisplay.active && generation === racePreparationGeneration && retry < 2) {
      setTimeout(() => {
        if (generation === racePreparationGeneration && !raceSceneReady) {
          void prepareRaceScene(items, mapName, generation, retry + 1);
        }
      }, 2_000);
    }
  }
}

/** Load GLB templates + per-level config + car-grid thumbnails OFF the critical path, so the menu
 *  is interactive immediately. Names appear at once; portraits stream in one per frame. */
async function loadAssetsInBackground(): Promise<void> {
  try { await assets.loadManifest(); } catch { /* primitives — game still runs */ }
  // Friendly names are cheap → publish them now so the car grid has labels right away.
  try { screens.setCarCatalog(assets.carNames().map(name => localizedCarName(locale, name)), []); } catch { /* no manifest */ }
  // Portrait captures run independently from the backdrop. A slow map or prop must not leave the car
  // grid spinning, and a live station race pauses this cosmetic work instead of cancelling it.
  const capturesMayStart = new Promise<void>(resolve => setTimeout(resolve, 1500));
  const canCapture = () => !raceLive;
  void (async () => {
    await capturesMayStart;
    await renderCarThumbnailsAsync(assets, (i, url) => screens.setCarThumb(i, url), 256, canCapture);
  })().catch(() => { /* failed tiles keep their styled fallback */ });
  void (async () => {
    await capturesMayStart;
    const orb = await renderBoostThumbnailAsync(assets, 96, canCapture);
    if (orb) { setOrbThumb(orb); screens.setBoostThumb(orb); }
  })().catch(() => { /* keep text-only nitro label */ });
  // Load a map for the backdrop: an explicit ?map= wins; otherwise grab the first authored map so
  // the attract-mode demo races a real neon track (not the bare generated straight). The race itself
  // re-applies the lobby's chosen map on start (via onItems), so this is just the menu backdrop.
  try {
    let bg = urlMap;
    if (!bg) { try { bg = Object.keys(await fetchMaps())[0] ?? null; } catch { bg = null; } }
    if (!raceLive) await applyLevel(bg);
  } catch { /* keep generated track */ }
  // Models + map are loaded → NOW the attract demo can show real cars on the real track. If a menu
  // already asked for it (wantAttract), kick it off; otherwise startAttract() will once a screen needs it.
  assetsReady = true;
  maybeMarkStationReady();
  if (wantAttract) reallyStartAttract();

  // Map previews LAST (heaviest — full scenery GLBs): render each authored map's 3D world to a tile
  // image so the map-select screen shows what the track looks like, not a blank card. Pace each one
  // to main-thread idle so a big scenery render can't hitch the attract demo.
  try {
    const maps = await fetchMaps();
    const previews: Record<string, string> = {};
    for (const [name, cfg] of Object.entries(maps)) {
      let url = '';
      let cancelled = false;
      do {
        while (!canCapture()) await new Promise(resolve => setTimeout(resolve, 250));
        await whenIdle();
        while (!canCapture()) await new Promise(resolve => setTimeout(resolve, 250));
        const controller = new AbortController();
        activeMapPreviewController = controller;
        try { url = await renderMapThumbnail(cfg, 480, controller.signal); }
        finally { if (activeMapPreviewController === controller) activeMapPreviewController = null; }
        cancelled = controller.signal.aborted;
      } while (cancelled); // a race interrupted this preview; retry after returning to the menu
      if (url) previews[name] = url;
    }
    screens.setMapPreviews(previews);
  } catch { /* tiles fall back to the placeholder */ }
}

/** Resolve when the main thread is idle (so heavy background renders yield to the live attract demo).
 *  requestIdleCallback where available (timeout-bounded so we never starve), else a double-rAF. */
function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 300 });
    else requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function boot() {
  if (isGarage) {
    // The car/model viewer moved to its own page (/garage) — redirect old ?garage=1 links there.
    location.href = '/garage';
    return;
  }
  // Hide the in-game HUD until a real race starts — the menu (or the connecting beat) is the focus.
  document.body.classList.add('in-menu');

  // CONNECT FIRST. The menu must appear the instant the server replies to join — so we wire the
  // listeners + join NOW, BEFORE the heavy asset work below. Previously join() ran only AFTER
  // awaiting loadManifest() (19 GLBs + Draco) and a synchronous 19-car thumbnail render, which is
  // why the screen sat blank (with just the static HUD) for a second or more.
  conn.onJoined((playerId) => { renderer.setMyId(playerId); });
  input.onIntent((i) => { if (!screens.isVisible) conn.sendIntent(i); });
  if (isDisplay) renderer.setSpectator(true);
  screens.bindHostKeys();   // ← back · → / Enter advance (only while a screen is visible)
  bindFlowDigits();          // 1-9 select a car/map by number (stands in for SMS)
  addEventListener('keydown', (e) => {
    if (screens.isVisible) return;             // flow keys handled by screens.bindHostKeys
    if (e.key === 'r') conn.restart();
    else if (e.key === 'Enter') { conn.ready(); }
  });
  // The shared screen SPECTATES by default (occupies no roster slot, gets no car) — it's the display,
  // not a player. It can still drive the whole flow (ready/advance/back/restart/select_map key off the
  // connection's room, not a playerId), so the game starts with ZERO players and fills up as people
  // call in. A device player join()s with their own name + gets a car.
  if (isDisplay) conn.spectate(roomCode, stationDisplay.displayToken ?? undefined);
  else conn.join(roomCode, name);

  // SHARED-SCREEN "I'm playing" TOGGLE (P): the screen defaults to spectator, but the operator can
  // opt IN to also play on this keyboard (joins as a real player + car), and opt back OUT (drops the
  // slot, stays the display). Keeps the screen unambiguous — it's a spectator unless you say otherwise.
  if (isDisplay && !stationDisplay.active) {
    addEventListener('keydown', (e) => {
      if (e.key !== 'p' && e.key !== 'P') return;
      if (displayIsPlaying) { conn.leave(); renderer.setMyId(''); renderer.setSpectator(true); displayIsPlaying = false; }
      else { conn.join(roomCode, name); displayIsPlaying = true; }   // onJoined sets myId → chase cam
      screens.setSelfPlaying(displayIsPlaying);
    });
  }

  // Fetch the join phone number (server config) so the lobby QR + copy show the real number. Fire-
  // and-forget: the lobby renders immediately with a placeholder and re-renders when this lands.
  let phoneQrGeneration = 0;
  const stopVoiceNumberUpdates = watchVoiceNumber(locale, async number => {
    const generation = ++phoneQrGeneration;
    if (!number) { screens.setPhoneNumber('', '/brand/join-qr.png?v=2'); return; }
    try {
      const qr = await QRCode.toDataURL(`tel:${number}`, {
        width: 520, margin: 1, color: { dark: '#000D25', light: '#FFFFFF' }, errorCorrectionLevel: 'M',
      });
      if (generation === phoneQrGeneration) screens.setPhoneNumber(number, qr);
    } catch {
      if (generation === phoneQrGeneration) screens.setPhoneNumber(number, '/brand/join-qr.png?v=2');
    }
  });
  addEventListener('pagehide', stopVoiceNumberUpdates, { once: true });
  void fetch('/api/arcade/config/public').then(r => r.ok ? r.json() : null).then(async cfg => {
    if (!cfg || stationDisplay.active || cfg.arcade?.mode === 'off' || typeof cfg.arcade?.cabinetId !== 'string') return;
    const base=location.origin,asset=stationQrAsset(locale,cfg.arcade.cabinetId,base);
    const qr=await resolveStationQrImage(asset,()=>QRCode.toDataURL(stationJoinUrl(cfg.arcade.cabinetId,locale,base),{width:520,margin:1,color:{dark:'#000D25',light:'#FFFFFF'},errorCorrectionLevel:'M'}));
    if(qr)screens.setArcadeQr(qr);
  }).catch(() => { /* Station mode stays optional. */ });

  // Heavy asset work happens in the BACKGROUND (off the critical path). The lobby is already up;
  // the race only needs these once someone starts, and the car grid fills in progressively.
  void loadAssetsInBackground();

  let lastPowerActive: Set<string> = new Set();  // Track which cars have active power for SFX

  function frame() {
    requestAnimationFrame(frame);
    // Attract mode owns the canvas while it runs (its own rAF renders the demo) — don't double-render.
    if (attract.isRunning) { big.textContent = ''; paintGauge(null); paintSplitLabels(null); return; }
    const snap = buffer.sample(performance.now());
    if (snap) {
      const splitScreen = raceLive && snap.cars.length === 2;
      renderer.render(snap, { splitScreen });
      paintSplitLabels(splitScreen ? snap : null);
      // Keep the big countdown number visible even though the "Get Ready" overlay is up; clear it
      // once racing starts (GO! is set by the event handler and self-clears).
      if (snap.phase === 'countdown') big.textContent = countdownDisplay(snap.countdown, locale);

      // Detect power/nitro activation for SFX — play turbo sound for any car that just activated
      for (const car of snap.cars) {
        if (car.powerActive > 0 && !lastPowerActive.has(car.id)) {
          getSoundEffectsManager().playTurbo();
          break; // One sound per frame is enough
        }
      }
      const nowActive = new Set<string>();
      for (const car of snap.cars) {
        if (car.powerActive > 0) nowActive.add(car.id);
      }
      lastPowerActive = nowActive;
    }
    // Before the first server message (and before attract starts), show a branded waiting beat.
    else if (!started && !screens.isVisible) { big.textContent = `${commonText('connection.connecting')}…`; paintSplitLabels(null); }
    else if (screens.isVisible) { big.textContent = ''; paintSplitLabels(null); }
    paintGauge(snap);
  }
  requestAnimationFrame(frame);
}

void boot();
