import { parseCrMessage } from './conversation-relay';
import { parseChessIntent, describeChessMove } from '../shared/chess-intent';
import type { ChessCommandResult, ChessEvent, ChessPieceType, ChessSquare, ChessState } from '../shared/chess-protocol';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { formatList, normalizeForMatching } from '../shared/i18n/translate';
import type { ChessVoiceMoveChoice } from './chess-room';
import type { VoiceInterpretFact, VoiceInterpretResult } from './voice-interpreter';

export interface ChessVoiceInterpretContext {
  phase: ChessState['phase'];
  gameId: number;
  revision: number;
  pendingMove: boolean;
  /** A question about the board cannot become a proposed or confirmed move. */
  readOnlyInquiry: boolean;
  legalMoves: readonly ChessVoiceMoveChoice[];
  facts: readonly VoiceInterpretFact[];
}

export interface ChessVoiceDeps {
  bind(
    roomCode: string,
    name: string,
    callSid: string,
    locale: SupportedLocale,
  ): { playerId: string; resumed: boolean } | null;
  leave(roomCode: string, playerId: string, callSid: string): void;
  command(roomCode: string, callSid: string, text: string, locale: SupportedLocale): ChessCommandResult | null;
  restart(roomCode: string, callSid: string): boolean;
  snapshot(roomCode: string): ChessState | null;
  legalMoves?(roomCode: string, callSid: string, locale: SupportedLocale): readonly ChessVoiceMoveChoice[];
  interpret?(spoken: string, locale: SupportedLocale, context: ChessVoiceInterpretContext,
    isCurrent: () => boolean): Promise<VoiceInterpretResult | null>;
  say(text: string, isCurrent?: () => boolean): void | Promise<boolean>;
}

/** One Conversation Relay caller controls one authoritative chess room. */
export class ChessVoiceSession {
  private roomCode: string | null = null;
  private playerId: string | null = null;
  private callSid: string | null = null;
  private commandLocale: SupportedLocale = DEFAULT_LOCALE;
  private authoritativeName: string | null = null;
  private stationManaged = false;
  private active = true;
  private turnEpoch = 0;
  private initiatingResetGameId: number | null = null;
  private readonly pendingSpeech = new Set<Promise<unknown>>();

  constructor(private readonly deps: ChessVoiceDeps) {}

  get boundRoomCode(): string | null { return this.roomCode; }
  get boundPlayerId(): string | null { return this.playerId; }
  get locale(): SupportedLocale { return this.commandLocale; }

  setAuthoritativeName(name: string | null): void {
    this.authoritativeName = name?.trim().slice(0, 40) || null;
  }

  setStationManaged(value: boolean): void { this.stationManaged = value; }

  handleMessage(raw: string): void {
    if (!this.active) return;
    const message = parseCrMessage(raw);
    if (message.type === 'setup') {
      this.handleSetup(message.callSid, message.customParameters);
      return;
    }
    if (!this.roomCode || !this.callSid) return;
    if (message.type === 'prompt') {
      if (message.last) this.handleFinalPrompt(message.voicePrompt);
      else this.turnEpoch++; // the caller has begun speaking over any queued line
    } else if (message.type === 'dtmf') {
      const command = message.digit === '1' ? 'confirm'
        : message.digit === '0' ? 'cancel'
          : message.digit === '9' ? 'help' : '';
      if (command) this.handleFinalPrompt(command);
    } else if (message.type === 'interrupt') {
      this.turnEpoch++;
    }
  }

  onRoomEvents(events: readonly ChessEvent[]): void {
    if (!this.active || !this.roomCode) return;
    const reset = events.find(event => event.type === 'reset');
    if (reset?.type === 'reset') {
      this.turnEpoch++;
      if (this.initiatingResetGameId === reset.gameId) {
        this.initiatingResetGameId = null;
        return;
      }
      const next = this.deps.snapshot(this.roomCode);
      if (next?.gameId === reset.gameId) {
        this.speak(this.introduction(next, false), true);
        if (next.lastMove?.actor === 'computer' && next.ply === 1)
          this.speak(describeChessMove(next.lastMove, this.commandLocale));
      }
      return;
    }
    for (const event of events) {
      if (event.type !== 'move' || event.move.actor !== 'computer') continue;
      this.speak(describeChessMove(event.move, this.commandLocale));
      const current = this.deps.snapshot(this.roomCode);
      if (current?.result) this.speak(this.resultLine(current));
    }
  }

