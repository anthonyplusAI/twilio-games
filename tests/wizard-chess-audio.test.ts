import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpServer } from '../server/http-server';
import { WizardChessAudioError, WizardChessAudioService } from '../server/wizard-chess-audio';
import { WIZARD_CHESS_DIALOGUE, WIZARD_CHESS_VOICE_IDS } from '../shared/wizard-chess-scene';

const ronLine = WIZARD_CHESS_DIALOGUE.find(line => line.speaker === 'ron')!;
let server: HttpServer | null = null;
let directory = '';

afterEach(async () => {
  await server?.stop();
  server = null;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
  vi.restoreAllMocks();
});

function upstreamAudio(body = 'MP3DATA') {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
}

async function startHttp(audio: WizardChessAudioService): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'wizard-screen-audio-'));
  server = new HttpServer({
    port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
    wizardChessAudio: audio,
    manifestPath: join(directory, 'manifest.json'),
    mapsPath: join(directory, 'maps.json'),
    arenaPath: join(directory, 'arena.json'),
    leaderboardPath: join(directory, 'leaderboard.json'),
    fighterMapsPath: join(directory, 'fighter-maps.json'),
    fighterPreviewDir: join(directory, 'fighter-previews'),
    analyticsPath: join(directory, 'analytics.json'),
    clientDir: join(directory, 'client'),
  });
  return `http://127.0.0.1:${await server.start()}`;
}

