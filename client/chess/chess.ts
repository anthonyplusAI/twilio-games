import QRCode from 'qrcode';
import { DEFAULT_ROOM } from '../../shared/constants';
import type { ChessColor, ChessEvent, ChessMoveRecord, ChessPiecePlacement,
  ChessPieceType, ChessResult, ChessState } from '../../shared/chess-protocol';
import { locale } from '../i18n';
import { createStationDisplay } from '../station-display';
import { rejectDisplayToken, watchVoiceNumber } from '../station-client';
import { wireFullscreenToggle } from '../fullscreen-toggle';
import { getMusicManager } from '../music-manager';
import type { ChessBoardScene } from './chess-board';
import { ChessConnection, chessWebSocketUrl, type ChessConnectionState } from './chess-net';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const app = element<HTMLDivElement>('app');
const boardStage = element<HTMLDivElement>('board-stage');
const fallback = element<HTMLDivElement>('fallback-board');
const accessibleBoard = element<HTMLTableElement>('accessible-board');
const connectionStatus = element<HTMLSpanElement>('connection-status');
const musicButton = element<HTMLButtonElement>('music-button');
const musicLabel = element<HTMLSpanElement>('music-label');
const statusTitle = element<HTMLHeadingElement>('status-title');
const statusDetail = element<HTMLParagraphElement>('status-detail');
const callCard = element<HTMLElement>('call-card');
const callCardInstructions = element<HTMLParagraphElement>('call-card-instructions');
const callCardQrFrame = element<HTMLDivElement>('call-card-qr-frame');
const callCardQr = element<HTMLImageElement>('call-card-qr');
const callCardNumber = element<HTMLAnchorElement>('call-card-number');
const callCardAvailability = element<HTMLParagraphElement>('call-card-availability');
const turnLabel = element<HTMLSpanElement>('turn-label');
const prompt = element<HTMLDivElement>('move-prompt');
const lastMoveLabel = element<HTMLElement>('last-move');
const mobileLastMove = element<HTMLElement>('mobile-last-move');
const lastCaption = element<HTMLParagraphElement>('last-caption');
const humanLabel = element<HTMLSpanElement>('human-label');
const computerLabel = element<HTMLSpanElement>('computer-label');
const eventBanner = element<HTMLDivElement>('event-banner');
const resultOverlay = element<HTMLDivElement>('result-overlay');
const resultTitle = element<HTMLElement>('result-title');
const resultDetail = element<HTMLParagraphElement>('result-detail');
const resultKicker = element<HTMLSpanElement>('result-kicker');
const resultReplay = element<HTMLButtonElement>('result-replay');
const liveAnnouncer = element<HTMLDivElement>('live-announcer');
const page = new URL(location.href);
const params = page.searchParams;
const roomCode = params.get('room') || DEFAULT_ROOM;
const stationLaunchRequested = params.has('station') || params.has('match') || params.has('launchGeneration');
const stationDisplay = createStationDisplay();
const isPortuguese = locale === 'pt-BR';
const music = getMusicManager();

let board: ChessBoardScene | null = null;
let connection: ChessConnection | null = null;
let connectionState: ChessConnectionState = 'connecting';
let latestState: ChessState | null = null;
let visualState: ChessState | null = null;
let processingBoard = false;
let transportError = '';
let lastFeedbackSequence = -1;
let lastAnnouncedMove = '';
let lastResultKey = '';
let bannerTimer: ReturnType<typeof setTimeout> | null = null;
let essentialVisualReady = false;
let hasRenderedRoomState = false;
let stationReadyMarked = false;
let phoneNumber = '';
let phoneQr = '';
let phoneQrFailed = false;
let phoneQrGeneration = 0;
let pageClosing = false;
const boardQueue: ChessState[] = [];

