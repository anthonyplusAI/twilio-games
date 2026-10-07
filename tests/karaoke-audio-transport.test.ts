import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KaraokeSong } from '../shared/karaoke';
import { EN_US_ORIGINAL_DEVELOPMENT_SONG, NEVER_GONNA_GIVE_YOU_UP } from '../shared/karaoke-songs';
import {
  KaraokeAudioTransport,
  KaraokeSelectedSongPreloader,
  karaokeBackingPlan,
} from '../client/karaoke/karaoke-audio';

describe('Voice Karaoke procedural backing arrangement', () => {
  it('builds the same complete arrangement for the same immutable song', () => {
    const first = karaokeBackingPlan(EN_US_ORIGINAL_DEVELOPMENT_SONG);
    const second = karaokeBackingPlan(EN_US_ORIGINAL_DEVELOPMENT_SONG);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(250);
    expect(first.some(event => event.kind === 'kick')).toBe(true);
    expect(first.some(event => event.kind === 'snare')).toBe(true);
    expect(first.some(event => event.kind === 'bass')).toBe(true);
    expect(first.some(event => event.kind === 'chord')).toBe(true);
  });

  it('never emits target-pitch guide tones that could leak scoring answers', () => {
    const plan = karaokeBackingPlan(EN_US_ORIGINAL_DEVELOPMENT_SONG);
    expect(plan.every(event => !('kind' in event) || (event.kind as string) !== 'guide')).toBe(true);
    const targetFrequency = 440 * 2 ** ((EN_US_ORIGINAL_DEVELOPMENT_SONG.chart.words[0]!.targetMidi - 69) / 12);
    expect(plan.some(event => event.timeSeconds === EN_US_ORIGINAL_DEVELOPMENT_SONG.chart.words[0]!.startMs / 1000
      && event.frequency === targetFrequency)).toBe(false);
  });

  it('keeps every generated event within the fixed 45-second transport', () => {
    const duration = EN_US_ORIGINAL_DEVELOPMENT_SONG.durationMs / 1000;
    const plan = karaokeBackingPlan(EN_US_ORIGINAL_DEVELOPMENT_SONG);
    expect(plan.every(event => event.timeSeconds >= 0 && event.timeSeconds < duration)).toBe(true);
    expect(plan.every((event, index) => index === 0 || event.timeSeconds >= plan[index - 1]!.timeSeconds)).toBe(true);
  });
});

class FakeAudioContext extends EventTarget {
  static latest: FakeAudioContext | null = null;
  state: AudioContextState = 'suspended';
  currentTime = 2;
  baseLatency = 0;
  outputLatency = 0;
  outputTimestamp: AudioTimestamp | null = null;
  sampleRate = 44_100;
  destination = {} as AudioDestinationNode;
  sourceCount = 0;

  constructor() {
    super();
    FakeAudioContext.latest = this;
  }

  createGain(): GainNode {
    return { gain: { value: 1 }, connect: vi.fn() } as unknown as GainNode;
  }

  createBufferSource(): AudioBufferSourceNode {
    this.sourceCount += 1;
    return {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    } as unknown as AudioBufferSourceNode;
  }

  async decodeAudioData(): Promise<AudioBuffer> { return {} as AudioBuffer; }
  createBuffer(channels: number, length: number): AudioBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: (channel: number) => data[channel]! } as AudioBuffer;
  }
  getOutputTimestamp(): AudioTimestamp {
    return this.outputTimestamp ?? { contextTime: Number.NaN, performanceTime: Number.NaN };
  }

  async resume(): Promise<void> {
    this.state = 'running';
    this.dispatchEvent(new Event('statechange'));
  }

  suspendForTest(): void {
    this.state = 'suspended';
    this.dispatchEvent(new Event('statechange'));
  }

  async close(): Promise<void> { this.state = 'closed'; }
}

const remoteSong: KaraokeSong = { ...EN_US_ORIGINAL_DEVELOPMENT_SONG, audioUrl: '/backing.wav' };

