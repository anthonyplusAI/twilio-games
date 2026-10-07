import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TriviaState } from '../shared/trivia-protocol';

const mocks = vi.hoisted(() => ({
  connections: [] as Array<{
    ready: number[];
    painted: Array<{ questionId: string; questionAttemptId: number; phase: string; renderRevision: number }>;
    votes: Array<{ playerId: string; category: string }>;
    connection?: (state: 'connected' | 'connecting' | 'reconnecting' | 'closed') => void;
    state?: (state: TriviaState) => void;
    error?: (code: string, message: string) => void;
    host?: (isHost: boolean) => void;
  }>,
  renderedErrors: [] as string[],
}));

vi.mock('../client/trivia/trivia-net', () => ({
  TriviaConnection: class {
    readonly record: (typeof mocks.connections)[number] = { ready: [], painted: [], votes: [] };
    constructor() { mocks.connections.push(this.record); }
    setDisplayAuth() {}
    onConnectionState(callback: (state: 'connected' | 'connecting' | 'reconnecting' | 'closed') => void) {
      this.record.connection = callback;
    }
    onClockSync() {}
    onJoined() {}
    onHostIdentity(callback: (isHost: boolean) => void) { this.record.host = callback; }
    onEvents() {}
    onError(callback: (code: string, message: string) => void) { this.record.error = callback; }
    onState(callback: (state: TriviaState) => void) { this.record.state = callback; }
    spectate() {}
    displayReady(generation: number) { this.record.ready.push(generation); }
    displaySelectCategory(playerId: string, category: string) { this.record.votes.push({ playerId, category }); }
    viewRendered(questionId: string, questionAttemptId: number, phase: string, renderRevision: number) {
      this.record.painted.push({ questionId, questionAttemptId, phase, renderRevision });
    }
    close() {}
  },
}));

vi.mock('../client/station-display', () => ({
  createStationDisplay: () => ({
    active: false,
    displayToken: null,
    markEngineReady() {},
    markEngineResultsReady() {},
  }),
}));
vi.mock('../client/station-client', () => ({
  rejectDisplayToken() {},
  watchVoiceNumber: () => () => undefined,
}));
vi.mock('../client/i18n', () => ({
  locale: 'en-US',
  commonText: (key: string) => key,
  injectLanguagePicker() {},
}));
vi.mock('../client/music-manager', () => ({
  getMusicManager: () => ({ switchContext() {}, stop() {}, resume() {}, getCurrentContext: () => 'lobby' }),
}));
vi.mock('../client/music-toggle', () => ({ injectMusicToggle() {} }));
vi.mock('../client/fullscreen-toggle', () => ({ injectFullscreenToggle() {} }));
vi.mock('../client/sound-effects', () => ({
  getSoundEffectsManager: () => ({ playCountdown() {} }),
}));
vi.mock('../client/theme', () => ({ wireThemeToggle() {} }));
vi.mock('../client/trivia/trivia-client-utils', () => ({
  TriviaCountdownSoundCue: class { update() {} },
  TriviaServerClock: class { observeSync() {}; now() { return 0; } },
  isInteractiveTriviaShortcutTarget: () => false,
  resolveTriviaWebSocketUrl: () => 'ws://localhost/trivia',
  triviaCountdownCount: () => 3,
  triviaDisplayPairingRequired: () => false,
  triviaLocalKeyboardCommand: () => null,
  triviaLocalKeyboardTestingAllowed: () => false,
  triviaQuestionTiming: () => ({ remainingSeconds: 0, progress: 1 }),
}));
vi.mock('../client/trivia/trivia-view', () => ({
  renderTriviaView: (_state: TriviaState | null, options: { error: string }) => {
    mocks.renderedErrors.push(options.error);
    return { html: _state ? `<section data-view="${_state.phase}"></section>` : '',
      announcement: '', announcementKey: '' };
  },
  triviaDisplayCopy: () => ({
    app: 'Trivia', home: 'Home', homeLabel: 'Home', stageLabel: 'Stage', seconds: 'seconds',
    theme: { light: 'Light', dark: 'Dark' },
    connection: { connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', closed: 'Closed' },
  }),
}));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  mocks.connections.length = 0;
  mocks.renderedErrors.length = 0;
});

