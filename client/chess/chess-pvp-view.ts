import type { ChessColor, ChessMode, ChessPieceType, ChessPlayerSeat, ChessState } from '../../shared/chess-protocol';
import type { SupportedLocale } from '../../shared/i18n/locales';
import { resultSummary } from './chess-result-view';

export interface ChessPvpScreenCopy {
  whiteLabel: string;
  blackLabel: string;
  readyCount: number;
  title: string;
  detail: string;
  turnLabel: string;
  prompt: string;
  lastMoveLabel: string;
  lastCaption: string;
  callCardTitle: string;
  callCardInstructions: string;
}

/** A fresh standalone launch cannot change a room while an earlier call still owns it. */
export function chessModeConflictScreenCopy(requestedMode: ChessMode, locale: SupportedLocale): {
  title: string; detail: string; turnLabel: string; prompt: string;
} {
  if (locale === 'pt-BR') return requestedMode === 'pvp'
    ? {
      title: 'O xadrez solo ainda ocupa esta sala',
      detail: 'Uma ligação anterior de um jogador ainda está usando esta sala.',
      turnLabel: 'Modo em uso',
      prompt: 'Encerre a ligação anterior, aguarde até 30 segundos, escolha Voltar e abra o Xadrez com 2 jogadores novamente.',
    }
    : {
      title: 'O xadrez com dois jogadores ainda ocupa esta sala',
      detail: 'Uma partida anterior com dois jogadores ainda está usando esta sala.',
      turnLabel: 'Modo em uso',
      prompt: 'Encerre as ligações anteriores, aguarde até 30 segundos, escolha Voltar e abra o Xadrez com 1 jogador novamente.',
    };
  return requestedMode === 'pvp'
    ? {
      title: 'Solo Chess is still using this room',
      detail: 'A previous one-player call is still connected to this room.',
      turnLabel: 'Mode conflict',
      prompt: 'End that call, wait up to 30 seconds for the room to clear, then choose Back and launch Chess with 2 players again.',
    }
    : {
      title: 'Two-player Chess is still using this room',
      detail: 'A previous two-player match still has a call in this room.',
      turnLabel: 'Mode conflict',
      prompt: 'End the earlier calls, wait up to 30 seconds for the room to clear, then choose Back and launch Chess with 1 player again.',
    };
}

