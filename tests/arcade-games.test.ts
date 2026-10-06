import { describe, expect, it } from 'vitest';
import {
  ARCADE_GAME_DEFINITIONS,
  PLAYABLE_ARCADE_GAMES,
  arcadeGameDefinition,
  isPlayableArcadeGame,
} from '../shared/arcade-games';

describe('Arcade game registry', () => {
  it('defines the approved playable capacities from one source', () => {
    expect(PLAYABLE_ARCADE_GAMES.map(game => [game.id, game.humanCapacity])).toEqual([
      ['racer', 2], ['monsters', 2], ['fighter', 2], ['karaoke', 1], ['trivia', 4], ['chess', 1],
    ]);
    expect(arcadeGameDefinition('racer').route).toBe('/play.html');
    expect(arcadeGameDefinition('karaoke')).toMatchObject({
      route: '/karaoke.html', humanCapacity: 1, minimumHumans: 1, aiFallback: false, playable: true,
    });
  });

  it('promotes Trivia as a routed station game without an AI fallback', () => {
    expect(ARCADE_GAME_DEFINITIONS.trivia).toMatchObject({
      playable: true, route: '/trivia.html', humanCapacity: 4, minimumHumans: 1, aiFallback: false,
    });
    expect(isPlayableArcadeGame('trivia')).toBe(true);
    expect(isPlayableArcadeGame('racer')).toBe(true);
    expect(isPlayableArcadeGame('karaoke')).toBe(true);
    expect(isPlayableArcadeGame('__proto__')).toBe(false);
  });

  it('routes one human to Voice Chess against a computer opponent', () => {
    expect(arcadeGameDefinition('chess')).toMatchObject({
      route: '/chess.html', humanCapacity: 1, minimumHumans: 1, aiFallback: true, playable: true,
    });
    expect(isPlayableArcadeGame('chess')).toBe(true);
  });
});