document.documentElement.lang = locale;
document.title = isPortuguese ? 'Xadrez por Voz · Twilio Games' : 'Voice Chess · Twilio Games';
localizeStaticCopy();
const stopVoiceNumberUpdates = stationLaunchRequested || stationDisplay.active ? null
  : watchVoiceNumber(locale, number => {
    const nextNumber = number.trim();
    if (nextNumber === phoneNumber && !phoneQrFailed) return;
    const generation = ++phoneQrGeneration;
    phoneNumber = nextNumber;
    phoneQr = '';
    phoneQrFailed = false;
    renderCallCard();
    if (!phoneNumber) return;
    void QRCode.toDataURL(`tel:${phoneNumber}`, {
      width: 520, margin: 1, errorCorrectionLevel: 'M',
      color: { dark: '#000D25', light: '#FFFFFF' },
    }).then(qr => {
      if (generation !== phoneQrGeneration) return;
      phoneQr = qr;
      renderCallCard();
    }).catch(() => {
      if (generation !== phoneQrGeneration) return;
      phoneQrFailed = true;
      renderCallCard();
    });
  });
music.setVolume(0.52);
music.switchContext('chess');
renderMusicButton();
setTimeout(renderMusicButton, 120);
musicButton.addEventListener('click', () => void toggleMusic());
resultReplay.addEventListener('click', () => {
  if (connectionState !== 'connected' || latestState?.phase !== 'finished'
    || latestState.canReplayOnDisplay !== true) return;
  connection?.replay(latestState.gameId);
});
addEventListener('pointerdown', event => {
  if ((event.target as Element | null)?.closest?.('#music-button')) return;
  void unlockMusic();
}, { once: true, passive: true });
addEventListener('keydown', event => {
  if ((event.target as Element | null)?.closest?.('#music-button')) return;
  void unlockMusic();
}, { once: true });
wireFullscreenToggle(element<HTMLButtonElement>('fullscreen-button'), {
  enter: isPortuguese ? 'Tela cheia' : 'Enter fullscreen',
  exit: isPortuguese ? 'Sair da tela cheia' : 'Exit fullscreen',
});

// Keep the live 2D board visible while the larger Three.js chunk arrives. A
// slow asset connection no longer delays room status or the first playable view.
void loadChessScene();

async function loadChessScene(): Promise<void> {
  try {
    const { ChessBoardScene } = await import('./chess-board');
    if (pageClosing) return;
    const scene = new ChessBoardScene(boardStage);
    const current = latestState ?? visualState;
    if (current) synchronizeScene(scene, current);
    board = scene;
    scene.setAvailabilityHandler(available => {
      document.body.dataset.renderer = available ? 'three' : 'fallback';
      fallback.hidden = available;
    });
  } catch (error) {
    console.warn('Voice Chess is showing its live 2D board because WebGL is unavailable.', error);
    document.body.dataset.renderer = 'fallback';
    fallback.hidden = false;
  }
}

function synchronizeScene(scene: ChessBoardScene, current: ChessState): void {
  scene.setHumanColor(current.humanColor);
  scene.setPosition(current.pieces);
  scene.setLastMove(current.lastMove?.from ?? null, current.lastMove?.to ?? null);
  const checkedKing = current.lastMove?.check
    ? current.pieces.find(piece => piece.type === 'k' && piece.color === current.turn)?.square ?? null : null;
  scene.setCheck(checkedKing);
  scene.setPendingMove(current.pendingMove?.from ?? null, current.pendingMove?.to ?? null);
  scene.setSelection(current.selection?.from ?? null);
}

if (stationLaunchRequested && !stationDisplay.displayToken) {
  transportError = isPortuguese
    ? 'Esta tela precisa ser vinculada novamente à estação.'
    : 'This display needs to be paired with the station again.';
  connectionState = 'closed';
  renderConnection();
  renderStatus();
} else {
  try {
    connection = new ChessConnection(chessWebSocketUrl(location), roomCode,
      stationLaunchRequested ? stationDisplay.displayToken : null, locale);
    connection.onState(receiveState);
    connection.onEvents(receiveEvents);
    connection.onError((code, message) => {
      if (code === 'bad_display_auth') {
        if (stationLaunchRequested) rejectDisplayToken(stationDisplay.displayToken);
        connection?.close();
        transportError = stationLaunchRequested
          ? isPortuguese
            ? 'A vinculação da estação expirou. Volte para a estação e abra o jogo novamente.'
            : 'Station pairing expired. Return to the station and open the game again.'
          : isPortuguese
            ? 'Esta sala pertence a uma estação. Abra o Xadrez por Voz na página de jogos.'
            : 'This room belongs to a station. Open Voice Chess from the games page.';
      } else transportError = message;
      renderStatus();
    });
    connection.onConnection(next => {
      connectionState = next;
      if (next === 'connected') transportError = '';
      renderConnection();
      renderStatus();
    });
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
    connectionState = 'closed';
    renderConnection();
    renderStatus();
  }
}

