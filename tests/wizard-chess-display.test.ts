import { describe, expect, it } from 'vitest';
import { WIZARD_CHESS_CHARACTERS, WIZARD_CHESS_SEQUENCE } from '../shared/wizard-chess-scene';
import { wizardAssetForPiece, wizardCharacterAt } from '../client/chess/wizard-pieces';
import { wizardMoveAt, wizardPositionAfterMoves } from '../client/chess/wizard-scene-state';

describe('Wizard Chess display reconstruction', () => {
  it('shows the documented pre-sacrifice position and keeps the three children attached to their chess roles', () => {
    const pieces = wizardPositionAfterMoves(0);
    for (const [name, anchor] of Object.entries(WIZARD_CHESS_CHARACTERS)) {
      expect(pieces).toContainEqual({ square: anchor.square, color: anchor.color, type: anchor.piece });
      expect(wizardCharacterAt(anchor.square, anchor.color, anchor.piece)).toBe(name);
      expect(wizardAssetForPiece(anchor.square, anchor.color, anchor.piece)).toBe(name);
    }
    expect(wizardAssetForPiece('c3', 'w', 'q')).toBe('queen');
    expect(wizardAssetForPiece('c6', 'w', 'b')).toBe('b');
  });

  it('reconstructs the sacrifice and Harry’s composed checkmate as legal scene moves', () => {
    expect(WIZARD_CHESS_SEQUENCE.map(step => `${step.from}${step.to}`)).toEqual(['g5h3', 'c3h3', 'a3c5', 'h3e3', 'c5e3']);
    const knight = wizardMoveAt(0);
    expect(knight.move).toMatchObject({ color: 'b', piece: 'n', from: 'g5', to: 'h3', check: true });
    expect(knight.next).toContainEqual({ square: 'h3', color: 'b', type: 'n' });
    expect(wizardCharacterAt('h3', 'b', 'n')).toBe('ron');

    const queen = wizardMoveAt(1);
    expect(queen.move).toMatchObject({ color: 'w', piece: 'q', from: 'c3', to: 'h3', captured: 'n' });
    expect(queen.next).toContainEqual({ square: 'h3', color: 'w', type: 'q' });
    expect(queen.next).not.toContainEqual({ square: 'h3', color: 'b', type: 'n' });

    const bishop = wizardMoveAt(2);
    expect(bishop.move).toMatchObject({ color: 'b', piece: 'b', from: 'a3', to: 'c5', check: true, checkmate: false });
    expect(wizardPositionAfterMoves(3)).toContainEqual({ square: 'c5', color: 'b', type: 'b' });
    expect(wizardCharacterAt('c5', 'b', 'b')).toBe('harry');
    const mate = wizardMoveAt(4);
    expect(mate.move).toMatchObject({ color: 'b', piece: 'b', from: 'c5', to: 'e3',
      captured: 'q', check: true, checkmate: true });
    expect(wizardCharacterAt('e3', 'b', 'b')).toBe('harry');
    expect(mate.next).toContainEqual({ square: 'e3', color: 'b', type: 'b' });
  });
});
