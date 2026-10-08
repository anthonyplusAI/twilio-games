import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SupportedLocale } from '../shared/i18n/locales';
import {
  WIZARD_CHESS_AUDIO_MODEL_ID, WIZARD_CHESS_AUDIO_OUTPUT_FORMAT,
  WIZARD_CHESS_AUDIO_CUES, WIZARD_CHESS_DIALOGUE,
  WIZARD_CHESS_FINALE_CUES, WIZARD_CHESS_VOICE_IDS,
} from '../shared/wizard-chess-scene';

const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const MAX_AUDIO_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 20_000;
const FAILURE_RETRY_MS = 15_000;
const AUTH_FAILURE_RETRY_MS = 60_000;

function cacheKey(lineId: string, text: string, voiceId: string): string {
  // The key never contains the API credential. Changing a line, voice, model, or
  // output format creates a new file without serving stale narration after deploy.
  return createHash('sha256')
    .update(JSON.stringify([lineId, text, voiceId,
      WIZARD_CHESS_AUDIO_MODEL_ID, WIZARD_CHESS_AUDIO_OUTPUT_FORMAT]))
    .digest('hex');
}

function isMp3(audio: Buffer): boolean {
  if (audio.length < 4 || audio.length > MAX_AUDIO_BYTES) return false;
  return (audio.length >= 10 && audio.subarray(0, 3).toString('ascii') === 'ID3')
    || (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0);
}

export class WizardChessAudioError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

/** Synthesizes only the scene's fixed story and finale cues. The API key stays on the server. */
export class WizardChessAudioService {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheDir?: string;
  private readonly cache = new Map<string, Buffer>();
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  private readonly recentFailures = new Map<string, { error: WizardChessAudioError; retryAt: number }>();
  private authFailure: { error: WizardChessAudioError; retryAt: number } | null = null;

  constructor(options: { apiKey?: string; fetchImpl?: typeof fetch; cacheDir?: string } = {}) {
    const configuredKey = (options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? '').trim();
    this.apiKey = configuredKey === 'disabled' ? '' : configuredKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheDir = options.cacheDir;
  }

  get configured(): boolean { return Boolean(this.apiKey); }

