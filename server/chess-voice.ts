import { parseCrMessage } from './conversation-relay';
import { parseChessIntent, describeChessMove } from '../shared/chess-intent';
import type { ChessCommandResult, ChessEvent, ChessState } from '../shared/chess-protocol';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';

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
    if (message.type === 'prompt' && message.last) {
      this.handleFinalPrompt(message.voicePrompt);
    } else if (message.type === 'dtmf') {
      const command = message.digit === '1' ? 'confirm'
        : message.digit === '0' ? 'cancel'
          : message.digit === '9' ? 'help' : '';
      if (command) this.handleFinalPrompt(command);
    }
  }

  onRoomEvents(events: readonly ChessEvent[]): void {
    if (!this.active || !this.roomCode || events.some(event => event.type === 'reset')) return;
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

  handleReplaced(): void { this.active = false; }

  handleClose(): void {
    if (!this.active) return;
    this.active = false;
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
    this.speak(this.introduction(state, binding.resumed));
    if (state.lastMove?.actor === 'computer' && (state.ply === 1 || binding.resumed)) {
      this.speak(describeChessMove(state.lastMove, this.commandLocale));
    }
    if (state.result) this.speak(this.resultLine(state));
  }

  private handleFinalPrompt(spoken: string): void {
    if (!this.roomCode || !this.callSid || !spoken.trim()) return;
    const intent = parseChessIntent(spoken, this.commandLocale);
    if (intent.kind === 'reset') {
      if (this.stationManaged) {
        this.speak(this.stationWaitLine());
        return;
      }
      const before = this.deps.snapshot(this.roomCode);
      if (before?.phase !== 'finished' || !this.deps.restart(this.roomCode, this.callSid)) {
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
      return;
    }

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
    const result = this.deps.say(line, () => this.active);
    if (!result || typeof (result as Promise<boolean>).then !== 'function') return;
    let tracked!: Promise<unknown>;
    tracked = Promise.resolve(result).catch(() => false).finally(() => this.pendingSpeech.delete(tracked));
    this.pendingSpeech.add(tracked);
  }
}
