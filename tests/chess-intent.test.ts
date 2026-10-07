import { describe, expect, it } from 'vitest';
import { describeChessMove, parseChessIntent } from '../shared/chess-intent';

describe('Voice Chess intent', () => {
  it('accepts natural confirmation replies without treating reservations as approval', () => {
    for (const speech of ['yes please', 'sure', 'okay', 'go ahead', 'sounds right', 'that is the move', 'sim pode jogar', 'claro']) {
      expect(parseChessIntent(speech)).toEqual({ kind: 'confirm' });
    }
    for (const speech of ['yes but wait', 'sure, what happens next?', 'okay do not move', 'is that right?']) {
      expect(parseChessIntent(speech)).not.toEqual({ kind: 'confirm' });
    }
  });

  it('understands direct requests for a move suggestion in both languages', () => {
    for (const speech of ['hint', 'hint please', 'please a hint', 'can I get a hint?', 'could we have a hint?',
      'give me a hint', 'give me a hint please', 'can you suggest a move?',
      'could you give me a hint?', 'Could you recommend a good move?', 'Which move would you recommend?',
      'what should I play?', "What's a good move?", 'What is a good move here?',
      'what do you suggest?', 'any tips?', 'help me choose a move', 'Please help me choose a move']) {
      expect(parseChessIntent(speech, 'en-US')).toEqual({ kind: 'hint' });
    }
    for (const speech of ['dica', 'dica por favor', 'alguma dica?', 'me dê uma dica', 'me dá uma dica',
      'posso pedir uma dica?', 'qual jogada devo fazer?', 'o que você sugere?']) {
      expect(parseChessIntent(speech, 'pt-BR')).toEqual({ kind: 'hint' });
    }
    expect(parseChessIntent('How many hints do I have left?')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('Can I get a hint count?')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('Could you explain what a good move is?')).toEqual({ kind: 'unknown' });
  });

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

  it('keeps spoken source files separate from rank-two homophones', () => {
    for (const speech of [
      'move the knight on B to C3',
      'knight from the B file to C3',
      'knight from column B to C3',
      'B-file knight to C3',
      'knight B to C3',
      'knight from bee to see three',
    ]) {
      expect(parseChessIntent(speech, 'en-US')).toEqual({
        kind: 'move', query: { piece: 'n', fromFile: 'b', to: 'c3' },
      });
    }
    expect(parseChessIntent('cavalo da coluna B para C3', 'pt-BR')).toEqual({
      kind: 'move', query: { piece: 'n', fromFile: 'b', to: 'c3' },
    });
    expect(parseChessIntent('cavalo na coluna B para C3', 'pt-BR')).toEqual({
      kind: 'move', query: { piece: 'n', fromFile: 'b', to: 'c3' },
    });
  });

  it('keeps a file-only piece reference as a source selection across a pause', () => {
    expect(parseChessIntent('move the knight on B')).toEqual({ kind: 'select', piece: 'n', fromFile: 'b' });
    expect(parseChessIntent('B-file knight')).toEqual({ kind: 'select', piece: 'n', fromFile: 'b' });
    expect(parseChessIntent('cavalo da coluna B', 'pt-BR')).toEqual({ kind: 'select', piece: 'n', fromFile: 'b' });
    expect(parseChessIntent('select the B-file knight to C3')).toEqual({
      kind: 'move', query: { piece: 'n', fromFile: 'b', to: 'c3' },
    });
    expect(parseChessIntent('to C3')).toMatchObject({ kind: 'move', query: { to: 'c3' } });
    expect(parseChessIntent('the B-file knight is pinned')).toEqual({ kind: 'unknown' });
  });

  it('preserves explicitly spoken rank two even when Relay says to', () => {
    expect(parseChessIntent('knight from B two to C4')).toMatchObject({
      kind: 'move', query: { piece: 'n', from: 'b2', to: 'c4' },
    });
    expect(parseChessIntent('knight on B too C3')).toMatchObject({
      kind: 'move', query: { piece: 'n', from: 'b2', to: 'c3' },
    });
    expect(parseChessIntent('knight B two to C3')).toMatchObject({
      kind: 'move', query: { piece: 'n', from: 'b2', to: 'c3' },
    });
    expect(parseChessIntent('pawn from ee to to ee for')).toMatchObject({
      kind: 'move', query: { piece: 'p', from: 'e2', to: 'e4' },
    });
  });

  it('routes non-command square mentions to conversational interpretation', () => {
    expect(parseChessIntent('I heard C3 on the board')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('Move my bishup to C3')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('Move my bishup from B2 to C3')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('C3')).toMatchObject({ kind: 'move', query: { to: 'c3' } });
    expect(parseChessIntent('E2 to E4')).toMatchObject({ kind: 'move', query: { from: 'e2', to: 'e4' } });
  });

  it('keeps polite actionable requests on the direct path while leaving questions read-only', () => {
    expect(parseChessIntent('Could you move my bishop to C3?')).toEqual({
      kind: 'move', query: { piece: 'b', to: 'c3' },
    });
    expect(parseChessIntent('Would you move the knight on B to C3?')).toEqual({
      kind: 'move', query: { piece: 'n', fromFile: 'b', to: 'c3' },
    });
    expect(parseChessIntent('Could you tell me if my bishop can move to C3?')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('Can my bishop move to C3?')).toEqual({ kind: 'unknown' });
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
    expect(parseChessIntent('my knight please', 'en-US')).toEqual({ kind: 'select', piece: 'n' });
    expect(parseChessIntent('move the queen', 'en-US')).toEqual({ kind: 'select', piece: 'q' });
    expect(parseChessIntent('select E2', 'en-US')).toEqual({ kind: 'select', from: 'e2' });
    expect(parseChessIntent('from E2', 'en-US')).toEqual({ kind: 'select', from: 'e2' });
    expect(parseChessIntent('E4', 'en-US')).toMatchObject({ kind: 'move', query: { to: 'e4' } });
  });

  it('routes comments about pieces and castling to conversational interpretation', () => {
    expect(parseChessIntent('My queen is trapped', 'en-US')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('The knight is my favorite piece', 'en-US')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('Castling is a defensive move', 'en-US')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('Meu cavalo está preso', 'pt-BR')).toEqual({ kind: 'unknown' });
  });

  it('treats a source square without a destination as a lasting selection', () => {
    expect(parseChessIntent('my pawn on E2', 'en-US')).toEqual({ kind: 'select', from: 'e2', piece: 'p' });
    expect(parseChessIntent('move the rook from A1', 'en-US')).toEqual({ kind: 'select', from: 'a1', piece: 'r' });
    expect(parseChessIntent('meu peão na casa E2', 'pt-BR')).toEqual({ kind: 'select', from: 'e2', piece: 'p' });
    expect(parseChessIntent('move my pawn to E4', 'en-US')).toMatchObject({
      kind: 'move', query: { piece: 'p', to: 'e4' },
    });
  });

  it('keeps a spoken castle piece distinct from the castling command', () => {
    expect(parseChessIntent('castle', 'en-US')).toEqual({ kind: 'move', query: { castle: null } });
    expect(parseChessIntent('castle piece from A1 to A3', 'en-US')).toMatchObject({
      kind: 'move', query: { piece: 'r', from: 'a1', to: 'a3' },
    });
    expect(parseChessIntent('the castle piece on A1', 'en-US')).toEqual({ kind: 'select', from: 'a1', piece: 'r' });
  });

  it('recovers common spoken-square transcription variants without guessing the piece', () => {
    expect(parseChessIntent('night to eff three')).toMatchObject({
      kind: 'move', query: { piece: 'n', to: 'f3' },
    });
    expect(parseChessIntent('pawn from ee too to ee for')).toMatchObject({
      kind: 'move', query: { piece: 'p', from: 'e2', to: 'e4' },
    });
    expect(parseChessIntent('cavalo para ge tres', 'pt-BR')).toMatchObject({
      kind: 'move', query: { piece: 'n', to: 'g3' },
    });
  });

  it('keeps only the corrected destination in a spoken move', () => {
    expect(parseChessIntent('knight to F3, no, H3')).toMatchObject({
      kind: 'move', query: { piece: 'n', to: 'h3' },
    });
    expect(parseChessIntent('cavalo de G1 para F3, não, H3', 'pt-BR')).toMatchObject({
      kind: 'move', query: { piece: 'n', from: 'g1', to: 'h3' },
    });
    expect(parseChessIntent("I didn't mean queen to H5; I mean bishop to C4")).toMatchObject({
      kind: 'move', query: { piece: 'b', to: 'c4' },
    });
    expect(parseChessIntent('cavalo para F3, quer dizer H3', 'pt-BR')).toMatchObject({
      kind: 'move', query: { piece: 'n', to: 'h3' },
    });
    expect(parseChessIntent('knight to F3, actually bishop to C4')).toMatchObject({
      kind: 'move', query: { piece: 'b', to: 'c4' },
    });
    expect(parseChessIntent('knight on B to F3, no, C3')).toEqual({
      kind: 'move', query: { piece: 'n', fromFile: 'b', to: 'c3' },
    });
  });

  it('does not turn negated or hypothetical move talk into a proposal', () => {
    expect(parseChessIntent("don't move the knight to F3")).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('not knight to F3, bishop to C4')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('What if I moved my queen to H5?')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('não faça roque', 'pt-BR')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('Tell me how castling works')).toEqual({ kind: 'unknown' });
    expect(parseChessIntent('I wonder if I can castle kingside')).toEqual({ kind: 'unknown' });
  });

  it('accepts natural confirmation and cancellation responses', () => {
    expect(parseChessIntent('yes, go ahead and make that move')).toEqual({ kind: 'confirm' });
    expect(parseChessIntent('actually cancel that')).toEqual({ kind: 'cancel' });
    expect(parseChessIntent('sim, confirma essa jogada', 'pt-BR')).toEqual({ kind: 'confirm' });
    expect(parseChessIntent('confirm, no, cancel')).toEqual({ kind: 'cancel' });
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
