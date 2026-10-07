import { describe, expect, it, vi } from 'vitest';
import {
  TRIVIA_SPEECH_MAX_ATTEMPTS,
  TRIVIA_SPEECH_RETRY_DELAY_MS,
  TriviaVoiceSession,
  matchTriviaAnswer,
  matchTriviaCategory,
  type TriviaVoiceChoice,
  type TriviaVoiceSnapshot,
  type TriviaSpeechOutcome,
  type TriviaIntentRequest,
  type TriviaIntentResult,
} from '../server/trivia-voice';
import { normalizeTriviaScore, TRIVIA_ROUND_CATEGORY_IDS } from '../shared/trivia';
import type {
  TriviaCategoryVoteCounts,
  TriviaPublicStanding,
  TriviaResult,
} from '../shared/trivia-protocol';
import type { SupportedLocale } from '../shared/i18n/locales';

const choices: readonly TriviaVoiceChoice[] = [
  { id: 'rome', text: 'Rome', aliases: ['the eternal city'] },
  { id: 'paris', text: 'Paris', aliases: ['the city of light'] },
  { id: 'madrid', text: 'Madrid', aliases: ['capital of Spain'] },
  { id: 'vienna', text: 'Vienna', aliases: ['Wien'] },
];

const portugueseChoices: readonly TriviaVoiceChoice[] = [
  { id: 'rome', text: 'Roma', aliases: ['a cidade eterna'] },
  { id: 'paris', text: 'Paris', aliases: ['a cidade luz'] },
  { id: 'madrid', text: 'Madri', aliases: ['capital da Espanha'] },
  { id: 'vienna', text: 'Viena', aliases: ['Wien'] },
];

describe('TriviaVoiceSession setup and categories', () => {
  it('never asks for or captures a name after the display has left onboarding', () => {
    const unconfirmed = player({ name: 'Player', nameConfirmed: false });
    const category = harness(baseState({ phase: 'category_select', myName: 'Player',
      nameConfirmed: false, players: [unconfirmed] }), 'en-US', { resumed: true });
    category.setup();
    category.prompt('science');
    expect(category.calls.votes).toEqual(['science']);
    expect(category.calls.setName).toEqual([]);
    expect(category.spoken.some(item => /what is your first name/i.test(item.text))).toBe(false);

    const question = harness(questionState({ myName: 'Player', nameConfirmed: false,
      players: [unconfirmed] }), 'en-US', { resumed: true });
    question.setup();
    question.prompt('Paris');
    expect(question.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 1_000 }]);
    expect(question.calls.setName).toEqual([]);
    expect(question.spoken.some(item => /what is your first name/i.test(item.text))).toBe(false);
  });
  it('speaks the new category menu after a shared-display replay changes results', async () => {
    const game = harness(resultState([resultPlayer('t1', 'Ada', 2_600, 2, 1)]),
      'en-US', { resumed: true });
    game.setup();
    await game.session.whenSpeechSettled();
    const spokenBeforeTouch = game.spoken.length;

    game.setState({ phase: 'category_select', result: null, categoryVoteCounts: emptyVotes(), myCategoryVote: null });
    game.session.onStateChanged();
    await game.session.whenSpeechSettled();
    expect(game.spoken.slice(spokenBeforeTouch).map(line => line.text).join(' '))
      .toMatch(/Choose a category.*1, General Knowledge/i);
    expect(game.spoken.slice(spokenBeforeTouch).map(line => line.text).join(' '))
      .not.toMatch(/wins with a leaderboard score/i);
  });

  it('retires the technology introduction when the visible menu changes', () => {
    const game = harness(baseState({ expectedPlayerCount: 2, hasExpectedPlayers: false }));
    game.setup();
    const introduction = game.spoken.find(line => /Twilio Conversation Relay/i.test(line.text));
    expect(introduction?.isCurrent?.()).toBe(true);
    game.setState({ phase: 'category_select' });
    game.session.onStateChanged();
    expect(introduction?.isCurrent?.()).toBe(false);
    game.setState({ phase: 'loading', loadingGeneration: 1, myCategoryVote: 'science' });
    game.session.onStateChanged();
    expect(game.state.phase).toBe('loading');
    expect(introduction?.isCurrent?.()).toBe(false);
    game.setState({ phase: 'category_select' });
    game.session.onStateChanged();
    expect(introduction?.isCurrent?.()).toBe(false);
  });

  it.each([
    {
      locale: 'en-US' as const,
      name: 'Ada',
      category: 'I would like science',
      welcome: /Welcome to Voice Trivia, Ada/,
      categoryPrompt: /Choose a category.*1, General Knowledge.*2, Science.*Mixed/i,
      selected: /Science selected/,
      preparing: /Preparing the trivia round/,
    },
    {
      locale: 'pt-BR' as const,
      name: 'Ana',
      category: 'eu quero ciencias',
      welcome: /Quiz por Voz, Ana/,
      categoryPrompt: /Escolha uma categoria.*1, Conhecimentos Gerais.*2, Ciências.*Misturado/i,
      selected: /Categoria Ciências selecionada/i,
      preparing: /Preparando a rodada de quiz/,
    },
  ])('captures a final name and completes deterministic category setup in $locale', row => {
    const game = harness(baseState({
      myName: null,
      nameConfirmed: false,
      players: [player({ name: row.locale === 'pt-BR' ? 'Jogador' : 'Player', nameConfirmed: false })],
    }), row.locale);
    game.setup();

    expect(game.spoken[0]?.text).toMatch(/Twilio Conversation Relay/i);
    expect(game.spoken.at(-1)?.text).toMatch(row.locale === 'pt-BR' ? /primeiro nome/i : /first name/i);
    game.prompt(row.name, false);
    expect(game.state.phase).toBe('lobby');
    game.prompt(row.name);

    expect(game.calls.setName).toEqual([row.name]);
    expect(game.state.phase).toBe('category_select');
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(row.welcome);
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(row.categoryPrompt);

    game.prompt(row.category);
    expect(game.calls.votes).toEqual(['science']);
    expect(game.state.phase).toBe('loading');
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(row.selected);
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(row.preparing);
  });

  it('waits for every expected caller to confirm a name before one trusted advance', () => {
    const game = harness(baseState({
      myName: 'Ada',
      nameConfirmed: true,
      expectedPlayerCount: 2,
      hasExpectedPlayers: true,
      automaticSetup: true,
      players: [
        player({ playerId: 't1', name: 'Ada' }),
        player({ playerId: 't2', name: 'Player', nameConfirmed: false }),
      ],
    }));
    game.session.setExpectedPlayers(2);
    game.session.setAuthoritativeName('Ada');
    game.setup();

    expect(game.calls.bindExpectedPlayers).toEqual([2]);
    expect(game.calls.advances).toBe(0);
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(/Waiting for all 2 players/i);

    game.setState({
      players: [player({ playerId: 't1', name: 'Ada' }), player({ playerId: 't2', name: 'Grace' })],
    });
    game.session.onStateChanged();

    expect(game.calls.advances).toBe(1);
    expect(game.state.phase).toBe('category_select');
  });

  it('passes only a validated station participant index into the authoritative bind', () => {
    const game = harness(baseState());
    game.session.setStationManaged(true);
    game.session.setStationAssignment(3);
    game.setup();
    expect(game.calls.bindParticipantIndexes).toEqual([3]);
    expect(() => game.session.setStationAssignment(-1)).toThrow(RangeError);
    expect(() => game.session.setStationAssignment(4)).toThrow(RangeError);

    const standalone = harness(baseState());
    standalone.setup();
    expect(standalone.calls.bindParticipantIndexes).toEqual([undefined]);
  });

  it('coordinates four independent callers through one authoritative lobby and vote', () => {
    let phase: TriviaVoiceSnapshot['phase'] = 'lobby';
    let loadingGeneration = 0;
    let successfulAdvances = 0;
    const players: Array<TriviaVoiceSnapshot['players'][number]> = [];
    const votes = new Map<string, (typeof TRIVIA_ROUND_CATEGORY_IDS)[number]>();
    const sessions: TriviaVoiceSession[] = [];
    const counts = () => {
      const result = { ...emptyVotes() };
      for (const category of votes.values()) result[category] += 1;
      return result;
    };
    const notify = () => sessions.forEach(session => session.onStateChanged());
    const snapshot = (playerId: string): TriviaVoiceSnapshot => {
      const me = players.find(candidate => candidate.playerId === playerId)!;
      return baseState({
        phase,
        myName: me.name,
        nameConfirmed: me.nameConfirmed,
        expectedPlayerCount: 4,
        hasExpectedPlayers: players.length === 4,
        automaticSetup: true,
        players: players.slice(),
        categoryVoteCounts: counts(),
        loadingGeneration,
      });
    };

    for (let index = 0; index < 4; index++) {
      let session!: TriviaVoiceSession;
      session = new TriviaVoiceSession({
        bind: () => {
          const playerId = `t${index + 1}`;
          players.push(player({ playerId, name: 'Player', nameConfirmed: false }));
          return { playerId, resumed: false };
        },
        leave: () => {},
        setName: (_code, playerId, name) => {
          const playerIndex = players.findIndex(candidate => candidate.playerId === playerId);
          players[playerIndex] = { ...players[playerIndex]!, name, nameConfirmed: true };
          notify();
          return true;
        },
        voteCategory: (_code, playerId, category) => {
          const accepted = phase === 'category_select';
          if (!accepted) return false;
          votes.set(playerId, category);
          notify();
          return true;
        },
        advance: () => {
          if (phase === 'lobby' && players.length === 4 && players.every(candidate => candidate.nameConfirmed)) {
            phase = 'category_select';
          } else if (phase === 'category_select' && votes.size === 4) {
            phase = 'loading';
            loadingGeneration = 1;
          } else return false;
          successfulAdvances += 1;
          notify();
          return true;
        },
        questionPromptReady: () => false,
        beginPromptDelivery: () => null,
        questionPromptSkipped: () => false,
        beginAnswerCueDelivery: () => null,
        questionAnswerCueReady: () => false,
        questionAnswerCueSkipped: () => false,
        beginRevealDelivery: () => null,
        questionRevealReady: () => false,
        queueEarlyAnswer: () => false,
        pauseAudio: () => false,
        retryQuestion: () => 'unavailable',
        beginAnswerResolution: () => null,
        finishAnswerResolution: () => false,
        answerAt: () => false,
        snapshot: (_code, playerId) => snapshot(playerId),
        say: async () => 'played',
        preemptSpeech: () => {},
      });
      session.setExpectedPlayers(4);
      sessions.push(session);
      session.handleMessage(JSON.stringify({
        type: 'setup', callSid: `CA-${index}`, customParameters: { roomCode: 'TEAM' },
      }));
    }

    ['Ada', 'Grace', 'Linus', 'Margaret'].forEach((name, index) => {
      sessions[index]!.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: name, last: true }));
    });
    expect(phase).toBe('category_select');
    expect(new Set(sessions.map(session => session.boundPlayerId))).toHaveLength(4);

    ['science', 'history', 'science', 'science'].forEach((category, index) => {
      sessions[index]!.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: category, last: true }));
    });
    expect(phase).toBe('loading');
    expect(successfulAdvances).toBe(2);
  });

  it('rejects command-like names and unknown categories without mutating authority', () => {
    const unnamed = harness(baseState({
      myName: null,
      nameConfirmed: false,
      players: [player({ name: 'Player', nameConfirmed: false })],
    }));
    unnamed.setup();
    unnamed.prompt('science');
    expect(unnamed.calls.setName).toEqual([]);
    expect(unnamed.spoken.at(-1)?.text).toMatch(/only your first name/i);

    const category = harness(baseState({ phase: 'category_select' }));
    category.setup();
    category.prompt('purple elephants');
    expect(category.calls.votes).toEqual([]);
    expect(category.spoken.at(-1)?.text).toMatch(/did not recognize that category/i);
  });

  it('matches category labels, aliases, cardinals, and ordinals without AI', () => {
    expect(matchTriviaCategory('category number two')).toBe('science');
    expect(matchTriviaCategory('I vote for science')).toBe('science');
    expect(matchTriviaCategory('my vote is science')).toBe('science');
    expect(matchTriviaCategory('eu voto em ciências', 'pt-BR')).toBe('science');
    expect(matchTriviaCategory('category two please')).toBe('science');
    expect(matchTriviaCategory('tech')).toBe('technology');
    expect(matchTriviaCategory('9')).toBe('mixed');
    expect(matchTriviaCategory('eu prefiro a terceira', 'pt-BR')).toBe('geography');
    expect(matchTriviaCategory('categoria dois por favor', 'pt-BR')).toBe('science');
    expect(matchTriviaCategory('filmes e musica', 'pt-BR')).toBe('entertainment');
    expect(matchTriviaCategory('something unrelated')).toBeNull();
  });

  it('answers category questions without recording a vote, while keeping direct choices fast', async () => {
    const requests: TriviaIntentRequest[] = [];
    const game = harness(baseState({ phase: 'category_select' }), 'en-US', {
      resolveIntent: async request => {
        requests.push(request);
        return { kind: 'answer', factId: request.transcript.includes('Science')
          ? 'category:science' : 'categories' };
      },
    });
    game.setup();
    expect(matchTriviaCategory('What is Science?')).toBeNull();
    expect(matchTriviaCategory('Can you explain the Science category?')).toBeNull();
    game.prompt('What is Science?');
    await game.session.whenSpeechSettled();
    game.prompt('Can you explain the Science category?');
    await game.session.whenSpeechSettled();
    expect(game.calls.votes).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.actions.length === 0)).toBe(true);
    expect(game.spoken.at(-1)?.text).toMatch(/Science.*category/i);

    game.prompt('Can I choose Science?');
    expect(game.calls.votes).toEqual(['science']);
  });

  it('does not treat category comparisons or consideration as a vote', async () => {
    for (const remark of ['Science seems hard', 'I am thinking about Science',
      'Compare Science with History', 'Science or History']) {
      expect(matchTriviaCategory(remark)).toBeNull();
    }
    expect(matchTriviaCategory('I would like Science')).toBe('science');
    const requests: TriviaIntentRequest[] = [];
    const game = harness(baseState({ phase: 'category_select' }), 'en-US', {
      resolveIntent: async request => { requests.push(request); return { kind: 'clarify' }; },
    });
    game.setup();
    game.prompt('Science seems hard');
    await game.session.whenSpeechSettled();
    expect(game.calls.votes).toEqual([]);
    expect(requests[0]?.transcript).toBe('Science seems hard');
  });

  it('answers a category question even if an interpreter proposes a forbidden vote', async () => {
    const game = harness(baseState({ phase: 'category_select' }), 'en-US', {
      resolveIntent: async () => ({ kind: 'action', actionId: 'select_category', targetId: 'science' }),
    });
    game.setup();
    game.prompt('Tell me about Science');
    await game.session.whenSpeechSettled();
    expect(game.calls.votes).toEqual([]);
    expect(game.spoken.at(-1)?.text).toMatch(/categories|category/i);
  });

  it('uses the player\'s correction and does not choose a negated category', () => {
    expect(matchTriviaCategory('Science, wait, no, actually history', 'en-US')).toBe('history');
    expect(matchTriviaCategory('not science please', 'en-US')).toBeNull();
    expect(matchTriviaCategory('no science', 'en-US')).toBeNull();
    expect(matchTriviaCategory('ciências, não, história', 'pt-BR')).toBe('history');
  });

  it('drops a delayed category interpretation after a shared-display vote fills that seat', async () => {
    let finish!: (result: TriviaIntentResult) => void;
    const pending = new Promise<TriviaIntentResult>(resolve => { finish = resolve; });
    const game = harness(baseState({
      phase: 'category_select', expectedPlayerCount: 2,
      players: [player(), player({ playerId: 't2', name: 'Grace' })],
    }), 'en-US', { resolveIntent: () => pending });
    game.setup();
    const utterance = 'the topic about tiny particles';
    expect(matchTriviaCategory(utterance)).toBeNull();
    game.prompt(utterance);
    game.setState({ myCategoryVote: 'history', categoryVoteCounts: { ...emptyVotes(), history: 1 } });
    game.session.onStateChanged();
    finish({ kind: 'action', actionId: 'select_category', targetId: 'science' });
    await game.session.whenSpeechSettled();
    expect(game.calls.votes).toEqual([]);
    expect(game.state.myCategoryVote).toBe('history');
  });

  it('preempts a stale category list and confirms a same-phase touchscreen vote', () => {
    const game = harness(baseState({
      phase: 'category_select', expectedPlayerCount: 2,
      players: [player(), player({ playerId: 't2', name: 'Grace' })],
    }), 'en-US', { resumed: true });
    game.setup();
    const categoryList = game.spoken.find(item => /Choose a category:/.test(item.text))!;
    expect(categoryList.isCurrent?.()).toBe(true);
    const preemptsBeforeTouch = game.calls.preempts;

    game.setState({
      myCategoryVote: 'science',
      categoryVoteCounts: { ...emptyVotes(), science: 1 },
    });
    game.session.onStateChanged();
    expect(categoryList.isCurrent?.()).toBe(false);
    expect(game.calls.preempts).toBe(preemptsBeforeTouch + 1);
    expect(game.spoken.at(-1)?.text).toBe('Science selected.');
    game.session.onStateChanged();
    expect(game.spoken.filter(item => item.text === 'Science selected.')).toHaveLength(1);
  });

  it('gives a conversational category command the full three-second interpretation budget', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (result: TriviaIntentResult) => void;
      const pending = new Promise<TriviaIntentResult>(resolve => { finish = resolve; });
      const game = harness(baseState({ phase: 'category_select' }), 'en-US', {
        resolveIntent: () => pending,
      });
      game.setup();
      game.prompt('the topic about tiny particles');
      await vi.advanceTimersByTimeAsync(2_500);
      finish({ kind: 'action', actionId: 'select_category', targetId: 'science' });
      await game.session.whenSpeechSettled();
      expect(game.calls.votes).toEqual(['science']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens category selection with reachable guidance after a loading timeout', () => {
    const game = harness(baseState({ phase: 'loading', loadingGeneration: 3 }), 'en-US', { resumed: true });
    game.setup();
    game.setState({ phase: 'category_select', categoryVoteCounts: emptyVotes(), loadingGeneration: 4 });
    game.session.onStateChanged();

    const speech = game.spoken.map(item => item.text).join(' ');
    expect(speech).toMatch(/display did not become ready.*choose a category again/i);
    expect(speech).toMatch(/Choose a category/i);
    expect(game.calls.advances).toBe(0);
  });

  it('invalidates queued intro speech after category selection advances the screen', () => {
    const game = harness(baseState());
    game.setup();
    const intro = game.spoken.find(item => /I will ask each question/i.test(item.text));
    expect(intro?.isCurrent?.()).toBe(true);
    game.prompt('science');
    expect(game.state.phase).toBe('loading');
    expect(intro?.isCurrent?.()).toBe(false);
  });
});