renderConnection();
renderStatus();
void (document.fonts?.ready ?? Promise.resolve()).then(() => new Promise<void>(resolve => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
})).then(() => {
  essentialVisualReady = true;
  maybeMarkStationReady();
});

addEventListener('pagehide', () => {
  pageClosing = true;
  if (bannerTimer) clearTimeout(bannerTimer);
  phoneQrGeneration += 1;
  stopVoiceNumberUpdates?.();
  connection?.close();
  board?.dispose();
  music.stop();
}, { once: true });

function receiveEvents(events: readonly ChessEvent[]): void {
  // State snapshots are the single board authority. Events only add timely spoken feedback.
  for (const event of events) {
    if (event.type === 'feedback' && event.feedback.sequence > lastFeedbackSequence) {
      lastFeedbackSequence = event.feedback.sequence;
      liveAnnouncer.textContent = event.feedback.text;
    }
  }
}

function receiveState(next: ChessState): void {
  if (!validRoomState(next)) return;
  const previous = latestState;
  if (previous && (next.gameId !== previous.gameId || next.revision < previous.revision
    || next.ply < previous.ply)) {
    lastFeedbackSequence = -1;
    lastAnnouncedMove = '';
    liveAnnouncer.textContent = '';
    eventBanner.classList.remove('show');
  }
  latestState = next;
  renderConnection();
  renderStatus();
  renderMoveNote();
  renderSides();
  announceState(next, previous);
  boardQueue.push(next);
  if (boardQueue.length > 8) boardQueue.splice(0, boardQueue.length - 1);
  void processBoardQueue();
}

async function processBoardQueue(): Promise<void> {
  if (processingBoard) return;
  processingBoard = true;
  try {
    while (boardQueue.length) {
      const next = boardQueue.shift()!;
      const previous = visualState;
      board?.setHumanColor(next.humanColor);
      const sameGame = previous?.gameId === next.gameId;
      const oneMove = sameGame && previous !== null && next.ply === previous.ply + 1
        && next.lastMove?.ply === next.ply && next.lastMove.revision === next.revision;
      if (oneMove && next.lastMove) {
        if (next.lastMove.captured) {
          bannerTimer = setTimeout(() => {
            if (latestState?.gameId === next.gameId && latestState.ply >= next.ply) showCaptureBanner(next.lastMove!);
          }, 670);
        }
        await board?.animateTo(next.pieces, next.lastMove);
      } else if (!previous || !sameGame || previous.fen !== next.fen || previous.ply !== next.ply) {
        board?.setPosition(next.pieces);
        board?.setLastMove(next.lastMove?.from ?? null, next.lastMove?.to ?? null);
        const checkedKing = next.lastMove?.check
          ? next.pieces.find(piece => piece.type === 'k' && piece.color === next.turn)?.square ?? null : null;
        board?.setCheck(checkedKing);
      }
      visualState = next;
      board?.setPendingMove(next.pendingMove?.from ?? null, next.pendingMove?.to ?? null);
      board?.setSelection(next.selection?.from ?? null);
      renderAccessiblePosition(next);
      hasRenderedRoomState = true;
      maybeMarkStationReady();
      renderResult(next);
    }
  } finally {
    processingBoard = false;
    if (boardQueue.length) void processBoardQueue();
  }
}

function maybeMarkStationReady(): void {
  if (!stationDisplay.active || stationReadyMarked || !essentialVisualReady || !hasRenderedRoomState) return;
  stationReadyMarked = true;
  stationDisplay.markEngineReady();
}

