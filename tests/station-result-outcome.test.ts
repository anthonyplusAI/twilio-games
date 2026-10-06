import { describe, expect, it } from 'vitest';
import { describeStationParticipantOutcome } from '../client/arcade/result-outcome';

describe('operator station result wording', () => {
  it.each([
    [{ completed: true, won: true, rank: 1 }, 'victory'],
    [{ completed: true, won: false, rank: 2 }, 'defeat'],
    [{ completed: true, won: null, rank: 1 }, 'draw'],
    [{ completed: false, won: null, rank: null }, 'did not finish'],
  ] as const)('shows Chess result %j as %s', (participant, expected) => {
    expect(describeStationParticipantOutcome('chess', participant)).toBe(expected);
  });

  it('keeps ranked-game placements', () => {
    expect(describeStationParticipantOutcome('trivia', {
      completed: true, won: false, rank: 2,
    })).toBe('place 2');
  });
});
