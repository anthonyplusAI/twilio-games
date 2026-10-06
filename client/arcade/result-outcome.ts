import type { PlayableArcadeGame } from '../../shared/arcade-games';

interface ParticipantOutcome {
  readonly completed: boolean;
  readonly won: boolean | null;
  readonly rank: number | null;
}

/** Operator result wording for ranked games and Chess's one-caller duel. */
export function describeStationParticipantOutcome(
  game: PlayableArcadeGame,
  participant: ParticipantOutcome,
): string {
  if (game === 'chess') {
    if (!participant.completed) return 'did not finish';
    if (participant.won === true) return 'victory';
    if (participant.won === false) return 'defeat';
    return 'draw';
  }
  return participant.won ? 'winner'
    : participant.rank ? `place ${participant.rank}`
      : participant.completed ? 'completed' : 'did not finish';
}
