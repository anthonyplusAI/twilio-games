import type { KaraokeSong } from '../../shared/karaoke';
import type { KaraokePhase } from '../../shared/karaoke-protocol';
import { karaokeAudioSchedule } from './karaoke-client-utils';

export type KaraokeWaveform = 'sine' | 'triangle' | 'square' | 'noise';

export interface KaraokeBackingEvent {
  readonly kind: 'kick' | 'snare' | 'hat' | 'bass' | 'chord';
  readonly timeSeconds: number;
  readonly durationSeconds: number;
  readonly frequency: number;
  readonly gain: number;
  readonly waveform: KaraokeWaveform;
}

const midiFrequency = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** Produces a deterministic, song-length arrangement consumed by the browser synthesizer. */
export function karaokeBackingPlan(song: KaraokeSong): readonly KaraokeBackingEvent[] {
  const durationSeconds = song.durationMs / 1000;
  const beatSeconds = 60 / song.bpm;
  const events: KaraokeBackingEvent[] = [];
  const progression = [48, 44, 41, 43] as const;
  const totalBeats = Math.ceil(durationSeconds / beatSeconds);
  for (let beat = 0; beat < totalBeats; beat++) {
    const timeSeconds = beat * beatSeconds;
    if (timeSeconds >= durationSeconds) break;
    events.push({ kind: 'kick', timeSeconds, durationSeconds: .22, frequency: 54, gain: .55, waveform: 'sine' });
    if (beat % 4 === 1 || beat % 4 === 3) {
      events.push({ kind: 'snare', timeSeconds, durationSeconds: .16, frequency: 180, gain: .19, waveform: 'noise' });
    }
    events.push({ kind: 'hat', timeSeconds, durationSeconds: .055, frequency: 5_200, gain: .07, waveform: 'noise' });
    const bassMidi = progression[Math.floor(beat / 8) % progression.length]!;
    events.push({
      kind: 'bass', timeSeconds, durationSeconds: beatSeconds * .72,
      frequency: midiFrequency(bassMidi), gain: .17, waveform: 'triangle',
    });
    if (beat % 4 === 0) {
      for (const interval of [0, 7, 12]) {
        events.push({
          kind: 'chord', timeSeconds, durationSeconds: beatSeconds * 3.6,
          frequency: midiFrequency(bassMidi + 12 + interval), gain: .038, waveform: 'sine',
        });
      }
    }
    const halfBeat = timeSeconds + beatSeconds / 2;
    if (halfBeat < durationSeconds) {
      events.push({ kind: 'hat', timeSeconds: halfBeat, durationSeconds: .04, frequency: 6_400, gain: .045, waveform: 'noise' });
    }
  }
  return Object.freeze(events.sort((a, b) => a.timeSeconds - b.timeSeconds));
}

type BrowserAudioContext = AudioContext & {
  createBuffer: AudioContext['createBuffer'];
  getOutputTimestamp?: () => AudioTimestamp;
  outputLatency?: number;
};

export type KaraokeAudioLatencySource = 'output-timestamp' | 'output-latency' | 'base-latency' | 'none';

export interface KaraokeAudioTimeline {
  readonly rawTimeMs: number;
  readonly presentationTimeMs: number;
  readonly estimatedOutputLatencyMs: number;
  readonly latencySource: KaraokeAudioLatencySource;
}

interface KaraokeOutputClock {
  contextTimeSeconds: number;
  latencySeconds: number;
  source: KaraokeAudioLatencySource;
}

interface PendingAudioBuffer {
  readonly request: Promise<AudioBuffer>;
  readonly controller: AbortController;
  readonly progressListeners: Set<(progress: number) => void>;
  progress: number;
  consumers: number;
  finished: boolean;
}

function audioBufferKey(song: KaraokeSong): string {
  return `${song.id}\u0000${song.audioUrl ?? 'synthesized'}`;
}

function abortedPreload(): DOMException {
  return new DOMException('Backing track preload was canceled.', 'AbortError');
}