describe('TriviaVoiceSession question playback and answers', () => {
  it.each([
    { locale: 'en-US' as const, request: 'Could you try that question again for us?' },
    { locale: 'pt-BR' as const, request: 'Pode repetir essa pergunta de novo, por favor?' },
  ])('replays the current failed question promptly when the $locale caller asks', row => {
    const game = harness(audioProblemState(), row.locale, { resumed: true });
    game.setup();
    game.prompt(row.request);
    expect(game.calls.retries).toEqual([{ questionId: 'question-1', attemptId: 1 }]);
    expect(game.state).toMatchObject({ phase: 'question_prompt', questionAttemptId: 2 });
  });

  it('uses semantic intent for a conversational failed-audio retry and ignores a stale result', async () => {
    const requests: TriviaIntentRequest[] = [];
    const game = harness(audioProblemState(), 'en-US', { resumed: true,
      resolveIntent: async request => {
        requests.push(request);
        return { kind: 'action', actionId: 'retry_question' };
      } });
    game.setup();
    game.prompt('That audio vanished; can we hear the whole item from the top?');
    await game.session.whenSpeechSettled();
    expect(requests[0]).toMatchObject({ phase: 'audio_problem',
      actions: [expect.objectContaining({ id: 'retry_question' })] });
    expect(game.calls.retries).toEqual([{ questionId: 'question-1', attemptId: 1 }]);

    let resolveIntent!: (result: TriviaIntentResult) => void;
    const stale = harness(audioProblemState(), 'en-US', { resumed: true,
      resolveIntent: () => new Promise(resolve => { resolveIntent = resolve; }) });
    stale.setup();
    stale.prompt('Can we hear that from the top?');
    await flushMicrotasks();
    stale.setState({ questionAttemptId: 2 });
    resolveIntent({ kind: 'action', actionId: 'retry_question' });
    await stale.session.whenSpeechSettled();
    expect(stale.calls.retries).toEqual([]);
  });

  it('keeps station audio recovery operator-owned and explains the standalone retry limit', () => {
    const station = harness(audioProblemState(), 'en-US', { resumed: true });
    station.session.setStationManaged(true);
    station.setup();
    station.prompt('Please replay that question');
    expect(station.calls.retries).toEqual([]);
    expect(station.spoken.some(item => /operator to replay/i.test(item.text))).toBe(true);

    const limited = harness(audioProblemState({ audioRetryRemaining: 0 }), 'en-US',
      { resumed: true, retryOutcome: 'limit' });
    limited.setup();
    expect(limited.spoken.some(item => /hang up and call back/i.test(item.text))).toBe(true);
    limited.prompt('Try again');
    expect(limited.calls.retries).toEqual([{ questionId: 'question-1', attemptId: 1 }]);
    expect(limited.state.phase).toBe('audio_problem');
  });
  it('accepts estimated Relay completion only for the current painted prompt and cue', async () => {
    const game = harness(questionPromptState(), 'en-US', {
      deferQuestion: true, deferCue: true, manualTimers: true,
    });
    game.setup();
    game.settleQuestion('estimated');
    await flushMicrotasks();
    expect(game.calls.promptReady).toEqual(['question-1']);
    expect(game.state.phase).toBe('answer_cue');
    expect(game.retryTimerCount).toBe(0);

    game.setState({ displayViewReady: true });
    game.session.onStateChanged();
    game.settleCue('estimated');
    await game.session.whenSpeechSettled();
    expect(game.calls.cueReady).toEqual(['question-1']);
    expect(game.state.phase).toBe('question');
  });

  it('waits for the current display view to paint before starting required question and cue audio', async () => {
    const game = harness(questionPromptState({ displayViewReady: false }));
    game.setup();
    expect(game.questionSpeech()).toHaveLength(0);

    game.setState({ displayViewReady: true });
    game.session.onStateChanged();
    expect(game.questionSpeech()).toHaveLength(1);
    await game.session.whenSpeechSettled();
    expect(game.state.phase).toBe('answer_cue');
    expect(game.spoken.filter(item => item.text.startsWith('Get ready.'))).toHaveLength(0);

    game.setState({ displayViewReady: true });
    game.session.onStateChanged();
    await game.session.whenSpeechSettled();
    expect(game.state.phase).toBe('question');
  });

  it('finishes the spoken question before starting the choice-reading clock', async () => {
    const game = harness(questionPromptState(), 'en-US', { deferQuestion: true });
    game.setup();
    expect(game.questionSpeech()).toHaveLength(1);
    expect(game.questionSpeech()[0]?.text).toMatch(/Question 1.*France/i);
    expect(game.questionSpeech()[0]?.text).not.toMatch(/choices are|One, Rome/i);
    expect(game.calls.promptReady).toEqual([]);
    game.settleQuestion(true);
    await game.session.whenSpeechSettled();
    expect(game.calls.promptReady).toEqual(['question-1']);
    expect(game.state.phase).toBe('answer_cue');
    game.setState({ displayViewReady: true });
    game.session.onStateChanged();
    await game.session.whenSpeechSettled();
    expect(game.spoken.some(item => /The choices are One, Rome.*Four, Vienna/i.test(item.text))).toBe(true);
  });
  it('does not replay the required reading into an already active answer timer', async () => {
    const game = harness(questionState(), 'en-US', { manualTimers: true });
    game.setup();
    expect(game.state).toMatchObject({
      phase: 'question', answeringStartsAtMs: 1_000, questionEndsAtMs: 11_000,
    });
    expect(game.questionSpeech()).toHaveLength(0);
    expect(game.calls.promptReady).toEqual([]);
    expect(game.calls.cueReady).toEqual([]);

    game.prompt('answer two');
    expect(game.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 1_000 }]);
    expect(game.state.phase).toBe('reveal');
    await game.session.whenSpeechSettled();
    expect(game.questionSpeech()).toHaveLength(0);
    expect(game.retryTimerCount).toBe(0);
  });

  it('preempts speech exactly once when room state publishes a genuinely new question', () => {
    const game = harness(revealState(), 'en-US', { resumed: true });
    game.setup();
    game.setState({
      phase: 'question_prompt',
      questionIndex: 1,
      questionAttemptId: 2,
      question: { id: 'question-2', prompt: 'Pick another city.', choices },
      reveal: null,
      standings: null,
      myAnswered: false,
      myQuestionPoints: 0,
      answeringStartsAtMs: null,
      questionEndsAtMs: null,
    });

    game.session.onStateChanged();
    game.session.onStateChanged();
    game.prompt('still thinking', false);

    expect(game.calls.preempts).toBe(1);
    expect(game.spoken.filter(item => /Question 2/.test(item.text))).toHaveLength(1);
    expect(game.spoken.filter(item => /choices are One, Rome/.test(item.text))).toHaveLength(0);
  });

  it('keeps a long question and four choices in ordered Relay jobs on opposite sides of clock start', async () => {
    const longPrompt = 'P'.repeat(240);
    const longChoices = choices.map((choice, index) => ({ ...choice, text: String(index + 1).repeat(100) }));
    const game = harness(questionPromptState({
      question: { id: 'question-1', prompt: longPrompt, choices: longChoices },
    }), 'en-US', { deferQuestion: true });
    game.setup();

    expect(game.questionSpeech()).toHaveLength(1);
    expect(game.questionSpeech()[0]!.text).toContain(longPrompt);
    for (const choice of longChoices) expect(game.questionSpeech()[0]!.text).not.toContain(choice.text);
    game.settleQuestion(true);
    await flushMicrotasks();
    game.setState({ displayViewReady: true });
    game.session.onStateChanged();
    await game.session.whenSpeechSettled();
    const choicesSpeech = game.spoken.find(item => item.text.startsWith('The choices are'))?.text ?? '';
    expect(Array.from(choicesSpeech).length).toBeGreaterThan(400);
    for (const choice of longChoices) expect(choicesSpeech).toContain(choice.text);
  });

  it('preserves the earliest matching interim onset and accepts its final during server grace', () => {
    const game = harness(questionState());
    game.setup();
    game.setNow(1_234);
    game.prompt('I think the answer is the city of light', false);
    game.setNow(1_800);
    game.prompt('the city of light', false);
    game.setNow(11_500);
    game.prompt('My final answer is Paris');

    expect(game.calls.answers).toEqual([{
      choiceId: 'paris',
      final: true,
      answeredAtMs: 1_234,
    }]);
    expect(game.spoken.map(item => item.text)).toContain('Answer locked.');
  });

  it('cancels an old semantic answer at the first partial of a spoken correction', async () => {
    let finish!: (result: TriviaIntentResult) => void;
    const pending = new Promise<TriviaIntentResult>(resolve => { finish = resolve; });
    const game = harness(questionState(), 'en-US', { resolveIntent: () => pending });
    game.setup();
    game.setNow(1_200);
    game.prompt('the romantic city on the river');
    game.setNow(1_500);
    game.prompt('actually Rome', false);
    finish({ kind: 'action', actionId: 'answer_choice', targetId: 'paris' });
    await game.session.whenSpeechSettled();
    expect(game.calls.answers).toEqual([]);
    expect(game.calls.resolutionFinishes).toEqual([1]);

    game.setNow(2_000);
    game.prompt('Rome');
    expect(game.calls.answers).toEqual([{ choiceId: 'rome', final: true, answeredAtMs: 1_500 }]);
  });

  it('accepts a delayed semantic result for a final heard inside the answer clock', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (result: TriviaIntentResult) => void;
      const pending = new Promise<TriviaIntentResult>(resolve => { finish = resolve; });
      const game = harness(questionState(), 'en-US', { resolveIntent: () => pending });
      game.setup();
      game.setNow(10_900);
      game.prompt('the city with the big iron tower');
      expect(game.calls.resolutionStarts).toEqual([{
        questionId: 'question-1', attemptId: 1, id: 1,
      }]);

      await vi.advanceTimersByTimeAsync(2_500);
      game.setNow(13_400);
      finish({ kind: 'action', actionId: 'answer_choice', targetId: 'paris' });
      await game.session.whenSpeechSettled();
      expect(game.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 10_900 }]);
      expect(game.calls.resolutionFinishes).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scores a semantic final inside ASR grace from its matching on-time interim onset', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (result: TriviaIntentResult) => void;
      const pending = new Promise<TriviaIntentResult>(resolve => { finish = resolve; });
      const game = harness(questionState(), 'en-US', { resolveIntent: () => pending });
      game.setup();
      game.setNow(10_800);
      game.prompt('Paris', false);
      game.setNow(11_800);
      game.prompt('the city with the big iron tower');
      expect(game.calls.resolutionStarts).toEqual([{
        questionId: 'question-1', attemptId: 1, id: 1,
        onset: { choiceId: 'paris', atMs: 10_800 },
      }]);

      await vi.advanceTimersByTimeAsync(2_500);
      game.setNow(14_300);
      finish({ kind: 'action', actionId: 'answer_choice', targetId: 'paris' });
      await game.session.whenSpeechSettled();
      expect(game.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 10_800 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts an accented or paraphrased answer begun during the clock even without a local choice match', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (result: TriviaIntentResult) => void;
      const pending = new Promise<TriviaIntentResult>(resolve => { finish = resolve; });
      const game = harness(questionState(), 'en-US', { resolveIntent: () => pending });
      game.setup();
      game.setNow(10_800);
      game.prompt('the city with the big iron', false);
      game.setNow(11_400);
      game.prompt('the city with the big iron tower');
      expect(game.calls.resolutionStarts).toEqual([{
        questionId: 'question-1', attemptId: 1, id: 1,
        onset: { atMs: 11_000 },
      }]);

      await vi.advanceTimersByTimeAsync(500);
      game.setNow(11_900);
      finish({ kind: 'action', actionId: 'answer_choice', targetId: 'paris' });
      await game.session.whenSpeechSettled();
      expect(game.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 11_000 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scores a locally resolved final that began as unrecognized speech at the deadline', () => {
    const game = harness(questionState());
    game.setup();
    game.setNow(10_850);
    game.prompt('I think it is', false);
    game.setNow(11_300);
    game.prompt('Paris');
    expect(game.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 11_000 }]);
  });

  it('lets the room extend a still-playing choice cue for a locally understood answer', () => {
    const game = harness(answerCueState({ displayViewReady: false,
      answeringStartsAtMs: 1_000, questionEndsAtMs: 2_000 }), 'en-US',
    { resumed: true, acceptAnswerCue: true });
    game.setup();
    game.setNow(2_100);
    game.prompt('Paris');

    expect(game.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 2_100 }]);
    expect(game.state.phase).toBe('reveal');
    expect(game.spoken.map(item => item.text)).not.toContain('Time is up.');
  });

  it('reserves semantic interpretation during a still-playing cue beyond its initial deadline', async () => {
    const game = harness(answerCueState({ displayViewReady: false,
      answeringStartsAtMs: 1_000, questionEndsAtMs: 2_000 }), 'en-US',
    { resumed: true, acceptAnswerCue: true,
      resolveIntent: async () => ({ kind: 'action', actionId: 'answer_choice', targetId: 'paris' }) });
    game.setup();
    game.setNow(2_100);
    game.prompt('the city with the big iron tower');
    await game.session.whenSpeechSettled();

    expect(game.calls.resolutionStarts).toEqual([{ questionId: 'question-1', attemptId: 1, id: 1 }]);
    expect(game.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 2_100 }]);
    expect(game.state.phase).toBe('reveal');
  });

  it('discards a delayed semantic answer when the question attempt changes', async () => {
    let finish!: (result: TriviaIntentResult) => void;
    const pending = new Promise<TriviaIntentResult>(resolve => { finish = resolve; });
    const game = harness(questionState(), 'en-US', { resolveIntent: () => pending });
    game.setup();
    game.prompt('the city with the big iron tower');
    game.setState({ questionAttemptId: 2, myAnswered: false });
    game.session.onStateChanged();
    finish({ kind: 'action', actionId: 'answer_choice', targetId: 'paris' });
    await game.session.whenSpeechSettled();
    expect(game.calls.answers).toEqual([]);
    expect(game.calls.resolutionFinishes).toEqual([1]);
  });

  it('rejects input before publication and accepts speech and DTMF immediately at publication', () => {
    const speech = harness(questionState({ answeringStartsAtMs: 4_000, questionEndsAtMs: 14_000 }));
    speech.setNow(2_000);
    speech.setup();
    speech.prompt('Paris');
    expect(speech.calls.answers).toEqual([]);
    speech.setNow(4_000);
    speech.prompt('answer two');
    expect(speech.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 4_000 }]);
    expect(speech.spoken.map(item => item.text)).toContain('Answer locked.');
    expect(speech.spoken.map(item => item.text)).not.toContain('Time is up.');

    const dtmf = harness(questionState({ answeringStartsAtMs: 4_000, questionEndsAtMs: 14_000 }));
    dtmf.setNow(2_500);
    dtmf.setup();
    dtmf.dtmf('1');
    expect(dtmf.calls.answers).toEqual([]);
    dtmf.setNow(4_000);
    dtmf.dtmf('1');
    expect(dtmf.calls.answers).toEqual([{ choiceId: 'rome', final: true, answeredAtMs: 4_000 }]);
    expect(dtmf.spoken.map(item => item.text)).toContain('Answer locked.');
    expect(dtmf.spoken.map(item => item.text)).not.toContain('Time is up.');
  });

  it('clears pre-publication and unknown onsets before a valid final', () => {
    const game = harness(questionState({ answeringStartsAtMs: 1_500, questionEndsAtMs: 11_500 }));
    game.setNow(1_000);
    game.setup();
    game.prompt('Paris', false);
    game.setNow(1_500);
    game.prompt('not a displayed answer');
    expect(game.calls.answers).toEqual([]);
    game.setNow(2_000);
    game.prompt('Paris');
    expect(game.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 2_000 }]);
  });

  it('clears onset after an unknown final or candidate change but preserves it across interrupt', () => {
    const unknown = harness(questionState());
    unknown.setup();
    unknown.setNow(1_100);
    unknown.prompt('Paris', false);
    unknown.setNow(2_000);
    unknown.prompt('something unknown');
    unknown.setNow(4_000);
    unknown.prompt('Paris');
    expect(unknown.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 4_000 }]);

    const changed = harness(questionState());
    changed.setup();
    changed.setNow(1_100);
    changed.prompt('Paris', false);
    changed.setNow(2_000);
    changed.prompt('Rome', false);
    changed.setNow(3_000);
    changed.prompt('Paris');
    expect(changed.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 3_000 }]);

    const interrupted = harness(questionState());
    interrupted.setup();
    interrupted.setNow(1_100);
    interrupted.prompt('Paris', false);
    interrupted.interrupt();
    interrupted.setNow(5_000);
    interrupted.prompt('Paris');
    expect(interrupted.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 1_100 }]);
  });

  it('locks a wrong displayed choice and acknowledges it without revealing correctness early', () => {
    const game = harness(questionState());
    game.setup();
    const before = game.spoken.length;
    game.setNow(2_000);
    game.prompt('A');

    expect(game.calls.answers[0]).toMatchObject({ choiceId: 'rome', answeredAtMs: 2_000 });
    expect(game.state.phase).toBe('reveal');
    const answerSpeech = game.spoken.slice(before).map(item => item.text);
    expect(answerSpeech[0]).toBe('Answer locked.');
    expect(answerSpeech[0]).not.toMatch(/correct|incorrect|not correct/i);
    expect(answerSpeech[1]).toBe('Incorrect. The correct answer was option Two, Paris.');
  });

  it('ignores duplicate locks and an interim stream that crosses a question boundary', () => {
    const game = harness(questionState());
    game.setup();
    game.setNow(1_100);
    game.prompt('Paris');
    game.prompt('Paris');
    expect(game.calls.answers).toHaveLength(1);

    game.prompt('Rome', false);
    game.setState({
      phase: 'question',
      questionIndex: 1,
      question: { id: 'question-2', prompt: 'Pick a city.', choices },
      reveal: null,
      myAnswered: false,
      myQuestionPoints: 0,
      answeringStartsAtMs: 20_000,
      questionEndsAtMs: 30_000,
      players: [player({ rawScore: 1_300, correctCount: 1 })],
      standings: null,
    });
    game.setNow(20_100);
    game.session.onStateChanged();
    game.prompt('Rome');
    expect(game.calls.answers).toHaveLength(1);

    game.prompt('Rome');
    expect(game.calls.answers).toHaveLength(2);
    expect(game.calls.answers[1]).toMatchObject({ choiceId: 'rome', answeredAtMs: 20_100 });
  });

  it('accepts category DTMF 1-9 while keeping answer DTMF restricted to 1-4', () => {
    const category = harness(baseState({ phase: 'category_select' }));
    category.setup();
    category.dtmf('9');
    expect(category.calls.votes).toEqual(['mixed']);

    const answer = harness(questionState());
    answer.setup();
    answer.dtmf('5');
    expect(answer.calls.answers).toEqual([]);
    answer.setNow(1_500);
    answer.dtmf('2');
    expect(answer.calls.answers).toEqual([{ choiceId: 'paris', final: true, answeredAtMs: 1_500 }]);
  });

  it('repeats the timed question immediately on an explicit request without invoking a model', () => {
    const game = harness(questionState());
    game.setup();
    const before = game.spoken.length;
    game.prompt('what was the question');
    expect(game.calls.answers).toEqual([]);
    expect(game.spoken.slice(before).map(item => item.text).join(' ')).toMatch(/Question 1.*capital of France.*choices are/i);
  });

  it('matches number forms, natural phrases, answer text, and bounded letter variants', () => {
    const question = questionState().question!;
    for (const [id, forms] of [
      ['rome', ['1', 'one', 'first']],
      ['paris', ['2', 'two', 'second', 'the second choice']],
      ['madrid', ['3', 'three', 'third']],
      ['vienna', ['4', 'four', 'fourth']],
    ] as const) {
      for (const spoken of forms) expect(matchTriviaAnswer(spoken, question), spoken).toBe(id);
    }
    expect(matchTriviaAnswer('answer two', question)).toBe('paris');
    expect(matchTriviaAnswer('option three please', question)).toBe('madrid');
    expect(matchTriviaAnswer('my answer is four', question)).toBe('vienna');
    expect(matchTriviaAnswer('I think it is one', question)).toBe('rome');
    for (const spoken of ['A', 'ay', 'aye', 'alpha', 'letter A', 'letter hey', 'answer eh']) {
      expect(matchTriviaAnswer(spoken, question), spoken).toBe('rome');
    }
    expect(matchTriviaAnswer('hey', question)).toBeNull();
    expect(matchTriviaAnswer('eh', question)).toBeNull();
    for (const spoken of ['B', 'bee', 'bravo', 'option B']) {
      expect(matchTriviaAnswer(spoken, question), spoken).toBe('paris');
    }
    for (const spoken of ['C', 'sea', 'charlie']) {
      expect(matchTriviaAnswer(spoken, question), spoken).toBe('madrid');
    }
    for (const spoken of ['D', 'dee', 'delta', 'option D']) {
      expect(matchTriviaAnswer(spoken, question), spoken).toBe('vienna');
    }
    for (const spoken of ['be', 'see', 'the', 'de']) {
      expect(matchTriviaAnswer(spoken, question), spoken).toBeNull();
    }
    expect(matchTriviaAnswer('answer be', question)).toBe('paris');
    expect(matchTriviaAnswer('letter see', question)).toBe('madrid');
    expect(matchTriviaAnswer('option the', question)).toBe('vienna');
    expect(matchTriviaAnswer('I think the answer is B', question)).toBe('paris');
    expect(matchTriviaAnswer('answer B please', question)).toBe('paris');
    expect(matchTriviaAnswer('I think the answer is the city of light', question)).toBe('paris');
    expect(matchTriviaAnswer('My final answer is Paris', question)).toBe('paris');
    expect(matchTriviaAnswer('I think the answer is the capital of Spain', question)).toBe('madrid');
    expect(matchTriviaAnswer('the answer is Paris', question)).toBe('paris');
    expect(matchTriviaAnswer('I think it is Paris', question)).toBe('paris');
    expect(matchTriviaAnswer('Paris please', question)).toBe('paris');
    expect(matchTriviaAnswer('Paris or Rome', question)).toBeNull();
    expect(matchTriviaAnswer('not Paris', question)).toBeNull();
    expect(matchTriviaAnswer('no Paris', question)).toBeNull();
    expect(matchTriviaAnswer('I do not think Paris', question)).toBeNull();
    expect(matchTriviaAnswer('Paris is the capital of France', question)).toBeNull();
    expect(matchTriviaAnswer('The Vienna convention mentions Vienna', question)).toBeNull();
    expect(matchTriviaAnswer('I think the answer is the best one', question)).toBeNull();
    expect(matchTriviaAnswer('answer five', question)).toBeNull();
    expect(matchTriviaAnswer('0', question)).toBeNull();

    const ptQuestion = { ...question, prompt: 'Qual e a capital da Franca?', choices: portugueseChoices };
    for (const [id, forms] of [
      ['rome', ['1', 'um', 'uma', 'primeiro', 'primeira']],
      ['paris', ['2', 'dois', 'duas', 'segundo', 'segunda', 'a segunda opcao']],
      ['madrid', ['3', 'tres', 'terceiro', 'terceira']],
      ['vienna', ['4', 'quatro', 'quarto', 'quarta']],
    ] as const) {
      for (const spoken of forms) expect(matchTriviaAnswer(spoken, ptQuestion, 'pt-BR'), spoken).toBe(id);
    }
    expect(matchTriviaAnswer('resposta dois', ptQuestion, 'pt-BR')).toBe('paris');
    expect(matchTriviaAnswer('opcao tres por favor', ptQuestion, 'pt-BR')).toBe('madrid');
    expect(matchTriviaAnswer('minha resposta e quatro', ptQuestion, 'pt-BR')).toBe('vienna');
    expect(matchTriviaAnswer('eu acho que e um', ptQuestion, 'pt-BR')).toBe('rome');
    expect(matchTriviaAnswer('a resposta seria b', ptQuestion, 'pt-BR')).toBe('paris');
    expect(matchTriviaAnswer('eu acho que a resposta e b', ptQuestion, 'pt-BR')).toBe('paris');
    expect(matchTriviaAnswer('letra alfa', ptQuestion, 'pt-BR')).toBe('rome');
    expect(matchTriviaAnswer('opcao delta', ptQuestion, 'pt-BR')).toBe('vienna');
    expect(matchTriviaAnswer('eu acho que e a cidade luz', ptQuestion, 'pt-BR')).toBe('paris');
    expect(matchTriviaAnswer('a resposta e Paris', ptQuestion, 'pt-BR')).toBe('paris');
    expect(matchTriviaAnswer('Paris por favor', ptQuestion, 'pt-BR')).toBe('paris');
    expect(matchTriviaAnswer('acho que de paris', ptQuestion, 'pt-BR')).toBeNull();
    expect(matchTriviaAnswer('nao Paris', ptQuestion, 'pt-BR')).toBeNull();
    for (const spoken of ['be', 'ce', 'se', 'de']) {
      expect(matchTriviaAnswer(spoken, ptQuestion, 'pt-BR'), spoken).toBeNull();
    }
    expect(matchTriviaAnswer('resposta be', ptQuestion, 'pt-BR')).toBe('paris');
    expect(matchTriviaAnswer('letra ce', ptQuestion, 'pt-BR')).toBe('madrid');
    expect(matchTriviaAnswer('opcao de', ptQuestion, 'pt-BR')).toBe('vienna');
  });

  it('takes a corrected final choice and refuses a negated answer', () => {
    const question = { id: 'q', prompt: 'Capital?', choices };
    expect(matchTriviaAnswer('I was going to say one, no, actually two', question)).toBe('paris');
    expect(matchTriviaAnswer('not Paris', question)).toBeNull();
    expect(matchTriviaAnswer('Roma, não, Paris', { ...question, choices: portugueseChoices }, 'pt-BR')).toBe('paris');
  });

  it('uses Portuguese question and choice speech from the localized voice snapshot', async () => {
    const game = harness(questionPromptState({
      question: { id: 'question-1', prompt: 'Qual e a capital da Franca?', choices: portugueseChoices },
    }), 'pt-BR', { deferQuestion: true });
    game.setup();
    expect(game.questionSpeech().map(item => item.text).join(' ')).toMatch(/Pergunta 1.*capital da Franca/i);
    expect(game.spoken.map(item => item.text).join(' ')).not.toMatch(/opções são/i);
    game.settleQuestion(true);
    await flushMicrotasks();
    game.setState({ displayViewReady: true });
    game.session.onStateChanged();
    await game.session.whenSpeechSettled();
    expect(game.calls.promptReady).toEqual(['question-1']);
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(
      /opções são Um, Roma; Dois, Paris; Três, Madri; Quatro, Viena/i,
    );
  });

  it.each([
    { locale: 'en-US' as const, spoken: 'Is Paris correct?', question: questionState() },
    { locale: 'pt-BR' as const, spoken: 'Paris está correta?',
      question: questionState({ question: { id: 'question-1', prompt: 'Qual é a capital da França?', choices: portugueseChoices } }) },
  ])('keeps $locale answer questions read-only even if the interpreter proposes Paris', async row => {
    const requests: TriviaIntentRequest[] = [];
    const game = harness(row.question, row.locale, {
      resumed: true,
      resolveIntent: async request => {
        requests.push(request);
        return { kind: 'action', actionId: 'answer_choice', targetId: 'paris' };
      },
    });
    game.setup();
    game.prompt(row.spoken);
    await game.session.whenSpeechSettled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.actions).toEqual([]);
    expect(game.calls.answers).toEqual([]);
    expect(game.calls.resolutionStarts).toEqual([]);
    expect(game.state.myAnswered).toBe(false);
  });

  it('does not skip an in-progress question reading when asked what skipping would do', async () => {
    const requests: TriviaIntentRequest[] = [];
    const game = harness(questionPromptState(), 'en-US', {
      resumed: true, deferQuestion: true,
      resolveIntent: async request => {
        requests.push(request);
        return { kind: 'action', actionId: 'skip_reading' };
      },
    });
    game.setup();
    const preempts = game.calls.preempts;
    game.prompt('What happens if I skip reading?');
    await flushMicrotasks();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.actions).toEqual([]);
    expect(game.state.phase).toBe('question_prompt');
    expect(game.calls.preempts).toBe(preempts);
    game.settleQuestion('interrupted');
    await game.session.whenSpeechSettled();
  });

  it('lets callers interrupt question, reveal, and result audio without an automatic replay', async () => {
    const answer = harness(questionPromptState(), 'en-US', { deferQuestion: true, manualTimers: true });
    answer.setup();
    expect(answer.questionSpeech()).toHaveLength(1);
    answer.interrupt();
    answer.settleQuestion('interrupted');
    await answer.session.whenSpeechSettled();
    answer.session.onStateChanged();
    expect(answer.questionSpeech()).toHaveLength(1);
    expect(answer.retryTimerCount).toBe(0);
    expect(answer.calls.promptReady).toEqual([]);
    answer.prompt('repeat the question please');
    expect(answer.questionSpeech()).toHaveLength(2);
    answer.settleQuestion('played');
    await answer.session.whenSpeechSettled();
    expect(answer.calls.promptReady).toEqual(['question-1']);

    const reveal = harness(revealState(), 'en-US', { deferReveal: true, resumed: true, manualTimers: true });
    reveal.setup();
    expect(reveal.spoken.filter(item => /Correct! Option Two, Paris/i.test(item.text))).toHaveLength(1);
    expect(reveal.calls.revealBegun).toHaveLength(1);
    expect(reveal.calls.revealReady).toHaveLength(0);
    reveal.interrupt();
    expect(reveal.calls.revealReady).toEqual(reveal.calls.revealBegun);
    reveal.settleReveal('interrupted');
    await flushMicrotasks();
    expect(reveal.retryTimerCount).toBe(0);
    await reveal.session.whenSpeechSettled();
    reveal.session.onStateChanged();
    expect(reveal.spoken.filter(item => /Correct! Option Two, Paris/i.test(item.text))).toHaveLength(1);

    const result = harness(resultState([
      resultPlayer('t1', 'Ada', 2_600, 2, 1),
    ]), 'en-US', { deferResult: true, resumed: true, manualTimers: true });
    result.setup();
    expect(result.spoken.filter(item => /Ada wins with a leaderboard score of 2,600/i.test(item.text))).toHaveLength(1);
    result.interrupt();
    result.settleResult('interrupted');
    await flushMicrotasks();
    expect(result.retryTimerCount).toBe(0);
    await result.session.whenSpeechSettled();
    result.session.onStateChanged();
    expect(result.spoken.filter(item => /Ada wins with a leaderboard score of 2,600/i.test(item.text))).toHaveLength(1);
  });

  it('retries a technically failed required reading once, then pauses the unstarted clock', async () => {
    const game = harness(questionPromptState(), 'en-US', {
      alwaysFailQuestion: true,
      manualTimers: true,
    });
    game.setup();
    await eventually(() => game.retryTimerCount === 1);
    expect(game.retryDelays).toEqual([TRIVIA_SPEECH_RETRY_DELAY_MS]);

    game.runNextRetryTimer();
    await eventually(() => game.state.phase === 'audio_problem');
    expect(game.questionSpeech()).toHaveLength(TRIVIA_SPEECH_MAX_ATTEMPTS);
    expect(game.retryTimerCount).toBe(0);
    await game.session.whenSpeechSettled();

    game.session.onStateChanged();
    expect(game.questionSpeech()).toHaveLength(TRIVIA_SPEECH_MAX_ATTEMPTS);
    expect(game.calls.promptReady).toEqual([]);
  });

  it('drops a scheduled required-speech retry after the guarded phase becomes stale', async () => {
    const game = harness(questionPromptState(), 'en-US', {
      deferQuestion: true,
      manualTimers: true,
    });
    game.setup();
    game.settleQuestion('failed');
    await eventually(() => game.retryTimerCount === 1);
    game.setState({ phase: 'reveal', myAnswered: true,
      reveal: { questionId: 'question-1', correctChoiceId: 'paris', explanation: 'Paris.' } });

    game.runNextRetryTimer();
    await game.session.whenSpeechSettled();
    expect(game.questionSpeech()).toHaveLength(1);
    expect(game.calls.promptReady).toEqual([]);
  });
});