describe('Wizard Chess screen narration', () => {
  it('selects the supplied character voice and fixed localized line, then deduplicates and caches audio', async () => {
    let release!: (response: Response) => void;
    const upstream = vi.fn(() => new Promise<Response>(resolve => { release = resolve; })) as unknown as typeof fetch;
    const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream });

    const first = audio.get(ronLine.id, 'en-US');
    const second = audio.get(ronLine.id, 'en-US');
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(upstream).mock.calls[0]!;
    expect(url).toContain(`/text-to-speech/${WIZARD_CHESS_VOICE_IDS.ron}`);
    expect((init!.headers as Record<string, string>)['xi-api-key']).toBe('local-test-key');
    expect(JSON.parse(String(init!.body))).toEqual({
      text: ronLine.text['en-US'], model_id: 'eleven_flash_v2_5',
    });

    release(upstreamAudio());
    expect((await first).toString()).toBe('MP3DATA');
    expect(await second).toBe(await first);
    expect(await audio.get(ronLine.id, 'en-US')).toBe(await first);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('never sends arbitrary text or an unknown line to the provider', async () => {
    const upstream = vi.fn(async () => upstreamAudio()) as unknown as typeof fetch;
    const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream });
    await expect(audio.get('please-read-my-custom-text', 'en-US')).rejects.toMatchObject({
      status: 404, code: 'unknown_line',
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('treats a missing or disabled key as optional and fails closed on bad upstream audio', async () => {
    const noKey = new WizardChessAudioService({ apiKey: 'disabled' });
    expect(noKey.configured).toBe(false);
    await expect(noKey.get(ronLine.id, 'en-US')).rejects.toMatchObject({
      status: 503, code: 'screen_audio_not_configured',
    } satisfies Partial<WizardChessAudioError>);

    const upstream = vi.fn(async () => new Response('{"error":"unavailable"}', {
      status: 429, headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream });
    await expect(audio.get(ronLine.id, 'pt-BR')).rejects.toMatchObject({
      status: 502, code: 'screen_audio_upstream_unavailable',
    });
    // A brief cooldown prevents repeated public requests from hammering a failed provider.
    await expect(audio.get(ronLine.id, 'pt-BR')).rejects.toMatchObject({ status: 502 });
    expect(upstream).toHaveBeenCalledTimes(1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16_000);
    await expect(audio.get(ronLine.id, 'pt-BR')).rejects.toMatchObject({ status: 502 });
    expect(upstream).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });

  it('logs only fixed identifiers and upstream status when a voice is inaccessible', async () => {
    const hermioneLine = WIZARD_CHESS_DIALOGUE.find(line => line.speaker === 'hermione')!;
    const secret = 'secret-key-must-not-appear';
    const providerBody = `private-provider-error-containing-${secret}`;
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const upstream = vi.fn(async () => new Response(providerBody, {
      status: 403, headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const audio = new WizardChessAudioService({ apiKey: secret, fetchImpl: upstream });

    await expect(audio.get(hermioneLine.id, 'en-US')).rejects.toMatchObject({
      status: 502, code: 'screen_audio_upstream_unavailable',
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `[wizard-audio] lineId=${hermioneLine.id} voiceId=${WIZARD_CHESS_VOICE_IDS.hermione} upstreamStatus=403 reason=http_error`,
    );
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(providerBody);
    expect(logged).not.toContain(hermioneLine.text['en-US']);
  });

  it('suppresses all voices for one minute after a 401 and returns a safe 503 to the display', async () => {
    const hermioneLine = WIZARD_CHESS_DIALOGUE.find(line => line.speaker === 'hermione')!;
    const secret = 'bad-secret-key-must-not-appear';
    const providerBody = `private-auth-error-containing-${secret}`;
    let attempts = 0;
    const upstream = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(providerBody, { status: 401, headers: { 'Content-Type': 'application/json' } })
        : upstreamAudio();
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const audio = new WizardChessAudioService({ apiKey: secret, fetchImpl: upstream });

    await expect(audio.get(ronLine.id, 'en-US')).rejects.toMatchObject({
      status: 503, code: 'screen_audio_auth_failed',
    });
    const base = await startHttp(audio);
    const blocked = await fetch(`${base}/api/chess/wizard-audio/${hermioneLine.id}?locale=en-US`);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ error: 'screen_audio_auth_failed' });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `[wizard-audio] lineId=${ronLine.id} voiceId=${WIZARD_CHESS_VOICE_IDS.ron} upstreamStatus=401 reason=authentication_failed`,
    );
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(providerBody);
    expect(logged).not.toContain(ronLine.text['en-US']);

    clock.mockReturnValue(now + 60_001);
    expect((await audio.get(hermioneLine.id, 'en-US')).toString()).toBe('MP3DATA');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('distinguishes invalid provider audio from an HTTP error without logging its body', async () => {
    const providerBody = 'private-error-message';
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const upstream = vi.fn(async () => new Response(providerBody, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream });

    await expect(audio.get(ronLine.id, 'en-US')).rejects.toMatchObject({ status: 502 });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `[wizard-audio] lineId=${ronLine.id} voiceId=${WIZARD_CHESS_VOICE_IDS.ron} upstreamStatus=200 reason=invalid_content_type`,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(providerBody);
  });

  it('serves only fixed narration IDs through the HTTP route without exposing the key', async () => {
    const upstream = vi.fn(async () => upstreamAudio()) as unknown as typeof fetch;
    const audio = new WizardChessAudioService({ apiKey: 'private-test-key', fetchImpl: upstream });
    const base = await startHttp(audio);
    const response = await fetch(`${base}/api/chess/wizard-audio/${ronLine.id}?locale=pt-BR`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(await response.text()).toBe('MP3DATA');
    expect(JSON.parse(String(vi.mocked(upstream).mock.calls[0]![1]!.body)).text)
      .toBe(ronLine.text['pt-BR']);
    const missing = await fetch(`${base}/api/chess/wizard-audio/custom-input?locale=en-US`);
    expect(missing.status).toBe(404);
    const invalidLocale = await fetch(`${base}/api/chess/wizard-audio/${ronLine.id}?locale=fr-FR`);
    expect(invalidLocale.status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await missing.json())).not.toContain('private-test-key');
  });

  it('reports optional unconfigured audio so the display can use its fallback', async () => {
    const base = await startHttp(new WizardChessAudioService({ apiKey: 'disabled' }));
    const response = await fetch(`${base}/api/chess/wizard-audio/${ronLine.id}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'screen_audio_not_configured' });
    const health = await (await fetch(`${base}/healthz`)).json() as Record<string, unknown>;
    expect(health.wizardScreenAudio).toBe('unavailable');
  });
});
