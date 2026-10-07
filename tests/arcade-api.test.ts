import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_ARCADE_CONFIG, type ArcadeConfigSettings } from '../shared/arcade-config';
import { ArcadeApi } from '../server/arcade-api';
import { ArcadeConfigStore } from '../server/arcade-config-store';
import { ArcadeEventHub } from '../server/arcade-events';
import { HttpServer } from '../server/http-server';
import { ArcadePlayerRuntime } from '../server/arcade-player-runtime';
import type { ArcadeMessagingTransport } from '../server/arcade-messaging-runtime';

const ADMIN_HEADER = { 'x-test-arcade-admin': 'admin@twilio.com' };
const DISPLAY_TOKEN = 'test-arcade-display-token';
let server: HttpServer | undefined;
let directory: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function settings(mode: 'off' | 'coin_only' | 'lead_capture' = 'off'): ArcadeConfigSettings {
  const copy = JSON.parse(JSON.stringify(DEFAULT_ARCADE_CONFIG)) as Record<string, any>;
  delete copy.schemaVersion;
  delete copy.version;
  delete copy.updatedAt;
  delete copy.updatedBy;
  copy.arcade.mode = mode;
  copy.earning.challenges = [{
    id: 'voice-docs',
    title: 'Read the Voice docs',
    message: 'Read the Voice docs to earn another coin.',
    url: 'https://www.twilio.com/docs/voice',
    rewardCoins: 1,
    enabled: true,
    maxClaimsPerPlayer: 1,
    displayOrder: 0,
    startsAt: null,
    endsAt: null,
  }];
  return copy as ArcadeConfigSettings;
}

async function harness(options: {
  maxEventStreams?: number;
  playerMode?: 'coin_only' | 'lead_capture';
  signingSecret?: string | null;
  fallbackVoiceNumber?: string | null;
  smsNumber?: string | null;
  whatsappNumber?: string | null;
  displayToken?: string | null;
  standaloneVoiceEnabled?: boolean;
  outboundTransport?: ArcadeMessagingTransport;
  deleteMemoryProfile?: (profileId: string) => Promise<void>;
  now?: () => number;
  shortenUrl?: (url: string, key: string) => Promise<string | null>;
  inboundMessagingRateLimits?: {
    addressLimit?: number;
    addressWindowMs?: number;
    processLimit?: number;
    processWindowMs?: number;
  };
} = {}): Promise<{
  baseUrl: string;
  store: ArcadeConfigStore;
  playerRuntime: ArcadePlayerRuntime;
  api: ArcadeApi;
}> {
  directory = await mkdtemp(path.join(tmpdir(), 'arcade-api-'));
  const fallbackVoiceNumber = options.fallbackVoiceNumber === undefined
    ? '+18555993809'
    : options.fallbackVoiceNumber ?? undefined;
  const smsNumber = options.smsNumber === undefined ? '+15005550006' : options.smsNumber ?? undefined;
  const whatsappNumber = options.whatsappNumber ?? undefined;
  const events = new ArcadeEventHub();
  const store = new ArcadeConfigStore({ directory: path.join(directory, 'arcade'), events });
  await store.load();
  if (options.playerMode) {
    await store.update({
      expectedVersion: 1,
      idempotencyKey: 'test-enable-player-mode',
      updatedBy: 'test@twilio.com',
      settings: settings(options.playerMode),
    });
  }
  const playerRuntime = new ArcadePlayerRuntime({
    configStore: store,
    events,
    stateFile: path.join(directory, 'arcade-state.json'),
    publicBaseUrl: 'http://localhost',
    signingSecret: () => options.signingSecret === null
      ? undefined
      : options.signingSecret ?? '0123456789abcdef'.repeat(4),
    outboundMessaging: options.outboundTransport ? {
      enabled: (channel?: 'sms' | 'whatsapp') => channel !== 'whatsapp',
      callNumber: () => fallbackVoiceNumber,
      createTransport: () => options.outboundTransport!,
    } : undefined,
  });
  const api = new ArcadeApi({
    configStore: store,
    events,
    publicBaseUrl: 'http://localhost',
    heartbeatMs: 20,
    maxEventStreams: options.maxEventStreams,
    playerRuntime,
    displayToken: options.displayToken === undefined ? DISPLAY_TOKEN : options.displayToken ?? undefined,
    fallbackVoiceNumber,
    messagingCapabilities: { sms: Boolean(smsNumber), whatsapp: Boolean(whatsappNumber) },
    inboundMessagingRateLimits: options.inboundMessagingRateLimits,
    deleteMemoryProfile: options.deleteMemoryProfile,
    shortenUrl: options.shortenUrl,
    now: options.now,
    authorizeAdmin: request => {
      const header = request.headers['x-test-arcade-admin'];
      const email = Array.isArray(header) ? header[0] : header;
      return email ? { email } : null;
    },
  });
  server = new HttpServer({
    port: 0,
    publicBaseUrl: 'http://localhost',
    validateSignatures: false,
    arcadeApi: api,
    standaloneVoiceEnabled: options.standaloneVoiceEnabled,
    analyticsPath: path.join(directory, 'analytics.json'),
    manifestPath: path.join(directory, 'manifest.json'),
    mapsPath: path.join(directory, 'maps.json'),
    arenaPath: path.join(directory, 'arena.json'),
    leaderboardPath: path.join(directory, 'leaderboard.json'),
    karaokeLeaderboardPath: path.join(directory, 'karaoke-leaderboard.json'),
    fighterMapsPath: path.join(directory, 'fighter-maps.json'),
    fighterPreviewDir: path.join(directory, 'fighter-previews'),
    clientDir: path.join(directory, 'client'),
    gamePhoneNumber: fallbackVoiceNumber,
    smsNumber,
    whatsappNumber,
    fighterDisplayToken: options.displayToken === undefined ? DISPLAY_TOKEN : options.displayToken ?? undefined,
  });
  const port = await server.start();
  return { baseUrl: `http://127.0.0.1:${port}`, store, playerRuntime, api };
}

async function updateConfig(
  baseUrl: string,
  body: ArcadeConfigSettings,
  options: { etag?: string; key?: string; origin?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/admin/arcade/config`, {
    method: 'PATCH',
    headers: {
      ...ADMIN_HEADER,
      'Content-Type': 'application/json',
      'If-Match': options.etag ?? '"arcade-config-1"',
      'Idempotency-Key': options.key ?? 'arcade-config-update-1',
      Origin: options.origin ?? 'http://localhost',
    },
    body: JSON.stringify(body),
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let received = '';
  for (let reads = 0; reads < 20 && !received.includes(expected); reads++) {
    const result = await reader.read();
    if (result.done) break;
    received += decoder.decode(result.value, { stream: true });
  }
  return received;
}

async function createPlayerSession(baseUrl: string, key: string): Promise<Response> {
  const sessionKey = Buffer.from(`arcade-session:${key}`, 'utf8').toString('base64url');
  return fetch(`${baseUrl}/api/arcade/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': sessionKey,
      Origin: 'http://localhost',
    },
    body: JSON.stringify({ cabinetId: 'ARCADE-01' }),
  });
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error(`response did not issue a cookie (HTTP ${response.status})`);
  return cookie.split(';', 1)[0]!;
}

const REGISTRATION = {
  lead: {
    firstName: 'Ada',
    lastName: 'Lovelace',
    workEmail: 'ada@example.com',
    companyName: 'Analytical Engines',
    phoneNumber: '+14155550199',
    countryCode: 'US',
  },
  termsAccepted: true,
  marketingConsent: false,
};