  async whenSpeechSettled(): Promise<void> {
    while (this.pendingSpeech.size) await Promise.allSettled([...this.pendingSpeech]);
  }

  handleReplaced(): void { this.active = false; this.turnEpoch++; }

  handleClose(): void {
    if (!this.active) return;
    this.active = false;
    this.turnEpoch++;
    if (this.roomCode && this.playerId && this.callSid) {
      this.deps.leave(this.roomCode, this.playerId, this.callSid);
    }
  }

  private handleSetup(callSid: string, parameters: Record<string, string>): void {
    if (this.roomCode || !callSid.trim()) return;
    const roomCode = parameters['roomCode']?.trim().toUpperCase();
    if (!roomCode) return;
    this.commandLocale = resolveLocale(parameters['commandLocale'] ?? parameters['locale'], DEFAULT_LOCALE);
    const name = this.authoritativeName ?? (this.commandLocale === 'pt-BR' ? 'Mago' : 'Wizard');
    const binding = this.deps.bind(roomCode, name, callSid.trim(), this.commandLocale);
    if (!binding) {
      this.speak(this.commandLocale === 'pt-BR'
        ? 'Este tabuleiro já está sendo comandado por outro jogador.'
        : 'Another caller already commands this chess board.');
      return;
    }
    this.roomCode = roomCode;
    this.playerId = binding.playerId;
    this.callSid = callSid.trim();
    const state = this.deps.snapshot(roomCode);
    if (!state) return;
    // A reconnect can land on a completed board. Give the result that is actually on screen;
    // asking for a move first makes the host sound as if the game is still in progress.
    if (state.phase === 'finished' && state.result) {
      this.speak(this.resultLine(state));
      return;
    }
    this.speak(this.introduction(state, binding.resumed), true);
    if (state.lastMove?.actor === 'computer' && (state.ply === 1 || binding.resumed)) {
      this.speak(describeChessMove(state.lastMove, this.commandLocale));
    }
  }

  private handleFinalPrompt(spoken: string): void {
    if (!this.roomCode || !this.callSid || !spoken.trim()) return;
    this.turnEpoch++;
    // Chess questions are read-only, even if they name a legal move or Relay
    // transcribes the question without its final question mark.
    if (isReadOnlyChessInquiry(spoken, this.commandLocale)) {
      this.requestSemanticTurn(spoken, true);
      return;
    }
    const intent = parseChessIntent(spoken, this.commandLocale);
    if (intent.kind === 'reset') {
      this.handleReset();
      return;
    }

    if (intent.kind === 'unknown' && this.deps.interpret && this.deps.legalMoves) {
      this.requestSemanticTurn(spoken, false);
      return;
    }

    this.runCommand(spoken);
  }

  private handleReset(): void {
    if (!this.roomCode || !this.callSid) return;
    if (this.stationManaged) { this.speak(this.stationWaitLine()); return; }
    const before = this.deps.snapshot(this.roomCode);
    if (before?.phase !== 'finished') {
      this.speak(this.commandLocale === 'pt-BR'
        ? 'Termine esta partida antes de começar outra.'
        : 'Finish this match before starting another.');
      return;
    }
    this.initiatingResetGameId = before.gameId + 1;
    if (!this.deps.restart(this.roomCode, this.callSid)) {
      this.initiatingResetGameId = null;
      this.speak(this.commandLocale === 'pt-BR'
        ? 'Termine esta partida antes de começar outra.'
        : 'Finish this match before starting another.');
      return;
    }
    const next = this.deps.snapshot(this.roomCode);
    if (next) {
      this.speak(this.introduction(next, false), true);
      if (next.lastMove?.actor === 'computer' && next.ply === 1) {
        this.speak(describeChessMove(next.lastMove, this.commandLocale));
      }
    }
  }

