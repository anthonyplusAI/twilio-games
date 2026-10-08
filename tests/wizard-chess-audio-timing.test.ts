import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WizardSceneController } from '../client/chess/wizard-scene-controller';
import type { WizardChessSceneSnapshot } from '../shared/chess-protocol';
import { WIZARD_CHESS_DIALOGUE, WIZARD_CHESS_FINALE_CUES,
  WIZARD_CHESS_SEQUENCE } from '../shared/wizard-chess-scene';

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
let progressReports = vi.fn<(sceneId: number, dialogueCursor: number) => void>();
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
    reportProgress(sceneId, dialogueCursor) { progressReports(sceneId, dialogueCursor); },
  });
  return controller;
}

async function beginStory(scene = createController()): Promise<FakeAudio> {
  scene.update(story);
  await flush();
  vi.advanceTimersByTime(800); // The opening wide shot settles before Harry speaks.
  await flush();
  return audioInstances[0]!;
}

async function finishLines(playback: FakeAudio, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    playback.finish();
    vi.advanceTimersByTime(WIZARD_CHESS_DIALOGUE[index]!.pauseAfterMs);
    await flush();
  }
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
  progressReports = vi.fn<(sceneId: number, dialogueCursor: number) => void>();
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
    await beginStory();

    expect(audioInstances[0]!.playCount).toBe(1);
    expect(browserSpeech.speak).not.toHaveBeenCalled();
  });

  it('lets the first reaction breathe before Ron speaks, then starts promptly at its scheduled beat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const playback = await beginStory();
    expect(playback.playCount).toBe(1);

    playback.finish();
    expect(progressReports).toHaveBeenCalledExactlyOnceWith(story.id, 1);
    vi.advanceTimersByTime(WIZARD_CHESS_DIALOGUE[0]!.pauseAfterMs - 1);
    await flush();
    expect(playback.playCount).toBe(1);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await flush();

    expect(playback.playCount).toBe(2);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(2);
  });

  it('warms opening dialogue and climax reactions before the first line finishes', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return audioResponse();
    }));
    const playback = await beginStory();
    expect(playback.playCount).toBe(1);

    for (const lineId of ['harry-wait', 'ron-sacrifice', 'ron-queen-takes', 'ron-check-king',
      'harry-no', ...WIZARD_CHESS_FINALE_CUES.map(cue => cue.id)]) {
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
    await vi.advanceTimersByTimeAsync(50_000);
    await flush();
    expect(elements.get('wizard-transcript')!.children).toHaveLength(WIZARD_CHESS_DIALOGUE.length);
    expect(skipRequests).toHaveBeenCalledExactlyOnceWith(story.id);
  });

  it('still plays a cached later voice when the first clip is unavailable', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return url.includes('/harry-wait?')
        ? { ...audioResponse(), ok: false, status: 503 }
        : audioResponse();
    }));
    createController().update(story);
    await flush();

    vi.advanceTimersByTime(3_000);
    await flush();
    expect(requested.some(url => url.includes('/ron-sacrifice?'))).toBe(true);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(2);
    expect(audioInstances[0]!.playCount).toBe(1);
    expect(elements.get('wizard-sound-toggle')!.dataset.state).toBe('partial');
    expect(browserSpeech.speak).not.toHaveBeenCalled();
  });

  it('advances readable captions and requests the move cue even with sound muted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    elements.get('wizard-sound-toggle')!.dispatchEvent(new Event('click'));
    scene.update(story);

    vi.advanceTimersByTime(50_000);
    await flush();

    expect(elements.get('wizard-transcript')!.children).toHaveLength(WIZARD_CHESS_DIALOGUE.length);
    expect(skipRequests).toHaveBeenCalledExactlyOnceWith(story.id);
    expect(elements.get('wizard-move-hint')!.hidden).toBe(true);
  });

  it('restores Ron’s final caption on a display that reconnects after a fast scene', () => {
    createController().update({ ...story, phase: 'ready', readyAt: 15_000 });

    const lines = elements.get('wizard-transcript')!.children;
    expect(lines).toHaveLength(WIZARD_CHESS_DIALOGUE.length);
    expect(lines.at(-2)!.children[1]!.textContent).toBe('Not Hermione.');
    expect(lines.at(-1)!.children[1]!.textContent).toBe('You.');
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
  });

  it('resumes a reconnected story from fully finished lines, never from elapsed-time guesses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    vi.setSystemTime(50_000); // The scene may run slower than its old 40.4s estimates.
    createController().update({ ...story, dialogueCursor: 5 });
    await flush();

    const lines = elements.get('wizard-transcript')!.children;
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)!.children[1]!.textContent).toBe(WIZARD_CHESS_DIALOGUE[5]!.text['en-US']);
    expect(skipRequests).not.toHaveBeenCalled();
    expect(audioInstances[0]!.playCount).toBe(1);
  });

  it('plays a fetched character voice that arrives within the bounded caption wait', async () => {
    let resolveOpening!: (response: Response) => void;
    const opening = new Promise<Response>(resolve => { resolveOpening = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('harry-wait')
      ? opening : Promise.resolve(audioResponse())));
    createController().update(story);

    vi.advanceTimersByTime(2_000);
    resolveOpening(audioResponse());
    await flush();

    expect(audioInstances[0]!.playCount).toBe(1);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(1);
    expect(browserSpeech.speak).not.toHaveBeenCalled();
  });

  it('waits for a character to finish before showing the next line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    const playback = await beginStory(scene);
    expect(playback.playCount).toBe(1);
    const pausesAfterStart = playback.pauseCount;

    vi.advanceTimersByTime(6_060);
    await flush();
    expect(elements.get('wizard-transcript')!.children).toHaveLength(1);
    expect(playback.pauseCount).toBe(pausesAfterStart);
    expect(playback.playCount).toBe(1);

    playback.finish();
    vi.advanceTimersByTime(WIZARD_CHESS_DIALOGUE[0]!.pauseAfterMs);
    await flush();
    expect(playback.playCount).toBe(2);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(2);

    scene.update({ ...story, phase: 'ready', readyAt: 12_260 });
    expect(playback.pauseCount).toBeGreaterThan(pausesAfterStart);
  });

  it('stops narration on Skip and shows the move cue only after ready confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    const playback = await beginStory(scene);
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
    await beginStory();
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
    const playback = await beginStory(scene);
    await finishLines(playback, WIZARD_CHESS_DIALOGUE.length - 1);
    expect(playback.playCount).toBe(WIZARD_CHESS_DIALOGUE.length);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(WIZARD_CHESS_DIALOGUE.length);
    const pausesBeforeReady = playback.pauseCount;

    vi.setSystemTime(90_000);
    scene.update({ ...story, phase: 'ready', readyAt: Date.now() });
    expect(playback.pauseCount).toBeGreaterThan(pausesBeforeReady);
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
  });

  it('ignores a late play rejection after the server has shown the move cue', async () => {
    FakeAudio.deferPlaybackAtCount = WIZARD_CHESS_DIALOGUE.length;
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    const playback = await beginStory(scene);
    await finishLines(playback, WIZARD_CHESS_DIALOGUE.length - 1);
    expect(playback.playCount).toBe(WIZARD_CHESS_DIALOGUE.length);

    scene.update({ ...story, phase: 'ready', readyAt: Date.now() });
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
    playback.rejectPendingPlay();
    await flush();

    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
  });

  it('does not start Ron’s last fetched voice after the server advances to ready', async () => {
    let releaseFinal!: (response: Response) => void;
    const finalAudio = new Promise<Response>(resolve => { releaseFinal = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('ron-you')
      ? finalAudio : Promise.resolve(audioResponse())));
    const scene = createController();
    const playback = await beginStory(scene);
    await finishLines(playback, WIZARD_CHESS_DIALOGUE.length - 1);
    expect(playback.playCount).toBe(WIZARD_CHESS_DIALOGUE.length - 1);

    scene.update({ ...story, phase: 'ready', readyAt: Date.now() });
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
    releaseFinal(audioResponse());
    await flush();
    expect(playback.playCount).toBe(WIZARD_CHESS_DIALOGUE.length - 1);
    expect(elements.get('wizard-move-hint')!.hidden).toBe(false);
  });

  it('signals ready after Ron’s final spoken beat and dramatic pause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const playback = await beginStory();
    await finishLines(playback, WIZARD_CHESS_DIALOGUE.length - 1);
    playback.finish();
    vi.advanceTimersByTime(WIZARD_CHESS_DIALOGUE.at(-1)!.pauseAfterMs - 1);
    await flush();
    expect(skipRequests).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(skipRequests).toHaveBeenCalledExactlyOnceWith(story.id);
  });

  it('plays Ron’s scream on queen impact, Harry’s cry afterward, and checkmate before the last move', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    const playback = await beginStory(scene);
    expect(playback.playCount).toBe(1);
    vi.setSystemTime(20_000);
    scene.setClockOffset(0);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(1);
    expect(playback.playCount).toBe(1); // Story and ready never play finale reactions.

    const readyAt = Date.now();
    scene.update({ ...story, phase: 'ready', readyAt });
    scene.setClockOffset(0);
    expect(elements.get('wizard-transcript')!.children).toHaveLength(1);

    const resolvedAt = Date.now();
    scene.update({ ...story, phase: 'resolved', readyAt, resolvedAt });
    expect(elements.get('wizard-transcript')!.children.at(-1)!.dataset.current).toBe('false');
    vi.setSystemTime(resolvedAt + WIZARD_CHESS_FINALE_CUES[0]!.atMs - 1);
    scene.setClockOffset(0);
    expect(playback.playCount).toBe(1);
    vi.setSystemTime(resolvedAt + WIZARD_CHESS_FINALE_CUES[0]!.atMs);
    scene.setClockOffset(0);
    await flush();
    expect(playback.playCount).toBe(2);
    expect(elements.get('wizard-transcript')!.children.at(-1)!.children[1]!.textContent).toBe('AHHHH!');

    vi.setSystemTime(resolvedAt + WIZARD_CHESS_FINALE_CUES[1]!.atMs);
    scene.setClockOffset(0);
    await flush();
    expect(playback.playCount).toBe(2); // Do not cut off Ron's scream.
    playback.finish();
    scene.setClockOffset(0);
    await flush();
    expect(playback.playCount).toBe(3);
    expect(elements.get('wizard-transcript')!.children.at(-1)!.children[1]!.textContent).toBe('Ron!');

    vi.setSystemTime(resolvedAt + WIZARD_CHESS_FINALE_CUES[2]!.atMs);
    scene.setClockOffset(0);
    await flush();
    expect(playback.playCount).toBe(4);
    expect(elements.get('wizard-transcript')!.children.at(-1)!.children[1]!.textContent).toBe('Checkmate.');
    expect(elements.get('wizard-scene')!.dataset.shot).toBe('harry');
    expect(WIZARD_CHESS_FINALE_CUES[2]!.atMs).toBeLessThan(WIZARD_CHESS_SEQUENCE.at(-1)!.atMs);
  });

  it('clears Harry’s reaction caption once his voice ends, leaving silent action shots clean', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    const resolvedAt = Date.now();
    scene.update({ ...story, phase: 'resolved', readyAt: resolvedAt, resolvedAt });
    const playback = audioInstances[0]!;

    vi.setSystemTime(resolvedAt + WIZARD_CHESS_FINALE_CUES[0]!.atMs);
    scene.setClockOffset(0);
    await flush();
    playback.finish();
    vi.setSystemTime(resolvedAt + WIZARD_CHESS_FINALE_CUES[1]!.atMs);
    scene.setClockOffset(0);
    await flush();
    const reaction = elements.get('wizard-transcript')!.children.at(-1)!;
    expect(reaction.children[1]!.textContent).toBe('Ron!');
    expect(reaction.dataset.current).toBe('true');

    playback.finish();
    vi.advanceTimersByTime(450);
    expect(reaction.dataset.current).toBe('false');
    vi.setSystemTime(resolvedAt + WIZARD_CHESS_SEQUENCE[2]!.atMs);
    scene.setClockOffset(0);
    expect(elements.get('wizard-scene')!.dataset.shot).toBe('board');
  });

  it('waits for Ron’s loading scream before cutting to Harry’s reaction camera and voice', async () => {
    let releaseScream!: (response: Response) => void;
    const slowScream = new Promise<Response>(resolve => { releaseScream = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/ron-scream?')
      ? slowScream : Promise.resolve(audioResponse())));
    const scene = createController();
    const resolvedAt = Date.now();
    scene.update({ ...story, phase: 'resolved', readyAt: resolvedAt, resolvedAt });
    const playback = audioInstances[0]!;

    vi.setSystemTime(resolvedAt + WIZARD_CHESS_FINALE_CUES[0]!.atMs);
    scene.setClockOffset(0);
    vi.setSystemTime(resolvedAt + WIZARD_CHESS_FINALE_CUES[1]!.atMs);
    scene.setClockOffset(0);
    expect(playback.playCount).toBe(0);
    expect(elements.get('wizard-scene')!.dataset.shot).toBe('ron-impact');

    releaseScream(audioResponse());
    await flush();
    expect(playback.playCount).toBe(1);
    vi.setSystemTime(resolvedAt + WIZARD_CHESS_FINALE_CUES[1]!.atMs + 500);
    scene.setClockOffset(0);
    expect(elements.get('wizard-scene')!.dataset.shot).toBe('ron-impact');
    playback.finish();
    scene.setClockOffset(0);
    await flush();
    expect(playback.playCount).toBe(2);
    expect(elements.get('wizard-scene')!.dataset.shot).toBe('harry');
  });

  it('holds the last bishop move until Harry finishes a slow Checkmate clip', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    const scene = createController();
    const resolvedAt = Date.now();
    scene.update({ ...story, phase: 'resolved', readyAt: resolvedAt, resolvedAt });
    const playback = audioInstances[0]!;

    vi.setSystemTime(resolvedAt + WIZARD_CHESS_FINALE_CUES[2]!.atMs);
    scene.setClockOffset(0);
    await flush();
    expect(playback.playCount).toBe(1);

    vi.setSystemTime(resolvedAt + WIZARD_CHESS_SEQUENCE.at(-1)!.atMs);
    scene.setClockOffset(0);
    expect(elements.get('wizard-scene')!.dataset.shot).toBe('king');
    playback.finish();
    vi.advanceTimersByTime(219);
    expect(elements.get('wizard-scene')!.dataset.shot).toBe('king');
    vi.advanceTimersByTime(1);
    scene.setClockOffset(0);
    expect(elements.get('wizard-scene')!.dataset.shot).toBe('checkmate');
  });

  it('shows the full finale captions without replaying stale voices after a late reconnect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
    vi.setSystemTime(50_000);
    const scene = createController();
    scene.update({ ...story, phase: 'resolved', readyAt: 20_000, resolvedAt: 20_000 });
    await flush();

    const lines = elements.get('wizard-transcript')!.children;
    expect(lines).toHaveLength(WIZARD_CHESS_DIALOGUE.length + WIZARD_CHESS_FINALE_CUES.length);
    expect(lines.slice(-3).map(line => line.children[1]!.textContent))
      .toEqual(['AHHHH!', 'Ron!', 'Checkmate.']);
    expect(audioInstances[0]!.playCount).toBe(0);
    expect(elements.get('wizard-scene')!.dataset.speaking).toBe('false');
  });
});
