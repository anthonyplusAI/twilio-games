import type { WizardChessSceneSnapshot } from '../../shared/chess-protocol';
import { WIZARD_CHESS_VICTORY_AT_MS } from '../../shared/wizard-chess-scene';
import { wizardPositionAfterMoves } from '../chess/wizard-scene-state';
import { ChessBoardScene } from '../chess/chess-board';
import { WizardSceneController } from '../chess/wizard-scene-controller';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = element<HTMLElement>('preview-status');
const dock = element<HTMLElement>('preview-dock');
const dockToggle = element<HTMLButtonElement>('preview-toggle');
const storyButton = element<HTMLButtonElement>('preview-story');
const readyButton = element<HTMLButtonElement>('preview-ready');
const moveButton = element<HTMLButtonElement>('preview-move');
const finaleButton = element<HTMLButtonElement>('preview-finale');

let sceneId = 0;
let current: WizardChessSceneSnapshot | null = null;
let board: ChessBoardScene | null = null;
let finaleDockTimer: ReturnType<typeof setTimeout> | null = null;

function setDockCollapsed(collapsed: boolean): void {
  dock.dataset.collapsed = String(collapsed);
  dockToggle.setAttribute('aria-expanded', String(!collapsed));
  dockToggle.textContent = collapsed ? 'Scene controls ▾' : 'Hide controls';
}

const controller = new WizardSceneController('en-US', {
  renderPosition() { /* The controller drives the real 3D board directly. */ },
  onActiveChange(active) { element<HTMLElement>('app').dataset.wizard = active ? 'active' : 'inactive'; },
  setMusicVolume() { /* The preview deliberately has no background soundtrack. */ },
  requestSkip(id) {
    if (current?.id === id && current.phase === 'story') queueMicrotask(jumpToReady);
  },
});

function setStatus(copy: string): void { status.textContent = copy; }

function showSnapshot(next: WizardChessSceneSnapshot): void {
  current = next;
  controller.update(next);
  moveButton.disabled = next.phase !== 'ready';
}

function newScene(phase: WizardChessSceneSnapshot['phase']): void {
  if (finaleDockTimer) clearTimeout(finaleDockTimer);
  finaleDockTimer = null;
  controller.update(null);
  const now = Date.now();
  const next: WizardChessSceneSnapshot = {
    id: ++sceneId, phase, startedAt: now,
    readyAt: phase === 'story' ? null : now,
    resolvedAt: phase === 'resolved' ? now : null,
  };
  showSnapshot(next);
}

function playStory(): void {
  newScene('story');
  setStatus('Scene playing. Watch the camera follow each speaker.');
  setDockCollapsed(true);
}

function jumpToReady(): void {
  if (current?.phase === 'story') {
    showSnapshot({ ...current, phase: 'ready', readyAt: Date.now() });
  } else newScene('ready');
  setStatus('Your turn. The local button stands in for Ron’s phone move.');
  setDockCollapsed(false);
}

function triggerRonMove(): void {
  if (current?.phase !== 'ready') return;
  showSnapshot({ ...current, phase: 'resolved', resolvedAt: Date.now() });
  setStatus('Ron’s knight is moving. Watch the sacrifice and checkmate.');
  setDockCollapsed(true);
  const id = current.id;
  finaleDockTimer = setTimeout(() => {
    if (current?.id === id && current.phase === 'resolved') {
      setStatus('Victory. Replay the finale or the full story.');
      setDockCollapsed(false);
    }
    finaleDockTimer = null;
  }, WIZARD_CHESS_VICTORY_AT_MS + 600);
}

function replayFinale(): void {
  newScene('ready');
  triggerRonMove();
}

storyButton.addEventListener('click', playStory);
dockToggle.addEventListener('click', () => setDockCollapsed(dock.dataset.collapsed !== 'true'));
readyButton.addEventListener('click', jumpToReady);
moveButton.addEventListener('click', triggerRonMove);
finaleButton.addEventListener('click', replayFinale);
moveButton.disabled = true;

try {
  board = new ChessBoardScene(element<HTMLElement>('board-stage'));
  (window as Window & { __wizardPreviewBoard?: ChessBoardScene }).__wizardPreviewBoard = board;
  board.setTheme('light');
  board.setHumanColor('w');
  board.setWizardMode(true);
  board.setPosition(wizardPositionAfterMoves(0));
  board.setWizardShot('wide', { cut: true });
  controller.attachBoard(board);
  controller.prefetchOpeningVoice();
  board.setAvailabilityHandler(available => {
    document.body.dataset.renderer = available ? 'three' : 'fallback';
    if (!available) setStatus('WebGL is unavailable in this browser. Try a desktop browser.');
    else if (!current) setStatus('Ready. Select “Play / replay story” to begin.');
  });
} catch (error) {
  console.error('The local Wizard Chess preview could not start.', error);
  setStatus('The 3D board could not start. Check WebGL and the local dev server.');
  storyButton.disabled = true;
  readyButton.disabled = true;
  finaleButton.disabled = true;
}

window.addEventListener('pagehide', () => {
  if (finaleDockTimer) clearTimeout(finaleDockTimer);
  controller.dispose();
  board?.dispose();
  delete (window as Window & { __wizardPreviewBoard?: ChessBoardScene }).__wizardPreviewBoard;
}, { once: true });
