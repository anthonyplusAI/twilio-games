// Voice Monsters battle page orchestrator. Ties the /battle WebSocket → the Game Boy renderer + the
// lobby/monster-select/results overlays. Roles by URL (matching the racer):
//   ?display=1 → the shared SCREEN (spectator; can also "play on this screen"); else → play on device.
//
// TURN-BASED FEEL: the client derives an explicit uiPhase from the snapshot (phase + chosen) so the
// move menu ONLY shows on your turn, a "command locked — waiting" beat appears after you pick, and
// resolution plays as paced events. An overlay dedup guard stops the lobby/results modals from
// re-mounting on every ~state push (the "win modal keeps popping up" bug).
import { BattleConnection, type BattleStateMsg } from './battle-net';
import { BattleRenderer, type UiPhase, type MenuMove } from './battle-renderer';
import { ArenaBackground } from './arena-background';
import { AmbientFx } from './ambient-fx';
import { battleControlsLegendHtml } from './battle-controls-legend';
import { drawMonsterSprite, typeColor } from './monster-sprite';
import { moveById } from '../../shared/monster-roster';
import { spriteCandidateUrls } from './sprite-sources';
import type { RosterEntry } from '../../shared/battle-protocol';
import type { BattleEvent, BattleAction } from '../../shared/battle-world';
import { dwellForEvent, HANDOFF_PAUSE_MS } from '../../shared/battle-timing';
import { effectivenessLabel, monsterTypeLabel, type MonsterType } from '../../shared/monster-types';
import { matchBattleAction } from '../../shared/battle-intent';
import { MONSTERS_MESSAGES } from '../../shared/i18n/monsters';
import { createTranslator } from '../../shared/i18n/translate';
import { locale, commonText } from '../i18n';
import { monsterName as localizedMonsterName, moveName as localizedMoveName } from '../../shared/i18n/content';
import { getMusicManager } from '../music-manager';
import { injectMusicToggle } from '../music-toggle';
import { injectFullscreenToggle } from '../fullscreen-toggle';
import { getSoundEffectsManager } from '../sound-effects';
import { createStationDisplay } from '../station-display';
import { resultTechHtml } from '../result-tech';
import { watchVoiceNumber } from '../station-client';
import QRCode from 'qrcode';

const params = new URLSearchParams(location.search);
const text = createTranslator(locale, MONSTERS_MESSAGES);
const isDisplay = params.get('display') === '1';
const roomCode = params.get('room') ?? '4821';
const name = params.get('name') ?? text('player.default');

const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = params.get('ws')
  ?? `${wsProto}://${location.host}/battle${isDisplay?'?display=1':''}`;

const overlay = document.getElementById('overlay')!;
const stageEl = document.getElementById('stage')!;
const appEl = document.getElementById('app')!;
const stationDisplay = createStationDisplay();
let stationRosterReady = false;
let stationStateReady = false;
const maybeMarkStationReady = () => {
  if (stationRosterReady && stationStateReady) stationDisplay.markEngineReady();
};

document.title = text('game.title');
const gameTitleLabel = document.querySelector<HTMLElement>('#vm-hud .htitle');
if (gameTitleLabel) gameTitleLabel.textContent = text('game.title');

document.getElementById('game-home')?.setAttribute('aria-label', commonText('navigation.homeAria'));
const homeLabel = document.getElementById('game-home-label');
if (homeLabel) homeLabel.textContent = commonText('navigation.home');
overlay.setAttribute('aria-label', text('access.menuOverlay'));

// Inject music toggle button
injectMusicToggle('music-toggle-container');
injectFullscreenToggle('music-toggle-container', {
  enter: commonText('fullscreen.enter'), exit: commonText('fullscreen.exit'),
});
const musicToggle = document.getElementById('music-toggle');
const localizeMusicToggle = (): void => {
  if (!musicToggle) return;
  musicToggle.title = commonText('music.toggleTitle');
  musicToggle.setAttribute('aria-label', commonText('music.toggleAria'));
  const label = musicToggle.querySelector<HTMLElement>('.music-toggle-label');
  if (label) label.textContent = commonText(getMusicManager().getIsMuted() ? 'music.off' : 'music.on');
};
localizeMusicToggle();
musicToggle?.addEventListener('click', localizeMusicToggle);

// The OUTER background FX layer: fills #app AROUND the stage + flashes the attack's color across the
// whole screen. Separate from the 3D arena/stage (those are untouched).
const ambient = new AmbientFx(appEl);

// A COLLAGE of all the monster sprites tiled behind the MENU overlays (lobby / select / results), so
// the menus have a lively rendered background instead of flat navy — matches the racer's rendered
// menu backdrop. Darkened + drifting so the glass card + text stay readable. Only shown in menus
// (hidden during a battle, when the 3D arena owns the screen). Built once; toggled by renderOverlay.
const collage = document.createElement('div');
collage.id = 'vm-collage';
collage.setAttribute('aria-hidden', 'true');
// The ambient canvas shares layer 0 and is already in the DOM, while the menu and battle stage
// occupy layer 1. This keeps the decorative art behind every readable control.
collage.style.zIndex = '0';
appEl.appendChild(collage);
function buildCollage(): void {
  if (collage.childElementCount || roster.length === 0) return;   // build once, after the roster arrives
  // 5 columns × enough rows to fill; cycle the 8 front sprites so the pattern reads as "all of them".
  const cells = 40;
  const portraits = new Map<string, HTMLImageElement[]>();
  for (let i = 0; i < cells; i++) {
    const m = roster[i % roster.length]!;
    const img = document.createElement('img');
    img.src = placeholderPortrait(m.id, m.type);
    img.alt = '';
    collage.appendChild(img);
    const copies = portraits.get(m.id) ?? [];
    copies.push(img);
    portraits.set(m.id, copies);
  }
  // Keep the local portrait visible while optional art loads. One probe per monster also avoids
  // issuing the same GIF/PNG request for every repeated tile on a slow connection.
  for (const [id, copies] of portraits) {
    const urls = spriteCandidateUrls(id, 'front');
    const tryNext = (index: number): void => {
      if (index >= urls.length) return;
      const probe = new Image();
      probe.onload = () => { for (const img of copies) img.src = urls[index]!; };
      probe.onerror = () => tryNext(index + 1);
      probe.src = urls[index]!;
    };
    tryNext(0);
  }
}