  private runCommand(spoken: string): void {
    if (!this.roomCode || !this.callSid) return;
    const result = this.deps.command(this.roomCode, this.callSid, spoken, this.commandLocale);
    if (!result) {
      this.speak(this.commandLocale === 'pt-BR'
        ? 'A ligação perdeu o controle do tabuleiro. Tente ligar novamente.'
        : 'This call lost control of the board. Please call again.');
      return;
    }
    if (result.code === 'confirmed' && result.state.lastMove?.actor === 'human') {
      this.speak(describeChessMove(result.state.lastMove, this.commandLocale), true);
      if (result.state.result) this.speak(this.resultLine(result.state));
    } else if (result.code === 'finished' && this.stationManaged) {
      this.speak(this.stationWaitLine());
    } else {
      this.speak(result.message);
    }
  }

  private requestSemanticTurn(spoken: string, readOnlyInquiry: boolean): void {
    if (!this.roomCode || !this.callSid) return;
    if (!this.deps.legalMoves) {
      if (readOnlyInquiry) this.speak(this.legalQuestionHelp());
      return;
    }
    const roomCode = this.roomCode, callSid = this.callSid;
    const before = this.deps.snapshot(roomCode);
    if (!before) return;
    const epoch = this.turnEpoch;
    const legalMoves = this.deps.legalMoves(roomCode, callSid, this.commandLocale);
    const facts = this.factsFor(before, legalMoves);
    if (readOnlyInquiry) {
      const direct = directLegalAnswer(spoken, this.commandLocale, before, legalMoves, facts);
      if (direct) { this.speak(direct); return; }
    }
    if (!this.deps.interpret) {
      if (readOnlyInquiry) this.speak(this.legalQuestionHelp());
      return;
    }
    const context: ChessVoiceInterpretContext = {
      phase: before.phase, gameId: before.gameId, revision: before.revision,
      pendingMove: before.pendingMove !== null, readOnlyInquiry, legalMoves, facts,
    };
    const isCurrent = () => {
      const live = this.deps.snapshot(roomCode);
      return this.active && this.turnEpoch === epoch && live?.gameId === before.gameId
        && live.revision === before.revision && live.phase === before.phase;
    };
    let pending!: Promise<unknown>;
    pending = this.deps.interpret(spoken, this.commandLocale, context, isCurrent)
      .then(decision => {
        if (!isCurrent()) return;
        if (decision?.kind === 'answer') {
          const fact = facts.find(item => item.id === decision.factId);
          if (fact) this.speak(fact.text);
          return;
        }
        // The interpreter is advisory. A question cannot silently become a
        // move even if a model or compatible gateway returns an action ID.
        if (readOnlyInquiry) { this.speak(this.legalQuestionHelp()); return; }
        if (decision?.kind === 'clarify') {
          this.speak(this.commandLocale === 'pt-BR'
            ? 'Qual peça e casa você quer? Diga a jogada completa.'
            : 'Which piece and square do you mean? Say the full move.');
          return;
        }
        if (decision?.kind === 'action') {
          if (decision.actionId === 'propose_move' && decision.targetId) {
            const currentMoves = this.deps.legalMoves?.(roomCode, callSid, this.commandLocale) ?? [];
            if (!legalMoves.some(move => move.id === decision.targetId)
              || !currentMoves.some(move => move.id === decision.targetId)) return;
            this.runCommand(spokenMoveFromId(decision.targetId));
            return;
          }
          if (decision.actionId === 'confirm' && before.pendingMove) { this.runCommand('confirm'); return; }
          if (decision.actionId === 'cancel' && (before.pendingMove || before.selection)) { this.runCommand('cancel'); return; }
          if (decision.actionId === 'reset' && before.phase === 'finished') { this.handleReset(); return; }
          if (decision.actionId === 'help') { this.runCommand('help'); return; }
        }
        this.runCommand(spoken);
      })
      .catch(() => {
        if (!isCurrent()) return;
        if (readOnlyInquiry) this.speak(this.legalQuestionHelp());
        else this.runCommand(spoken);
      })
      .finally(() => this.pendingSpeech.delete(pending));
    this.pendingSpeech.add(pending);
  }

