import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  isWizardChessTrigger, parseWizardChessVoiceAction,
  WIZARD_CHESS_CHARACTERS, WIZARD_CHESS_DIALOGUE, WIZARD_CHESS_PRE_RON_FEN,
  WIZARD_CHESS_SEQUENCE, WIZARD_CHESS_VOICE_IDS,
} from '../shared/wizard-chess-scene';
import { wizardPositionAfterMoves } from '../client/chess/wizard-scene-state';

describe('wizard chess scene', () => {
  it('places the three characters on their documented pieces and plays a legal sacrifice', () => {
    const board = new Chess(WIZARD_CHESS_PRE_RON_FEN);
    for (const character of ['ron', 'harry', 'hermione'] as const) {
      const anchor = WIZARD_CHESS_CHARACTERS[character];
      expect(board.get(anchor.square)).toMatchObject({ type: anchor.piece, color: anchor.color });
      expect(WIZARD_CHESS_VOICE_IDS[character]).toMatch(/^[a-zA-Z0-9]{20}$/);
    }
    expect(WIZARD_CHESS_SEQUENCE.map(step => step.san)).toEqual(['Nh3+', 'Qxh3', 'Bc5+', 'Qe3', 'Bxe3#']);
    for (const step of WIZARD_CHESS_SEQUENCE) {
      const before = wizardPositionAfterMoves(WIZARD_CHESS_SEQUENCE.indexOf(step));
      expect(before.map(piece => `${piece.color}${piece.type}${piece.square}`).sort()).toEqual(
        board.board().flatMap(row => row.filter(piece => piece !== null)
          .map(piece => `${piece.color}${piece.type}${piece.square}`)).sort());
      const move = board.move({ from: step.from, to: step.to });
      expect(move).toMatchObject({ from: step.from, to: step.to, san: step.san,
        color: step.color, piece: step.piece });
      expect(board.isCheck()).toBe(step.check);
    }
    expect(wizardPositionAfterMoves(WIZARD_CHESS_SEQUENCE.length)
      .map(piece => `${piece.color}${piece.type}${piece.square}`).sort()).toEqual(
        board.board().flatMap(row => row.filter(piece => piece !== null)
          .map(piece => `${piece.color}${piece.type}${piece.square}`)).sort());
    expect(board.fen()).toBe('5r1k/1pN1R1pp/1Pb5/n3P3/7N/4b3/7P/1R4K1 w - - 0 5');
    expect(board.isCheck()).toBe(true);
    expect(board.isCheckmate()).toBe(true); // The full composed line, not H3 alone, is mate.
  });

  it('provides fixed bilingual original dialogue for all three voices', () => {
    expect(WIZARD_CHESS_DIALOGUE[0]?.text['en-US']).toMatch(/^Once I make my move,/);
    expect(new Set(WIZARD_CHESS_DIALOGUE.map(line => line.speaker))).toEqual(new Set(['ron', 'hermione', 'harry']));
    for (const line of WIZARD_CHESS_DIALOGUE) {
      expect(line.id).toBeTruthy();
      expect(line.text['en-US']).toBeTruthy();
      expect(line.text['pt-BR']).toBeTruthy();
    }
  });

  it('recognizes natural summons and the one spoken final move without mistaking questions for commands', () => {
    for (const speech of ['wizard chess', 'Wizard’s chess', 'Can we play Harry Potter?',
      'Show the Sorcerer’s Stone board', 'Let’s play Hogwarts chess']) {
      expect(isWizardChessTrigger(speech, 'en-US')).toBe(true);
    }
    expect(isWizardChessTrigger('What is wizard chess?', 'en-US')).toBe(false);
    expect(isWizardChessTrigger('Do not play Harry Potter chess', 'en-US')).toBe(false);
    expect(isWizardChessTrigger('xadrez de bruxo', 'pt-BR')).toBe(true);
    for (const speech of ['knight to H3', 'Ron to H three', 'move Ron’s knight from G5 to H3',
      'H3', 'Knight to H-three', 'G five to H three']) {
      expect(parseWizardChessVoiceAction(speech, 'en-US')).toBe('final');
    }
    expect(parseWizardChessVoiceAction('What happens if the knight goes to H3?', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Do not move Ron to H3', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Don’t exit; move Ron’s knight to H3', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Don’t skip; show me the move', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Don’t give me a hint; move Ron to H3', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Can I exit the scene?', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Move Ron’s knight from H3 back to G5', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Move the knight away from H3', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Move the knight H3 to G5', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('The queen takes Ron’s knight on H3', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Ron’s knight is going to H3, right?', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Help me move Ron’s knight to H3', 'en-US')).toBe('final');
    expect(parseWizardChessVoiceAction('Skip ahead and move Ron’s knight to H3', 'en-US')).toBe('final');
    expect(parseWizardChessVoiceAction('Move my queen to H3', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('The exit button is red', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('The skip button is visible', 'en-US')).toBe('unknown');
    expect(parseWizardChessVoiceAction('Can you skip to the move?', 'en-US')).toBe('skip');
    expect(parseWizardChessVoiceAction('skip to the move', 'en-US')).toBe('skip');
    expect(parseWizardChessVoiceAction('back to normal chess', 'en-US')).toBe('exit');
    expect(parseWizardChessVoiceAction('dica', 'pt-BR')).toBe('hint');
    expect(parseWizardChessVoiceAction('mova o cavalo do Ron para H três', 'pt-BR')).toBe('final');
  });
});