const conn = new BattleConnection(wsUrl, locale);
// The 3D spinning arena sits BEHIND the GB battle canvas (both live in #stage). Created first so its
// canvas is under the renderer's. Loaded lazily when a battle actually starts (no 3D cost in menus).
const arena = new ArenaBackground(stageEl);
let arenaLoaded = false;
const renderer = new BattleRenderer(stageEl, locale);

let roster: RosterEntry[] = [];
let myId: string | null = null;
let state: BattleStateMsg | null = null;
let draining = false;                 // events currently animating
let lockedMoveName: string | null = null;   // the move I committed this turn (for the "locked" beat)
let menuLevel: 'root' | 'fight' = 'root';   // two-level command menu: root actions → ATTACK's moves
let phoneNumber = '';   // the number players call to join (from /api/config) — shown in the lobby join flow
let phoneQr = '/brand/join-qr.png?v=2';
let joinedHere = false;
let resultAuthorityFresh = false;
let touchTargetPlayerId: string | null = null;
let connectionEpoch = 0;
let lastResultsAckGeneration: number | null = null;
let pendingResultsAckGeneration: number | null = null;
let pendingShowResultsGeneration: number | null = null;

function localizeBattleState(message: BattleStateMsg): BattleStateMsg {
  if (!message.snapshot) return message;
  const side = (combatant: typeof message.snapshot.a) => ({
    ...combatant,
    monsterName: localizedMonsterName(locale, combatant.monsterId),
    moves: combatant.moves.map(move => ({ ...move, name: localizedMoveName(locale, move.id) })),
  });
  return { ...message, snapshot: { ...message.snapshot, a: side(message.snapshot.a), b: side(message.snapshot.b) } };
}

// Fetch the join phone number so the lobby QR + copy show the real number (matches the racer). Fire-
// and-forget: the lobby renders immediately with a placeholder, then re-renders when this lands.
let phoneQrGeneration = 0;
const stopVoiceNumberUpdates = watchVoiceNumber(locale, async number => {
  const generation = ++phoneQrGeneration;
  phoneNumber = number;
  if (!number) { phoneQr = '/brand/join-qr.png?v=2'; lastOverlayKey = ''; renderOverlay(); return; }
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
  lastOverlayKey = ''; renderOverlay();
});
addEventListener('pagehide', stopVoiceNumberUpdates, { once: true });

conn.onRoster((entries) => {
  stationRosterReady = true; maybeMarkStationReady();
  roster = entries.map(entry => ({
    ...entry,
    name: localizedMonsterName(locale, entry.id),
    moves: entry.moves.map(move => ({ ...move, name: localizedMoveName(locale, move.id) })),
  }));
  renderOverlay();
});
conn.onJoined((id) => { myId = id; joinedHere = true; resultAuthorityFresh = false; lastOverlayKey = ''; renderOverlay(); });
conn.onError((code, msg) => {
  console.error(`[battle] ${code}: ${msg}`);
  if (code === 'room_full' || code === 'battle_in_progress' || code === 'round_complete') {
    myId = null; joinedHere = false; conn.spectate(roomCode, stationDisplay.displayToken ?? undefined);
  }
});
conn.onConnected(() => {
  connectionEpoch++;
  resultAuthorityFresh = false;
  cancelPlayback();
  lastResultsAckGeneration = null;
  pendingResultsAckGeneration = null;
  lastOverlayKey = '';
  renderOverlay();
});
conn.onDisconnected(() => {
  connectionEpoch++;
  resultAuthorityFresh = false;
  lastOverlayKey = '';
  renderOverlay();
});
conn.onEvents((events, eventIds, generation) => queueEvents(events, eventIds, generation));
conn.onShowResults((generation) => {
  if (state?.phase !== 'results' || state.generation !== generation) {
    pendingShowResultsGeneration = generation;
    return;
  }
  cancelPlayback();
  dismissContinue();
});

conn.onState((incoming) => {
  stationStateReady = true; maybeMarkStationReady();
  const m = localizeBattleState(incoming);
  const prevPhase = state?.phase;
  const prevGeneration = state?.generation;
  const priorTouchTarget = state?.players.find(player => player.playerId === touchTargetPlayerId);
  const prevPlayerCount = state?.players?.length ?? 0;
  const prevMonsterSelections = state?.players?.filter(p => p.monsterId).length ?? 0;
  state = m;
  resultAuthorityFresh = true;
  if (prevGeneration !== undefined && prevGeneration !== m.generation) {
    cancelPlayback();
    lastActionSide = null;
    if (pendingShowResultsGeneration !== m.generation) pendingShowResultsGeneration = null;
  }
  if (m.phase === 'monster_select' && isDisplay && !joinedHere) {
    if (priorTouchTarget && !priorTouchTarget.monsterId
      && m.players.find(player => player.playerId === priorTouchTarget.playerId)?.monsterId) {
      touchTargetPlayerId = m.players.find(player => !player.isAi && !player.monsterId)?.playerId
        ?? priorTouchTarget.playerId;
    }
    touchTargetPlayerId = resolveTouchTarget(m.players);
  }
  if (m.phase === 'results' && pendingShowResultsGeneration === m.generation) {
    cancelPlayback();
    pendingShowResultsGeneration = null;
    awaitingContinue = false;
  }
  
  // Play select sound on new player join or monster selection
  const currentPlayerCount = m.players?.length ?? 0;
  const currentMonsterSelections = m.players?.filter(p => p.monsterId).length ?? 0;
  if ((currentPlayerCount > prevPlayerCount && prevPlayerCount > 0) ||
      (currentMonsterSelections > prevMonsterSelections && prevMonsterSelections > 0)) {
    getSoundEffectsManager().playSelect();
  }

  // Switch music context based on phase
  if (m.phase === 'lobby' && prevPhase !== 'lobby') {
    getMusicManager().switchContext('lobby');
  } else if (m.phase === 'battle' && prevPhase !== 'battle') {
    lastActionSide = null;
    getMusicManager().switchContext('monsters');
  }
  
  // A fresh turn (back to choosing) clears the last locked move + resets the menu to the root actions.
  if (m.snapshot?.phase === 'choosing') {
    if (!chosenForMe(m)) lockedMoveName = null;
    menuLevel = m.activeMenu ?? 'root';
  }
  // Leaving results (rematch / reset) drops any pending continue-hold so it can't strand the stage.
  if (m.phase !== 'results') awaitingContinue = false;
  // First time we enter a battle, spin up the 3D arena behind the GB overlay (lazy — no 3D in menus).
  // Pull the editor-authored config from /api/arena; fall back to sensible defaults on any failure.
  if (m.phase === 'battle' && !arenaLoaded) {
    arenaLoaded = true;
    fetch('/api/arena').then(r => r.ok ? r.json() : null).then((cfg) => {
      arena.load(cfg && typeof cfg === 'object' ? cfg : { file: 'arena.glb', spinSpeed: 0.18 });
    }).catch(() => arena.load({ file: 'arena.glb', spinSpeed: 0.18 }));
  }
  paintBattle();
  renderOverlay();
  // Advancing OUT of battle (→ results) or into it clears stale banners.
  if (prevPhase !== m.phase) renderer.setEventBanner('');
});

