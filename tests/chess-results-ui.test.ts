import { describe, expect, it } from 'vitest';
import { chessResultPresentation, resultSummary } from '../client/chess/chess-result-view';

describe('Voice Chess result presentation', () => {
  it('announces a checkmate victory and offers replay and exit on a standalone display', () => {
    const result = chessResultPresentation(
      { reason: 'checkmate', winner: 'w' }, 'w', 'en-US',
      { canReplayOnDisplay: true, stationManaged: false },
    );
    expect(result.outcome).toBe('win');
    expect(result.title).toBe('Victory');
    expect(result.detail).toBe('You checkmated the Archmage.');
    expect(result.showReplay).toBe(true);
    expect(result.showExit).toBe(true);
  });

  it('keeps a station loss and next-round guidance without controls that navigate or restart its display', () => {
    const result = chessResultPresentation(
      { reason: 'checkmate', winner: 'b' }, 'w', 'en-US',
      { canReplayOnDisplay: true, stationManaged: true },
    );
    expect(result.outcome).toBe('loss');
    expect(result.title).toBe('Defeat');
    expect(result.detail).toBe('The Archmage delivered checkmate.');
    expect(result.showReplay).toBe(false);
    expect(result.showExit).toBe(false);
    expect(result.stationNextRound).toMatch(/rejoin/i);
  });

  it('explains draw reasons and localizes Portuguese result controls', () => {
    const draw = chessResultPresentation(
      { reason: 'threefold_repetition', winner: null }, 'w', 'pt-BR',
      { canReplayOnDisplay: true, stationManaged: false },
    );
    expect(draw.outcome).toBe('draw');
    expect(draw.title).toBe('Empate');
    expect(draw.detail).toBe('Empate por repetição de posição.');
    expect(draw.replayLabel).toBe('Jogar de novo');
    expect(draw.exitLabel).toBe('Voltar aos jogos');
    expect(resultSummary(null, 'w', 'en-US')).toBe('The final position is on the board.');
  });
});
