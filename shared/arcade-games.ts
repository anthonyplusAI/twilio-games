import type { ArcadeGame, StationGame } from './arcade-config';
import { MAX_PLAYERS } from './constants';

export type PlayableArcadeGame = StationGame;

export type ArcadeGameDefinition = Readonly<{
  id: ArcadeGame;
  route: string | null;
  humanCapacity: number | null;
  minimumHumans: number | null;
  aiFallback: boolean;
  playable: boolean;
}>;

export const ARCADE_GAME_DEFINITIONS: Readonly<Record<ArcadeGame, ArcadeGameDefinition>> = Object.freeze({
  racer: Object.freeze({
    id: 'racer', route: '/play.html', humanCapacity: MAX_PLAYERS, minimumHumans: 1,
    aiFallback: true, playable: true,
  }),
  monsters: Object.freeze({
    id: 'monsters', route: '/monsters.html', humanCapacity: 2, minimumHumans: 1,
    aiFallback: true, playable: true,
  }),
  fighter: Object.freeze({
    id: 'fighter', route: '/fighter.html', humanCapacity: 2, minimumHumans: 1,
    aiFallback: true, playable: true,
  }),
  karaoke: Object.freeze({
    id: 'karaoke', route: '/karaoke.html', humanCapacity: 1, minimumHumans: 1,
    aiFallback: false, playable: true,
  }),
  trivia: Object.freeze({
    id: 'trivia', route: '/trivia.html', humanCapacity: 4, minimumHumans: 1,
    aiFallback: false, playable: true,
  }),
  chess: Object.freeze({
    id: 'chess', route: '/chess.html', humanCapacity: 2, minimumHumans: 1,
    aiFallback: true, playable: true,
  }),
});

export const PLAYABLE_ARCADE_GAMES = Object.freeze(
  Object.values(ARCADE_GAME_DEFINITIONS)
    .filter((game): game is ArcadeGameDefinition & { id: PlayableArcadeGame; route: string; humanCapacity: number; minimumHumans: number } => game.playable),
);

export function arcadeGameDefinition(game: ArcadeGame): ArcadeGameDefinition {
  return ARCADE_GAME_DEFINITIONS[game];
}

export function isArcadeGame(value: unknown): value is ArcadeGame {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(ARCADE_GAME_DEFINITIONS, value);
}

export function isPlayableArcadeGame(value: unknown): value is PlayableArcadeGame {
  return isArcadeGame(value)
    && ARCADE_GAME_DEFINITIONS[value as ArcadeGame].playable;
}