function validRoomState(state: ChessState): boolean {
  if (typeof state.roomCode !== 'string' || state.roomCode.toUpperCase() !== roomCode.trim().toUpperCase()
    || !Number.isSafeInteger(state.gameId) || state.gameId < 1
    || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Number.isSafeInteger(state.ply) || state.ply < 0
    || !['waiting', 'playing', 'pending', 'finished'].includes(state.phase)
    || !['w', 'b'].includes(state.humanColor) || !['w', 'b'].includes(state.turn)
    || typeof state.fen !== 'string' || !Array.isArray(state.pieces) || state.pieces.length > 32) return false;
  const squares = new Set<string>();
  for (const piece of state.pieces) {
    if (!piece || !/^[a-h][1-8]$/.test(piece.square) || squares.has(piece.square)
      || !['w', 'b'].includes(piece.color) || !['p', 'n', 'b', 'r', 'q', 'k'].includes(piece.type)) return false;
    squares.add(piece.square);
  }
  return true;
}

function renderConnection(): void {
  connectionStatus.dataset.state = connectionState;
  const label = connectionState === 'connected'
    ? latestState?.playerConnected
      ? isPortuguese ? 'Telefone conectado' : 'Phone connected'
      : isPortuguese ? 'Tabuleiro conectado' : 'Board connected'
    : connectionState === 'reconnecting'
      ? isPortuguese ? 'Reconectando' : 'Reconnecting'
      : connectionState === 'closed'
        ? isPortuguese ? 'Desconectado' : 'Disconnected'
        : isPortuguese ? 'Conectando' : 'Connecting';
  connectionStatus.querySelector('span')!.textContent = label;
  resultReplay.disabled = connectionState !== 'connected';
}

function renderStatus(): void {
  const state = latestState;
  let title: string;
  let detail: string;
  let label: string;
  let hint: string;
  if (transportError) {
    title = isPortuguese ? 'A câmara está em silêncio' : 'The chamber is quiet';
    detail = transportError;
    label = isPortuguese ? 'Conexão' : 'Connection';
    hint = isPortuguese ? 'A posição será atualizada quando a conexão voltar.' : 'The board will update when the connection returns.';
  } else if (!state) {
    title = isPortuguese ? 'Abrindo a câmara' : 'Opening the chamber';
    detail = isPortuguese ? 'Preparando seu tabuleiro de xadrez.' : 'Preparing your chess board.';
    label = isPortuguese ? 'Canal de voz' : 'Voice channel';
    hint = isPortuguese ? 'Diga uma peça e uma casa na chamada; depois confirme.'
      : 'Say a piece and square on your call, then confirm the move.';
  } else if (connectionState !== 'connected') {
    title = isPortuguese ? 'Reconectando' : 'Reconnecting';
    detail = isPortuguese ? 'A posição atual continua no tabuleiro.' : 'Your last known position remains on the board.';
    label = isPortuguese ? 'Canal de voz' : 'Voice channel';
    hint = isPortuguese ? 'Aguarde a conexão voltar.' : 'Waiting for the voice link to return.';
  } else if (state.phase === 'waiting' || !state.playerConnected) {
    title = isPortuguese ? 'Aguardando sua chamada' : 'Awaiting your call';
    detail = isPortuguese ? 'Seu duelo começa assim que a chamada estiver conectada.'
      : 'Your duel begins as soon as your call connects.';
    label = isPortuguese ? 'Câmara pronta' : 'Chamber ready';
    hint = isPortuguese ? 'Use o telefone para falar seus lances.' : 'Speak your moves through your phone.';
  } else if (state.phase === 'pending' && state.pendingMove) {
    title = isPortuguese ? 'Confirme seu lance' : 'Confirm your move';
    detail = isPortuguese
      ? `${pieceName(state.pendingMove.piece)} para ${state.pendingMove.to.toUpperCase()}.`
      : `${capitalize(pieceName(state.pendingMove.piece))} to ${state.pendingMove.to.toUpperCase()}.`;
    label = isPortuguese ? 'Feitiço preparado' : 'Spell prepared';
    hint = isPortuguese ? 'Diga “confirmar” na chamada, ou “cancelar” para escolher outro lance.'
      : 'Say “confirm” on your call, or “cancel” to choose another move.';
  } else if (state.phase === 'finished') {
    title = isPortuguese ? 'Duelo encerrado' : 'Duel complete';
    detail = resultSummary(state.result, state.humanColor);
    label = isPortuguese ? 'Resultado final' : 'Final result';
    hint = isPortuguese ? 'O tabuleiro mostra a posição final.' : 'The board shows the final position.';
  } else if (state.turn === state.humanColor) {
    title = isPortuguese ? 'Sua vez' : 'Your move';
    detail = state.selection?.piece
      ? isPortuguese
        ? `${pieceName(state.selection.piece)} selecionado${state.selection.from ? ` em ${state.selection.from.toUpperCase()}` : ''}. Diga a casa de destino.`
        : `${capitalize(pieceName(state.selection.piece))} selected${state.selection.from ? ` on ${state.selection.from.toUpperCase()}` : ''}. Say its destination.`
      : isPortuguese ? 'O tabuleiro está ouvindo pelo telefone.' : 'The board is listening through your phone.';
    label = isPortuguese ? 'Sua jogada' : 'Your turn';
    hint = isPortuguese ? 'Diga a peça e a casa de destino. Depois confirme o lance.'
      : 'Say a piece and its destination square. Then confirm the move.';
  } else {
    title = isPortuguese ? 'O arquimago joga' : 'The Archmage moves';
    detail = isPortuguese ? 'Seu rival está escolhendo um lance.' : 'Your rival is choosing a move.';
    label = isPortuguese ? 'Vez do rival' : 'Rival’s turn';
    hint = isPortuguese ? 'O telefone anunciará o próximo lance.' : 'Your phone will announce the next move.';
  }
  if (state?.feedback && ['illegal', 'ambiguous', 'unknown', 'help', 'not_your_turn', 'stale'].includes(state.feedback.code)) {
    detail = state.feedback.text;
  }
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
  turnLabel.textContent = label;
  prompt.textContent = hint;
  app.dataset.phase = state?.phase ?? 'connecting';
  renderCallCard();
}