describe('TriviaVoiceSession reconnect, reveal, and lifecycle', () => {
  it('acknowledges a reveal only after playback is reported complete', async () => {
    const game = harness(revealState({ myQuestionPoints: 0 }), 'en-US',
      { resumed: true, deferReveal: true });
    game.setup();
    expect(game.calls.revealBegun).toHaveLength(1);
    expect(game.calls.revealReady).toHaveLength(0);
    game.settleReveal('estimated');
    await game.session.whenSpeechSettled();
    expect(game.calls.revealReady).toEqual(game.calls.revealBegun);
  });

  it('retries failed reveal audio beyond the normal two-attempt limit until its phase ends', async () => {
    const game = harness(revealState({ myQuestionPoints: 0 }), 'en-US',
      { resumed: true, deferReveal: true, manualTimers: true });
    game.setup();
    for (let attempt = 0; attempt < TRIVIA_SPEECH_MAX_ATTEMPTS + 1; attempt++) {
      game.settleReveal('failed');
      await eventually(() => game.retryTimerCount === 1);
      expect(game.calls.revealReady).toHaveLength(0);
      game.runNextRetryTimer();
      await eventually(() => game.calls.revealBegun.length === attempt + 2);
    }
    expect(game.calls.revealBegun.length).toBeGreaterThan(TRIVIA_SPEECH_MAX_ATTEMPTS);
    game.settleReveal('played');
    await game.session.whenSpeechSettled();
    expect(game.calls.revealReady).toEqual([game.calls.revealBegun.at(-1)]);
  });

  it('lets an interruption cancel a failed reveal retry and release the caller immediately', async () => {
    const game = harness(revealState({ myQuestionPoints: 0 }), 'en-US',
      { resumed: true, deferReveal: true, manualTimers: true });
    game.setup();
    game.settleReveal('failed');
    await eventually(() => game.retryTimerCount === 1);
    game.interrupt();
    expect(game.retryTimerCount).toBe(0);
    expect(game.calls.revealReady).toEqual(game.calls.revealBegun);
    await game.session.whenSpeechSettled();
    game.session.onStateChanged();
    expect(game.calls.revealBegun).toHaveLength(1);
  });

  it('ignores delayed playback from a replaced reveal transport', async () => {
    const old = harness(revealState({ myQuestionPoints: 0 }), 'en-US',
      { resumed: true, deferReveal: true });
    old.setup();
    old.session.handleReplaced();
    old.settleReveal('played');
    await old.session.whenSpeechSettled();
    expect(old.calls.revealReady).toHaveLength(0);
  });

  it('announces an expired audio pause as a terminal round, only once', async () => {
    const game = harness(baseState({ phase: 'audio_expired', questionAttemptId: 4 }),
      'en-US', { resumed: true });
    game.setup();
    await game.session.whenSpeechSettled();
    game.session.onStateChanged();
    expect(game.spoken.filter(item => /round ended.*audio/i.test(item.text))).toHaveLength(1);
  });

  it('does not replay a settled prompt or cue or relock an answer after reconnect', async () => {
    const settled = questionPromptState({ myPromptReady: true });
    const resumedPrompt = harness(settled, 'en-US', { resumed: true });
    resumedPrompt.setup();
    expect(resumedPrompt.questionSpeech()).toHaveLength(0);
    expect(resumedPrompt.calls.promptReady).toEqual([]);

    const missingCue = harness(answerCueState(), 'en-US', { resumed: true });
    missingCue.setup();
    await missingCue.session.whenSpeechSettled();
    expect(missingCue.spoken.filter(item => item.text.startsWith('The choices are'))).toHaveLength(1);
    expect(missingCue.calls.cueReady).toEqual(['question-1']);

    const settledCue = harness(answerCueState({ myAnswerCueReady: true }), 'en-US', { resumed: true });
    settledCue.setup();
    expect(settledCue.spoken.filter(item => item.text.startsWith('The choices are'))).toHaveLength(0);
    expect(settledCue.calls.cueReady).toEqual([]);

    const resumedActive = harness(questionState(), 'en-US', { resumed: true });
    resumedActive.setNow(5_000);
    resumedActive.setup();
    resumedActive.session.onStateChanged();
    expect(resumedActive.spoken.map(item => item.text)).toContain(
      'You have 6 seconds left. Say the answer in your own words or by number.',
    );
    expect(resumedActive.questionSpeech()).toHaveLength(0);
    expect(resumedActive.spoken.map(item => item.text).join(' ')).not.toMatch(/You are back/i);
    expect(resumedActive.spoken.filter(item => /seconds left/.test(item.text))).toHaveLength(1);
    expect(resumedActive.state).toMatchObject({ answeringStartsAtMs: 1_000, questionEndsAtMs: 11_000 });

    const resumedLock = harness(questionState({ myAnswered: true }), 'en-US', { resumed: true });
    resumedLock.setup();
    expect(resumedLock.spoken.filter(item => item.text === 'Say your answer now.')).toHaveLength(0);
    expect(resumedLock.questionSpeech()).toHaveLength(0);
    resumedLock.prompt('Paris');
    resumedLock.dtmf('2');
    expect(resumedLock.calls.answers).toEqual([]);
  });

  it('announces concise reveal and terminal winner or tie once', async () => {
    const reveal = harness(revealState({ myQuestionPoints: 1_300 }), 'en-US', { resumed: true });
    reveal.setup();
    reveal.session.onStateChanged();
    expect(reveal.spoken.filter(item => /Correct! Option Two, Paris\. You earned 1,300 points/i.test(item.text))).toHaveLength(1);
    expect(reveal.spoken.map(item => item.text).join(' ')).not.toMatch(/standings:/i);

    const tieBrokenResult = resultState([
      resultPlayer('t1', 'Ada', 2_600, 2, 1),
      resultPlayer('t2', 'Grace', 2_600, 2, 2),
    ]);
    const result = harness(tieBrokenResult, 'en-US', { resumed: true });
    result.setup();
    result.session.onStateChanged();
    await result.session.whenSpeechSettled();
    expect(result.spoken.filter(item => /Ada wins with a leaderboard score of 2,600/i.test(item.text))).toHaveLength(1);
    expect(result.spoken.map(item => item.text).join(' ')).not.toMatch(/tie between/i);
    expect(result.spoken.map(item => item.text).join(' ')).toMatch(
      /Ada, your leaderboard score is 2,600.*2 of eight/i,
    );

    const trueTie = harness(resultState([
      resultPlayer('t1', 'Ada', 2_600, 2, 1),
      resultPlayer('t2', 'Grace', 2_600, 2, 1),
    ]), 'en-US', { resumed: true });
    trueTie.setup();
    await trueTie.session.whenSpeechSettled();
    expect(trueTie.spoken.filter(item => /tie between Ada and Grace/i.test(item.text))).toHaveLength(1);

    const winner = harness(resultState([
      resultPlayer('t1', 'Ada', 2_600, 2, 1),
      resultPlayer('t2', 'Grace', 1_200, 1, 2),
    ]), 'en-US', { resumed: true });
    winner.setup();
    await winner.session.whenSpeechSettled();
    expect(winner.spoken.map(item => item.text).join(' ')).toMatch(
      /Ada wins with a leaderboard score of 2,600/i,
    );
  });

  it.each([
    { locale: 'en-US' as const, name: 'Ada', result: /Ada wins\. 2,600 points; 2 correct/i,
      technology: /Twilio Conversation Relay.*transcribed phone answers.*scored.*screen.*spoke results/i,
      guidance: /Check messages for coins to replay/i },
    { locale: 'pt-BR' as const, name: 'Ana', result: /Ana venceu\. 2\.600 pontos; 2 acertos/i,
      technology: /Twilio Conversation Relay.*transcreve.*pontua.*tela.*narra/i,
      guidance: /Veja o SMS.*moedas.*jogar de novo/i },
  ])('queues a compact $locale station result before slow Relay playback settles', async row => {
    const game = harness(resultState([
      resultPlayer('t1', row.name, 2_600, 2, 1),
    ]), row.locale, { resumed: true, deferResult: true, manualTimers: true });
    game.session.setStationManaged(true);
    game.setup();
    const resultLines = game.spoken.filter(line => row.guidance.test(line.text));
    expect(resultLines).toHaveLength(1);
    expect(resultLines[0]?.text).toMatch(row.result);
    expect(resultLines[0]?.text).toMatch(row.technology);
    expect(resultLines[0]?.text.indexOf('Twilio Conversation Relay')).toBeGreaterThan(0);
    expect(resultLines[0]?.text.trim().split(/\s+/).length).toBeLessThanOrEqual(32);

    let settled = false;
    const waiting = game.session.whenSpeechSettled().then(() => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(false);
    game.settleResult('played');
    await waiting;
    expect(settled).toBe(true);
    expect(game.retryTimerCount).toBe(0);
  });

  it.each([
    { locale: 'en-US' as const, outcome: /Ada wins.*2,600/i,
      technology: /Twilio Conversation Relay.*transcribed phone answers.*scored.*screen.*spoke results/i,
      replay: /To play again, say Play again/i },
    { locale: 'pt-BR' as const, outcome: /Ada venceu.*2\.600/i,
      technology: /Twilio Conversation Relay.*transcreve.*pontua.*tela.*narra/i,
      replay: /Para jogar novamente, diga Jogar novamente/i },
  ])('explains $locale Trivia voice technology after the standalone result and before replay guidance', async row => {
    const game = harness(resultState([resultPlayer('t1', 'Ada', 2_600, 2, 1)]),
      row.locale, { resumed: true });
    game.setup();
    await game.session.whenSpeechSettled();
    const lines = game.spoken.map(item => item.text);
    const outcomeIndex = lines.findIndex(line => row.outcome.test(line));
    const technologyIndex = lines.findIndex(line => row.technology.test(line));
    const replayIndex = lines.findIndex(line => row.replay.test(line));
    expect(outcomeIndex).toBeGreaterThanOrEqual(0);
    expect(technologyIndex).toBeGreaterThan(outcomeIndex);
    expect(replayIndex).toBeGreaterThan(technologyIndex);
  });

  it('tells a caller who answered incorrectly what the full correct answer was', async () => {
    const game = harness(revealState({ myQuestionPoints: 0 }), 'en-US', { resumed: true });
    game.setup();
    await game.session.whenSpeechSettled();
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(/Incorrect.*option two.*Paris/i);
    expect(game.spoken.map(item => item.text).join(' ')).not.toMatch(/Correct choice:/i);
  });

  it('reads the localized correct answer after a wrong Portuguese reply', async () => {
    const game = harness(revealState({ myQuestionPoints: 0,
      question: { id: 'question-1', prompt: 'Qual é a capital da França?', choices: portugueseChoices },
    }), 'pt-BR', { resumed: true });
    game.setup();
    await game.session.whenSpeechSettled();
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(/Incorreto.*opção dois.*Paris/i);
  });

  it('distinguishes a timed-out trivia answer from a wrong submitted answer', async () => {
    const game = harness(revealState({ myQuestionPoints: 0, myAnswered: false }), 'en-US', { resumed: true });
    game.setup();
    await game.session.whenSpeechSettled();
    expect(game.spoken.map(item => item.text).join(' ')).toMatch(/time.*up.*option two.*Paris/i);
    expect(game.spoken.map(item => item.text).join(' ')).not.toMatch(/Incorrect/i);
  });

  it('narrates every final score from the normalized display result', async () => {
    const normalizedScore = normalizeTriviaScore(7_100);
    expect(normalizedScore).toBe(55_039);
    const game = harness(resultState([
      resultPlayer('t1', 'Ada', 7_100, 5, 1, normalizedScore),
    ]), 'en-US', { resumed: true });
    game.setup();
    await game.session.whenSpeechSettled();

    const finalSpeech = game.spoken.map(item => item.text).join(' ');
    expect(finalSpeech).toMatch(/wins with a leaderboard score of 55,039/i);
    expect(finalSpeech).toMatch(/your leaderboard score is 55,039/i);
    expect(finalSpeech).not.toContain('7,100');

    const tie = harness(resultState([
      resultPlayer('t1', 'Ada', 7_100, 5, 1, normalizedScore),
      resultPlayer('t2', 'Grace', 7_100, 5, 1, normalizedScore),
    ]), 'en-US', { resumed: true });
    tie.setup();
    await tie.session.whenSpeechSettled();
    expect(tie.spoken.map(item => item.text).join(' ')).toMatch(
      /tie between Ada and Grace, each with a leaderboard score of 55,039/i,
    );
    expect(tie.spoken.map(item => item.text).join(' ')).not.toContain('7,100');
  });

  it('invalidates pending playback on close, sends nothing afterward, and settles cleanly', async () => {
    const game = harness(questionPromptState(), 'en-US', { deferQuestion: true, resumed: true });
    game.setup();
    expect(game.questionSpeech()).toHaveLength(1);
    const speechCount = game.spoken.length;

    game.session.handleClose();
    game.settleQuestion(true);
    await game.session.whenSpeechSettled();
    game.session.onStateChanged();
    game.prompt('Paris');

    expect(game.calls.promptReady).toEqual([]);
    expect(game.calls.leaves).toBe(1);
    expect(game.spoken).toHaveLength(speechCount);
  });

  it('lets a replacement transport retain the slot without scheduling a leave', () => {
    const game = harness(questionState(), 'en-US', { resumed: true });
    game.setup();
    game.session.handleReplaced();
    expect(game.calls.leaves).toBe(0);
    expect(game.session.boundPlayerId).toBeNull();
  });
});

interface HarnessOptions {
  deferQuestion?: boolean;
  deferCue?: boolean;
  deferReveal?: boolean;
  deferResult?: boolean;
  alwaysFailQuestion?: boolean;
  manualTimers?: boolean;
  resumed?: boolean;
  resolveIntent?: (request: TriviaIntentRequest) => Promise<TriviaIntentResult>;
  retryOutcome?: 'limit' | 'unavailable';
  acceptAnswerCue?: boolean;
}

function harness(initial: TriviaVoiceSnapshot, locale: SupportedLocale = 'en-US', options: HarnessOptions = {}) {
  let state = initial;
  let now = state.answeringStartsAtMs ?? 0;
  let categoryVote: string | null = null;
  let deliveryGeneration = 0;
  let questionResolvers: Array<(outcome: TriviaSpeechOutcome) => void> = [];
  let cueResolver: ((outcome: TriviaSpeechOutcome) => void) | null = null;
  let revealResolvers: Array<(outcome: TriviaSpeechOutcome) => void> = [];
  let resultResolvers: Array<(outcome: TriviaSpeechOutcome) => void> = [];
  const retryTimers: Array<{ callback: () => void; delayMs: number }> = [];
  const retryDelays: number[] = [];
  const spoken: { text: string; isCurrent?: () => boolean }[] = [];
  const calls = {
    bindExpectedPlayers: [] as number[],
    bindParticipantIndexes: [] as Array<number | undefined>,
    setName: [] as string[],
    votes: [] as string[],
    advances: 0,
    promptReady: [] as string[],
    cueReady: [] as string[],
    revealBegun: [] as { questionId: string; attemptId: number; generation: number }[],
    revealReady: [] as { questionId: string; attemptId: number; generation: number }[],
    answers: [] as { choiceId: string; final: true; answeredAtMs: number }[],
    retries: [] as { questionId: string; attemptId: number }[],
    resolutionStarts: [] as { questionId: string; attemptId: number; id: number;
      onset?: { choiceId?: string; atMs: number } }[],
    resolutionFinishes: [] as number[],
    leaves: 0,
    preempts: 0,
  };

  const setState = (patch: Partial<TriviaVoiceSnapshot>) => { state = { ...state, ...patch }; };
  const updateMe = (patch: Partial<TriviaVoiceSnapshot['players'][number]>) => {
    const players = state.players.map(candidate => candidate.playerId === 't1' ? { ...candidate, ...patch } : candidate);
    const me = players.find(candidate => candidate.playerId === 't1')!;
    setState({ players, myName: me.name, nameConfirmed: me.nameConfirmed });
  };

  const timerDeps = options.manualTimers ? {
    setTimer: (callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs };
      retryTimers.push(timer);
      retryDelays.push(delayMs);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      const index = retryTimers.indexOf(timer as unknown as { callback: () => void; delayMs: number });
      if (index >= 0) retryTimers.splice(index, 1);
    },
  } : {};

  const session = new TriviaVoiceSession({
    bind: (_code, _name, _callSid, _locale, _nameConfirmed, expectedPlayers, participantIndex) => {
      calls.bindExpectedPlayers.push(expectedPlayers);
      calls.bindParticipantIndexes.push(participantIndex);
      return { playerId: 't1', resumed: options.resumed === true };
    },
    leave: () => { calls.leaves += 1; },
    setName: (_code, _playerId, name) => {
      calls.setName.push(name);
      updateMe({ name, nameConfirmed: true });
      return true;
    },
    voteCategory: (_code, _playerId, category) => {
      calls.votes.push(category);
      const counts = { ...state.categoryVoteCounts };
      if (categoryVote) counts[categoryVote as keyof TriviaCategoryVoteCounts] -= 1;
      counts[category] += 1;
      categoryVote = category;
      setState({ categoryVoteCounts: counts, myCategoryVote: category });
      return state.phase === 'category_select';
    },
    advance: () => {
      calls.advances += 1;
      if (state.phase === 'lobby' && state.hasExpectedPlayers
        && state.players.every(candidate => candidate.nameConfirmed)) {
        setState({ phase: 'category_select' });
        return true;
      }
      const voteCount = TRIVIA_ROUND_CATEGORY_IDS.reduce(
        (total, category) => total + state.categoryVoteCounts[category], 0,
      );
      if (state.phase === 'category_select' && voteCount >= state.expectedPlayerCount) {
        setState({ phase: 'loading', loadingGeneration: state.loadingGeneration + 1 });
        return true;
      }
      if (state.phase === 'results' && !state.automaticSetup) {
        setState({ phase: 'category_select', result: null });
        return true;
      }
      return false;
    },
    questionPromptReady: (_code, _playerId, questionId) => {
      calls.promptReady.push(questionId);
      if (state.phase !== 'question_prompt' || state.question?.id !== questionId) return false;
      setState({
        phase: 'answer_cue',
        myPromptReady: true,
        myAnswerCueReady: false,
        displayViewReady: false,
        answeringStartsAtMs: null,
        questionEndsAtMs: null,
      });
      return true;
    },
    beginPromptDelivery: () => ++deliveryGeneration,
    questionPromptSkipped: (_code, _playerId, questionId) => {
      if (state.phase !== 'question_prompt' || state.question?.id !== questionId) return false;
      setState({ phase: 'answer_cue', myPromptReady: true, displayViewReady: false });
      return true;
    },
    beginAnswerCueDelivery: () => ++deliveryGeneration,
    questionAnswerCueReady: (_code, _playerId, questionId) => {
      calls.cueReady.push(questionId);
      if (state.phase !== 'answer_cue' || state.question?.id !== questionId) return false;
      setState({
        phase: 'question',
        myAnswerCueReady: true,
        displayViewReady: false,
        answeringStartsAtMs: now,
        questionEndsAtMs: now + 10_000,
      });
      return true;
    },
    questionAnswerCueSkipped: (_code, _playerId, questionId) => {
      if (state.phase !== 'answer_cue' || state.question?.id !== questionId) return false;
      setState({ phase: 'question', myAnswerCueReady: true, displayViewReady: false,
        answeringStartsAtMs: now, questionEndsAtMs: now + 10_000 });
      return true;
    },
    beginRevealDelivery: (_code, _playerId, questionId, attemptId) => {
      if (state.phase !== 'reveal' || state.question?.id !== questionId
        || state.questionAttemptId !== attemptId) return null;
      const generation = ++deliveryGeneration;
      calls.revealBegun.push({ questionId, attemptId, generation });
      return generation;
    },
    questionRevealReady: (_code, _playerId, questionId, attemptId, generation) => {
      if (state.phase !== 'reveal' || state.question?.id !== questionId
        || state.questionAttemptId !== attemptId) return false;
      calls.revealReady.push({ questionId, attemptId, generation });
      return true;
    },
    queueEarlyAnswer: (_code, _playerId, questionId, _attemptId, choiceId) => {
      if ((state.phase !== 'question_prompt' && state.phase !== 'answer_cue')
        || state.question?.id !== questionId) return false;
      calls.answers.push({ choiceId, final: true, answeredAtMs: now });
      setState({ phase: 'question', myAnswered: true, myPromptReady: true, myAnswerCueReady: true,
        answeringStartsAtMs: now, questionEndsAtMs: now + 10_000 });
      return true;
    },
    pauseAudio: () => {
      setState({ phase: 'audio_problem' });
      return true;
    },
    retryQuestion: (_code, _playerId, questionId, attemptId) => {
      calls.retries.push({ questionId, attemptId });
      if (options.retryOutcome) return options.retryOutcome;
      if (state.phase !== 'audio_problem' || state.question?.id !== questionId
        || state.questionAttemptId !== attemptId) return 'unavailable';
      setState({ phase: 'question_prompt', questionAttemptId: attemptId + 1,
        myPromptReady: false, myAnswerCueReady: false, displayViewReady: false,
        answeringStartsAtMs: null, questionEndsAtMs: null,
        audioRetryRemaining: Math.max(0, state.audioRetryRemaining - 1) });
      return 'retried';
    },
    beginAnswerResolution: (_code, _playerId, questionId, attemptId, onset) => {
      const id = calls.resolutionStarts.length + 1;
      calls.resolutionStarts.push({ questionId, attemptId, id, ...(onset ? { onset } : {}) });
      return id;
    },
    finishAnswerResolution: (_code, _playerId, _questionId, _attemptId, id) => {
      calls.resolutionFinishes.push(id);
      return true;
    },
    answerAt: (_code, _playerId, choiceId, final, answeredAtMs) => {
      calls.answers.push({ choiceId, final, answeredAtMs });
      if (state.phase !== 'question' && !(options.acceptAnswerCue && state.phase === 'answer_cue')
        || state.myAnswered) return false;
      if (state.phase === 'answer_cue' && state.questionEndsAtMs !== null
        && answeredAtMs > state.questionEndsAtMs) setState({ questionEndsAtMs: answeredAtMs + 8_000 });
      const points = choiceId === 'paris' ? 1_300 : 0;
      const current = state.players.find(candidate => candidate.playerId === 't1')!;
      updateMe({
        rawScore: current.rawScore + points,
        correctCount: current.correctCount + (points > 0 ? 1 : 0),
      });
      const standings = standingsFor(state.players);
      setState({
        phase: 'reveal',
        myAnswered: true,
        myQuestionPoints: points,
        reveal: { questionId: state.question!.id, correctChoiceId: 'paris', explanation: 'Paris is the capital.' },
        standings,
      });
      return true;
    },
    snapshot: () => state,
    resolveIntent: options.resolveIntent,
    say: (text, isCurrent) => {
      spoken.push({ text, ...(isCurrent ? { isCurrent } : {}) });
      if (options.deferCue && /^(?:The choices are|As opções são)/i.test(text)) {
        return new Promise<TriviaSpeechOutcome>(resolve => { cueResolver = resolve; });
      }
      if (options.deferQuestion && isQuestionAudio(text)) {
        return new Promise<TriviaSpeechOutcome>(resolve => { questionResolvers.push(resolve); });
      }
      if (options.alwaysFailQuestion && isQuestionAudio(text)) {
        return Promise.resolve('failed' as const);
      }
      if (options.deferReveal && /^(?:Correct!|Incorrect\.|Time's up\.|Correto!|Incorreto\.|Tempo esgotado\.)/i.test(text)) {
        return new Promise<TriviaSpeechOutcome>(resolve => { revealResolvers.push(resolve); });
      }
      if (options.deferResult && /wins with a leaderboard score|tie between|wins\. [\d,.]+ points|venceu\. [\d,.]+ pontos/i.test(text)) {
        return new Promise<TriviaSpeechOutcome>(resolve => { resultResolvers.push(resolve); });
      }
      return Promise.resolve('played' as const);
    },
    preemptSpeech: () => { calls.preempts += 1; },
    now: () => now,
    ...timerDeps,
  });

  return {
    session,
    spoken,
    calls,
    retryDelays,
    get retryTimerCount() { return retryTimers.length; },
    get state() { return state; },
    setState,
    setNow(value: number) { now = value; },
    setup(callSid = 'CA-TRIVIA') {
      session.handleMessage(JSON.stringify({
        type: 'setup',
        callSid,
        customParameters: { roomCode: ' voice ', commandLocale: locale },
      }));
    },
    prompt(voicePrompt: string, last = true) {
      session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt, last }));
    },
    dtmf(digit: string) { session.handleMessage(JSON.stringify({ type: 'dtmf', digit })); },
    interrupt() { session.handleMessage(JSON.stringify({ type: 'interrupt' })); },
    settleQuestion(outcome: boolean | TriviaSpeechOutcome) {
      if (!questionResolvers.length) throw new Error('question playback is not pending');
      const resolvers = questionResolvers;
      questionResolvers = [];
      resolvers.forEach(resolve => resolve(speechOutcome(outcome)));
    },
    settleQuestionChunk(index: number, outcome: boolean | TriviaSpeechOutcome) {
      const resolve = questionResolvers[index];
      if (!resolve) throw new Error('question playback chunk is not pending');
      questionResolvers[index] = (() => {}) as (outcome: TriviaSpeechOutcome) => void;
      resolve(speechOutcome(outcome));
    },
    settleCue(outcome: boolean | TriviaSpeechOutcome) {
      if (!cueResolver) throw new Error('answer cue playback is not pending');
      const resolve = cueResolver;
      cueResolver = null;
      resolve(speechOutcome(outcome));
    },
    settleReveal(outcome: boolean | TriviaSpeechOutcome) {
      settleResolvers(revealResolvers, outcome, 'reveal');
      revealResolvers = [];
    },
    settleResult(outcome: boolean | TriviaSpeechOutcome) {
      settleResolvers(resultResolvers, outcome, 'result');
      resultResolvers = [];
    },
    runNextRetryTimer() {
      const timer = retryTimers.shift();
      if (!timer) throw new Error('required speech retry is not scheduled');
      timer.callback();
    },
    questionSpeech() {
      return spoken.filter(item => isQuestionAudio(item.text));
    },
  };
}

