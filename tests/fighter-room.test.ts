import { describe, expect, it } from 'vitest';
import { FIGHTER_LOADING_TIMEOUT_SECONDS, FIGHTER_VICTORY_SECONDS, FIGHTER_VOICE_COMMAND_TTL_SECONDS, MAX_VOICE_COMMAND_QUEUE, FighterRoom } from '../server/fighter-room';
import { FIGHTER_INTRO_SECONDS } from '../shared/fighter-protocol';

function readyFightRoom(now: () => number = Date.now): FighterRoom {
  const room = new FighterRoom('VOICE', 1, undefined, now);
  const first = room.addPlayer('Ada') as { playerId: string };
  const second = room.addPlayer('Bo') as { playerId: string };
  room.advance();
  room.selectFighter(first.playerId, 'nyx'); room.selectFighter(second.playerId, 'wraith');
  room.advance(); room.selectMap(first.playerId, 'void'); room.advance();
  room.ready(room.state().loadingGeneration);
  room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
  return room;
}

describe('fighter room', () => {
  it('holds shared menu votes through both callers’ current phone audio, then advances automatically', () => {
    const room = new FighterRoom('SPOKEN-MENU', 5);
    room.configureStandaloneSeats(2);
    const ada = room.addPlayer('Ada'), bo = room.addPlayer('Bo');
    if ('error' in ada || 'error' in bo) throw new Error('join failed');
    room.registerVoicePlayer(ada.playerId);
    room.registerVoicePlayer(bo.playerId);
    const finishAdaLobby = room.beginMenuAudio(ada.playerId, 'lobby');
    const finishBoLobby = room.beginMenuAudio(bo.playerId, 'lobby');

    room.advance(ada.playerId);
    room.advance(bo.playerId);
    expect(room.phase).toBe('lobby');
    finishAdaLobby();
    expect(room.completeSharedDecisionIfReady()).toBe(false);
    expect(room.phase).toBe('lobby');
    finishBoLobby();
    expect(room.completeSharedDecisionIfReady()).toBe(true);
    expect(room.phase).toBe('fighter_select');

    room.selectFighter(ada.playerId, 'nyx');
    room.selectFighter(bo.playerId, 'wraith');
    const finishAdaFighter = room.beginMenuAudio(ada.playerId, 'fighter_select');
    const finishBoFighter = room.beginMenuAudio(bo.playerId, 'fighter_select');
    room.advance(ada.playerId);
    room.advance(bo.playerId);
    expect(room.phase).toBe('fighter_select');
    finishAdaFighter();
    expect(room.completeSharedDecisionIfReady()).toBe(false);
    finishBoFighter();
    expect(room.completeSharedDecisionIfReady()).toBe(true);
    expect(room.phase).toBe('map_select');

    room.selectMap(ada.playerId, 'void');
    room.selectMap(bo.playerId, 'void');
    const finishAdaMap = room.beginMenuAudio(ada.playerId, 'map_select');
    const finishBoMap = room.beginMenuAudio(bo.playerId, 'map_select');
    room.advance(ada.playerId);
    room.advance(bo.playerId);
    expect(room.phase).toBe('map_select');
    finishAdaMap();
    expect(room.completeSharedDecisionIfReady()).toBe(false);
    finishBoMap();
    expect(room.completeSharedDecisionIfReady()).toBe(true);
    expect(room.phase).toBe('loading');

    room.ready(room.state().loadingGeneration); room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    const world = room.state().world!; world.status = 'finished'; world.winner = 'p1';
    room.tick(.1); room.tick(FIGHTER_VICTORY_SECONDS);
    room.acknowledgePresentation('results', room.state().loadingGeneration);
    const finishAdaResult = room.beginMenuAudio(ada.playerId, 'results');
    const finishBoResult = room.beginMenuAudio(bo.playerId, 'results');
    room.advance(ada.playerId);
    room.advance(bo.playerId);
    expect(room.phase).toBe('results');
    finishAdaResult();
    expect(room.completeSharedDecisionIfReady()).toBe(false);
    finishBoResult();
    expect(room.completeSharedDecisionIfReady()).toBe(true);
    expect(room.phase).toBe('fighter_select');
  });

  it('keeps shared votes pending after failed audio until that caller hears a fresh menu cue', () => {
    const room = new FighterRoom('RETRY-CUE', 5);
    room.configureStandaloneSeats(2);
    const ada = room.addPlayer('Ada'), bo = room.addPlayer('Bo');
    if ('error' in ada || 'error' in bo) throw new Error('join failed');
    room.registerVoicePlayer(ada.playerId);
    room.registerVoicePlayer(bo.playerId);
    const failedAdaCue = room.beginMenuAudio(ada.playerId, 'lobby');
    const boCue = room.beginMenuAudio(bo.playerId, 'lobby');
    room.advance(ada.playerId);
    room.advance(bo.playerId);
    failedAdaCue(false);
    boCue(true);
    expect(room.completeSharedDecisionIfReady()).toBe(false);
    expect(room.state()).toMatchObject({ phase: 'lobby',
      phoneRetryPlayerIds: [ada.playerId], advanceReadyPlayerIds: [ada.playerId, bo.playerId] });

    room.beginMenuAudio(ada.playerId, 'lobby')();
    expect(room.completeSharedDecisionIfReady()).toBe(false);
    const retry = room.beginMenuAudio(ada.playerId, 'lobby', true);
    retry(true);
    expect(room.completeSharedDecisionIfReady()).toBe(true);
    expect(room.phase).toBe('fighter_select');
  });

  it.each(['stale first', 'replacement first'] as const)(
    'accepts a newer overlapping menu cue after an obsolete cue is skipped (%s)', order => {
      const room = new FighterRoom('REPLACED-CUE', 5);
      room.configureStandaloneSeats(2);
      const ada = room.addPlayer('Ada'), bo = room.addPlayer('Bo');
      if ('error' in ada || 'error' in bo) throw new Error('join failed');
      room.registerVoicePlayer(ada.playerId);
      room.registerVoicePlayer(bo.playerId);
      const stale = room.beginMenuAudio(ada.playerId, 'lobby');
      const replacement = room.beginMenuAudio(ada.playerId, 'lobby');
      const finishBo = room.beginMenuAudio(bo.playerId, 'lobby');
      room.advance(ada.playerId);
      room.advance(bo.playerId);
      finishBo(true);

      if (order === 'stale first') {
        stale(false);
        expect(room.completeSharedDecisionIfReady()).toBe(false);
        replacement(true);
      } else {
        replacement(true);
        expect(room.completeSharedDecisionIfReady()).toBe(false);
        stale(false);
      }

      expect(room.state().phoneRetryPlayerIds).toEqual([]);
      expect(room.completeSharedDecisionIfReady()).toBe(true);
      expect(room.phase).toBe('fighter_select');
    },
  );

  it('keeps shared votes pending if the newest overlapping menu cue itself fails', () => {
    const room = new FighterRoom('LATEST-CUE-FAILED', 5);
    room.configureStandaloneSeats(2);
    const ada = room.addPlayer('Ada'), bo = room.addPlayer('Bo');
    if ('error' in ada || 'error' in bo) throw new Error('join failed');
    room.registerVoicePlayer(ada.playerId);
    room.registerVoicePlayer(bo.playerId);
    const older = room.beginMenuAudio(ada.playerId, 'lobby');
    const latest = room.beginMenuAudio(ada.playerId, 'lobby');
    room.beginMenuAudio(bo.playerId, 'lobby')(true);
    room.advance(ada.playerId);
    room.advance(bo.playerId);
    older(true);
    latest(false);

    expect(room.completeSharedDecisionIfReady()).toBe(false);
    expect(room.state().phoneRetryPlayerIds).toEqual([ada.playerId]);
    room.beginMenuAudio(ada.playerId, 'lobby', true)(true);
    expect(room.completeSharedDecisionIfReady()).toBe(true);
    expect(room.phase).toBe('fighter_select');
  });

  it('holds an already recorded shared vote while a caller is speaking before final ASR', () => {
    const room = new FighterRoom('INPUT-TURN', 5);
    room.configureStandaloneSeats(2);
    const ada = room.addPlayer('Ada'), bo = room.addPlayer('Bo');
    if ('error' in ada || 'error' in bo) throw new Error('join failed');
    room.registerVoicePlayer(ada.playerId);
    room.registerVoicePlayer(bo.playerId);
    room.beginMenuAudio(ada.playerId, 'lobby')();
    room.beginMenuAudio(bo.playerId, 'lobby')();

    const finishBoInput = room.beginMenuTurn(bo.playerId, 'lobby');
    room.advance(ada.playerId);
    room.advance(bo.playerId);
    expect(room.phase).toBe('lobby');
    expect(room.completeSharedDecisionIfReady()).toBe(false);
    finishBoInput();
    expect(room.completeSharedDecisionIfReady()).toBe(true);
    expect(room.phase).toBe('fighter_select');
  });

  it('reserves a fixed one-caller match against a second caller', () => {
    const room = new FighterRoom('SOLO-RESERVATION', 1);
    expect(room.configureStandaloneSeats(1)).toBe(true);
    const first = room.addPlayer('Ada');
    if ('error' in first) throw new Error(first.error);

    expect(room.addPlayer('Bo')).toEqual({ error: 'room_full' });
    expect(room.state()).toMatchObject({ phase: 'lobby', expectedPlayerCount: 1,
      players: [expect.objectContaining({ name: 'Ada' })] });
  });

  it('treats a reconnecting display’s unchanged caller count as a no-op mid-menu', () => {
    const room = new FighterRoom('REJOIN-COUNT', 1);
    const ada = room.addPlayer('Ada');
    if ('error' in ada) throw new Error(ada.error);
    room.advance(ada.playerId);
    expect(room.phase).toBe('fighter_select');
    expect(room.configureStandaloneSeats(1)).toBe(true);
    expect(room.phase).toBe('fighter_select');
    expect(room.configureStandaloneSeats(2)).toBe(false);
    expect(room.state().expectedPlayerCount).toBe(1);
  });

  it('forgets a temporarily disconnected caller’s shared menu consent', () => {
    const room = new FighterRoom('HOLD-VOTE', 2);
    room.configureStandaloneSeats(2);
    const ada = room.addPlayer('Ada'), bo = room.addPlayer('Bo');
    if ('error' in ada || 'error' in bo) throw new Error('join failed');

    room.advance(ada.playerId);
    expect(room.state().advanceReadyPlayerIds).toEqual([ada.playerId]);
    (room as FighterRoom & { suspendPlayer?: (id: string) => void }).suspendPlayer?.(ada.playerId);
    expect(room.state().advanceReadyPlayerIds).toEqual([]);
    room.advance(bo.playerId);
    expect(room.phase).toBe('lobby');

    room.advance(ada.playerId);
    expect(room.phase).toBe('fighter_select');
    room.back(ada.playerId);
    expect(room.state().backReadyPlayerIds).toEqual([ada.playerId]);
    (room as FighterRoom & { suspendPlayer?: (id: string) => void }).suspendPlayer?.(ada.playerId);
    expect(room.state().backReadyPlayerIds).toEqual([]);
    room.back(bo.playerId);
    expect(room.phase).toBe('fighter_select');
  });

  it('holds the two-caller result until a suspended caller returns and votes again', () => {
    const room = new FighterRoom('RESULT-HOLD-VOTE', 3);
    room.configureStandaloneSeats(2);
    const ada = room.addPlayer('Ada'), bo = room.addPlayer('Bo');
    if ('error' in ada || 'error' in bo) throw new Error('join failed');
    room.advance(ada.playerId); room.advance(bo.playerId);
    room.selectFighter(ada.playerId, 'nyx'); room.selectFighter(bo.playerId, 'wraith');
    room.advance(ada.playerId); room.advance(bo.playerId);
    room.selectMap(ada.playerId, 'void'); room.selectMap(bo.playerId, 'void');
    room.advance(ada.playerId); room.advance(bo.playerId);
    room.ready(room.state().loadingGeneration); room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    const world = room.state().world!; world.status = 'finished'; world.winner = 'p1';
    room.tick(.1); room.tick(FIGHTER_VICTORY_SECONDS);
    room.acknowledgePresentation('results', room.state().loadingGeneration);

    room.advance(ada.playerId);
    expect(room.state().advanceReadyPlayerIds).toEqual([ada.playerId]);
    (room as FighterRoom & { suspendPlayer?: (id: string) => void }).suspendPlayer?.(ada.playerId);
    room.advance(bo.playerId);
    expect(room.state()).toMatchObject({ phase: 'results', result: { winnerName: 'Ada' } });
    expect(room.state().advanceReadyPlayerIds).toEqual([bo.playerId]);
    room.advance(ada.playerId);
    expect(room.phase).toBe('fighter_select');
  });

  it('changes the fixed caller count only for an unattended completed standalone result', () => {
    const room = new FighterRoom('NEXT-COUNT', 4);
    room.configureStandaloneSeats(1);
    const ada = room.addPlayer('Ada');
    if ('error' in ada) throw new Error(ada.error);
    room.advance(ada.playerId); room.selectFighter(ada.playerId, 'nyx'); room.advance(ada.playerId);
    room.selectMap(ada.playerId, 'void'); room.advance(ada.playerId);
    room.ready(room.state().loadingGeneration); room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    const world = room.state().world!; world.status = 'finished'; world.winner = 'p1';
    room.tick(.1); room.tick(FIGHTER_VICTORY_SECONDS); room.removePlayer(ada.playerId);
    expect(room.state()).toMatchObject({ phase: 'results', expectedPlayerCount: 1,
      result: { winnerName: 'Ada' } });

    expect(room.configureStandaloneSeats(1)).toBe(true);
    expect(room.phase).toBe('results');
    expect(room.configureStandaloneSeats(2)).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'lobby', expectedPlayerCount: 2, result: null });
  });

  it('keeps standalone Fighter in lobby until a named caller explicitly advances', () => {
    const room = new FighterRoom('NAMES', 1);
    room.expectHumanPlayers(1);
    const caller = room.addPlayer('Caller', undefined, false); if ('error' in caller) throw new Error(caller.error);
    expect(room.phase).toBe('lobby');
    room.setName(caller.playerId, 'Ada');
    expect(room.phase).toBe('lobby');
    expect(room.advance()).toBe(false);
    expect(room.advance(caller.playerId)).toBe(true);
    expect(room.phase).toBe('fighter_select');
  });
  it('runs lobby through selection into a solo AI fight', () => {
    const room = new FighterRoom('4821', 1);
    const joined = room.addPlayer('Ada'); if ('error' in joined) throw new Error(joined.error);
    expect(room.advance()).toBe(true);
    expect(room.selectFighter(joined.playerId, 'nyx')).toBe(true);
    expect(room.advance()).toBe(true);
    const warmedRival = room.state().aiFighterId;
    expect(warmedRival).toBeTruthy();
    expect(warmedRival).not.toBe('nyx');
    expect(room.selectMap(joined.playerId,'void')).toBe(true);
    expect(room.advance()).toBe(true);
    expect(room.state().aiFighterId).toBe(warmedRival);
    expect(room.phase).toBe('loading');
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    expect(room.phase).toBe('intro');
    expect(room.command(joined.playerId, 'punch')).toEqual([]);
    expect(room.state().intro).toBe(FIGHTER_INTRO_SECONDS);
    room.tick(FIGHTER_INTRO_SECONDS + 0.1);
    expect(room.phase).toBe('countdown');
    expect(room.state().countdown).toBe(6);
    room.tick(6.1);
    expect(room.phase).toBe('fight');
    expect(room.lobbyPlayers()).toHaveLength(2);
    expect(room.lobbyPlayers()[1]?.isAi).toBe(true);
    expect(room.lobbyPlayers()[1]?.fighterId).toBe(warmedRival);
  });
  it('keeps the solo rival across loading retry but clears it when fighter selection reopens', () => {
    const room = new FighterRoom('WARMUP', 1);
    const joined = room.addPlayer('Ada'); if ('error' in joined) throw new Error(joined.error);
    room.advance(); room.selectFighter(joined.playerId, 'nyx'); room.advance();
    const rival = room.state().aiFighterId;
    expect(rival).toBeTruthy();
    room.selectMap(joined.playerId, 'void'); room.advance();
    expect(room.back()).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'map_select', aiFighterId: rival });
    expect(room.back()).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'fighter_select', aiFighterId: null });
  });
  it('chooses a solo rival when a second standalone caller leaves during arena selection', () => {
    const room = new FighterRoom('DROP-WARMUP', 1);
    const first = room.addPlayer('Ada'), second = room.addPlayer('Bo');
    if ('error' in first || 'error' in second) throw new Error('join failed');
    room.advance(); room.selectFighter(first.playerId, 'nyx'); room.selectFighter(second.playerId, 'wraith');
    room.advance();
    expect(room.state().aiFighterId).toBeNull();
    room.removePlayer(second.playerId);
    expect(room.state().phase).toBe('map_select');
    expect(room.state().aiFighterId).toBeTruthy();
    expect(room.state().aiFighterId).not.toBe('nyx');
  });
  it('refreshes the loading generation and timeout budget for an authenticated retry', () => {
    const room = new FighterRoom('RETRY', 1);
    const joined = room.addPlayer('Ada'); if ('error' in joined) throw new Error(joined.error);
    room.advance(); room.selectFighter(joined.playerId, 'nyx'); room.advance(); room.selectMap(joined.playerId, 'void'); room.advance();
    const generation = room.state().loadingGeneration;
    room.tick(FIGHTER_LOADING_TIMEOUT_SECONDS - 5);
    expect(room.retryLoading(generation)).toBe(true);
    expect(room.state().loadingGeneration).toBe(generation + 1);
    room.tick(10);
    expect(room.phase).toBe('loading');
    expect(room.retryLoading(generation)).toBe(false);
  });
  it('returns pre-fight phases to loading when display readiness is lost', () => {
    const room = new FighterRoom('DISPLAY-LOSS', 1);
    const joined = room.addPlayer('Ada'); if ('error' in joined) throw new Error(joined.error);
    room.advance(); room.selectFighter(joined.playerId, 'nyx'); room.advance(); room.selectMap(joined.playerId, 'void'); room.advance();
    const firstGeneration = room.state().loadingGeneration;
    room.ready(firstGeneration);
    expect(room.invalidateDisplayReady()).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'loading', loadingGeneration: firstGeneration + 1, intro: null, countdown: null });
    expect(room.ready(firstGeneration)).toBe(false);
    expect(room.ready(firstGeneration + 1)).toBe(true);
    room.tick(FIGHTER_INTRO_SECONDS + .1);
    expect(room.phase).toBe('countdown');
    expect(room.invalidateDisplayReady()).toBe(true);
    expect(room.phase).toBe('loading');
    expect(room.invalidateDisplayReady()).toBe(false);
  });
  it('binds each human to only their own side', () => {
    const room = new FighterRoom('4821', 1);
    const a = room.addPlayer('A'), b = room.addPlayer('B');
    if ('error' in a || 'error' in b) throw new Error('join failed');
    room.advance(); room.selectFighter(a.playerId, 'nyx'); room.selectFighter(b.playerId, 'wraith'); room.advance(); room.selectMap(a.playerId,'foundry'); room.advance(); room.ready(room.state().loadingGeneration); room.tick(FIGHTER_INTRO_SECONDS + 0.1); room.tick(6.1);
    expect(room.command(b.playerId, 'jump')[0]).toEqual({ type: 'action', fighter: 'p2', command: 'jump' });
    expect(room.command('unknown', 'punch')).toEqual([]);
  });
  it('waits for both expected station callers and preserves assigned sides', () => {
    const room=new FighterRoom('4821');room.expectHumanPlayers(2);
    const b=room.addPlayer('B','p2');if('error' in b)throw new Error(b.error);
    expect(room.state()).toMatchObject({ expectedPlayerCount: 2, hasExpectedPlayers: false });
    const a=room.addPlayer('A','p1');if('error' in a)throw new Error(a.error);
    expect(room.state()).toMatchObject({ expectedPlayerCount: 2, hasExpectedPlayers: true });
    expect(room.phase).toBe('lobby');expect(room.advance()).toBe(false);expect(room.advance(a.playerId)).toBe(true);
    expect(room.phase).toBe('lobby');expect(room.advance(b.playerId)).toBe(true);
    expect(room.back()).toBe(false);expect(room.phase).toBe('fighter_select');
    room.selectFighter(b.playerId,'wraith');
    room.selectFighter(a.playerId,'nyx');expect(room.phase).toBe('fighter_select');expect(room.advance()).toBe(false);
    expect(room.advance(a.playerId)).toBe(true);expect(room.phase).toBe('fighter_select');
    expect(room.advance(b.playerId)).toBe(true);expect(room.phase).toBe('map_select');
    expect(room.lobbyPlayers()).toEqual(expect.arrayContaining([
      expect.objectContaining({playerId:a.playerId,side:'p1',fighterId:'nyx'}),
      expect.objectContaining({playerId:b.playerId,side:'p2',fighterId:'wraith'}),
    ]));
    expect(room.selectMap(b.playerId,'void')).toBe(true);
    expect(room.state()).toMatchObject({phase:'map_select',mapVotesByPlayerId:{[b.playerId]:'void'}});
    expect(room.selectMap(a.playerId,'foundry')).toBe(true);
    expect(room.phase).toBe('map_select');expect(room.advance()).toBe(false);
    expect(room.advance(b.playerId)).toBe(true);expect(room.phase).toBe('map_select');
    expect(room.advance(a.playerId)).toBe(true);expect(room.phase).toBe('loading');
  });

  it('requires both callers to confirm each shared menu before it moves', () => {
    const room = new FighterRoom('BOTH-READY', 7);
    room.expectHumanPlayers(2);
    const ada = room.addPlayer('Ada', 'p1');
    const bo = room.addPlayer('Bo', 'p2');
    if ('error' in ada || 'error' in bo) throw new Error('join failed');

    expect(room.advance(ada.playerId)).toBe(true);
    expect(room.phase).toBe('lobby');
    expect(room.state().advanceReadyPlayerIds).toEqual([ada.playerId]);
    expect(room.advance(bo.playerId)).toBe(true);
    expect(room.phase).toBe('fighter_select');
    expect(room.state().advanceReadyPlayerIds).toEqual([]);

    room.selectFighter(ada.playerId, 'nyx');
    room.selectFighter(bo.playerId, 'wraith');
    expect(room.advance(ada.playerId)).toBe(true);
    expect(room.phase).toBe('fighter_select');
    room.selectFighter(bo.playerId, 'cinder-capone');
    expect(room.state().advanceReadyPlayerIds).toEqual([]);
    expect(room.advance(bo.playerId)).toBe(true);
    expect(room.phase).toBe('fighter_select');
    expect(room.advance(ada.playerId)).toBe(true);
    expect(room.phase).toBe('map_select');

    room.selectMap(ada.playerId, 'void');
    room.selectMap(bo.playerId, 'foundry');
    expect(room.advance(ada.playerId)).toBe(true);
    expect(room.phase).toBe('map_select');
    expect(room.advance(bo.playerId)).toBe(true);
    expect(room.phase).toBe('loading');
  });

  it('waits for both callers before rewinding a shared menu', () => {
    const room = new FighterRoom('BOTH-BACK', 11);
    room.expectHumanPlayers(2);
    const ada = room.addPlayer('Ada', 'p1');
    const bo = room.addPlayer('Bo', 'p2');
    if ('error' in ada || 'error' in bo) throw new Error('join failed');
    room.advance(ada.playerId); room.advance(bo.playerId);
    room.selectFighter(ada.playerId, 'nyx'); room.selectFighter(bo.playerId, 'wraith');
    room.advance(ada.playerId); room.advance(bo.playerId);

    expect(room.back(ada.playerId)).toBe(true);
    expect(room.phase).toBe('map_select');
    expect(room.state().backReadyPlayerIds).toEqual([ada.playerId]);
    expect(room.back(bo.playerId)).toBe(true);
    expect(room.phase).toBe('fighter_select');
    expect(room.state().backReadyPlayerIds).toEqual([]);
  });

  it('shows when arena votes tie and clears the tie after a vote changes', () => {
    const room = new FighterRoom('TIE', 17);
    room.expectHumanPlayers(2);
    const ada = room.addPlayer('Ada', 'p1');
    const bo = room.addPlayer('Bo', 'p2');
    if ('error' in ada || 'error' in bo) throw new Error('join failed');
    room.advance(ada.playerId); room.advance(bo.playerId);
    room.selectFighter(ada.playerId, 'nyx'); room.selectFighter(bo.playerId, 'wraith');
    room.advance(ada.playerId); room.advance(bo.playerId);
    room.selectMap(ada.playerId, 'void'); room.selectMap(bo.playerId, 'foundry');
    expect(room.state().mapVoteTied).toBe(true);
    expect(['void', 'foundry']).toContain(room.state().selectedMap);
    room.selectMap(bo.playerId, 'void');
    expect(room.state()).toMatchObject({ mapVoteTied: false, selectedMap: 'void' });
  });

  it('lets a lone retained player continue through explicit gates after a no-show drop', () => {
    const room=new FighterRoom('4821');room.expectHumanPlayers(2);
    const b=room.addPlayer('B','p2');if('error' in b)throw new Error(b.error);
    room.expectHumanPlayers(1);room.advance(b.playerId);room.selectFighter(b.playerId,'wraith');

    expect(room.canControlSetup(b.playerId)).toBe(true);
    expect(room.state()).toMatchObject({expectedPlayerCount:1,hasExpectedPlayers:true,players:[expect.objectContaining({playerId:b.playerId,side:'p1'})]});
    expect(room.phase).toBe('fighter_select');expect(room.advance()).toBe(false);
    expect(room.advance(b.playerId)).toBe(true);expect(room.phase).toBe('map_select');
  });
  it('lets a standalone survivor continue against AI after the other caller disconnects', () => {
    const room=new FighterRoom('STANDALONE-DROP');room.expectHumanPlayers(2,false);
    const a=room.addPlayer('Ada'),b=room.addPlayer('Bo');if('error' in a||'error' in b)throw new Error('join failed');
    room.removePlayer(b.playerId);
    room.advance(a.playerId);
    room.selectFighter(a.playerId,'nyx');
    expect(room.phase).toBe('fighter_select');room.advance(a.playerId);
    expect(room.phase).toBe('map_select');
    room.selectMap(a.playerId,'void');
    expect(room.phase).toBe('map_select');room.advance(a.playerId);
    expect(room.phase).toBe('loading');
  });
  it('rebuilds standalone loading setup when one caller disconnects', () => {
    const room=new FighterRoom('LOADING-DROP');room.expectHumanPlayers(2,false);
    const a=room.addPlayer('Ada'),b=room.addPlayer('Bo');if('error' in a||'error' in b)throw new Error('join failed');
    room.advance(a.playerId);room.advance(b.playerId);
    room.selectFighter(a.playerId,'nyx');room.selectFighter(b.playerId,'wraith');
    room.advance(a.playerId);room.advance(b.playerId);
    room.selectMap(a.playerId,'void');room.selectMap(b.playerId,'void');
    room.advance(a.playerId);room.advance(b.playerId);
    expect(room.phase).toBe('loading');
    room.removePlayer(b.playerId);
    expect(room.phase).toBe('fighter_select');
    expect(room.state().selectedMap).toBeNull();
    room.advance(a.playerId);
    expect(room.phase).toBe('map_select');
    room.selectMap(a.playerId,'void');
    expect(room.phase).toBe('map_select');room.advance(a.playerId);
    expect(room.phase).toBe('loading');
    expect(room.lobbyPlayers().find(player=>player.isAi)?.fighterId).not.toBe('nyx');
  });
  it('gates advancement on valid selections', () => {
    const room = new FighterRoom('4821'); const joined = room.addPlayer('A'); if ('error' in joined) throw new Error('join failed');
    room.advance(); expect(room.advance()).toBe(false); expect(room.selectFighter(joined.playerId, 'missing')).toBe(false);
  });

  it('rejects late joins after character selection', () => {
    const room = new FighterRoom('4821'); const joined = room.addPlayer('A'); if ('error' in joined) throw new Error('join failed');
    room.advance(); room.selectFighter(joined.playerId, 'nyx'); room.advance();
    expect(room.addPlayer('Late')).toEqual({ error: 'room_full' });
  });

  it('chooses a random solo rival that is never the player fighter', () => {
    const rivals = new Set<string>();
    for (let index = 1; index <= 12; index++) {
      const seed = (index * 0x1f123bb5) >>> 0;
      const room = new FighterRoom(`AI${seed}`, seed); const joined = room.addPlayer('A'); if ('error' in joined) throw new Error('join failed');
      room.advance(); room.selectFighter(joined.playerId, 'nyx'); room.advance(); room.selectMap(joined.playerId,'foundry'); room.advance();
      const rival = room.lobbyPlayers().find(player => player.isAi)?.fighterId;
      expect(rival).not.toBe('nyx'); if (rival) rivals.add(rival);
    }
    expect(rivals.size).toBeGreaterThan(1);
  });

  it('keeps an assigned side stable when the other player leaves', () => {
    const room = new FighterRoom('4821'); const a = room.addPlayer('A'), b = room.addPlayer('B');
    if ('error' in a || 'error' in b) throw new Error('join failed');
    room.removePlayer(a.playerId);
    expect(room.lobbyPlayers()).toMatchObject([{ playerId: b.playerId, side: 'p2' }]);
    const c = room.addPlayer('C'); if ('error' in c) throw new Error('join failed');
    expect(room.lobbyPlayers()).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: b.playerId, side: 'p2' }),
      expect.objectContaining({ playerId: c.playerId, side: 'p1' }),
    ]));
  });

  it('reopens fighter selection for a replacement when a player leaves arena voting',()=>{
    const room=new FighterRoom('4821');room.expectHumanPlayers(2);
    const a=room.addPlayer('A','p1'),b=room.addPlayer('B','p2');if('error'in a||'error'in b)throw new Error('join failed');
    room.advance(a.playerId);room.advance(b.playerId);
    room.selectFighter(a.playerId,'nyx');room.selectFighter(b.playerId,'wraith');
    room.advance(a.playerId);room.advance(b.playerId);expect(room.phase).toBe('map_select');
    room.selectMap(a.playerId,'void');room.removePlayer(b.playerId);
    expect(room.state()).toMatchObject({phase:'fighter_select',selectedMap:null,mapVotesByPlayerId:{}});
    expect(room.addPlayer('C','p2')).toEqual(expect.objectContaining({playerId:expect.any(String)}));
  });

  it.each(['count-first','remove-first'] as const)('keeps arena voting gated when a no-show is dropped %s',order=>{
    const room=new FighterRoom('4821');room.expectHumanPlayers(2);
    const a=room.addPlayer('A','p1'),b=room.addPlayer('B','p2');if('error'in a||'error'in b)throw new Error('join failed');
    room.advance(a.playerId);room.advance(b.playerId);
    room.selectFighter(a.playerId,'nyx');room.selectFighter(b.playerId,'wraith');
    room.advance(a.playerId);room.advance(b.playerId);room.selectMap(a.playerId,'void');
    if(order==='count-first')room.expectHumanPlayers(1);
    room.removePlayer(b.playerId);
    if(order==='remove-first')room.expectHumanPlayers(1);
    if(room.phase==='fighter_select')expect(room.advance(a.playerId)).toBe(true);
    expect(room.phase).toBe('map_select');expect(room.state().selectedMap).toBe('void');
    expect(room.advance(a.playerId)).toBe(true);expect(room.phase).toBe('loading');
  });

  it('rejects stale loading generations and falls back to map selection', () => {
    const room = new FighterRoom('4821'); const player = room.addPlayer('A'); if ('error' in player) throw new Error('join failed');
    room.advance(); room.selectFighter(player.playerId, 'nyx'); room.advance(); room.selectMap(player.playerId,'void'); room.advance();
    const generation = room.state().loadingGeneration;
    expect(room.ready(generation + 1)).toBe(false);
    expect(FIGHTER_LOADING_TIMEOUT_SECONDS).toBeGreaterThan(15);
    room.tick(15);
    expect(room.phase).toBe('loading');
    room.tick(FIGHTER_LOADING_TIMEOUT_SECONDS - 15);
    expect(room.phase).toBe('map_select');
    expect(room.state().world).toBeNull();
  });

  it('lets the display cancel loading back to map selection', () => {
    const room = new FighterRoom('4821'); const player = room.addPlayer('A'); if ('error' in player) throw new Error('join failed');
    room.advance(); room.selectFighter(player.playerId, 'nyx'); room.advance(); room.selectMap(player.playerId,'void'); room.advance();
    expect(room.back()).toBe(true);
    expect(room.phase).toBe('map_select');
    expect(room.state().world).toBeNull();
  });

  it('keeps rematch locked until the authoritative victory presentation finishes', () => {
    const room = new FighterRoom('4821'); const player = room.addPlayer('A'); if ('error' in player) throw new Error('join failed');
    room.advance(); room.selectFighter(player.playerId, 'nyx'); room.advance(); room.selectMap(player.playerId,'void'); room.advance();
    room.ready(room.state().loadingGeneration); room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    const world = room.state().world!; world.p1.x = 0; world.p2.x = 1; world.p2.health = 10;
    room.command(player.playerId, 'kick'); room.tick(0.6);
    expect(room.phase).toBe('victory');
    expect(room.advance()).toBe(false);
    room.tick(FIGHTER_VICTORY_SECONDS);
    expect(room.phase).toBe('results');
    expect(room.advance()).toBe(false);
    expect(room.acknowledgePresentation('results',room.state().loadingGeneration)).toBe(true);
    expect(room.advance()).toBe(true);
    expect(room.phase).toBe('fighter_select');
  });

  it('keeps the winner, roster, and result visible after every caller hangs up', () => {
    const room = readyFightRoom();
    const players = room.state().players;
    const world = room.state().world!;
    world.status = 'finished'; world.winner = 'p1';
    room.tick(.1);
    room.removePlayer(players[0]!.playerId);
    room.removePlayer(players[1]!.playerId);
    expect(room.phase).toBe('victory');
    room.tick(FIGHTER_VICTORY_SECONDS);
    room.acknowledgePresentation('results', room.state().loadingGeneration);
    expect(room.state()).toMatchObject({
      phase: 'results', result: { winner: 'p1', winnerName: 'Ada' },
      players: [expect.objectContaining({ name: 'Ada', fighterId: 'nyx' }),
        expect.objectContaining({ name: 'Bo', fighterId: 'wraith' })],
    });
    expect(room.isEmpty).toBe(true);
    expect(room.advance()).toBe(true);
    expect(room.phase).toBe('lobby');
  });

  it.each(['victory', 'results'] as const)('starts a fresh standalone lobby only when a new caller joins an empty %s room', finalPhase => {
    const room = new FighterRoom('NEXT-CALLER', 1);
    const first = room.addPlayer('Ada'); if ('error' in first) throw new Error(first.error);
    room.advance(); room.selectFighter(first.playerId, 'nyx'); room.advance();
    room.selectMap(first.playerId, 'void'); room.advance();
    room.ready(room.state().loadingGeneration); room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    const world = room.state().world!; world.status = 'finished'; world.winner = 'p1';
    room.tick(.1); if (finalPhase === 'results') room.tick(FIGHTER_VICTORY_SECONDS);
    room.removePlayer(first.playerId);

    expect(room.state()).toMatchObject({ phase: finalPhase, result: { winnerName: 'Ada' } });
    const next = room.addPlayer('Bea', undefined, false);
    if ('error' in next) throw new Error(next.error);
    expect(room.state()).toMatchObject({
      phase: 'lobby', result: null, selectedMap: null, players: [expect.objectContaining({ playerId: next.playerId, name: 'Bea' })],
    });
    expect(room.advance(next.playerId)).toBe(false);
    room.setName(next.playerId, 'Bea');
    expect(room.advance(next.playerId)).toBe(true);
    expect(room.phase).toBe('fighter_select');
  });

  it.each(['victory', 'results'] as const)('does not let a new caller erase a fixed station %s', finalPhase => {
    const room = new FighterRoom('FIXED-RESULT', 1);
    room.expectHumanPlayers(1, true);
    const first = room.addPlayer('Ada'); if ('error' in first) throw new Error(first.error);
    room.advance(first.playerId); room.selectFighter(first.playerId, 'nyx'); room.advance(first.playerId);
    room.selectMap(first.playerId, 'void'); room.advance(first.playerId);
    room.ready(room.state().loadingGeneration); room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    const world = room.state().world!; world.status = 'finished'; world.winner = 'p1';
    room.tick(.1); if (finalPhase === 'results') room.tick(FIGHTER_VICTORY_SECONDS);
    room.removePlayer(first.playerId);

    expect(room.addPlayer('Late')).toEqual({ error: 'room_full' });
    expect(room.state()).toMatchObject({ phase: finalPhase, result: { winnerName: 'Ada' } });
  });

  it('accepts only current-match display paint receipts and invalidates them on display loss', () => {
    const room = new FighterRoom('PAINT', 1);
    const player=room.addPlayer('Ada');if('error' in player)throw new Error(player.error);
    room.advance();room.selectFighter(player.playerId,'nyx');room.advance();
    room.selectMap(player.playerId,'void');room.advance();
    const generation=room.state().loadingGeneration;
    room.ready(generation);room.tick(FIGHTER_INTRO_SECONDS);room.tick(6);
    expect(room.hudPresented).toBe(false);
    expect(room.acknowledgePresentation('fight',generation+1)).toBe(false);
    expect(room.acknowledgePresentation('fight',generation)).toBe(true);
    expect(room.hudPresented).toBe(true);
    const world=room.state().world!;world.p1.x=0;world.p2.x=1;world.p2.health=10;
    room.command(player.playerId,'kick');room.tick(.6);room.tick(FIGHTER_VICTORY_SECONDS);
    expect(room.resultsPresented).toBe(false);
    expect(room.acknowledgePresentation('results',generation+1)).toBe(false);
    expect(room.acknowledgePresentation('results',generation)).toBe(true);
    expect(room.resultsPresented).toBe(true);
    room.invalidatePresentation();
    expect(room.resultsPresented).toBe(false);
  });

  it('exposes a bounded result-presentation recovery deadline without falsely marking paint', () => {
    let now=10_000;
    const room=new FighterRoom('RECOVER',1,undefined,()=>now);
    const player=room.addPlayer('Ada');if('error' in player)throw new Error(player.error);
    room.advance();room.selectFighter(player.playerId,'nyx');room.advance();
    room.selectMap(player.playerId,'void');room.advance();
    room.ready(room.state().loadingGeneration);room.tick(FIGHTER_INTRO_SECONDS);room.tick(6);
    const world=room.state().world!;world.p1.x=0;world.p2.x=1;world.p2.health=10;
    room.command(player.playerId,'kick');room.tick(.6);room.tick(FIGHTER_VICTORY_SECONDS);
    expect(room.resultsPresentationTimedOut).toBe(false);
    expect(room.resultsPresented).toBe(false);
    now += 15_001;
    expect(room.resultsPresentationTimedOut).toBe(true);
    expect(room.resultsPresented).toBe(false);
  });

  it('lets a finished caller skip the optional victory hold into results', () => {
    const room=new FighterRoom('SKIP',1);
    const player=room.addPlayer('Ada');if('error' in player)throw new Error(player.error);
    room.advance();room.selectFighter(player.playerId,'nyx');room.advance();
    room.selectMap(player.playerId,'void');room.advance();
    room.ready(room.state().loadingGeneration);room.tick(FIGHTER_INTRO_SECONDS);room.tick(6);
    const world=room.state().world!;world.p1.x=0;world.p2.x=1;world.p2.health=10;
    room.command(player.playerId,'kick');room.tick(.6);
    expect(room.phase).toBe('victory');
    expect(room.revealResults('stale')).toBe(false);
    expect(room.revealResults(player.playerId)).toBe(true);
    expect(room.phase).toBe('results');
    expect(room.resultsPresented).toBe(false);
  });

  it('rejects a stale caller attempting to replay another player’s finished match', () => {
    const room = readyFightRoom();
    const playerId = room.lobbyPlayers().find(player => !player.isAi)!.playerId;
    const world=room.state().world!;world.status='finished';world.winner='p1';
    room.tick(.1);room.tick(FIGHTER_VICTORY_SECONDS);
    room.acknowledgePresentation('results',room.state().loadingGeneration);
    expect(room.advance('stale-player')).toBe(false);
    expect(room.phase).toBe('results');
    expect(room.advance(playerId)).toBe(true);
  });

  it('supersedes a recovery attack with a newer defensive voice command and resolves both receipts', () => {
    const room = readyFightRoom();
    const playerId = room.lobbyPlayers().find(player => player.side === 'p1')!.playerId;
    expect(room.voiceCommand(playerId, 'punch', 'opening')).toMatchObject({ status: 'executed' });
    expect(room.voiceCommand(playerId, 'kick', 'stale-attack')).toMatchObject({ status: 'queued' });
    expect(room.voiceCommand(playerId, 'block', 'new-block')).toMatchObject({ status: 'queued' });
    expect(room.drainVoiceCommandOutcomes()).toContainEqual(expect.objectContaining({
      requestId: 'stale-attack', status: 'rejected', reason: 'superseded',
    }));
    room.tick(0.8);
    expect(room.drainVoiceCommandOutcomes()).toContainEqual(expect.objectContaining({
      requestId: 'new-block', status: 'executed',
    }));
    expect(room.drainEvents().flatMap(event => event.type === 'action' && event.fighter === 'p1' ? [event.command] : []))
      .toEqual(['punch', 'block']);
  });

  it('runs a queued solo caller command before an AI decision on the same ready tick', () => {
    const room = new FighterRoom('SOLO-PRIORITY', 1);
    const player = room.addPlayer('Ada'); if ('error' in player) throw new Error(player.error);
    room.advance(); room.selectFighter(player.playerId, 'nyx'); room.advance();
    room.selectMap(player.playerId, 'void'); room.advance();
    room.ready(room.state().loadingGeneration); room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    expect(room.voiceCommand(player.playerId, 'forward', 'opening')).toMatchObject({ status: 'executed' });
    expect(room.voiceCommand(player.playerId, 'block', 'queued-block')).toMatchObject({ status: 'queued' });
    room.drainEvents();
    room.tick(1);
    const actions = room.drainEvents().flatMap(event => event.type === 'action' ? [`${event.fighter}:${event.command}`] : []);
    expect(actions[0]).toBe('p1:block');
    expect(actions[1]).toMatch(/^p2:/);
    expect(room.drainVoiceCommandOutcomes()).toContainEqual(expect.objectContaining({
      requestId: 'queued-block', status: 'executed',
    }));
  });

  it('keeps both commands from one voice sequence in order through recovery', () => {
    const room = readyFightRoom();
    const playerId = room.lobbyPlayers().find(player => player.side === 'p1')!.playerId;
    room.voiceCommand(playerId, 'punch', 'opening');
    expect(room.voiceSequence(playerId, ['kick', 'block'], ['pair-1', 'pair-2']))
      .toEqual([expect.objectContaining({ status: 'queued' }), expect.objectContaining({ status: 'queued' })]);
    room.tick(0.75);
    expect(room.drainVoiceCommandOutcomes()).toContainEqual(expect.objectContaining({
      requestId: 'pair-1', status: 'executed',
    }));
    room.tick(1);
    expect(room.drainVoiceCommandOutcomes()).toContainEqual(expect.objectContaining({
      requestId: 'pair-2', status: 'executed',
    }));
    expect(room.drainEvents().flatMap(event => event.type === 'action' && event.fighter === 'p1' ? [event.command] : []))
      .toEqual(['punch', 'kick', 'block']);
  });

  it('reports expired sequence commands instead of silently dropping them', () => {
    let now = 0;
    const room = readyFightRoom(() => now);
    const playerId = room.lobbyPlayers().find(player => player.side === 'p1')!.playerId;
    room.voiceCommand(playerId, 'punch', 'opening');
    room.voiceSequence(playerId, ['kick', 'block'], ['pair-1', 'pair-2']);
    now = FIGHTER_VOICE_COMMAND_TTL_SECONDS * 1000 + 1;
    room.tick(0.1);
    expect(room.drainVoiceCommandOutcomes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'pair-1', status: 'rejected', reason: 'expired' }),
      expect.objectContaining({ requestId: 'pair-2', status: 'rejected', reason: 'expired' }),
    ]));
  });

  it('lets only a loaded solo match skip the optional intro and countdown', () => {
    const solo = new FighterRoom('SOLO');
    const player = solo.addPlayer('Ada') as { playerId: string };
    solo.advance(); solo.selectFighter(player.playerId, 'nyx'); solo.advance(); solo.selectMap(player.playerId, 'void'); solo.advance();
    expect(solo.startNow(player.playerId)).toBe(false);
    expect(solo.phase).toBe('loading');
    solo.ready(solo.state().loadingGeneration);
    expect(solo.startNow(player.playerId)).toBe(true);
    expect(solo.phase).toBe('fight');

    const duo = readyFightRoom();
    const first = duo.lobbyPlayers().find(p => p.side === 'p1')!.playerId;
    duo.phase = 'intro';
    expect(duo.startNow(first)).toBe(false);
    expect(duo.phase).toBe('intro');
  });

  it('treats later standalone voice commands as corrections, leaving at most two dependent commands', () => {
    const room = new FighterRoom('4821'); const a = room.addPlayer('A'), b = room.addPlayer('B');
    if ('error' in a || 'error' in b) throw new Error('join failed');
    room.advance(); room.selectFighter(a.playerId, 'nyx'); room.selectFighter(b.playerId, 'wraith');
    room.advance(); room.selectMap(a.playerId,'void'); room.advance(); room.ready(room.state().loadingGeneration); room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    expect(MAX_VOICE_COMMAND_QUEUE).toBe(2);
    expect(room.voiceCommand(a.playerId,'jump')).toBe(true);
    expect(room.voiceCommand(a.playerId,'punch')).toBe(true);
    expect(room.voiceCommand(a.playerId,'kick')).toBe(true);
    expect(room.voiceCommand(a.playerId,'block')).toBe(true);
    const events = room.drainEvents();
    for (let index = 0; index < 20; index++) { room.tick(0.1); events.push(...room.drainEvents()); }
    expect(events.flatMap(event=>event.type==='action'&&event.fighter==='p1'?[event.command]:[]))
      .toEqual(['jump','block']);
  });

  it('expires stale queued voice commands',()=>{
    let now=0;const room=new FighterRoom('4821',1,undefined,()=>now);const a=room.addPlayer('A'),b=room.addPlayer('B');
    if('error'in a||'error'in b)throw new Error('join failed');
    room.advance();room.selectFighter(a.playerId,'nyx');room.selectFighter(b.playerId,'wraith');
    room.advance();room.selectMap(a.playerId,'void');room.advance();room.ready(room.state().loadingGeneration);room.tick(FIGHTER_INTRO_SECONDS);room.tick(6);
    room.voiceCommand(a.playerId,'kick');room.voiceCommand(a.playerId,'punch');room.voiceCommand(a.playerId,'block');
    now=FIGHTER_VOICE_COMMAND_TTL_SECONDS*1000;room.tick(1);
    expect(room.voiceCommand(a.playerId,'jump')).toBe(true);
    const commands=room.drainEvents().flatMap(event=>event.type==='action'&&event.fighter==='p1'?[event.command]:[]);
    expect(commands).toEqual(['kick','jump']);
  });
});