/** Keeps optional early work limited to the song currently selected by the room. */
export class KaraokeSelectedSongPreloader {
  private selected: {
    key: string;
    controller: AbortController;
    deadline: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private phase: KaraokePhase | null = null;

  constructor(
    private readonly audio: Pick<KaraokeAudioTransport, 'preload'>,
    private readonly timeoutMs = 10_000,
  ) {}

  update(phase: KaraokePhase, song: KaraokeSong | null): void {
    const returningFromLoading = this.phase === 'loading' && phase === 'song_select';
    this.phase = phase;
    const key = song ? audioBufferKey(song) : '';
    if (phase === 'song_select' && song) {
      if (!returningFromLoading && this.selected?.key === key) return;
      this.clearSelected();
      const controller = new AbortController();
      const deadline = setTimeout(() => {
        if (this.selected?.controller !== controller) return;
        this.selected.deadline = null;
        controller.abort();
      }, this.timeoutMs);
      this.selected = { key, controller, deadline };
      // A selection preload is opportunistic; loading reports any failure and can retry.
      void this.audio.preload(song, undefined, controller.signal).catch(() => {}).finally(() => {
        if (this.selected?.controller !== controller || this.selected.deadline === null) return;
        clearTimeout(this.selected.deadline);
        this.selected.deadline = null;
      });
      return;
    }
    // The loading phase must be able to attach to the same in-flight request.
    if (phase === 'loading' && this.selected?.key === key) return;
    this.clearSelected();
  }

  dispose(): void {
    this.clearSelected();
    this.phase = null;
  }

  private clearSelected(): void {
    const selected = this.selected;
    if (!selected) return;
    this.selected = null;
    if (selected.deadline !== null) clearTimeout(selected.deadline);
    selected.controller.abort();
  }
}

export class KaraokeAudioTransport {
  private context: BrowserAudioContext | null = null;
  private master: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Map<string, PendingAudioBuffer>();
  private activeSong: KaraokeSong | null = null;
  private activeStartedAtMs: number | null = null;
  private contextStartedAt = 0;
  private offsetSeconds = 0;
  private lastRawTimeMs = 0;
  private lastPresentationTimeMs = 0;
  private muted = false;
  private blocked = false;
  private blockedCallback?: (blocked: boolean) => void;
  private runningCallback?: (running: boolean) => void;
  private contextStateListener?: () => void;

  onAutoplayBlocked(callback: (blocked: boolean) => void): void {
    this.blockedCallback = callback;
    callback(this.blocked);
  }

  onRunningStateChange(callback: (running: boolean) => void): void {
    this.runningCallback = callback;
    callback(this.isRunning());
  }

  isRunning(): boolean { return this.context?.state === 'running'; }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : .82;
  }

