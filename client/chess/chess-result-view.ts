import type { SupportedLocale } from '../../shared/i18n/locales';
import type { ChessColor, ChessResult } from '../../shared/chess-protocol';

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
  options: { canReplayOnDisplay: boolean; stationManaged: boolean },
): ChessResultPresentation {
  const isPortuguese = locale === 'pt-BR';
  const outcome = result.winner === null ? 'draw' : result.winner === humanColor ? 'win' : 'loss';
  return {
    outcome,
    kicker: isPortuguese ? 'Duelo encerrado' : 'Duel complete',
    title: outcome === 'draw' ? isPortuguese ? 'Empate' : 'Draw'
      : outcome === 'win' ? isPortuguese ? 'Vitória' : 'Victory'
        : isPortuguese ? 'Derrota' : 'Defeat',
    detail: resultSummary(result, humanColor, locale),
    replayLabel: isPortuguese ? 'Jogar de novo' : 'Play again',
    exitLabel: isPortuguese ? 'Voltar aos jogos' : 'Exit to games',
    stationNextRound: isPortuguese
      ? 'Quer jogar de novo? Entre novamente na fila da estação pelo telefone.'
      : 'Want another turn? Rejoin the station queue on your phone.',
    showReplay: !options.stationManaged && options.canReplayOnDisplay,
    showExit: !options.stationManaged,
  };
}

export function resultSummary(result: ChessResult | null, humanColor: ChessColor, locale: SupportedLocale): string {
  const isPortuguese = locale === 'pt-BR';
  if (!result) return isPortuguese ? 'A posição final está no tabuleiro.' : 'The final position is on the board.';
  if (result.winner === null) {
    if (result.reason === 'draw') return isPortuguese ? 'Empate.' : 'A draw.';
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