function renderCallCard(): void {
  const waitingForCaller = !stationLaunchRequested && !stationDisplay.active
    && connectionState === 'connected' && !transportError
    && latestState !== null && latestState.phase !== 'finished' && !latestState.playerConnected;
  callCard.hidden = !waitingForCaller;
  app.dataset.callCard = waitingForCaller ? 'visible' : 'hidden';
  if (!waitingForCaller) return;

  callCardInstructions.hidden = !phoneNumber;
  callCardInstructions.textContent = phoneQr
    ? isPortuguese ? 'Escaneie com o celular ou toque no número.' : 'Scan with your phone or tap the number.'
    : isPortuguese ? 'Toque no número para ligar e começar.' : 'Tap the number to call and start.';
  callCard.dataset.qr = phoneQr ? 'ready' : 'missing';
  callCardQrFrame.hidden = !phoneQr;
  if (phoneQr) callCardQr.src = phoneQr;
  else callCardQr.removeAttribute('src');

  callCardNumber.hidden = !phoneNumber;
  if (phoneNumber) {
    callCardNumber.href = `tel:${phoneNumber}`;
    callCardNumber.textContent = phoneNumber;
    callCardNumber.setAttribute('aria-label', isPortuguese
      ? `Ligar para jogar Xadrez por Voz: ${phoneNumber}` : `Call to play Voice Chess: ${phoneNumber}`);
  } else {
    callCardNumber.removeAttribute('href');
    callCardNumber.textContent = '';
  }
  callCardAvailability.hidden = !!phoneQr;
  callCardAvailability.textContent = !phoneNumber
    ? isPortuguese ? 'A linha de voz não está disponível no momento.' : 'The voice line is unavailable right now.'
    : phoneQrFailed
      ? isPortuguese ? 'QR indisponível. Use o número exibido.' : 'QR unavailable. Use the number shown.'
      : isPortuguese ? 'Preparando o código para ligar…' : 'Preparing your call code…';
}

