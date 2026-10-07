import type { ChessPieceType, ChessSquare } from '../../shared/chess-protocol';
import { WIZARD_CHESS_PRE_RON_FEN, WIZARD_CHESS_SEQUENCE } from '../../shared/wizard-chess-scene';
import type { BoardMove, BoardPiece } from './chess-board';

/** This five-move scene is fixed, so its display does not need the chess.js
 * engine in the initial page bundle. Tests validate every step against chess.js. */
function positionFromFen(fen: string): BoardPiece[] {
  const rows = fen.split(' ')[0]!.split('/');
  if (rows.length !== 8) throw new Error('Invalid Wizard Chess starting position');
  const position: BoardPiece[] = [];
  rows.forEach((row, rowIndex) => {
    let file = 0;
    for (const mark of row) {
      if (/^[1-8]$/.test(mark)) { file += Number(mark); continue; }
      const type = mark.toLowerCase() as ChessPieceType;
      if (!'pnbrqk'.includes(type) || file > 7) throw new Error('Invalid Wizard Chess piece');
      position.push({ square: `${'abcdefgh'[file]}${8 - rowIndex}` as ChessSquare,
        color: mark === mark.toUpperCase() ? 'w' : 'b', type });
      file++;
    }
    if (file !== 8) throw new Error('Invalid Wizard Chess rank');
  });
  return position;
}

function afterStep(before: readonly BoardPiece[], index: number): BoardPiece[] {
  const step = WIZARD_CHESS_SEQUENCE[index]!;
  const actor = before.find(piece => piece.square === step.from);
  if (!actor || actor.type !== step.piece || actor.color !== step.color) {
    throw new Error(`Wizard Chess actor missing for ${step.id}`);
  }
  return [...before.filter(piece => piece.square !== step.from && piece.square !== step.to),
    { ...actor, square: step.to }].sort((a, b) =>
    Number(b.square[1]) - Number(a.square[1]) || a.square.charCodeAt(0) - b.square.charCodeAt(0));
}

const positions: readonly (readonly BoardPiece[])[] = (() => {
  const sequence: BoardPiece[][] = [positionFromFen(WIZARD_CHESS_PRE_RON_FEN)];
  WIZARD_CHESS_SEQUENCE.forEach((_step, index) => sequence.push(afterStep(sequence[index]!, index)));
  return sequence;
})();

export function wizardPositionAfterMoves(count: number): BoardPiece[] {
  const index = Number.isFinite(count) ? Math.max(0, Math.min(Math.trunc(count), WIZARD_CHESS_SEQUENCE.length)) : 0;
  return positions[index]!.map(piece => ({ ...piece }));
}

/** Return one prevalidated move and its authoritative post-move scene position. */
export function wizardMoveAt(index: number): { move: BoardMove; next: BoardPiece[] } {
  if (!Number.isInteger(index) || index < 0 || index >= WIZARD_CHESS_SEQUENCE.length) {
    throw new Error('Unknown Wizard Chess move');
  }
  const step = WIZARD_CHESS_SEQUENCE[index]!;
  const captured = positions[index]!.find(piece => piece.square === step.to)?.type;
  return {
    move: { from: step.from, to: step.to, piece: step.piece, color: step.color,
      captured, check: step.check, checkmate: step.san.endsWith('#') },
    next: wizardPositionAfterMoves(index + 1),
  };
}