describe('Arcade API', () => {
  it('selects public voice numbers and call locale without coupling the SMS number', async () => {
    const { baseUrl, store, api } = await harness({
      fallbackVoiceNumber: '+18555993809',
      smsNumber: '+15005550006',
    });
    expect(api.getVoiceNumbers()).toEqual({
      'en-US': '+18555993809',
      'pt-BR': '+18555993809',
    });
    expect(api.voiceLocaleForNumber('+18555993809')).toBeNull();
    const localized = settings('off') as Record<string, any>;
    localized.channels.voiceNumbers = {
      'en-US': '+18555993809',
      'pt-BR': '+551155555555',
    };
    await store.update({
      expectedVersion: 1,
      idempotencyKey: 'localized-voice-numbers',
      updatedBy: 'test@twilio.com',
      settings: localized,
    });

    expect(api.getVoiceNumbers()).toEqual(localized.channels.voiceNumbers);
    expect(api.voiceLocaleForNumber('+551155555555')).toBe('pt-BR');
    expect(api.voiceLocaleForNumber('+18555993809')).toBe('en-US');
    const bootstrap = await (await fetch(`${baseUrl}/api/config`)).json() as Record<string, any>;
    expect(bootstrap).toMatchObject({
      phoneNumber: '+18555993809',
      smsNumber: '+15005550006',
      voiceNumbers: localized.channels.voiceNumbers,
    });

    const display = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/game?display=1`);
    await new Promise<void>((resolve, reject) => {
      display.once('open', resolve);
      display.once('error', reject);
    });
    display.send(JSON.stringify({ type: 'spectate', roomCode: '4821', displayToken: DISPLAY_TOKEN }));
    await new Promise(resolve => setTimeout(resolve, 20));
    const voice = await fetch(`${baseUrl}/voice/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        From: '+14155550199', To: '+551155555555', CallSid: 'CA-localized-number',
      }),
    });
    const xml = await voice.text();
    expect(xml).toContain('transcriptionLanguage="pt-BR"');
    expect(xml).toContain('name="commandLocale" value="pt-BR"');
    display.close();

    localized.channels.voiceNumbers['pt-BR'] = null;
    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'single-locale-voice-number',
      updatedBy: 'test@twilio.com',
      settings: localized,
    });
    expect(api.getVoiceNumbers()).toEqual({ 'en-US': '+18555993809', 'pt-BR': null });
    expect(api.voiceLocaleForNumber('+18555993809')).toBe('en-US');
  });

  it('serves redacted mode-off public config without changing existing endpoints', async () => {
    const { baseUrl } = await harness();
    const response = await fetch(`${baseUrl}/api/arcade/config/public`);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"arcade-config-1"');
    const config = await response.json() as Record<string, any>;
    expect(config.arcade.mode).toBe('off');
    expect(config.updatedAt).toBeUndefined();
    expect(config.updatedBy).toBeUndefined();

    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/config`)).status).toBe(200);
  });

  it('requires an authenticated admin and derives audit identity from that principal', async () => {
    const { baseUrl } = await harness();
    expect((await fetch(`${baseUrl}/api/admin/arcade/config`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/admin/arcade/status`)).status).toBe(401);

    const status = await fetch(`${baseUrl}/api/admin/arcade/status`, { headers: ADMIN_HEADER });
    expect(await status.json()).toMatchObject({
      config: { initialized: true, version: 1 }, tac: null,
      display: { configured: true, connected: false, checking: true, lastSeenAt: null, presenceTimeoutSeconds: 20 },
    });

    const updated = await updateConfig(baseUrl, settings('coin_only'));
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).toBe('"arcade-config-2"');
    const config = await updated.json() as Record<string, any>;
    expect(config.arcade.mode).toBe('coin_only');
    expect(config.updatedBy).toBe('admin@twilio.com');

    const full = await fetch(`${baseUrl}/api/admin/arcade/config`, { headers: ADMIN_HEADER });
    expect((await full.json() as Record<string, any>).earning.challenges[0].url)
      .toBe('https://www.twilio.com/docs/voice');
    const publicConfig = await (await fetch(`${baseUrl}/api/arcade/config/public`)).json() as Record<string, any>;
    expect(publicConfig.earning.challenges[0].url).toBeUndefined();
  });

  it('lets an authenticated same-origin operator reset one Racer map with concurrency protection', async () => {
    const { baseUrl } = await harness();
    const leaderboardPath = path.join(directory!, 'leaderboard.json');
    await writeFile(leaderboardPath, JSON.stringify([
      { name:'Ada',map:'Silver Lake',carIndex:0,finishT:31,at:1 },
      { name:'Bo',map:'Silver Lake',carIndex:1,finishT:32,at:2 },
      { name:'Cy',map:'Neon City',carIndex:0,finishT:33,at:3 },
    ]));
    const karaokeLeaderboardPath = path.join(directory!, 'karaoke-leaderboard.json');
    await writeFile(karaokeLeaderboardPath, JSON.stringify([
      {name:'Dee',songId:'never-gonna-give-you-up',score:90000,bestCombo:40,at:4},
      {name:'Eli',songId:'never-gonna-give-you-up',score:85000,bestCombo:35,at:5},
    ]));
    const endpoint=`${baseUrl}/api/admin/arcade/leaderboards`;

    expect((await fetch(endpoint)).status).toBe(401);
    const listed=await fetch(endpoint,{headers:ADMIN_HEADER});
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(await listed.json()).toEqual({games:[
      {game:'racer',resettable:true,maps:[{map:'Neon City',records:1},{map:'Silver Lake',records:2}]},
      {game:'monsters',resettable:false,maps:[]},
      {game:'fighter',resettable:false,maps:[]},
      {game:'karaoke',resettable:true,maps:[
        {map:'a-thousand-miles',label:'A Thousand Miles',records:0},
        {map:'luz-no-ritmo-dev',label:'Luz no Ritmo',records:0},
        {map:'never-gonna-give-you-up',label:'Never Gonna Give You Up',records:2},
      ]},
      {game:'trivia',resettable:true,maps:[
        {map:'all-time',label:'All time',records:0},
        {map:'general',label:'general',records:0},
        {map:'science',label:'science',records:0},
        {map:'geography',label:'geography',records:0},
        {map:'history',label:'history',records:0},
        {map:'entertainment',label:'entertainment',records:0},
        {map:'sports',label:'sports',records:0},
        {map:'technology',label:'technology',records:0},
        {map:'twilio',label:'twilio',records:0},
      ]},
    ]});
    const etag=listed.headers.get('etag');expect(etag).toMatch(/^"leaderboard-[a-f0-9]{16}"$/);
    const resetHeaders={...ADMIN_HEADER,'Content-Type':'application/json',Origin:'http://localhost'};
    expect((await fetch(`${endpoint}/reset`,{method:'POST',headers:{...resetHeaders,'If-Match':etag!},body:JSON.stringify({game:'racer',map:'Silver Lake',reason:''})})).status).toBe(400);
    expect((await fetch(`${endpoint}/reset`,{method:'POST',headers:{...resetHeaders,Origin:'https://evil.example','If-Match':etag!},body:JSON.stringify({game:'racer',map:'Silver Lake',reason:'event cleanup'})})).status).toBe(403);
    expect((await fetch(`${endpoint}/reset`,{method:'POST',headers:{...resetHeaders,'If-Match':'"stale"'},body:JSON.stringify({game:'racer',map:'Silver Lake',reason:'event cleanup'})})).status).toBe(412);

    const reset=await fetch(`${endpoint}/reset`,{method:'POST',headers:{...resetHeaders,'If-Match':etag!},body:JSON.stringify({game:'racer',map:'Silver Lake',reason:'event cleanup'})});
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({game:'racer',map:'Silver Lake',deleted:2,remaining:1});
    expect(JSON.parse(await readFile(leaderboardPath,'utf8'))).toEqual([
      {name:'Cy',map:'Neon City',carIndex:0,finishT:33,at:3},
    ]);
    const refreshed=await fetch(endpoint,{headers:ADMIN_HEADER}),refreshedEtag=refreshed.headers.get('etag');
    expect(refreshedEtag).not.toBe(etag);
    const concurrent=await Promise.all([1,2].map(index=>fetch(`${endpoint}/reset`,{
      method:'POST',headers:{...resetHeaders,'If-Match':refreshedEtag!},
      body:JSON.stringify({game:'racer',map:'Neon City',reason:`concurrent cleanup ${index}`}),
    })));
    expect(concurrent.map(response=>response.status).sort()).toEqual([200,412]);
    const afterRacer=await fetch(endpoint,{headers:ADMIN_HEADER}),karaokeEtag=afterRacer.headers.get('etag');
    const karaokeReset=await fetch(`${endpoint}/reset`,{method:'POST',headers:{...resetHeaders,'If-Match':karaokeEtag!},body:JSON.stringify({game:'karaoke',map:'never-gonna-give-you-up',reason:'event cleanup'})});
    expect(karaokeReset.status).toBe(200);
    expect(await karaokeReset.json()).toEqual({game:'karaoke',map:'never-gonna-give-you-up',deleted:2,remaining:0});
    expect(JSON.parse(await readFile(karaokeLeaderboardPath,'utf8'))).toEqual([]);
  });

  it('connects an authenticated same-origin booth display without initializing mode-off player state', async () => {
    let now = Date.parse('2026-07-23T12:00:00.000Z');
    const { baseUrl, playerRuntime } = await harness({ now: () => now });
    const endpoint = `${baseUrl}/api/admin/arcade/display/connect`;
    const validHeaders = {
      ...ADMIN_HEADER,
      'Content-Type': 'application/json',
      Origin: 'http://localhost',
    };

    const getResponse = await fetch(endpoint, { headers: ADMIN_HEADER });
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get('allow')).toBe('POST');

    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: '{}',
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('access-control-allow-origin')).toBeNull();

    for (const origin of [undefined, 'https://evil.example']) {
      const headers: Record<string, string> = { ...ADMIN_HEADER, 'Content-Type': 'application/json' };
      if (origin) headers.Origin = origin;
      const response = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
      expect(response.status).toBe(403);
    }

    const wrongType = await fetch(endpoint, {
      method: 'POST', headers: { ...ADMIN_HEADER, 'Content-Type': 'text/plain', Origin: 'http://localhost' }, body: '{}',
    });
    expect(wrongType.status).toBe(415);

    for (const body of ['[]', '{"extra":true}', '{bad json', '']) {
      const response = await fetch(endpoint, { method: 'POST', headers: validHeaders, body });
      expect(response.status).toBe(400);
    }

    expect(playerRuntime.getStatus()).toMatchObject({ mode: 'off', initialized: false });
    const connected = await fetch(endpoint, { method: 'POST', headers: validHeaders, body: '{}' });
    expect(connected.status).toBe(200);
    expect(connected.headers.get('cache-control')).toBe('no-store, private');
    expect(connected.headers.get('access-control-allow-origin')).toBeNull();
    expect(await connected.json()).toEqual({ displayToken: DISPLAY_TOKEN });
    expect(playerRuntime.getStatus()).toMatchObject({ mode: 'off', initialized: false });

    const display = await fetch(`${baseUrl}/api/arcade/station/display`, {
      headers: { 'X-Arcade-Display-Token': DISPLAY_TOKEN },
    });
    expect(display.status).toBe(200);
    const status = await fetch(`${baseUrl}/api/admin/arcade/status`, { headers: ADMIN_HEADER });
    expect(await status.json()).toMatchObject({ display: { configured: true, connected: true } });
    now += 20_001;
    const expired = await fetch(`${baseUrl}/api/admin/arcade/status`, { headers: ADMIN_HEADER });
    expect(await expired.json()).toMatchObject({ display: { configured: true, connected: false } });

    const adminConfig = await (await fetch(`${baseUrl}/api/admin/arcade/config`, { headers: ADMIN_HEADER })).text();
    const publicConfig = await (await fetch(`${baseUrl}/api/arcade/config/public`)).text();
    for (const config of [adminConfig, publicConfig]) {
      expect(config).not.toContain(DISPLAY_TOKEN);
      expect(config).not.toContain('displayToken');
    }
  });

  it('returns a safe unavailable response when the configured display capability is under 16 bytes', async () => {
    const { baseUrl, playerRuntime } = await harness({ displayToken: '123456789012345' });
    const response = await fetch(`${baseUrl}/api/admin/arcade/display/connect`, {
      method: 'POST',
      headers: { ...ADMIN_HEADER, 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: '{}',
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const body = await response.json() as Record<string, any>;
    expect(body).toEqual({
      error: {
        code: 'ARCADE_DISPLAY_TOKEN_UNAVAILABLE',
        message: 'Booth display connection is unavailable. Ask a deployment administrator to configure it.',
      },
    });
    expect(JSON.stringify(body)).not.toContain('123456789012345');
    expect(playerRuntime.getStatus()).toMatchObject({ mode: 'off', initialized: false });
  });

  it('rejects active station config without complete Voice and configured coin-only messaging', async () => {
    const { baseUrl } = await harness({
      fallbackVoiceNumber: null,
      smsNumber: null,
      whatsappNumber: null,
    });
    const noVoice = settings('lead_capture') as Record<string, any>;
    noVoice.channels.voice = false;
    let response = await updateConfig(baseUrl, noVoice as ArcadeConfigSettings, { key: 'no-voice' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'STATION_VOICE_REQUIRED' },
    });

    const partialVoice = settings('lead_capture') as Record<string, any>;
    partialVoice.channels.voiceNumbers = { 'en-US': '+14155550100', 'pt-BR': null };
    response = await updateConfig(baseUrl, partialVoice as ArcadeConfigSettings, { key: 'partial-voice' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'STATION_VOICE_NUMBERS_REQUIRED' },
    });

    const noSender = settings('coin_only') as Record<string, any>;
    noSender.channels.voiceNumbers = {
      'en-US': '+14155550100',
      'pt-BR': '+551155555555',
    };
    noSender.channels.sms = true;
    noSender.channels.whatsapp = true;
    response = await updateConfig(baseUrl, noSender as ArcadeConfigSettings, { key: 'no-sender' });
    expect(response.status).toBe(422);
    const body = await response.json() as Record<string, any>;
    expect(body.error.code).toBe('COIN_ONLY_MESSAGING_REQUIRED');
    expect(body.error.message).toContain('TWILIO_SMS_NUMBER');
  });

  it('requires a display token for activation and reports persisted capability drift as degraded', async () => {
    const { baseUrl } = await harness({ playerMode: 'lead_capture', displayToken: null });
    const update = await updateConfig(baseUrl, settings('lead_capture'), {
      etag: '"arcade-config-2"', key: 'missing-display-token-update',
    });
    expect(update.status).toBe(422);
    expect(await update.json()).toMatchObject({
      error: { code: 'STATION_DISPLAY_TOKEN_REQUIRED' },
    });
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(503);
    const session = await createPlayerSession(baseUrl, 'missing-display-token');
    expect(session.status).toBe(503);
    expect(await session.json()).toMatchObject({
      error: { code: 'STATION_CAPABILITY_UNAVAILABLE' },
    });
  });

  it('enforces optimistic concurrency, idempotency, origin, media type, and body limits', async () => {
    const { baseUrl } = await harness();
    expect((await updateConfig(baseUrl, settings('coin_only'))).status).toBe(200);
    expect((await updateConfig(baseUrl, settings('coin_only'))).status).toBe(200);

    const reused = await updateConfig(baseUrl, settings('lead_capture'));
    expect(reused.status).toBe(409);
    expect((await reused.json() as Record<string, any>).error.code).toBe('IDEMPOTENCY_CONFLICT');

    const stale = await updateConfig(baseUrl, settings('lead_capture'), { key: 'stale-update' });
    expect(stale.status).toBe(412);
    expect((await stale.json() as Record<string, any>).error.details.currentVersion).toBe(2);

    const forbiddenOrigin = await updateConfig(baseUrl, settings('lead_capture'), {
      etag: '"arcade-config-2"', key: 'origin-update', origin: 'https://evil.example',
    });
    expect(forbiddenOrigin.status).toBe(403);

    const wrongType = await fetch(`${baseUrl}/api/admin/arcade/config`, {
      method: 'PATCH',
      headers: { ...ADMIN_HEADER, 'Content-Type': 'text/plain', Origin: 'http://localhost' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);

    const tooLarge = await fetch(`${baseUrl}/api/admin/arcade/config`, {
      method: 'PATCH',
      headers: {
        ...ADMIN_HEADER,
        'Content-Type': 'application/json',
        'If-Match': '"arcade-config-2"',
        'Idempotency-Key': 'large-update',
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ data: 'x'.repeat(513 * 1024) }),
    });
    expect(tooLarge.status).toBe(413);

    const invalid = await fetch(`${baseUrl}/api/admin/arcade/config`, {
      method: 'PATCH',
      headers: {
        ...ADMIN_HEADER,
        'Content-Type': 'application/json',
        'If-Match': '"arcade-config-2"',
        'Idempotency-Key': 'invalid-update',
        Origin: 'http://localhost',
      },
      body: '{bad json',
    });
    expect(invalid.status).toBe(400);

    const method = await fetch(`${baseUrl}/api/arcade/config/public`, { method: 'POST' });
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET');
  });

  it('streams current and updated config versions without exposing config contents', async () => {
    const { baseUrl } = await harness();
    const response = await fetch(`${baseUrl}/api/arcade/events`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const initial = await readUntil(reader, '"version":1');
    expect(initial).toContain('event: arcade_config_updated');
    expect(initial).not.toContain('updatedBy');

    expect((await updateConfig(baseUrl, settings('coin_only'))).status).toBe(200);
    const updated = await readUntil(reader, '"version":2');
    expect(updated).toContain('data: {"type":"arcade_config_updated","version":2}');
    expect(updated).not.toContain('voice-docs');
    await reader.cancel();
  });

  it('requires resetting an active event before switching player journeys', async () => {
    const { baseUrl, store, playerRuntime } = await harness({ playerMode: 'coin_only' });
    const resources = await playerRuntime.getActive();
    await resources.service.identifyCoinOnly({
      playerId: 'pause-player', destination: '+14155550199', idempotencyKey: 'pause-identify',
    });
    const coin = await resources.service.insertStationCoin({
      stationId: 'ARCADE-01', playerId: 'pause-player', idempotencyKey: 'pause-coin',
    });
    const activeState = resources.store.snapshot();

    const lockedCandidates: Array<readonly [string, Record<string, any>]> = [];
    const activeModeChange = settings('lead_capture') as Record<string, any>;
    lockedCandidates.push(['active-mode', activeModeChange]);
    const cabinetChange = settings('coin_only') as Record<string, any>;
    cabinetChange.arcade.cabinetId = 'ARCADE-02';
    lockedCandidates.push(['cabinet', cabinetChange]);
    const channelsChange = settings('coin_only') as Record<string, any>;
    channelsChange.channels.voiceNumbers['en-US'] = '+14155550100';
    channelsChange.channels.voiceNumbers['pt-BR'] = '+551155555555';
    lockedCandidates.push(['channels', channelsChange]);
    const stationChange = settings('coin_only') as Record<string, any>;
    stationChange.station.qrRail = 'always';
    lockedCandidates.push(['station', stationChange]);
    for (const [name, candidate] of lockedCandidates) {
      const response = await updateConfig(baseUrl, candidate as ArcadeConfigSettings, {
        etag: '"arcade-config-2"', key: `active-${name}-change`,
      });
      expect(response.status, name).toBe(409);
      expect(await response.json(), name).toMatchObject({ error: { code: 'ACTIVE_STATION_CONFIG_LOCKED' } });
    }
    expect(store.getSnapshot()).toMatchObject({ version: 2, arcade: { mode: 'coin_only' } });
    expect(resources.store.snapshot()).toEqual(activeState);

    const mixedPause = settings('off') as Record<string, any>;
    mixedPause.station.timings.recruitingSeconds = 120;
    const mixedResponse = await updateConfig(baseUrl, mixedPause as ArcadeConfigSettings, {
      etag: '"arcade-config-2"', key: 'pause-with-policy-change',
    });
    expect(mixedResponse.status).toBe(409);
    expect(await mixedResponse.json()).toMatchObject({
      error: {
        code: 'ACTIVE_STATION_CONFIG_LOCKED',
        message: expect.stringContaining('Reset the active event flow'),
      },
    });
    expect(store.getSnapshot()).toMatchObject({ version: 2, arcade: { mode: 'coin_only' } });
    expect(resources.store.snapshot()).toEqual(activeState);

    const standaloneBlocked = await updateConfig(baseUrl, settings('off'), {
      etag: '"arcade-config-2"', key: 'standalone-before-reset',
    });
    expect(standaloneBlocked.status).toBe(409);
    expect(await standaloneBlocked.json()).toMatchObject({error:{code:'ACTIVE_STATION_CONFIG_LOCKED'}});
    expect(resources.store.snapshot()).toEqual(activeState);

    const reset = await fetch(`${baseUrl}/api/admin/arcade/station/reset`, {
      method: 'POST',
      headers: {
        ...ADMIN_HEADER,
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
        'If-Match': `"arcade-station-${coin.station.revision}"`,
        'Idempotency-Key': 'pause-reset',
      },
      body: JSON.stringify({ reason: 'clear current event before standalone play' }),
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ station: { phase: 'ATTRACT' }, round: null, match: null });

    const standalone = await updateConfig(baseUrl, settings('off'), {
      etag: '"arcade-config-2"', key: 'standalone-after-reset',
    });
    expect(standalone.status).toBe(200);
    expect(await standalone.json()).toMatchObject({ version: 3, arcade: { mode: 'off' } });
    expect(await (await fetch(`${baseUrl}/api/arcade/station/public`)).json()).toMatchObject({
      phase: 'ATTRACT', revision: 0, currentReadyCount: 0, roster: [], launch: null,
    });

    const reopened = await updateConfig(baseUrl, settings('coin_only'), {
      etag: '"arcade-config-3"', key: 'messaging-after-standalone',
    });
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ version: 4, arcade: { mode: 'coin_only' } });
  });

  it('closes active event streams during server shutdown', async () => {
    const { baseUrl } = await harness();
    const response = await fetch(`${baseUrl}/api/arcade/events`);
    expect(response.status).toBe(200);
    await expect(server!.stop()).resolves.toBeUndefined();
    server = undefined;
  });

  it('bounds concurrent event streams', async () => {
    const { baseUrl } = await harness({ maxEventStreams: 1 });
    const first = await fetch(`${baseUrl}/api/arcade/events`);
    expect(first.status).toBe(200);
    const rejected = await fetch(`${baseUrl}/api/arcade/events`);
    expect(rejected.status).toBe(503);
    expect((await rejected.json() as Record<string, any>).error.code).toBe('EVENT_STREAM_LIMIT');
    await first.body?.cancel();
  });

  it('exposes privacy-scoped station views and generation-safe display readiness', async () => {
    const { baseUrl, playerRuntime } = await harness({ playerMode: 'coin_only' });
    const empty = await fetch(`${baseUrl}/api/arcade/station/public`);
    expect(await empty.json()).toMatchObject({ phase: 'ATTRACT', revision: 0, currentReadyCount: 0 });

    const events = await fetch(`${baseUrl}/api/arcade/events`);
    const reader = events.body!.getReader();
    await readUntil(reader, 'arcade_config_updated');
    const stationResources = await playerRuntime.getActive();
    const stationPlayerId = 'station-player';
    await stationResources.service.identifyCoinOnly({
      playerId: stationPlayerId,
      destination: '+14155550199',
      idempotencyKey: 'identify-station-player',
    });
    const cookie = stationResources.sessions.issue(
      stationPlayerId, 'http://localhost#ARCADE-01',
    ).cookie.split(';', 1)[0]!;
    await stationResources.store.transaction(state => {
      state.channelAddresses['channel:test-station-player'] = {
        id: 'channel:test-station-player', playerId: stationPlayerId, channel: 'sms',
        normalizedAddress: '+14155550199', providerAddress: '+14155550199',
        preferredLocale: 'en-US', firstSeenAt: '2026-07-20T10:00:00.000Z',
        lastSeenAt: '2026-07-20T10:00:00.000Z',
      };
      state.messagingDrafts[stationPlayerId] = {
        playerId: stationPlayerId, stationId: 'ARCADE-01', step: 'COMPLETE',
        firstName: 'Ada', lastName: null, workEmail: null, companyName: null, countryCode: null,
        createdAt: '2026-07-20T10:00:00.000Z', updatedAt: '2026-07-20T10:00:00.000Z',
      };
    });
    const coin = await fetch(`${baseUrl}/api/arcade/station/coin`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json',
        'Idempotency-Key': 'station-coin-1',
      },
      body: '{}',
    });
    expect(coin.status).toBe(200);
    expect(await coin.json()).toMatchObject({
      phase: 'RECRUITING', ready: { status: 'READY', position: 1, reservation: { amount: 1, status: 'ACTIVE' } },
    });
    const presentationOnly = settings('coin_only') as Record<string, any>;
    presentationOnly.arcade.displayName = 'Expo station';
    expect((await updateConfig(baseUrl, presentationOnly as ArcadeConfigSettings, {
      etag: '"arcade-config-2"', key: 'active-presentation-change',
    })).status).toBe(200);
    const policyChange = JSON.parse(JSON.stringify(presentationOnly)) as Record<string, any>;
    policyChange.station.timings.recruitingSeconds = 120;
    const lockedConfig = await updateConfig(baseUrl, policyChange as ArcadeConfigSettings, {
      etag: '"arcade-config-3"', key: 'active-policy-change',
    });
    expect(lockedConfig.status).toBe(409);
    expect((await lockedConfig.json() as Record<string, any>).error.code)
      .toBe('ACTIVE_STATION_CONFIG_LOCKED');
    const stationEvent = await readUntil(reader, 'arcade_station_updated');
    expect(stationEvent).toContain('id: station:2');
    await reader.cancel();

    const publicResponse = await fetch(`${baseUrl}/api/arcade/station/public`);
    const publicStation = await publicResponse.json() as Record<string, any>;
    expect(publicStation).toMatchObject({ phase: 'RECRUITING', revision: 2, currentReadyCount: 1 });
    expect(JSON.stringify(publicStation)).not.toMatch(/player:|reservation|email|phone|company/i);

    const operator = await fetch(`${baseUrl}/api/admin/arcade/station`, { headers: ADMIN_HEADER });
    expect(operator.status).toBe(200);
    expect(JSON.stringify(await operator.clone().json())).not.toMatch(/playerId|reservationId|email|phone/i);
    let etag = operator.headers.get('etag')!;
    const control = async (route: string, body: Record<string, unknown>, key: string) => {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: {
          ...ADMIN_HEADER,
          Origin: 'http://localhost', 'Content-Type': 'application/json',
          'If-Match': etag, 'Idempotency-Key': key,
        },
        body: JSON.stringify(body),
      });
      if (response.ok) etag = response.headers.get('etag')!;
      return response;
    };
    expect((await control(
      '/api/admin/arcade/station/recruiting/close', { reason: 'start selection' }, 'station-close',
    )).status).toBe(200);
    expect((await control(
      '/api/admin/arcade/station/game/select', { game: 'fighter', reason: 'best fit' }, 'station-select',
    )).status).toBe(200);
    expect((await control(
      '/api/admin/arcade/station/launch/request', { reason: 'countdown elapsed' }, 'station-launch',
    )).status).toBe(200);

    const publicLaunching = await fetch(`${baseUrl}/api/arcade/station/public`);
    expect(await publicLaunching.json()).toMatchObject({ phase: 'LAUNCHING', launch: null });
    const launchingResponse = await fetch(`${baseUrl}/api/arcade/station/display`, {
      headers: { 'X-Arcade-Display-Token': DISPLAY_TOKEN },
    });
    const launching = await launchingResponse.json() as Record<string, any>;
    expect(launching).toMatchObject({
      phase: 'LAUNCHING', launch: { game: 'fighter', route: '/fighter.html', generation: 1 },
    });
    const unauthorizedDisplay = await fetch(`${baseUrl}/api/arcade/station/display/ready`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost', 'Content-Type': 'application/json',
        'If-Match': launchingResponse.headers.get('etag')!, 'Idempotency-Key': 'display-unauthorized',
      },
      body: JSON.stringify({ matchId: launching.launch.matchId, launchGeneration: 1 }),
    });
    expect(unauthorizedDisplay.status).toBe(401);
    const stale = await fetch(`${baseUrl}/api/arcade/station/display/ready`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost', 'Content-Type': 'application/json',
        'If-Match': launchingResponse.headers.get('etag')!, 'Idempotency-Key': 'display-stale',
        'X-Arcade-Display-Token': DISPLAY_TOKEN,
      },
      body: JSON.stringify({ matchId: 'stale-match', launchGeneration: 1 }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json() as Record<string, any>).error.code).toBe('STALE_STATION_LAUNCH');

    const ready = await fetch(`${baseUrl}/api/arcade/station/display/ready`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost', 'Content-Type': 'application/json',
        'If-Match': launchingResponse.headers.get('etag')!, 'Idempotency-Key': 'display-ready',
        'X-Arcade-Display-Token': DISPLAY_TOKEN,
      },
      body: JSON.stringify({
        matchId: launching.launch.matchId, launchGeneration: launching.launch.generation,
      }),
    });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ phase: 'LAUNCHING', revision: 6 });
    expect((await playerRuntime.getActive()).store.snapshot().stationControlEvents).toMatchObject([
      { action: 'CLOSE_STATION_RECRUITING', actorKind: 'operator', reason: 'start selection' },
      { action: 'SELECT_STATION_GAME', actorKind: 'operator', reason: 'best fit' },
      { action: 'REQUEST_STATION_LAUNCH', actorKind: 'operator', reason: 'countdown elapsed' },
      { action: 'MARK_STATION_DISPLAY_READY', actorKind: 'system' },
    ]);
  });

  it('accepts session-authenticated game choices and returns private choice projections', async () => {
    const { baseUrl, store, playerRuntime } = await harness({ playerMode: 'lead_capture' });
    const cookie = cookieFrom(await createPlayerSession(baseUrl, 'game-choice-player'));
    expect((await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json',
        'Idempotency-Key': 'game-choice-register',
      },
      body: JSON.stringify(REGISTRATION),
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/arcade/station/coin`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json',
        'Idempotency-Key': 'game-choice-coin',
      },
      body: '{}',
    })).status).toBe(200);
    const resources = await playerRuntime.getActive();
    const recruiting = await resources.service.getStation('ARCADE-01');
    await resources.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'game-choice-close', authorization: resources.operatorAuthorization('test@twilio.com'),
    });
    const choose = (body: unknown, key: string, headers: Record<string, string> = {}) => fetch(
      `${baseUrl}/api/arcade/station/game-choice`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json',
          'Idempotency-Key': key, ...headers,
        },
        body: JSON.stringify(body),
      },
    );
    expect((await fetch(`${baseUrl}/api/arcade/station/game-choice`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost', 'Content-Type': 'application/json',
        'Idempotency-Key': 'game-choice-no-session',
      },
      body: JSON.stringify({ game: 'fighter' }),
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/arcade/station/game-choice`, {
      method: 'POST',
      headers: {
        Cookie: cookie, 'Content-Type': 'application/json',
        'Idempotency-Key': 'game-choice-no-origin',
      },
      body: JSON.stringify({ game: 'fighter' }),
    })).status).toBe(403);
    expect((await choose({ game: 'fighter', playerId: 'attacker' }, 'game-choice-extra')).status).toBe(400);
    const selected = await choose({ game: 'fighter' }, 'game-choice-fighter');
    expect(selected.status).toBe(200);
    const selectedResult = await selected.json();
    expect(selectedResult).toEqual({ gameChoice: 'fighter' });
    const replay = await choose({ game: 'fighter' }, 'game-choice-fighter');
    expect(await replay.json()).toEqual(selectedResult);

    const publicProjection = await (await fetch(`${baseUrl}/api/arcade/station/public`)).json() as Record<string, any>;
    expect(publicProjection.games).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'fighter', choices: 1 }),
      expect.objectContaining({ id: 'racer', choices: 0 }),
      expect.objectContaining({ id: 'karaoke', capacity: 1, choices: 0 }),
    ]));
    expect(JSON.stringify(publicProjection)).not.toContain('gameChoicesByReadyEntryId');
    expect(JSON.stringify(publicProjection)).not.toContain('station-ready-entry');
    const operatorProjection = await (await fetch(`${baseUrl}/api/admin/arcade/station`, {
      headers: ADMIN_HEADER,
    })).json();
    expect(operatorProjection.voteCounts).toEqual(expect.arrayContaining([
      { game: 'fighter', count: 1 },
      { game: 'karaoke', count: 0 },
    ]));
    expect(JSON.stringify(operatorProjection.voteCounts)).not.toContain('station-ready-entry');
    expect(JSON.stringify(operatorProjection)).not.toContain('gameChoicesByReadyEntryId');
    expect(JSON.stringify(operatorProjection)).not.toContain('gameChoice');

    const changed = await choose({ game: 'monsters' }, 'game-choice-monsters');
    expect(await changed.json()).toEqual({ gameChoice: 'monsters' });
    expect(await (await choose({ game: 'fighter' }, 'game-choice-fighter')).json())
      .toEqual({ gameChoice: 'fighter' });
    const currentPlayer = await (await fetch(`${baseUrl}/api/arcade/station/me`, {
      headers: { Cookie: cookie },
    })).json();
    expect(currentPlayer).toMatchObject({ ready: { gameChoice: 'monsters' } });
    const conflict = await choose({ game: 'racer' }, 'game-choice-fighter');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });

    const disabled = settings('lead_capture') as Record<string, any>;
    disabled.station.games.monsters.enabled = false;
    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'disable-chosen-game',
      updatedBy: 'test@twilio.com',
      settings: disabled as ArcadeConfigSettings,
    });
    expect(await (await fetch(`${baseUrl}/api/arcade/station/me`, {
      headers: { Cookie: cookie },
    })).json()).toMatchObject({ ready: { gameChoice: null } });
    const filteredPublic = await (await fetch(`${baseUrl}/api/arcade/station/public`)).json() as Record<string, any>;
    expect(filteredPublic.games).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'monsters', choices: 0 }),
    ]));
  });

  it('protects emergency reset with operator auth, same-origin, idempotency, and a current station ETag', async () => {
    const { baseUrl, playerRuntime, api } = await harness({ playerMode: 'coin_only' });
    const resources = await playerRuntime.getActive();
    await resources.service.identifyCoinOnly({
      playerId: 'reset-player', destination: '+14155550999', idempotencyKey: 'reset:identify',
    });
    await resources.store.transaction(state => {
      state.channelAddresses['reset-channel'] = {
        id: 'reset-channel', playerId: 'reset-player', channel: 'sms',
        normalizedAddress: '+14155550999', providerAddress: '+14155550999',
        preferredLocale: 'en-US', firstSeenAt: '2026-07-20T10:00:00.000Z',
        lastSeenAt: '2026-07-20T10:00:00.000Z',
      };
    });
    const coin = await resources.service.insertStationCoin({
      stationId: 'ARCADE-01', playerId: 'reset-player', idempotencyKey: 'reset:coin',
    });
    const authorization = resources.operatorAuthorization('admin@twilio.com');
    const selecting = await resources.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: coin.station.revision,
      idempotencyKey: 'reset:close', authorization, reason: 'prepare reset test',
    });
    const locked = await resources.station.selectGame({
      game: 'racer', expectedRevision: selecting.station.revision,
      idempotencyKey: 'reset:select', authorization, reason: 'prepare reset test',
    });
    const launching = await resources.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'reset:launch', authorization, reason: 'prepare reset test',
    });
    const roomCode = launching.match!.engineRoomCode;
    const voiceRoute = await api.stationVoiceRoute('+14155550999', 'CA-reset');
    expect(voiceRoute).toMatchObject({ roomCode, admitted: true });
    expect(await api.validateStationVoiceSetup({
      callSid: 'CA-reset', readyEntryId: voiceRoute!.readyEntryId!,
      matchId: voiceRoute!.matchId, launchGeneration: voiceRoute!.launchGeneration,
      game: voiceRoute!.game, roomCode,
    })).toBe(true);
    expect(api.isStationEngineRoom(roomCode)).toBe(true);
    const display = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/game`);
    await new Promise<void>((resolve, reject) => {
      display.once('open', resolve);
      display.once('error', reject);
    });
    display.send(JSON.stringify({ type: 'spectate', roomCode, displayToken: DISPLAY_TOKEN }));
    const displayClosed = new Promise<number>(resolve => display.once('close', resolve));
    const currentEtag = `"arcade-station-${launching.station.revision}"`;
    const reset = (options: {
      admin?: boolean;
      origin?: string;
      etag?: string;
      key?: string;
      body?: unknown;
    } = {}) => fetch(`${baseUrl}/api/admin/arcade/station/reset`, {
      method: 'POST',
      headers: {
        ...(options.admin === false ? {} : ADMIN_HEADER),
        Origin: options.origin ?? 'http://localhost',
        'Content-Type': 'application/json',
        'If-Match': options.etag ?? currentEtag,
        'Idempotency-Key': options.key ?? 'station-emergency-reset',
      },
      body: JSON.stringify(options.body ?? { reason: 'physical cabinet emergency' }),
    });

    expect((await reset({ admin: false, key: 'reset-unauthorized' })).status).toBe(401);
    expect((await reset({ origin: 'https://evil.example', key: 'reset-wrong-origin' })).status).toBe(403);
    expect((await reset({ body: {}, key: 'reset-missing-reason' })).status).toBe(400);
    const stale = await reset({
      etag: `"arcade-station-${launching.station.revision - 1}"`, key: 'reset-stale',
    });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ error: { code: 'ARCADE_STATION_VERSION_CONFLICT' } });
    expect((await resources.service.getStation('ARCADE-01'))?.station.phase).toBe('LAUNCHING');
    expect(api.isStationEngineRoom(roomCode)).toBe(true);

    const response = await reset();
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(`"arcade-station-${launching.station.revision + 1}"`);
    const resetBody = await response.json() as Record<string, any>;
    expect(resetBody).toMatchObject({
      station: { phase: 'ATTRACT', revision: launching.station.revision + 1 },
      round: null,
      match: null,
    });
    expect(resetBody.recentControls[0]).toMatchObject({
      action: 'RESET_STATION', actorKind: 'operator', actorSubject: 'admin@twilio.com',
      reason: 'physical cabinet emergency',
    });
    const firstReset = await reset();
    expect(firstReset.status, await firstReset.clone().text()).toBe(200);
    expect(await displayClosed).toBe(4002);
    expect(await api.validateStationVoiceSetup({
      callSid: 'CA-reset', readyEntryId: voiceRoute!.readyEntryId!,
      matchId: voiceRoute!.matchId, launchGeneration: voiceRoute!.launchGeneration,
      game: voiceRoute!.game, roomCode,
    })).toBe(false);
    expect(api.isStationEngineRoom(roomCode)).toBe(false);
    const state = resources.store.snapshot();
    expect(state.stationMatches[launching.match!.id]?.phase).toBe('FAILED');
    expect(state.stationReadyEntries[coin.readyEntry.id]?.status).toBe('LEFT');
    expect(state.wallets['reset-player']?.reservations[0]?.status).toBe('RELEASED');
    expect(state.stationControlEvents.filter(event => event.action === 'RESET_STATION')).toHaveLength(1);
  });

  it('resets a safe test player through the audited operator route and clears Conversation Memory', async () => {
    const deletedProfiles: string[] = [];
    const { baseUrl, playerRuntime, api } = await harness({
      playerMode: 'coin_only',
      deleteMemoryProfile: async profileId => { deletedProfiles.push(profileId); },
    });
    const resources = await playerRuntime.getActive();
    await resources.service.identifyCoinOnly({
      playerId: 'test-player', destination: '+14155550123', idempotencyKey: 'test-reset:identify',
    });
    await resources.store.transaction(state => {
      state.players['test-player'] = {
        ...state.players['test-player']!, conversationProfileId: 'mem-test-player',
      };
      state.messagingDrafts['test-player'] = {
        playerId: 'test-player', stationId: 'ARCADE-01', step: 'COMPLETE', firstName: 'Ada',
        lastName: null, workEmail: null, companyName: null, countryCode: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      state.channelAddresses['test-reset-channel'] = {
        id: 'test-reset-channel', playerId: 'test-player', channel: 'sms',
        normalizedAddress: '+14155550123', providerAddress: '+14155550123', preferredLocale: 'en-US',
        firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      };
    });
    const coin = await resources.service.insertStationCoin({
      stationId: 'ARCADE-01', playerId: 'test-player', idempotencyKey: 'test-reset:coin',
    });
    const endpoint = `${baseUrl}/api/admin/arcade/station/ready/${encodeURIComponent(coin.readyEntry.id)}/reset-test-player`;
    const request = (key = 'test-player-reset') => fetch(endpoint, {
      method: 'POST',
      headers: {
        ...ADMIN_HEADER,
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
        'If-Match': `"arcade-station-${coin.station.revision}"`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ reason: 'repeat attendee flow' }),
    });

    expect((await fetch(endpoint, {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'unauthorized' }),
    })).status).toBe(401);
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(`"arcade-station-${coin.station.revision + 1}"`);
    expect(deletedProfiles).toEqual(['mem-test-player']);
    expect((await response.json() as Record<string, any>).recentControls[0]).toMatchObject({
      action: 'RESET_TEST_PLAYER', actorSubject: 'admin@twilio.com', reason: 'repeat attendee flow',
    });
    expect((await request()).status).toBe(200);
    expect(deletedProfiles).toEqual(['mem-test-player']);
    expect(await api.attachMessagingProfile({
      from: '+14155550123', conversationProfileId: 'mem-test-player',
    })).toBe(false);
    const state = resources.store.snapshot();
    expect(state.players['test-player']).toBeUndefined();
    expect(Object.values(state.channelAddresses).some(address => address.normalizedAddress === '+14155550123')).toBe(false);
  });

  it('lists inactive zero-coin players and restores the configured starting balance', async () => {
    const { baseUrl, api, playerRuntime } = await harness({ playerMode: 'coin_only' });
    const send = (providerMessageId: string, body: string) => api.processMessagingWebhook({
      from: '+14155550177', body, providerMessageId,
    });
    await send('SM-RESTORE-JOIN', 'JOIN');
    await send('SM-RESTORE-NAME', 'Ada');
    await send('SM-RESTORE-TERMS', 'YES');
    await send('SM-RESTORE-COIN', 'COIN');
    const resources = await playerRuntime.getActive();
    const authorization = resources.operatorAuthorization('admin@twilio.com');
    const recruiting = await resources.service.getStation('ARCADE-01');
    const selecting = await resources.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'restore-close', authorization, reason: 'finish test game',
    });
    const locked = await resources.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: 'RESTORE-ROOM', idempotencyKey: 'restore-select', authorization,
    });
    const launching = await resources.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'restore-launch', authorization, reason: 'finish test game',
    });
    const ready = await resources.service.markStationDisplayReady({
      stationId: 'ARCADE-01', expectedRevision: launching.station.revision,
      matchId: launching.match!.id, launchGeneration: launching.match!.launchGeneration,
      idempotencyKey: 'restore-display', authorization, reason: 'display ready',
    });
    const playing = await resources.service.startStationMatch({
      stationId: 'ARCADE-01', expectedRevision: ready.station.revision,
      idempotencyKey: 'restore-start', authorization, reason: 'start',
    });
    const results = await resources.service.completeStationMatch({
      stationId: 'ARCADE-01', expectedRevision: playing.station.revision,
      idempotencyKey: 'restore-complete', authorization, reason: 'complete',
    });

    const holdEndpoint=`${baseUrl}/api/admin/arcade/station/results/hold`;
    const holdHeaders={
      ...ADMIN_HEADER,Origin:'http://localhost','Content-Type':'application/json',
      'If-Match':`"arcade-station-${results.station.revision}"`,'Idempotency-Key':'hold-api-results',
    };
    expect((await fetch(holdEndpoint,{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json'},body:'{}'})).status).toBe(401);
    expect((await fetch(holdEndpoint,{method:'POST',headers:{...ADMIN_HEADER,'Content-Type':'application/json'},body:'{}'})).status).toBe(403);
    const held=await fetch(holdEndpoint,{method:'POST',headers:holdHeaders,body:JSON.stringify({reason:'players reviewing scores'})});
    expect(held.status).toBe(200);
    expect(held.headers.get('etag')).toBe(`"arcade-station-${results.station.revision+1}"`);
    const heldBody=await held.json() as Record<string,any>;
    expect(heldBody.resultsHeld).toBe(true);
    expect(heldBody.recentControls[0]).toMatchObject({action:'HOLD_STATION_RESULTS',reason:'players reviewing scores'});
    expect((await fetch(holdEndpoint,{method:'POST',headers:holdHeaders,body:JSON.stringify({reason:'players reviewing scores'})})).status).toBe(200);
    const advanced=await fetch(`${baseUrl}/api/admin/arcade/station/results/advance`,{
      method:'POST',headers:{...ADMIN_HEADER,Origin:'http://localhost','Content-Type':'application/json','If-Match':`"arcade-station-${results.station.revision+1}"`,'Idempotency-Key':'advance-api-results'},body:JSON.stringify({reason:'score review complete'}),
    });
    expect(advanced.status).toBe(200);
    const inactiveHold=await fetch(holdEndpoint,{
      method:'POST',headers:{...ADMIN_HEADER,Origin:'http://localhost','Content-Type':'application/json','If-Match':advanced.headers.get('etag')!,'Idempotency-Key':'hold-api-inactive'},body:JSON.stringify({reason:'late hold attempt'}),
    });
    expect(inactiveHold.status).toBe(409);
    expect(await inactiveHold.json()).toMatchObject({error:{code:'RESULTS_NOT_ACTIVE'}});

    expect((await fetch(`${baseUrl}/api/admin/arcade/players`)).status).toBe(401);
    const listed = await fetch(`${baseUrl}/api/admin/arcade/players`, { headers: ADMIN_HEADER });
    expect(listed.status).toBe(200);
    const page = await listed.json() as Record<string, any>;
    expect(page).toMatchObject({ startingBalance: 1, players: [{
      displayName: 'Ada', availableBalance: 0, canRestoreStartingBalance: true, canReset: true,
    }] });
    expect(JSON.stringify(page)).not.toContain('+14155550177');
    const playerId = page.players[0].playerId as string;
    const endpoint = `${baseUrl}/api/admin/arcade/players/${encodeURIComponent(playerId)}/restore-starting-balance`;
    const restored = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...ADMIN_HEADER, Origin: 'http://localhost', 'Content-Type': 'application/json',
        'If-Match': `"arcade-config-${page.configVersion}"`, 'Idempotency-Key': 'restore-player-balance',
      },
      body: JSON.stringify({ reason: 'attendee needs another turn' }),
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ restored: true, amountGranted: 1, availableBalance: 1 });
    const afterRestore = await (await fetch(`${baseUrl}/api/admin/arcade/players`, { headers: ADMIN_HEADER })).json() as Record<string, any>;
    expect(afterRestore.players).toMatchObject([{ playerId, availableBalance: 1, canRestoreStartingBalance: false, canReset: true }]);
    const beforeResetState = resources.store.snapshot();
    const readyEntryId = Object.values(beforeResetState.stationReadyEntries).find(entry => entry.playerId === playerId)!.id;
    const resetMatch = Object.values(beforeResetState.stationMatches)
      .find(match => Boolean(match.enginePlayerIdsByReadyEntryId[readyEntryId]))!;
    const enginePlayerId = `${resetMatch.engineRoomCode}:${resetMatch.enginePlayerIdsByReadyEntryId[readyEntryId]!}`;
    await writeFile(path.join(directory!, 'leaderboard.json'), JSON.stringify([
      { name: 'Ada', map: 'Silver Lake', carIndex: 0, finishT: 12.5, at: 1, enginePlayerId },
      { name: 'Other', map: 'Silver Lake', carIndex: 1, finishT: 14, at: 2 },
    ]));
    const resetEndpoint = `${baseUrl}/api/admin/arcade/players/${encodeURIComponent(playerId)}/reset`;
    const reset = () => fetch(resetEndpoint, {
      method: 'POST', headers: {
        ...ADMIN_HEADER, Origin: 'http://localhost', 'Content-Type': 'application/json',
        'Idempotency-Key': 'reset-historical-player',
      }, body: JSON.stringify({ reason: 'start attendee from scratch' }),
    });
    expect((await fetch(resetEndpoint)).status).toBe(405);
    const historicalReset = await reset();
    expect(historicalReset.status, await historicalReset.clone().text()).toBe(200);
    expect((await reset()).status).toBe(200);
    expect((await (await fetch(`${baseUrl}/api/admin/arcade/players`, { headers: ADMIN_HEADER })).json() as Record<string, any>).players).toEqual([]);
    const stationAfterReset = await (await fetch(`${baseUrl}/api/admin/arcade/station`, { headers: ADMIN_HEADER })).json() as Record<string, any>;
    expect(stationAfterReset.recentControls[0]).toMatchObject({
      action: 'RESET_TEST_PLAYER', actorSubject: 'admin@twilio.com', reason: 'start attendee from scratch',
    });
    expect(JSON.parse(await readFile(path.join(directory!, 'leaderboard.json'), 'utf8'))).toEqual([
      { name: 'PLAYER', map: 'Silver Lake', carIndex: 0, finishT: 12.5, at: 1, enginePlayerId },
      { name: 'Other', map: 'Silver Lake', carIndex: 1, finishT: 14, at: 2 },
    ]);
    expect(await send('SM-RESTORE-NEW-JOIN', 'JOIN')).toContain('first name');
    const newState = resources.store.snapshot();
    expect(newState.players[playerId]).toBeUndefined();
    expect(Object.values(newState.channelAddresses).some(address => address.playerId === playerId)).toBe(false);
  });

  it('routes signed-provider SMS commands through durable Arcade messaging when enabled', async () => {
    const{baseUrl,store,playerRuntime,api}=await harness({playerMode:'coin_only',whatsappNumber:'+15005550007'});
    const enabled = settings('coin_only') as Record<string, any>;
    enabled.channels.sms = true;
    enabled.channels.whatsapp = true;
    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'enable-arcade-sms',
      updatedBy: 'test@twilio.com',
      settings: enabled as ArcadeConfigSettings,
    });
    const send = (sid: string, body: string) => fetch(`${baseUrl}/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        From: '+14155550199', Body: body, MessageSid: sid, NumMedia: '0',
      }),
    });

    const joined = await send('SM-ARCADE-1', 'JOIN ARCADE-01 LANG en-US');
    expect(joined.status).toBe(200);
    expect(await joined.text()).toContain('first name');
    expect(await (await send('SM-ARCADE-2', 'Ada')).text()).toContain('Reply YES');
    expect(await (await send('SM-ARCADE-3', 'YES')).text()).toContain('You&apos;re set, Ada');
    expect(await (await send('SM-ARCADE-4', 'COIN')).text()).toContain('COIN IN');
    expect(await (await send('SM-ARCADE-5', 'STATUS')).text()).toContain('#1 in line for the next game');
    expect(await (await send('SM-ARCADE-1', 'JOIN ARCADE-01 LANG en-US')).text()).toContain('first name');
    expect(await api.processMessagingWebhook({
      from: '+14155550199', body: 'JOIN ARCADE-01 LANG en-US', providerMessageId: 'SM-ARCADE-1',
      conversationProfileId: 'mem_profile_fallback', conversationId: 'conv_fallback',
    })).toBeNull();
    expect(await api.attachMessagingProfile({
      from: '+14155550199', conversationProfileId: 'mem_profile_fallback',
    })).toBe(true);
    expect(await api.messagingMemoryIdentity('+14155550199')).toEqual({
      profileId:'mem_profile_fallback',firstName:'Ada',locale:'en-US',phoneNumber:'+14155550199',
    });

    const state = (await playerRuntime.getActive()).store.snapshot();
    expect(Object.keys(state.inboundMessages)).toHaveLength(5);
    expect(Object.values(state.stationReadyEntries)).toHaveLength(1);
    expect(state.players[Object.keys(state.players)[0]!]?.lead).toBeNull();
    expect(Object.values(state.messagingDrafts)[0]?.firstName).toBe('Ada');
    expect(Object.values(state.players)[0]?.conversationProfileId).toBe('mem_profile_fallback');
    expect(await (await fetch(`${baseUrl}/api/arcade/station/public`)).json()).toMatchObject({
      phase: 'RECRUITING', currentReadyCount: 1,
      roster: [{ displayName: 'Ada' }],
    });
    const resources = await playerRuntime.getActive();
    const adminStatus = await fetch(`${baseUrl}/api/admin/arcade/status`, { headers: ADMIN_HEADER });
    expect(await adminStatus.json()).toMatchObject({
      messaging: {
        enabled: false,
        counts: { PENDING: 0, DELIVERED: 0, FAILED: 0 },
        storage: {
          players: 1,
          messagingIdentities: 1,
          identityCapacity: 90_000,
          remainingIdentityCapacity: 89_999,
          drafts: 1,
          cleanupEligible: 0,
        },
      },
    });
    expect(await api.processMessagingWebhook({
      from: '+5511999999999', body: 'ENTRAR', providerMessageId: 'SM-API-ENTRAR',
      recalledLocale: 'en-US',
    })).toContain('somente pelo WhatsApp');
    expect(await api.processMessagingWebhook({
      from:'whatsapp:+5511999999999',body:'ENTRAR',providerMessageId:'SM-API-ENTRAR-WHATSAPP',
      recalledLocale:'en-US',
    })).toContain('primeiro nome');
    const rejectedSwitch = {
      from:'+5511999999999',body:'MOEDA',providerMessageId:'SM-API-PT-SWITCH-TO-SMS',
    };
    const rejectedSwitchReply = await api.processMessagingWebhook(rejectedSwitch);
    expect(rejectedSwitchReply).toContain('somente pelo WhatsApp');
    expect(await api.processMessagingWebhook(rejectedSwitch)).toBe(rejectedSwitchReply);
    const policyState = resources.store.snapshot();
    expect(Object.values(policyState.inboundMessages).find(receipt => (
      receipt.providerMessageId === 'SM-API-PT-SWITCH-TO-SMS'
    ))).toMatchObject({ command: 'CHANNEL_POLICY' });
    expect(Object.values(policyState.channelAddresses).some(address => (
      address.normalizedAddress === '+5511999999999' && address.channel === 'sms'
    ))).toBe(false);
    expect(await api.processMessagingWebhook({
      from: '+5511999999999', body: 'JOIN ARCADE-01 LANG en-US',
      providerMessageId: 'SM-API-PT-SWITCH-TO-ENGLISH-SMS',
    })).toContain('first name');
    expect(await api.processMessagingWebhook({
      from: '+5511999999999', body: 'Ada',
      providerMessageId: 'SM-API-PT-CONTINUE-IN-ENGLISH-SMS',
    })).toContain('Reply YES');
    expect(await api.processMessagingWebhook({
      from: 'whatsapp:+5511999999999', body: 'ENTRAR',
      providerMessageId: 'SM-API-SWITCH-BACK-TO-PORTUGUESE',
    })).toContain('Responda SIM');
    const restoredPolicyInput = {
      from: '+5511999999999', body: 'MOEDA', providerMessageId: 'SM-API-RESTORED-PT-SMS-POLICY',
    };
    const restoredPolicyReply = await api.processMessagingWebhook(restoredPolicyInput);
    expect(restoredPolicyReply).toContain('somente pelo WhatsApp');
    expect(await api.processMessagingWebhook(restoredPolicyInput)).toBe(restoredPolicyReply);
    expect(await api.processMessagingWebhook({
      from: '+14155550222', body: 'ENTRAR ARCADE-01 LANG en-US', providerMessageId: 'SM-API-LANG',
      recalledLocale: 'pt-BR',
    })).toContain('first name');
    const remembered = await api.processMessagingWebhook({
      from: '+14155550200', body: 'JOIN ARCADE-01 LANG pt-BR', providerMessageId: 'comm-memory-replay',
      conversationProfileId: 'mem_profile_replay', conversationId: 'conv_replay',
    });
    expect(await api.processMessagingWebhook({
      from: '+14155550200', body: 'JOIN ARCADE-01 LANG pt-BR', providerMessageId: 'comm-memory-replay',
      conversationProfileId: 'mem_profile_replay', conversationId: 'conv_replay',
    })).toBe(remembered);
    await expect(api.processMessagingWebhook({
      from: '+14155550200', body: 'JOIN ARCADE-01 LANG pt-BR', providerMessageId: 'comm-memory-replay',
      conversationProfileId: 'mem_profile_other', conversationId: 'conv_replay',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const station = await resources.service.getStation('ARCADE-01');
    const selecting = await resources.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: station!.station.revision,
      idempotencyKey: 'voice-route-close', authorization: resources.operatorAuthorization('test@twilio.com'),
    });
    const locked = await resources.station.selectGame({
      game: 'racer', expectedRevision: selecting.station.revision,
      idempotencyKey: 'voice-route-select', authorization: resources.operatorAuthorization('test@twilio.com'),
    });
    await resources.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'voice-route-launch', authorization: resources.operatorAuthorization('test@twilio.com'),
    });
    expect(await api.stationVoiceRoute('+14155550199')).toMatchObject({ game: 'racer', admitted: true });
    expect(await api.stationVoiceRoute('+14155550000')).toMatchObject({ game: 'racer', admitted: false });
  });

  it('durably enforces Portuguese channel policy when a channel is disabled', async () => {
    const { api, store, playerRuntime } = await harness({
      playerMode: 'coin_only', whatsappNumber: '+15005550007',
    });
    const whatsappOnly = settings('coin_only') as Record<string, any>;
    whatsappOnly.channels.sms = false;
    whatsappOnly.channels.whatsapp = true;
    await store.update({
      expectedVersion: 2, idempotencyKey: 'whatsapp-only-policy',
      updatedBy: 'test@twilio.com', settings: whatsappOnly as ArcadeConfigSettings,
    });
    const rejected = {
      from: '+5511999999999', body: 'ENTRAR', providerMessageId: 'SM-DISABLED-PT-SMS',
    };
    const reply = await api.processMessagingWebhook(rejected);
    expect(reply).toContain('somente pelo WhatsApp');
    expect(await api.processMessagingWebhook(rejected)).toBe(reply);
    const state = (await playerRuntime.getActive()).store.snapshot();
    expect(Object.values(state.inboundMessages).find(receipt => (
      receipt.providerMessageId === rejected.providerMessageId
    ))).toMatchObject({ command: 'CHANNEL_POLICY' });
    expect(Object.keys(state.players)).toHaveLength(0);

    const smsOnly = settings('coin_only') as Record<string, any>;
    smsOnly.channels.sms = true;
    smsOnly.channels.whatsapp = false;
    await store.update({
      expectedVersion: 3, idempotencyKey: 'sms-only-policy',
      updatedBy: 'test@twilio.com', settings: smsOnly as ArcadeConfigSettings,
    });
    const unavailable = await api.processMessagingWebhook({
      from: 'whatsapp:+5511888888888', body: 'ENTRAR', providerMessageId: 'SM-DISABLED-PT-WA',
    });
    expect(unavailable).toContain('Peça ajuda à equipe');
    expect(unavailable).not.toContain('Use SMS');
  });

  it('bounds inbound messaging by address and process without charging durable provider replays', async () => {
    const { api, playerRuntime } = await harness({
      playerMode: 'coin_only',
      inboundMessagingRateLimits: {
        addressLimit: 1,
        addressWindowMs: 60_000,
        processLimit: 2,
        processWindowMs: 60_000,
      },
    });
    const first = {
      from: '+14155550101', body: 'JOIN ARCADE-01', providerMessageId: 'SM-RATE-001',
    };
    const firstReply = await api.processMessagingWebhook(first);
    expect(firstReply).toContain('first name');
    expect(await api.processMessagingWebhook(first)).toBe(firstReply);
    expect(await api.processMessagingWebhook({
      ...first, providerMessageId: 'SM-RATE-002', body: 'STATUS',
    })).toContain('Too many messages');

    expect(await api.processMessagingWebhook({
      from: '+14155550102', body: 'JOIN ARCADE-01', providerMessageId: 'SM-RATE-003',
    })).toContain('first name');
    expect(await api.processMessagingWebhook({
      from: '+14155550103', body: 'JOIN ARCADE-01', providerMessageId: 'SM-RATE-004',
    })).toContain('Too many messages');
    expect(await api.processMessagingWebhook(first)).toBe(firstReply);

    const state = (await playerRuntime.getActive()).store.snapshot();
    expect(Object.keys(state.players)).toHaveLength(2);
    expect(Object.keys(state.inboundMessages)).toHaveLength(2);
  });

  it('keeps TAC profile enrichment non-destructive in either webhook order', async () => {
    const { api, playerRuntime } = await harness({ playerMode: 'coin_only' });
    expect(await api.attachMessagingProfile({
      from: '+14155550401', conversationProfileId: 'mem_profile_converged',
    })).toBe(true);
    const first = await api.processMessagingWebhook({
      from: '+14155550401', body: 'JOIN', providerMessageId: 'SM-PROFILE-FIRST',
    });
    expect(first).toContain('first name');
    let state = (await playerRuntime.getActive()).store.snapshot();
    const owner = Object.values(state.players)[0]!;
    expect(owner.conversationProfileId).toBe('mem_profile_converged');

    expect(await api.processMessagingWebhook({
      from: '+14155550402', body: 'JOIN', providerMessageId: 'SM-PROFILE-SECOND',
    })).toContain('first name');
    expect(Object.keys((await playerRuntime.getActive()).store.snapshot().players)).toHaveLength(2);
    expect(await api.attachMessagingProfile({
      from: '+14155550402', conversationProfileId: 'mem_profile_converged',
    })).toBe(false);
    state = (await playerRuntime.getActive()).store.snapshot();
    expect(Object.keys(state.players)).toHaveLength(2);
    expect(Object.values(state.channelAddresses).map(address => address.playerId))
      .toHaveLength(2);
    expect(await api.processMessagingWebhook({
      from: '+14155550402', body: 'Ada', providerMessageId: 'SM-PROFILE-SECOND-NAME',
    })).toContain('Reply YES');
  });

  it('reports effective outbound status and performs authenticated same-origin audited retries', async () => {
    let sends = 0;
    const { baseUrl, playerRuntime, api } = await harness({
      playerMode: 'coin_only',
      outboundTransport: {
        send: async () => ({
          providerMessageId: `SM${(++sends).toString(16).padStart(32, '0')}`,
          status: 'failed',
        }),
      },
    });
    expect(await api.processMessagingWebhook({
      from: '+14155550199', body: 'JOIN ARCADE-01 LANG en-US', providerMessageId: 'SM-RETRY-JOIN',
    })).toContain('first name');
    await api.processMessagingWebhook({
      from: '+14155550199', body: 'Ada', providerMessageId: 'SM-RETRY-NAME',
    });
    await api.processMessagingWebhook({
      from: '+14155550199', body: 'YES', providerMessageId: 'SM-RETRY-TERMS',
    });
    expect(await api.processMessagingWebhook({
      from: '+14155550199', body: 'COIN', providerMessageId: 'SM-RETRY-COIN',
    })).toContain("we'll text you a number to call");
    const resources = await playerRuntime.getActive();
    const recruiting = await resources.service.getStation('ARCADE-01');
    const selecting = await resources.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'retry-close', authorization: resources.operatorAuthorization('admin@twilio.com'),
    });
    await resources.service.selectStationGame({
      stationId: 'ARCADE-01', expectedRevision: selecting.station.revision,
      game: 'racer', engineRoomCode: '4821', idempotencyKey: 'retry-select',
      authorization: resources.operatorAuthorization('admin@twilio.com'),
    });
    await resources.messaging.flush();
    const failed = Object.values(resources.store.snapshot().outboundNotifications)[0]!;
    expect(failed.status).toBe('FAILED');

    const statusResponse = await fetch(`${baseUrl}/api/admin/arcade/status`, { headers: ADMIN_HEADER });
    const status = await statusResponse.json() as Record<string, any>;
    expect(status.messaging).toMatchObject({
      configured: true,
      enabled: true,
      started: true,
      lastError: null,
      onboarding: { sms: true, whatsapp: false },
      channels: { sms: true, whatsapp: false },
      counts: { FAILED: 1 },
      recentFailures: [{ notificationId: failed.id, retryEligible: true, attempts: 1 }],
    });

    const retryUrl = `${baseUrl}/api/admin/arcade/messaging/notifications/${encodeURIComponent(failed.id)}/retry`;
    const retry = (headers: Record<string, string>, reason: string, key = 'operator-retry') => fetch(retryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers },
      body: JSON.stringify({ reason }),
    });
    expect((await retry({ Origin: 'http://localhost' }, 'not authenticated')).status).toBe(401);
    expect((await retry(ADMIN_HEADER, 'missing origin')).status).toBe(403);
    expect((await retry({ ...ADMIN_HEADER, Origin: 'http://localhost' }, '   ')).status).toBe(400);

    const accepted = await retry(
      { ...ADMIN_HEADER, Origin: 'http://localhost' }, 'visitor confirmed handset recovery',
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      notificationId: failed.id, status: 'PENDING', attempts: 1, replayed: false,
    });
    await resources.messaging.flush();
    expect(sends).toBe(2);
    const replay = await retry(
      { ...ADMIN_HEADER, Origin: 'http://localhost' }, 'visitor confirmed handset recovery',
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      notificationId: failed.id, status: 'FAILED', attempts: 2, replayed: true,
    });
    const conflict = await retry(
      { ...ADMIN_HEADER, Origin: 'http://localhost' }, 'a different retry reason',
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(sends).toBe(2);
    expect(Object.values(resources.store.snapshot().messagingAuditEvents)).toEqual([
      expect.objectContaining({
        notificationId: failed.id,
        actorSubject: 'admin@twilio.com',
        reason: 'visitor confirmed handset recovery',
        attemptCount: 1,
      }),
    ]);
  });

  it('routes Voice by the unique admitted identity across lead and channel addresses', async () => {
    const { baseUrl, playerRuntime, api } = await harness({ playerMode: 'lead_capture' });
    const firstCookie = cookieFrom(await createPlayerSession(baseUrl, 'voice-lead-one'));
    const secondCookie = cookieFrom(await createPlayerSession(baseUrl, 'voice-lead-two'));
    const register = (cookie: string, key: string, phoneNumber: string) => fetch(
      `${baseUrl}/api/arcade/register`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie, Origin: 'http://localhost',
          'Content-Type': 'application/json', 'Idempotency-Key': key,
        },
        body: JSON.stringify({
          ...REGISTRATION,
          lead: { ...REGISTRATION.lead, phoneNumber },
        }),
      },
    );
    expect((await register(firstCookie, 'voice-lead-register-one', '+14155550199')).status).toBe(200);
    expect((await register(secondCookie, 'voice-lead-register-two', '+14155550200')).status).toBe(200);
    const resources = await playerRuntime.getActive();
    const firstPlayerId = resources.sessions.readCookie(firstCookie, 'http://localhost#ARCADE-01')!.player;
    const secondPlayerId = resources.sessions.readCookie(secondCookie, 'http://localhost#ARCADE-01')!.player;
    const coin = (cookie: string, key: string) => fetch(`${baseUrl}/api/arcade/station/coin`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      },
      body: '{}',
    });
    expect((await coin(firstCookie, 'voice-lead-coin-one')).status).toBe(200);
    expect((await coin(secondCookie, 'voice-lead-coin-two')).status).toBe(200);

    await api.processMessagingWebhook({
      from: '+14155550300', body: 'JOIN ARCADE-01', providerMessageId: 'SM-NON-ADMITTED',
    });
    await resources.store.transaction(state => {
      const address = Object.values(state.channelAddresses)
        .find(candidate => candidate.normalizedAddress === '+14155550300')!;
      state.channelAddresses[address.id] = { ...address, normalizedAddress: '+14155550199' };
    });
    const station = await resources.service.getStation('ARCADE-01');
    const selecting = await resources.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: station!.station.revision,
      idempotencyKey: 'identity-route-close',
      authorization: resources.operatorAuthorization('test@twilio.com'),
    });
    const locked = await resources.station.selectGame({
      game: 'racer', expectedRevision: selecting.station.revision,
      idempotencyKey: 'identity-route-select',
      authorization: resources.operatorAuthorization('test@twilio.com'),
    });
    const launching=await resources.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'identity-route-launch',
      authorization: resources.operatorAuthorization('test@twilio.com'),
    });

    const routed = await api.stationVoiceRoute('+14155550199', 'CA-known-name');
    expect(routed).toMatchObject({ admitted: true });
    expect(resources.store.snapshot().stationReadyEntries[routed!.readyEntryId!]?.playerId)
      .toBe(firstPlayerId);
    expect(await api.resolveStationVoiceSetup({
      callSid:'CA-known-name',readyEntryId:routed!.readyEntryId!,matchId:routed!.matchId,
      launchGeneration:routed!.launchGeneration,game:routed!.game,roomCode:routed!.roomCode,
    })).toEqual({ firstName: REGISTRATION.lead.firstName, terminal: false, participantIndex: 0, participantCount: 2 });
    const routedSecond=await api.stationVoiceRoute('+14155550200','CA-known-name-two');
    expect(routedSecond).toMatchObject({admitted:true,roomCode:routed!.roomCode,matchId:routed!.matchId});
    expect(resources.store.snapshot().stationReadyEntries[routedSecond!.readyEntryId!]?.playerId)
      .toBe(secondPlayerId);
    expect(await api.resolveStationVoiceSetup({
      callSid:'CA-known-name-two',readyEntryId:routedSecond!.readyEntryId!,matchId:routedSecond!.matchId,
      launchGeneration:routedSecond!.launchGeneration,game:routedSecond!.game,roomCode:routedSecond!.roomCode,
    })).toEqual({firstName:REGISTRATION.lead.firstName,terminal:false,participantIndex:1,participantCount:2});
    expect(api.stationVoiceSetupReady(routed!.readyEntryId!)).toBe(false);
    api.stationVoiceParticipantConnected('CA-known-name',routed!.readyEntryId!,'engine-player-one','connection-one');
    await Promise.resolve();expect(api.stationVoiceSetupReady(routed!.readyEntryId!)).toBe(false);
    api.stationVoiceParticipantConnected('CA-known-name-two',routedSecond!.readyEntryId!,'engine-player-two','connection-two');
    await Promise.resolve();expect(api.stationVoiceSetupReady(routed!.readyEntryId!)).toBe(true);
    const displayReady=await resources.service.markStationDisplayReady({
      stationId:'ARCADE-01',expectedRevision:launching.station.revision,idempotencyKey:'identity-route-display',
      authorization:resources.operatorAuthorization('test@twilio.com'),matchId:launching.match!.id,launchGeneration:launching.match!.launchGeneration,
    });
    const playing=await resources.service.startStationMatch({
      stationId:'ARCADE-01',expectedRevision:displayReady.station.revision,idempotencyKey:'identity-route-start',authorization:resources.operatorAuthorization('test@twilio.com'),
    });
    await resources.service.completeStationMatch({
      stationId:'ARCADE-01',expectedRevision:playing.station.revision,idempotencyKey:'identity-route-complete',authorization:resources.operatorAuthorization('test@twilio.com'),
    });
    expect(await api.resolveStationVoiceSetup({
      callSid:'CA-known-name',readyEntryId:routed!.readyEntryId!,matchId:routed!.matchId,
      launchGeneration:routed!.launchGeneration,game:routed!.game,roomCode:routed!.roomCode,
    })).toEqual({firstName:REGISTRATION.lead.firstName,terminal:true,participantIndex:0,participantCount:2});

  });

  it('accepts localized Portuguese browser registration in lead-capture mode', async () => {
    const { baseUrl, api, store, playerRuntime } = await harness({ playerMode: 'lead_capture' });
    const localized = settings('lead_capture') as Record<string, any>;
    localized.channels.voiceNumbers = {
      'en-US': '+14155550100',
      'pt-BR': '+551155555555',
    };
    await store.update({
      expectedVersion: 2, idempotencyKey: 'portuguese-browser-call-numbers',
      updatedBy: 'test@twilio.com', settings: localized as ArcadeConfigSettings,
    });
    expect(await api.processMessagingWebhook({
      from: '+5511888888888', body: 'ENTRAR', providerMessageId: 'SM-PT-LEAD-BROWSER-GUIDANCE',
    })).toContain('continue no navegador');
    const cookie = cookieFrom(await createPlayerSession(baseUrl, 'portuguese-browser-player'));
    const registration = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'portuguese-browser-register',
      },
      body: JSON.stringify({ ...REGISTRATION, preferredLocale: 'pt-BR' }),
    });
    expect(registration.status).toBe(200);
    expect(await registration.json()).toMatchObject({
      registered: true, firstName: REGISTRATION.lead.firstName, preferredLocale: 'pt-BR',
    });
    expect((await fetch(`${baseUrl}/api/arcade/station/coin`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'portuguese-browser-coin',
      },
      body: '{}',
    })).status).toBe(200);
    const resources = await playerRuntime.getActive();
    const recruiting = await resources.service.getStation('ARCADE-01');
    const selecting = await resources.service.closeStationRecruiting({
      stationId: 'ARCADE-01', expectedRevision: recruiting!.station.revision,
      idempotencyKey: 'portuguese-browser-close',
      authorization: resources.operatorAuthorization('test@twilio.com'),
    });
    const locked = await resources.station.selectGame({
      game: 'racer', expectedRevision: selecting.station.revision,
      idempotencyKey: 'portuguese-browser-select',
      authorization: resources.operatorAuthorization('test@twilio.com'),
    });
    expect(await (await fetch(`${baseUrl}/api/arcade/station/me`, {
      headers: { Cookie: cookie },
    })).json()).toMatchObject({ phase: 'LOCKED', ready: { status: 'ADMITTED' }, callNumber: null });
    await resources.service.requestStationLaunch({
      stationId: 'ARCADE-01', expectedRevision: locked.station.revision,
      idempotencyKey: 'portuguese-browser-launch',
      authorization: resources.operatorAuthorization('test@twilio.com'),
    });
    expect(await (await fetch(`${baseUrl}/api/arcade/station/me`, {
      headers: { Cookie: cookie },
    })).json()).toMatchObject({
      phase: 'LAUNCHING', ready: { status: 'ADMITTED' }, callNumber: '+551155555555',
    });
  });

  it('does not let browser registration claim an existing messaging identity', async () => {
    const { baseUrl, api } = await harness({ playerMode: 'lead_capture' });
    const joined = await api.processMessagingWebhook({
      from: '+14155550199', body: 'JOIN ARCADE-01 LANG en-US', providerMessageId: 'SM-LINK-1',
    });
    expect(joined).toContain('first name');
    const browserSession = await createPlayerSession(baseUrl, 'linked-browser');
    const registered = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookieFrom(browserSession), Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'linked-browser-register',
      },
      body: JSON.stringify({ ...REGISTRATION, preferredLocale: 'en-US' }),
    });
    expect(registered.status).toBe(409);
    expect((await registered.json() as Record<string, any>).error.code).toBe('PHONE_ALREADY_LINKED');
  });

  it('keeps player state and signing secrets untouched while mode is off', async () => {
    const { baseUrl, playerRuntime, api } = await harness({
      signingSecret: null, standaloneVoiceEnabled: false,
    });
    const response = await createPlayerSession(baseUrl, 'off-session');
    expect(response.status).toBe(409);
    expect((await response.json() as Record<string, any>).error.code).toBe('ARCADE_MODE_DISABLED');
    expect(response.headers.get('set-cookie')).toBeNull();
    const display = await fetch(`${baseUrl}/api/arcade/station/display`, {
      headers: { 'X-Arcade-Display-Token': DISPLAY_TOKEN },
    });
    expect(display.status).toBe(200);
    expect(await display.json()).toMatchObject({ phase: 'ATTRACT', revision: 0 });
    const voice = await fetch(`${baseUrl}/voice/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: '+14155550199', CallSid: 'CA-mode-off' }),
    });
    expect(voice.status).toBe(200);
    expect(await voice.text()).toContain('<Hangup />');
    expect(await api.stationVoiceRoute('+14155550199', 'CA-retained-mode-off')).toBeNull();
    expect(playerRuntime.getStatus().initialized).toBe(false);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it('persists standalone locale and provider replays without creating player identities', async () => {
    const { baseUrl, store, playerRuntime, api } = await harness();
    const portuguese = {
      from: '+14155550199', body: 'LANG pt-BR', providerMessageId: 'SM-STANDALONE-PT',
    };
    const firstReply = await api.processMessagingWebhook(portuguese);
    expect(firstReply).toContain('jogo independente');
    expect(await api.processMessagingWebhook(portuguese)).toBe(firstReply);
    expect(await api.processMessagingWebhook({
      from: portuguese.from, body: 'oi', providerMessageId: 'SM-STANDALONE-PT-2',
    })).toContain('jogo independente');

    expect(await api.processMessagingWebhook({
      from: '+5511999999999', body: 'LANG en-US', providerMessageId: 'SM-STANDALONE-EN',
    })).toContain('Standalone play is active');
    const mms = await fetch(`${baseUrl}/sms`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        From: '+5511999999999', Body: '', MessageSid: 'SM-STANDALONE-MMS', NumMedia: '1',
      }),
    });
    expect(await mms.text()).toContain('I can read text replies only');

    const cleanupStore = await playerRuntime.getStateStoreForCleanup();
    const state = cleanupStore.snapshot();
    expect(Object.keys(state.players)).toHaveLength(0);
    expect(Object.keys(state.inboundMessages)).toHaveLength(3);
    expect(Object.keys(state.idempotencyRecords).filter(key => key.startsWith('standalone-locale:'))).toHaveLength(2);

    const staleAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await cleanupStore.transaction(draft => {
      for (const [id, message] of Object.entries(draft.inboundMessages)) {
        if (message.command === 'STANDALONE') draft.inboundMessages[id] = { ...message, receivedAt: staleAt };
      }
      for (const [id, record] of Object.entries(draft.idempotencyRecords)) {
        if (id.startsWith('standalone-locale:')) draft.idempotencyRecords[id] = { ...record, createdAt: staleAt };
      }
    });
    expect(await api.processMessagingWebhook({
      from: portuguese.from, body: 'hello', providerMessageId: 'SM-STANDALONE-PRUNE',
    })).toContain('Standalone play is active');
    const pruned = cleanupStore.snapshot();
    expect(Object.values(pruned.inboundMessages).map(message => message.providerMessageId))
      .toEqual(['SM-STANDALONE-PRUNE']);
    expect(Object.keys(pruned.idempotencyRecords).filter(id => id.startsWith('standalone-locale:')))
      .toHaveLength(1);

    const englishOnly = settings('off') as Record<string, any>;
    englishOnly.channels.voiceNumbers = { 'en-US': '+18555993809', 'pt-BR': null };
    await store.update({
      expectedVersion: 1, idempotencyKey: 'standalone-english-only',
      updatedBy: 'test@twilio.com', settings: englishOnly as ArcadeConfigSettings,
    });
    expect(await api.processMessagingWebhook({
      from: '+5511888888888', body: 'LANG pt-BR', providerMessageId: 'SM-STANDALONE-NO-PT',
    })).toContain('não estão disponíveis');
  });

  it('reports degraded health when enabled player state cannot initialize', async () => {
    const { baseUrl } = await harness({ playerMode: 'lead_capture', signingSecret: null });
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: 'degraded' });
    const session = await createPlayerSession(baseUrl, 'degraded-session');
    expect(session.status).toBe(503);
    expect((await session.json() as Record<string, any>).error.code).toBe('ARCADE_STATE_UNAVAILABLE');
    expect((await fetch(`${baseUrl}/api/admin/arcade/status`, { headers: ADMIN_HEADER })).status).toBe(200);
  });

  it('issues isolated sessions and exposes only authenticated self projections', async () => {
    const { baseUrl, playerRuntime } = await harness({ playerMode: 'lead_capture' });
    const session = await createPlayerSession(baseUrl, 'lead-session');
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ mode: 'lead_capture', registered: false, availableBalance: null });
    const setCookie = session.headers.get('set-cookie')!;
    const cookie = cookieFrom(session);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const replay = await createPlayerSession(baseUrl, 'lead-session');
    expect(replay.headers.get('set-cookie')).not.toBe(setCookie);
    const pending = await fetch(`${baseUrl}/api/arcade/player`, { headers: { Cookie: cookie } });
    expect(await pending.json()).toEqual({ registered: false, firstName: null, preferredLocale: null });
    expect((await fetch(`${baseUrl}/api/arcade/wallet`, { headers: { Cookie: cookie } })).status).toBe(409);

    const registration = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'register-self',
      },
      body: JSON.stringify(REGISTRATION),
    });
    expect(registration.status).toBe(200);
    expect(await registration.json()).toEqual({
      registered: true, firstName: 'Ada', preferredLocale: null, availableBalance: 1,
    });

    const player = await (await fetch(`${baseUrl}/api/arcade/player`, { headers: { Cookie: cookie } })).json();
    const wallet = await (await fetch(`${baseUrl}/api/arcade/wallet`, { headers: { Cookie: cookie } })).json();
    expect(JSON.stringify(player)).not.toMatch(/email|phoneNumber|company|lastName|destination|player:/i);
    expect(wallet).toMatchObject({ ledgerBalance: 1, reservedBalance: 0, availableBalance: 1 });
    expect(JSON.stringify(wallet)).not.toMatch(/transaction|reservation|idempotency|player:/i);

    const resources = await playerRuntime.getActive();
    const persistedPlayer = Object.values(resources.store.snapshot().players)[0]!;
    expect(persistedPlayer.lead?.phoneNumber).toBe('+14155550199');
    expect(persistedPlayer.trustedDestination).toBeNull();
  });

  it('allows a registered browser player to join without an OTP step', async () => {
    const { baseUrl, playerRuntime } = await harness({ playerMode: 'lead_capture' });
    const cookie = cookieFrom(await createPlayerSession(baseUrl, 'browser-player'));
    const mutate = (path: string, key: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    expect((await mutate('/api/arcade/register', 'browser-register', REGISTRATION)).status).toBe(200);
    expect((await mutate('/api/arcade/station/coin', 'browser-coin', {})).status).toBe(200);

    const resources = await playerRuntime.getActive();
    const before = resources.store.snapshot();
    const readyEntry = Object.values(before.stationReadyEntries)[0]!;
    const station = before.stations['ARCADE-01']!;
    await resources.service.resetTestPlayer({
      stationId: 'ARCADE-01', readyEntryId: readyEntry.id, expectedRevision: station.revision,
      idempotencyKey: 'browser-player-reset', reason: 'repeat browser journey',
      authorization: resources.operatorAuthorization('admin@twilio.com'),
    });
    const retiredRegistration = await mutate('/api/arcade/register', 'browser-register-after-reset', REGISTRATION);
    expect(retiredRegistration.status).toBe(409);
    expect(await retiredRegistration.json()).toMatchObject({ error: { code: 'PLAYER_SESSION_RETIRED' } });
    const restarted = await fetch(`${baseUrl}/api/arcade/session`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json',
        'Idempotency-Key': 'browser-player-restart',
      },
      body: JSON.stringify({ cabinetId: 'ARCADE-01' }),
    });
    expect(restarted.status).toBe(200);
    expect(restarted.headers.get('set-cookie')).not.toBeNull();
    expect(await restarted.json()).toEqual({ mode: 'lead_capture', registered: false, availableBalance: null });
  });

  it('rejects missing origins, caller-controlled identity fields, and tampered sessions', async () => {
    const { baseUrl } = await harness({ playerMode: 'lead_capture' });
    const staleQr = await fetch(`${baseUrl}/api/arcade/session`, {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cabinetId: 'ARCADE-02' }),
    });
    expect(staleQr.status).toBe(409);
    expect((await staleQr.json() as Record<string, any>).error.code).toBe('CABINET_CHANGED');
    expect(staleQr.headers.get('set-cookie')).toBeNull();
    const session = await createPlayerSession(baseUrl, 'secure-session');
    const cookie = cookieFrom(session);
    const missingOrigin = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'missing-origin' },
      body: JSON.stringify(REGISTRATION),
    });
    expect(missingOrigin.status).toBe(403);

    const injectedIdentity = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'injected-identity',
      },
      body: JSON.stringify({ ...REGISTRATION, playerId: 'player:attacker', destination: '+14155550000' }),
    });
    expect(injectedIdentity.status).toBe(400);

    const tampered = `${cookie}x`;
    const unauthorized = await fetch(`${baseUrl}/api/arcade/player`, { headers: { Cookie: tampered } });
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json() as Record<string, any>).error.code).toBe('ARCADE_SESSION_REQUIRED');
  });

  it('does not materialize browser identities or wallets in coin-only mode', async () => {
    const { baseUrl, playerRuntime } = await harness({ playerMode: 'coin_only' });
    const first = await createPlayerSession(baseUrl, 'coin-player-one');
    const second = await createPlayerSession(baseUrl, 'coin-player-two');
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect((await first.json() as Record<string, any>).error.code).toBe('MESSAGING_IDENTITY_REQUIRED');
    expect(first.headers.get('set-cookie')).toBeNull();
    const state = (await playerRuntime.getActive()).store.snapshot();
    expect(Object.keys(state.players)).toHaveLength(0);
    expect(Object.keys(state.wallets)).toHaveLength(0);
  });

  it('namespaces one external idempotency key independently for each authenticated player', async () => {
    const { baseUrl, playerRuntime } = await harness({ playerMode: 'lead_capture' });
    const firstCookie = cookieFrom(await createPlayerSession(baseUrl, 'namespace-player-one'));
    const secondCookie = cookieFrom(await createPlayerSession(baseUrl, 'namespace-player-two'));
    const register = (cookie: string, phoneNumber: string) => fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'same-browser-key',
      },
      body: JSON.stringify({ ...REGISTRATION, lead: { ...REGISTRATION.lead, phoneNumber } }),
    });
    const [first, second] = await Promise.all([
      register(firstCookie, '+14155550199'), register(secondCookie, '+14155550200'),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const state = (await playerRuntime.getActive()).store.snapshot();
    expect(Object.keys(state.players)).toHaveLength(2);
    expect(Object.keys(state.idempotencyRecords)).toHaveLength(2);
  });

  it('uses the authenticated player current entry for queue actions without exposing queue IDs', async () => {
    const { baseUrl } = await harness({ playerMode: 'lead_capture' });
    const session = await createPlayerSession(baseUrl, 'queue-player');
    expect(session.status, await session.clone().text()).toBe(200);
    const cookie = cookieFrom(session);
    const registered = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'queue-register',
      },
      body: JSON.stringify(REGISTRATION),
    });
    expect(registered.status).toBe(200);
    const mutate = (path: string, key: string, body: unknown = {}) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });

    const joined = await mutate('/api/arcade/queue/join', 'queue-join', {
      preferredGame: 'racer', flexibleGame: false,
    });
    expect(joined.status).toBe(200);
    const joinedBody = await joined.json() as Record<string, any>;
    expect(joinedBody).toMatchObject({
      availableBalance: 1,
      queue: { status: 'WAITING', preferredGame: 'racer', position: 1, reservation: null },
    });
    expect(JSON.stringify(joinedBody)).not.toMatch(/queueEntryId|playerId|reason|event/i);
    const status = await (await fetch(`${baseUrl}/api/arcade/queue/status`, {
      headers: { Cookie: cookie },
    })).json();
    expect(status).toMatchObject({ queue: { status: 'WAITING', position: 1 } });

    const invalidConfirm = await mutate('/api/arcade/queue/confirm', 'queue-confirm');
    expect(invalidConfirm.status).toBe(409);
    const injectedId = await mutate('/api/arcade/queue/snooze', 'queue-injected', {
      queueEntryId: 'another-player-entry',
    });
    expect(injectedId.status).toBe(400);

    const snoozed = await mutate('/api/arcade/queue/snooze', 'queue-snooze');
    expect(await snoozed.json()).toMatchObject({ status: 'DEFERRED', queue: { position: null } });
    const left = await mutate('/api/arcade/queue/leave', 'queue-leave');
    expect(await left.json()).toMatchObject({ status: 'LEFT_QUEUE', queue: null });
    const checkIn = await mutate('/api/arcade/check-in', 'queue-check-in', { game: 'racer' });
    expect(checkIn.status).toBe(409);
    expect((await checkIn.json() as Record<string, any>).error.code).toBe('QUEUE_ENTRY_REQUIRED');
  });

  it('allows an authenticated player to leave an existing queue after mode switches off', async () => {
    const { baseUrl, store } = await harness({ playerMode: 'lead_capture' });
    const cookie = cookieFrom(await createPlayerSession(baseUrl, 'off-cleanup-player'));
    const mutate = (path: string, key: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    expect((await mutate('/api/arcade/register', 'off-cleanup-register', REGISTRATION)).status).toBe(200);
    expect((await mutate('/api/arcade/queue/join', 'off-cleanup-join', {
      preferredGame: 'racer', flexibleGame: false,
    })).status).toBe(200);
    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'switch-off-with-queue',
      updatedBy: 'admin@twilio.com',
      settings: settings('off'),
    });

    for (const [path, key, body] of [
      ['/api/arcade/queue/confirm', 'off-cleanup-confirm', {}],
      ['/api/arcade/queue/snooze', 'off-cleanup-snooze', {}],
      ['/api/arcade/check-in', 'off-cleanup-check-in', { game: 'racer' }],
    ] as const) {
      const blocked = await mutate(path, key, body);
      expect(blocked.status).toBe(409);
      expect((await blocked.json() as Record<string, any>).error.code).toBe('ARCADE_MODE_DISABLED');
    }
    expect((await fetch(`${baseUrl}/api/arcade/queue/status`, {
      headers: { Cookie: cookie },
    })).status).toBe(409);

    const left = await mutate('/api/arcade/queue/leave', 'off-cleanup-leave', {});
    expect(left.status).toBe(200);
    expect(await left.json()).toMatchObject({ status: 'LEFT_QUEUE', queue: null });
    expect((await createPlayerSession(baseUrl, 'new-off-session')).status).toBe(409);
  });

  it('issues player-bound challenge tokens and claims rewards atomically through POST', async () => {
    const { baseUrl, store } = await harness({ playerMode: 'lead_capture' });
    const cookie = cookieFrom(await createPlayerSession(baseUrl, 'challenge-player'));
    const registration = await fetch(`${baseUrl}/api/arcade/register`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'challenge-register',
      },
      body: JSON.stringify(REGISTRATION),
    });
    expect(registration.status).toBe(200);

    const listed = await fetch(`${baseUrl}/api/arcade/challenges`, { headers: { Cookie: cookie } });
    const listBody = await listed.json() as Record<string, any>;
    expect(listBody.challenges).toEqual([{
      id: 'voice-docs',
      title: 'Read the Voice docs',
      message: 'Read the Voice docs to earn another coin.',
      rewardCoins: 1,
      displayOrder: 0,
      claimCount: 0,
      maxClaimsPerPlayer: 1,
      available: true,
      startsAt: null,
      endsAt: null,
    }]);
    expect(JSON.stringify(listBody)).not.toMatch(/twilio\.com|destination|token|player:/i);

    const tokenResponse = await fetch(`${baseUrl}/api/arcade/challenges/voice-docs/token`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = await tokenResponse.json() as Record<string, any>;
    expect(tokenBody.challengeId).toBe('voice-docs');
    expect(typeof tokenBody.token).toBe('string');

    const claim = (key: string) => fetch(`${baseUrl}/api/arcade/challenges/voice-docs/claim`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      },
      body: JSON.stringify({ token: tokenBody.token }),
    });
    const first = await claim('challenge-claim');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      challengeId: 'voice-docs',
      rewardCoins: 1,
      availableBalance: 2,
      destinationUrl: 'https://www.twilio.com/docs/voice',
    });
    expect((await claim('challenge-claim')).status).toBe(200);
    const replayedToken = await claim('challenge-token-replay');
    expect(replayedToken.status).toBe(409);
    expect((await replayedToken.json() as Record<string, any>).error.code).toBe('CHALLENGE_TOKEN_REPLAYED');

    const movedCabinet = JSON.parse(JSON.stringify(settings('lead_capture'))) as Record<string, any>;
    movedCabinet.arcade.cabinetId = 'ARCADE-02';
    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'challenge-cabinet-change',
      updatedBy: 'admin@twilio.com',
      settings: movedCabinet,
    });
    expect((await claim('challenge-claim')).status).toBe(401);

    const after = await fetch(`${baseUrl}/api/arcade/challenges`, {
      headers: { Cookie: cookie },
    });
    expect(after.status).toBe(401);
  });

  it('serves a shortened visit-first messaging challenge hub without a browser player cookie', async () => {
    let portalDestination = '';
    const { baseUrl, api, playerRuntime } = await harness({
      playerMode: 'coin_only',
      shortenUrl: async url => { portalDestination = url; return 'https://go.example/reward'; },
    });
    const send = (providerMessageId: string, body: string) => api.processMessagingWebhook({
      from: '+14155550188', body, providerMessageId,
    });
    await send('SM-LINK-JOIN', 'JOIN');
    await send('SM-LINK-NAME', 'Ada');
    await send('SM-LINK-TERMS', 'YES');
    const more = await send('SM-LINK-MORE', 'MORE');
    expect(more).toContain('https://go.example/reward');
    expect(portalDestination).toContain('/challenge/?locale=en-US#');
    expect(await send('SM-LINK-MORE', 'MORE')).toBe(more);
    const token = decodeURIComponent(new URL(portalDestination).hash.slice(1));
    const statusEndpoint = `${baseUrl}/api/arcade/challenge-portal/status`;

    expect((await fetch(statusEndpoint)).status).toBe(405);
    expect((await fetch(statusEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    })).status).toBe(403);
    const post = (action: 'status'|'visit'|'claim', challengeId?: string) => fetch(`${baseUrl}/api/arcade/challenge-portal/${action}`, {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...(challengeId ? { challengeId } : {}) }),
    });
    expect(await (await post('status')).json()).toMatchObject({ challenges: [{ id: 'voice-docs', action: 'visit' }] });
    expect((await post('claim', 'voice-docs')).status).toBe(409);
    expect(await (await post('visit', 'voice-docs')).json()).toEqual({ destinationUrl: 'https://www.twilio.com/docs/voice' });
    const first = await post('claim', 'voice-docs');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      destinationUrl: 'https://www.twilio.com/docs/voice', availableBalance: 2, rewardCoins: 1,
    });
    expect((await post('claim', 'voice-docs')).status).toBe(200);
    expect(await (await post('status')).json()).toMatchObject({ challenges: [{ id: 'voice-docs', action: 'claimed' }] });
    const state = (await playerRuntime.getActive()).store.snapshot();
    expect(Object.values(state.wallets).flatMap(wallet => wallet.challengeClaims)).toHaveLength(1);
  });

  it('lets authenticated operators advance and release a player queue journey with audit reasons', async () => {
    const { baseUrl, store, playerRuntime } = await harness({ playerMode: 'lead_capture' });
    const cookie = cookieFrom(await createPlayerSession(baseUrl, 'operator-queue-player'));
    const playerMutation = (path: string, key: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    expect((await playerMutation('/api/arcade/register', 'operator-register', REGISTRATION)).status).toBe(200);
    expect((await playerMutation('/api/arcade/queue/join', 'operator-join', {
      preferredGame: 'racer', flexibleGame: false,
    })).status).toBe(200);

    expect((await fetch(`${baseUrl}/api/admin/arcade/queue`)).status).toBe(401);
    const queueResponse = await fetch(`${baseUrl}/api/admin/arcade/queue`, { headers: ADMIN_HEADER });
    const queueBody = await queueResponse.json() as Record<string, any>;
    expect(queueBody.queue).toHaveLength(1);
    expect(JSON.stringify(queueBody)).not.toMatch(/playerId|email|phone|company/i);
    const queueEntryId = queueBody.queue[0].queueEntryId as string;
    const operatorAction = (action: string, key: string, reason: string) => fetch(
      `${baseUrl}/api/admin/arcade/queue/${queueEntryId}/${action}`,
      {
        method: 'POST',
        headers: {
          ...ADMIN_HEADER,
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ reason }),
      },
    );

    expect((await operatorAction(
      'approach', 'operator-oversized-audit', '\ud800'.repeat(200),
    )).status).toBe(400);
    expect((await operatorAction('approach', 'operator-approach', 'two groups away')).status).toBe(200);
    expect((await playerMutation('/api/arcade/queue/confirm', 'operator-player-confirm', {})).status).toBe(200);
    expect((await operatorAction('call', 'operator-call', 'cabinet ready')).status).toBe(200);
    const checkedIn = await playerMutation('/api/arcade/check-in', 'operator-check-in', { game: 'racer' });
    expect(await checkedIn.json()).toMatchObject({
      status: 'CHECKED_IN', availableBalance: 0, reservation: { amount: 1, status: 'ACTIVE' },
    });
    expect((await operatorAction('activate', 'operator-activate', 'player at cabinet')).status).toBe(200);
    const state = (await playerRuntime.getActive()).store.snapshot();
    expect(state.queueEvents.find(event => event.type === 'MARKED_APPROACHING')?.reason)
      .toBe('{"operator":"admin@twilio.com","reason":"two groups away"}');
    const started = await fetch(`${baseUrl}/api/admin/arcade/matches/start`, {
      method: 'POST',
      headers: {
        ...ADMIN_HEADER, Origin: 'http://localhost',
        'Content-Type': 'application/json', 'Idempotency-Key': 'operator-match-start',
      },
      body: JSON.stringify({
        queueEntryIds: [queueEntryId], game: 'racer', reason: 'starting ready players',
      }),
    });
    expect(started.status).toBe(200);
    const startedBody = await started.json() as Record<string, any>;
    expect(startedBody).toMatchObject({
      entries: [{ queueEntryId, status: 'PLAYING' }],
    });

    await store.update({
      expectedVersion: 2,
      idempotencyKey: 'operator-switch-off',
      updatedBy: 'admin@twilio.com',
      settings: settings('off'),
    });
    const completed = await fetch(
      `${baseUrl}/api/admin/arcade/matches/${startedBody.matchId}/complete`,
      {
        method: 'POST',
        headers: {
          ...ADMIN_HEADER, Origin: 'http://localhost',
          'Content-Type': 'application/json', 'Idempotency-Key': 'operator-match-complete',
        },
        body: JSON.stringify({ queueEntryIds: [queueEntryId], reason: 'authoritative game result' }),
      },
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      matchId: startedBody.matchId,
      entries: [{ queueEntryId, status: 'COMPLETED' }],
    });
  });
});