function baseState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  return {
    phase: 'lobby',
    myName: 'Ada',
    nameConfirmed: true,
    expectedPlayerCount: 1,
    hasExpectedPlayers: true,
    automaticSetup: false,
    players: [player()],
    categoryVoteCounts: emptyVotes(),
    myCategoryVote: null,
    loadingGeneration: 0,
    questionIndex: null,
    questionAttemptId: null,
    answeringStartsAtMs: null,
    questionEndsAtMs: null,
    question: null,
    reveal: null,
    standings: null,
    result: null,
    myAnswered: false,
    myPromptReady: false,
    myAnswerCueReady: false,
    displayViewReady: true,
    myQuestionPoints: 0,
    audioRetryRemaining: 2,
    ...overrides,
  };
}

function questionPromptState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  return baseState({
    phase: 'question_prompt',
    loadingGeneration: 1,
    questionIndex: 0,
    questionAttemptId: 1,
    question: { id: 'question-1', prompt: 'What is the capital of France?', choices },
    ...overrides,
  });
}

function questionState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  return questionPromptState({
    phase: 'question',
    answeringStartsAtMs: 1_000,
    questionEndsAtMs: 11_000,
    ...overrides,
  });
}

function answerCueState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  return questionPromptState({
    phase: 'answer_cue',
    myPromptReady: true,
    ...overrides,
  });
}