  private factsFor(state: ChessState, legalMoves: readonly ChessVoiceMoveChoice[]): VoiceInterpretFact[] {
    const ownTurn = state.turn === state.humanColor;
    const facts: VoiceInterpretFact[] = [
      { id: 'turn', text: this.commandLocale === 'pt-BR'
        ? ownTurn ? 'É sua vez de jogar.' : 'É a vez do rival.'
        : ownTurn ? 'It is your turn.' : 'It is the rival’s turn.' },
      { id: 'side', text: this.commandLocale === 'pt-BR'
        ? `Você joga com as ${state.humanColor === 'w' ? 'brancas' : 'pretas'}.`
        : `You play ${state.humanColor === 'w' ? 'White' : 'Black'}.` },
    ];
    if (state.lastMove) facts.push({ id: 'last_move', text: describeChessMove(state.lastMove, this.commandLocale) });
    if (state.pendingMove) facts.push({ id: 'pending_move', text: this.commandLocale === 'pt-BR'
      ? `A jogada ${state.pendingMove.san} está aguardando sua confirmação.`
      : `The move ${state.pendingMove.san} is waiting for your confirmation.` });
    facts.push(...legalMoveFacts(state, legalMoves, this.commandLocale));
    return facts;
  }

  private legalQuestionHelp(): string {
    return this.commandLocale === 'pt-BR'
      ? 'Posso dizer se o roque é legal agora e para onde cada peça pode ir. Qual peça ou casa inicial você quer consultar?'
      : 'I can tell you whether castling is legal now and where each piece can move. Which piece or starting square do you mean?';
  }

  private introduction(state: ChessState, resumed: boolean): string {
    const side = state.humanColor === 'w'
      ? (this.commandLocale === 'pt-BR' ? 'Brancas' : 'White')
      : (this.commandLocale === 'pt-BR' ? 'Pretas' : 'Black');
    const opening = state.humanColor === 'w'
      ? (this.commandLocale === 'pt-BR' ? 'peão de E dois para E quatro' : 'pawn from E two to E four')
      : (this.commandLocale === 'pt-BR' ? 'peão de E sete para E cinco' : 'pawn from E seven to E five');
    if (this.commandLocale === 'pt-BR') {
      return resumed
        ? `Bem-vindo de volta ao Xadrez por Voz da Twilio Conversation Relay. Você joga com as ${side}. Diga sua jogada ou ajuda.`
        : `Bem-vindo ao Xadrez por Voz da Twilio Conversation Relay. Você joga com as ${side}. Diga uma jogada, por exemplo, ${opening}, ou diga uma peça e sua casa inicial. Pense com calma antes de dizer o destino. Eu repetirei a jogada; diga confirmar ou cancelar. Para fazer roque, diga roque.`;
    }
    return resumed
      ? `Welcome back to Voice Chess on Twilio Conversation Relay. You command ${side}. Say your move or help.`
      : `Welcome to Voice Chess on Twilio Conversation Relay. You command ${side}. Say a move, for example, ${opening}, or name a piece and its starting square. Take your time before naming the destination. I will repeat your move; say confirm or cancel. For castling, say castle.`;
  }

  private resultLine(state: ChessState): string {
    const won = state.result?.winner === state.humanColor;
    const drew = state.result?.winner === null;
    const next = this.stationManaged ? this.stationWaitLine()
      : this.commandLocale === 'pt-BR'
        ? 'Se quiser outra partida, diga jogar de novo.'
        : 'Say play again for a new game.';
    if (this.commandLocale === 'pt-BR') {
      if (drew) return `Empate. ${next}`;
      const outcome = won
        ? 'Xeque-mate! Você venceu o duelo de magos.'
        : 'Xeque-mate. O mago rival venceu desta vez.';
      return `${outcome} ${next}`;
    }
    if (drew) return `The duel ends in a draw. ${next}`;
    const outcome = won
      ? 'Checkmate! You won the wizard duel.'
      : 'Checkmate. The rival wizard wins this time.';
    return `${outcome} ${next}`;
  }

