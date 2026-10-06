import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ARCADE_CONFIG, parseArcadeConfig, type ArcadeConfigSnapshot } from '../shared/arcade-config';
import { ArcadeService } from '../server/arcade-service';
import { ArcadeStateStore } from '../server/arcade-state-store';

const directories: string[] = [];
const AUTHORIZATION = Object.freeze({ trusted: true });
const TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
const EN_CONTENT_SID = `HX${'a'.repeat(32)}`;
const PT_CONTENT_SID = `HX${'b'.repeat(32)}`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcade-outbound-service-'));
  directories.push(directory);
  const statePath = path.join(directory, 'state.json');
  const store = await ArcadeStateStore.open(statePath);
  let config = stationConfig('coin_only');
  let now = Date.parse('2026-07-21T10:00:00.000Z');
  let sequence = 0;
  const service = new ArcadeService({
    store,
    config: () => config,
    clock: () => now++,
    idGenerator: kind => `${kind}-${++sequence}`,
    challengeTokenSecret: TOKEN_SECRET,
    operatorAuthorizer: value => value === AUTHORIZATION
      ? { kind: 'system', subject: 'outbound-test' }
      : null,
    stationNotifications: {
      enabled: () => true,
      callNumber: () => '+14155550100',
      whatsappContentSid: (_kind, locale) => locale === 'pt-BR' ? PT_CONTENT_SID : EN_CONTENT_SID,
    },
  });
  return {
    store,
    statePath,
    service,
    setMode: (mode: 'off' | 'coin_only') => { config = stationConfig(mode); },
    setVoice: (enabled: boolean, numbers: { 'en-US': string | null; 'pt-BR': string | null }) => {
      const value = JSON.parse(JSON.stringify(config)) as Record<string, any>;
      value.channels.voice = enabled;
      value.channels.voiceNumbers = numbers;
      config = parseArcadeConfig(value);
    },
    enableKaraoke: () => {
      const value = JSON.parse(JSON.stringify(config)) as Record<string, any>;
      value.station.games.karaoke.enabled = true;
      config = parseArcadeConfig(value);
    },
  };
}

function stationConfig(mode: 'off' | 'coin_only'): ArcadeConfigSnapshot {
  const value = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  value.arcade.mode = mode;
  value.coins.startingBalance = 1;
  value.channels.voiceNumbers = {
    'en-US': '+14155550100',
    'pt-BR': '+551155555555',
  };
  value.channels.whatsapp = true;
  value.postGame.enabled = false;
  value.postGame.channels = [];
  value.postGame.includeChallenges = true;
  value.earning.challenges = [{
    id: 'voice-docs', title: 'Voice docs', message: 'Visit the Voice docs to earn another coin.',
    url: 'https://www.twilio.com/docs/voice', rewardCoins: 1, enabled: true,
    maxClaimsPerPlayer: 1, displayOrder: 0, startsAt: null, endsAt: null,
  }];
  return parseArcadeConfig(value);
}

function providerKey(sid: string): string {
  return `provider:${createHash('sha256').update(sid).digest('hex')}`;
}

async function inbound(
  service: ArcadeService,
  sid: string,
  body: string,
  from: string,
  channel: 'sms' | 'whatsapp' = 'sms',
) {
  return service.processInboundStationMessage({
    channel,
    normalizedAddress: from,
    providerAddress: channel === 'whatsapp' ? `whatsapp:${from}` : from,
    providerMessageId: sid,
    body,
    stationId: 'ARCADE-01',
    preferredLocale: body.includes('pt-BR') ? 'pt-BR' : 'en-US',
    idempotencyKey: providerKey(sid),
  });
}

async function createThreeReadyPlayers(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  const names = ['Alice', 'Bruna', 'Carla'];
  for (const [index, locale] of ['en-US', 'pt-BR', 'pt-BR'].entries()) {
    const from = `+1415555010${index + 1}`;
    const channel = 'whatsapp';
    await inbound(h.service, `SM-JOIN-${index}`, `JOIN ARCADE-01 LANG ${locale}`, from,channel);
    await inbound(h.service, `SM-NAME-${index}`, names[index]!, from,channel);
    await inbound(h.service, `SM-TERMS-${index}`, locale === 'pt-BR' ? 'SIM' : 'YES', from,channel);
    const ready = await inbound(
      h.service, `SM-COIN-${index}`, locale === 'pt-BR' ? 'MOEDA' : 'COIN', from,channel,
    );
    if (index === 0) expect(ready.reply).toContain("we'll text you a number to call");
  }
}

