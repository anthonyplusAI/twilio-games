/** Serializable contracts shared by the Voice Chess room, transport, and 3D display. */
export type ChessColor = 'w' | 'b';
export type ChessPieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type ChessFile = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h';
export type ChessRank = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';
export type ChessSquare = `${ChessFile}${ChessRank}`;
export type ChessPhase = 'waiting' | 'playing' | 'pending' | 'finished';
export type ChessCastleSide = 'king' | 'queen';

export interface ChessPiecePlacement {
  square: ChessSquare;
  color: ChessColor;
  type: ChessPieceType;
}

export interface ChessMovePreview {
  color: ChessColor;
  piece: ChessPieceType;
  from: ChessSquare;
  to: ChessSquare;
  san: string;
  captured: ChessPieceType | null;
  capturedSquare: ChessSquare | null;
  promotion: ChessPieceType | null;
  castle: ChessCastleSide | null;
  rookFrom: ChessSquare | null;
  rookTo: ChessSquare | null;
  enPassant: boolean;
}

export interface ChessPendingMove extends ChessMovePreview {
  baseRevision: number;
}

export interface ChessMoveRecord extends ChessMovePreview {
  actor: 'human' | 'computer';
  ply: number;
  revision: number;
  fen: string;
  check: boolean;
  checkmate: boolean;
}

export type ChessResultReason =
  | 'checkmate'
  | 'stalemate'
  | 'threefold_repetition'
  | 'fifty_move'
  | 'insufficient_material'
  | 'draw';

export interface ChessResult {
  reason: ChessResultReason;
  winner: ChessColor | null;
}

export type ChessFeedbackCode =
  | 'selected'
  | 'proposed'
  | 'confirmed'
  | 'cancelled'
  | 'illegal'
  | 'ambiguous'
  | 'unknown'
  | 'help'
  | 'no_pending'
  | 'not_your_turn'
  | 'stale'
  | 'waiting'
  | 'finished'
  | 'reset';

export interface ChessFeedback {
  code: ChessFeedbackCode;
  text: string;
  /** Monotonic across utterances, including those that leave the board unchanged. */
  sequence: number;
}

export interface ChessSelection {
  piece?: ChessPieceType;
  from?: ChessSquare;
}

export interface ChessState {
  roomCode: string;
  gameId: number;
  phase: ChessPhase;
  playerConnected: boolean;
  humanColor: ChessColor;
  computerColor: ChessColor;
  turn: ChessColor;
  fen: string;
  pieces: ChessPiecePlacement[];
  /** Monotonic committed board version, including resets. */
  revision: number;
  /** Number of half-moves in the current game. */
  ply: number;
  selection: ChessSelection | null;
  pendingMove: ChessPendingMove | null;
  lastMove: ChessMoveRecord | null;
  result: ChessResult | null;
  feedback: ChessFeedback | null;
}

export type ChessEvent =
  | { type: 'move'; move: ChessMoveRecord }
  | { type: 'proposal'; move: ChessPendingMove }
  | { type: 'selection'; selection: ChessSelection | null }
  | { type: 'feedback'; feedback: ChessFeedback }
  | { type: 'result'; result: ChessResult }
  | { type: 'reset'; gameId: number; revision: number };

export interface ChessCommandResult {
  code: ChessFeedbackCode;
  message: string;
  state: ChessState;
  candidates?: ChessMovePreview[];
}

export type ChessClientMessage =
  | { type: 'spectate'; roomCode: string; locale?: 'en-US' | 'pt-BR' }
  | { type: 'display_auth'; roomCode: string; token: string }
  | { type: 'clock_sync'; clientSentAtMs: number };
export type ChessServerMessage =
  | { type: 'chess_capabilities'; displayAuth: boolean }
  | { type: 'clock_sync'; clientSentAtMs: number; serverNowMs: number }
  | ({ type: 'chess_state' } & ChessState)
  | { type: 'chess_events'; events: ChessEvent[] }
  | { type: 'error'; code: string; message: string };
