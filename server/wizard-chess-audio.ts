import type { SupportedLocale } from '../shared/i18n/locales';
import { WIZARD_CHESS_DIALOGUE, WIZARD_CHESS_VOICE_IDS } from '../shared/wizard-chess-scene';

const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const MAX_AUDIO_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 6_000;
const FAILURE_RETRY_MS = 15_000;
const AUTH_FAILURE_RETRY_MS = 60_000;

export class WizardChessAudioError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

/** Synthesizes only the scene's published lines. The API key never reaches the browser. */
export class WizardChessAudioService {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, Buffer>();
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  private readonly recentFailures = new Map<string, { error: WizardChessAudioError; retryAt: number }>();
  private authFailure: { error: WizardChessAudioError; retryAt: number } | null = null;

  constructor(options: { apiKey?: string; fetchImpl?: typeof fetch } = {}) {
    const configuredKey = (options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? '').trim();
    this.apiKey = configuredKey === 'disabled' ? '' : configuredKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured(): boolean { return Boolean(this.apiKey); }

  async get(lineId: string, locale: SupportedLocale): Promise<Buffer> {
    const line = WIZARD_CHESS_DIALOGUE.find(candidate => candidate.id === lineId);
    if (!line) throw new WizardChessAudioError(404, 'unknown_line');
    if (locale !== 'en-US' && locale !== 'pt-BR') {
      throw new WizardChessAudioError(400, 'invalid_locale');
    }
    if (!this.apiKey) throw new WizardChessAudioError(503, 'screen_audio_not_configured');

    const cacheKey = `${line.id}:${locale}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    if (this.authFailure) {
      if (this.authFailure.retryAt > Date.now()) throw this.authFailure.error;
      this.authFailure = null;
    }
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;
    const failed = this.recentFailures.get(cacheKey);
    if (failed && failed.retryAt > Date.now()) throw failed.error;
    this.recentFailures.delete(cacheKey);

    const request = this.synthesize(line.id, line.text[locale], WIZARD_CHESS_VOICE_IDS[line.speaker])
      .then(audio => {
        this.cache.set(cacheKey, audio);
        return audio;
      })
      .catch((error: WizardChessAudioError) => {
        this.recentFailures.set(cacheKey, { error, retryAt: Date.now() + FAILURE_RETRY_MS });
        throw error;
      })
      .finally(() => { this.inFlight.delete(cacheKey); });
    this.inFlight.set(cacheKey, request);
    return request;
  }

  private async synthesize(lineId: string, text: string, voiceId: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let upstreamStatus: number | 'none' = 'none';
    let failureReason = 'request_failed';
    try {
      const response = await this.fetchImpl(
        `${ELEVENLABS_URL}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
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