describe('Arcade station outbound outbox', () => {
  it('atomically queues admitted, overflow, call-now, results, and promoted-next notices', async () => {
    const h = await harness();
    await createThreeReadyPlayers(h);
    const activePlayerId = Object.values(h.store.snapshot().channelAddresses)[0]!.playerId;
    await expect(h.service.restorePlayerStartingBalance({
      playerId: activePlayerId, expectedConfigVersion: 1, idempotencyKey: 'restore-active-player',
      authorization: AUTHORIZATION, reason: 'should be blocked',
    })).rejects.toMatchObject({ code: 'PLAYER_ACTIVE_ADMISSION' });
    const recruiting = await h.service.getStation('ARCADE-01');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'close', authorization: AUTHORIZATION,
    });
    const selectionInput = {
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'fighter' as const, engineRoomCode: '4821', idempotencyKey: 'select',
      authorization: AUTHORIZATION,
    };
    const locked = await h.service.selectStationGame(selectionInput);
    await expect(h.service.selectStationGame(selectionInput)).resolves.toEqual(locked);

    expect(Object.values(h.store.snapshot().outboundNotifications).map(item => item.kind).sort())
      .toEqual(['STATION_ADMITTED', 'STATION_ADMITTED', 'STATION_OVERFLOW']);
    expect(Object.keys(h.store.snapshot().stationReadyChannels)).toHaveLength(3);
    expect(Object.values(h.store.snapshot().outboundNotifications)
      .find(item => item.kind === 'STATION_OVERFLOW')?.body).toContain('próximo jogo');

    const launching = await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'launch', authorization: AUTHORIZATION,
    });
    const callNow = Object.values(h.store.snapshot().outboundNotifications)
      .filter(item => item.kind === 'STATION_CALL_NOW');
    const englishWhatsapp=callNow.find(item=>item.locale==='en-US')!;
    expect(englishWhatsapp.body).toContain('Call +14155550100 with your device Phone app');
    expect(englishWhatsapp.callNumber).toBe('+14155550100');
    expect(englishWhatsapp.templateVariables).toEqual({'1':'Voice Fighter'});
    expect(englishWhatsapp.templateContentSid).toBe(EN_CONTENT_SID);
    const whatsappCall=callNow.find(item=>item.channel==='whatsapp'&&item.locale==='pt-BR')!;
    expect(whatsappCall.body).toContain('Ligue para +551155555555 usando o app Telefone');
    expect(whatsappCall.callNumber).toBe('+551155555555');
    expect(whatsappCall.templateVariables).toEqual({'1':'Luta por Voz'});
    expect(whatsappCall.templateContentSid).toBe(PT_CONTENT_SID);
    const displayReady = await h.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: 'display-ready', authorization: AUTHORIZATION,
    });
    const playing = await h.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: displayReady.station.revision,
      idempotencyKey: 'start', authorization: AUTHORIZATION,
    });
    const results = await h.service.completeStationMatch({
      stationId: 'ARCADE-01', expectedRevision: playing.station.revision,
      idempotencyKey: 'complete', authorization: AUTHORIZATION,
    });
    const resultNotice = Object.values(h.store.snapshot().outboundNotifications)
      .find(item => item.kind === 'STATION_RESULTS' && item.locale === 'en-US')!;
    expect(resultNotice.body).toContain('Voice Fighter complete!');
    expect(resultNotice.body).not.toContain('controlled the big screen');
    expect(resultNotice.body).toContain('\n\nCheck the scoreboard on the display.');
    expect(resultNotice.body).toContain('Reply MORE to complete a challenge');
    expect(resultNotice.templateVariables).toEqual({ '1': 'Voice Fighter' });
    expect(Object.values(h.store.snapshot().outboundNotifications)
      .filter(item => item.kind === 'STATION_RESULTS' && item.channel === 'whatsapp')
      .every(item => item.templateContentSid === null)).toBe(true);
    const recovery = await h.service.listPlayersNeedingCoins();
    const restorable = recovery.players.filter(player => player.canRestoreStartingBalance);
    expect(recovery.startingBalance).toBe(1);
    expect(restorable).toMatchObject([{ availableBalance: 0 }, { availableBalance: 0 }]);
    expect(JSON.stringify(recovery)).not.toContain('+1415555010');
    const target = restorable[0]!;
    const restoreInput = {
      playerId: target.playerId, expectedConfigVersion: recovery.configVersion,
      idempotencyKey: 'restore-zero-player', authorization: AUTHORIZATION, reason: 'help attendee replay',
    };
    const restored = await h.service.restorePlayerStartingBalance(restoreInput);
    expect(restored).toMatchObject({ restored: true, amountGranted: 1, targetBalance: 1, availableBalance: 1 });
    expect(await h.service.restorePlayerStartingBalance(restoreInput)).toEqual(restored);
    await expect(h.service.restorePlayerStartingBalance({ ...restoreInput, idempotencyKey: 'restore-zero-player-again' }))
      .rejects.toMatchObject({ code: 'PLAYER_BALANCE_CHANGED' });
    const restoredWallet = h.store.snapshot().wallets[target.playerId]!;
    expect(restoredWallet.transactions.filter(transaction => transaction.type === 'operator_grant')).toEqual([
      expect.objectContaining({ delta: 1, metadata: expect.objectContaining({
        action: 'restore_starting_balance', reason: 'help attendee replay',
        configuredStartingBalance: 1, previousAvailableBalance: 0,
      }) }),
    ]);
    expect((await h.service.listPlayersNeedingCoins()).players.filter(player => player.canRestoreStartingBalance)).toHaveLength(1);
    await h.service.advanceStationResults({
      stationId: 'ARCADE-01', expectedRevision: results.station.revision,
      idempotencyKey: 'advance', authorization: AUTHORIZATION,
    });

    const kinds = Object.values(h.store.snapshot().outboundNotifications).map(item => item.kind).sort();
    expect(kinds).toEqual([
      'STATION_ADMITTED', 'STATION_ADMITTED', 'STATION_CALL_NOW', 'STATION_CALL_NOW',
      'STATION_NEXT_GAME', 'STATION_OVERFLOW', 'STATION_RESULTS', 'STATION_RESULTS',
    ].sort());
    expect(new Set(Object.values(h.store.snapshot().outboundNotifications).map(item => item.id)).size).toBe(8);
  });

  it('keeps SMS call-now notices on the locale-specific E.164 number',async()=>{
    const h=await harness(),from='+14155550999';
    await inbound(h.service,'SMS-CALL-JOIN','JOIN ARCADE-01 LANG en-US',from,'sms');
    await inbound(h.service,'SMS-CALL-NAME','Ada',from,'sms');
    await inbound(h.service,'SMS-CALL-TERMS','YES',from,'sms');
    await inbound(h.service,'SMS-CALL-COIN','COIN',from,'sms');
    const recruiting=await h.service.getStation('ARCADE-01');
    const selecting=await h.service.closeStationRecruiting({stationId:'ARCADE-01',expectedRevision:recruiting!.station.revision,idempotencyKey:'sms-call-close',authorization:AUTHORIZATION});
    const locked=await h.service.selectStationGame({stationId:'ARCADE-01',expectedRevision:selecting.station.revision,game:'racer',engineRoomCode:'SMS',idempotencyKey:'sms-call-select',authorization:AUTHORIZATION});
    await h.service.requestStationLaunch({stationId:'ARCADE-01',expectedRevision:locked.station.revision,idempotencyKey:'sms-call-launch',authorization:AUTHORIZATION});
    const callNow=Object.values(h.store.snapshot().outboundNotifications).find(item=>item.kind==='STATION_CALL_NOW')!;
    expect(callNow.channel).toBe('sms');expect(callNow.body).toContain('+14155550100');
    expect(callNow.templateVariables['1']).toBe('+14155550100');
  });

  it('migrates the routed number from persisted schema-v8 call-now variables',async()=>{
    const h=await harness(),from='+14155550998';
    await inbound(h.service,'MIGRATE-CALL-JOIN','JOIN ARCADE-01 LANG en-US',from,'whatsapp');
    await inbound(h.service,'MIGRATE-CALL-NAME','Ada',from,'whatsapp');
    await inbound(h.service,'MIGRATE-CALL-TERMS','YES',from,'whatsapp');
    await inbound(h.service,'MIGRATE-CALL-COIN','COIN',from,'whatsapp');
    const recruiting=await h.service.getStation('ARCADE-01');
    const selecting=await h.service.closeStationRecruiting({stationId:'ARCADE-01',expectedRevision:recruiting!.station.revision,idempotencyKey:'migrate-call-close',authorization:AUTHORIZATION});
    const locked=await h.service.selectStationGame({stationId:'ARCADE-01',expectedRevision:selecting.station.revision,game:'racer',engineRoomCode:'MIGRATE',idempotencyKey:'migrate-call-select',authorization:AUTHORIZATION});
    await h.service.requestStationLaunch({stationId:'ARCADE-01',expectedRevision:locked.station.revision,idempotencyKey:'migrate-call-launch',authorization:AUTHORIZATION});
    const legacy=JSON.parse(await readFile(h.statePath,'utf8')) as Record<string,any>;
    legacy.schemaVersion=8;
    for(const notification of Object.values(legacy.outboundNotifications) as Record<string,any>[]){
      delete notification.callNumber;
      if(notification.kind==='STATION_CALL_NOW')notification.templateVariables={'1':'+14155550100','2':'Voice Racer'};
    }
    await writeFile(h.statePath,JSON.stringify(legacy));
    const migrated=await ArcadeStateStore.open(h.statePath);
    expect(Object.values(migrated.snapshot().outboundNotifications).find(item=>item.kind==='STATION_CALL_NOW')?.callNumber)
      .toBe('+14155550100');
  });

  it('includes each Racer place and time in one idempotent result summary', async () => {
    const h = await harness();
    await createThreeReadyPlayers(h);
    const recruiting = await h.service.getStation('ARCADE-01');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'racer-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: 'RACE', idempotencyKey: 'racer-select', authorization: AUTHORIZATION,
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'racer-launch', authorization: AUTHORIZATION,
    });
    const displayReady = await h.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: 'racer-display', authorization: AUTHORIZATION,
    });
    const participantIds = displayReady.match!.participantReadyEntryIds;
    const enginePlayerIdsByReadyEntryId = Object.fromEntries(participantIds.map((readyEntryId, index) => [readyEntryId, `racer-${index + 1}`]));
    const playing = await h.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: displayReady.station.revision,
      idempotencyKey: 'racer-start', authorization: AUTHORIZATION, enginePlayerIdsByReadyEntryId,
    });
    const completionInput = {
      stationId: 'ARCADE-01', expectedRevision: playing.station.revision,
      idempotencyKey: 'racer-complete', authorization: AUTHORIZATION, resultSource: 'ENGINE' as const,
      engineResults: participantIds.map((readyEntryId, index) => ({
        enginePlayerId: enginePlayerIdsByReadyEntryId[readyEntryId]!, rank: index + 1,
        completed: true, won: index === 0, score: null, durationSeconds: index === 0 ? 12.34 : 15.67 + index,
      })),
    };
    const results = await h.service.completeStationMatch(completionInput);
    await expect(h.service.completeStationMatch(completionInput)).resolves.toEqual(results);

    const resultNotices = Object.values(h.store.snapshot().outboundNotifications)
      .filter(item => item.kind === 'STATION_RESULTS');
    const englishResult = resultNotices.find(item => item.locale === 'en-US')!;
    expect(englishResult.body).toContain('YOU WON! You finished #1.');
    expect(englishResult.body).toContain('Race time: 12.34 seconds.');
    const portugueseResult = resultNotices.find(item => item.locale === 'pt-BR' && item.body.includes('2º lugar'))!;
    expect(portugueseResult.body).toContain('Tempo da corrida: 16,67 segundos.');
    expect(resultNotices).toHaveLength(2);
  });

  it.each([
    {
      locale: 'en-US', from: '+14155550801', language: 'en-US', name: 'Ada', terms: 'YES', coin: 'COIN',
      expected: 'Your score: 54321.', forbidden: 'finished #1', gameName: 'Voice Karaoke',
    },
    {
      locale: 'pt-BR', from: '+551155555801', language: 'pt-BR', name: 'Bia', terms: 'SIM', coin: 'MOEDA',
      expected: 'Sua pontuação: 54321.', forbidden: '1º lugar', gameName: 'Karaokê por Voz',
    },
  ])('sends a Karaoke score instead of solo placement copy in $locale', async row => {
    const h = await harness();
    h.enableKaraoke();
    await inbound(h.service, `KARAOKE-${row.locale}-JOIN`, `JOIN ARCADE-01 LANG ${row.language}`, row.from, 'whatsapp');
    await inbound(h.service, `KARAOKE-${row.locale}-NAME`, row.name, row.from, 'whatsapp');
    await inbound(h.service, `KARAOKE-${row.locale}-TERMS`, row.terms, row.from, 'whatsapp');
    await inbound(h.service, `KARAOKE-${row.locale}-COIN`, row.coin, row.from, 'whatsapp');
    const recruiting = await h.service.getStation('ARCADE-01');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: `karaoke-${row.locale}-close`, authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'karaoke', engineRoomCode: `SING-${row.locale}`, idempotencyKey: `karaoke-${row.locale}-select`,
      authorization: AUTHORIZATION,
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: `karaoke-${row.locale}-launch`, authorization: AUTHORIZATION,
    });
    const displayReady = await h.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: `karaoke-${row.locale}-display`, authorization: AUTHORIZATION,
    });
    const readyEntryId = displayReady.match!.participantReadyEntryIds[0]!;
    const enginePlayerId = `singer-${row.locale}`;
    const playing = await h.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: displayReady.station.revision,
      idempotencyKey: `karaoke-${row.locale}-start`, authorization: AUTHORIZATION,
      enginePlayerIdsByReadyEntryId: { [readyEntryId]: enginePlayerId },
    });
    await h.service.completeStationMatch({
      stationId: 'ARCADE-01', expectedRevision: playing.station.revision,
      idempotencyKey: `karaoke-${row.locale}-complete`, authorization: AUTHORIZATION,
      resultSource: 'ENGINE',
      engineResults: [{
        enginePlayerId, rank: 1, completed: true, won: null, score: 54_321, durationSeconds: 45,
      }],
    });

    const result = Object.values(h.store.snapshot().outboundNotifications)
      .find(item => item.kind === 'STATION_RESULTS')!;
    expect(result.locale).toBe(row.locale);
    expect(result.body).toContain(row.expected);
    expect(result.body).not.toContain(row.forbidden);
    expect(result.templateVariables).toEqual({ '1': row.gameName });
  });

  it.each([
    { locale: 'en-US', outcome: 'win', from: '+14155550811', language: 'en-US', terms: 'YES', coin: 'COIN', won: true,
      expected: 'You won the wizard duel.', gameName: 'Voice Chess' },
    { locale: 'pt-BR', outcome: 'loss', from: '+551155555811', language: 'pt-BR', terms: 'SIM', coin: 'MOEDA', won: false,
      expected: 'O mago rival venceu este duelo.', gameName: 'Xadrez por Voz' },
    { locale: 'en-US', outcome: 'draw', from: '+14155550812', language: 'en-US', terms: 'YES', coin: 'COIN', won: null,
      expected: 'The wizard duel ended in a draw.', gameName: 'Voice Chess' },
    { locale: 'pt-BR', outcome: 'draw', from: '+551155555812', language: 'pt-BR', terms: 'SIM', coin: 'MOEDA', won: null,
      expected: 'Empate no duelo de magos.', gameName: 'Xadrez por Voz' },
  ])('sends a Chess $outcome without a score or placement in $locale', async row => {
    const h = await harness();
    await inbound(h.service, `CHESS-${row.locale}-JOIN`, `JOIN ARCADE-01 LANG ${row.language}`, row.from, 'whatsapp');
    await inbound(h.service, `CHESS-${row.locale}-NAME`, 'Ada', row.from, 'whatsapp');
    await inbound(h.service, `CHESS-${row.locale}-TERMS`, row.terms, row.from, 'whatsapp');
    await inbound(h.service, `CHESS-${row.locale}-COIN`, row.coin, row.from, 'whatsapp');
    const recruiting = await h.service.getStation('ARCADE-01');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: `chess-${row.locale}-close`, authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'chess', engineRoomCode: `CHESS-${row.locale}`, idempotencyKey: `chess-${row.locale}-select`,
      authorization: AUTHORIZATION,
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: `chess-${row.locale}-launch`, authorization: AUTHORIZATION,
    });
    const displayReady = await h.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: `chess-${row.locale}-display`, authorization: AUTHORIZATION,
    });
    const readyEntryId = displayReady.match!.participantReadyEntryIds[0]!;
    const enginePlayerId = `wizard-${row.locale}`;
    const playing = await h.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: displayReady.station.revision,
      idempotencyKey: `chess-${row.locale}-start`, authorization: AUTHORIZATION,
      enginePlayerIdsByReadyEntryId: { [readyEntryId]: enginePlayerId },
    });
    await h.service.completeStationMatch({
      stationId: 'ARCADE-01', expectedRevision: playing.station.revision,
      idempotencyKey: `chess-${row.locale}-complete`, authorization: AUTHORIZATION,
      resultSource: 'ENGINE',
      engineResults: [{ enginePlayerId, rank: 1, completed: true, won: row.won, score: null, durationSeconds: null }],
    });

    const result = Object.values(h.store.snapshot().outboundNotifications)
      .find(item => item.kind === 'STATION_RESULTS')!;
    expect(result.locale).toBe(row.locale);
    expect(result.body).toContain(row.expected);
    expect(result.body).not.toMatch(/score|pontuação|placar|scoreboard|#1|1º lugar/i);
    expect(result.templateVariables).toEqual({ '1': row.gameName });
  });

  it('does not bind or notify a browser-created ready entry', async () => {
    const h = await harness();
    await h.service.identifyCoinOnly({ playerId: 'browser-player', idempotencyKey: 'identify-browser' });
    const ready = await h.service.insertStationCoin({
      stationId: 'ARCADE-01', playerId: 'browser-player', idempotencyKey: 'browser-coin',
    });
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: ready.station.revision,
      idempotencyKey: 'browser-close', authorization: AUTHORIZATION,
    });
    await h.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: '4821', idempotencyKey: 'browser-select',
      authorization: AUTHORIZATION,
    });
    expect(h.store.snapshot().stationReadyChannels).toEqual({});
    expect(h.store.snapshot().outboundNotifications).toEqual({});
  });

  it('suppresses call-now notices when the selected locale has no voice number', async () => {
    const h = await harness();
    h.setVoice(true, { 'en-US': '+14155550100', 'pt-BR': null });
    await inbound(h.service, 'SM-NO-CALL-JOIN', 'JOIN ARCADE-01 LANG pt-BR', '+5511999999999', 'whatsapp');
    await inbound(h.service, 'SM-NO-CALL-NAME', 'Bia', '+5511999999999', 'whatsapp');
    await inbound(h.service, 'SM-NO-CALL-TERMS', 'SIM', '+5511999999999', 'whatsapp');
    await inbound(h.service, 'SM-NO-CALL-COIN', 'MOEDA', '+5511999999999', 'whatsapp');
    const recruiting = await h.service.getStation('ARCADE-01');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'no-call-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: '4821', idempotencyKey: 'no-call-select',
      authorization: AUTHORIZATION,
    });
    await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'no-call-launch', authorization: AUTHORIZATION,
    });
    expect(Object.values(h.store.snapshot().outboundNotifications)
      .some(item => item.kind === 'STATION_CALL_NOW')).toBe(false);
  });

  it('allows off-mode completion without queuing results', async () => {
    const h = await harness();
    await inbound(h.service, 'SM-OFF-JOIN', 'JOIN ARCADE-01 LANG en-US', '+14155550200');
    await inbound(h.service, 'SM-OFF-NAME', 'Ada', '+14155550200');
    await inbound(h.service, 'SM-OFF-TERMS', 'YES', '+14155550200');
    await inbound(h.service, 'SM-OFF-COIN', 'COIN', '+14155550200');
    const recruiting = await h.service.getStation('ARCADE-01');
    const selecting = await h.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'off-close', authorization: AUTHORIZATION,
    });
    const locked = await h.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: '4821', idempotencyKey: 'off-select', authorization: AUTHORIZATION,
    });
    const launching = await h.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'off-launch', authorization: AUTHORIZATION,
    });
    const ready = await h.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: 'off-ready', authorization: AUTHORIZATION,
    });
    const playing = await h.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: ready.station.revision,
      idempotencyKey: 'off-start', authorization: AUTHORIZATION,
    });
    h.setMode('off');
    await h.service.completeStationMatch({
      stationId: 'ARCADE-01', expectedRevision: playing.station.revision,
      idempotencyKey: 'off-complete', authorization: AUTHORIZATION,
    });
    expect(Object.values(h.store.snapshot().outboundNotifications)
      .some(item => item.kind === 'STATION_RESULTS')).toBe(false);
  });
});
