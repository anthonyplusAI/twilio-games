import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TriviaPublicPlayer, TriviaState } from '../shared/trivia-protocol';
import { renderTriviaView, triviaDisplayCopy } from '../client/trivia/trivia-view';

const players: TriviaPublicPlayer[] = [
  { playerId: 'p1', name: 'Ada', nameConfirmed: true, playerOrder: 0, connected: true, answered: true, rawScore: 1_300, correctCount: 1, bestStreak: 1 },
  { playerId: 'p2', name: 'Grace', nameConfirmed: true, playerOrder: 1, connected: true, answered: false, rawScore: 0, correctCount: 0, bestStreak: 0 },
];

const question = {
  id: 'question-one',
  category: 'technology' as const,
  difficulty: 'medium' as const,
  prompt: 'Which protocol powers web sockets?',
  choices: [
    { id: 'alpha-secret', text: 'SMTP' },
    { id: 'bravo-secret', text: 'WebSocket' },
    { id: 'charlie-secret', text: 'FTP' },
    { id: 'delta-secret', text: 'POP3' },
  ],
};

function state(overrides: Partial<TriviaState>): TriviaState {
  return {
    roomCode: 'ROOM', phase: 'lobby', expectedPlayerCount: 2,
    hasExpectedPlayers: true, automaticSetup: true, preferredLocale: 'en-US', category: null,
    categoryVoteCounts: {
      general: 0, science: 0, geography: 0, history: 0, entertainment: 0,
      sports: 0, technology: 0, twilio: 0, mixed: 0,
    },
    players, serverNowMs: 20_000, loadingGeneration: 1, displayReady: false,
    questionIndex: null, countdownEndsAtMs: null, questionPromptEndsAtMs: null,
    answerCueEndsAtMs: null, answeringStartsAtMs: null, questionEndsAtMs: null, revealEndsAtMs: null,
    question: null, reveal: null, standings: null, result: null,
    ...overrides,
  } as unknown as TriviaState;
}

const context = {
  locale: 'en-US' as const,
  roomCode: 'ROOM',
  serverNowMs: 20_000,
  connectionState: 'connected' as const,
};

