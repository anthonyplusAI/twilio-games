import { describe, expect, it } from 'vitest';
import { HttpServer, isRacerAdvanceWord } from '../server/http-server';
import type { HostContext } from '../server/game-host';
import type { GameServer } from '../server/game-server';
import type { Room } from '../server/room';
import type { LlmClient, LlmReply } from '../server/llm';

type RacerInterpreter = {
  llm: LlmClient;
  game: GameServer;
  roomConfigCache: { carCount: number; maps: string[]; carNames: string[] };
  resolveRacerVoiceTurn(room: Room, playerId: string, utterance: string, locale: 'en-US' | 'pt-BR',
    isCurrent: () => boolean, stationManaged: boolean, nameLocked: boolean, setupReady: boolean,
    readOnlyInquiry?: boolean):
    Promise<{ text: string; phase: string } | null>;
};

function fixture(reply: LlmClient['respond']) {
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
  it.each([
    { locale: 'en-US' as const, placement: /You placed 2nd.*leaderboard/i,
      nextStep: /For another race, check your messages for game coin instructions\./i,
      standalone: /Want another race\?/i },
    { locale: 'pt-BR' as const, placement: /Você ficou em 2º.*classificação/i,
      nextStep: /Para correr novamente, veja nas mensagens as instruções sobre moedas\./i,
      standalone: /Quer correr de novo\?/i },
  ])('gives $locale station racers a coin-based replay step after their result', row => {
    const http = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false }) as unknown as {
      racerResultsRecap(context: HostContext, locale: 'en-US' | 'pt-BR'): string;
    };
    const resultContext = {
      myPlace: 2, myFinishTime: 42.1, myCurrentTrackRank: 5,
      currentTrackRankedRunCount: 12, allTimeBest: null, stationManaged: true,
    } as HostContext;
    const station = http.racerResultsRecap(resultContext, row.locale);
    expect(station).toMatch(row.placement);
    expect(station).toMatch(row.nextStep);
    expect(station).not.toMatch(row.standalone);

    const standalone = http.racerResultsRecap({ ...resultContext, stationManaged: false }, row.locale);
    expect(standalone).toMatch(row.standalone);
    expect(standalone).not.toMatch(row.nextStep);
  });

  it('does not advance a menu from negated or informational speech', () => {
    expect(isRacerAdvanceWord("don't start yet")).toBe(false);
    expect(isRacerAdvanceWord('when does the race start?')).toBe(false);
    expect(isRacerAdvanceWord('who won the race')).toBe(false);
    expect(isRacerAdvanceWord('can i race again')).toBe(false);
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

  it('answers live position, lap, leader, and nitro questions from the current race', async () => {
    const factIds: string[][] = [];
    const { http, room, playerId } = fixture(async (_system, messages) => {
      const request = JSON.parse(messages[0]!.content) as { facts: { id: string }[] };
      factIds.push(request.facts.map(fact => fact.id));
      return { say: '', toolCalls: [
        { name: 'resolve_voice_turn', args: { kind: 'answer', factId: 'position' } },
      ] };
    });
    expect(room.selectCar(playerId, 0)).toBe(true);
    expect(room.advance(playerId)).toBe(true);
    expect(room.selectMap(room.mapChoices[0]!, playerId)).toBe(true);
    expect(room.advance(playerId)).toBe(true);
    room.tick(6.3);
    expect(room.phase).toBe('racing');
    const result = await http.resolveRacerVoiceTurn(room, playerId,
      'Where am I in the race', 'en-US', () => true, false, false, true);
    expect(factIds[0]).toEqual(expect.arrayContaining(['position', 'leader', 'lap', 'nitro']));
    expect(result?.text).toMatch(/1st of 1/i);
  });

  it('never acts on an informational racing turn even if the model proposes a control', async () => {
    const { http, room, playerId } = fixture(async () => ({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'action', actionId: 'BOOST' } },
    ] }));
    expect(room.selectCar(playerId, 0)).toBe(true);
    expect(room.advance(playerId)).toBe(true);
    expect(room.selectMap(room.mapChoices[0]!, playerId)).toBe(true);
    expect(room.advance(playerId)).toBe(true);
    room.tick(6.3);
    const before = room.snapshot()!.cars[0]!.boost;
    const result = await http.resolveRacerVoiceTurn(room, playerId,
      'Can you tell me what boost does', 'en-US', () => true, false, false, true, true);
    expect(room.snapshot()!.cars[0]!.boost).toBe(before);
    expect(result?.text).toMatch(/boost/i);
  });
});
