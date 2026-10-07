import { parseCrMessage } from './conversation-relay';
import { parseChessIntent, describeChessMove } from '../shared/chess-intent';
import type { ChessCommandResult, ChessEvent, ChessState } from '../shared/chess-protocol';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import type { ChessVoiceMoveChoice } from './chess-room';
import type { VoiceInterpretFact, VoiceInterpretResult } from './voice-interpreter';

export interface ChessVoiceInterpretContext {
  phase: ChessState['phase'];
  gameId: number;
  revision: number;
  pendingMove: boolean;
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
        this.speak(this.introduction(next, false));
        if (next.lastMove?.actor === 'computer' && next.ply === 1)
          this.speak(describeChessMove(next.lastMove, this.commandLocale));
      }
      return;
    }
    for (const event of events) {
      if (event.type !== 'move' || event.move.actor !== 'computer') continue;
      this.turnEpoch++;
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
    this.speak(this.introduction(state, binding.resumed));
    if (state.lastMove?.actor === 'computer' && (state.ply === 1 || binding.resumed)) {
      this.speak(describeChessMove(state.lastMove, this.commandLocale));
    }
  }

  private handleFinalPrompt(spoken: string): void {
    if (!this.roomCode || !this.callSid || !spoken.trim()) return;
    this.turnEpoch++;
    const intent = parseChessIntent(spoken, this.commandLocale);
    if (intent.kind === 'reset') {
      this.handleReset();
      return;
    }

    if (intent.kind === 'unknown' && this.deps.interpret && this.deps.legalMoves) {
      this.requestSemanticTurn(spoken);
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
      this.speak(this.introduction(next, false));
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
      this.speak(describeChessMove(result.state.lastMove, this.commandLocale));
      if (result.state.result) this.speak(this.resultLine(result.state));
    } else if (result.code === 'finished' && this.stationManaged) {
      this.speak(this.stationWaitLine());
    } else {
      this.speak(result.message);
    }
  }

  private requestSemanticTurn(spoken: string): void {
    if (!this.roomCode || !this.callSid || !this.deps.interpret || !this.deps.legalMoves) return;
    const roomCode = this.roomCode, callSid = this.callSid;
    const before = this.deps.snapshot(roomCode);
    if (!before) return;
    const epoch = this.turnEpoch;
    const legalMoves = this.deps.legalMoves(roomCode, callSid, this.commandLocale);
    const facts = this.factsFor(before);
    const context: ChessVoiceInterpretContext = {
      phase: before.phase, gameId: before.gameId, revision: before.revision,
      pendingMove: before.pendingMove !== null, legalMoves, facts,
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
      .catch(() => { if (isCurrent()) this.runCommand(spoken); })
      .finally(() => this.pendingSpeech.delete(pending));
    this.pendingSpeech.add(pending);
  }

  private factsFor(state: ChessState): VoiceInterpretFact[] {
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
    return facts;
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
        ? `Bem-vindo de volta ao Xadrez por Voz. Você joga com as ${side}. Diga sua jogada ou ajuda.`
        : `Bem-vindo ao Xadrez por Voz. Você joga com as ${side}. Diga uma jogada, por exemplo, ${opening}, ou selecione uma peça primeiro. Eu repetirei a jogada. Diga confirmar ou cancelar.`;
    }
    return resumed
      ? `Welcome back to Voice Chess. You command ${side}. Say your move or help.`
      : `Welcome to Voice Chess. You command ${side}. Say a move, for example, ${opening}, or select a piece first. I will repeat your move. Say confirm or cancel.`;
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

  private speak(line: string): void {
    const epoch = this.turnEpoch;
    const roomCode = this.roomCode;
    const current = roomCode ? this.deps.snapshot(roomCode) : null;
    const result = this.deps.say(line, () => {
      const live = roomCode ? this.deps.snapshot(roomCode) : null;
      return this.active && epoch === this.turnEpoch
        && (!current || (live?.gameId === current.gameId && live.revision === current.revision
          && live.phase === current.phase));
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
