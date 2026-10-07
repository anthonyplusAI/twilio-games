import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WizardSceneController } from '../client/chess/wizard-scene-controller';
import type { WizardChessSceneSnapshot } from '../shared/chess-protocol';

class FakeElement extends EventTarget {
  hidden = false;
  dataset: Record<string, string> = {};
  textContent = '';
  scrollTop = 0;
  scrollHeight = 0;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  replaceChildren(): void { this.children.length = 0; }
  querySelector(): FakeElement { return new FakeElement(); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  focus(): void {}
}

class FakeAudio extends EventTarget {
  static rejectPlayback = false;
  static durationSeconds = 3;
  src = '';
  preload = '';
  duration = FakeAudio.durationSeconds;
  paused = true;
  ended = false;
  playCount = 0;
  pauseCount = 0;
  constructor() {
    super();
    audioInstances.push(this);
  }
  load(): void {
    if (this.src) this.dispatchEvent(new Event('loadedmetadata'));
  }
  play(): Promise<void> {
    this.playCount++;
    if (FakeAudio.rejectPlayback) return Promise.reject({ name: 'NotAllowedError' });
    this.paused = false;
    this.ended = false;
    return Promise.resolve();
  }
  pause(): void { this.pauseCount++; this.paused = true; }
  removeAttribute(name: string): void { if (name === 'src') this.src = ''; }
  finish(): void {
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event('ended'));
  }
}

let audioInstances: FakeAudio[];
let elements: Map<string, FakeElement>;
let controller: WizardSceneController | null;
let browserSpeech: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
const story: WizardChessSceneSnapshot = {
  id: 7, phase: 'story', startedAt: 0, readyAt: null, resolvedAt: null,
};
const audioResponse = (): Response => ({
  ok: true,
  status: 200,
  headers: { get: (name: string) => name === 'content-type' ? 'audio/mpeg' : null },
  blob: async () => new Blob(['fake audio'], { type: 'audio/mpeg' }),
} as Response);

async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

function createController(): WizardSceneController {
  controller = new WizardSceneController('en-US', {
    renderPosition() {}, onActiveChange() {}, setMusicVolume() {}, requestSkip() {},
  });
  return controller;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(6_000);
  audioInstances = [];
  FakeAudio.rejectPlayback = false;
  FakeAudio.durationSeconds = 3;
  elements = new Map();
  vi.stubGlobal('document', {
    getElementById(id: string) {
      let found = elements.get(id);
      if (!found) elements.set(id, found = new FakeElement());
      return found;
    },
    createElement() { return new FakeElement(); },
  });
  vi.stubGlobal('Audio', FakeAudio);
  browserSpeech = { speak: vi.fn(), cancel: vi.fn() };
  vi.stubGlobal('window', { speechSynthesis: browserSpeech });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    lang = '';
    rate = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly text: string) {}
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:wizard-${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  controller = null;
});

afterEach(() => {
  controller?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Wizard Chess timed screen voices', () => {
  it('keeps a late fetched line silent when its actual duration exceeds the remaining cue window', async () => {
    FakeAudio.durationSeconds = 5;
    let resolveOpening!: (response: Response) => void;
    const opening = new Promise<Response>(resolve => { resolveOpening = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('ron-sees-the-line')
      ? opening : Promise.resolve(audioResponse())));
    createController().update(story);

    vi.advanceTimersByTime(1_800);
    resolveOpening(audioResponse());
    await flush();

    expect(audioInstances[0]!.playCount).toBe(0);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(1);
  });

  it('does not cut an unfinished screen voice at the next caption cue, but stops it on the server ready phase', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    scene.update(story);
    await flush();
    const playback = audioInstances[0]!;
    expect(playback.playCount).toBe(1);
    const pausesAfterStart = playback.pauseCount;

    vi.advanceTimersByTime(6_060);
    await flush();
    expect(elements.get('wizard-transcript')!.children).toHaveLength(2);
    expect(playback.pauseCount).toBe(pausesAfterStart);
    expect(playback.playCount).toBe(1);

    playback.finish();
    await flush();
    expect(playback.playCount).toBe(2);

    scene.update({ ...story, phase: 'ready', readyAt: 12_060 });
    expect(playback.pauseCount).toBeGreaterThan(pausesAfterStart);
  });

  it('does not start a late browser speech fallback that cannot finish before the next cue', async () => {
    let resolveOpening!: (response: Response) => void;
    const opening = new Promise<Response>(resolve => { resolveOpening = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('ron-sees-the-line')
      ? opening : Promise.resolve(audioResponse())));
    createController().update(story);

    vi.advanceTimersByTime(1_800);
    resolveOpening({ ...audioResponse(), ok: false, status: 503 });
    await flush();

    expect(browserSpeech.speak).not.toHaveBeenCalled();
    expect(elements.get('wizard-transcript')!.children).toHaveLength(1);
  });

  it('lets browser speech finish past a later caption cue and cancels it on Skip', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ...audioResponse(), ok: false, status: 503 })));
    createController().update(story);
    await flush();
    expect(browserSpeech.speak).toHaveBeenCalledTimes(1);
    const cancelsAfterStart = browserSpeech.cancel.mock.calls.length;

    vi.advanceTimersByTime(6_060);
    await flush();
    expect(elements.get('wizard-transcript')!.children).toHaveLength(2);
    expect(browserSpeech.cancel).toHaveBeenCalledTimes(cancelsAfterStart);

    elements.get('wizard-skip-button')!.dispatchEvent(new Event('click'));
    expect(browserSpeech.cancel).toHaveBeenCalledTimes(cancelsAfterStart + 1);
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
  });

  it('offers a gesture to retry when the browser blocks autoplay', async () => {
    FakeAudio.rejectPlayback = true;
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    createController().update(story);
    await flush();
    const toggle = elements.get('wizard-sound-toggle')!;
    expect(toggle.dataset.state).toBe('blocked');
    expect(toggle.attributes.get('aria-label')).toBe('Tap to enable voices');

    FakeAudio.rejectPlayback = false;
    toggle.dispatchEvent(new Event('click'));
    await flush();
    expect(toggle.dataset.state).toBe('on');
    expect(audioInstances[0]!.playCount).toBe(2);
  });
});