describe('Trivia display readiness retry', () => {
  it('waits for changed loading authority after rejection and retries once on caller reconnect', async () => {
    const elements = new Map<string, Record<string, any>>();
    const getElement = (id: string) => {
      let value = elements.get(id);
      if (!value) {
        value = {
          textContent: '', innerHTML: '', dataset: {}, parentElement: null,
          setAttribute() {}, addEventListener() {},
          querySelector: (selector: string) => value!.innerHTML.includes(selector.slice(1, -1)) ? {} : null,
        };
        elements.set(id, value);
      }
      return value;
    };
    vi.stubGlobal('document', {
      title: '', body: { dataset: {} }, fonts: { ready: Promise.resolve() },
      getElementById: getElement, querySelector: () => null,
    });
    vi.stubGlobal('location', {
      href: 'http://localhost/trivia.html?room=4821', hostname: 'localhost',
    });
    vi.stubGlobal('history', { state: null, replaceState() {} });
    vi.stubGlobal('addEventListener', () => undefined);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      if (callback.name !== 'updateTimeDrivenUi') queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal('performance', { now: () => 0 });

    await import('../client/trivia/trivia');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const connection = mocks.connections[0]!;
    connection.host?.(true);
    const loading = loadingState(false);
    connection.state?.(loading);
    expect(connection.ready).toEqual([4]);

    connection.error?.('not_ready', 'All admitted callers must be connected.');
    connection.state?.({ ...loading, serverNowMs: loading.serverNowMs + 1 });
    expect(connection.ready).toEqual([4]);
    expect(mocks.renderedErrors.at(-1)).toBe('');

    connection.state?.(loadingState(true));
    expect(connection.ready).toEqual([4, 4]);
  });

  it('acknowledges painted prompt and cue views on a host voice-only display', async () => {
    const elements = new Map<string, Record<string, any>>();
    const getElement = (id: string) => {
      let value = elements.get(id);
      if (!value) {
        value = {
          textContent: '', innerHTML: '', dataset: {}, parentElement: null,
          setAttribute() {}, addEventListener() {},
          querySelector: (selector: string) => value!.innerHTML.includes(selector.slice(1, -1)) ? {} : null,
        };
        elements.set(id, value);
      }
      return value;
    };
    vi.stubGlobal('document', {
      title: '', body: { dataset: {} }, fonts: { ready: Promise.resolve() },
      getElementById: getElement, querySelector: () => null,
    });
    vi.stubGlobal('location', { href: 'http://localhost/trivia.html?room=4821', hostname: 'localhost' });
    vi.stubGlobal('history', { state: null, replaceState() {} });
    vi.stubGlobal('addEventListener', () => undefined);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      if (callback.name !== 'updateTimeDrivenUi') queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal('performance', { now: () => 0 });

    await import('../client/trivia/trivia');
    await flushMicrotasks();
    const connection = mocks.connections[0]!;
    connection.connection?.('connected');
    connection.host?.(true);
    const prompt = questionView('question_prompt', 9);
    connection.state?.(prompt);
    await flushMicrotasks();
    expect(connection.painted).toEqual([{
      questionId: 'q1', questionAttemptId: 1, phase: 'question_prompt', renderRevision: 9,
    }]);

    connection.state?.(questionView('answer_cue', 10));
    await flushMicrotasks();
    expect(connection.painted.at(-1)).toEqual({
      questionId: 'q1', questionAttemptId: 1, phase: 'answer_cue', renderRevision: 10,
    });
  });

  it('sends only one category vote per visible seat until the display moves to the next seat', async () => {
    const elements = new Map<string, Record<string, any>>();
    const getElement = (id: string) => {
      let value = elements.get(id);
      if (!value) {
        value = {
          textContent: '', innerHTML: '', dataset: {}, parentElement: null, listeners: {},
          setAttribute() {}, addEventListener(type: string, callback: EventListener) { this.listeners[type] = callback; },
          querySelector: () => null,
        };
        elements.set(id, value);
      }
      return value;
    };
    vi.stubGlobal('document', {
      title: '', body: { dataset: {} }, fonts: { ready: Promise.resolve() },
      getElementById: getElement, querySelector: () => null,
    });
    vi.stubGlobal('location', { href: 'http://localhost/trivia.html?room=4821', hostname: 'localhost' });
    vi.stubGlobal('history', { state: null, replaceState() {} });
    vi.stubGlobal('addEventListener', () => undefined);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      if (callback.name !== 'updateTimeDrivenUi') queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal('performance', { now: () => 0 });

    await import('../client/trivia/trivia');
    await flushMicrotasks();
    const connection = mocks.connections[0]!;
    connection.connection?.('connected');
    connection.host?.(true);
    const category = {
      ...loadingState(true), phase: 'category_select',
      categoryVotingSeat: { playerId: 't1', name: 'Ada' },
    } as TriviaState;
    connection.state?.(category);
    const stage = getElement('trivia-stage');
    const click = (playerId: string) => stage.listeners.click({ target: {
      closest: () => ({ dataset: { voter: playerId, category: 'science' } }),
    } });

    click('t1');
    click('t1');
    expect(connection.votes).toEqual([{ playerId: 't1', category: 'science' }]);

    connection.state?.({ ...category, categoryVotingSeat: { playerId: 't2', name: 'Grace' } });
    click('t2');
    expect(connection.votes).toEqual([
      { playerId: 't1', category: 'science' },
      { playerId: 't2', category: 'science' },
    ]);
  });
});