// ── who am I + my moves ──────────────────────────────────────────────────────────────────────────
function mySide(m: BattleStateMsg): 'a' | 'b' | null {
  if (!m.snapshot) return null;
  if (m.snapshot.a.id === myId) return 'a';
  if (m.snapshot.b.id === myId) return 'b';
  return null;   // spectator/display
}
function mySideMoves(m: BattleStateMsg): MenuMove[] {
  const snap = m.snapshot; if (!snap) return [];
  const side = mySide(m) ?? m.activeSide ?? 'a';   // shared display follows the active monster's menu
  const cs = side === 'b' ? snap.b : snap.a;
  return cs.moves.map(mv => ({ name: mv.name, type: mv.type, power: mv.power }));
}
function chosenForMe(m: BattleStateMsg): boolean {
  const side = mySide(m); if (!side || !m.snapshot) return false;
  return m.snapshot.chosen[side];
}
const opponentName = (m: BattleStateMsg): string => {
  const snap = m.snapshot; if (!snap) return text('battle.rival');
  return mySide(m) === 'b' ? snap.a.name : snap.b.name;
};

/** Derive the client turn state from the wire snapshot + local draining/lock. */
function currentUiPhase(): UiPhase {
  if (!state?.snapshot) return 'idle';
  if (draining) return 'resolving';
  if (state.snapshot.phase === 'finished') return 'finished';
  if (state.snapshot.phase === 'choosing') {
    const side = mySide(state);
    if (!side) return isDisplay && state.activeSide ? 'awaiting-input' : 'idle';
    if (lockedMoveName && (!state.activeSide || state.activeSide === side)) return 'command-locked';
    if (chosenForMe(state)) return 'command-locked';
    if (state.activeSide && state.activeSide !== side) return 'idle';
    return 'awaiting-input';
  }
  return 'resolving';
}

/** Push the current battle view to the renderer (snapshot + my moves + turn state + status line). */
function paintBattle(): void {
  if (!state) return;
  const uiPhase = currentUiPhase();
  let status = '';
  const sideForMenu = mySide(state) ?? state.activeSide ?? 'a';
  if (state.snapshot) {
    const combatant = sideForMenu === 'b' ? state.snapshot.b : state.snapshot.a;
    const myMon = combatant.monsterName;
    if (uiPhase === 'awaiting-input') status = menuLevel === 'fight'
      ? text('status.moves', { monster: myMon })
      : text('status.whatWillDo', { monster: myMon });
    else if (uiPhase === 'command-locked') status = `${lockedMoveName ? lockedMoveName + ' ' : ''}${text('status.waitingFor', { opponent: opponentName(state) })}`;
    else if (state.snapshot.phase === 'choosing' && state.activeSide) status = text('status.choosing', { monster: actorName(state.activeSide) });
    else if (uiPhase === 'finished') status = state.result ? text('status.wins', { winner: state.result.winnerName }) : '';
    const effects = [combatant.guarding ? text('status.guarding') : '', combatant.taunted ? text('status.taunted') : ''].filter(Boolean);
    if (effects.length) status = `${status}${status ? ' · ' : ''}${effects.join(' · ')}`;
  }
  // The foe's type → the renderer shows move pips as effectiveness vs THIS opponent.
  const foeType = state.snapshot ? (sideForMenu === 'b' ? state.snapshot.a.type : state.snapshot.b.type) : null;
  renderer.setMenu(menuLevel, sideForMenu);
  renderer.setState(state.snapshot, mySideMoves(state), uiPhase, status, foeType ?? null);
  if (!draining) renderer.setActiveSide(state.activeSide ?? null);
}

// ── paced event playback ──────────────────────────────────────────────────────────────────────────
interface QueuedBattleEvent { event: BattleEvent; eventId: number; generation: number }
let eventQ: QueuedBattleEvent[] = [];
let playbackEpoch = 0;
let playbackTimer: ReturnType<typeof setTimeout> | null = null;
function cancelPlayback(): void {
  playbackEpoch++;
  if (playbackTimer) clearTimeout(playbackTimer);
  playbackTimer = null;
  eventQ = [];
  pendingHandoff = null;
  draining = false;
  awaitingContinue = false;
  renderer.setActiveSide(null);
}
function scheduleNext(delay: number): void {
  const epoch = playbackEpoch;
  playbackTimer = setTimeout(() => {
    playbackTimer = null;
    if (epoch === playbackEpoch) drainNext();
  }, delay);
}
function queueEvents(events: BattleEvent[], eventIds: number[], generation: number): void {
  if (events.length !== eventIds.length || generation !== state?.generation) return;
  eventQ.push(...events.map((event, index) => ({ event, eventId: eventIds[index]!, generation })));
  if (!draining) { draining = true; paintBattle(); drainNext(); }
}
let lastActionSide: 'a' | 'b' | null = null;
let pendingHandoff: 'a' | 'b' | null = null;   // a synthetic "▶ X'S TURN" card to show before next move
let awaitingContinue = false;   // battle ended → holding on the arena until the player acknowledges

