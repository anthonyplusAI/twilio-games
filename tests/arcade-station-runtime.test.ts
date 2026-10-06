import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, parseArcadeConfig } from '../shared/arcade-config';
import {
  ArcadeEventHub,
  createArcadeConfigUpdatedEvent,
  createArcadeStationUpdatedEvent,
} from '../server/arcade-events';
import { ArcadeService } from '../server/arcade-service';
import { ArcadeStateStore } from '../server/arcade-state-store';
import { ArcadeStationRuntime, chooseStationGame } from '../server/arcade-station-runtime';

const directories: string[] = [];
const T0 = Date.parse('2026-07-20T10:00:00.000Z');
const TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
const AUTHORIZATION = Object.freeze({ trusted: true });
const OPERATOR_AUTHORIZATION = Object.freeze({ operator: true });

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function harness(configure?: (input: Record<string, any>) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcade-station-runtime-'));
  directories.push(directory);
  const store = await ArcadeStateStore.open(path.join(directory, 'state.json'));
  const input = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  input.arcade.mode = 'coin_only';
  input.coins.startingBalance = 2;
  configure?.(input);
  const config = parseArcadeConfig(input);
  const events = new ArcadeEventHub();
  let now = T0;
  let enabled = true;
  let sequence = 0;
  let scheduled: { handle: NodeJS.Timeout; callback: () => void; delayMs: number } | null = null;
  const removedMatches: Array<{ game: string; roomCode: string; removal: 'retire'|'abort' }> = [];
  const participantUpdates: Array<{
    game: string;
    roomCode: string;
    count: number;
    activeEnginePlayerIds: readonly string[];
    participantSlots: readonly (string | null)[];
  }> = [];
  const runtimeErrors: unknown[] = [];
  const service = new ArcadeService({
    store,
    config,
    clock: () => now,
    idGenerator: kind => `${kind}-${++sequence}`,
    challengeTokenSecret: TOKEN_SECRET,
    operatorAuthorizer: authorization => authorization === AUTHORIZATION
      ? { kind: 'system', subject: 'runtime:test' }
      : authorization === OPERATOR_AUTHORIZATION
        ? { kind: 'operator', subject: 'operator@twilio.com' }
        : null,
    stationUpdated: revision => events.publish(createArcadeStationUpdatedEvent(revision)),
  });
  const makeRuntime = () => new ArcadeStationRuntime({
    service,
    events,
    stationId: () => 'expo',
    systemAuthorization: () => AUTHORIZATION,
    enabled: () => enabled,
    config: () => config,
    clock: () => now,
    setTimer: (callback, delayMs) => {
      const handle = setTimeout(() => undefined, 2_147_483_647);
      handle.unref();
      scheduled = { handle, callback, delayMs };
      return handle;
    },
    clearTimer: handle => {
      clearTimeout(handle);
      if (scheduled?.handle === handle) scheduled = null;
    },
    onMatchRemoved: (game, roomCode, removal) => removedMatches.push({ game, roomCode, removal }),
    onMatchParticipantsChanged: (game, roomCode, count, activeEnginePlayerIds, participantSlots) => {
      participantUpdates.push({ game, roomCode, count, activeEnginePlayerIds, participantSlots });
    },
    onError: error => runtimeErrors.push(error),
  });
  return {
    store,
    service,
    makeRuntime,
    setTime: (value: number) => { now = value; },
    setEnabled: (value: boolean) => {
      enabled = value;
      events.publish(createArcadeConfigUpdatedEvent(value ? 3 : 2));
    },
    scheduled: () => scheduled,
    removedMatches,
    participantUpdates,
    runtimeErrors,
    fire: () => {
      const current = scheduled;
      if (!current) throw new Error('no station timer is scheduled');
      clearTimeout(current.handle);
      scheduled = null;
      current.callback();
    },
  };
}