  private stationWaitLine(): string {
    return this.commandLocale === 'pt-BR'
      ? 'A estação prepara a próxima partida. Aguarde o próximo jogo.'
      : 'The station will prepare the next game. Please wait for the next match.';
  }

  private speak(line: string, throughComputerReply = false): void {
    const epoch = this.turnEpoch;
    const roomCode = this.roomCode;
    const current = roomCode ? this.deps.snapshot(roomCode) : null;
    const result = this.deps.say(line, () => {
      const live = roomCode ? this.deps.snapshot(roomCode) : null;
      if (!this.active || epoch !== this.turnEpoch) return false;
      if (!current) return true;
      if (live?.gameId !== current.gameId) return false;
      if (live.revision === current.revision && live.phase === current.phase) return true;
      // The computer responds after 900 ms, often before Relay has finished a human
      // move confirmation or the Black-side introduction. Both remain relevant on
      // the same board; queue its move *after* them unless the caller interrupts.
      return throughComputerReply && live.revision === current.revision + 1
        && live.ply === current.ply + 1 && live.lastMove?.actor === 'computer'
        && current.phase === 'playing' && (live.phase === 'playing' || live.phase === 'finished');
    });
    if (!result || typeof (result as Promise<boolean>).then !== 'function') return;
    let tracked!: Promise<unknown>;
    tracked = Promise.resolve(result).catch(() => false).finally(() => this.pendingSpeech.delete(tracked));
    this.pendingSpeech.add(tracked);
  }
}

function spokenMoveFromId(id: string): string {
  const from = id.slice(0, 2).toUpperCase();
  const to = id.slice(2, 4).toUpperCase();
  const promotion: Record<string, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
  return `${from} to ${to}${promotion[id[4] ?? ''] ? ` promote to ${promotion[id[4]!]}` : ''}`;
}

interface LegalChessMove {
  id: string;
  from: ChessSquare;
  to: ChessSquare;
  piece: ChessPieceType;
}

const CHESS_PIECES: readonly ChessPieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const PIECE_NAME: Record<SupportedLocale, Record<ChessPieceType, [string, string]>> = {
  'en-US': {
    p: ['pawn', 'pawns'], n: ['knight', 'knights'], b: ['bishop', 'bishops'],
    r: ['rook', 'rooks'], q: ['queen', 'queens'], k: ['king', 'kings'],
  },
  'pt-BR': {
    p: ['peão', 'peões'], n: ['cavalo', 'cavalos'], b: ['bispo', 'bispos'],
    r: ['torre', 'torres'], q: ['dama', 'damas'], k: ['rei', 'reis'],
  },
};
const RANK_NAME: Record<SupportedLocale, readonly string[]> = {
  'en-US': ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'],
  'pt-BR': ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito'],
};

function sayChessSquare(square: ChessSquare, locale: SupportedLocale): string {
  return `${square[0]!.toUpperCase()} ${RANK_NAME[locale][Number(square[1]) - 1]}`;
}

function currentLegalMoves(state: ChessState, choices: readonly ChessVoiceMoveChoice[]): LegalChessMove[] {
  if (state.phase === 'finished' || !state.playerConnected || state.turn !== state.humanColor) return [];
  const ownPieces = new Map(state.pieces.filter(piece => piece.color === state.humanColor)
    .map(piece => [piece.square, piece.type]));
  return choices.flatMap(choice => {
    const match = /^([a-h][1-8])([a-h][1-8])(?:[qrbn])?$/.exec(choice.id);
    if (!match) return [];
    const from = match[1] as ChessSquare;
    const piece = ownPieces.get(from);
    return piece ? [{ id: choice.id, from, to: match[2] as ChessSquare, piece }] : [];
  });
}

function unavailableLegalLine(state: ChessState, locale: SupportedLocale): string | null {
  if (state.phase === 'finished') return locale === 'pt-BR'
    ? 'A partida terminou; não há mais jogadas nesta posição.'
    : 'The match is over; there are no more moves in this position.';
  if (!state.playerConnected) return locale === 'pt-BR'
    ? 'Aguarde a ligação do jogador antes de consultar as jogadas.'
    : 'Wait for the player to connect before checking moves.';
  if (state.turn !== state.humanColor) return locale === 'pt-BR'
    ? 'É a vez do rival. Pergunte novamente depois da jogada dele.'
    : 'It is the rival’s turn. Ask again after their move.';
  return null;
}

