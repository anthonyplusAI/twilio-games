import { Chess, type Move } from 'chess.js';
import { describeChessMove, parseChessIntent, type ChessMoveQuery } from '../shared/chess-intent';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import { normalizeForMatching } from '../shared/i18n/translate';
import type {
  ChessColor, ChessCommandResult, ChessEvent, ChessFeedback, ChessFeedbackCode,
  ChessHint, ChessMovePreview, ChessMoveRecord, ChessPendingMove, ChessPieceType,
  ChessResult, ChessSelection, ChessSquare, ChessState, ChessFile,
} from '../shared/chess-protocol';

export interface ChessRoomOptions {
  random?: () => number;
  /** Optional legal position for a match or a focused rules test. Reset starts standard chess. */
  initialFen?: string;
  /** Overrides the first game's random side, primarily for controlled matches/tests. */
  humanColor?: ChessColor;
  /** Search overrides for tests. The defaults target an approachable 800-1200 Elo feel, not a measured rating. */
  aiDepth?: number;
  aiNodeBudget?: number;
  aiTimeBudgetMs?: number;
}

/** A legal human move, labeled for the semantic speech interpreter. The ID is
 * coordinate notation; the caller still has to explicitly confirm the proposal. */
export interface ChessVoiceMoveChoice {
  id: string;
  label: string;
  aliases: string[];
}

const PIECE_VALUE: Record<ChessPieceType, number> = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
const MATE_SCORE = 100_000;
const SEARCH_INFINITY = 1_000_000;
const AI_MAX_CANDIDATES = 5;
const AI_MAX_CENTIPAWN_LOSS = 180;
const AI_SELECTION_TEMPERATURE = 65;
const MAX_HINTS = 3;

function opposite(color: ChessColor): ChessColor { return color === 'w' ? 'b' : 'w'; }
function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value!))) : fallback;
}
function inLanguage(locale: SupportedLocale, english: string, portuguese: string): string {
  return locale === 'pt-BR' ? portuguese : english;
}

/** One authoritative, headless chess match. Timers and transport are owned by the host. */
export class ChessRoom {
  private chess: Chess;
  private readonly random: () => number;
  private readonly aiDepth: number;
  private readonly aiNodeBudget: number;
  private readonly aiTimeBudgetMs: number;
  private humanColorValue: ChessColor;
  private playerConnectedValue = false;
  private gameIdValue = 1;
  private revisionValue = 0;
  private plyValue = 0;
  private selectionValue: ChessSelection | null = null;
  private pendingValue: ChessPendingMove | null = null;
  private hintsRemainingValue = MAX_HINTS;
  private hintValue: ChessHint | null = null;
  private lastMoveValue: ChessMoveRecord | null = null;
  private resultValue: ChessResult | null = null;
  private feedbackValue: ChessFeedback | null = null;
  private feedbackSequence = 0;
  private events: ChessEvent[] = [];

  constructor(readonly code: string, options: ChessRoomOptions = {}) {
    this.random = options.random ?? Math.random;
    this.aiDepth = boundedInteger(options.aiDepth, 2, 1, 4);
    this.aiNodeBudget = boundedInteger(options.aiNodeBudget, 2_500, 100, 20_000);
    this.aiTimeBudgetMs = boundedInteger(options.aiTimeBudgetMs, 800, 20, 1_000);
    this.humanColorValue = options.humanColor ?? (this.random() < 0.5 ? 'w' : 'b');
    this.chess = new Chess(options.initialFen);
    this.resultValue = this.detectResult();
    if (!this.resultValue && this.chess.turn() !== this.humanColorValue) this.commitComputerMove(true);
  }

  get phase(): ChessState['phase'] {
    if (this.resultValue) return 'finished';
    if (!this.playerConnectedValue) return 'waiting';
    return this.pendingValue ? 'pending' : 'playing';
  }
  get humanColor(): ChessColor { return this.humanColorValue; }
  get playerConnected(): boolean { return this.playerConnectedValue; }