function drainNext(): void {
  // A queued handoff card takes priority: show it as its own slow beat, THEN continue to the attack.
  if (pendingHandoff) {
    const who = pendingHandoff; pendingHandoff = null;
    renderer.setEventBanner(handoffText(who));
    renderer.setActiveSide(who);
    scheduleNext(HANDOFF_PAUSE_MS);   // hold the "their turn" card so the ping-pong is unmistakable
    return;
  }
  const beat = eventQ.shift();
  if (!beat) {
    draining = false; renderer.setActiveSide(null);
    // Battle just ended? Don't jump straight to the results modal — hold on the arena with a
    // "▶ Continue" prompt so the win lands, and wait for the player to acknowledge.
    if (state?.phase === 'results') {
      if (stationDisplay.active) {
        awaitingContinue = false;
        renderer.setEventBanner('');
        renderOverlay();
        return;
      }
      awaitingContinue = true;
      renderer.setEventBanner(text('battle.continue', { winner: state.result?.winnerName ?? text('results.winner') }));
      renderOverlay();
      return;
    }
    paintBattle(); renderOverlay(); return;
  }

  const ev = beat.event;

  const actionSide = sideForActionEvent(ev);
  if (actionSide && lastActionSide && lastActionSide !== actionSide) {
    lastActionSide = actionSide; pendingHandoff = actionSide; eventQ.unshift(beat); scheduleNext(0); return;
  }
  if (actionSide) lastActionSide = actionSide;
  if (ev.kind === 'move_used') {
    renderer.setActiveSide(ev.by);
    // Flash the OUTER background in the move's element color (leaves the 3D stage untouched).
    const moveType = moveById(ev.moveId)?.type ?? 'normal';
    ambient.flash(typeColor(moveType));
    // Play attack SFX based on element type
    getSoundEffectsManager().playAttack(moveType);
  } else if (ev.kind === 'guard') {
    getSoundEffectsManager().playGuard();
  } else if (ev.kind === 'block') {
    getSoundEffectsManager().playGuard();
  } else if (ev.kind === 'item') {
    getSoundEffectsManager().playItem();
  } else if (ev.kind === 'taunt') {
    getSoundEffectsManager().playTaunt();
  } else if (ev.kind === 'battle_over') {
    getMusicManager().switchContext('leaderboard');
  }

  renderer.playEvent(ev);
  const banner = bannerFor(ev);
  if (banner) renderer.setEventBanner(banner);
  // The voice announcer receives this beat only after the animation and banner have reached a frame.
  const epoch = playbackEpoch;
  const socketEpoch = connectionEpoch;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (epoch !== playbackEpoch || socketEpoch !== connectionEpoch
      || state?.generation !== beat.generation || stageEl.style.display === 'none') return;
    conn.ackEvent(beat.generation, beat.eventId);
  }));
  scheduleNext(dwellFor(ev));
}

/** "▶ YOUR TURN" when it's the local player's monster, else "▶ RIVAL'S TURN" (names the foe). */
function handoffText(side: 'a' | 'b'): string {
  const me = state ? mySide(state) : null;
  if (me && side === me) return text('battle.handoffYour');
  return text('battle.handoffNamed', { monster: actorName(side).toLocaleUpperCase(locale) });
}

function sideForActionEvent(ev: BattleEvent): 'a' | 'b' | null {
  return ev.kind === 'move_used' || ev.kind === 'guard' || ev.kind === 'item' || ev.kind === 'taunt'
    ? ev.by : null;
}

/** How long to hold on `ev` before playing the next one — SHARED with the voice layer (battle-timing)
 *  so the screen animation + spoken commentary stay on the same clock. */
const dwellFor = dwellForEvent;
/** The monster name for a side, from the current snapshot (for "X used Move!" banners). */
function actorName(side: 'a' | 'b'): string {
  const snap = state?.snapshot; if (!snap) return side === 'a' ? text('battle.actorYou') : text('battle.actorFoe');
  return (side === 'a' ? snap.a : snap.b).monsterName;
}
function bannerFor(ev: BattleEvent): string | null {
  switch (ev.kind) {
    case 'turn_start': return text('battle.eventTurn', { turn: ev.turn });
    // Name the attacker so it's unmistakable WHOSE turn it is ("Sparkmouse used Thunder Jolt!").
    case 'move_used': return text('battle.eventMove', { monster: actorName(ev.by), move: localizedMoveName(locale, ev.moveId) });
    case 'miss': return text('battle.eventMiss');
    case 'guard': return text('battle.eventGuard', { monster: localizedMonsterName(locale, ev.monsterName) });
    case 'block': return text('battle.eventBlock', { monster: localizedMonsterName(locale, ev.monsterName) });
    case 'item': return text('battle.eventItem', { monster: actorName(ev.by), item: text('content.potion') });
    case 'taunt': return text('battle.eventTaunt', { monster: localizedMonsterName(locale, ev.monsterName), target: localizedMonsterName(locale, ev.targetName) });
    case 'heal': return null;   // the HP bar rising tells the story; no separate banner
    case 'damage': return ev.crit ? text('battle.eventCritical') : null;   // a normal hit shows no banner
    case 'effectiveness': return effectivenessLabel(ev.multiplier, locale);
    case 'faint': return text('battle.eventFaint', { monster: localizedMonsterName(locale, ev.monsterName) });
    case 'battle_over': return text('battle.eventWin', { winner: ev.winnerName });
    default: return null;
  }
}