  async preload(
    song: KaraokeSong,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw abortedPreload();
    const key = audioBufferKey(song);
    if (this.buffers.has(key)) { onProgress?.(1); return; }
    let pending = this.pending.get(key);
    if (!pending) {
      const context = this.ensureContext();
      const controller = new AbortController();
      const progressListeners = new Set<(progress: number) => void>();
      const reportProgress = (progress: number): void => {
        entry.progress = progress;
        for (const listener of progressListeners) {
          try { listener(progress); }
          catch (error) { console.error('Karaoke audio progress listener failed.', error); }
        }
      };
      const entry: PendingAudioBuffer = {
        controller, progressListeners, progress: 0, consumers: 0, finished: false,
        request: Promise.resolve().then(() => {
          if (controller.signal.aborted) throw abortedPreload();
          return song.audioUrl
            ? this.loadRemoteBuffer(context, song.audioUrl, reportProgress, controller.signal)
            : this.synthesizeBacking(context, song, reportProgress, controller.signal);
        }),
      };
      pending = entry;
      this.pending.set(key, entry);
      void entry.request.then(buffer => {
        entry.finished = true;
        if (this.pending.get(key) !== entry) return;
        this.buffers.set(key, buffer);
        this.pending.delete(key);
        reportProgress(1);
      }, () => {
        entry.finished = true;
        if (this.pending.get(key) === entry) this.pending.delete(key);
      });
    }
    pending.consumers += 1;
    let onAbort: (() => void) | undefined;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (onProgress) pending.progressListeners.delete(onProgress);
      pending.consumers -= 1;
      if (pending.consumers === 0 && !pending.finished && this.pending.get(key) === pending) {
        this.pending.delete(key);
        pending.controller.abort();
      }
    };
    try {
      if (onProgress) {
        pending.progressListeners.add(onProgress);
        onProgress(pending.progress);
      }
      if (signal) {
        await Promise.race([
          pending.request,
          new Promise<never>((_, reject) => {
            onAbort = () => {
              release();
              reject(abortedPreload());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]);
      } else await pending.request;
    } finally { release(); }
  }

  isReady(song: KaraokeSong): boolean { return this.buffers.has(audioBufferKey(song)); }

  /** Schedules or seeks playback against an absolute server start, including reconnect drift repair. */
  async sync(song: KaraokeSong, startedAtMs: number, serverNowMs: number): Promise<void> {
    if (!this.buffers.has(audioBufferKey(song))) await this.preload(song);
    const context = this.ensureContext();
    const samePerformance = this.activeSong?.id === song.id
      && this.activeSong.audioUrl === song.audioUrl
      && this.activeStartedAtMs === startedAtMs
      && this.source;
    if (samePerformance && context.state === 'running' && serverNowMs >= startedAtMs) {
      const drift = Math.abs(this.currentTimeMs(serverNowMs) - (serverNowMs - startedAtMs));
      if (drift < 280) return;
    } else if (samePerformance && context.state === 'running') return;
    this.startSource(song, startedAtMs, serverNowMs);
    try {
      await context.resume();
      this.updateContextState();
    } catch {
      this.setBlocked(true);
    }
    this.updateContextState();
  }

  /** Retries autoplay and seeks to the current absolute song position after a user gesture. */
  async recover(serverNowMs: number): Promise<boolean> {
    const context = this.ensureContext();
    const wasRunning = context.state === 'running';
    try { await context.resume(); }
    catch { this.setBlocked(true); return false; }
    if (context.state !== 'running') { this.setBlocked(true); return false; }
    if (!wasRunning && this.activeSong && this.activeStartedAtMs !== null) {
      this.startSource(this.activeSong, this.activeStartedAtMs, serverNowMs);
    }
    this.updateContextState();
    return true;
  }

  currentTimeMs(serverNowMs: number): number {
    return this.timeline(serverNowMs).rawTimeMs;
  }

  presentationTimeMs(serverNowMs: number): number {
    return this.timeline(serverNowMs).presentationTimeMs;
  }

  /** Reports both the render clock and the context time estimated to be reaching the speakers. */
  timeline(serverNowMs: number): KaraokeAudioTimeline {
    const output = this.outputClock();
    if (!this.activeSong || this.activeStartedAtMs === null) {
      return Object.freeze({
        rawTimeMs: 0,
        presentationTimeMs: 0,
        estimatedOutputLatencyMs: output.latencySeconds * 1000,
        latencySource: output.source,
      });
    }
    let rawTimeMs: number;
    let presentationTimeMs: number;
    if (!this.context || this.context.state !== 'running') {
      rawTimeMs = this.boundSongTime(serverNowMs - this.activeStartedAtMs);
      presentationTimeMs = rawTimeMs;
    } else {
      rawTimeMs = this.boundSongTime((
        this.offsetSeconds + Math.max(0, this.context.currentTime - this.contextStartedAt)
      ) * 1000);
      presentationTimeMs = this.boundSongTime((
        this.offsetSeconds + output.contextTimeSeconds - this.contextStartedAt
      ) * 1000);
    }
    this.lastRawTimeMs = Math.max(this.lastRawTimeMs, rawTimeMs);
    this.lastPresentationTimeMs = Math.max(
      this.lastPresentationTimeMs,
      Math.min(this.lastRawTimeMs, presentationTimeMs),
    );
    return Object.freeze({
      rawTimeMs: this.lastRawTimeMs,
      presentationTimeMs: this.lastPresentationTimeMs,
      estimatedOutputLatencyMs: output.latencySeconds * 1000,
      latencySource: output.source,
    });
  }

  estimatedOutputLatencyMs(): number {
    return this.outputClock().latencySeconds * 1000;
  }

  stop(): void {
    if (this.source) {
      try { this.source.stop(); } catch { /* source already ended */ }
      this.source.disconnect();
    }
    this.source = null;
    this.activeSong = null;
    this.activeStartedAtMs = null;
    this.offsetSeconds = 0;
    this.lastRawTimeMs = 0;
    this.lastPresentationTimeMs = 0;
  }

  dispose(): void {
    this.stop();
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
    this.buffers.clear();
    if (this.contextStateListener) this.context?.removeEventListener('statechange', this.contextStateListener);
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.contextStateListener = undefined;
  }

  private ensureContext(): BrowserAudioContext {
    if (this.context) return this.context;
    const Constructor = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) throw new Error('Web Audio is not supported by this browser.');
    const context = new Constructor() as BrowserAudioContext;
    const master = context.createGain();
    master.gain.value = this.muted ? 0 : .82;
    master.connect(context.destination);
    this.context = context;
    this.master = master;
    this.contextStateListener = () => this.updateContextState();
    context.addEventListener('statechange', this.contextStateListener);
    this.updateContextState();
    return context;
  }

  private startSource(song: KaraokeSong, startedAtMs: number, serverNowMs: number): void {
    const context = this.ensureContext();
    const buffer = this.buffers.get(audioBufferKey(song));
    if (!buffer) throw new Error(`Audio for ${song.id} is not ready.`);
    const continuingPerformance = this.activeSong?.id === song.id
      && this.activeSong.audioUrl === song.audioUrl
      && this.activeStartedAtMs === startedAtMs;
    if (this.source) {
      try { this.source.stop(); } catch { /* source already ended */ }
      this.source.disconnect();
    }
    const schedule = karaokeAudioSchedule(startedAtMs, serverNowMs, context.currentTime, song.durationMs);
    this.activeSong = song;
    this.activeStartedAtMs = startedAtMs;
    this.contextStartedAt = schedule.contextStartTime;
    this.offsetSeconds = schedule.offsetSeconds;
    if (!continuingPerformance) {
      this.lastRawTimeMs = 0;
      this.lastPresentationTimeMs = 0;
    }
    if (schedule.ended) { this.source = null; return; }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master!);
    source.start(schedule.contextStartTime, schedule.offsetSeconds);
    source.onended = () => { if (this.source === source) this.source = null; };
    this.source = source;
  }

