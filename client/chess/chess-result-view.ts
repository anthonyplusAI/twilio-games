import type { SupportedLocale } from '../../shared/i18n/locales';
import type { ChessColor, ChessMode, ChessPlayerSeat, ChessResult } from '../../shared/chess-protocol';

type ChessResultViewOptions = { mode?: ChessMode; players?: readonly ChessPlayerSeat[];
  rematchReadyPlayerIds?: readonly string[]; rematchWaitingForPhone?: boolean };

export interface ChessResultPresentation {
  outcome: 'win' | 'loss' | 'draw';
  kicker: string;
  title: string;
  detail: string;
  replayLabel: string;
  exitLabel: string;
  stationNextRound: string;
  showReplay: boolean;
  showExit: boolean;
}

export function chessResultPresentation(
  result: ChessResult,
  humanColor: ChessColor,
  locale: SupportedLocale,
  options: { canReplayOnDisplay: boolean; stationManaged: boolean } & ChessResultViewOptions,
): ChessResultPresentation {
  const isPortuguese = locale === 'pt-BR';
  const pvp = options.mode === 'pvp';
  const outcome = result.winner === null ? 'draw'
    : pvp || result.winner === humanColor ? 'win' : 'loss';
  const winner = result.winner === null ? null
    : options.players?.find(player => player.color === result.winner)?.name
      ?? (result.winner === 'w' ? isPortuguese ? 'Brancas' : 'White'
        : isPortuguese ? 'Pretas' : 'Black');
  const replayVoters = options.players?.filter(player =>
    options.rematchReadyPlayerIds?.includes(player.playerId)) ?? [];
  const pvpNextRound = options.rematchWaitingForPhone
    ? isPortuguese
      ? 'Os dois pediram outra partida. Aguardando os avisos terminarem nas duas chamadas.'
      : 'Both callers requested another match. Waiting for both phone announcements to finish.'
    : replayVoters.length === 1
      ? isPortuguese
        ? `${replayVoters[0]!.name} pediu outra partida. Aguardando o outro jogador dizer jogar de novo.`
        : `${replayVoters[0]!.name} requested another match. Waiting for the other caller to say play again.`
      : options.players?.some(player => !player.connected)
        ? isPortuguese
          ? 'Aguardando a chamada voltar. Se ela terminar, iniciem uma nova partida para dois jogadores.'
          : 'Waiting for the missing call to reconnect. If it ended, start a new two-player match.'
        : isPortuguese
          ? 'Para jogar de novo, os dois jogadores dizem jogar de novo em suas chamadas.'
          : 'To play again, both callers say play again on their phones.';
  return {
    outcome,
    kicker: isPortuguese ? 'Duelo encerrado' : 'Duel complete',
    title: pvp && winner ? isPortuguese ? `${winner} venceu` : `${winner} wins`
      : outcome === 'draw' ? isPortuguese ? 'Empate' : 'Draw'
      : outcome === 'win' ? isPortuguese ? 'Vitória' : 'Victory'
        : isPortuguese ? 'Derrota' : 'Defeat',
    detail: resultSummary(result, humanColor, locale, options),
    replayLabel: isPortuguese ? 'Jogar de novo' : 'Play again',
    exitLabel: isPortuguese ? 'Voltar aos jogos' : 'Exit to games',
    stationNextRound: pvp && !options.stationManaged
      ? pvpNextRound
      : isPortuguese
        ? 'Quer jogar de novo? Entre novamente na fila da estação pelo telefone.'
        : 'Want another turn? Rejoin the station queue on your phone.',
    showReplay: !pvp && !options.stationManaged && options.canReplayOnDisplay,
    showExit: !options.stationManaged,
  };
}

export function resultSummary(result: ChessResult | null, humanColor: ChessColor, locale: SupportedLocale,
  options: ChessResultViewOptions = {}): string {
  const isPortuguese = locale === 'pt-BR';
  if (!result) return isPortuguese ? 'A posição final está no tabuleiro.' : 'The final position is on the board.';
  if (options.mode === 'pvp' && result.winner) {
    const winner = options.players?.find(player => player.color === result.winner)?.name
      ?? (result.winner === 'w' ? isPortuguese ? 'Brancas' : 'White'
        : isPortuguese ? 'Pretas' : 'Black');
    const loser = options.players?.find(player => player.color !== result.winner)?.name
      ?? (result.winner === 'w' ? isPortuguese ? 'Pretas' : 'Black'
        : isPortuguese ? 'Brancas' : 'White');
    if (result.reason === 'forfeit') return isPortuguese
      ? `${winner} venceu por desistência depois que ${loser} saiu da chamada.`
      : `${winner} wins by forfeit after ${loser} left the call.`;
    if (result.reason === 'checkmate') return isPortuguese
      ? `${winner} deu xeque-mate em ${loser}.` : `${winner} checkmated ${loser}.`;
    return isPortuguese ? `${winner} venceu ${loser}.` : `${winner} beat ${loser}.`;
  }
  if (result.winner === null) {
    if (result.reason === 'draw') return isPortuguese ? 'Empate.' : 'A draw.';
    const reason: Record<ChessResult['reason'], string> = isPortuguese
      ? { checkmate: 'Xeque-mate', forfeit: 'Desistência', stalemate: 'Afogamento', threefold_repetition: 'Repetição de posição',
          fifty_move: 'Regra dos cinquenta lances', insufficient_material: 'Material insuficiente', draw: 'Empate' }
      : { checkmate: 'Checkmate', forfeit: 'Forfeit', stalemate: 'Stalemate', threefold_repetition: 'Threefold repetition',
          fifty_move: 'Fifty-move rule', insufficient_material: 'Insufficient material', draw: 'Draw' };
    return isPortuguese ? `Empate por ${reason[result.reason].toLowerCase()}.`
      : `A draw by ${reason[result.reason].toLowerCase()}.`;
  }
  const humanWon = result.winner === humanColor;
  if (result.reason === 'forfeit') return isPortuguese
    ? humanWon ? 'Você venceu por desistência.' : 'O Arquimago venceu por desistência.'
    : humanWon ? 'You won by forfeit.' : 'The Archmage won by forfeit.';
  if (result.reason === 'checkmate') return isPortuguese
    ? humanWon ? 'Você deu xeque-mate no Arquimago.' : 'O Arquimago deu xeque-mate.'
    : humanWon ? 'You checkmated the Archmage.' : 'The Archmage delivered checkmate.';
  return isPortuguese
    ? humanWon ? 'Você venceu o duelo.' : 'O Arquimago venceu o duelo.'
    : humanWon ? 'You won the duel.' : 'The Archmage won the duel.';
}