// ── overlays (lobby / monster-select / results) — DEDUP-GUARDED so they don't re-mount every push ──
let lastOverlayKey = '';
function renderOverlay(): void {
  const phase = state?.phase ?? 'connecting';
  // The battle STAGE (GB canvas + 3D arena) must only show during an actual battle. Otherwise its
  // "Waiting…" canvas rendered ON TOP of the lobby/select overlays (covering the buttons — the bug).
  // Also keep it up while AWAITING CONTINUE (battle ended, holding on the win before the results modal).
  const inBattle = phase === 'battle' || draining || awaitingContinue;
  document.body.classList.toggle('vm-showing-results', phase === 'results' && !inBattle);
  const stageWasHidden = stageEl.style.display === 'none';
  stageEl.style.display = inBattle ? '' : 'none';
  if (inBattle && stageWasHidden) requestAnimationFrame(() => dispatchEvent(new Event('resize')));
  // The monster collage backs the MENU overlays only (hidden during a battle, where the arena owns it).
  buildCollage();
  collage.style.display = inBattle || phase === 'connecting' ? 'none' : '';
  // During battle (incl. resolving), the GB canvas owns the screen — no overlay.
  if (inBattle || phase === 'connecting') {
    if (lastOverlayKey !== 'hidden') { overlay.innerHTML = ''; overlay.style.display = 'none'; lastOverlayKey = 'hidden'; }
    return;
  }
  const key = overlayKey(phase);
  if (key === lastOverlayKey) {
    if (phase === 'results') scheduleResultsReceipt();
    return;   // nothing meaningful changed → don't rebuild (kills modal spam)
  }
  const previousResultCard = overlay.querySelector<HTMLElement>('.vm-results');
  const active = document.activeElement;
  let focusedResultControl: 'title' | 'rematch' | 'exit' | 'guide' | null = null;
  if (previousResultCard?.contains(active)) {
    if (active?.id === 'vm-result-title') focusedResultControl = 'title';
    else if (active?.matches('[data-act="advance"]')) focusedResultControl = 'rematch';
    else if (active?.matches('a[href="/"]')) focusedResultControl = 'exit';
    else if (active?.matches('.result-tech__more a')) focusedResultControl = 'guide';
  }
  const previousResultView = phase === 'results' && previousResultCard ? {
    overlayScroll: overlay.scrollTop,
    cardScroll: previousResultCard.scrollTop,
    expanded: [...overlay.querySelectorAll<HTMLDetailsElement>('details')].map((detail, index) => detail.open ? index : -1),
  } : null;
  lastOverlayKey = key;
  overlay.style.display = 'flex';
  if (phase === 'lobby') overlay.innerHTML = lobbyHtml();
  else if (phase === 'monster_select') overlay.innerHTML = monsterSelectHtml();
  else if (phase === 'results') overlay.innerHTML = resultsHtml();
  if (previousResultView) {
    overlay.scrollTop = previousResultView.overlayScroll;
    const card = overlay.querySelector<HTMLElement>('.vm-results');
    if (card) card.scrollTop = previousResultView.cardScroll;
    overlay.querySelectorAll<HTMLDetailsElement>('details').forEach((detail, index) => {
      detail.open = previousResultView.expanded.includes(index);
    });
  }
  wireOverlay();
  if (phase === 'results') {
    const focusTarget = focusedResultControl === 'rematch' ? overlay.querySelector<HTMLElement>('[data-act="advance"]')
      : focusedResultControl === 'exit' ? overlay.querySelector<HTMLElement>('.vm-result-actions a[href="/"]')
        : focusedResultControl === 'guide' ? overlay.querySelector<HTMLElement>('.result-tech__more a')
          : null;
    if (focusedResultControl) (focusTarget ?? overlay.querySelector<HTMLElement>('#vm-result-title'))?.focus({ preventScroll: true });
    else if (!previousResultCard || !previousResultCard.contains(active))
      overlay.querySelector<HTMLElement>('#vm-result-title')?.focus({ preventScroll: true });
  } else if (previousResultCard) {
    overlay.querySelector<HTMLElement>('.vm-title')?.focus({ preventScroll: true });
  }
  if (phase === 'monster_select') upgradeSelectPortraits();   // swap placeholders → real GIF/PNG
  if (phase === 'results') scheduleResultsReceipt();
}

/** A result is ready for narration only after its overlay has actually painted on this display. */
function scheduleResultsReceipt(): void {
  if (state?.phase !== 'results' || draining || awaitingContinue || overlay.style.display === 'none') return;
  const generation = state.generation;
  if (pendingResultsAckGeneration === generation || lastResultsAckGeneration === generation) return;
  pendingResultsAckGeneration = generation;
  const socketEpoch = connectionEpoch;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (pendingResultsAckGeneration !== generation || socketEpoch !== connectionEpoch
      || state?.phase !== 'results' || state.generation !== generation
      || draining || awaitingContinue || overlay.style.display === 'none') {
      if (pendingResultsAckGeneration === generation) pendingResultsAckGeneration = null;
      return;
    }
    pendingResultsAckGeneration = null;
    stationDisplay.markEngineResultsReady();
    if (isDisplay && !joinedHere && !state.resultsPresented) {
      lastResultsAckGeneration = generation;
      conn.ackResults(generation);
    }
  }));
}
/** A stable fingerprint of the overlay's meaningful inputs — only a change here rebuilds the DOM. */
function overlayKey(phase: string): string {
  const players = state?.players ?? [];
  const roster3 = roster.length;
  const roster3k = players.map(p => `${p.playerId}:${p.name}:${p.monsterId ?? ''}`).join('|');
  const win = state?.result?.winnerName ?? '';
  const replay = phase === 'results' && stationDisplay.active ? 'station' : canOfferRematch() ? 'ready' : 'locked';
  return `${phase}|${isDisplay ? 'D' : 'P'}|${joinedHere ? 'J' : 'j'}|r${roster3}|${roster3k}|${win}|${replay}`;
}

function canOfferRematch(): boolean {
  return !stationDisplay.active && resultAuthorityFresh && state?.phase === 'results' && state.canRematch === true;
}

/** Can THIS client drive the flow (advance / start)? A device player (auto-joined) can drive their
 *  own game vs AI; the shared screen drives once it has a player or has opted to play on-screen. */
