import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { HttpServer } from '../server/http-server';
import type { GameServer } from '../server/game-server';
import type { BattleServer } from '../server/battle-server';

type RouteInternals = {
  standaloneDisplays: Map<'racer' | 'battle', Map<WebSocket, number>>;
  game: GameServer;
  battle: BattleServer;
  recentVoiceGame(): string | null;
  pickVoiceGame(frame: string): string | null;
};

function candidate(): WebSocket {
  return { readyState: WebSocket.OPEN } as WebSocket;
}

describe('standalone voice routing', () => {
  it('counts only accepted displays bound to the default room, and refuses two real screens', () => {
    const http = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false }) as unknown as RouteInternals;
    const racer = candidate();
    const battle = candidate();
    http.standaloneDisplays.set('racer', new Map([[racer, 100]]));
    http.standaloneDisplays.set('battle', new Map([[battle, 200]]));
    let battleBound = false;
    vi.spyOn(http.game, 'hasStandaloneDisplay').mockImplementation((ws, code) => ws === racer && code === '4821');
    vi.spyOn(http.battle, 'hasStandaloneDisplay').mockImplementation((ws, code) => ws === battle && battleBound && code === '4821');
    const setup = JSON.stringify({ type: 'setup', customParameters: { roomCode: '4821' } });

    // An upgraded but unbound Battle socket cannot steal or block the Racer call.
    expect(http.recentVoiceGame()).toBe('racer');
    expect(http.pickVoiceGame(setup)).toBe('racer');
    battleBound = true;
    expect(http.recentVoiceGame()).toBeNull();
    expect(http.pickVoiceGame(setup)).toBeNull();
    expect(http.pickVoiceGame(JSON.stringify({ type: 'setup', customParameters: { game: 'battle' } }))).toBe('battle');
    battleBound = false;
    expect(http.recentVoiceGame()).toBe('racer');
  });
});