function renderSides(): void {
  if (!latestState) return;
  const human = latestState.humanColor;
  humanLabel.textContent = isPortuguese
    ? `Você · ${human === 'w' ? 'Brancas' : 'Pretas'}`
    : `You · ${human === 'w' ? 'White' : 'Black'}`;
  computerLabel.textContent = isPortuguese
    ? `O Arquimago · ${human === 'w' ? 'Pretas' : 'Brancas'}`
    : `The Archmage · ${human === 'w' ? 'Black' : 'White'}`;
}

function renderMoveNote(): void {
  const move = latestState?.lastMove;
  const notation = move
    ? `${move.actor === 'human' ? isPortuguese ? 'Você' : 'You' : isPortuguese ? 'Arquimago' : 'Archmage'} · ${move.san}`
    : isPortuguese ? 'Nenhum lance ainda' : 'No moves yet';
  lastMoveLabel.textContent = notation;
  mobileLastMove.textContent = notation;
  lastCaption.textContent = move ? moveCaption(move)
    : isPortuguese ? 'As peças aguardam o primeiro comando.' : 'The pieces await their first command.';
}

function renderResult(state: ChessState): void {
  if (state.phase !== 'finished' || !state.result) {
    resultOverlay.hidden = true;
    lastResultKey = '';
    return;
  }
  const key = `${state.gameId}:${state.ply}:${state.result.reason}`;
  const humanWon = state.result.winner === null ? null : state.result.winner === state.humanColor;
  resultOverlay.dataset.result = humanWon === null ? 'draw' : humanWon ? 'win' : 'loss';
  resultKicker.textContent = isPortuguese ? 'Duelo encerrado' : 'Duel complete';
  resultTitle.textContent = humanWon === null
    ? isPortuguese ? 'Empate' : 'Draw'
    : humanWon ? isPortuguese ? 'Vitória' : 'Victory' : isPortuguese ? 'Derrota' : 'Defeat';
  resultDetail.textContent = resultSummary(state.result, state.humanColor);
  resultReplay.hidden = state.canReplayOnDisplay !== true || stationLaunchRequested || stationDisplay.active;
  resultReplay.disabled = connectionState !== 'connected';
  resultOverlay.hidden = false;
  stationDisplay.markEngineResultsReady();
  if (lastResultKey !== key) {
    lastResultKey = key;
    board?.showResult(humanWon);
    liveAnnouncer.textContent = `${resultTitle.textContent}. ${resultDetail.textContent}`;
  }
}

function announceState(next: ChessState, previous: ChessState | null): void {
  if (next.feedback && next.feedback.sequence > lastFeedbackSequence) {
    lastFeedbackSequence = next.feedback.sequence;
    liveAnnouncer.textContent = next.feedback.text;
  }
  const key = next.lastMove ? `${next.gameId}:${next.lastMove.ply}` : '';
  if (key && key !== lastAnnouncedMove && previous?.gameId === next.gameId && next.ply === previous.ply + 1) {
    lastAnnouncedMove = key;
    liveAnnouncer.textContent = moveCaption(next.lastMove!);
  }
}