function canDrive(): boolean {
  const havePlayers = (state?.players?.length ?? 0) > 0;
  return joinedHere || (isDisplay && havePlayers);
}

function resolveTouchTarget(players: BattleStateMsg['players']): string | null {
  const humans = players.filter(player => !player.isAi);
  if (touchTargetPlayerId && humans.some(player => player.playerId === touchTargetPlayerId))
    return touchTargetPlayerId;
  return humans.find(player => !player.monsterId)?.playerId ?? humans[0]?.playerId ?? null;
}

function lobbyHtml(): string {
  // ONE lobby screen, matching Voice Racer: callers dial in and appear as chips; the shared screen can
  // add a KEYBOARD tester with P. Advance ("Choose your monster") once at least one player is in — no
  // separate "play on this screen" step.
  const players = state?.players ?? [];
  const chips = players.map(p => `<span class="vm-chip">${esc(p.name)}${p.monsterId ? ' ✓' : ''}</span>`).join('')
    || `<span class="vm-dim">${text('lobby.waitingChallengers')}</span>`;
  const havePlayers = players.length > 0;
  let action: string;
  if (havePlayers && canDrive() && state?.canAdvanceLobby) {
    action = `<button class="vm-btn" data-act="advance">${text('lobby.chooseMonster')}</button>`;
  } else if (havePlayers) {
    action = `<div class="vm-dim">${text('lobby.waitingReady')}</div>`;
  } else if (isDisplay) {
    // Shared screen, nobody in yet: wait for callers, or press P to add a keyboard tester player.
    action = `<div class="vm-dim">${text('lobby.anyoneCanJoin')}</div>`;
  } else {
    action = `<div class="vm-dim">${text('lobby.waitingHost')}</div>`;
  }
  // TWO-COLUMN layout matching Voice Racer's lobby: LEFT = join flow (QR + numbered steps stacked) +
  // chips + action; RIGHT = the "How to battle" legend panel. Side by side, not one tall stack.
  const num = phoneNumber
    ? `<a class="vm-num" href="tel:${esc(phoneNumber)}">${esc(phoneNumber)}</a>`
    : `<span class="vm-num vm-num-unset">${text('lobby.phoneUnset')}</span>`;
  const join = stationDisplay.active
    ? `<div class="vm-station-call"><strong>${text('lobby.stationTitle')}</strong><span>${text('lobby.stationBody')}</span>
        <ol class="vm-join-steps"><li><span class="vm-step-n">1</span> ${text('lobby.stationStep1')}</li><li><span class="vm-step-n">2</span> ${text('lobby.stationStep2')}</li><li><span class="vm-step-n">3</span> ${text('lobby.stationStep3')}</li></ol></div>`
    : `<div class="vm-join">
        <div class="vm-join-qr">${phoneQr ? `<img src="${esc(phoneQr)}" alt="${text('lobby.qrAlt')}">` : ''}<div class="vm-join-cap">${text('lobby.scanToJoin')}</div></div>
        <ol class="vm-join-steps"><li><span class="vm-step-n">1</span> ${text('lobby.stepScan')}</li><li><span class="vm-step-n">2</span> ${text('lobby.stepCall', { number: num })}</li><li><span class="vm-step-n">3</span> ${text('lobby.stepBattle')}</li></ol>
      </div>`;
  const left = `
    <div class="vm-lobby-main">
      ${join}
      <div class="vm-chips">${chips}</div>
      ${action}
    </div>`;
  return `<div class="vm-card wide vm-lobby">
    ${brandHead(text('lobby.title'), text('lobby.subtitle'))}
    <div class="vm-lobby-grid">
      ${left}
      ${battleControlsLegendHtml(locale)}
    </div>
  </div>`;
}

/** The Twilio brand header used across the menus: logo eyebrow → red wordmark → subtitle. Matches
 *  Voice Racer's scr-head so the two games look like one product. */
function brandHead(title: string, sub: string): string {
  return `<div class="vm-head">
    <div class="vm-eyebrow"><img src="/brand/Twilio_Logo_Bug_White.svg" alt="">Twilio</div>
    <div class="vm-title" role="heading" aria-level="1" tabindex="-1">${esc(title)}</div>
    <div class="vm-sub">${esc(sub)}</div>
  </div>`;
}

/** The procedural placeholder portrait as a data-URL, cached per monster id. Used as the <img> src
 *  fallback when no real sprite file exists. */
const portraitCache = new Map<string, string>();
function placeholderPortrait(id: string, type: string): string {
  let url = portraitCache.get(id);
  if (!url) {
    try { url = drawMonsterSprite({ id, type: type as never, view: 'front', size: 128 }).toDataURL(); }
    catch { url = ''; }
    portraitCache.set(id, url);
  }
  return url;
}

/** After the select grid mounts, upgrade each portrait <img> to the REAL sprite if one exists: try
 *  the animated GIF, then the static PNG, and leave the procedural placeholder in place if neither
 *  loads. Loading the file directly into an <img> means an animated GIF ANIMATES on the card (unlike
 *  a canvas snapshot). */
function upgradeSelectPortraits(): void {
  overlay.querySelectorAll<HTMLImageElement>('img[data-mon-portrait]').forEach((img) => {
    const id = img.dataset.monPortrait!;
    const urls = spriteCandidateUrls(id, 'front');
    const tryNext = (i: number): void => {
      if (i >= urls.length) return;   // exhausted → keep the placeholder already in src
      const probe = new Image();
      probe.onload = () => { img.src = urls[i]!; };   // real file exists → show it (animates if GIF)
      probe.onerror = () => tryNext(i + 1);
      probe.src = urls[i]!;
    };
    tryNext(0);
  });
}