export function chessPvpScreenCopy(state: ChessState, locale: SupportedLocale): ChessPvpScreenCopy {
  const portuguese = locale === 'pt-BR';
  const players = state.players ?? [];
  const phonePending = new Set(state.phonePendingPlayerIds ?? []);
  const phoneTurnPending = new Set(state.phoneTurnPendingPlayerIds ?? []);
  const phoneRetry = new Set(state.phoneRetryPlayerIds ?? []);
  const seat = (color: ChessColor): ChessPlayerSeat | undefined =>
    players.find(player => player.color === color);
  const colorName = (color: ChessColor): string => color === 'w'
    ? portuguese ? 'Brancas' : 'White' : portuguese ? 'Pretas' : 'Black';
  const label = (color: ChessColor): string => {
    const player = seat(color);
    if (!player) return `${colorName(color)} · ${portuguese ? 'Aguardando chamada' : 'Waiting for caller'}`;
    const status = !player.connected ? portuguese ? 'Reconectando' : 'Reconnecting'
      : !player.nameConfirmed ? portuguese ? 'Confirme o nome' : 'Name needed'
        : phoneTurnPending.has(player.playerId) ? portuguese ? 'Conversa no telefone' : 'Phone conversation in progress'
        : phoneRetry.has(player.playerId) ? portuguese ? 'Diga repetir na chamada' : 'Say repeat on phone'
        : phonePending.has(player.playerId) ? portuguese ? 'Ouvindo orientações' : 'Phone guidance playing'
        : portuguese ? 'Pronto' : 'Ready';
    const displayName = player.nameConfirmed ? player.name
      : color === 'w' ? portuguese ? 'Jogador 1' : 'Player 1'
        : portuguese ? 'Jogador 2' : 'Player 2';
    return `${colorName(color)} · ${displayName} · ${status}`;
  };
  const readyCount = players.filter(player => player.connected && player.nameConfirmed
    && !phonePending.has(player.playerId)).length;
  const turnName = seat(state.turn)?.name ?? colorName(state.turn);
  const moveName = state.lastMove
    ? seat(state.lastMove.color)?.name ?? colorName(state.lastMove.color) : null;
  const lastMoveLabel = state.lastMove ? `${moveName} · ${state.lastMove.san}`
    : portuguese ? 'Nenhum lance ainda' : 'No moves yet';
  const lastCaption = state.lastMove
    ? portuguese ? `${moveName} jogou ${state.lastMove.san}.` : `${moveName} played ${state.lastMove.san}.`
    : portuguese ? 'Os dois jogadores compartilham este tabuleiro.' : 'Both callers share this board.';
  const common = {
    whiteLabel: label('w'), blackLabel: label('b'), readyCount,
    lastMoveLabel, lastCaption,
    callCardTitle: readyCount === 0
      ? portuguese ? 'Ligue para jogar' : 'Call to play'
      : portuguese ? 'Segundo jogador' : 'Second caller',
    callCardInstructions: readyCount === 0
      ? portuguese ? 'Cada jogador liga e diz seu nome.' : 'Each player calls and says their name.'
      : portuguese ? 'Ligue e diga seu nome para entrar.' : 'Call and say your name to join.',
  };
  if (state.phase === 'finished') return {
    ...common,
    title: portuguese ? 'Partida encerrada' : 'Match complete',
    detail: resultSummary(state.result, 'w', locale, { mode: 'pvp', players }),
    turnLabel: portuguese ? 'Resultado final' : 'Final result',
    prompt: portuguese ? 'O tabuleiro mostra a posição final.' : 'The board shows the final position.',
  };
  if (state.phase === 'waiting') {
    const paused = players.length === 2 && players.every(player => player.nameConfirmed)
      && players.some(player => !player.connected);
    const pendingNames = players.filter(player => phonePending.has(player.playerId))
      .map(player => player.name).join(portuguese ? ' e ' : ' and ');
    const busyNames = players.filter(player => phoneTurnPending.has(player.playerId))
      .map(player => player.name).join(portuguese ? ' e ' : ' and ');
    const retryNames = players.filter(player => phoneRetry.has(player.playerId))
      .map(player => player.name).join(portuguese ? ' e ' : ' and ');
    const waitingForPhone = players.length === 2
      && players.every(player => player.connected && player.nameConfirmed)
      && phonePending.size > 0;
    return {
      ...common,
      title: paused ? portuguese ? 'Partida pausada' : 'Match paused'
        : portuguese ? `${readyCount} de 2 jogadores prontos` : `${readyCount} of 2 players ready`,
      detail: paused
        ? portuguese ? 'Aguardando a chamada voltar. Nenhum lance será aceito enquanto isso.'
          : 'Waiting for the missing caller to reconnect. Moves are paused.'
        : waitingForPhone
          ? retryNames
            ? portuguese ? `A resposta ou orientação de ${retryNames} pelo telefone não terminou. Diga repetir na chamada ou reconecte.`
              : `${retryNames}'s phone answer or guidance did not finish. Say repeat on the call or reconnect.`
            : busyNames
            ? portuguese ? `Aguardando ${busyNames} terminar a conversa no telefone. O tabuleiro começará depois.`
              : `Waiting for ${busyNames} to finish their phone conversation. The board starts afterward.`
            : portuguese ? `As orientações pelo telefone ainda estão tocando para ${pendingNames}. O tabuleiro começará depois.`
              : `Phone guidance is still playing for ${pendingNames}. The board starts after it finishes.`
        : portuguese ? 'Os dois jogadores precisam conectar a chamada e confirmar o nome.'
          : 'Both callers must connect and confirm their names before the board starts.',
      turnLabel: portuguese ? 'Aguardando jogadores' : 'Waiting for players',
      prompt: waitingForPhone
        ? retryNames
          ? portuguese ? 'Repita as orientações pelo telefone para começar.'
            : 'Repeat the phone guidance to start.'
          : busyNames
          ? portuguese ? 'O tabuleiro aguardará as respostas nas duas chamadas.'
            : 'The board will wait for both phone answers.'
          : portuguese ? 'O tabuleiro aguardará as orientações nas duas chamadas.'
            : 'The board will wait for both phone introductions.'
        : portuguese ? 'O tabuleiro não avançará até os dois estarem prontos.'
          : 'The board will not advance until both players are ready.',
    };
  }
  if (state.phase === 'pending' && state.pendingMove) return {
    ...common,
    title: portuguese ? `${turnName} confirma` : `${turnName} confirms`,
    detail: portuguese ? `${turnName} deve confirmar ou cancelar ${state.pendingMove.san} na chamada.`
      : `${turnName} must confirm or cancel ${state.pendingMove.san} on their call.`,
    turnLabel: portuguese ? 'Aguardando confirmação' : 'Awaiting confirmation',
    prompt: portuguese ? 'O rival não pode confirmar este lance.'
      : 'The other caller cannot confirm this move.',
  };
  return {
    ...common,
    title: portuguese ? `Vez de ${turnName}` : `${turnName}'s turn`,
    detail: portuguese ? `Só ${turnName} pode jogar nesta vez.` : `Only ${turnName} can move now.`,
    turnLabel: portuguese ? `${colorName(state.turn)} jogam` : `${colorName(state.turn)} to move`,
    prompt: portuguese ? `${turnName} diz o lance na chamada e depois confirma.`
      : `${turnName} says a move on their call, then confirms it.`,
  };
}

