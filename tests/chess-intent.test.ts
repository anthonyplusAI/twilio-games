import { describe, expect, it } from 'vitest';
import { describeChessMove, parseChessIntent } from '../shared/chess-intent';

describe('Voice Chess intent', () => {
  it('extracts a named piece and destination from English speech', () => {
    expect(parseChessIntent('Knight to E six', 'en-US')).toMatchObject({
      kind: 'move', query: { piece: 'n', to: 'e6' },
    });
  });

  it('extracts source and destination for disambiguation', () => {
    expect(parseChessIntent('Knight from F4 to E6', 'en-US')).toMatchObject({
      kind: 'move', query: { piece: 'n', from: 'f4', to: 'e6' },
    });
    expect(parseChessIntent('E2 to E4', 'en-US')).toMatchObject({
      kind: 'move', query: { from: 'e2', to: 'e4' },
    });
  });

  it('parses captures, promotion, and both forms of castling', () => {
    expect(parseChessIntent('Bishop captures on C6', 'en-US')).toMatchObject({
      kind: 'move', query: { piece: 'b', to: 'c6', captureOnly: true },
    });
    expect(parseChessIntent('Bishop captures knight on C6', 'en-US')).toMatchObject({
      kind: 'move', query: { piece: 'b', to: 'c6', captureOnly: true },
    });
    expect(parseChessIntent('Pawn from A7 to A8 promote to rook', 'en-US')).toMatchObject({
      kind: 'move', query: { piece: 'p', from: 'a7', to: 'a8', promotion: 'r' },
    });
    expect(parseChessIntent('castle kingside', 'en-US')).toMatchObject({
      kind: 'move', query: { castle: 'king' },
    });
    expect(parseChessIntent('roque grande', 'pt-BR')).toMatchObject({
      kind: 'move', query: { castle: 'queen' },
    });
  });

  it('understands Brazilian Portuguese piece and command words', () => {
    expect(parseChessIntent('cavalo de F4 para E seis', 'pt-BR')).toMatchObject({
      kind: 'move', query: { piece: 'n', from: 'f4', to: 'e6' },
    });
    expect(parseChessIntent('peão captura em D6', 'pt-BR')).toMatchObject({
      kind: 'move', query: { piece: 'p', to: 'd6', captureOnly: true },
    });
    expect(parseChessIntent('confirmar', 'pt-BR')).toEqual({ kind: 'confirm' });
    expect(parseChessIntent('cancelar', 'pt-BR')).toEqual({ kind: 'cancel' });
    expect(parseChessIntent('jogar de novo', 'pt-BR')).toEqual({ kind: 'reset' });
  });

  it('supports two-step spoken piece selection', () => {
    expect(parseChessIntent('select the knight', 'en-US')).toEqual({ kind: 'select', piece: 'n' });
    expect(parseChessIntent('select E2', 'en-US')).toEqual({ kind: 'select', from: 'e2' });
    expect(parseChessIntent('E4', 'en-US')).toMatchObject({ kind: 'move', query: { to: 'e4' } });
  });

  it('describes a lost piece and check in the caller language', () => {
    const move = {
      actor: 'computer' as const, color: 'b' as const, piece: 'r' as const,
      from: 'a8' as const, to: 'a1' as const, captured: 'b' as const,
      capturedSquare: 'a1' as const, promotion: null, castle: null,
      rookFrom: null, rookTo: null, enPassant: false, check: true, checkmate: false,
      san: 'Rxa1+', fen: '', ply: 1, revision: 1,
    };
    expect(describeChessMove(move, 'en-US')).toMatch(/your bishop/i);
    expect(describeChessMove(move, 'en-US')).toMatch(/check/i);
    expect(describeChessMove(move, 'pt-BR')).toMatch(/bispo/i);
  });
});
