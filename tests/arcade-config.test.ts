import { describe, expect, it } from 'vitest';
import {
  ARCADE_CONFIG_SCHEMA_VERSION,
  ArcadeConfigValidationError,
  DEFAULT_ARCADE_CONFIG,
  createArcadeConfigSnapshot,
  createDefaultArcadeConfig,
  normalizeCountryCode,
  parseArcadeConfig,
  parseArcadeConfigSettings,
  projectPublicArcadeConfig,
  replaceArcadeConfigSettings,
} from '../shared/arcade-config';

function rawConfig(): any {
  return JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG));
}

function rawSettings(): any {
  const { schemaVersion: _schemaVersion, version: _version, updatedAt: _updatedAt, updatedBy: _updatedBy,
    ...settings } = rawConfig();
  return settings;
}

function expectInvalid(candidate: unknown): void {
  expect(() => parseArcadeConfig(candidate)).toThrow(ArcadeConfigValidationError);
}

describe('Twilio Games runtime configuration', () => {
  it('ships revision 1 of the current schema in mode off with the complete approved defaults', () => {
    expect(DEFAULT_ARCADE_CONFIG.schemaVersion).toBe(ARCADE_CONFIG_SCHEMA_VERSION);
    expect(DEFAULT_ARCADE_CONFIG.version).toBe(1);
    expect(DEFAULT_ARCADE_CONFIG.arcade.mode).toBe('off');
    expect(DEFAULT_ARCADE_CONFIG.station).toEqual({
      timings: {
        recruitingSeconds: 90,
        hardDeadlineSeconds: 120,
        selectionSeconds: 30,
        lockedSeconds: 10,
        launchTimeoutSeconds: 120,
        resultsSeconds: 10,
        postGameRecruitingSeconds: 45,
      },
      games: {
        racer: { enabled: true },
        monsters: { enabled: true },
        fighter: { enabled: true },
        karaoke: { enabled: true },
        trivia: { enabled: true },
        chess: { enabled: true },
      },
      comingSoon: {
        trivia: { enabled: false },
      },
      automaticSelection: {
        policy: 'best_fit_rotation',
        order: ['racer', 'monsters', 'fighter', 'karaoke', 'trivia', 'chess'],
      },
      qrRail: 'auto',
    });
    expect(DEFAULT_ARCADE_CONFIG.coins).toMatchObject({
      startingBalance: 1,
      defaultGameCost: 1,
      gameCosts: { racer: 1, monsters: 1, fighter: 1, karaoke: 1, trivia: 1, chess: 1 },
      chargePolicy: 'per_player',
      consumeWhen: 'match_start',
    });
    expect(DEFAULT_ARCADE_CONFIG.queue).toMatchObject({
      maximumWaitingPlayers: 250,
      checkInWindowSeconds: 60,
      baseJoinWindowSeconds: 45,
      readyGraceSeconds: 20,
      hardStartDeadlineSeconds: 90,
    });
    expect(DEFAULT_ARCADE_CONFIG.channels).toEqual({
      voice: true,
      sms: true,
      whatsapp: false,
      voiceNumbers: { 'en-US': null, 'pt-BR': null },
    });
    expect(DEFAULT_ARCADE_CONFIG.postGame.enabled).toBe(false);
    expect(DEFAULT_ARCADE_CONFIG.postGame.channels).toEqual([]);
    expect(DEFAULT_ARCADE_CONFIG.postGame).toMatchObject({
      includeScore: false,
      includeLeaderboard: false,
      includeCoinBalance: true,
      includeChallenges: true,
      includeRematchLink: false,
      includeAchievement: false,
      includeIntelligenceTip: false,
    });
    expect(DEFAULT_ARCADE_CONFIG.intelligence.enabled).toBe(false);
  });

  it('enables Chess in new configs and requires it in each station game list', () => {
    const config = rawConfig();
    expect(config.schemaVersion).toBe(8);
    expect(config.station.games.chess).toEqual({ enabled: true });
    expect(config.station.automaticSelection.order).toEqual([
      'racer', 'monsters', 'fighter', 'karaoke', 'trivia', 'chess',
    ]);
    expect(config.coins.gameCosts.chess).toBe(1);

    delete config.station.games.chess;
    expectInvalid(config);
  });

  it('contains exactly the six approved registration fields and no verification workflow', () => {
    const fields = DEFAULT_ARCADE_CONFIG.registration.fields;
    expect(fields.map(field => field.key)).toEqual([
      'firstName', 'lastName', 'workEmail', 'companyName', 'phoneNumber', 'countryCode',
    ]);
    expect(fields.every(field => field.enabled && field.required)).toBe(true);
    expect(fields.find(field => field.key === 'workEmail')).toMatchObject({ verify: false });
    expect(fields.find(field => field.key === 'phoneNumber')).toMatchObject({ verify: false });
    expect(fields.find(field => field.key === 'countryCode')).toMatchObject({ length: 2 });
    expect(fields.some(field => (field.key as string) === 'jobTitle')).toBe(false);
  });

  it.each(['off', 'coin_only', 'lead_capture'] as const)('accepts mode %s', mode => {
    const candidate = rawConfig();
    candidate.arcade.mode = mode;
    expect(parseArcadeConfig(candidate).arcade.mode).toBe(mode);
  });

  it('accepts every station timing boundary', () => {
    const minimum = rawConfig();
    minimum.station.timings = {
      recruitingSeconds: 15,
      hardDeadlineSeconds: 15,
      selectionSeconds: 5,
      lockedSeconds: 3,
      launchTimeoutSeconds: 10,
      resultsSeconds: 3,
      postGameRecruitingSeconds: 10,
    };
    expect(parseArcadeConfig(minimum).station.timings).toEqual(minimum.station.timings);

    const maximum = rawConfig();
    maximum.station.timings = {
      recruitingSeconds: 600,
      hardDeadlineSeconds: 900,
      selectionSeconds: 180,
      lockedSeconds: 60,
      launchTimeoutSeconds: 180,
      resultsSeconds: 120,
      postGameRecruitingSeconds: 300,
    };
    expect(parseArcadeConfig(maximum).station.timings).toEqual(maximum.station.timings);
  });

  it.each([
    ['recruitingSeconds', 14],
    ['recruitingSeconds', 601],
    ['hardDeadlineSeconds', 14],
    ['hardDeadlineSeconds', 901],
    ['selectionSeconds', 4],
    ['selectionSeconds', 181],
    ['lockedSeconds', 2],
    ['lockedSeconds', 61],
    ['launchTimeoutSeconds', 9],
    ['launchTimeoutSeconds', 181],
    ['resultsSeconds', 2],
    ['resultsSeconds', 121],
    ['postGameRecruitingSeconds', 9],
    ['postGameRecruitingSeconds', 301],
    ['resultsSeconds', 10.5],
  ])('rejects station timing %s value %s', (field, value) => {
    const candidate = rawConfig();
    candidate.station.timings[field] = value;
    expectInvalid(candidate);
  });

  it('requires the station hard deadline to cover recruiting', () => {
    const candidate = rawConfig();
    candidate.station.timings.recruitingSeconds = 121;
    candidate.station.timings.hardDeadlineSeconds = 120;
    expectInvalid(candidate);
  });

  it('orders results, post-game recruiting, and hard deadlines', () => {
    const postGameAfterHard = rawConfig();
    postGameAfterHard.station.timings.postGameRecruitingSeconds = 121;
    postGameAfterHard.station.timings.hardDeadlineSeconds = 120;
    expectInvalid(postGameAfterHard);

    const resultsAfterPostGame = rawConfig();
    resultsAfterPostGame.station.timings.resultsSeconds = 46;
    resultsAfterPostGame.station.timings.postGameRecruitingSeconds = 45;
    expectInvalid(resultsAfterPostGame);

    const coincidentDeadlines = rawConfig();
    coincidentDeadlines.station.timings.recruitingSeconds = 120;
    coincidentDeadlines.station.timings.resultsSeconds = 120;
    coincidentDeadlines.station.timings.postGameRecruitingSeconds = 120;
    coincidentDeadlines.station.timings.hardDeadlineSeconds = 120;
    expect(parseArcadeConfig(coincidentDeadlines).station.timings).toEqual(coincidentDeadlines.station.timings);
  });

  it('requires exact station game settings and an enabled game while arcade mode is on', () => {
    const allDisabled = rawConfig();
    for (const game of ['racer', 'monsters', 'fighter', 'karaoke', 'trivia', 'chess']) allDisabled.station.games[game].enabled = false;
    expect(parseArcadeConfig(allDisabled).station.games.racer.enabled).toBe(false);

    allDisabled.arcade.mode = 'coin_only';
    expectInvalid(allDisabled);

    const fixedRegistry = rawConfig();
    fixedRegistry.station.games.racer.route = '/custom-racer';
    expectInvalid(fixedRegistry);

    const extraGame = rawConfig();
    extraGame.station.games.pong = { enabled: true };
    expectInvalid(extraGame);

    const missingGame = rawConfig();
    delete missingGame.station.games.fighter;
    expectInvalid(missingGame);

    const retiredConcept = rawConfig();
    retiredConcept.station.comingSoon.karaoke = { enabled: true };
    expectInvalid(retiredConcept);

    const revivedTombstone = rawConfig();
    revivedTombstone.station.comingSoon.trivia.enabled = true;
    expect(() => parseArcadeConfig(revivedTombstone)).toThrow(/compatibility tombstone must remain false/);
  });

  it.each(['best_fit_rotation', 'round_robin', 'fixed_priority'] as const)(
    'accepts automatic selection policy %s',
    policy => {
      const candidate = rawConfig();
      candidate.station.automaticSelection.policy = policy;
      candidate.station.automaticSelection.order = ['trivia', 'fighter', 'racer', 'monsters', 'karaoke', 'chess'];
      expect(parseArcadeConfig(candidate).station.automaticSelection).toEqual({
        policy,
        order: ['trivia', 'fighter', 'racer', 'monsters', 'karaoke', 'chess'],
      });
    },
  );

  it('requires every station game exactly once in automatic selection order', () => {
    for (const order of [
      ['racer', 'monsters'],
      ['racer', 'monsters', 'fighter', 'racer'],
      ['racer', 'racer', 'fighter', 'karaoke', 'trivia'],
      ['racer', 'monsters', 'fighter', 'karaoke', 'pong'],
    ]) {
      const candidate = rawConfig();
      candidate.station.automaticSelection.order = order;
      expectInvalid(candidate);
    }

    const policy = rawConfig();
    policy.station.automaticSelection.policy = 'random';
    expectInvalid(policy);

    const rail = rawConfig();
    rail.station.qrRail = 'sometimes';
    expectInvalid(rail);
  });

  it('requires every field and requiredByDefault in lead_capture mode', () => {
    for (const change of [
      (candidate: any) => { candidate.registration.fields[0].enabled = false; candidate.registration.fields[0].required = false; },
      (candidate: any) => { candidate.registration.fields[0].required = false; },
      (candidate: any) => { candidate.registration.requiredByDefault = false; },
    ]) {
      const candidate = rawConfig();
      candidate.arcade.mode = 'lead_capture';
      change(candidate);
      expectInvalid(candidate);
    }
  });

  it('rejects duplicate, missing, extra, and altered registration fields', () => {
    const duplicate = rawConfig();
    duplicate.registration.fields[5] = { ...duplicate.registration.fields[0] };
    expectInvalid(duplicate);

    const missing = rawConfig();
    missing.registration.fields.pop();
    expectInvalid(missing);

    const jobTitle = rawConfig();
    jobTitle.registration.fields[5] = { key: 'jobTitle', enabled: true, required: true };
    expectInvalid(jobTitle);

    const verified = rawConfig();
    verified.registration.fields[2].verify = true;
    expectInvalid(verified);

    const longCountry = rawConfig();
    longCountry.registration.fields[5].length = 3;
    expectInvalid(longCountry);
  });

  it('normalizes safe text and timezone-bearing ISO timestamps', () => {
    const candidate = rawConfig();
    candidate.updatedBy = '  admin@example.com  ';
    candidate.arcade.displayName = '  Cafe\u0301 Arcade  ';
    candidate.earning.challenges = [{
      id: 'voice-docs',
      title: '  Voice docs  ',
      message: '  Visit the Voice docs to earn a coin.  ',
      url: '  https://www.twilio.com/docs/voice  ',
      rewardCoins: 1,
      enabled: true,
      maxClaimsPerPlayer: 1,
      displayOrder: 0,
      startsAt: '2026-07-20T01:00:00-04:00',
      endsAt: '2026-07-20T06:00:00Z',
    }];
    const parsed = parseArcadeConfig(candidate);
    expect(parsed.updatedBy).toBe('admin@example.com');
    expect(parsed.arcade.displayName).toBe('Café Arcade');
    expect(parsed.earning.challenges[0]).toMatchObject({
      title: 'Voice docs',
      message: 'Visit the Voice docs to earn a coin.',
      url: 'https://www.twilio.com/docs/voice',
      startsAt: '2026-07-20T05:00:00.000Z',
      endsAt: '2026-07-20T06:00:00.000Z',
    });
  });

  it('normalizes the country input contract without deciding the UK-to-GB integration question', () => {
    expect(normalizeCountryCode(' us ')).toBe('US');
    expect(normalizeCountryCode('uk')).toBe('UK');
    expect(() => normalizeCountryCode('USA')).toThrow(ArcadeConfigValidationError);
    expect(() => normalizeCountryCode('éx')).toThrow(ArcadeConfigValidationError);
  });

  it('rejects unknown fields at every level', () => {
    const root = rawConfig();
    root.secret = true;
    expectInvalid(root);

    const nested = rawConfig();
    nested.coins.gameCosts.pong = 1;
    expectInvalid(nested);

    const station = rawConfig();
    station.station.timings.launchRoute = '/play.html';
    expectInvalid(station);

    const challenge = rawConfig();
    challenge.earning.challenges = [{
      id: 'docs', title: 'Docs', message: null, url: 'https://twilio.com', rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null, proof: 'none',
    }];
    expectInvalid(challenge);
  });

  it('rejects prototype-polluting keys and unsafe object prototypes', () => {
    const pollutedKey = JSON.stringify(rawConfig()).replace(
      '"displayName":"Twilio Games"',
      '"displayName":"Twilio Games","__proto__":{"polluted":true}',
    );
    expectInvalid(pollutedKey);

    const constructorKey = JSON.stringify(rawConfig()).replace(
      '"voice":true',
      '"voice":true,"constructor":{"prototype":{"polluted":true}}',
    );
    expectInvalid(constructorKey);

    const candidate = rawConfig();
    Object.setPrototypeOf(candidate.queue, { injected: true });
    expectInvalid(candidate);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects malformed JSON and non-object roots', () => {
    expectInvalid('{bad json');
    expectInvalid(null);
    expectInvalid([]);
  });

  it('accepts a complete valid challenge and rejects duplicate IDs', () => {
    const candidate = rawConfig();
    const challenge = {
      id: 'voice-docs', title: 'Explore Voice', message: null, url: 'https://www.twilio.com/docs/voice',
      rewardCoins: 2, enabled: true, maxClaimsPerPlayer: 1, displayOrder: 1,
      startsAt: null, endsAt: null,
    };
    candidate.earning.challenges = [challenge];
    expect(parseArcadeConfig(candidate).earning.challenges[0]).toMatchObject(challenge);
    candidate.earning.challenges.push({ ...challenge, title: 'Duplicate' });
    expectInvalid(candidate);
  });

  it('normalizes optional challenge messages and bounds personalized copy', () => {
    const candidate = rawConfig();
    const challenge = {
      id: 'voice-docs', title: 'Explore Voice', message: '  Visit Voice docs for a coin.  ',
      url: 'https://www.twilio.com/docs/voice', rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    };
    candidate.earning.challenges = [challenge];
    expect(parseArcadeConfig(candidate).earning.challenges[0]?.message).toBe('Visit Voice docs for a coin.');
    candidate.earning.challenges[0].message = 'x'.repeat(301);
    expectInvalid(candidate);
    candidate.earning.challenges[0].message = '';
    expectInvalid(candidate);
    candidate.earning.challenges[0].message = null;
    expect(parseArcadeConfig(candidate).earning.challenges[0]?.message).toBeNull();
  });

  it.each([
    '../admin',
    'Voice_Docs',
    '-voice-docs',
    'voice/docs',
    'constructor',
  ])('rejects unsafe challenge ID %s', id => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id, title: 'Docs', message: null, url: 'https://twilio.com', rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    expectInvalid(candidate);
  });

  it.each([
    'http://www.twilio.com/docs',
    '/relative',
    'javascript:alert(1)',
    'https://user:password@example.com/docs',
  ])('rejects unsafe challenge URL %s', url => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id: 'docs', title: 'Docs', message: null, url, rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    expectInvalid(candidate);
  });

  it('canonicalizes accepted HTTPS destinations with URL.href', () => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id: 'docs', title: 'Docs',
      message: null,
      url: ' https://WWW.TWILIO.COM:443/products/../docs/voice?q=hello world#start ',
      rewardCoins: 1, enabled: true, maxClaimsPerPlayer: 1, displayOrder: 1,
      startsAt: null, endsAt: null,
    }];
    expect(parseArcadeConfig(candidate).earning.challenges[0]!.url).toBe(
      'https://www.twilio.com/docs/voice?q=hello%20world#start',
    );
  });

  it.each([
    'https://localhost/docs',
    'https://arcade.local/docs',
    'https://intranet/docs',
    'https://127.0.0.1/docs',
    'https://127.1/docs',
    'https://10.2.3.4/docs',
    'https://172.16.0.1/docs',
    'https://192.168.1.1/docs',
    'https://169.254.1.1/docs',
    'https://[::1]/docs',
    'https://[fd00::1]/docs',
    'https://[fe80::1]/docs',
    'https://[::ffff:127.0.0.1]/docs',
  ])('rejects loopback, private, or local challenge destination %s', url => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id: 'docs', title: 'Docs', message: null, url, rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    expectInvalid(candidate);
  });

  it.each([
    ['not-a-date', null],
    ['2026-02-30T00:00:00Z', null],
    ['2026-07-20T00:00:00', null],
    ['2026-07-20T02:00:00Z', '2026-07-20T01:00:00Z'],
    ['2026-07-20T01:00:00Z', '2026-07-20T01:00:00Z'],
  ])('rejects invalid challenge schedule %s to %s', (startsAt, endsAt) => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id: 'docs', title: 'Docs', message: null, url: 'https://twilio.com', rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt, endsAt,
    }];
    expectInvalid(candidate);
  });

  it('rejects invalid number ranges and non-integers', () => {
    for (const change of [
      (candidate: any) => { candidate.version = 0; },
      (candidate: any) => { candidate.coins.startingBalance = -1; },
      (candidate: any) => { candidate.coins.defaultGameCost = 1.5; },
      (candidate: any) => { candidate.earning.defaultRewardCoins = 0; },
      (candidate: any) => { candidate.queue.maximumWaitingPlayers = 0; },
      (candidate: any) => { candidate.queue.snoozeSeconds = 86_401; },
    ]) {
      const candidate = rawConfig();
      change(candidate);
      expectInvalid(candidate);
    }
  });

  it.each([
    ['defaultGameCost', null, 0],
    ['defaultGameCost', null, 2],
    ['gameCosts', 'racer', 0],
    ['gameCosts', 'monsters', 2],
    ['gameCosts', 'fighter', 1.5],
    ['gameCosts', 'karaoke', 2],
    ['gameCosts', 'trivia', 2],
  ])('rejects non-one station coin cost %s.%s = %s', (field, game, value) => {
    const candidate = rawConfig();
    if (game === null) candidate.coins[field] = value;
    else candidate.coins[field][game] = value;
    expect(() => parseArcadeConfig(candidate)).toThrow(/must be exactly 1/);
  });

  it('requires a starting coin for paid play while allowing zero in free play', () => {
    const paid = rawConfig();
    paid.coins.startingBalance = 0;
    expect(() => parseArcadeConfig(paid)).toThrow(/must be at least 1 when chargePolicy is per_player/);

    const free = rawConfig();
    free.coins.chargePolicy = 'free';
    free.coins.startingBalance = 0;
    expect(parseArcadeConfig(free).coins).toMatchObject({ chargePolicy: 'free', startingBalance: 0 });
  });

  it('requires coin charging for Messaging Entry and Lead Capture', () => {
    for (const mode of ['coin_only','lead_capture'] as const) {
      const candidate=rawConfig();candidate.arcade.mode=mode;candidate.coins.chargePolicy='free';candidate.coins.startingBalance=0;
      expect(()=>parseArcadeConfig(candidate)).toThrow(/require one coin per player/);
    }
  });

  it('accepts documented milestone maxima and rejects values immediately above them', () => {
    const atLimit = rawConfig();
    atLimit.coins.startingBalance = 100;
    atLimit.earning.defaultRewardCoins = 100;
    atLimit.earning.challenges = [{
      id: 'docs', title: 'Docs', message: null, url: 'https://www.twilio.com/docs', rewardCoins: 100,
      enabled: true, maxClaimsPerPlayer: 100, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    atLimit.queue.maximumWaitingPlayers = 5_000;
    expect(parseArcadeConfig(atLimit)).toMatchObject({
      coins: { startingBalance: 100, defaultGameCost: 1 },
      queue: { maximumWaitingPlayers: 5_000 },
    });

    for (const change of [
      (candidate: any) => { candidate.coins.startingBalance = 101; },
      (candidate: any) => { candidate.earning.defaultRewardCoins = 101; },
      (candidate: any) => { candidate.queue.maximumWaitingPlayers = 5_001; },
      (candidate: any) => {
        candidate.earning.challenges = [{
          id: 'docs', title: 'Docs', message: null, url: 'https://www.twilio.com/docs', rewardCoins: 101,
          enabled: true, maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
        }];
      },
      (candidate: any) => {
        candidate.earning.challenges = [{
          id: 'docs', title: 'Docs', message: null, url: 'https://www.twilio.com/docs', rewardCoins: 1,
          enabled: true, maxClaimsPerPlayer: 101, displayOrder: 1, startsAt: null, endsAt: null,
        }];
      },
    ]) {
      const candidate = rawConfig();
      change(candidate);
      expectInvalid(candidate);
    }
  });

  it('bounds challenge count, post-game channels, identifiers, and display text', () => {
    const challenges = rawConfig();
    challenges.earning.challenges = Array.from({ length: 101 }, (_, index) => ({
      id: `challenge-${index}`, title: `Challenge ${index}`, message: null, url: 'https://www.twilio.com/docs',
      rewardCoins: 1, enabled: true, maxClaimsPerPlayer: 1, displayOrder: index,
      startsAt: null, endsAt: null,
    }));
    expectInvalid(challenges);

    const channels = rawConfig();
    channels.postGame.channels = ['sms', 'whatsapp', 'sms'];
    expectInvalid(channels);

    const cabinetId = rawConfig();
    cabinetId.arcade.cabinetId = 'a'.repeat(65);
    expectInvalid(cabinetId);

    const title = rawConfig();
    title.earning.challenges = [{
      id: 'docs', title: 'a'.repeat(201), message: null, url: 'https://www.twilio.com/docs', rewardCoins: 1,
      enabled: true, maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    expectInvalid(title);

    const challengeId = rawConfig();
    challengeId.earning.challenges = [{
      id: 'a'.repeat(65), title: 'Docs', message: null, url: 'https://www.twilio.com/docs', rewardCoins: 1,
      enabled: true, maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    expectInvalid(challengeId);
  });

  it('rejects timer and no-show relationships that cannot honor the hard deadline', () => {
    for (const change of [
      (candidate: any) => { candidate.queue.checkInWindowSeconds = 91; },
      (candidate: any) => { candidate.queue.baseJoinWindowSeconds = 71; },
      (candidate: any) => { candidate.queue.automaticDeferrals = 2; },
    ]) {
      const candidate = rawConfig();
      change(candidate);
      expectInvalid(candidate);
    }
  });

  it('rejects invalid enum values and duplicate post-game channels', () => {
    const charge = rawConfig();
    charge.coins.chargePolicy = 'per_ai';
    expectInvalid(charge);

    const consume = rawConfig();
    consume.coins.consumeWhen = 'check_in';
    expectInvalid(consume);

    const channels = rawConfig();
    channels.postGame.channels = ['sms', 'sms'];
    expectInvalid(channels);
  });

  it('accepts only implemented post-game delivery options when delivery is enabled', () => {
    const supported = rawConfig();
    supported.postGame.enabled = true;
    supported.postGame.channels = ['sms'];
    supported.postGame.includeChallenges = true;
    expect(parseArcadeConfig(supported).postGame).toMatchObject({
      enabled: true,
      channels: ['sms'],
      includeCoinBalance: true,
      includeChallenges: true,
    });

    for (const field of [
      'includeScore',
      'includeLeaderboard',
      'includeRematchLink',
      'includeAchievement',
      'includeIntelligenceTip',
    ]) {
      const candidate = rawConfig();
      candidate.postGame.enabled = true;
      candidate.postGame.channels = ['sms'];
      candidate.postGame[field] = true;
      expect(() => parseArcadeConfig(candidate)).toThrow(`${field}: is not supported`);
    }
  });

  it('requires enabled post-game delivery to have an enabled messaging channel', () => {
    const empty = rawConfig();
    empty.postGame.enabled = true;
    expect(() => parseArcadeConfig(empty)).toThrow(/must contain at least one channel/);

    const disabledChannel = rawConfig();
    disabledChannel.postGame.enabled = true;
    disabledChannel.postGame.channels = ['whatsapp'];
    expect(() => parseArcadeConfig(disabledChannel)).toThrow(/whatsapp must also be enabled/);
  });

  it('keeps disabled legacy post-game flags loadable without advertising them as active', () => {
    const legacy = rawConfig();
    Object.assign(legacy.postGame, {
      enabled: false,
      includeScore: true,
      includeLeaderboard: true,
      includeChallenges: true,
      includeRematchLink: true,
      includeAchievement: true,
      includeIntelligenceTip: true,
    });
    expect(parseArcadeConfig(legacy).postGame).toMatchObject({ enabled: false, includeScore: true });
  });

  it('accepts only currently modeled charge policies while retaining future-facing types', () => {
    const free = rawConfig();
    free.coins.chargePolicy = 'free';
    expect(parseArcadeConfig(free).coins.chargePolicy).toBe('free');

    for (const policy of ['per_match', 'host_sponsors']) {
      const candidate = rawConfig();
      candidate.coins.chargePolicy = policy;
      expectInvalid(candidate);
    }
  });

  it('returns detached, deeply immutable snapshots', () => {
    const candidate = rawConfig();
    const snapshot = createArcadeConfigSnapshot(candidate);
    candidate.arcade.displayName = 'Changed outside';
    candidate.station.timings.recruitingSeconds = 600;
    candidate.registration.fields[0].required = false;
    expect(snapshot.arcade.displayName).toBe('Twilio Games');
    expect(snapshot.station.timings.recruitingSeconds).toBe(90);
    expect(snapshot.registration.fields[0]!.required).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.coins.gameCosts)).toBe(true);
    expect(Object.isFrozen(snapshot.station.timings)).toBe(true);
    expect(Object.isFrozen(snapshot.station.games.racer)).toBe(true);
    expect(Object.isFrozen(snapshot.station.automaticSelection.order)).toBe(true);
    expect(Object.isFrozen(snapshot.registration.fields)).toBe(true);
    expect(() => { (snapshot.arcade as any).mode = 'lead_capture'; }).toThrow(TypeError);

    const firstDefault = createDefaultArcadeConfig();
    const secondDefault = createDefaultArcadeConfig();
    expect(firstDefault).not.toBe(secondDefault);
    expect(firstDefault.arcade).not.toBe(secondDefault.arcade);
  });

  it('projects a frozen public config without server identity or direct challenge destinations', () => {
    const candidate = rawConfig();
    candidate.earning.challenges = [{
      id: 'docs', title: 'Docs', message: 'Read the docs for another coin.', url: 'https://twilio.com/docs', rewardCoins: 1, enabled: true,
      maxClaimsPerPlayer: 1, displayOrder: 1, startsAt: null, endsAt: null,
    }];
    const projected = projectPublicArcadeConfig(candidate);
    expect(projected.version).toBe(1);
    expect(projected.arcade.mode).toBe('off');
    expect(projected.station).toEqual(DEFAULT_ARCADE_CONFIG.station);
    expect(projected).not.toHaveProperty('updatedAt');
    expect(projected).not.toHaveProperty('updatedBy');
    expect(projected.earning.challenges[0]).not.toHaveProperty('url');
    expect(projected.earning.challenges[0]?.message).toBe('Read the docs for another coin.');
    expect(Object.isFrozen(projected.earning.challenges[0])).toBe(true);
    expect(Object.isFrozen(projected.station.games)).toBe(true);
    expect(Object.isFrozen(projected.station.comingSoon)).toBe(true);
    candidate.earning.challenges[0].title = 'Changed';
    candidate.station.games.racer.enabled = false;
    expect(projected.earning.challenges[0]!.title).toBe('Docs');
    expect(projected.station.games.racer.enabled).toBe(true);
  });

  it('parses only full settings payloads for replacement', () => {
    const settings = rawSettings();
    expect(parseArcadeConfigSettings(settings).arcade.mode).toBe('off');
    delete settings.queue;
    expect(() => parseArcadeConfigSettings(settings)).toThrow(ArcadeConfigValidationError);

    const withMetadata = rawSettings();
    withMetadata.version = 99;
    expect(() => parseArcadeConfigSettings(withMetadata)).toThrow(ArcadeConfigValidationError);
  });

  it('replaces all settings, preserves server metadata, and advances revision exactly once', () => {
    const current = rawConfig();
    current.version = 41;
    current.updatedAt = '2026-07-20T00:00:00.000Z';
    current.updatedBy = 'original@example.com';
    const replacement = rawSettings();
    replacement.arcade.mode = 'coin_only';
    replacement.arcade.displayName = 'New Arcade';
    replacement.coins.startingBalance = 3;

    const updated = replaceArcadeConfigSettings(current, replacement);
    expect(updated).toMatchObject({
      schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
      version: 42,
      updatedAt: '2026-07-20T00:00:00.000Z',
      updatedBy: 'original@example.com',
      arcade: { mode: 'coin_only', displayName: 'New Arcade' },
      coins: { startingBalance: 3 },
    });
    expect(current.version).toBe(41);
    expect(replacement).not.toHaveProperty('version');
  });

  it('accepts trusted update metadata separately without allowing it to control the revision', () => {
    const current = rawConfig();
    current.version = 9;
    const updated = replaceArcadeConfigSettings(current, rawSettings(), {
      updatedAt: '2026-07-20T12:34:56Z',
      updatedBy: ' admin@example.com ',
    });
    expect(updated.version).toBe(10);
    expect(updated.schemaVersion).toBe(ARCADE_CONFIG_SCHEMA_VERSION);
    expect(updated.updatedAt).toBe('2026-07-20T12:34:56.000Z');
    expect(updated.updatedBy).toBe('admin@example.com');
  });

  it('does not conflate schemaVersion with revision version', () => {
    const wrongSchema = rawConfig();
    wrongSchema.schemaVersion = 1;
    wrongSchema.version = 100;
    expectInvalid(wrongSchema);

    const highRevision = rawConfig();
    highRevision.version = 100;
    expect(parseArcadeConfig(highRevision)).toMatchObject({
      schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
      version: 100,
    });
  });

  it('accepts nullable locale voice numbers only in E.164 format', () => {
    const config = rawConfig();
    config.channels.voiceNumbers = { 'en-US': '+18555993809', 'pt-BR': '+551155555555' };
    expect(parseArcadeConfig(config).channels.voiceNumbers).toEqual(config.channels.voiceNumbers);
    for (const invalid of ['18555993809', '+55', '+5511ABC', '', 551155555555]) {
      const candidate = rawConfig();
      candidate.channels.voiceNumbers['pt-BR'] = invalid;
      expectInvalid(candidate);
    }
    const duplicate = rawConfig();
    duplicate.channels.voiceNumbers = { 'en-US': '+18555993809', 'pt-BR': '+18555993809' };
    expectInvalid(duplicate);
  });
});