  async get(lineId: string, locale: SupportedLocale): Promise<Buffer> {
    const line = WIZARD_CHESS_AUDIO_CUES.find(candidate => candidate.id === lineId);
    if (!line) throw new WizardChessAudioError(404, 'unknown_line');
    if (locale !== 'en-US' && locale !== 'pt-BR') {
      throw new WizardChessAudioError(400, 'invalid_locale');
    }
    const text = line.text[locale];
    const voiceId = WIZARD_CHESS_VOICE_IDS[line.speaker];
    const key = cacheKey(line.id, text, voiceId);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.loadOrSynthesize(key, line.id, text, voiceId)
      .finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, request);
    return request;
  }

  /** Warm the opening and climax first, then the rest, without more than two provider requests at once. */
  async prewarm(): Promise<void> {
    if (!this.apiKey) return;
    const prioritized = [
      ...WIZARD_CHESS_DIALOGUE.slice(0, 2),
      ...WIZARD_CHESS_FINALE_CUES,
      ...WIZARD_CHESS_DIALOGUE.slice(2),
    ];
    let next = 0;
    const warm = async () => {
      while (next < prioritized.length) {
        const line = prioritized[next++]!;
        try { await this.get(line.id, 'en-US'); }
        catch { /* synthesize logs safe diagnostics; the scene keeps captions */ }
      }
    };
    await Promise.all([warm(), warm()]);
  }

  private async loadOrSynthesize(key: string, lineId: string, text: string, voiceId: string): Promise<Buffer> {
    // Disk comes before key and provider cooldown checks so already-downloaded
    // clips still play if ElevenLabs is later unavailable or the key is removed.
    if (this.cacheDir) {
      const downloaded = await this.readDownloaded(key, lineId);
      if (downloaded) {
        this.cache.set(key, downloaded);
        return downloaded;
      }
    }
    if (!this.apiKey) throw new WizardChessAudioError(503, 'screen_audio_not_configured');
    if (this.authFailure) {
      if (this.authFailure.retryAt > Date.now()) throw this.authFailure.error;
      this.authFailure = null;
    }
    const failed = this.recentFailures.get(key);
    if (failed && failed.retryAt > Date.now()) throw failed.error;
    this.recentFailures.delete(key);

    try {
      const audio = await this.synthesize(lineId, text, voiceId);
      this.cache.set(key, audio);
      // Azure Files can be slow. A cache write must never postpone the first
      // audible line or keep same-process callers waiting on storage I/O.
      if (this.cacheDir) {
        void this.saveDownloaded(key, lineId, audio).catch(() => {
          console.warn(`[wizard-audio] lineId=${lineId} reason=cache_write_failed`);
        });
      }
      return audio;
    } catch (error) {
      if (error instanceof WizardChessAudioError) {
        this.recentFailures.set(key, { error, retryAt: Date.now() + FAILURE_RETRY_MS });
      }
      throw error;
    }
  }

  private async readDownloaded(key: string, lineId: string): Promise<Buffer | null> {
    const file = join(this.cacheDir!, `${key}.mp3`);
    try {
      const info = await stat(file);
      if (info.size > MAX_AUDIO_BYTES || info.size < 4) {
        console.warn(`[wizard-audio] lineId=${lineId} reason=cache_invalid`);
        return null;
      }
      const audio = await readFile(file);
      if (isMp3(audio)) return audio;
      console.warn(`[wizard-audio] lineId=${lineId} reason=cache_invalid`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[wizard-audio] lineId=${lineId} reason=cache_read_failed`);
      }
    }
    return null;
  }

  private async saveDownloaded(key: string, lineId: string, audio: Buffer): Promise<void> {
    const file = join(this.cacheDir!, `${key}.mp3`);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.cacheDir!, { recursive: true });
      await writeFile(temporary, audio, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch {
      // A cache outage must not turn an otherwise successful scene voice into a
      // failed HTTP response. RAM still deduplicates subsequent calls this run.
      console.warn(`[wizard-audio] lineId=${lineId} reason=cache_write_failed`);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async synthesize(lineId: string, text: string, voiceId: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let upstreamStatus: number | 'none' = 'none';
    let failureReason = 'request_failed';
    try {
      const response = await this.fetchImpl(
        `${ELEVENLABS_URL}/${encodeURIComponent(voiceId)}?output_format=${WIZARD_CHESS_AUDIO_OUTPUT_FORMAT}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({ text, model_id: WIZARD_CHESS_AUDIO_MODEL_ID }),
          signal: controller.signal,
        },
      );
      upstreamStatus = response.status;
      if (response.status === 401) {
        failureReason = 'authentication_failed';
        throw new WizardChessAudioError(503, 'screen_audio_auth_failed');
      }
      if (!response.ok) {
        failureReason = 'http_error';
        throw new WizardChessAudioError(502, 'screen_audio_upstream_unavailable');
      }
      if (!/^audio\/(?:mpeg|mp3)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        failureReason = 'invalid_content_type';
        throw new WizardChessAudioError(502, 'screen_audio_upstream_unavailable');
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (declaredLength > MAX_AUDIO_BYTES) {
        failureReason = 'audio_too_large';
        throw new WizardChessAudioError(502, 'screen_audio_too_large');
      }
      const body = response.body;
      if (!body) {
        failureReason = 'empty_audio';
        throw new WizardChessAudioError(502, 'screen_audio_empty');
      }
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_AUDIO_BYTES) {
          void reader.cancel().catch(() => {});
          failureReason = 'audio_too_large';
          throw new WizardChessAudioError(502, 'screen_audio_too_large');
        }
        chunks.push(value);
      }
      if (bytes === 0) {
        failureReason = 'empty_audio';
        throw new WizardChessAudioError(502, 'screen_audio_empty');
      }
      return Buffer.concat(chunks, bytes);
    } catch (error) {
      let failure: WizardChessAudioError;
      if (error instanceof WizardChessAudioError) failure = error;
      else if (controller.signal.aborted) {
        failureReason = 'timeout';
        failure = new WizardChessAudioError(504, 'screen_audio_timeout');
      } else failure = new WizardChessAudioError(502, 'screen_audio_upstream_unavailable');
      if (failure.code === 'screen_audio_auth_failed') {
        // A bad account key affects every voice. One diagnostic is enough until retry.
        if (this.authFailure && this.authFailure.retryAt > Date.now()) throw this.authFailure.error;
        this.authFailure = { error: failure, retryAt: Date.now() + AUTH_FAILURE_RETRY_MS };
      }
      // Fixed identifiers and an HTTP status are enough to diagnose inaccessible voices,
      // authentication, and quota failures. Never log the key, text, provider body, or error.
      console.warn(`[wizard-audio] lineId=${lineId} voiceId=${voiceId} upstreamStatus=${upstreamStatus} reason=${failureReason}`);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }
}