function legalMoveFacts(state: ChessState, choices: readonly ChessVoiceMoveChoice[], locale: SupportedLocale): VoiceInterpretFact[] {
  const unavailable = unavailableLegalLine(state, locale);
  const moves = currentLegalMoves(state, choices);
  const isCastle = (side: 'king' | 'queen') => moves.some(move =>
    move.piece === 'k' && move.id === `${state.humanColor === 'w' ? 'e1' : 'e8'}${side === 'king' ? 'g' : 'c'}${state.humanColor === 'w' ? '1' : '8'}`);
  const king = isCastle('king'), queen = isCastle('queen');
  const castle = unavailable ?? (locale === 'pt-BR'
    ? king && queen ? 'Sim. O roque pequeno e o grande são legais agora. Diga qual lado se quiser propor a jogada.'
      : king || queen ? `Sim. O roque ${king ? 'pequeno' : 'grande'} é legal agora. Diga roque se quiser propor a jogada.`
        : 'Não. O roque não é legal nesta posição.'
    : king && queen ? 'Yes. Both kingside and queenside castling are legal now. Name a side if you want to propose it.'
      : king || queen ? `Yes. ${king ? 'Kingside' : 'Queenside'} castling is legal now. Say castle if you want to propose it.`
        : 'No. Castling is not legal in this position.');
  const sideFact = (side: 'king' | 'queen') => unavailable ?? (locale === 'pt-BR'
    ? `${isCastle(side) ? 'Sim' : 'Não'}. O roque ${side === 'king' ? 'pequeno' : 'grande'} ${isCastle(side) ? 'é' : 'não é'} legal agora.`
    : `${isCastle(side) ? 'Yes' : 'No'}. ${side === 'king' ? 'Kingside' : 'Queenside'} castling is ${isCastle(side) ? '' : 'not '}legal now.`);
  const movablePieces = CHESS_PIECES.filter(piece => moves.some(move => move.piece === piece))
    .map(piece => PIECE_NAME[locale][piece][1]);
  const summary = unavailable ?? (locale === 'pt-BR'
    ? `Você tem ${moves.length} ${moves.length === 1 ? 'jogada legal' : 'jogadas legais'} agora. ${movablePieces.length ? `Peças que podem jogar: ${formatList(locale, movablePieces)}.` : 'Nenhuma peça pode se mover.'} Pergunte por uma peça ou casa inicial para ouvir os destinos.`
    : `You have ${moves.length} legal ${moves.length === 1 ? 'move' : 'moves'} now. ${movablePieces.length ? `Pieces that can move: ${formatList(locale, movablePieces)}.` : 'No pieces can move.'} Ask about a piece or starting square for its destinations.`);
  const facts: VoiceInterpretFact[] = [
    { id: 'legal_moves', text: summary },
    { id: 'castle', text: castle },
    { id: 'castle_kingside', text: sideFact('king') },
    { id: 'castle_queenside', text: sideFact('queen') },
    { id: 'castle_rules', text: locale === 'pt-BR'
      ? `No roque, o rei anda duas casas em direção à torre e a torre fica ao lado dele. Rei e torre não podem ter se movido, o caminho deve estar livre e o rei não pode estar em xeque nem atravessar ou terminar numa casa ameaçada. ${castle}`
      : `Castling moves the king two squares toward a rook, then the rook lands beside it. Neither can have moved, the path must be clear, and the king cannot start in check or cross or end on an attacked square. ${castle}` },
  ];
  for (const piece of CHESS_PIECES) {
    const placements = state.pieces.filter(placement => placement.color === state.humanColor && placement.type === piece);
    const matching = moves.filter(move => move.piece === piece);
    const plural = PIECE_NAME[locale][piece][1];
    const sourceLines = placements.flatMap(placement => {
      const destinations = [...new Set(matching.filter(move => move.from === placement.square).map(move => move.to))];
      if (!destinations.length) return [];
      const text = locale === 'pt-BR'
        ? `Seu ${PIECE_NAME[locale][piece][0]} em ${sayChessSquare(placement.square, locale)} pode ir para ${formatList(locale, destinations.map(square => sayChessSquare(square, locale)))}.`
        : `Your ${PIECE_NAME[locale][piece][0]} on ${sayChessSquare(placement.square, locale)} can move to ${formatList(locale, destinations.map(square => sayChessSquare(square, locale)))}.`;
      return [{ square: placement.square, text }];
    });
    let pieceText: string;
    if (unavailable) pieceText = unavailable;
    else if (!placements.length) pieceText = locale === 'pt-BR'
      ? `Você não tem ${plural} no tabuleiro.` : `You have no ${plural} on the board.`;
    else if (!matching.length) pieceText = locale === 'pt-BR'
      ? `Seus ${plural} não têm jogadas legais agora.` : `Your ${plural} have no legal moves now.`;
    else {
      const shown = sourceLines.slice(0, 4);
      const more = sourceLines.length - shown.length;
      pieceText = `${shown.map(source => source.text).join(' ')}${more ? locale === 'pt-BR'
        ? ` Outras ${more} peças também podem se mover; diga a casa inicial para ouvir esses destinos.`
        : ` ${more} more pieces can move; name a starting square to hear those destinations.` : ''}`;
    }
    facts.push({ id: `legal_piece_${piece}`, text: pieceText });
    for (const placement of placements) {
      const source = sourceLines.find(line => line.square === placement.square);
      facts.push({ id: `legal_from_${placement.square}`, text: unavailable ?? source?.text ?? (locale === 'pt-BR'
        ? `Seu ${PIECE_NAME[locale][piece][0]} em ${sayChessSquare(placement.square, locale)} não tem jogada legal agora.`
        : `Your ${PIECE_NAME[locale][piece][0]} on ${sayChessSquare(placement.square, locale)} has no legal move now.`) });
    }
  }
  return facts;
}