function monsterSelectHtml(): string {
  const players = state?.players ?? [];
  // Highlight ANY player's current pick (this is a shared screen — a caller who picked by VOICE must
  // see their square light up even though they have no browser + no local myId). Map monsterId → who
  // picked it, so a voice pick highlights just like a tap.
  const pickedBy = new Map<string, string[]>();
  for (const p of players) if (p.monsterId) pickedBy.set(p.monsterId, [...(pickedBy.get(p.monsterId) ?? []), p.name]);
  const anyPick = players.some(p => p.monsterId);
  const canBattle = !!state?.canStartBattle;
  const target = isDisplay && !joinedHere ? resolveTouchTarget(players) : myId;
  const targetPlayer = players.find(player => player.playerId === target);
  const picker = isDisplay && !joinedHere && players.some(player => !player.isAi)
    ? `<div class="vm-touch-picker" role="group" aria-label="${esc(text('select.touchTarget'))}">
        ${players.filter(player => !player.isAi).map(player => `
          <button type="button" class="vm-touch-player${target === player.playerId ? ' active' : ''}"
            data-touch-player="${esc(player.playerId)}" aria-pressed="${target === player.playerId}">
            ${esc(player.name)}${player.monsterId ? ` · ${esc(text('select.chosen'))}` : ''}
          </button>`).join('')}
      </div>` : '';
  // MINIMAL cards: portrait + name + type + (who picked it). Portrait starts as the placeholder;
  // upgradeSelectPortraits() swaps in a real GIF/PNG post-mount.
  const cards = roster.map(m => {
    const pickers = pickedBy.get(m.id) ?? [];
    const selected = pickers.length > 0;
    const typeLabel = monsterTypeLabel(m.type as MonsterType, locale);
    return `
    <button class="vm-mon t-${m.type}${selected ? ' sel' : ''}" data-mon="${m.id}"
      ${!target || !canDrive() ? 'disabled' : ''}
      aria-pressed="${targetPlayer?.monsterId === m.id}"
      aria-label="${esc(text('access.monsterOption', { name: m.name, type: typeLabel }))}">
      <div class="portrait"><img data-mon-portrait="${m.id}" src="${placeholderPortrait(m.id, m.type)}" alt=""></div>
      <div class="vm-mon-name">${esc(m.name)}</div>
      <div class="vm-type t-${m.type}">${typeLabel}</div>
      ${selected ? `<div class="vm-picked-by">${esc(pickers.join(' + '))}</div>` : ''}
    </button>`;
  }).join('');
  return `<div class="vm-card wide">
    ${brandHead(text('select.title'), text('select.subtitle'))}
    ${picker}
    <div class="vm-grid">${cards}</div>
    ${canDrive() && canBattle
      ? `<button class="vm-btn" data-act="advance">${text('select.battle')}</button>`
      : canDrive()
        ? `<div class="vm-dim">${anyPick ? text('select.waitingAll') : text('select.pickFirst')}</div>`
      : `<div class="vm-dim">${text('select.pick')}</div>`}
    ${canDrive() ? `<button class="vm-btn vm-btn-secondary" data-act="back">${text('select.back')}</button>` : ''}
  </div>`;
}

function resultsHtml(): string {
  const w = state?.result?.winnerName ?? text('results.nobody');
  const winningSide = state?.result?.winner;
  const winningMonster = winningSide === 'a' ? state?.snapshot?.a : winningSide === 'b' ? state?.snapshot?.b : null;
  const champion = winningMonster
    ? text('results.winningMonster', { monster: localizedMonsterName(locale, winningMonster.monsterId) }) : '';
  const action = stationDisplay.active
    ? `<p class="vm-result-next">${text('results.stationNext')}</p>`
    : !canOfferRematch()
      ? `<span class="vm-dim">${text('results.goodBattle')}</span>`
      : `<button class="vm-btn" data-act="advance">${text('results.rematch')}</button>`;
  const exit = stationDisplay.active ? '' : `<a class="vm-btn vm-btn-ghost" href="/">${text('results.exit')}</a>`;
  return `<section class="vm-card vm-results${stationDisplay.active ? ' station-result' : ''}" role="dialog" aria-modal="true" aria-labelledby="vm-result-title">
    ${brandHead(text('lobby.title'), text('results.subtitle'))}
    <div class="vm-result-outcome">
      <span>${text('results.winner')}</span>
      <h1 id="vm-result-title" tabindex="-1">${esc(text('results.wins', { winner: w }))}</h1>
      ${champion ? `<p>${esc(champion)}</p>` : ''}
    </div>
    <div class="vm-result-actions">${action}${exit}</div>
    ${resultTechHtml('monsters', locale, { stationManaged: stationDisplay.active })}
  </section>`;
}