const PIECE_NAMES: Record<SupportedLocale, Record<ChessPieceType, string>> = {
  'en-US': { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' },
  'pt-BR': { p: 'peão', n: 'cavalo', b: 'bispo', r: 'torre', q: 'dama', k: 'rei' },
};

function pvpPlayerName(state: ChessState, color: ChessColor, locale: SupportedLocale): string {
  return state.players?.find(player => player.color === color)?.name
    ?? (color === 'w' ? locale === 'pt-BR' ? 'Brancas' : 'White'
      : locale === 'pt-BR' ? 'Pretas' : 'Black');
}

function portugueseArticle(piece: ChessPieceType, definite = true): string {
  const feminine = piece === 'q' || piece === 'r';
  return definite ? feminine ? 'a' : 'o' : feminine ? 'uma' : 'um';
}

export function chessPvpMoveCaption(state: ChessState, locale: SupportedLocale): string {
  const move = state.lastMove;
  if (!move) return '';
  const mover = pvpPlayerName(state, move.color, locale);
  const opponent = pvpPlayerName(state, move.color === 'w' ? 'b' : 'w', locale);
  const target = move.to.toUpperCase();
  const piece = PIECE_NAMES[locale][move.piece];
  const captured = move.captured ? PIECE_NAMES[locale][move.captured] : null;
  if (locale === 'pt-BR') {
    const action = move.castle
      ? `${mover} fez roque.`
      : captured
        ? `${portugueseArticle(move.piece).toUpperCase()} ${piece} de ${mover} capturou ${portugueseArticle(move.captured!)} ${captured} de ${opponent} em ${target}.`
        : `${mover} moveu ${portugueseArticle(move.piece)} ${piece} para ${target}.`;
    return `${action}${move.promotion ? ` O peão virou ${PIECE_NAMES[locale][move.promotion]}.` : ''}`
      + `${move.checkmate ? ' Xeque-mate.' : move.check ? ' Xeque.' : ''}`;
  }
  const action = move.castle
    ? `${mover} castled.`
    : captured
      ? `${mover}'s ${piece} captured ${opponent}'s ${captured} on ${target}.`
      : `${mover} moved a ${piece} to ${target}.`;
  return `${action}${move.promotion ? ` The pawn became a ${PIECE_NAMES[locale][move.promotion]}.` : ''}`
    + `${move.checkmate ? ' Checkmate.' : move.check ? ' Check.' : ''}`;
}

export function chessPvpCaptureBanner(state: ChessState, locale: SupportedLocale): string {
  const move = state.lastMove;
  if (!move?.captured) return '';
  const mover = pvpPlayerName(state, move.color, locale);
  const victim = PIECE_NAMES[locale][move.captured];
  if (locale === 'pt-BR') return `${mover} capturou ${portugueseArticle(move.captured, false)} ${victim}!`;
  return `${mover} captured a ${victim}!`;
}