function isReadOnlyChessInquiry(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizeForMatching(spoken, locale);
  // A polite command phrased as a request remains actionable. The player will
  // still have to confirm any move it proposes.
  if (/^(?:please )?(?:can|could|would|will) you (?:please )?(?:move|play|castle|make|put|send|push)\b/.test(text)
    || /^(?:por favor )?(?:voce pode|pode) (?:por favor )?(?:mover|jogar|fazer o roque)\b/.test(text)) return false;
  return spoken.includes('?')
    || /^(?:can i|could i|may i|should i|would i|do i|does my|did i|am i|is|are|where|which|what|how|why|when|if|tell me|explain|can you tell|could you tell|would you tell|posso|poderia eu|devo|eu posso|e possivel|isso e|esta|estao|onde|para onde|quais|qual|como|por que|se eu|me diga|me explique)\b/.test(text)
    || /\b(?:wonder if|wondering if|want to know if|whether|quero saber se|queria saber se|me pergunto se)\b/.test(text);
}

const SPOKEN_RANKS: Readonly<Record<string, string>> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  um: '1', uma: '1', dois: '2', duas: '2', tres: '3', quatro: '4', cinco: '5', seis: '6', sete: '7', oito: '8',
};

function questionSquares(text: string): ChessSquare[] {
  return [...text.matchAll(/\b([a-h])\s*(one|two|three|four|five|six|seven|eight|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|[1-8])\b/g)]
    .map(match => `${match[1]}${SPOKEN_RANKS[match[2]!] ?? match[2]}` as ChessSquare);
}

function namedPiece(text: string): ChessPieceType | null {
  const patterns: readonly [ChessPieceType, RegExp][] = [
    ['p', /\b(?:pawn|peao)\b/], ['n', /\b(?:knight|night|horse|cavalo)\b/],
    ['b', /\b(?:bishop|bispo)\b/], ['r', /\b(?:rook|torre|castle piece)\b/],
    ['q', /\b(?:queen|rainha|dama)\b/], ['k', /\b(?:king|rei)\b/],
  ];
  let first: { piece: ChessPieceType; index: number } | null = null;
  for (const [piece, pattern] of patterns) {
    const index = pattern.exec(text)?.index;
    if (index !== undefined && (first === null || index < first.index)) first = { piece, index };
  }
  return first?.piece ?? null;
}

