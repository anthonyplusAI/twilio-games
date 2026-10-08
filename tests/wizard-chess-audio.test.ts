import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpServer } from '../server/http-server';
import { WizardChessAudioError, WizardChessAudioService } from '../server/wizard-chess-audio';
import { WIZARD_CHESS_AUDIO_CUES, WIZARD_CHESS_DIALOGUE,
  WIZARD_CHESS_FINALE_CUES, WIZARD_CHESS_VOICE_IDS } from '../shared/wizard-chess-scene';

const ronLine = WIZARD_CHESS_DIALOGUE.find(line => line.speaker === 'ron')!;
let server: HttpServer | null = null;
let directory = '';
const cacheDirectories: string[] = [];

afterEach(async () => {
  await server?.stop();
  server = null;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
  for (const cacheDirectory of cacheDirectories.splice(0)) {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function upstreamAudio(body = 'MP3DATA') {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
}

async function temporaryCacheDirectory(): Promise<string> {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'wizard-audio-cache-'));
  cacheDirectories.push(cacheDirectory);
  return cacheDirectory;
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
  it('routes Harry, Ron, and Hermione to their selected ElevenLabs voice IDs', async () => {
    const upstream = vi.fn(async () => upstreamAudio()) as unknown as typeof fetch;
    const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream });
    const selected = [
      ['harry', 'llNlEi50DSCIEuoOIaH7'],
      ['ron', 'bDTlr4ICxntY9qVWyL0o'],
      ['hermione', 'nDJIICjR9zfJExIFeSCN'],
    ] as const;

    for (const [speaker, voiceId] of selected) {
      const line = WIZARD_CHESS_DIALOGUE.find(candidate => candidate.speaker === speaker)!;
      await audio.get(line.id, 'en-US');
      const url = vi.mocked(upstream).mock.calls.at(-1)![0];
      expect(url).toContain(`/text-to-speech/${voiceId}`);
    }
  });

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

  it('serves the three separate finale reactions from the matching character voices and disk cache', async () => {
    const cacheDir = await temporaryCacheDirectory();
    const upstream = vi.fn(async (_url: string, init?: RequestInit) =>
      upstreamAudio(`ID3cue:${JSON.parse(String(init?.body)).text}`)) as unknown as typeof fetch;
    const original = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream, cacheDir });
    for (const cue of WIZARD_CHESS_FINALE_CUES) {
      expect((await original.get(cue.id, 'en-US')).toString()).toBe(`ID3cue:${cue.text['en-US']}`);
      const [url, init] = vi.mocked(upstream).mock.calls.at(-1)!;
      expect(url).toContain(`/text-to-speech/${WIZARD_CHESS_VOICE_IDS[cue.speaker]}`);
      expect(JSON.parse(String(init?.body))).toMatchObject({ text: cue.text['en-US'] });
    }
    await vi.waitFor(async () => expect((await readdir(cacheDir)).filter(name => name.endsWith('.mp3')))
      .toHaveLength(WIZARD_CHESS_FINALE_CUES.length));
    const offline = vi.fn(async () => { throw new Error('provider should not be called'); }) as unknown as typeof fetch;
    const restarted = new WizardChessAudioService({ apiKey: 'disabled', fetchImpl: offline, cacheDir });
    for (const cue of WIZARD_CHESS_FINALE_CUES) {
      expect((await restarted.get(cue.id, 'en-US')).toString()).toBe(`ID3cue:${cue.text['en-US']}`);
    }
    expect(offline).not.toHaveBeenCalled();
  });

  it('reuses downloaded scene audio across server instances even when the key is later unavailable', async () => {
    const cacheDir = await temporaryCacheDirectory();
    const upstream = vi.fn(async () => upstreamAudio('ID3DOWNLOADED-RON')) as unknown as typeof fetch;
    const first = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream, cacheDir });
    expect((await first.get(ronLine.id, 'en-US')).toString()).toBe('ID3DOWNLOADED-RON');

    await vi.waitFor(async () => expect((await readdir(cacheDir)).filter(file => file.endsWith('.mp3'))).toHaveLength(1));
    const files = (await readdir(cacheDir)).filter(file => file.endsWith('.mp3'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.mp3$/);
    expect((await readFile(join(cacheDir, files[0]!))).toString()).toBe('ID3DOWNLOADED-RON');
    expect(files[0]).not.toContain('local-test-key');

    const offline = vi.fn(async () => { throw new Error('provider should not be called'); }) as unknown as typeof fetch;
    const restarted = new WizardChessAudioService({ apiKey: 'disabled', fetchImpl: offline, cacheDir });
    expect((await restarted.get(ronLine.id, 'en-US')).toString()).toBe('ID3DOWNLOADED-RON');
    // The displayed Portuguese scene currently uses the same English text and voice.
    expect((await restarted.get(ronLine.id, 'pt-BR')).toString()).toBe('ID3DOWNLOADED-RON');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(offline).not.toHaveBeenCalled();
  });

  it('invalidates downloaded audio when a fixed line changes voice or text', async () => {
    const cacheDir = await temporaryCacheDirectory();
    const upstream = vi.fn(async (_url: string, init?: RequestInit) => {
      const text = JSON.parse(String(init?.body)).text as string;
      return upstreamAudio(`ID3clip-${text.length}`);
    }) as unknown as typeof fetch;
    const voiceIds = WIZARD_CHESS_VOICE_IDS as Record<'ron' | 'harry' | 'hermione', string>;
    const text = ronLine.text as Record<'en-US' | 'pt-BR', string>;
    const originalVoice = voiceIds.ron;
    const originalText = text['en-US'];
    try {
      await new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream, cacheDir })
        .get(ronLine.id, 'en-US');
      voiceIds.ron = 'another-ron-voice-id';
      await new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream, cacheDir })
        .get(ronLine.id, 'en-US');
      text['en-US'] = `${originalText} A revised line.`;
      await new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream, cacheDir })
        .get(ronLine.id, 'en-US');

      expect(upstream).toHaveBeenCalledTimes(3);
      await vi.waitFor(async () => expect((await readdir(cacheDir)).filter(file => file.endsWith('.mp3'))).toHaveLength(3));
    } finally {
      voiceIds.ron = originalVoice;
      text['en-US'] = originalText;
    }
  });

  it('treats a truncated cached file as a miss and replaces it with fresh audio', async () => {
    const cacheDir = await temporaryCacheDirectory();
    const upstream = vi.fn()
      .mockResolvedValueOnce(upstreamAudio('ID3ORIGINAL-CLIP'))
      .mockResolvedValueOnce(upstreamAudio('ID3REPAIRED-CLIP')) as unknown as typeof fetch;
    await new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream, cacheDir })
      .get(ronLine.id, 'en-US');
    await vi.waitFor(async () => expect((await readdir(cacheDir)).filter(file => file.endsWith('.mp3'))).toHaveLength(1));
    const [file] = (await readdir(cacheDir)).filter(name => name.endsWith('.mp3'));
    await writeFile(join(cacheDir, file!), 'truncated');

    const restarted = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream, cacheDir });
    expect((await restarted.get(ronLine.id, 'en-US')).toString()).toBe('ID3REPAIRED-CLIP');
    await vi.waitFor(async () => expect((await readFile(join(cacheDir, file!))).toString()).toBe('ID3REPAIRED-CLIP'));
    expect((await readFile(join(cacheDir, file!))).toString()).toBe('ID3REPAIRED-CLIP');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('still narrates when persistent storage cannot be written', async () => {
    const directory = await temporaryCacheDirectory();
    const cacheDir = join(directory, 'not-a-directory');
    await writeFile(cacheDir, 'occupied');
    const upstream = vi.fn(async () => upstreamAudio()) as unknown as typeof fetch;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream, cacheDir });

    expect((await audio.get(ronLine.id, 'en-US')).toString()).toBe('MP3DATA');
    expect((await audio.get(ronLine.id, 'en-US')).toString()).toBe('MP3DATA');
    expect(upstream).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(warning.mock.calls.some(call => String(call[0]).includes('cache_write_failed'))).toBe(true));
  });

  it('serves generated narration without waiting for a stalled persistent write', async () => {
    const cacheDir = await temporaryCacheDirectory();
    const upstream = vi.fn(async () => upstreamAudio('ID3READY-NOW')) as unknown as typeof fetch;
    const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream, cacheDir });
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    const storage = audio as unknown as {
      saveDownloaded: (key: string, lineId: string, bytes: Buffer) => Promise<void>;
    };
    const write = vi.spyOn(storage, 'saveDownloaded').mockReturnValue(blockedWrite);
    let returned = false;
    const request = audio.get(ronLine.id, 'en-US').then(clip => {
      returned = true;
      return clip;
    });
    try {
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(returned).toBe(true), { timeout: 300 });
    } finally {
      releaseWrite();
      await request;
    }
    expect((await request).toString()).toBe('ID3READY-NOW');
  });

  it('prewarms fixed dialogue with no more than two concurrent provider requests', async () => {
    let active = 0;
    let peak = 0;
    const upstream = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return upstreamAudio();
    }) as unknown as typeof fetch;
    const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream });

    await audio.prewarm();

    expect(upstream).toHaveBeenCalledTimes(WIZARD_CHESS_AUDIO_CUES.length);
    expect(new Set(vi.mocked(upstream).mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)).text as string)))
      .toEqual(new Set(WIZARD_CHESS_AUDIO_CUES.map(cue => cue.text['en-US'])));
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
    await audio.prewarm();
    expect(upstream).toHaveBeenCalledTimes(WIZARD_CHESS_AUDIO_CUES.length);
  });

  it('continues warming later lines when one earlier voice is slow', async () => {
    let releaseRon!: (response: Response) => void;
    const slowRon = new Promise<Response>(resolve => { releaseRon = resolve; });
    const upstream = vi.fn(async (_url: string, init?: RequestInit) => {
      const text = JSON.parse(String(init?.body)).text as string;
      return text === ronLine.text['en-US'] ? slowRon : upstreamAudio();
    }) as unknown as typeof fetch;
    const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream });
    const warming = audio.prewarm();
    try {
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(vi.mocked(upstream).mock.calls.length).toBeGreaterThan(2), { timeout: 300 });
    } finally {
      releaseRon(upstreamAudio());
      await warming;
    }
  });

  it('never sends arbitrary text or an unknown line to the provider', async () => {
    const upstream = vi.fn(async () => upstreamAudio()) as unknown as typeof fetch;
    const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream });
    await expect(audio.get('please-read-my-custom-text', 'en-US')).rejects.toMatchObject({
      status: 404, code: 'unknown_line',
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('allows a longer character line to finish synthesizing after six seconds', async () => {
    vi.useFakeTimers();
    try {
      const upstream = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(upstreamAudio()), 7_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;
      const audio = new WizardChessAudioService({ apiKey: 'local-test-key', fetchImpl: upstream });

      const result = audio.get(ronLine.id, 'en-US')
        .then(body => body.toString(), (error: WizardChessAudioError) => error.code);
      await vi.advanceTimersByTimeAsync(7_000);

      expect(await result).toBe('MP3DATA');
    } finally {
      vi.useRealTimers();
    }
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
    const finale = WIZARD_CHESS_FINALE_CUES[0]!;
    const finaleResponse = await fetch(`${base}/api/chess/wizard-audio/${finale.id}?locale=en-US`);
    expect(finaleResponse.status).toBe(200);
    expect(JSON.parse(String(vi.mocked(upstream).mock.calls[1]![1]!.body)).text)
      .toBe(finale.text['en-US']);
    const missing = await fetch(`${base}/api/chess/wizard-audio/custom-input?locale=en-US`);
    expect(missing.status).toBe(404);
    const invalidLocale = await fetch(`${base}/api/chess/wizard-audio/${ronLine.id}?locale=fr-FR`);
    expect(invalidLocale.status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(2);
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
