/** Serializable contracts shared by the Voice Chess room, transport, and 3D display. */
export type ChessColor = 'w' | 'b';
export type ChessPieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type ChessFile = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h';
export type ChessRank = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';
export type ChessSquare = `${ChessFile}${ChessRank}`;
export type ChessPhase = 'waiting' | 'playing' | 'pending' | 'finished';
export type ChessCastleSide = 'king' | 'queen';

/** The screen's temporary cinematic board. The ordinary match remains authoritative underneath. */
export interface WizardChessSceneSnapshot {
  id: number;
  phase: 'story' | 'ready' | 'resolved';
  /** Number of dialogue lines whose playback has fully finished. */
  dialogueCursor?: number;
  /** Server clock timestamps in milliseconds; clients can align them with clock_sync. */
  startedAt: number;
  readyAt: number | null;
  resolvedAt: number | null;
}

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

/** A recommendation for the current board, never an automatically played move. */
export interface ChessHint {
  from: ChessSquare;
  to: ChessSquare;
  piece: ChessPieceType;
  san: string;
  revision: number;
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
  | 'hint'
  | 'hint_limit'
  | 'hint_unavailable'
  | 'no_pending'
  | 'not_your_turn'
  | 'stale'
  | 'waiting'
  | 'finished'
  | 'reset'
  | 'wizard_started'
  | 'wizard_ready'
  | 'wizard_resolved'
  | 'wizard_skipped'
  | 'wizard_exited'
  | 'wizard_hint'
  | 'wizard_waiting';

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
  hintsRemaining: number;
  hint: ChessHint | null;
  lastMove: ChessMoveRecord | null;
  result: ChessResult | null;
  feedback: ChessFeedback | null;
  /** The Easter egg is offered only before the caller's first committed move, once per call. */
  wizardAvailable?: boolean;
  /** Present while the cinematic overlay owns the display and phone commands. */
  wizardScene?: WizardChessSceneSnapshot | null;
  /** Server-authorized result-menu action for this display; absent in voice-only snapshots. */
  canReplayOnDisplay?: boolean;
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
  | { type: 'leave' }
  | { type: 'display_auth'; roomCode: string; token: string }
  | { type: 'clock_sync'; clientSentAtMs: number }
  | { type: 'display_wizard_skip'; roomCode: string; sceneId: number }
  | { type: 'display_wizard_progress'; roomCode: string; sceneId: number; cursor: number }
  | { type: 'display_replay'; roomCode: string; gameId: number };
export type ChessServerMessage =
  | { type: 'chess_capabilities'; displayAuth: boolean }
  | { type: 'clock_sync'; clientSentAtMs: number; serverNowMs: number }
  | ({ type: 'chess_state' } & ChessState)
  | { type: 'chess_events'; events: ChessEvent[] }
  | { type: 'error'; code: string; message: string };