function showCaptureBanner(move: ChessMoveRecord): void {
  if (!move.captured || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const victim = capitalize(pieceName(move.captured));
  eventBanner.textContent = move.actor === 'human'
    ? isPortuguese ? `${victim} destruído!` : `${victim} shattered!`
    : isPortuguese ? `Seu ${pieceName(move.captured)} caiu!` : `Your ${pieceName(move.captured)} falls!`;
  eventBanner.classList.remove('show');
  void eventBanner.offsetWidth;
  eventBanner.classList.add('show');
}

function renderAccessiblePosition(state: ChessState): void {
  const positions = new Map<string, ChessPiecePlacement>(state.pieces.map(piece => [piece.square, piece]));
  const files = state.humanColor === 'w' ? 'abcdefgh' : 'hgfedcba';
  const ranks = state.humanColor === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const symbols: Record<ChessColor, Record<ChessPieceType, string>> = {
    w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
    b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' },
  };
  const body = accessibleBoard.tBodies[0] ?? accessibleBoard.createTBody();
  body.replaceChildren();
  for (const rank of ranks) {
    const row = document.createElement('tr');
    for (const file of files) {
      const square = `${file}${rank}`;
      const piece = positions.get(square);
      const cell = document.createElement('td');
      cell.className = (('abcdefgh'.indexOf(file) + rank) % 2 ? 'dark' : 'light')
        + (state.lastMove?.to === square ? ' last' : '')
        + (state.selection?.from === square ? ' selected' : '')
        + (state.pendingMove?.from === square ? ' pending-from' : '')
        + (state.pendingMove?.to === square ? ' pending-to' : '');
      cell.dataset.square = square.toUpperCase();
      if (piece) {
        const glyph = document.createElement('span');
        glyph.className = `fallback-piece ${piece.color === 'w' ? 'ivory' : 'obsidian'}`;
        glyph.textContent = symbols[piece.color][piece.type];
        cell.append(glyph);
      }
      cell.setAttribute('aria-label', piece
        ? isPortuguese
          ? `${capitalize(pieceName(piece.type))} das ${piece.color === 'w' ? 'brancas' : 'pretas'} em ${square.toUpperCase()}`
          : `${piece.color === 'w' ? 'White' : 'Black'} ${pieceName(piece.type)} on ${square.toUpperCase()}`
        : isPortuguese ? `${square.toUpperCase()}, casa vazia` : `${square.toUpperCase()}, empty`);
      row.append(cell);
    }
    body.append(row);
  }
}

function pieceName(piece: ChessPieceType): string {
  const english: Record<ChessPieceType, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const portuguese: Record<ChessPieceType, string> = { p: 'peão', n: 'cavalo', b: 'bispo', r: 'torre', q: 'rainha', k: 'rei' };
  return (isPortuguese ? portuguese : english)[piece];
}

function capitalize(value: string): string { return value[0]!.toUpperCase() + value.slice(1); }

function localizeStaticCopy(): void {
  if (!isPortuguese) return;
  element<HTMLDivElement>('game-brand').setAttribute('aria-label', 'Xadrez por Voz da Twilio');
  element<HTMLElement>('brand-name').textContent = 'Xadrez por Voz';
  element<HTMLElement>('brand-subtitle').textContent = 'O Gambito de Mármore';
  const home = element<HTMLAnchorElement>('game-home');
  home.setAttribute('aria-label', 'Voltar à página de jogos da Twilio');
  home.title = 'Voltar à página de jogos da Twilio';
  element<HTMLElement>('game-home-label').textContent = 'Voltar';
  humanLabel.textContent = 'Você · Marfim';
  computerLabel.textContent = 'O Arquimago · Obsidiana';
  element<HTMLElement>('mobile-last-label').textContent = 'Último lance';
  element<HTMLElement>('last-spell-label').textContent = 'O último feitiço';
  element<HTMLElement>('call-card-kicker').textContent = 'SEU DUELO AGUARDA';
  element<HTMLElement>('call-card-title').textContent = 'Ligue para jogar';
  element<HTMLElement>('call-card-instructions').textContent = 'Escaneie com o celular ou toque no número.';
  callCardQr.alt = 'Escaneie para ligar e jogar Xadrez por Voz';
  element<HTMLElement>('camera-hint-pointer').textContent = 'Arraste para girar · botão direito para mover · rolagem para ampliar · clique duplo para centralizar';
  element<HTMLElement>('camera-hint-touch').textContent = 'Um dedo gira · dois dedos movem ou ampliam';
  lastMoveLabel.textContent = 'Nenhum lance ainda';
  lastCaption.textContent = 'As peças aguardam o primeiro comando.';
  resultKicker.textContent = 'Duelo encerrado';
  resultTitle.textContent = 'Vitória';
  resultReplay.textContent = 'Jogar de novo';
  element<HTMLElement>('fallback-explanation').textContent = 'Tabuleiro ao vivo · modo 2D';
  accessibleBoard.setAttribute('aria-label', 'Tabuleiro de xadrez ao vivo');
}

function moveCaption(move: ChessMoveRecord): string {
  const to = move.to.toUpperCase();
  const actor = move.actor === 'human';
  if (move.captured) {
    if (isPortuguese) return actor
      ? `Seu ${pieceName(move.piece)} destruiu ${pieceName(move.captured)} do Arquimago em ${to}.`
      : `Seu ${pieceName(move.captured)} caiu diante de ${pieceName(move.piece)} do Arquimago em ${to}.`;
    return actor
      ? `Your ${pieceName(move.piece)} shattered the Archmage’s ${pieceName(move.captured)} on ${to}.`
      : `Your ${pieceName(move.captured)} fell to the Archmage’s ${pieceName(move.piece)} on ${to}.`;
  }
  if (move.castle) return actor
    ? isPortuguese ? 'Você fez o roque.' : 'You castled.'
    : isPortuguese ? 'O Arquimago fez o roque.' : 'The Archmage castled.';
  const promotion = move.promotion
    ? isPortuguese ? ` e virou ${pieceName(move.promotion)}` : ` and became a ${pieceName(move.promotion)}` : '';
  const check = move.checkmate
    ? isPortuguese ? ' Xeque-mate.' : ' Checkmate.'
    : move.check ? isPortuguese ? ' Xeque.' : ' Check.' : '';
  return isPortuguese
    ? `${actor ? 'Você moveu' : 'O Arquimago moveu'} ${pieceName(move.piece)} para ${to}${promotion}.${check}`
    : `${actor ? 'You moved' : 'The Archmage moved'} ${pieceName(move.piece)} to ${to}${promotion}.${check}`;
}

function resultSummary(result: ChessResult | null, humanColor: ChessColor): string {
  if (!result) return isPortuguese ? 'A posição final está no tabuleiro.' : 'The final position is on the board.';
  if (result.winner === null) {
    const reason: Record<ChessResult['reason'], string> = isPortuguese
      ? { checkmate: 'Xeque-mate', stalemate: 'Afogamento', threefold_repetition: 'Repetição de posição',
          fifty_move: 'Regra dos cinquenta lances', insufficient_material: 'Material insuficiente', draw: 'Empate' }
      : { checkmate: 'Checkmate', stalemate: 'Stalemate', threefold_repetition: 'Threefold repetition',
          fifty_move: 'Fifty-move rule', insufficient_material: 'Insufficient material', draw: 'Draw' };
    return isPortuguese ? `Empate por ${reason[result.reason].toLowerCase()}.`
      : `A draw by ${reason[result.reason].toLowerCase()}.`;
  }
  const humanWon = result.winner === humanColor;
  if (result.reason === 'checkmate') return isPortuguese
    ? humanWon ? 'Você deu xeque-mate no Arquimago.' : 'O Arquimago deu xeque-mate.'
    : humanWon ? 'You checkmated the Archmage.' : 'The Archmage delivered checkmate.';
  return isPortuguese
    ? humanWon ? 'Você venceu o duelo.' : 'O Arquimago venceu o duelo.'
    : humanWon ? 'You won the duel.' : 'The Archmage won the duel.';
}

async function toggleMusic(): Promise<void> {
  if (music.getIsMuted()) {
    music.unmute();
    await music.playFromGesture();
  } else if (music.getIsAudible()) music.mute();
  else await music.playFromGesture();
  renderMusicButton();
}

async function unlockMusic(): Promise<void> {
  if (music.getIsMuted() || music.getIsAudible()) return;
  await music.playFromGesture();
  renderMusicButton();
}

function renderMusicButton(): void {
  const muted = music.getIsMuted();
  const audible = music.getIsAudible();
  const state = muted ? 'muted' : audible ? 'playing' : 'blocked';
  musicButton.dataset.state = state;
  const label = muted
    ? isPortuguese ? 'Música desligada' : 'Music off'
    : audible ? isPortuguese ? 'Música ligada' : 'Music on'
      : isPortuguese ? 'Ativar música' : 'Play music';
  musicButton.title = label;
  musicButton.setAttribute('aria-label', label);
  musicButton.setAttribute('aria-pressed', String(audible));
  musicLabel.textContent = muted ? isPortuguese ? 'Sem música' : 'Music off'
    : audible ? isPortuguese ? 'Música' : 'Music on'
      : isPortuguese ? 'Ativar' : 'Play music';
}