function audioProblemState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  return questionPromptState({
    phase: 'audio_problem', myPromptReady: false, myAnswerCueReady: false,
    displayViewReady: false, audioRetryRemaining: 2,
    ...overrides,
  });
}

function revealState(overrides: Partial<TriviaVoiceSnapshot> = {}): TriviaVoiceSnapshot {
  const players = [player({ rawScore: 1_300, correctCount: 1 })];
  return questionState({
    phase: 'reveal',
    players,
    myAnswered: true,
    myQuestionPoints: 1_300,
    reveal: { questionId: 'question-1', correctChoiceId: 'paris', explanation: 'Paris is the capital.' },
    standings: standingsFor(players),
    ...overrides,
  });
}

function resultState(players: TriviaResult['players']): TriviaVoiceSnapshot {
  const result: TriviaResult = {
    resultId: `result-${players.map(candidate => candidate.rawScore).join('-')}`,
    generation: 1,
    category: 'mixed',
    contentRevision: 'test',
    players,
    completedAtMs: 50_000,
  };
  const publicPlayers = players.map(candidate => player({
    playerId: candidate.playerId,
    name: candidate.name,
    rawScore: candidate.rawScore,
    correctCount: candidate.correctCount,
  }));
  return baseState({
    phase: 'results',
    players: publicPlayers,
    myName: players[0]?.name ?? null,
    result,
    standings: standingsFor(publicPlayers),
  });
}