function wireOverlay(): void {
  overlay.querySelectorAll<HTMLElement>('[data-touch-player]').forEach(el =>
    el.onclick = () => {
      touchTargetPlayerId = el.dataset.touchPlayer!;
      lastOverlayKey = '';
      renderOverlay();
    });
  overlay.querySelectorAll<HTMLElement>('[data-mon]').forEach(el =>
    el.onclick = () => {
      if (isDisplay && !joinedHere) {
        const playerId = state && resolveTouchTarget(state.players);
        if (playerId) conn.displaySelectMonster(playerId, el.dataset.mon!);
      } else conn.selectMonster(el.dataset.mon!);
    });
  overlay.querySelectorAll<HTMLElement>('[data-act="advance"]').forEach(el =>
    el.onclick = () => { if (state?.phase !== 'results' || canOfferRematch()) conn.advance(); });
  overlay.querySelectorAll<HTMLElement>('[data-act="back"]').forEach(el =>
    el.onclick = () => conn.back());
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ── connect: display spectates, device joins ─────────────────────────────────────────────────────
// Matches Voice Racer's lobby model: the shared SCREEN defaults to a spectator (callers dial in as
// players), and the operator presses P to add/drop a KEYBOARD TESTER player on this screen. A device
// (phone browser) auto-joins as its own player. `joinedHere` = this client holds a player slot.
if (isDisplay) conn.spectate(roomCode, stationDisplay.displayToken ?? undefined);
else conn.join(roomCode, name);

/** Shared-screen P-toggle: opt IN as a keyboard tester player (adds a slot), or opt back OUT (drops it,
 *  stays the display). No-op on a device (already a player). */
function toggleSelfPlaying(): void {
  if (!isDisplay || stationDisplay.active) return;
  resultAuthorityFresh = false;
  if (joinedHere) { conn.leave(roomCode); joinedHere = false; }
  else conn.join(roomCode, name);
  lastOverlayKey = ''; renderOverlay();
}

// Keyboard: during MY choosing turn the command menu is two levels —
//   root: 1 ATTACK (→ opens the moves) · 2 GUARD · 3 ITEM (Potion) · 4 TAUNT
//   fight: 1–4 pick a move, 0 goes back to root.
// Lobby/select/results: P adds/drops a keyboard tester (shared screen); Enter advances the flow.
addEventListener('keydown', (e) => {
  if (awaitingContinue) { dismissContinue(); return; }   // battle-end hold → any key continues
  if (draining) return;
  if (state?.phase === 'battle' && currentUiPhase() === 'awaiting-input') {
    handleMenuKey(e.key);
  } else if ((e.key === 'p' || e.key === 'P') && isDisplay && state?.phase !== 'battle') {
    toggleSelfPlaying();
  } else if (e.key === 'Enter' && isDisplay && state?.phase !== 'battle'
    && (state?.phase !== 'results' || canOfferRematch())) {
    conn.advance();
  }
});
// Tap/click the stage to continue past the battle-end hold (phone-friendly, no keyboard needed).
stageEl.addEventListener('click', () => { if (awaitingContinue) dismissContinue(); });

/** Player acknowledged the win → drop the hold + clear the banner so the results modal appears. */
function dismissContinue(): void {
  awaitingContinue = false;
  renderer.setEventBanner('');
  lastOverlayKey = '';   // force the results overlay to (re)build now that the stage is hidden
  renderOverlay();
}

/** Drive the two-level command menu from a keypress. Thin: it maps keys → the SAME menu-action shape
 *  voice produces (openFight/back/guard/item/taunt/fight-move), then hands off to applyMenuAction so
 *  keyboard + voice share one nav/commit path. */
function handleMenuKey(key: string): void {
  if (!state?.snapshot) return;
  if (menuLevel === 'root') {
    if (key === '1') applyMenuAction({ kind: 'openFight' });
    else if (key === '2') applyMenuAction({ kind: 'guard' });
    else if (key === '3') applyMenuAction({ kind: 'item', item: 'potion' });
    else if (key === '4') applyMenuAction({ kind: 'taunt' });
    return;
  }
  // attack submenu
  if (key === '0' || key === 'Escape') { applyMenuAction({ kind: 'back' }); return; }
  if (/^[1-4]$/.test(key)) {
    const mv = mySnapMoves()[parseInt(key, 10) - 1];
    if (mv) applyMenuAction({ kind: 'fight', moveId: mv.id });
  }
}

/** Drive the same two-level menu from a SPOKEN utterance (Conversation Relay transcript). Voice reuses
 *  the SAME nav/commit path as the keyboard: we run the pure `matchBattleAction` matcher against the
 *  live snapshot (my 4 moves + potions + current level), then hand its result to applyMenuAction.
 *
 *  The live phone flow is server-driven, but this hook remains useful for device/browser speech tests
 *  and manual verification from the console (window.__battleVoice('guard')). */
export function handleVoiceUtterance(text: string): boolean {
  if (state?.phase !== 'battle' || currentUiPhase() !== 'awaiting-input') return false;
  if (!state.snapshot) return false;
  const action = matchBattleAction(text, {
    moves: mySnapMoves().map(m => ({ id: m.id, name: m.name })),
    potions: myPotions(),
    level: menuLevel,
  }, locale);
  if (!action) return false;   // unrecognized → caller stays put (server/relay may re-prompt)
  applyMenuAction(action);
  return true;
}
// Expose the voice hook for manual testing + the eventual relay wiring (see the seam note above).
(window as unknown as { __battleVoice?: (t: string) => boolean }).__battleVoice = handleVoiceUtterance;

/** The single nav/commit dispatcher SHARED by keyboard + voice. Nav results (openFight/back) just move
 *  the menu level; the four real actions commit the turn. ITEM is guarded on the potion count here too,
 *  so neither input path can spend a potion the player doesn't have. */
function applyMenuAction(action: BattleAction | { kind: 'openFight' } | { kind: 'back' }): void {
  switch (action.kind) {
    case 'openFight': menuLevel = 'fight'; conn.openFight(); paintBattle(); return;
    case 'back':      menuLevel = 'root';  conn.backMenu(); paintBattle(); return;
    case 'guard':     commitAction({ kind: 'guard' }, text('battle.lockGuard')); return;
    case 'taunt':     commitAction({ kind: 'taunt' }, text('battle.lockTaunt')); return;
    case 'item':      if (myPotions() > 0) commitAction({ kind: 'item', item: 'potion' }, text('battle.lockPotion')); return;
    case 'fight': {
      const mv = mySnapMoves().find(m => m.id === action.moveId);
      if (mv) commitAction({ kind: 'fight', moveId: mv.id }, mv.name);
      return;
    }
  }
}

/** My monster's current move list from the live snapshot (display/spectator falls back to A's moves,
 *  matching mySideMoves). Shared by the keyboard + voice menu logic. */
function mySnapMoves(): { id: string; name: string }[] {
  const snap = state?.snapshot; if (!snap) return [];
  const side = mySide(state!) ?? state!.activeSide ?? 'a';
  return (side === 'b' ? snap.b : snap.a).moves.map(m => ({ id: m.id, name: m.name }));
}

/** How many Potions the local player has left (greys out ITEM at 0). */
function myPotions(): number {
  const snap = state?.snapshot; if (!snap) return 0;
  const side = mySide(state!) ?? state!.activeSide ?? 'a';
  return side === 'b' ? snap.potions.b : snap.potions.a;
}

/** Commit a turn action + show the "locked, waiting…" beat. */
function commitAction(action: BattleAction, lockedLabel: string): void {
  lockedMoveName = lockedLabel;
  conn.chooseAction(action);
  paintBattle();
}

renderOverlay();