describe('KaraokeAudioTransport browser state', () => {
  beforeEach(() => {
    FakeAudioContext.latest = null;
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal('performance', { now: () => 1_000 });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('stays unready while suspended and reports running after gesture recovery', async () => {
    const transport = new KaraokeAudioTransport();
    const running: boolean[] = [];
    const blocked: boolean[] = [];
    transport.onRunningStateChange(value => running.push(value));
    transport.onAutoplayBlocked(value => blocked.push(value));
    await transport.preload(remoteSong);
    expect(transport.isRunning()).toBe(false);
    expect(blocked.at(-1)).toBe(true);
    await expect(transport.recover(10_000)).resolves.toBe(true);
    expect(transport.isRunning()).toBe(true);
    expect(running.at(-1)).toBe(true);
    expect(blocked.at(-1)).toBe(false);
    transport.dispose();
  });

  it('creates and unlocks the audio context when recovery happens before preload', async () => {
    const transport = new KaraokeAudioTransport();
    await expect(transport.recover(0)).resolves.toBe(true);
    expect(transport.isRunning()).toBe(true);
    transport.dispose();
  });

  it('fetches and decodes the licensed excerpt from its root-relative catalog URL', async () => {
    const transport = new KaraokeAudioTransport();
    await transport.preload(NEVER_GONNA_GIVE_YOU_UP);
    expect(fetch).toHaveBeenCalledWith(
      '/audio/karaoke/classic-instrumental-45s.mp3?v=20260827-sync-2',
      { credentials: 'same-origin', signal: expect.any(AbortSignal) },
    );
    expect(transport.isReady(NEVER_GONNA_GIVE_YOU_UP)).toBe(true);
    transport.dispose();
  });

  it('shares a selection request with loading and replays its current progress', async () => {
    let resolveBytes!: (bytes: ArrayBuffer) => void;
    const bytes = new Promise<ArrayBuffer>(resolve => { resolveBytes = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: () => bytes })));
    const transport = new KaraokeAudioTransport();
    const early = transport.preload(remoteSong);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    const progress: number[] = [];
    const loading = transport.preload(remoteSong, value => progress.push(value));
    expect(progress).toEqual([.08]);
    resolveBytes(new ArrayBuffer(8));
    await Promise.all([early, loading]);

    expect(progress).toEqual([.08, .62, .96, 1]);
    await transport.preload(remoteSong);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(transport.isReady(remoteSong)).toBe(true);
    transport.dispose();
  });

  it('keeps loading attached when the optional selection consumer is canceled', async () => {
    let resolveBytes!: (bytes: ArrayBuffer) => void;
    const bytes = new Promise<ArrayBuffer>(resolve => { resolveBytes = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: () => bytes })));
    const transport = new KaraokeAudioTransport();
    const controller = new AbortController();
    const early = transport.preload(remoteSong, undefined, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const loading = transport.preload(remoteSong);

    controller.abort();
    await expect(early).rejects.toMatchObject({ name: 'AbortError' });
    expect((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(false);
    resolveBytes(new ArrayBuffer(8));
    await loading;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(transport.isReady(remoteSong)).toBe(true);
    transport.dispose();
  });

  it('lets a changed selection cancel stale work without caching its late result', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve; });
    const secondResponse = new Promise<Response>(resolve => { resolveSecond = resolve; });
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse));
    const transport = new KaraokeAudioTransport();
    const controller = new AbortController();
    const first = transport.preload(remoteSong, undefined, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = transport.preload(remoteSong);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    resolveFirst({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response);
    await Promise.resolve();
    expect(transport.isReady(remoteSong)).toBe(false);
    resolveSecond({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response);
    await second;
    expect(transport.isReady(remoteSong)).toBe(true);
    transport.dispose();
  });

  it('starts a fresh request after loading times out to the same selected song', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new KaraokeAudioTransport();
    const selected = new KaraokeSelectedSongPreloader(transport);
    selected.update('song_select', remoteSong);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstSignal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;

    selected.update('loading', remoteSong);
    const loadingController = new AbortController();
    const loading = transport.preload(remoteSong, undefined, loadingController.signal);
    loadingController.abort();
    selected.update('song_select', remoteSong);
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);

    const retryController = new AbortController();
    const retry = transport.preload(remoteSong, undefined, retryController.signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    retryController.abort();
    selected.dispose();
    await expect(retry).rejects.toMatchObject({ name: 'AbortError' });
    transport.dispose();
  });

  it('bounds an optional menu preload without restarting on repeated broadcasts', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));
      vi.stubGlobal('fetch', fetchMock);
      const transport = new KaraokeAudioTransport();
      const selected = new KaraokeSelectedSongPreloader(transport, 25);
      selected.update('song_select', remoteSong);
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const firstSignal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;

      await vi.advanceTimersByTimeAsync(25);
      expect(firstSignal.aborted).toBe(true);
      selected.update('song_select', remoteSong);
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const loadingController = new AbortController();
      const loading = transport.preload(remoteSong, undefined, loadingController.signal);
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      loadingController.abort();
      await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
      selected.dispose();
      transport.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('keeps procedural preloading asynchronous so the selection menu can paint', async () => {
    class LowRateAudioContext extends FakeAudioContext { sampleRate = 1_000; }
    vi.stubGlobal('window', { AudioContext: LowRateAudioContext });
    const transport = new KaraokeAudioTransport();
    const preload = transport.preload(EN_US_ORIGINAL_DEVELOPMENT_SONG);
    expect(transport.isReady(EN_US_ORIGINAL_DEVELOPMENT_SONG)).toBe(false);
    await preload;
    expect(transport.isReady(EN_US_ORIGINAL_DEVELOPMENT_SONG)).toBe(true);
    transport.dispose();
  });

  it('does not use the same-performance drift shortcut while audio is suspended', async () => {
    const transport = new KaraokeAudioTransport();
    await transport.preload(remoteSong);
    await transport.recover(10_000);
    await transport.sync(remoteSong, 9_000, 10_000);
    const context = FakeAudioContext.latest!;
    const firstSourceCount = context.sourceCount;
    context.suspendForTest();
    await transport.sync(remoteSong, 9_000, 10_200);
    expect(context.sourceCount).toBe(firstSourceCount + 1);
    expect(transport.isRunning()).toBe(true);
    transport.dispose();
  });

  it('exposes raw and audible timelines from a valid output timestamp', async () => {
    const transport = new KaraokeAudioTransport();
    await transport.preload(remoteSong);
    await transport.recover(10_000);
    await transport.sync(remoteSong, 9_000, 10_000);
    const context = FakeAudioContext.latest!;
    context.outputTimestamp = { contextTime: 1.95, performanceTime: 1_000 };
    const initial = transport.timeline(10_000);
    expect(initial.rawTimeMs).toBe(1_000);
    expect(initial.presentationTimeMs).toBeCloseTo(950);
    expect(initial.estimatedOutputLatencyMs).toBeCloseTo(50);
    expect(initial.latencySource).toBe('output-timestamp');

    context.currentTime = 3;
    context.outputTimestamp = { contextTime: 2.875, performanceTime: 1_000 };

    expect(transport.timeline(11_000)).toEqual({
      rawTimeMs: 2_000,
      presentationTimeMs: 1_875,
      estimatedOutputLatencyMs: 125,
      latencySource: 'output-timestamp',
    });
    expect(transport.currentTimeMs(11_000)).toBe(2_000);
    expect(transport.presentationTimeMs(11_000)).toBe(1_875);
    transport.dispose();
  });

  it('falls back through output latency, base latency, and zero', async () => {
    const transport = new KaraokeAudioTransport();
    await transport.preload(remoteSong);
    await transport.recover(10_000);
    await transport.sync(remoteSong, 9_000, 10_000);
    const context = FakeAudioContext.latest!;

    context.currentTime = 3;
    context.outputLatency = .08;
    expect(transport.timeline(11_000)).toMatchObject({
      rawTimeMs: 2_000, presentationTimeMs: 1_920,
      estimatedOutputLatencyMs: 80, latencySource: 'output-latency',
    });

    context.currentTime = 3.1;
    context.outputLatency = 0;
    context.baseLatency = .025;
    expect(transport.timeline(11_100)).toMatchObject({
      rawTimeMs: 2_100, presentationTimeMs: 2_075,
      estimatedOutputLatencyMs: 25, latencySource: 'base-latency',
    });

    context.currentTime = 3.2;
    context.baseLatency = 0;
    expect(transport.timeline(11_200)).toMatchObject({
      rawTimeMs: 2_200, presentationTimeMs: 2_200,
      estimatedOutputLatencyMs: 0, latencySource: 'none',
    });
    transport.dispose();
  });

  it('keeps both song clocks monotonic and bounded when output estimates move', async () => {
    const transport = new KaraokeAudioTransport();
    await transport.preload(remoteSong);
    await transport.recover(10_000);
    await transport.sync(remoteSong, 9_000, 10_000);
    const context = FakeAudioContext.latest!;
    context.currentTime = 3;
    context.outputTimestamp = { contextTime: 2.9, performanceTime: 1_000 };
    expect(transport.timeline(11_000).presentationTimeMs).toBe(1_900);

    context.currentTime = 3.05;
    context.outputTimestamp = { contextTime: 2.7, performanceTime: 1_000 };
    expect(transport.timeline(11_050).presentationTimeMs).toBe(1_900);

    context.currentTime = 100;
    context.outputTimestamp = { contextTime: 99.9, performanceTime: 1_000 };
    expect(transport.timeline(100_000)).toMatchObject({ rawTimeMs: 45_000, presentationTimeMs: 45_000 });
    transport.dispose();
  });
});

describe('Karaoke selected-song preloading', () => {
  it('starts only for the selected song, deduplicates broadcasts, and preserves loading work', () => {
    const preload = vi.fn((_song: KaraokeSong, _progress?: (progress: number) => void, _signal?: AbortSignal) =>
      new Promise<void>(() => {}));
    const selected = new KaraokeSelectedSongPreloader({ preload });
    const otherSong = { ...remoteSong, id: 'second-song', audioUrl: '/second.wav' };

    selected.update('lobby', remoteSong);
    selected.update('song_select', null);
    expect(preload).not.toHaveBeenCalled();

    selected.update('song_select', remoteSong);
    selected.update('song_select', remoteSong);
    expect(preload).toHaveBeenCalledTimes(1);
    const firstSignal = preload.mock.calls[0]![2]!;

    selected.update('song_select', otherSong);
    expect(firstSignal.aborted).toBe(true);
    expect(preload).toHaveBeenCalledTimes(2);
    const secondSignal = preload.mock.calls[1]![2]!;
    selected.update('loading', otherSong);
    expect(secondSignal.aborted).toBe(false);
    expect(preload).toHaveBeenCalledTimes(2);

    selected.update('results', otherSong);
    expect(secondSignal.aborted).toBe(true);
  });
});