  legalVoiceMoves(locale: SupportedLocale = DEFAULT_LOCALE): ChessVoiceMoveChoice[] {
    if (!this.playerConnectedValue || this.resultValue || this.chess.turn() !== this.humanColorValue) return [];
    const names: Record<ChessPieceType, string> = locale === 'pt-BR'
      ? { p: 'peão', n: 'cavalo', b: 'bispo', r: 'torre', q: 'dama', k: 'rei' }
      : { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
    return this.chess.moves({ verbose: true }).map(move => {
      const id = `${move.from}${move.to}${move.promotion ?? ''}`;
      const castle = move.isKingsideCastle() ? 'king' : move.isQueensideCastle() ? 'queen' : null;
      const label = castle
        ? inLanguage(locale, `Castle ${castle === 'king' ? 'kingside' : 'queenside'} (${move.from.toUpperCase()} to ${move.to.toUpperCase()})`,
          `Roque ${castle === 'king' ? 'pequeno' : 'grande'} (${move.from.toUpperCase()} para ${move.to.toUpperCase()})`)
        : inLanguage(locale,
          `${names[move.piece]} from ${move.from.toUpperCase()} to ${move.to.toUpperCase()}${move.captured ? ' capture' : ''}${move.promotion ? ` promote to ${names[move.promotion]}` : ''}`,
          `${names[move.piece]} de ${move.from.toUpperCase()} para ${move.to.toUpperCase()}${move.captured ? ' captura' : ''}${move.promotion ? ` promover a ${names[move.promotion]}` : ''}`);
      return { id, label, aliases: [move.san, `${move.from} ${move.to}`] };
    });
  }

  state(): ChessState {
    return {
      roomCode: this.code,
      gameId: this.gameIdValue,
      phase: this.phase,
      playerConnected: this.playerConnectedValue,
      humanColor: this.humanColorValue,
      computerColor: opposite(this.humanColorValue),
      turn: this.chess.turn(),
      fen: this.chess.fen(),
      pieces: this.chess.board().flatMap(row => row.filter(piece => piece !== null).map(piece => ({
        square: piece.square, color: piece.color, type: piece.type,
      }))),
      revision: this.revisionValue,
      ply: this.plyValue,
      selection: this.selectionValue ? { ...this.selectionValue } : null,
      pendingMove: this.pendingValue ? { ...this.pendingValue } : null,
      hintsRemaining: this.hintsRemainingValue,
      hint: this.hintValue ? { ...this.hintValue } : null,
      lastMove: this.lastMoveValue ? { ...this.lastMoveValue } : null,
      result: this.resultValue ? { ...this.resultValue } : null,
      feedback: this.feedbackValue ? { ...this.feedbackValue } : null,
    };
  }

  drainEvents(): ChessEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  /** A disconnect invalidates an unconfirmed proposal and blocks a delayed AI callback. */
  setPlayerConnected(connected: boolean): void {
    if (this.playerConnectedValue === connected) return;
    this.playerConnectedValue = connected;
    if (!connected) {
      this.pendingValue = null;
      this.clearSelection();
    }
  }

  handleVoiceCommand(text: string, locale: SupportedLocale = DEFAULT_LOCALE): ChessCommandResult {
    const intent = parseChessIntent(text, locale);
    if (!this.playerConnectedValue) {
      return this.respond('waiting', inLanguage(locale, 'Waiting for the player to connect.', 'Aguardando o jogador se conectar.'));
    }
    if (intent.kind === 'reset') {
      if (!this.resultValue) return this.respond('illegal', inLanguage(locale, 'Finish this game before starting another.', 'Termine esta partida antes de começar outra.'));
      this.reset();
      return this.respond('reset', inLanguage(locale, 'A new enchanted match begins.', 'Uma nova partida encantada começa.'));
    }
    if (this.resultValue) {
      return this.respond('finished', inLanguage(locale, 'The match is over. Say play again for a new game.', 'A partida acabou. Diga jogar de novo para começar outra.'));
    }
    switch (intent.kind) {
      case 'confirm': return this.confirmMove(undefined, locale);
      case 'cancel': return this.cancelMove(locale);
      case 'hint': return this.requestHint(locale);
      case 'select': return this.selectPiece(intent, locale);
      case 'move': return this.selectSpokenSource(text, intent.query, locale)
        ?? this.proposeQuery(intent.query, locale);
      case 'help': return this.respond('help', inLanguage(locale,
        'Say a piece and destination; I infer a unique legal source. If several fit, add its square or file. You can pause before the destination. Confirm or cancel my proposal. Say castle for castling, or ask for a hint. You have three hints per game.',
        'Diga a peça e o destino; encontrarei a origem legal se for única. Se houver mais de uma, diga a casa ou coluna. Você pode pausar antes do destino. Confirme ou cancele minha proposta. Diga roque, ou peça uma dica. Você tem três dicas por partida.'));
      default: return this.respond('unknown', inLanguage(locale,
        'I did not catch a chess move. Say a piece and destination square, or say help.',
        'Não entendi a jogada. Diga a peça e a casa de destino, ou diga ajuda.'));
    }
  }

  proposeMove(text: string, locale: SupportedLocale = DEFAULT_LOCALE): ChessCommandResult {
    const intent = parseChessIntent(text, locale);
    return intent.kind === 'move'
      ? this.proposeQuery(intent.query, locale)
      : this.respond('unknown', inLanguage(locale, 'Say a piece and destination square.', 'Diga uma peça e a casa de destino.'));
  }

  confirmMove(expectedRevision?: number, locale: SupportedLocale = DEFAULT_LOCALE): ChessCommandResult {
    const guard = this.guardHumanAction(locale);
    if (guard) return guard;
    const pending = this.pendingValue;
    if (!pending) return this.respond('no_pending', inLanguage(locale, 'There is no move to confirm.', 'Não há jogada para confirmar.'));
    if ((expectedRevision !== undefined && expectedRevision !== this.revisionValue)
      || pending.baseRevision !== this.revisionValue) {
      this.pendingValue = null;
      return this.respond('stale', inLanguage(locale, 'The board changed. Please say your move again.', 'O tabuleiro mudou. Diga sua jogada novamente.'));
    }
    const legal = this.chess.moves({ verbose: true }).find(move =>
      move.from === pending.from && move.to === pending.to && (move.promotion ?? null) === pending.promotion);
    if (!legal) {
      this.pendingValue = null;
      return this.respond('stale', inLanguage(locale, 'That move is no longer legal. Please say it again.', 'Essa jogada não é mais legal. Diga novamente.'));
    }
    this.pendingValue = null;
    const committed = this.commitMove(legal, 'human');
    return this.respond('confirmed', describeChessMove(committed, locale));
  }

  cancelMove(locale: SupportedLocale = DEFAULT_LOCALE): ChessCommandResult {
    if (!this.playerConnectedValue) {
      return this.respond('waiting', inLanguage(locale, 'Waiting for the player to connect.', 'Aguardando o jogador se conectar.'));
    }
    if (!this.pendingValue && !this.selectionValue) {
      return this.respond('no_pending', inLanguage(locale, 'There is no move to cancel.', 'Não há jogada para cancelar.'));
    }
    this.pendingValue = null;
    this.clearSelection();
    return this.respond('cancelled', inLanguage(locale, 'Move cancelled. The pieces stay put.', 'Jogada cancelada. As peças ficam no lugar.'));
  }

  private requestHint(locale: SupportedLocale): ChessCommandResult {
    const guard = this.guardHumanAction(locale);
    if (guard) return guard;
    if (this.pendingValue) return this.respond('hint_unavailable', inLanguage(locale,
      'Confirm or cancel the proposed move before asking for a hint.',
      'Confirme ou cancele a jogada proposta antes de pedir uma dica.'));
    if (this.hintValue?.revision === this.revisionValue) return this.respond('hint', this.hintLine(this.hintValue, locale));
    if (this.hintsRemainingValue === 0) return this.respond('hint_limit', inLanguage(locale,
      'You have used all three hints for this game. It is still your move.',
      'Você já usou as três dicas desta partida. Ainda é sua vez.'));
    const move = this.chooseHintMove();
    if (!move) return this.respond('hint_unavailable', inLanguage(locale,
      'There is no legal move to suggest right now.', 'Não há jogada legal para sugerir agora.'));
    this.hintsRemainingValue--;
    this.hintValue = { from: move.from, to: move.to, piece: move.piece, san: move.san, revision: this.revisionValue };
    return this.respond('hint', this.hintLine(this.hintValue, locale));
  }

  private hintLine(hint: ChessHint, locale: SupportedLocale): string {
    const names: Record<ChessPieceType, string> = locale === 'pt-BR'
      ? { p: 'peão', n: 'cavalo', b: 'bispo', r: 'torre', q: 'dama', k: 'rei' }
      : { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
    const used = MAX_HINTS - this.hintsRemainingValue;
    const castle = hint.san === 'O-O' ? 'king' : hint.san === 'O-O-O' ? 'queen' : null;
    if (castle) return inLanguage(locale,
      `Hint ${used} of ${MAX_HINTS}: try castling ${castle === 'king' ? 'kingside' : 'queenside'}. The move is yours to choose.`,
      `Dica ${used} de ${MAX_HINTS}: tente o roque ${castle === 'king' ? 'pequeno' : 'grande'}. Você decide a jogada.`);
    return inLanguage(locale,
      `Hint ${used} of ${MAX_HINTS}: try your ${names[hint.piece]} from ${hint.from.toUpperCase()} to ${hint.to.toUpperCase()}. The move is yours to choose.`,
      `Dica ${used} de ${MAX_HINTS}: tente mover seu ${names[hint.piece]} de ${hint.from.toUpperCase()} para ${hint.to.toUpperCase()}. Você decide a jogada.`);
  }

  /** Call separately after publishing the human move. Expected revision rejects stale timers. */
  playComputerMove(expectedRevision?: number): ChessMoveRecord | null {
    if (!this.playerConnectedValue || (expectedRevision !== undefined && expectedRevision !== this.revisionValue)) return null;
    return this.commitComputerMove(false);
  }

  /** Replay requires an explicit command; this method is also available to a trusted host. */
  reset(): ChessState {
    this.gameIdValue += 1;
    this.revisionValue += 1;
    this.plyValue = 0;
    this.chess = new Chess();
    this.humanColorValue = this.random() < 0.5 ? 'w' : 'b';
    this.selectionValue = null;
    this.pendingValue = null;
    this.hintsRemainingValue = MAX_HINTS;
    this.hintValue = null;
    this.lastMoveValue = null;
    this.resultValue = null;
    this.feedbackValue = null;
    this.events = [{ type: 'reset', gameId: this.gameIdValue, revision: this.revisionValue }];
    if (this.humanColorValue === 'b') this.commitComputerMove(true);
    return this.state();
  }

  private selectPiece(intent: { piece?: ChessPieceType; from?: ChessSquare; fromFile?: ChessFile }, locale: SupportedLocale): ChessCommandResult {
    const guard = this.guardHumanAction(locale);
    if (guard) return guard;
    if (intent.from && intent.fromFile && intent.from[0] !== intent.fromFile) {
      return this.respond('illegal', inLanguage(locale,
        'That starting square is on a different file. Please say the square again.',
        'Essa casa inicial fica em outra coluna. Diga a casa novamente.'));
    }
    if (intent.fromFile && !intent.from) {
      const starts = [...new Set(this.chess.moves({ verbose: true })
        .filter(move => move.from[0] === intent.fromFile && (!intent.piece || move.piece === intent.piece))
        .map(move => move.from))];
      if (starts.length === 0) return this.respond('illegal', inLanguage(locale,
        `No legal move starts from the ${intent.fromFile.toUpperCase()} file for that piece.`,
        `Não há jogada legal dessa peça na coluna ${intent.fromFile.toUpperCase()}.`));
      if (starts.length > 1) return this.respond('ambiguous', inLanguage(locale,
        `Which piece on the ${intent.fromFile.toUpperCase()} file? Say its starting square: ${starts.map(square => square.toUpperCase()).join(', ')}.`,
        `Qual peça na coluna ${intent.fromFile.toUpperCase()}? Diga a casa inicial: ${starts.map(square => square.toUpperCase()).join(', ')}.`));
      intent = { ...intent, from: starts[0] };
    }
    if (intent.from) {
      const piece = this.chess.get(intent.from);
      if (!piece || piece.color !== this.humanColorValue || (intent.piece && intent.piece !== piece.type)) {
        return this.respond('illegal', inLanguage(locale, 'That square has no piece of yours.', 'Essa casa não tem uma peça sua.'));
      }
      this.selectionValue = { from: intent.from, piece: piece.type };
    } else if (intent.piece) {
      const movable = this.chess.moves({ verbose: true }).some(move => move.piece === intent.piece);
      if (!movable) return this.respond('illegal', inLanguage(locale, 'That piece has no legal move.', 'Essa peça não tem jogada legal.'));
      this.selectionValue = { piece: intent.piece };
    } else {
      return this.respond('unknown', inLanguage(locale, 'Choose a piece or square.', 'Escolha uma peça ou casa.'));
    }
    this.pendingValue = null;
    this.events.push({ type: 'selection', selection: { ...this.selectionValue } });
    return this.respond('selected', inLanguage(locale, 'Piece selected. Say the destination square.', 'Peça selecionada. Diga a casa de destino.'));
  }

  /** A bare "pawn E2" names the pawn already on E2, not an impossible move onto itself. */
  private selectSpokenSource(text: string, query: ChessMoveQuery, locale: SupportedLocale): ChessCommandResult | null {
    if (!query.to || query.from || query.fromFile || query.castle !== undefined || query.captureOnly || query.promotion) return null;
    const normalized = normalizeForMatching(text, locale);
    if (/\b(?:to|toward|towards|into|onto|para|pra)\b/.test(normalized)) return null;
    const occupant = this.chess.get(query.to);
    if (!occupant || occupant.color !== this.humanColorValue
      || (query.piece && query.piece !== occupant.type)) return null;
    return this.selectPiece({ from: query.to, piece: occupant.type }, locale);
  }

  private proposeQuery(query: ChessMoveQuery, locale: SupportedLocale): ChessCommandResult {
    const guard = this.guardHumanAction(locale);
    if (guard) return guard;
    this.pendingValue = null;
    const replacesSelection = Boolean(query.from || query.fromFile || query.castle !== undefined
      || (query.piece && this.selectionValue?.piece && query.piece !== this.selectionValue.piece));
    const effective: ChessMoveQuery = { ...(replacesSelection ? {} : this.selectionValue ?? {}), ...query };
    if (replacesSelection) this.clearSelection();
    let candidates = this.chess.moves({ verbose: true }).filter(move => {
      if (effective.castle !== undefined) {
        return effective.castle === null
          ? move.isKingsideCastle() || move.isQueensideCastle()
          : effective.castle === 'king' ? move.isKingsideCastle() : move.isQueensideCastle();
      }
      return (!effective.piece || move.piece === effective.piece)
        && (!effective.from || move.from === effective.from)
        && (!effective.fromFile || move.from[0] === effective.fromFile)
        && (!effective.to || move.to === effective.to)
        && (!effective.captureOnly || move.isCapture() || move.isEnPassant())
        && (!effective.promotion || move.promotion === effective.promotion);
    });
    if (effective.promotion === undefined && candidates.some(move => move.promotion)) {
      candidates = candidates.filter(move => !move.promotion || move.promotion === 'q');
    }
    if (candidates.length === 0) {
      if (effective.castle !== undefined) return this.respond('illegal', inLanguage(locale,
        'Castling is not legal in this position. Try another move.',
        'O roque não é legal nesta posição. Tente outra jogada.'));
      return this.respond('illegal', inLanguage(locale,
        'That move is not legal from this position. Try another square.',
        'Essa jogada não é legal nesta posição. Tente outra casa.'));
    }
    if (candidates.length > 1) {
      const previews = candidates.map(move => this.preview(move));
      if (effective.castle !== undefined) return this.respond('ambiguous', inLanguage(locale,
        'Both castling sides are legal. Say castle kingside or castle queenside.',
        'Os dois lados do roque são possíveis. Diga roque pequeno ou roque grande.'), previews);
      const sources = [...new Set(candidates.map(move => move.from.toUpperCase()))].join(', ');
      return this.respond('ambiguous', inLanguage(locale,
        `More than one piece can move there. Repeat the full move with its starting square: ${sources}.`,
        `Mais de uma peça pode chegar lá. Repita a jogada completa com a casa inicial: ${sources}.`), previews);
    }
    const pending: ChessPendingMove = { ...this.preview(candidates[0]!), baseRevision: this.revisionValue };
    this.pendingValue = pending;
    this.clearSelection();
    this.events.push({ type: 'proposal', move: { ...pending } });
    const confirmation = pending.castle
      ? inLanguage(locale,
        `Castle ${pending.castle === 'king' ? 'kingside' : 'queenside'}? Say confirm or cancel.`,
        `Confirma roque ${pending.castle === 'king' ? 'pequeno' : 'grande'}? Diga confirmar ou cancelar.`)
      : inLanguage(locale,
        `Confirm ${pending.san} from ${pending.from.toUpperCase()} to ${pending.to.toUpperCase()}? Say confirm or cancel.`,
        `Confirma ${pending.san} de ${pending.from.toUpperCase()} para ${pending.to.toUpperCase()}? Diga confirmar ou cancelar.`);
    return this.respond('proposed', confirmation);
  }

  private guardHumanAction(locale: SupportedLocale): ChessCommandResult | null {
    if (!this.playerConnectedValue) {
      return this.respond('waiting', inLanguage(locale, 'Waiting for the player to connect.', 'Aguardando o jogador se conectar.'));
    }
    if (this.resultValue) {
      return this.respond('finished', inLanguage(locale, 'The match has ended. Say play again for a new game.', 'A partida acabou. Diga jogar de novo para começar outra.'));
    }
    if (this.chess.turn() !== this.humanColorValue) {
      return this.respond('not_your_turn', inLanguage(locale, 'Wait for the rival to move.', 'Aguarde a jogada do rival.'));
    }
    return null;
  }

  private clearSelection(): void {
    if (!this.selectionValue) return;
    this.selectionValue = null;
    this.events.push({ type: 'selection', selection: null });
  }

  private respond(code: ChessFeedbackCode, message: string, candidates?: ChessMovePreview[]): ChessCommandResult {
    const feedback: ChessFeedback = { code, text: message, sequence: ++this.feedbackSequence };
    this.feedbackValue = feedback;
    this.events.push({ type: 'feedback', feedback: { ...feedback } });
    return { code, message, state: this.state(), ...(candidates ? { candidates } : {}) };
  }

  private preview(move: Move): ChessMovePreview {
    const castle = move.isKingsideCastle() ? 'king' : move.isQueensideCastle() ? 'queen' : null;
    const rookRank = move.color === 'w' ? '1' : '8';
    const capturedSquare: ChessSquare | null = move.captured
      ? move.isEnPassant() ? `${move.to[0]}${move.from[1]}` as ChessSquare : move.to
      : null;
    return {
      color: move.color, piece: move.piece, from: move.from, to: move.to, san: move.san,
      captured: move.captured ?? null, capturedSquare, promotion: move.promotion ?? null, castle,
      rookFrom: castle ? `${castle === 'king' ? 'h' : 'a'}${rookRank}` as ChessSquare : null,
      rookTo: castle ? `${castle === 'king' ? 'f' : 'd'}${rookRank}` as ChessSquare : null,
      enPassant: move.isEnPassant(),
    };
  }

  private commitMove(move: Move, actor: 'human' | 'computer'): ChessMoveRecord {
    const applied = this.chess.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
    this.revisionValue += 1;
    this.hintValue = null;
    this.plyValue += 1;
    this.resultValue = this.detectResult();
    const record: ChessMoveRecord = {
      ...this.preview(applied), actor, ply: this.plyValue, revision: this.revisionValue,
      fen: this.chess.fen(), check: this.chess.isCheck(), checkmate: this.chess.isCheckmate(),
    };
    this.lastMoveValue = record;
    this.events.push({ type: 'move', move: { ...record } });
    if (this.resultValue) this.events.push({ type: 'result', result: { ...this.resultValue } });
    return record;
  }

  private commitComputerMove(allowDisconnected: boolean): ChessMoveRecord | null {
    if ((!allowDisconnected && !this.playerConnectedValue) || this.resultValue
      || this.chess.turn() === this.humanColorValue) return null;
    const best = this.chooseComputerMove();
    return best ? this.commitMove(best, 'computer') : null;
  }

  private detectResult(): ChessResult | null {
    if (this.chess.isCheckmate()) return { reason: 'checkmate', winner: opposite(this.chess.turn()) };
    if (this.chess.isStalemate()) return { reason: 'stalemate', winner: null };
    if (this.chess.isThreefoldRepetition()) return { reason: 'threefold_repetition', winner: null };
    if (this.chess.isDrawByFiftyMoves()) return { reason: 'fifty_move', winner: null };
    if (this.chess.isInsufficientMaterial()) return { reason: 'insufficient_material', winner: null };
    return this.chess.isDraw() ? { reason: 'draw', winner: null } : null;
  }

  private chooseComputerMove(): Move | null {
    const ranked = this.rankLegalMoves(this.aiDepth, this.aiNodeBudget, this.aiTimeBudgetMs);
    if (!ranked) return null;
    if (!ranked.scoredMoves) return ranked.ordered[0]!;
    return this.chooseApproachableMove(ranked.completedDepth === 1
      ? this.accountForImmediateRecaptures(ranked.scoredMoves) : ranked.scoredMoves);
  }

  /** Hints use the best bounded-search move, without the rival's forgiving random variation. */
  private chooseHintMove(): Move | null {
    const ranked = this.rankLegalMoves(Math.min(this.aiDepth, 2),
      Math.min(this.aiNodeBudget, 1_200), Math.min(this.aiTimeBudgetMs, 250));
    if (!ranked) return null;
    if (!ranked.scoredMoves) return ranked.ordered[0]!;
    return (ranked.completedDepth === 1
      ? this.accountForImmediateRecaptures(ranked.scoredMoves) : ranked.scoredMoves)[0]!.move;
  }

  private rankLegalMoves(depthLimit: number, nodeLimit: number, timeLimitMs: number):
    { ordered: Move[]; scoredMoves: { move: Move; score: number }[] | null; completedDepth: number } | null {
    const legal = this.chess.moves({ verbose: true });
    if (!legal.length) return null;
    let ordered = this.orderMoves(legal);
    let scoredMoves: { move: Move; score: number }[] | null = null;
    let completedDepth = 0;
    const budget = { nodes: 0, limit: nodeLimit, deadline: Date.now() + timeLimitMs };
    // Keep the best *completed* iteration. If a deeper search exhausts its budget,
    // the board is fully undone and the earlier legal answer is still available.
    for (let depth = 1; depth <= depthLimit; depth++) {
      const roundScores: { move: Move; score: number }[] = [];
      let completed = true;
      for (const move of ordered) {
        if (budget.nodes >= budget.limit || Date.now() >= budget.deadline) { completed = false; break; }
        this.chess.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
        let reply: number | null;
        // Every root score must be exact: a narrow alpha-beta window would only
        // bound weaker moves, making the weighted choice deceptively risky.
        try { reply = this.search(depth - 1, -SEARCH_INFINITY, SEARCH_INFINITY, budget, 1); }
        finally { this.chess.undo(); }
        if (reply === null) { completed = false; break; }
        roundScores.push({ move, score: -reply });
      }
      if (!completed) break;
      roundScores.sort((a, b) => b.score - a.score);
      scoredMoves = roundScores;
      completedDepth = depth;
      ordered = roundScores.map(entry => entry.move);
      if (Math.abs(roundScores[0]!.score) >= MATE_SCORE - 20) break;
    }
    return { ordered, scoredMoves, completedDepth };
  }

  /** When two plies cannot finish, avoid the worst one-move piece drops. */
  private accountForImmediateRecaptures(scoredMoves: { move: Move; score: number }[]): { move: Move; score: number }[] {
    return scoredMoves.map(entry => {
      const movedPiece = entry.move.promotion ?? entry.move.piece;
      this.chess.move({ from: entry.move.from, to: entry.move.to,
        ...(entry.move.promotion ? { promotion: entry.move.promotion } : {}) });
      let canRecapture: boolean;
      try {
        canRecapture = this.chess.moves({ verbose: true }).some(reply =>
          reply.captured === movedPiece && (reply.to === entry.move.to
            || (reply.isEnPassant() && `${reply.to[0]}${reply.from[1]}` === entry.move.to)));
      } finally { this.chess.undo(); }
      return { ...entry, score: entry.score - (canRecapture ? PIECE_VALUE[movedPiece] : 0) };
    }).sort((a, b) => b.score - a.score);
  }

  /** A short, weighted shortlist adds forgiving variation without throwing away a queen. */
  private chooseApproachableMove(scoredMoves: { move: Move; score: number }[]): Move {
    const bestScore = scoredMoves[0]!.score;
    const candidates = scoredMoves
      .filter(entry => bestScore - entry.score <= AI_MAX_CENTIPAWN_LOSS)
      .slice(0, AI_MAX_CANDIDATES);
    const weights = candidates.map(entry => Math.exp((entry.score - bestScore) / AI_SELECTION_TEMPERATURE));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const roll = Math.min(0.999999999, Math.max(0, this.random())) * totalWeight;
    let cumulative = 0;
    for (let index = 0; index < candidates.length; index++) {
      cumulative += weights[index]!;
      if (roll < cumulative) return candidates[index]!.move;
    }
    return candidates[0]!.move;
  }

  private search(
    depth: number,
    alpha: number,
    beta: number,
    budget: { nodes: number; limit: number; deadline: number },
    ply: number,
  ): number | null {
    if (budget.nodes >= budget.limit || Date.now() >= budget.deadline) return null;
    budget.nodes += 1;
    if (this.chess.isCheckmate()) return -MATE_SCORE + ply;
    if (this.chess.isDraw()) return 0;
    if (depth <= 0) return this.evaluate();
    const moves = this.orderMoves(this.chess.moves({ verbose: true }));
    let best = -SEARCH_INFINITY;
    for (const move of moves) {
      this.chess.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
      let reply: number | null;
      try { reply = this.search(depth - 1, -beta, -alpha, budget, ply + 1); }
      finally { this.chess.undo(); }
      if (reply === null) return null;
      const score = -reply;
      best = Math.max(best, score);
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    return best;
  }

  private orderMoves(moves: Move[]): Move[] {
    return [...moves].sort((a, b) => this.movePriority(b) - this.movePriority(a));
  }

  private movePriority(move: Move): number {
    return (move.captured ? PIECE_VALUE[move.captured] * 10 - PIECE_VALUE[move.piece] : 0)
      + (move.promotion ? PIECE_VALUE[move.promotion] : 0)
      + (move.san.endsWith('#') ? 10_000 : move.san.endsWith('+') ? 80 : 0);
  }

  private evaluate(): number {
    let whiteScore = 0;
    for (const row of this.chess.board()) {
      for (const piece of row) {
        if (!piece) continue;
        const file = piece.square.charCodeAt(0) - 97;
        const rank = Number(piece.square[1]) - 1;
        const center = 7 - Math.abs(file - 3.5) - Math.abs(rank - 3.5);
        const advance = piece.color === 'w' ? rank : 7 - rank;
        const centerFile = 3.5 - Math.abs(file - 3.5);
        const position = piece.type === 'p' ? advance * 5 + center * 2 + Math.min(advance, 3) * centerFile * 3
          : piece.type === 'n' ? center * 12
            : piece.type === 'b' ? center * 5
              : piece.type === 'q' ? center * 2
                : piece.type === 'r' ? advance * 2 : 0;
        whiteScore += (piece.color === 'w' ? 1 : -1) * (PIECE_VALUE[piece.type] + position);
      }
    }
    const perspective = this.chess.turn() === 'w' ? 1 : -1;
    return perspective * whiteScore - (this.chess.isCheck() ? 20 : 0);
  }
}