  private async loadRemoteBuffer(
    context: BrowserAudioContext,
    url: string,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<AudioBuffer> {
    onProgress?.(.08);
    const response = await fetch(url, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`Backing track request failed (${response.status}).`);
    const bytes = await response.arrayBuffer();
    if (signal?.aborted) throw abortedPreload();
    onProgress?.(.62);
    const decoded = await context.decodeAudioData(bytes);
    if (signal?.aborted) throw abortedPreload();
    onProgress?.(.96);
    return decoded;
  }

  private async synthesizeBacking(
    context: BrowserAudioContext,
    song: KaraokeSong,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<AudioBuffer> {
    // Let the selection state paint before allocating and generating a full song buffer.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (signal?.aborted) throw abortedPreload();
    const sampleRate = Math.min(44_100, context.sampleRate);
    const length = Math.ceil(song.durationMs / 1000 * sampleRate);
    const buffer = context.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const plan = karaokeBackingPlan(song);
    let seed = 0x4b415241;
    const noise = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0xffff_ffff * 2 - 1;
    };
    for (const [eventIndex, event] of plan.entries()) {
      if (eventIndex > 0 && eventIndex % 32 === 0) {
        // Building a procedural backing track should leave time for menu input and painting.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (signal?.aborted) throw abortedPreload();
      }
      const start = Math.max(0, Math.floor(event.timeSeconds * sampleRate));
      const end = Math.min(length, start + Math.ceil(event.durationSeconds * sampleRate));
      const pan = event.kind === 'hat' ? (eventIndex % 2 ? .28 : -.28) : 0;
      for (let sample = start; sample < end; sample++) {
        const time = (sample - start) / sampleRate;
        const progress = (sample - start) / Math.max(1, end - start);
        const attack = Math.min(1, time / (event.kind === 'chord' ? .18 : .012));
        const envelope = attack * (1 - progress) ** (event.kind === 'chord' ? 1.3 : 2.2);
        let wave: number;
        if (event.waveform === 'noise') wave = noise();
        else {
          const phase = time * event.frequency * Math.PI * 2;
          wave = event.waveform === 'square' ? Math.sign(Math.sin(phase))
            : event.waveform === 'triangle' ? Math.asin(Math.sin(phase)) * 2 / Math.PI
            : Math.sin(phase);
          if (event.kind === 'kick') wave = Math.sin(phase * (1.8 - progress * .8));
        }
        const value = wave * envelope * event.gain;
        left[sample] = (left[sample] ?? 0) + value * (1 - Math.max(0, pan));
        right[sample] = (right[sample] ?? 0) + value * (1 + Math.min(0, pan));
      }
      if (eventIndex % 80 === 0) onProgress?.(.08 + .82 * eventIndex / plan.length);
    }
    return buffer;
  }

  private outputClock(): KaraokeOutputClock {
    const context = this.context;
    if (!context) return { contextTimeSeconds: 0, latencySeconds: 0, source: 'none' };
    const rawContextTime = context.currentTime;
    if (context.state === 'running' && typeof context.getOutputTimestamp === 'function') {
      try {
        const timestamp = context.getOutputTimestamp();
        const timestampContextTime = timestamp.contextTime;
        const timestampPerformanceTime = timestamp.performanceTime;
        const now = performance.now();
        const ageSeconds = typeof timestampPerformanceTime === 'number'
          ? (now - timestampPerformanceTime) / 1000
          : Number.NaN;
        const outputContextTime = typeof timestampContextTime === 'number'
          ? timestampContextTime + Math.max(0, ageSeconds)
          : Number.NaN;
        const latencySeconds = rawContextTime - outputContextTime;
        if ([timestampContextTime, timestampPerformanceTime, ageSeconds, outputContextTime, latencySeconds]
          .every(Number.isFinite)
          && typeof timestampContextTime === 'number' && timestampContextTime >= 0
          && typeof timestampPerformanceTime === 'number' && timestampPerformanceTime >= 0
          && ageSeconds >= -.05 && ageSeconds <= 1
          && latencySeconds >= -.01) {
          return {
            contextTimeSeconds: Math.min(rawContextTime, Math.max(0, outputContextTime)),
            latencySeconds: Math.max(0, latencySeconds),
            source: 'output-timestamp',
          };
        }
      } catch { /* Some browsers expose the API before an output timestamp is available. */ }
    }
    if (this.validFallbackLatency(context.outputLatency)) {
      return {
        contextTimeSeconds: Math.max(0, rawContextTime - context.outputLatency),
        latencySeconds: context.outputLatency,
        source: 'output-latency',
      };
    }
    if (this.validFallbackLatency(context.baseLatency)) {
      return {
        contextTimeSeconds: Math.max(0, rawContextTime - context.baseLatency),
        latencySeconds: context.baseLatency,
        source: 'base-latency',
      };
    }
    return { contextTimeSeconds: rawContextTime, latencySeconds: 0, source: 'none' };
  }

  private validFallbackLatency(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value)
      && value > 0;
  }

  private boundSongTime(value: number): number {
    return Math.min(this.activeSong?.durationMs ?? 0, Math.max(0, value));
  }

  private setBlocked(blocked: boolean): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    this.blockedCallback?.(blocked);
  }

  private updateContextState(): void {
    const running = this.context?.state === 'running';
    this.setBlocked(Boolean(this.context) && !running);
    this.runningCallback?.(running);
  }
}
