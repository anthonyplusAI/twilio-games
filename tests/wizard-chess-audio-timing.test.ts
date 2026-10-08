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
  static deferPlaybackAtCount = 0;
  static durationSeconds = 3;
  src = '';
  preload = '';
  duration = FakeAudio.durationSeconds;
  paused = true;
  ended = false;
  playCount = 0;
  pauseCount = 0;
  pendingPlayReject: ((reason: unknown) => void) | null = null;
  constructor() {
    super();
    audioInstances.push(this);
  }
  load(): void {
    if (this.src) this.dispatchEvent(new Event('loadedmetadata'));
  }
  play(): Promise<void> {
    this.playCount++;
    if (this.playCount === FakeAudio.deferPlaybackAtCount) {
      return new Promise((_resolve, reject) => { this.pendingPlayReject = reject; });
    }
    if (FakeAudio.rejectPlayback) return Promise.reject({ name: 'NotAllowedError' });
    this.paused = false;
    this.ended = false;
    return Promise.resolve();
  }
  pause(): void { this.pauseCount++; this.paused = true; }
  rejectPendingPlay(): void { this.pendingPlayReject?.({ name: 'NotAllowedError' }); }
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
let skipRequests = vi.fn<(sceneId: number) => void>();
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
    renderPosition() {}, onActiveChange() {}, setMusicVolume() {},
    requestSkip(sceneId) { skipRequests(sceneId); },
  });
  return controller;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(6_000);
  audioInstances = [];
  FakeAudio.rejectPlayback = false;
  FakeAudio.deferPlaybackAtCount = 0;
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
  skipRequests = vi.fn<(sceneId: number) => void>();
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
  it('plays an ElevenLabs clip even when its duration exceeds the old six-second cue slot', async () => {
    FakeAudio.durationSeconds = 9;
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    createController().update(story);
    await flush();

    expect(audioInstances[0]!.playCount).toBe(1);
    expect(browserSpeech.speak).not.toHaveBeenCalled();
  });

  it('starts the next character within 200ms of the previous voice ending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    createController().update(story);
    await flush();
    const playback = audioInstances[0]!;
    expect(playback.playCount).toBe(1);

    playback.finish();
    vi.advanceTimersByTime(200);
    await flush();

    expect(playback.playCount).toBe(2);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(2);
  });

  it('warms the four short replies before Ron’s long line ends', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return audioResponse();
    }));
    createController().update(story);
    await flush();
    const playback = audioInstances[0]!;
    expect(playback.playCount).toBe(1);

    playback.finish();
    vi.advanceTimersByTime(200);
    await flush();
    expect(playback.playCount).toBe(2);
    for (const lineId of ['harry-no', 'hermione-asks', 'harry-realizes', 'hermione-pleads']) {
      expect(requested.some(url => url.includes(`/wizard-audio/${lineId}?`))).toBe(true);
    }
    expect(requested.some(url => url.includes('/wizard-audio/ron-final-appeal?'))).toBe(false);
  });

  it('keeps unavailable character voices silent instead of substituting the device voice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ...audioResponse(), ok: false, status: 503 })));
    createController().update(story);
    await flush();

    expect(browserSpeech.speak).not.toHaveBeenCalled();
    expect(elements.get('wizard-sound-toggle')!.dataset.state).toBe('unavailable');
    vi.advanceTimersByTime(50_000);
    await flush();
    expect(elements.get('wizard-transcript')!.children).toHaveLength(7);
    expect(skipRequests).toHaveBeenCalledExactlyOnceWith(story.id);
  });

  it('advances readable captions and requests the move cue even with sound muted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    elements.get('wizard-sound-toggle')!.dispatchEvent(new Event('click'));
    scene.update(story);

    vi.advanceTimersByTime(50_000);
    await flush();

    expect(elements.get('wizard-transcript')!.children).toHaveLength(7);
    expect(skipRequests).toHaveBeenCalledExactlyOnceWith(story.id);
    expect(elements.get('wizard-move-hint')!.hidden).toBe(true);
  });

  it('restores Ron’s final caption on a display that reconnects after a fast scene', () => {
    createController().update({ ...story, phase: 'ready', readyAt: 15_000 });

    const lines = elements.get('wizard-transcript')!.children;
    expect(lines).toHaveLength(7);
    expect(lines.at(-1)!.children[1]!.textContent).toContain('Not Hermione. You.');
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
  });

  it('plays a fetched character voice that arrives three seconds after its caption', async () => {
    let resolveOpening!: (response: Response) => void;
    const opening = new Promise<Response>(resolve => { resolveOpening = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('harry-wait')
      ? opening : Promise.resolve(audioResponse())));
    createController().update(story);

    vi.advanceTimersByTime(3_000);
    resolveOpening(audioResponse());
    await flush();

    expect(audioInstances[0]!.playCount).toBe(1);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(1);
    expect(browserSpeech.speak).not.toHaveBeenCalled();
  });

  it('waits for a character to finish before showing the next line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    scene.update(story);
    await flush();
    const playback = audioInstances[0]!;
    expect(playback.playCount).toBe(1);
    const pausesAfterStart = playback.pauseCount;

    vi.advanceTimersByTime(6_060);
    await flush();
    expect(elements.get('wizard-transcript')!.children).toHaveLength(1);
    expect(playback.pauseCount).toBe(pausesAfterStart);
    expect(playback.playCount).toBe(1);

    playback.finish();
    vi.advanceTimersByTime(200);
    await flush();
    expect(playback.playCount).toBe(2);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(2);

    scene.update({ ...story, phase: 'ready', readyAt: 12_260 });
    expect(playback.pauseCount).toBeGreaterThan(pausesAfterStart);
  });

  it('stops narration on Skip and shows the move cue only after ready confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    scene.update(story);
    await flush();
    const playback = audioInstances[0]!;
    const pausesBeforeSkip = playback.pauseCount;

    elements.get('wizard-skip-button')!.dispatchEvent(new Event('click'));
    expect(playback.pauseCount).toBeGreaterThan(pausesBeforeSkip);
    expect(skipRequests).toHaveBeenCalledExactlyOnceWith(story.id);
    expect(elements.get('wizard-move-hint')!.hidden).toBe(true);

    scene.update({ ...story, phase: 'ready', readyAt: 6_000 });
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
    expect(elements.get('wizard-move-hint')!.textContent).toContain('Knight to H3');
  });

  it('lets a tap resume the pending ElevenLabs line after autoplay is blocked', async () => {
    FakeAudio.rejectPlayback = true;
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    createController().update(story);
    await flush();
    const toggle = elements.get('wizard-sound-toggle')!;
    expect(toggle.dataset.state).toBe('blocked');
    expect(toggle.attributes.get('aria-label')).toBe('Tap to enable character voices');
    expect(browserSpeech.speak).not.toHaveBeenCalled();

    FakeAudio.rejectPlayback = false;
    toggle.dispatchEvent(new Event('click'));
    await flush();
    expect(toggle.dataset.state).toBe('on');
    expect(audioInstances[0]!.playCount).toBe(2);
    expect(browserSpeech.speak).not.toHaveBeenCalled();
  });

  it('stops Ron’s final voice and shows the cue when the server timeout advances to ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    scene.update(story);
    await flush();
    const playback = audioInstances[0]!;
    for (let index = 0; index < 6; index++) {
      playback.finish();
      vi.advanceTimersByTime(200);
      await flush();
    }
    expect(playback.playCount).toBe(7);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(7);
    const pausesBeforeReady = playback.pauseCount;

    vi.setSystemTime(60_000);
    scene.update({ ...story, phase: 'ready', readyAt: Date.now() });
    expect(playback.pauseCount).toBeGreaterThan(pausesBeforeReady);
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
  });

  it('ignores a late play rejection after the server has shown the move cue', async () => {
    FakeAudio.deferPlaybackAtCount = 7;
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    scene.update(story);
    await flush();
    const playback = audioInstances[0]!;
    for (let index = 0; index < 6; index++) {
      playback.finish();
      vi.advanceTimersByTime(200);
      await flush();
    }
    expect(playback.playCount).toBe(7);

    scene.update({ ...story, phase: 'ready', readyAt: Date.now() });
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
    playback.rejectPendingPlay();
    await flush();

    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
  });

  it('does not start Ron’s last fetched voice after the server advances to ready', async () => {
    let releaseFinal!: (response: Response) => void;
    const finalAudio = new Promise<Response>(resolve => { releaseFinal = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('ron-final-appeal')
      ? finalAudio : Promise.resolve(audioResponse())));
    const scene = createController();
    scene.update(story);
    await flush();
    const playback = audioInstances[0]!;
    for (let index = 0; index < 6; index++) {
      playback.finish();
      vi.advanceTimersByTime(200);
      await flush();
    }
    expect(playback.playCount).toBe(6);

    scene.update({ ...story, phase: 'ready', readyAt: Date.now() });
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
    releaseFinal(audioResponse());
    await flush();
    expect(playback.playCount).toBe(6);
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
  });

  it('signals ready immediately after Ron’s final voice ends', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    createController().update(story);
    await flush();
    const playback = audioInstances[0]!;
    for (let index = 0; index < 7; index++) {
      playback.finish();
      vi.advanceTimersByTime(200);
      await flush();
    }
    expect(skipRequests).toHaveBeenCalledExactlyOnceWith(story.id);
  });
});
