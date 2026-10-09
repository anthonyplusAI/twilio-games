import { describe, expect, it } from 'vitest';
import {
  advanceStationResults,
  assertStationInvariants,
  closeStationRecruiting,
  completeStationMatch,
  createArcadeStation,
  dropStationAdmittedEntry,
  insertStationCoin,
  failStationLaunch,
  leaveStationReadyEntry,
  markStationDisplayReady,
  markStationMatchStarted,
  recordStationGameChoice,
  requestStationLaunch,
  resetArcadeStation,
  selectStationGame,
  stationReadyEntries,
  type ArcadeStationAggregate,
} from '../shared/arcade-station';

const T0 = '2026-07-21T10:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

function insert(state: ArcadeStationAggregate, player: string, index: number, seconds = index) {
  return insertStationCoin(state, {
    readyEntryId: `ready-${index}`,
    roundId: `round-${index}`,
    playerId: player,
    reservationId: `reservation-${index}`,
    at: at(seconds),
    configVersion: 1,
    expectedRevision: state.station.revision,
  });
}

describe('Arcade station reducer', () => {
  it.each([
    'RECRUITING', 'GAME_SELECTION', 'LOCKED', 'LAUNCHING', 'PLAYING', 'RESULTS',
  ] as const)('resets %s to an audited-safe idle aggregate in one revision', phase => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    if (phase !== 'RECRUITING') {
      state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    }
    if (!['RECRUITING', 'GAME_SELECTION'].includes(phase)) {
      state = selectStationGame(state, {
        game: 'racer', matchId: 'match-1', engineRoomCode: '4821', at: at(91),
        expectedRevision: state.station.revision,
      });
    }
    if (['LAUNCHING', 'PLAYING', 'RESULTS'].includes(phase)) {
      state = requestStationLaunch(state, { at: at(101), expectedRevision: state.station.revision });
    }
    if (['PLAYING', 'RESULTS'].includes(phase)) {
      state = markStationDisplayReady(state, { at: at(102), expectedRevision: state.station.revision });
      state = markStationMatchStarted(state, {
        at: at(103), expectedRevision: state.station.revision,
        redeemedReservationIds: ['reservation-1'],
      });
    }
    if (phase === 'RESULTS') {
      state = completeStationMatch(state, { at: at(104), expectedRevision: state.station.revision });
    }

    const previousRevision = state.station.revision;
    state = resetArcadeStation(state, { at: at(200), expectedRevision: previousRevision });

    expect(state.station).toMatchObject({
      phase: 'ATTRACT', activeRoundId: null, nextRoundId: null,
      activeGame: null, activeMatchId: null, revision: previousRevision + 1,
    });
    expect(state.rounds['round-1']).toMatchObject({ phase: 'CLOSED', closedAt: at(200) });
    expect(state.readyEntries['ready-1']?.status).toBe(phase === 'RESULTS' ? 'COMPLETED' : 'LEFT');
    if (state.matches['match-1']) {
      expect(state.matches['match-1']).toMatchObject({
        phase: phase === 'RESULTS' ? 'COMPLETED' : 'FAILED', completedAt: phase === 'RESULTS' ? at(104) : at(200),
      });
    }
    expect(() => assertStationInvariants(state)).not.toThrow();
  });

  it('closes overflow and next-round work during a playing reset', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 5; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, {
      game: 'racer', matchId: 'match-1', engineRoomCode: '4821', at: at(91),
      expectedRevision: state.station.revision,
    });
    state = requestStationLaunch(state, { at: at(101), expectedRevision: state.station.revision });
    state = markStationDisplayReady(state, { at: at(102), expectedRevision: state.station.revision });
    state = markStationMatchStarted(state, {
      at: at(103), expectedRevision: state.station.revision,
      redeemedReservationIds: ['reservation-1', 'reservation-2'],
    });
    state = insert(state, 'late-player', 6, 110);

    state = resetArcadeStation(state, { at: at(120), expectedRevision: state.station.revision });

    expect(Object.values(state.readyEntries).map(entry => entry.status)).toEqual(Array(6).fill('LEFT'));
    expect(state.rounds['round-1']?.phase).toBe('CLOSED');
    expect(state.rounds['round-6']?.phase).toBe('CLOSED');
    expect(state.matches['match-1']).toMatchObject({ phase: 'FAILED', completedAt: at(120) });
  });

  it('rejects resetting an already idle station or a stale revision', () => {
    const idle = createArcadeStation('ARCADE-01', T0);
    expect(() => resetArcadeStation(idle, { at: at(1), expectedRevision: idle.station.revision }))
      .toThrow(/already idle/);
    const recruiting = insert(idle, 'player-1', 1);
    expect(() => resetArcadeStation(recruiting, { at: at(2), expectedRevision: idle.station.revision }))
      .toThrow(/revision changed/);
  });

  it('starts recruiting on the first coin and rejects a duplicate live player', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    expect(state.station).toMatchObject({ phase: 'RECRUITING', activeRoundId: 'round-1' });
    expect(state.rounds['round-1']).toMatchObject({
      recruitingEndsAt: at(91), hardEndsAt: at(121),
    });
    expect(() => insert(state, 'player-1', 2)).toThrow(/already has an active ready entry/);
  });

  it('places a coin arriving at the persisted cutoff into the next round', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    state = insert(state, 'player-2', 2, 91);
    expect(state.station).toMatchObject({
      phase: 'RECRUITING', activeRoundId: 'round-1', nextRoundId: 'round-2',
    });
    expect(state.readyEntries['ready-1']?.roundId).toBe('round-1');
    expect(state.readyEntries['ready-2']?.roundId).toBe('round-2');
  });

  it('admits two Racer players and preserves FIFO overflow', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 5; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, {
      game: 'racer', matchId: 'match-1', engineRoomCode: '4821', at: at(91),
      expectedRevision: state.station.revision,
    });
    expect(state.matches['match-1']?.participantReadyEntryIds).toEqual(['ready-1', 'ready-2']);
    expect(state.matches['match-1']?.overflowReadyEntryIds).toEqual(['ready-3', 'ready-4', 'ready-5']);
    expect(state.matches['match-1']?.humanCapacity).toBe(2);
    expect(state.readyEntries['ready-3']).toMatchObject({ status: 'OVERFLOW', overflowOrdinal: 1 });
  });

  it('records and changes only current READY choices during game selection', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    state = insert(state, 'player-2', 2);
    expect(() => recordStationGameChoice(state, {
      readyEntryId: 'ready-1', roundId: 'round-1', game: 'racer', at: at(3),
      expectedRevision: state.station.revision,
    })).toThrow(/selection is not active/);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    const selectionRevision = state.station.revision;
    state = recordStationGameChoice(state, {
      readyEntryId: 'ready-1', roundId: 'round-1', game: 'racer', at: at(91),
      expectedRevision: selectionRevision,
    });
    state = recordStationGameChoice(state, {
      readyEntryId: 'ready-1', roundId: 'round-1', game: 'fighter', at: at(92),
      expectedRevision: state.station.revision,
    });
    expect(state.rounds['round-1']?.gameChoicesByReadyEntryId).toEqual({ 'ready-1': 'fighter' });
    expect(Object.isFrozen(state.rounds['round-1']?.gameChoicesByReadyEntryId)).toBe(true);
    expect(() => recordStationGameChoice(state, {
      readyEntryId: 'ready-2', roundId: 'stale-round', game: 'racer', at: at(93),
      expectedRevision: state.station.revision,
    })).toThrow(/not active for this round/);
    state = recordStationGameChoice(state, {
      readyEntryId: 'ready-2', roundId: 'round-1', game: 'trivia', at: at(93),
      expectedRevision: state.station.revision,
    });
    expect(state.rounds['round-1']?.gameChoicesByReadyEntryId).toEqual({
      'ready-1': 'fighter', 'ready-2': 'trivia',
    });
    expect(() => recordStationGameChoice(state, {
      readyEntryId: 'ready-2', roundId: 'round-1', game: 'racer', at: at(93),
      expectedRevision: selectionRevision,
    })).toThrow(/revision changed/);

    state = leaveStationReadyEntry(state, {
      readyEntryId: 'ready-1', at: at(94), expectedRevision: state.station.revision,
    });
    expect(state.rounds['round-1']?.gameChoicesByReadyEntryId).toEqual({ 'ready-2': 'trivia' });
    state = recordStationGameChoice(state, {
      readyEntryId: 'ready-2', roundId: 'round-1', game: 'racer', at: at(95),
      expectedRevision: state.station.revision,
    });
    state = selectStationGame(state, {
      game: 'racer', matchId: 'choice-match', engineRoomCode: 'CHOICE', at: at(96),
      expectedRevision: state.station.revision,
    });
    expect(state.rounds['round-1']?.gameChoicesByReadyEntryId).toEqual({});
    expect(state.matches['choice-match']?.participantReadyEntryIds).toEqual(['ready-2']);
  });

  it('rejects game choices at and after the persisted selection deadline', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    expect(state.rounds['round-1']?.selectionEndsAt).toBe(at(120));

    for (const seconds of [120, 121]) {
      expect(() => recordStationGameChoice(state, {
        readyEntryId: 'ready-1', roundId: 'round-1', game: 'racer', at: at(seconds),
        expectedRevision: state.station.revision,
      })).toThrow(expect.objectContaining({ code: 'SELECTION_CLOSED' }));
    }
    expect(state.rounds['round-1']?.gameChoicesByReadyEntryId).toEqual({});
  });

  it.each([['racer', 2], ['monsters', 2], ['fighter', 2], ['karaoke', 1], ['trivia', 4], ['chess', 2]] as const)('enforces %s capacity %d', (game, capacity) => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 4; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game, matchId: 'match-1', engineRoomCode: '4821', at: at(91),
      expectedRevision: state.station.revision });
    expect(state.matches['match-1']?.participantReadyEntryIds).toHaveLength(capacity);
    expect(state.matches['match-1']?.overflowReadyEntryIds).toHaveLength(4 - capacity);
  });

  it('collects coins for the next round during play and promotes overflow after results', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 5; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, {
      game: 'racer', matchId: 'match-1', engineRoomCode: '4821', at: at(91),
      expectedRevision: state.station.revision,
    });
    state = requestStationLaunch(state, { at: at(101), expectedRevision: state.station.revision });
    state = markStationDisplayReady(state, { at: at(102), expectedRevision: state.station.revision });
    state = markStationMatchStarted(state, { at: at(103), expectedRevision: state.station.revision,
      redeemedReservationIds: ['reservation-1', 'reservation-2'] });
    state = insert(state, 'late-player', 6, 110);
    expect(state.station.nextRoundId).toBe('round-6');
    expect(state.rounds['round-6']?.recruitingEndsAt).toBeNull();
    state = completeStationMatch(state, { at: at(200), expectedRevision: state.station.revision });
    state = advanceStationResults(state, { nextRoundId: 'round-next', at: at(210), configVersion: 1,
      expectedRevision: state.station.revision });
    expect(state.station).toMatchObject({ phase: 'RECRUITING', activeRoundId: 'round-6', nextRoundId: null });
    expect(stationReadyEntries(state, 'round-6').map(entry => entry.id)).toEqual(['ready-3', 'ready-4', 'ready-5', 'ready-6']);
    expect(state.rounds['round-6']?.recruitingEndsAt).toBe(at(245));
    state = closeStationRecruiting(state, { at: at(220), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'monsters', matchId: 'match-2', engineRoomCode: '4821',
      at: at(221), expectedRevision: state.station.revision });
    expect(state.matches['match-2']?.participantReadyEntryIds).toEqual(['ready-3','ready-4']);
  });

  it('advances delayed results with immediately due safe deadlines', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 5; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, {
      game: 'racer', matchId: 'match-1', engineRoomCode: '4821', at: at(91),
      expectedRevision: state.station.revision,
    });
    state = requestStationLaunch(state, { at: at(101), expectedRevision: state.station.revision });
    state = markStationDisplayReady(state, { at: at(102), expectedRevision: state.station.revision });
    state = markStationMatchStarted(state, { at: at(103), expectedRevision: state.station.revision,
      redeemedReservationIds: ['reservation-1', 'reservation-2'] });
    state = completeStationMatch(state, { at: at(200), expectedRevision: state.station.revision });

    state = advanceStationResults(state, { nextRoundId: 'round-next', at: at(400), configVersion: 1,
      expectedRevision: state.station.revision });

    expect(state.station).toMatchObject({ phase: 'RECRUITING', activeRoundId: 'round-next' });
    expect(state.rounds['round-next']).toMatchObject({
      firstCoinAt: at(400), recruitingEndsAt: at(400), hardEndsAt: at(400),
    });
    state = closeStationRecruiting(state, { at: at(400), expectedRevision: state.station.revision });
    expect(state.station.phase).toBe('GAME_SELECTION');
  });

  it('rejects reducer timing with post-game recruiting after the hard deadline', () => {
    const state = createArcadeStation('ARCADE-01', T0);
    expect(() => insertStationCoin(state, {
      readyEntryId: 'ready-1', roundId: 'round-1', playerId: 'player-1',
      reservationId: 'reservation-1', at: at(1), configVersion: 1,
      expectedRevision: state.station.revision,
    }, {
      recruitingSeconds: 15,
      hardDeadlineSeconds: 44,
      selectionSeconds: 30,
      lockedSeconds: 10,
      postGameRecruitingSeconds: 45,
    })).toThrow(/hard deadline must not precede post-game recruiting deadline/);
  });

  it('accepts Trivia and rejects malformed cross-record state', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, {
      game: 'trivia', matchId: 'match-1', engineRoomCode: '4821', at: at(91),
      expectedRevision: state.station.revision,
    });
    expect(state.station.activeGame).toBe('trivia');
    expect(() => assertStationInvariants({
      ...state,
      station: { ...state.station, activeRoundId: 'missing' },
    })).toThrow(/active round does not exist/);
  });

  it('rejects stale revisions, backdated actions, and colliding next-round IDs', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    expect(() => insertStationCoin(state, {
      readyEntryId: 'ready-stale', roundId: 'round-stale', playerId: 'player-stale',
      reservationId: 'reservation-stale', at: at(2), configVersion: 1, expectedRevision: 1,
    })).toThrow(/revision changed/);
    expect(() => closeStationRecruiting(state, {
      at: at(0), expectedRevision: state.station.revision,
    })).toThrow(/precedes station chronology/);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    expect(() => insertStationCoin(state, {
      readyEntryId: 'ready-2', roundId: 'round-1', playerId: 'player-2',
      reservationId: 'reservation-2', at: at(91), configVersion: 1,
      expectedRevision: state.station.revision,
    })).toThrow(/round ID already exists/);
  });

  it('requires exact redeemed reservations before gameplay', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'racer', matchId: 'match-1', engineRoomCode: '4821',
      at: at(91), expectedRevision: state.station.revision });
    state = requestStationLaunch(state, { at: at(101), expectedRevision: state.station.revision });
    state = markStationDisplayReady(state, { at: at(102), expectedRevision: state.station.revision });
    expect(() => markStationMatchStarted(state, { at: at(103), expectedRevision: state.station.revision,
      redeemedReservationIds: [] })).toThrow(/must be redeemed/);
    state = markStationMatchStarted(state, { at: at(103), expectedRevision: state.station.revision,
      redeemedReservationIds: ['reservation-1'] });
    expect(state.readyEntries['ready-1']?.status).toBe('PLAYING');
  });

  it('restores reservations to the ready pool after launch failure and allows overflow leave', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 5; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'racer', matchId: 'match-1', engineRoomCode: '4821',
      at: at(91), expectedRevision: state.station.revision });
    state = leaveStationReadyEntry(state, {
      readyEntryId: 'ready-5', at: at(92), expectedRevision: state.station.revision,
    });
    expect(state.readyEntries['ready-5']?.status).toBe('LEFT');
    state = requestStationLaunch(state, { at: at(101), expectedRevision: state.station.revision });
    state = failStationLaunch(state, { at: at(102), expectedRevision: state.station.revision });
    expect(state.station).toMatchObject({ phase: 'RECRUITING', activeMatchId: null, activeGame: null });
    expect(['ready-1','ready-2','ready-3','ready-4'].map(id => state.readyEntries[id]?.status))
      .toEqual(['READY','READY','READY','READY']);
    expect(state.matches['match-1']?.phase).toBe('FAILED');
    state = closeStationRecruiting(state, { at: at(150), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'racer', matchId: 'match-2', engineRoomCode: '4821',
      at: at(151), expectedRevision: state.station.revision });
    expect(state.matches['match-2']?.participantReadyEntryIds).toEqual(['ready-1','ready-2']);
  });

  it('deep-freezes records restored from JSON and uses deterministic equal-time FIFO', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-b', 2, 1);
    state = insertStationCoin(state, {
      readyEntryId: 'ready-a', roundId: 'ignored-round', playerId: 'player-a',
      reservationId: 'reservation-a', at: at(1), configVersion: 1,
      expectedRevision: state.station.revision,
    });
    const restored = JSON.parse(JSON.stringify(state)) as ArcadeStationAggregate;
    const next = insert(restored, 'player-c', 3, 2);
    expect(Object.isFrozen(next.rounds['round-2'])).toBe(true);
    expect(Object.isFrozen(next.readyEntries['ready-a'])).toBe(true);
    expect(stationReadyEntries(next, 'round-2').map(entry => entry.id)).toEqual(['ready-2','ready-a','ready-3']);
  });

  it('returns to attract when the last recruiting player leaves', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    state = leaveStationReadyEntry(state, {
      readyEntryId: 'ready-1', at: at(2), expectedRevision: state.station.revision,
    });
    expect(state.station).toMatchObject({ phase: 'ATTRACT', activeRoundId: null });
    expect(state.rounds['round-1']).toMatchObject({ phase: 'CLOSED', closedAt: at(2) });
  });

  it('returns to attract when the last player leaves during game selection', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = leaveStationReadyEntry(state, {
      readyEntryId: 'ready-1', at: at(91), expectedRevision: state.station.revision,
    });
    expect(state.station).toMatchObject({ phase: 'ATTRACT', activeRoundId: null });
    expect(state.rounds['round-1']).toMatchObject({ phase: 'CLOSED', closedAt: at(91) });
  });

  it('promotes overflow when an existing next round emptied before results', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 5; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'racer', matchId: 'match-1', engineRoomCode: '4821',
      at: at(91), expectedRevision: state.station.revision });
    state = requestStationLaunch(state, { at: at(101), expectedRevision: state.station.revision });
    state = markStationDisplayReady(state, { at: at(102), expectedRevision: state.station.revision });
    state = markStationMatchStarted(state, { at: at(103), expectedRevision: state.station.revision,
      redeemedReservationIds: ['reservation-1','reservation-2'] });
    state = insert(state, 'late-player', 6, 110);
    state = leaveStationReadyEntry(state, {
      readyEntryId: 'ready-6', at: at(111), expectedRevision: state.station.revision,
    });
    expect(state.station.nextRoundId).toBeNull();
    state = completeStationMatch(state, { at: at(200), expectedRevision: state.station.revision });
    state = advanceStationResults(state, { nextRoundId: 'round-next', at: at(201), configVersion: 1,
      expectedRevision: state.station.revision });
    expect(state.station).toMatchObject({ phase: 'RECRUITING', activeRoundId: 'round-next' });
    expect(stationReadyEntries(state, 'round-next').map(entry => entry.id)).toEqual(['ready-3','ready-4','ready-5']);
  });

  it('requires display-ready acknowledgement before start', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'racer', matchId: 'match-1', engineRoomCode: '4821',
      at: at(91), expectedRevision: state.station.revision });
    state = requestStationLaunch(state, { at: at(101), expectedRevision: state.station.revision });
    expect(() => markStationMatchStarted(state, { at: at(102), expectedRevision: state.station.revision,
      redeemedReservationIds: ['reservation-1'] })).toThrow(/display must acknowledge/);
  });

  it('promotes a waiting next pool when recovered active players all leave', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 4; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'racer', matchId: 'match-1', engineRoomCode: '4821',
      at: at(91), expectedRevision: state.station.revision });
    state = requestStationLaunch(state, { at: at(101), expectedRevision: state.station.revision });
    state = insert(state, 'late-player', 5, 102);
    state = failStationLaunch(state, { at: at(103), expectedRevision: state.station.revision });
    for (let index = 1; index <= 4; index++) {
      state = leaveStationReadyEntry(state, {
        readyEntryId: `ready-${index}`, at: at(103 + index), expectedRevision: state.station.revision,
      });
    }
    expect(state.station).toMatchObject({
      phase: 'RECRUITING', activeRoundId: 'round-5', nextRoundId: null,
    });
    expect(stationReadyEntries(state, 'round-5').map(entry => entry.id)).toEqual(['ready-5']);
    expect(state.matches['match-1']?.participantReadyEntryIds).toEqual(['ready-1','ready-2']);
  });

  it('rejects persisted match phases without required timestamp evidence', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'racer', matchId: 'match-1', engineRoomCode: '4821',
      at: at(91), expectedRevision: state.station.revision });
    state = requestStationLaunch(state, { at: at(101), expectedRevision: state.station.revision });
    state = markStationDisplayReady(state, { at: at(102), expectedRevision: state.station.revision });
    state = markStationMatchStarted(state, { at: at(103), expectedRevision: state.station.revision,
      redeemedReservationIds: ['reservation-1'] });
    expect(() => assertStationInvariants({
      ...state,
      matches: { ...state.matches, 'match-1': { ...state.matches['match-1']!, launchRequestedAt: null } },
    })).toThrow(/lacks timestamp evidence/);
  });

  it('rejects attract stations with stranded next pools and regressed chronology', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    expect(() => assertStationInvariants({
      ...state,
      station: { ...state.station, phase: 'ATTRACT', activeRoundId: null, nextRoundId: 'round-1' },
    })).toThrow(/attract station has active state/);
    expect(() => assertStationInvariants({
      ...state,
      station: { ...state.station, updatedAt: T0 },
    })).toThrow(/follows station updatedAt/);

    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'racer', matchId: 'match-1', engineRoomCode: '4821',
      at: at(91), expectedRevision: state.station.revision });
    expect(() => assertStationInvariants({
      ...state,
      rounds: { ...state.rounds, 'round-1': { ...state.rounds['round-1']!, lockedAt: at(89) } },
    })).toThrow(/phase chronology is invalid/);
  });

  it('rejects orphan live reservations and underfilled admission with overflow', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    state = insert(state, 'player-1', 1);
    expect(() => assertStationInvariants({
      ...state,
      station: { ...state.station, phase: 'ATTRACT', activeRoundId: null },
      rounds: { ...state.rounds, 'round-1': { ...state.rounds['round-1']!, phase: 'CLOSED', closedAt: at(1) } },
    })).toThrow(/live ready entry is not reachable|attract station has active state/);

    state = insert(state, 'player-2', 2);
    state = insert(state, 'player-3', 3);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'fighter', matchId: 'match-1', engineRoomCode: '4821',
      at: at(91), expectedRevision: state.station.revision });
    const match = state.matches['match-1']!;
    expect(() => assertStationInvariants({
      ...state,
      readyEntries: {
        ...state.readyEntries,
        'ready-2': { ...state.readyEntries['ready-2']!, status: 'OVERFLOW', overflowOrdinal: 1 },
      },
      matches: {
        ...state.matches,
        'match-1': {
          ...match,
          participantReadyEntryIds: ['ready-1'],
          overflowReadyEntryIds: ['ready-2','ready-3'],
        },
      },
    })).toThrow(/admission count does not match capacity/);
  });

  it('rejects active-match entries from the next round and omitted active-round members', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 3; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, { game: 'fighter', matchId: 'match-1', engineRoomCode: '4821',
      at: at(91), expectedRevision: state.station.revision });
    const match = state.matches['match-1']!;
    expect(() => assertStationInvariants({
      ...state,
      readyEntries: {
        ...state.readyEntries,
        'ready-3': { ...state.readyEntries['ready-3']!, roundId: 'round-next' },
      },
      rounds: {
        ...state.rounds,
        'round-next': { ...state.rounds['round-1']!, id: 'round-next', firstCoinAt: at(91),
          phase: 'RECRUITING', selectionStartedAt: null, selectionEndsAt: null, lockedAt: null,
          lockedEndsAt: null, selectedGame: null },
      },
      station: { ...state.station, nextRoundId: 'round-next' },
    })).toThrow(/another round|next round contains non-ready/);

    expect(() => assertStationInvariants({
      ...state,
      readyEntries: {
        ...state.readyEntries,
        'ready-extra': { ...state.readyEntries['ready-3']!, id: 'ready-extra', playerId: 'player-extra',
          reservationId: 'reservation-extra', status: 'READY', overflowOrdinal: null },
      },
      matches: { ...state.matches, 'match-1': match },
    })).toThrow(/membership differs from match/);
  });

  it('drops an admitted no-show, promotes FIFO overflow, and renews an active launch window', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 5; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, {
      game: 'racer', matchId: 'match-no-show', engineRoomCode: 'DROP-ROOM', at: at(91),
      expectedRevision: state.station.revision,
    });
    state = requestStationLaunch(state, { at: at(92), expectedRevision: state.station.revision });
    state = dropStationAdmittedEntry(state, {
      readyEntryId: 'ready-2', at: at(93), expectedRevision: state.station.revision,
    });
    expect(state.readyEntries['ready-2']?.status).toBe('LEFT');
    expect(state.matches['match-no-show']?.participantReadyEntryIds)
      .toEqual(['ready-1', 'ready-3']);
    expect(state.readyEntries['ready-3']).toMatchObject({ status: 'ADMITTED', overflowOrdinal: null });
    expect(state.matches['match-no-show']?.overflowReadyEntryIds).toEqual(['ready-4', 'ready-5']);
    expect(state.matches['match-no-show']).toMatchObject({ launchGeneration: 2, launchRequestedAt: at(93) });
    expect(() => assertStationInvariants(state)).not.toThrow();
  });

  it('replaces the only admitted Karaoke no-show when overflow exists', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 3; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, {
      game: 'karaoke', matchId: 'karaoke-no-show', engineRoomCode: 'SING', at: at(91),
      expectedRevision: state.station.revision,
    });
    state = requestStationLaunch(state, { at: at(92), expectedRevision: state.station.revision });

    state = dropStationAdmittedEntry(state, {
      readyEntryId: 'ready-1', at: at(93), expectedRevision: state.station.revision,
    });

    expect(state.matches['karaoke-no-show']?.participantReadyEntryIds).toEqual(['ready-2']);
    expect(state.matches['karaoke-no-show']?.overflowReadyEntryIds).toEqual(['ready-3']);
    expect(state.readyEntries['ready-2']).toMatchObject({ status: 'ADMITTED', overflowOrdinal: null });
    expect(() => assertStationInvariants(state)).not.toThrow();
  });

  it('fills the exact vacated player slot without changing a connected player side', () => {
    let state = createArcadeStation('ARCADE-01', T0);
    for (let index = 1; index <= 3; index++) state = insert(state, `player-${index}`, index);
    state = closeStationRecruiting(state, { at: at(90), expectedRevision: state.station.revision });
    state = selectStationGame(state, {
      game: 'monsters', matchId: 'slot-match', engineRoomCode: 'SLOT', at: at(91),
      expectedRevision: state.station.revision,
    });
    state = requestStationLaunch(state, { at: at(92), expectedRevision: state.station.revision });
    state = dropStationAdmittedEntry(state, {
      readyEntryId: 'ready-1', at: at(93), expectedRevision: state.station.revision,
    });

    expect(state.matches['slot-match']?.participantReadyEntryIds).toEqual(['ready-3', 'ready-2']);
    expect(state.matches['slot-match']?.overflowReadyEntryIds).toEqual([]);
    expect(() => assertStationInvariants(state)).not.toThrow();
  });
});