function directLegalAnswer(spoken: string, locale: SupportedLocale, state: ChessState,
  choices: readonly ChessVoiceMoveChoice[], facts: readonly VoiceInterpretFact[]): string | null {
  const text = normalizeForMatching(spoken, locale);
  const fact = (id: string) => facts.find(item => item.id === id)?.text ?? null;
  const moveQuestion = /\b(?:move|moves|mover|jogar|jogada|jogadas|go|ir|legal|allowed|permitido|possible|possivel|can|could|pode|posso|destino|destination)\b/.test(text);
  if (!moveQuestion && !/\b(?:castle|castling|roque)\b/.test(text)) return null;
  const squares = questionSquares(text);
  const piece = namedPiece(text);
  const castleQuestion = /\b(?:castle|castling|roque)\b/.test(text) && !/\bcastle piece\b/.test(text);
  if (castleQuestion && squares.length === 0) {
    if (/^(?:how|como|explain|me explique)\b/.test(text)) return fact('castle_rules');
    if (/\b(?:kingside|king side|short|pequeno|lado do rei)\b/.test(text)) return fact('castle_kingside');
    if (/\b(?:queenside|queen side|long|grande|lado da dama)\b/.test(text)) return fact('castle_queenside');
    return fact('castle');
  }
  const squareWord = '[a-h]\\s*(?:[1-8]|one|two|three|four|five|six|seven|eight|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito)';
  const namedSource = new RegExp(`\\b(?:pawn|peao|knight|night|horse|cavalo|bishop|bispo|rook|torre|queen|rainha|dama|king|rei)\\s+(?:on|at|em|na casa|no quadrado)\\s+${squareWord}\\b`).exec(text);
  const sourceQuestion = new RegExp(`\\b(?:from|de|da casa|do quadrado)\\s+${squareWord}\\b`).test(text)
    || (namedSource !== null && namedPiece(namedSource[0]) === piece);
  if (squares.length === 1 && sourceQuestion) {
    const from = squares[0]!;
    return fact(`legal_from_${from}`) ?? (locale === 'pt-BR'
      ? `Você não tem uma peça em ${sayChessSquare(from, locale)}.`
      : `You have no piece on ${sayChessSquare(from, locale)}.`);
  }
  if (squares.length > 0 && squares.length <= 2) {
    const unavailable = unavailableLegalLine(state, locale);
    if (unavailable) return unavailable;
    const moves = currentLegalMoves(state, choices);
    const from = squares.length === 2 ? squares[0] : null;
    const to = squares[squares.length - 1]!;
    const matches = moves.filter(move => move.to === to && (!from || move.from === from)
      && (!piece || move.piece === piece));
    const named = piece ? PIECE_NAME[locale][piece][0] : null;
    if (matches.length) {
      const sources = [...new Set(matches.map(move => sayChessSquare(move.from, locale)))];
      return locale === 'pt-BR'
        ? `Sim. ${named ? `Seu ${named}` : 'Uma peça sua'} em ${formatList(locale, sources)} pode ir legalmente para ${sayChessSquare(to, locale)}. Nenhuma jogada foi feita.`
        : `Yes. ${named ? `Your ${named}` : 'Your piece'} on ${formatList(locale, sources)} can legally move to ${sayChessSquare(to, locale)}. No move was made.`;
    }
    return locale === 'pt-BR'
      ? `Não. ${from ? `A jogada de ${sayChessSquare(from, locale)} para` : `Uma jogada para`} ${sayChessSquare(to, locale)}${named ? ` com ${named}` : ''} não é legal nesta posição.`
      : `No. ${from ? `A move from ${sayChessSquare(from, locale)} to` : `A move to`} ${sayChessSquare(to, locale)}${named ? ` with your ${named}` : ''} is not legal in this position.`;
  }
  if (piece) return fact(`legal_piece_${piece}`);
  if (/\b(?:moves|jogadas|options|opcoes|possibilities|possibilidades)\b/.test(text)) return fact('legal_moves');
  return null;
}
