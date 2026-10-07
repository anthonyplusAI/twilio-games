import { describe, expect, it } from 'vitest';
import { HttpServer, isRacerAdvanceWord } from '../server/http-server';
import type { GameServer } from '../server/game-server';
import type { Room } from '../server/room';
import type { LlmClient, LlmReply } from '../server/llm';

type RacerInterpreter = {
  llm: LlmClient;
  game: GameServer;
  roomConfigCache: { carCount: number; maps: string[]; carNames: string[] };
  resolveRacerVoiceTurn(room: Room, playerId: string, utterance: string, locale: 'en-US' | 'pt-BR',
    isCurrent: () => boolean, stationManaged: boolean, nameLocked: boolean, setupReady: boolean):
    Promise<{ text: string; phase: string } | null>;
};

function fixture(reply: () => Promise<LlmReply>) {
  const http = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false }) as unknown as RacerInterpreter;
  http.roomConfigCache = { carCount: 2, maps: ['Silver Lake'], carNames: ['Roadster', 'Coupe'] };
  http.llm = { enabled: true, respond: reply };
  const room = http.game.getOrCreateRoom('SEMANTIC');
  const joined = room.addPlayer('Ana', undefined, undefined, true) as { playerId: string };
  room.advance();
  expect(room.phase).toBe('car_select');
  return { http, room, playerId: joined.playerId };
}

describe('Racer current-screen semantic fallback', () => {
  it('does not advance a menu from negated or informational speech', () => {
    expect(isRacerAdvanceWord("don't start yet")).toBe(false);
    expect(isRacerAdvanceWord('when does the race start?')).toBe(false);
    expect(isRacerAdvanceWord('não vamos começar agora', 'pt-BR')).toBe(false);
    expect(isRacerAdvanceWord('go now')).toBe(true);
  });
  it('lets a Portuguese paraphrase select the car proposed by the model', async () => {
    const { http, room, playerId } = fixture(async () => ({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'action', actionId: 'select_car', targetId: '1' } },
    ] }));
    const result = await http.resolveRacerVoiceTurn(room, playerId,
      'eu queria o carro mais compacto, aquele segundo ali', 'pt-BR', () => true, false, false, true);
    expect(room.lobbyPlayers()[0]?.carIndex).toBe(1);
    expect(result?.text).toContain('Coupe');
  });

  it('discards a delayed proposal after the caller interrupts', async () => {
    let release!: (reply: LlmReply) => void;
    const { http, room, playerId } = fixture(() => new Promise(resolve => { release = resolve; }));
    let current = true;
    const pending = http.resolveRacerVoiceTurn(room, playerId,
      'pick the coupe', 'en-US', () => current, false, false, true);
    current = false;
    release({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'action', actionId: 'select_car', targetId: '1' } },
    ] });
    expect(await pending).toBeNull();
    expect(room.lobbyPlayers()[0]?.carIndex).toBeNull();
  });

  it('does not execute an action invented for another phase', async () => {
    const { http, room, playerId } = fixture(async () => ({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'action', actionId: 'MOVE_LEFT' } },
    ] }));
    expect(await http.resolveRacerVoiceTurn(room, playerId, 'turn left', 'en-US', () => true,
      false, false, true)).toBeNull();
    expect(room.lobbyPlayers()[0]?.carIndex).toBeNull();
  });
});