describe('Voice Trivia display DOM projection', () => {
  it('shows the configured call QR and a dial link in the standalone lobby', () => {
    const rendered = renderTriviaView(state({ phase: 'lobby', players: [] }), {
      ...context,
      callEntry: { number: '+15551234567', qrCode: 'data:image/png;base64,example', loading: false },
    });

    expect(rendered.html).toContain('data-view="lobby"');
    expect(rendered.html).toContain('src="data:image/png;base64,example"');
    expect(rendered.html).toContain('href="tel:+15551234567"');
    expect(rendered.html).toContain('+15551234567');
    expect(rendered.html).toContain('Scan to call');
  });

  it('keeps the standalone call QR out of station and pairing screens', () => {
    const callEntry = { number: '+15551234567', qrCode: 'data:image/png;base64,example', loading: false };
    const station = renderTriviaView(state({ phase: 'lobby' }), { ...context, stationMode: true, callEntry });
    expect(station.html).toContain('data-view="lobby"');
    expect(station.html).not.toContain('tel:+15551234567');
    expect(station.html).not.toContain('data:image/png;base64,example');

    const pairingError = renderTriviaView(state({ phase: 'lobby' }), {
      ...context, stationMode: true, pairingRequired: true, callEntry,
    });
    expect(pairingError.html).toContain('data-view="pairing"');
    expect(pairingError.html).not.toContain('tel:+15551234567');
    expect(pairingError.html).not.toContain('data:image/png;base64,example');
  });

  it('states when a Portuguese lobby cannot show a call number or QR', () => {
    const noNumber = renderTriviaView(state({ phase: 'lobby' }), {
      ...context, locale: 'pt-BR', callEntry: { number: '', qrCode: null, loading: false },
    });
    expect(noNumber.html).toContain('Número para ligar indisponível');
    expect(noNumber.html).not.toContain('href="tel:');
    expect(noNumber.html).not.toContain('<img src="data:image/png');

    const noQr = renderTriviaView(state({ phase: 'lobby' }), {
      ...context, locale: 'pt-BR', callEntry: { number: '+5511999999999', qrCode: null, loading: false },
    });
    expect(noQr.html).toContain('Código QR indisponível');
    expect(noQr.html).toContain('href="tel:+5511999999999"');
    expect(noQr.html).not.toContain('<img src="data:image/png');
  });

  it('renders 1-4 and locked status without active-question answer keys or browser controls', () => {
    const activeQuestion = {
      ...question,
      choices: question.choices.map((choice, index) => ({ ...choice, aliases: [`private-alias-${index}`] })),
      correctChoiceId: 'bravo-secret',
      explanation: 'must remain hidden',
      source: { url: 'https://hidden.example' },
    };
    const rendered = renderTriviaView(state({
      phase: 'question', questionIndex: 0, question: activeQuestion,
      answeringStartsAtMs: 15_000, questionEndsAtMs: 25_000,
    }), context);

    expect(rendered.html).toContain('data-view="question"');
    expect(rendered.html).toContain('id="question-seconds">5</strong>');
    expect(rendered.html).toMatch(/<span>1<\/span>[\s\S]*<span>2<\/span>[\s\S]*<span>3<\/span>[\s\S]*<span>4<\/span>/);
    expect(rendered.html).toContain('Answer locked');
    expect(rendered.html).not.toContain('correct-choice');
    expect(rendered.html).not.toContain('bravo-secret');
    expect(rendered.html).not.toContain('private-alias');
    expect(rendered.html).not.toContain('must remain hidden');
    expect(rendered.html).not.toContain('hidden.example');
    expect(rendered.html).not.toMatch(/<(button|input|form)\b/);
  });

  it('uses only authoritative reveal data for correctness and score deltas', () => {
    const standings = players.map((player, index) => ({
      ...player, rank: index + 1, normalizedScore: index ? 0 : 10_078, cumulativeCorrectTimeMs: index ? 0 : 1_500,
    }));
    const rendered = renderTriviaView(state({
      phase: 'reveal', questionIndex: 0, question,
      reveal: { questionId: question.id, correctChoiceId: 'bravo-secret', explanation: 'It is an upgraded HTTP connection.' },
      standings,
    }), {
      ...context,
      answerResults: new Map([
        ['p1', { correct: true, points: 1_300, rawScore: 1_300 }],
      ]),
    });

    expect(rendered.html.match(/class="correct-choice"/g)).toHaveLength(1);
    expect(rendered.html).toContain('It is an upgraded HTTP connection.');
    expect(rendered.html).toContain('Correct · +1300 pts');
    expect(rendered.html).toContain('No answer');
    expect(rendered.announcement).toContain('Correct answer: WebSocket');
  });

  it('renders a localized answer cue status with no answer countdown', () => {
    const cue = renderTriviaView(state({
      phase: 'answer_cue', questionIndex: 0, question,
      answerCueEndsAtMs: 45_000, answeringStartsAtMs: null, questionEndsAtMs: null,
    }), context);
    expect(cue.html).toContain('data-view="answer_cue"');
    expect(cue.html).toContain('Get ready to answer');
    expect(cue.html).toContain('Phones are synchronizing the answer cue.');
    expect(cue.html).not.toContain('id="question-seconds"');
    expect(cue.announcement).toBe('Get ready to answer. Phones are synchronizing the answer cue.');

    const portuguese = renderTriviaView(state({
      phase: 'answer_cue', questionIndex: 0, question,
    }), { ...context, locale: 'pt-BR' });
    expect(portuguese.html).toContain('Preparem-se para responder');
    expect(portuguese.html).toContain('Os telefones estão sincronizando o aviso de resposta.');
  });

  it('shows answering immediately without the obsolete pre-start wait UI', () => {
    const rendered = renderTriviaView(state({
      phase: 'question', questionIndex: 0, question,
      answeringStartsAtMs: 23_000, questionEndsAtMs: 33_000,
    }), context);
    expect(rendered.html).toContain('id="question-seconds">10</strong>');
    expect(rendered.html).toContain('Listening');
    expect(rendered.html).toContain('Answer now');
    expect(rendered.html).not.toContain('question-start-seconds');
    expect(rendered.html).not.toContain('Answers open in');
  });

  it('renders live category totals, roster readiness, and terminal result data', () => {
    const categories = renderTriviaView(state({
      phase: 'category_select',
      categoryVoteCounts: {
        general: 0, science: 1, geography: 0, history: 0, entertainment: 0,
        sports: 0, technology: 1, twilio: 0, mixed: 0,
      },
    }), context);
    expect(categories.html).toContain('<b>1</b> vote');
    expect(categories.announcement).toBe('2 votes.');

    const lobby = renderTriviaView(state({ phase: 'lobby', expectedPlayerCount: 3, hasExpectedPlayers: false }), context);
    expect(lobby.html).toContain('Ada');
    expect(lobby.html).toContain('Open seat');

    const results = renderTriviaView(state({
      phase: 'results', category: 'technology', standings: [],
      result: {
        resultId: 'result-1', generation: 1, category: 'technology', contentRevision: 'rev-1', completedAtMs: 30_000,
        players: [
          { playerId: 'p1', name: 'Ada', playerOrder: 0, rank: 1, rawScore: 1_300, normalizedScore: 10_078, correctCount: 1, bestStreak: 1, cumulativeCorrectTimeMs: 1_500 },
          { playerId: 'p2', name: 'Grace', playerOrder: 1, rank: 2, rawScore: 0, normalizedScore: 0, correctCount: 0, bestStreak: 0, cumulativeCorrectTimeMs: 0 },
        ],
      },
    }), { ...context, canReplay: true });
    expect(results.html).toContain('Winner');
    expect(results.html).toContain('Ada');
    expect(results.html).toContain('Leaderboard score');
    expect(results.html).toContain('10,078');
    expect(results.html).toContain('id="trivia-replay"');
    expect(results.html).toContain('Play again');
    expect(results.html).toContain('id="trivia-exit"');
    expect(results.html).toContain('Exit');

    const tied = renderTriviaView(state({
      phase: 'results',
      result: {
        resultId: 'result-tie', generation: 2, category: 'mixed', contentRevision: 'rev-1', completedAtMs: 40_000,
        players: [
          { playerId: 'p1', name: 'Ada', playerOrder: 0, rank: 1, rawScore: 1_300, normalizedScore: 10_078, correctCount: 1, bestStreak: 1, cumulativeCorrectTimeMs: 1_500 },
          { playerId: 'p2', name: 'Grace', playerOrder: 1, rank: 1, rawScore: 1_300, normalizedScore: 10_078, correctCount: 1, bestStreak: 1, cumulativeCorrectTimeMs: 1_500 },
        ],
      },
    }), context);
    expect(tied.html).toContain('It is a tie');
    expect(tied.announcement).toContain('Ada and Grace');

    const portuguese = renderTriviaView(state({ phase: 'results' }), {
      ...context, locale: 'pt-BR', canReplay: true,
    });
    expect(portuguese.html).toContain('Jogar novamente');
    expect(portuguese.html).toContain('Sair');
  });

  it('makes only the named current category voting seat touchable', () => {
    const categories = renderTriviaView(state({
      phase: 'category_select', categoryVotingSeat: { playerId: 'p2', name: 'Grace' },
    }), { ...context, isHost: true });
    expect(categories.html).toContain('Grace');
    expect(categories.html).toContain('data-category="science"');
    expect(categories.html).toContain('data-voter="p2"');
    const spectator = renderTriviaView(state({
      phase: 'category_select', categoryVotingSeat: { playerId: 'p2', name: 'Grace' },
    }), { ...context, isHost: false });
    expect(spectator.html).not.toContain('data-voter=');
  });

  it('binds announcements to question attempt and keeps reveal speech short', () => {
    const first = renderTriviaView(state({ phase: 'question_prompt', questionIndex: 0,
      questionAttemptId: 5, question }), context);
    const retry = renderTriviaView(state({ phase: 'question_prompt', questionIndex: 0,
      questionAttemptId: 6, question }), context);
    expect(first.announcementKey).not.toBe(retry.announcementKey);
    const reveal = renderTriviaView(state({ phase: 'reveal', questionIndex: 0,
      questionAttemptId: 6, question,
      reveal: { questionId: question.id, correctChoiceId: 'bravo-secret',
        explanation: 'A very long explanation should remain visible but should not be announced.' },
    }), context);
    expect(reveal.html).toContain('A very long explanation');
    expect(reveal.announcement).not.toContain('A very long explanation');
  });

  it('shows a terminal audio failure once the operator retry window expires', () => {
    const expired = renderTriviaView(state({ phase: 'audio_expired', question: null,
      questionAttemptId: 7, audioProblem: null }), context);
    expect(expired.html).toContain('This round has ended');
    expect(expired.html).not.toContain('retry this question');
    expect(expired.announcementKey).toContain('7');
  });

  it('escapes server-provided text and includes the accessibility and motion contracts', () => {
    const rendered = renderTriviaView(state({
      phase: 'question', questionIndex: 0,
      question: { ...question, prompt: '<img src=x onerror=alert(1)>' },
      answeringStartsAtMs: 20_000, questionEndsAtMs: 30_000,
    }), context);
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered.html).not.toContain('<img src=x');

    const html = readFileSync(new URL('../client/trivia.html', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../client/trivia/trivia.css', import.meta.url), 'utf8');
    const vite = readFileSync(new URL('../client/vite.config.ts', import.meta.url), 'utf8');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-label="Voice Trivia quiz stage"');
    expect(html).toContain('id="music-toggle-container"');
    expect(css).toContain('@media (prefers-reduced-motion:reduce)');
    expect(css).toContain('@media (max-width:700px)');
    expect(vite).toContain("trivia: resolve(__dirname, 'trivia.html')");
    expect(vite).toMatch(/'\/trivia':\s*\{[\s\S]*?target: gameServer,[\s\S]*?ws: true/);
  });

  it('localizes Portuguese home, stage, theme, and connection accessibility labels', () => {
    const copy = triviaDisplayCopy('pt-BR');
    expect(copy.home).toBe('Início');
    expect(copy.homeLabel).toBe('Voltar ao início do Twilio Games');
    expect(copy.stageLabel).toBe('Palco do Quiz por Voz');
    expect(copy.theme).toEqual({ light: 'Tema claro', dark: 'Tema escuro' });
    expect(copy.connection).toEqual({
      connecting: 'Conectando', connected: 'Ao vivo', reconnecting: 'Reconectando', closed: 'Desconectado',
    });

    const client = readFileSync(new URL('../client/trivia/trivia.ts', import.meta.url), 'utf8');
    expect(client).toContain("homeLink?.setAttribute('aria-label', copy.homeLabel)");
    expect(client).toContain("stage.setAttribute('aria-label', copy.stageLabel)");
    expect(client).toContain('connectionStatus.textContent = copy.connection.connecting');
    expect(client).toContain('light: copy.theme.light');
    expect(client).toContain('dark: copy.theme.dark');
  });

  it('retries rejected display readiness only after the next authoritative loading state', () => {
    const client = readFileSync(new URL('../client/trivia/trivia.ts', import.meta.url), 'utf8');
    const notReadyBranch = client.match(/if \(code === 'not_ready'\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    const applyState = client.match(/function applyState\([\s\S]*?\n\}/)?.[0] ?? '';

    expect(notReadyBranch).toContain('readySentGeneration = 0');
    expect(notReadyBranch).toContain('rejectedReadyContext = displayReadinessContext(state)');
    expect(notReadyBranch).not.toContain('maybeSignalDisplayReady()');
    expect(notReadyBranch).not.toContain('stageError =');
    expect(applyState).toContain("displayReadinessContext(next) !== rejectedReadyContext");
    expect(applyState).toContain('else if (readinessChanged)');
    expect(client).toContain('rejectedReadyContext === displayReadinessContext(state)');
    expect(client).toContain('readySentGeneration = state.loadingGeneration;');
  });
});