function questionView(phase: 'question_prompt' | 'answer_cue', renderRevision: number): TriviaState {
  return {
    ...loadingState(true), phase, questionIndex: 0, questionAttemptId: 1, renderRevision,
    questionPromptEndsAtMs: 30_000, answerCueEndsAtMs: phase === 'answer_cue' ? 40_000 : null,
    answeringStartsAtMs: phase === 'answer_cue' ? 1_000 : null,
    questionEndsAtMs: phase === 'answer_cue' ? 26_000 : null,
    question: { id: 'q1', category: 'general', difficulty: 'easy', prompt: 'Question?',
      choices: [
        { id: 'a', text: 'One' }, { id: 'b', text: 'Two' },
        { id: 'c', text: 'Three' }, { id: 'd', text: 'Four' },
      ] },
  } as TriviaState;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function loadingState(connected: boolean): TriviaState {
  return {
    roomCode: '4821', phase: 'loading', expectedPlayerCount: 1, hasExpectedPlayers: true,
    automaticSetup: true, preferredLocale: 'en-US', category: 'science',
    categoryVoteCounts: {
      general: 0, science: 1, geography: 0, history: 0, entertainment: 0,
      sports: 0, technology: 0, twilio: 0, mixed: 0,
    },
    categoryVotingSeat: null,
    players: [{
      playerId: 't1', name: 'Ada', nameConfirmed: true, playerOrder: 0, connected,
      answered: false, rawScore: 0, correctCount: 0, bestStreak: 0,
    }],
    serverNowMs: 1_000, loadingGeneration: 4, displayReady: false, questionIndex: null,
    questionAttemptId: null, renderRevision: 0, audioProblem: null,
    countdownEndsAtMs: null, questionPromptEndsAtMs: null, answerCueEndsAtMs: null,
    answeringStartsAtMs: null, questionEndsAtMs: null, revealEndsAtMs: null,
    question: null, reveal: null, standings: null, result: null,
  };
}
