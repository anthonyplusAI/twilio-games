import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TriviaState } from '../shared/trivia-protocol';

const mocks = vi.hoisted(() => ({
  connections: [] as Array<{
    ready: number[];
    state?: (state: TriviaState) => void;
    error?: (code: string, message: string) => void;
    host?: (isHost: boolean) => void;
  }>,
  renderedErrors: [] as string[],
}));

vi.mock('../client/trivia/trivia-net', () => ({
  TriviaConnection: class {
    readonly record: (typeof mocks.connections)[number] = { ready: [] };
    constructor() { mocks.connections.push(this.record); }
    setDisplayAuth() {}
    onConnectionState() {}
    onClockSync() {}
    onJoined() {}
    onHostIdentity(callback: (isHost: boolean) => void) { this.record.host = callback; }
    onEvents() {}
    onError(callback: (code: string, message: string) => void) { this.record.error = callback; }
    onState(callback: (state: TriviaState) => void) { this.record.state = callback; }
    spectate() {}
    displayReady(generation: number) { this.record.ready.push(generation); }
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
    return { html: '', announcement: '', announcementKey: '' };
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
          setAttribute() {}, addEventListener() {}, querySelector: () => null,
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
});

function loadingState(connected: boolean): TriviaState {
  return {
    roomCode: '4821', phase: 'loading', expectedPlayerCount: 1, hasExpectedPlayers: true,
    automaticSetup: true, preferredLocale: 'en-US', category: 'science',
    categoryVoteCounts: {
      general: 0, science: 1, geography: 0, history: 0, entertainment: 0,
      sports: 0, technology: 0, twilio: 0, mixed: 0,
    },
    players: [{
      playerId: 't1', name: 'Ada', nameConfirmed: true, playerOrder: 0, connected,
      answered: false, rawScore: 0, correctCount: 0, bestStreak: 0,
    }],
    serverNowMs: 1_000, loadingGeneration: 4, displayReady: false, questionIndex: null,
    countdownEndsAtMs: null, questionPromptEndsAtMs: null, answerCueEndsAtMs: null,
    answeringStartsAtMs: null, questionEndsAtMs: null, revealEndsAtMs: null,
    question: null, reveal: null, standings: null, result: null,
  };
}