function player(overrides: Partial<TriviaVoiceSnapshot['players'][number]> = {}): TriviaVoiceSnapshot['players'][number] {
  return {
    playerId: 't1',
    name: 'Ada',
    nameConfirmed: true,
    connected: true,
    rawScore: 0,
    correctCount: 0,
    ...overrides,
  };
}

function standingsFor(players: readonly TriviaVoiceSnapshot['players'][number][]): TriviaPublicStanding[] {
  return players.map((candidate, index) => ({
    ...candidate,
    playerOrder: index,
    answered: true,
    bestStreak: candidate.correctCount,
    rank: index + 1,
    normalizedScore: candidate.rawScore,
    cumulativeCorrectTimeMs: 0,
  }));
}

function resultPlayer(
  playerId: string,
  name: string,
  rawScore: number,
  correctCount: number,
  rank: number,
  normalizedScore = rawScore,
): TriviaResult['players'][number] {
  return {
    playerId,
    name,
    playerOrder: rank - 1,
    rank,
    rawScore,
    normalizedScore,
    correctCount,
    bestStreak: correctCount,
    cumulativeCorrectTimeMs: 0,
  };
}

function emptyVotes(): TriviaCategoryVoteCounts {
  return Object.fromEntries(TRIVIA_ROUND_CATEGORY_IDS.map(category => [category, 0])) as unknown as TriviaCategoryVoteCounts;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition did not settle');
}

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) await Promise.resolve();
}

function settleResolvers(
  resolvers: Array<(outcome: TriviaSpeechOutcome) => void>,
  outcome: boolean | TriviaSpeechOutcome,
  label: string,
): void {
  if (!resolvers.length) throw new Error(`${label} playback is not pending`);
  for (const resolve of resolvers) resolve(speechOutcome(outcome));
}

function speechOutcome(outcome: boolean | TriviaSpeechOutcome): TriviaSpeechOutcome {
  return outcome === true ? 'played' : outcome === false ? 'failed' : outcome;
}

function isQuestionAudio(text: string): boolean {
  return /^(?:Question \d|Pergunta \d|\d+\.\s)/i.test(text);
}