describe('ArcadeStationRuntime', () => {
  it('keeps active setup alive with a bounded inactivity window without marking gameplay started', async () => {
    const h=await harness();
    await h.service.identifyCoinOnly({playerId:'p1',idempotencyKey:'setup-grace-identify'});
    const inserted=await h.service.insertStationCoin({stationId:'expo',playerId:'p1',idempotencyKey:'setup-grace-coin'});
    const runtime=h.makeRuntime();await runtime.start();
    const selecting=await h.service.closeStationRecruiting({stationId:'expo',expectedRevision:inserted.station.revision,idempotencyKey:'setup-grace-close',authorization:AUTHORIZATION});
    const locked=await h.service.selectStationGame({stationId:'expo',expectedRevision:selecting.station.revision,game:'racer',engineRoomCode:'SETUP-GRACE',idempotencyKey:'setup-grace-select',authorization:AUTHORIZATION});
    const launching=await h.service.requestStationLaunch({stationId:'expo',expectedRevision:locked.station.revision,idempotencyKey:'setup-grace-launch',authorization:AUTHORIZATION});
    await runtime.flush();
    h.setTime(T0+119_000);
    runtime.markParticipantConnected(launching.match!.participantReadyEntryIds[0]!,'engine-p1');
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('LAUNCHING');
    expect(h.scheduled()?.delayMs).toBe(120_000);

    h.setTime(T0+120_500);h.fire();await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('LAUNCHING');
    expect(h.scheduled()?.delayMs).toBe(118_500);

    h.setTime(T0+230_000);runtime.markSetupActivity(launching.match!.participantReadyEntryIds[0]!);await runtime.flush();
    expect(h.scheduled()?.delayMs).toBe(120_000);
    h.setTime(T0+239_001);h.fire();await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('LAUNCHING');
    h.setTime(T0+350_001);h.fire();await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RECRUITING');
    expect(h.removedMatches).toEqual([{game:'racer',roomCode:'SETUP-GRACE',removal:'abort'}]);
  });

  it('rearms a two-caller launch from either connected player setup activity',async()=>{
    const h=await harness();
    for(const playerId of ['p1','p2']){
      await h.service.identifyCoinOnly({playerId,idempotencyKey:`two-activity-identify:${playerId}`});
      await h.service.insertStationCoin({stationId:'expo',playerId,idempotencyKey:`two-activity-coin:${playerId}`});
    }
    const runtime=h.makeRuntime();await runtime.start();
    const recruiting=await h.service.getStation('expo');
    const selecting=await h.service.closeStationRecruiting({stationId:'expo',expectedRevision:recruiting!.station.revision,idempotencyKey:'two-activity-close',authorization:AUTHORIZATION});
    const locked=await h.service.selectStationGame({stationId:'expo',expectedRevision:selecting.station.revision,game:'racer',engineRoomCode:'TWO-ACTIVE',idempotencyKey:'two-activity-select',authorization:AUTHORIZATION});
    const launching=await h.service.requestStationLaunch({stationId:'expo',expectedRevision:locked.station.revision,idempotencyKey:'two-activity-launch',authorization:AUTHORIZATION});
    const[first,second]=launching.match!.participantReadyEntryIds;
    runtime.markParticipantConnected(first!,'engine-p1');runtime.markParticipantConnected(second!,'engine-p2');await runtime.flush();
    h.setTime(T0+110_000);runtime.markSetupActivity(second!);await runtime.flush();
    expect(h.scheduled()?.delayMs).toBe(120_000);
    h.setTime(T0+121_000);h.fire();await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('LAUNCHING');
  });

  it('updates the live engine player gate when an admitted no-show has no replacement', async () => {
    const h = await harness();
    for (const playerId of ['p1', 'p2', 'p3']) {
      await h.service.identifyCoinOnly({ playerId, idempotencyKey: `identify:${playerId}` });
      await h.service.insertStationCoin({ stationId: 'expo', playerId, idempotencyKey: `coin:${playerId}` });
    }
    const recruiting = await h.service.getStation('expo');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'drop-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, game: 'racer',
      engineRoomCode: 'DROP', idempotencyKey: 'drop-select', authorization: AUTHORIZATION,
    });
    const runtime = h.makeRuntime();
    const firstDropInput = {
      readyEntryId: locked.match!.participantReadyEntryIds[1]!,
      expectedRevision: locked.station.revision,
      idempotencyKey: 'drop-with-replacement', authorization: OPERATOR_AUTHORIZATION,
      reason: 'first caller left before launch',
    };
    const firstDrop = await runtime.dropAdmittedEntry(firstDropInput);
    await runtime.dropAdmittedEntry({
      readyEntryId: firstDrop.match!.participantReadyEntryIds[1]!,
      expectedRevision: firstDrop.station.revision,
      idempotencyKey: 'drop-no-replacement', authorization: OPERATOR_AUTHORIZATION,
      reason: 'replacement caller also left before launch',
    });

    expect(h.participantUpdates).toEqual([
      {game:'racer',roomCode:'DROP',count:2,activeEnginePlayerIds:[],participantSlots:[null,null]},
      {game:'racer',roomCode:'DROP',count:1,activeEnginePlayerIds:[],participantSlots:[null]},
    ]);
    h.participantUpdates.length = 0;
    await runtime.dropAdmittedEntry(firstDropInput);
    expect(h.participantUpdates).toEqual([{
      game:'racer',roomCode:'DROP',count:1,activeEnginePlayerIds:[],participantSlots:[null],
    }]);
  });

  it('recovers an overdue recruiting deadline and advances later deadlines deterministically', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    h.setTime(T0 + 91_000);
    const runtime = h.makeRuntime();

    await runtime.start();
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('GAME_SELECTION');
    expect(h.scheduled()?.delayMs).toBe(29_000);

    h.setTime(T0 + 122_000);
    h.fire();
    await runtime.flush();
    expect(await h.service.getStation('expo')).toMatchObject({
      station: { phase: 'LOCKED', activeGame: 'racer' },
    });
    expect(h.scheduled()?.delayMs).toBe(8_000);

    h.setTime(T0 + 133_000);
    h.fire();
    await runtime.flush();
    const launching = await h.service.getStation('expo');
    expect(launching?.station.phase).toBe('LAUNCHING');
    expect(h.scheduled()?.delayMs).toBe(117_000);

    await runtime.markEngineStarted('racer', launching!.matches[launching!.station.activeMatchId!]!.engineRoomCode);
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('LAUNCHING');
    const activeMatch = launching!.matches[launching!.station.activeMatchId!]!;
    runtime.markParticipantConnected(activeMatch.participantReadyEntryIds[0]!);
    await runtime.markDisplayReady({
      matchId: activeMatch.id,
      launchGeneration: activeMatch.launchGeneration,
      expectedRevision: launching!.station.revision,
      idempotencyKey: 'display-ready',
    });
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('PLAYING');

    await runtime.markEngineCompleted('racer', activeMatch.engineRoomCode);
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RESULTS');
    expect(h.scheduled()?.delayMs).toBe(10_000);
    h.setTime(T0 + 144_000);
    h.fire();
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('ATTRACT');
    expect(h.removedMatches).toContainEqual({game:'racer',roomCode:activeMatch.engineRoomCode,removal:'retire'});
    await runtime.stop();
  });

  it('rebuilds its wakeup from persisted deadlines after restart', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const first = h.makeRuntime();
    await first.start();
    await first.flush();
    expect(h.scheduled()?.delayMs).toBe(90_000);
    await first.stop();

    h.setTime(T0 + 100_000);
    const restarted = h.makeRuntime();
    await restarted.start();
    await restarted.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('GAME_SELECTION');
    expect(h.scheduled()?.delayMs).toBe(20_000);
    await restarted.stop();
  });

  it('yields deeply overdue recovery instead of failing runtime initialization', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'stale-identify' });
    await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'stale-coin' });
    h.setTime(T0 + 30 * 60_000);
    const runtime = h.makeRuntime();

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(h.runtimeErrors).toEqual([]);
    expect((await h.service.getStation('expo'))!.station.revision).toBeGreaterThan(1);
    await runtime.stop();
  });

  it('cancels deadlines and does not advance station phases while paused', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'pause-timer-identify' });
    await h.service.insertStationCoin({
      stationId: 'expo', playerId: 'p1', idempotencyKey: 'pause-timer-coin',
    });
    const runtime = h.makeRuntime();
    await runtime.start();
    expect(h.scheduled()?.delayMs).toBe(90_000);

    h.setEnabled(false);
    await runtime.flush();
    expect(h.scheduled()).toBeNull();
    h.setTime(T0 + 121_000);
    h.setEnabled(false);
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RECRUITING');
    expect(h.scheduled()).toBeNull();

    h.setEnabled(true);
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('LOCKED');
    expect(h.scheduled()?.delayMs).toBe(9_000);
    await runtime.stop();
  });

  it('does not start a ready launch while paused but still handles an explicit terminal event', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'pause-launch-identify' });
    const coin = await h.service.insertStationCoin({
      stationId: 'expo', playerId: 'p1', idempotencyKey: 'pause-launch-coin',
    });
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision,
      idempotencyKey: 'pause-launch-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision,
      idempotencyKey: 'pause-launch-select', authorization: AUTHORIZATION,
      game: 'racer', engineRoomCode: 'PAUSED-LAUNCH',
    });
    const pausedLaunch = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision,
      idempotencyKey: 'pause-launch-request', authorization: AUTHORIZATION,
    });
    h.setEnabled(false);
    const runtime = h.makeRuntime();
    await runtime.start();
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('LAUNCHING');
    expect((await h.service.getWalletStatus('p1'))).toMatchObject({ reservedBalance: 1, availableBalance: 1 });
    await runtime.markDisplayReady({
      matchId: pausedLaunch.match!.id,
      launchGeneration: pausedLaunch.match!.launchGeneration,
      expectedRevision: pausedLaunch.station.revision,
      idempotencyKey: 'pause-launch-display-ready',
    });
    await runtime.markEngineStarted('racer', 'PAUSED-LAUNCH');
    runtime.markParticipantConnected(pausedLaunch.match!.participantReadyEntryIds[0]!);
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('LAUNCHING');
    expect(h.scheduled()).toBeNull();

    await runtime.markEngineAbandoned('racer', 'PAUSED-LAUNCH');
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RECRUITING');
    await runtime.stop();
  });

  it('does not wedge an overdue recruiting timer after a later coin updates station chronology', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    h.setTime(T0 + 91_000);
    await h.service.identifyCoinOnly({ playerId: 'p2', idempotencyKey: 'identify:p2' });
    const later = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p2', idempotencyKey: 'coin:p2' });
    expect(later.readyEntry.roundId).not.toBe((await h.service.getStation('expo'))?.station.activeRoundId);
    const runtime = h.makeRuntime();

    await runtime.start();
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('GAME_SELECTION');
    expect(h.scheduled()?.delayMs).toBe(30_000);
    await runtime.stop();
  });

  it('returns an interrupted launch to recruiting without losing the hold', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });

    const restarted = h.makeRuntime();
    await restarted.start();
    await restarted.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RECRUITING');
    expect((await h.service.getWalletStatus('p1'))?.reservedBalance).toBe(1);
    expect(h.removedMatches).toEqual([{ game: 'racer', roomCode: '4821', removal: 'abort' }]);
    await restarted.stop();
  });

  it('reconciles a reset event by cancelling launch work and forgetting the old engine room', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'reset-identify:p1' });
    const coin = await h.service.insertStationCoin({
      stationId: 'expo', playerId: 'p1', idempotencyKey: 'reset-coin:p1',
    });
    const runtime = h.makeRuntime();
    await runtime.start();
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision,
      idempotencyKey: 'reset-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision,
      idempotencyKey: 'reset-select', authorization: AUTHORIZATION,
      game: 'racer', engineRoomCode: 'RESET-4821',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision,
      idempotencyKey: 'reset-launch', authorization: AUTHORIZATION,
    });
    await runtime.markEngineStarted('racer', 'RESET-4821');
    runtime.markParticipantConnected(launching.match!.participantReadyEntryIds[0]!);
    await runtime.flush();
    expect(h.scheduled()).not.toBeNull();

    await h.service.resetStation({
      stationId: 'expo', expectedRevision: launching.station.revision,
      idempotencyKey: 'reset-emergency', authorization: OPERATOR_AUTHORIZATION,
      reason: 'cabinet emergency stop',
    });
    await runtime.flush();

    expect((await h.service.getStation('expo'))?.station.phase).toBe('ATTRACT');
    expect(h.scheduled()).toBeNull();
    expect((await h.service.getWalletStatus('p1'))).toMatchObject({ reservedBalance: 0, availableBalance: 2 });
    await runtime.markEngineCompleted('racer', 'RESET-4821');
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('ATTRACT');
    await runtime.stop();
  });

  it('fails a launch when the engine ends before every participant connects', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const runtime = h.makeRuntime();
    await runtime.start();
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    await runtime.markEngineCompleted('racer', '4821');
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RECRUITING');
    expect((await h.service.getWalletStatus('p1'))).toMatchObject({ reservedBalance: 1, availableBalance: 1 });
    expect(h.removedMatches).toEqual([{ game: 'racer', roomCode: '4821', removal: 'abort' }]);
    await runtime.stop();
  });

  it('fails an overdue launch instead of starting from late readiness signals', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const runtime = h.makeRuntime();
    await runtime.start();
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    await runtime.markDisplayReady({
      matchId: launching.match!.id,
      launchGeneration: launching.match!.launchGeneration,
      expectedRevision: launching.station.revision,
      idempotencyKey: 'late-display-ready',
    });
    h.setTime(T0 + 121_000);
    runtime.markParticipantConnected(launching.match!.participantReadyEntryIds[0]!);
    await runtime.markEngineStarted('racer', '4821');
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RECRUITING');
    expect(h.removedMatches).toEqual([{ game: 'racer', roomCode: '4821', removal: 'abort' }]);
    await runtime.stop();
  });

  it('automatically replaces a launch-time no-show with FIFO overflow', async () => {
    const h = await harness();
    for (let index = 1; index <= 5; index++) {
      await h.service.identifyCoinOnly({ playerId: `p${index}`, idempotencyKey: `identify:p${index}` });
      await h.service.insertStationCoin({ stationId: 'expo', playerId: `p${index}`, idempotencyKey: `coin:p${index}` });
    }
    const runtime = h.makeRuntime();await runtime.start();await runtime.flush();
    const aggregate = await h.service.getStation('expo');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: aggregate!.station.revision, idempotencyKey: 'auto-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'auto-select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: 'AUTO',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'auto-launch', authorization: AUTHORIZATION,
    });
    await runtime.markDisplayReady({
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      expectedRevision: launching.station.revision, idempotencyKey: 'auto-ready',
    });
    const admitted=launching.match!.participantReadyEntryIds;
    runtime.markParticipantConnected(admitted[0]!);
    runtime.markParticipantConnected(admitted[1]!);
    await runtime.flush();
    runtime.markParticipantDisconnected(admitted[1]!);
    expect(h.scheduled()?.delayMs).toBe(120_000);
    h.setTime(T0+121_000);h.fire();await runtime.flush();
    const replaced=await h.service.getStation('expo');
    expect(h.runtimeErrors).toEqual([]);
    expect(replaced?.station.phase).toBe('LAUNCHING');
    expect(Object.values(replaced!.readyEntries).filter(entry=>entry.status==='LEFT').map(entry=>entry.id))
      .toEqual([admitted[1]]);
    expect(replaced?.matches[replaced.station.activeMatchId!]!.participantReadyEntryIds)
      .toContain(launching.match!.overflowReadyEntryIds[0]);
    expect(replaced?.matches[replaced.station.activeMatchId!]!.launchGeneration).toBe(2);
    expect(h.participantUpdates.at(-1)).toEqual({
      game:'racer',roomCode:'AUTO',count:2,activeEnginePlayerIds:[`legacy:${admitted[0]}`],
      participantSlots:[`legacy:${admitted[0]}`,null],
    });
    expect(h.scheduled()?.delayMs).toBe(120_000);
    h.setTime(T0+240_000);
    runtime.markParticipantConnected(launching.match!.overflowReadyEntryIds[0]!);
    await runtime.flush();
    expect(h.scheduled()?.delayMs).toBe(120_000);
    await runtime.stop();
  });

  it('projects indexed slots through middle replacement and later capacity shrink', async () => {
    const h = await harness();
    for (let index = 1; index <= 5; index++) {
      await h.service.identifyCoinOnly({ playerId: `slot-p${index}`, idempotencyKey: `slot-identify:${index}` });
      await h.service.insertStationCoin({
        stationId: 'expo', playerId: `slot-p${index}`, idempotencyKey: `slot-coin:${index}`,
      });
    }
    const runtime = h.makeRuntime();
    await runtime.start();
    await runtime.flush();
    const recruiting = await h.service.getStation('expo');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'slot-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision,
      idempotencyKey: 'slot-select', authorization: AUTHORIZATION,
      game: 'trivia', engineRoomCode: 'SLOT-PROJECTION',
    });
    const original = locked.match!.participantReadyEntryIds;
    expect(original).toHaveLength(4);
    original.forEach((readyEntryId, index) => runtime.markParticipantConnected(readyEntryId, `engine-${index}`));
    await runtime.flush();

    runtime.markParticipantDisconnected(original[1]!);
    const replaced = await runtime.dropAdmittedEntry({
      readyEntryId: original[1]!, expectedRevision: locked.station.revision,
      idempotencyKey: 'slot-replace-middle', authorization: OPERATOR_AUTHORIZATION,
      reason: 'replace middle no-show',
    });
    expect(h.participantUpdates.at(-1)).toEqual({
      game: 'trivia', roomCode: 'SLOT-PROJECTION', count: 4,
      activeEnginePlayerIds: ['engine-0', 'engine-2', 'engine-3'],
      participantSlots: ['engine-0', null, 'engine-2', 'engine-3'],
    });

    runtime.markParticipantDisconnected(original[0]!);
    await runtime.dropAdmittedEntry({
      readyEntryId: original[0]!, expectedRevision: replaced.station.revision,
      idempotencyKey: 'slot-shrink-with-pending', authorization: OPERATOR_AUTHORIZATION,
      reason: 'shrink while replacement is pending',
    });
    expect(h.participantUpdates.at(-1)).toEqual({
      game: 'trivia', roomCode: 'SLOT-PROJECTION', count: 3,
      activeEnginePlayerIds: ['engine-2', 'engine-3'],
      participantSlots: [null, 'engine-2', 'engine-3'],
    });
    await runtime.stop();
  });

  it('replays a terminal engine event after a transient state transaction failure', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const runtime = h.makeRuntime();
    await runtime.start();
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    const ready = await h.service.markStationDisplayReady({
      stationId: 'expo', expectedRevision: launching.station.revision, idempotencyKey: 'ready',
      authorization: AUTHORIZATION, matchId: launching.match!.id,
      launchGeneration: launching.match!.launchGeneration,
    });
    await h.service.startStationMatch({
      stationId: 'expo', expectedRevision: ready.station.revision, idempotencyKey: 'start', authorization: AUTHORIZATION,
    });
    await runtime.flush();
    const transaction = h.store.transaction.bind(h.store);
    let failNextTransaction = true;
    h.store.transaction = async mutation => {
      if (failNextTransaction) {
        failNextTransaction = false;
        throw new Error('temporary persistence failure');
      }
      return transaction(mutation);
    };
    await expect(runtime.markEngineCompleted('racer', '4821')).rejects.toThrow('temporary persistence failure');
    expect((await h.service.getStation('expo'))?.station.phase).toBe('PLAYING');
    expect(h.scheduled()?.delayMs).toBe(1_000);
    h.setTime(T0 + 1_000);
    h.fire();
    await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RESULTS');
    await runtime.stop();
  });

  it('correlates Racer results after a participant reconnects with a new engine identity', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const runtime = h.makeRuntime();
    await runtime.start();
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    const readyEntryId = launching.match!.participantReadyEntryIds[0]!;
    const ready = await h.service.markStationDisplayReady({
      stationId: 'expo', expectedRevision: launching.station.revision, idempotencyKey: 'ready',
      authorization: AUTHORIZATION, matchId: launching.match!.id,
      launchGeneration: launching.match!.launchGeneration,
    });
    await h.service.startStationMatch({
      stationId: 'expo', expectedRevision: ready.station.revision, idempotencyKey: 'start',
      authorization: AUTHORIZATION, enginePlayerIdsByReadyEntryId: { [readyEntryId]: 'engine-old' },
    });
    runtime.markParticipantConnected(readyEntryId, 'engine-new');
    await runtime.markEngineCompleted('racer', '4821', [{
      enginePlayerId: 'engine-new', rank: 1, completed: true, won: true, score: 100, durationSeconds: 12,
    }]);
    const completed = await h.service.getStation('expo');
    expect(completed?.station.phase).toBe('RESULTS');
    expect(completed?.matches[completed.station.activeMatchId!]?.result?.participants[0]).toMatchObject({
      readyEntryId, enginePlayerId: 'engine-old', rank: 1, completed: true, score: 100,
    });
    await runtime.stop();
  });

  it('refunds an interrupted playing match during restart recovery', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    const coin = await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision, idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'expo', expectedRevision: selecting.station.revision, idempotencyKey: 'select',
      authorization: AUTHORIZATION, game: 'racer', engineRoomCode: '4821',
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'expo', expectedRevision: locked.station.revision, idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    const ready = await h.service.markStationDisplayReady({
      stationId: 'expo', expectedRevision: launching.station.revision, idempotencyKey: 'ready',
      authorization: AUTHORIZATION, matchId: launching.match!.id,
      launchGeneration: launching.match!.launchGeneration,
    });
    await h.service.startStationMatch({
      stationId: 'expo', expectedRevision: ready.station.revision, idempotencyKey: 'start', authorization: AUTHORIZATION,
    });

    const restarted = h.makeRuntime();
    await restarted.start();
    await restarted.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('RESULTS');
    expect((await h.service.getWalletStatus('p1'))).toMatchObject({
      reservedBalance: 0, availableBalance: 2,
    });
    expect(h.scheduled()?.delayMs).toBe(10_000);
    const recovered=await h.service.getStation('expo');
    await h.service.holdStationResults({stationId:'expo',expectedRevision:recovered!.station.revision,idempotencyKey:'hold-results',authorization:AUTHORIZATION,reason:'hold for review'});
    await restarted.flush();
    expect(h.scheduled()).toBeNull();
    await restarted.stop();
  });

  it('uses configured timings and enabled-game fixed priority', async () => {
    const h = await harness(input => {
      input.station.timings.recruitingSeconds = 20;
      input.station.timings.hardDeadlineSeconds = 25;
      input.station.timings.postGameRecruitingSeconds = 20;
      input.station.games.racer.enabled = false;
      input.station.automaticSelection.policy = 'fixed_priority';
      input.station.automaticSelection.order = ['fighter', 'monsters', 'racer', 'karaoke', 'trivia', 'chess'];
    });
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'identify:p1' });
    await h.service.insertStationCoin({ stationId: 'expo', playerId: 'p1', idempotencyKey: 'coin:p1' });
    const runtime = h.makeRuntime();
    await runtime.start();
    await runtime.flush();
    expect(h.scheduled()?.delayMs).toBe(20_000);
    h.setTime(T0 + 21_000);h.fire();await runtime.flush();
    expect((await h.service.getStation('expo'))?.station.phase).toBe('GAME_SELECTION');
    h.setTime(T0 + 52_000);h.fire();await runtime.flush();
    expect(await h.service.getStation('expo')).toMatchObject({
      station: { phase: 'LOCKED', activeGame: 'fighter' },
    });
    await runtime.stop();
  });

  it('selects Chess when moved to first priority and skips it when disabled', async () => {
    for (const chessEnabled of [true, false]) {
      const h = await harness(input => {
        input.station.timings.recruitingSeconds = 20;
        input.station.timings.hardDeadlineSeconds = 25;
        input.station.timings.postGameRecruitingSeconds = 20;
        input.station.games.chess.enabled = chessEnabled;
        input.station.automaticSelection.policy = 'fixed_priority';
        input.station.automaticSelection.order = [
          'chess', 'fighter', 'monsters', 'racer', 'karaoke', 'trivia',
        ];
      });
      await h.service.identifyCoinOnly({
        playerId: 'p1', idempotencyKey: `identify:chess-priority:${chessEnabled}`,
      });
      await h.service.insertStationCoin({
        stationId: 'expo', playerId: 'p1', idempotencyKey: `coin:chess-priority:${chessEnabled}`,
      });
      const runtime = h.makeRuntime();
      await runtime.start();
      h.setTime(T0 + 21_000); h.fire(); await runtime.flush();
      expect((await h.service.getStation('expo'))?.station.phase).toBe('GAME_SELECTION');
      if (!chessEnabled) {
        await expect(h.service.recordStationGameChoice({
          stationId: 'expo', playerId: 'p1', game: 'chess', idempotencyKey: 'disabled-chess-vote',
        })).rejects.toMatchObject({ code: 'GAME_DISABLED' });
      }
      h.setTime(T0 + 52_000); h.fire(); await runtime.flush();
      expect((await h.service.getStation('expo'))?.station).toMatchObject({
        phase: 'LOCKED', activeGame: chessEnabled ? 'chess' : 'fighter',
      });
      await runtime.stop();
    }
  });

  it('resolves vote leaders and applies automatic policy only across tied enabled games', async () => {
    const h = await harness();
    for (const playerId of ['p1', 'p2', 'p3']) {
      await h.service.identifyCoinOnly({ playerId, idempotencyKey: `vote-identify:${playerId}` });
      await h.service.insertStationCoin({ stationId: 'expo', playerId, idempotencyKey: `vote-coin:${playerId}` });
    }
    const recruiting = await h.service.getStation('expo');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'vote-close', authorization: AUTHORIZATION,
    });
    expect(chooseStationGame((await h.service.getStation('expo'))!)).toBe('trivia');
    await h.service.recordStationGameChoice({
      stationId: 'expo', playerId: 'p1', game: 'racer', idempotencyKey: 'vote-p1',
    });
    await h.service.recordStationGameChoice({
      stationId: 'expo', playerId: 'p2', game: 'racer', idempotencyKey: 'vote-p2-racer',
    });
    const fixed = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
    fixed.station.automaticSelection.policy = 'fixed_priority';
    fixed.station.automaticSelection.order = ['fighter', 'monsters', 'racer', 'karaoke', 'trivia', 'chess'];
    const fixedConfig = parseArcadeConfig(fixed);
    expect(chooseStationGame((await h.service.getStation('expo'))!, fixedConfig.station)).toBe('racer');

    await h.service.recordStationGameChoice({
      stationId: 'expo', playerId: 'p2', game: 'fighter', idempotencyKey: 'vote-p2-fighter',
    });
    expect(chooseStationGame((await h.service.getStation('expo'))!, fixedConfig.station)).toBe('fighter');

    const retryState=(await h.service.getStation('expo'))!;
    const failedRacer={...retryState,matches:{...retryState.matches,failed:{
      game:'racer',phase:'FAILED',roundId:retryState.station.activeRoundId,
    }}} as unknown as typeof retryState;
    expect(chooseStationGame(failedRacer,fixedConfig.station)).toBe('racer');

    const tied = (await h.service.getStation('expo'))!;
    const withPreviousMonsters = {
      ...tied,
      matches: {
        ...tied.matches,
        historical: { game: 'monsters' },
      },
    } as unknown as typeof tied;
    fixed.station.automaticSelection.order = ['racer', 'monsters', 'fighter', 'karaoke', 'trivia', 'chess'];
    fixed.station.automaticSelection.policy = 'round_robin';
    const roundRobin = parseArcadeConfig(fixed);
    expect(chooseStationGame(withPreviousMonsters, roundRobin.station)).toBe('fighter');

    fixed.station.automaticSelection.policy = 'best_fit_rotation';
    const bestFit = parseArcadeConfig(fixed);
    expect(chooseStationGame(tied, bestFit.station)).toBe('racer');

    fixed.station.games.fighter.enabled = false;
    const disabled = parseArcadeConfig(fixed);
    expect(chooseStationGame((await h.service.getStation('expo'))!, disabled.station)).toBe('racer');
    expect(selecting.station.phase).toBe('GAME_SELECTION');
  });

  it('rejects a late vote racing an overdue selection timer before resolving the game', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'p1', idempotencyKey: 'race-identify:p1' });
    const coin = await h.service.insertStationCoin({
      stationId: 'expo', playerId: 'p1', idempotencyKey: 'race-coin:p1',
    });
    await h.service.closeStationRecruiting({
      stationId: 'expo', expectedRevision: coin.station.revision,
      idempotencyKey: 'race-close', authorization: AUTHORIZATION,
    });
    const runtime = h.makeRuntime();
    await runtime.start();
    expect(h.scheduled()?.delayMs).toBe(30_000);
    h.setTime(T0 + 30_001);
    const lateVote = h.service.recordStationGameChoice({
      stationId: 'expo', playerId: 'p1', game: 'fighter', idempotencyKey: 'race-late-vote',
    });
    h.fire();
    await expect(lateVote).rejects.toMatchObject({ code: 'SELECTION_CLOSED' });
    await runtime.flush();
    expect(await h.service.getStation('expo')).toMatchObject({
      station: { phase: 'LOCKED', activeGame: 'racer' },
    });
    await runtime.stop();
  });
});
