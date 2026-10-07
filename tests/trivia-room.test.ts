import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TRIVIA_COUNTDOWN_MS,
  TRIVIA_FINAL_ANSWER_GRACE_MS,
  TRIVIA_MAX_QUESTION_WINDOW_MS,
  TRIVIA_MIN_POST_CUE_ANSWER_MS,
  TRIVIA_SEMANTIC_ANSWER_MAX_MS,
  TRIVIA_REVEAL_MS,
  TRIVIA_REVEAL_MAX_MS,
  TriviaRoom,
} from '../server/trivia-room';
import {
  TRIVIA_ANSWER_WINDOW_MS,
  TRIVIA_CHOICE_IDS,
  TRIVIA_DIFFICULTY_DISTRIBUTION,
  parseTriviaQuestionBankJson,
  type TriviaQuestionBank,
} from '../shared/trivia';

const bank: TriviaQuestionBank = parseTriviaQuestionBankJson(
  readFileSync(new URL('../content/trivia/questions.json', import.meta.url), 'utf8'),
);

function bankWithLongestLegalChoices(): TriviaQuestionBank {
  const longText = (id: string) => {
    const clipped = `${id.toUpperCase()} ${'This answer takes time to read aloud over the phone while the players consider their choice. '.repeat(2)}`.slice(0, 100);
    return clipped.endsWith(' ') ? `${clipped.slice(0, -1)}.` : clipped;
  };
  return parseTriviaQuestionBankJson(JSON.stringify({
    ...bank,
    questions: bank.questions.map(question => ({
      ...question,
      locales: Object.fromEntries(Object.entries(question.locales).map(([locale, localized]) => [
        locale,
        { ...localized, choices: localized.choices.map(choice => ({
          ...choice, text: longText(choice.id),
        })) },
      ])),
    })),
  }));
}

function joined(room: TriviaRoom, name = 'Ada', confirmed = true): string {
  const result = room.addPlayer(name, confirmed);
  if ('error' in result) throw new Error(result.error);
  return result.playerId;
}

function startQuestion(room: TriviaRoom, playerId: string, now: { value: number }): void {
  expect(room.advance(playerId)).toBe(true);
  expect(room.advance(playerId)).toBe(true);
  const generation = room.state().loadingGeneration;
  expect(room.ready(generation)).toBe(true);
  now.value += TRIVIA_COUNTDOWN_MS;
  expect(room.tick()).toBe(true);
  expect(room.phase).toBe('question_prompt');
  settlePrompt(room, now);
}

function settlePrompt(room: TriviaRoom, now?: { value: number }): void {
  if (room.phase === 'question_prompt') {
    const state = room.state();
    for (const player of state.players) {
      const generation = room.beginPromptDelivery(player.playerId, state.question!.id,
        state.questionAttemptId!);
      if (generation !== null) expect(room.questionPromptReady(player.playerId, state.question!.id,
        state.questionAttemptId!, generation)).toBe(true);
    }
  }
  if (room.phase === 'answer_cue') {
    const state = room.state();
    for (const player of state.players) {
      const generation = room.beginAnswerCueDelivery(player.playerId, state.question!.id,
        state.questionAttemptId!);
      if (generation !== null) expect(room.questionAnswerCueReady(player.playerId, state.question!.id,
        state.questionAttemptId!, generation)).toBe(true);
    }
  }
  expect(room.phase).toBe('question');
  if (now) now.value = room.state().answeringStartsAtMs!;
}

function correctChoice(room: TriviaRoom): string {
  const questionId = room.state().question!.id;
  return bank.questions.find(question => question.id === questionId)!.correctChoiceId;
}

function finishRound(room: TriviaRoom, playerId: string, now: { value: number }): void {
  startQuestion(room, playerId, now);
  for (let index = 0; index < 8; index++) {
    room.answer(playerId, correctChoice(room));
    now.value = room.state().revealEndsAtMs!;
    room.tick();
    if (index < 7) settlePrompt(room, now);
  }
}

describe('authoritative trivia room', () => {
  it('starts the shared answer clock before choice audio finishes and scores a spoken choice during it', () => {
    const now = { value: 10_000 };
    const room = new TriviaRoom('CHOICES-CLOCK', { bank, now: () => now.value });
    const first = joined(room, 'Ada');
    const second = joined(room, 'Grace');
    room.advance(first);
    room.advance(first);
    room.ready(room.state().loadingGeneration);
    now.value += TRIVIA_COUNTDOWN_MS;
    room.tick();
    const question = room.state().question!;
    const attempt = room.state().questionAttemptId!;
    for (const player of [first, second]) {
      const generation = room.beginPromptDelivery(player, question.id, attempt)!;
      expect(room.questionPromptReady(player, question.id, attempt, generation)).toBe(true);
    }

    expect(room.state()).toMatchObject({
      phase: 'answer_cue', answeringStartsAtMs: now.value,
      questionEndsAtMs: now.value + TRIVIA_ANSWER_WINDOW_MS,
    });
    now.value += 4_000;
    expect(room.answer(first, correctChoice(room))).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'answer_cue' });
    expect(room.state().players.find(player => player.playerId === first)?.answered).toBe(true);
    const secondCue = room.beginAnswerCueDelivery(second, question.id, attempt)!;
    expect(room.questionAnswerCueReady(second, question.id, attempt, secondCue)).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'question', answeringStartsAtMs: 13_000, questionEndsAtMs: 13_000 + TRIVIA_ANSWER_WINDOW_MS,
    });
  });

  it.each(['en-US', 'pt-BR'] as const)('keeps four legal 100-character choices and a post-cue answer window in %s', locale => {
    const longBank = bankWithLongestLegalChoices();
    const now = { value: 0 };
    const room = new TriviaRoom('LONG-CHOICES', {
      bank: longBank, now: () => now.value, preferredLocale: locale,
    });
    const player = joined(room);
    room.advance(player);
    room.advance(player);
    room.ready(room.state().loadingGeneration);
    now.value = TRIVIA_COUNTDOWN_MS;
    room.tick();
    const question = room.state().question!;
    expect(question.choices.map(choice => Array.from(choice.text).length)).toEqual([100, 100, 100, 100]);
    const attempt = room.state().questionAttemptId!;
    const prompt = room.beginPromptDelivery(player, question.id, attempt)!;
    expect(room.questionPromptReady(player, question.id, attempt, prompt)).toBe(true);
    const clockStartedAt = now.value;
    expect(room.state().answeringStartsAtMs).toBe(clockStartedAt);
    expect(room.state().questionEndsAtMs! - clockStartedAt).toBeGreaterThan(50_000);
    const cue = room.beginAnswerCueDelivery(player, question.id, attempt)!;

    now.value += locale === 'pt-BR' ? 55_000 : 50_000;
    expect(room.tick()).toBe(false);
    expect(room.phase).toBe('answer_cue');
    expect(room.questionAnswerCueReady(player, question.id, attempt, cue)).toBe(true);
    expect(room.phase).toBe('question');
    expect(room.state().questionEndsAtMs! - now.value).toBeGreaterThanOrEqual(TRIVIA_MIN_POST_CUE_ANSWER_MS);
    now.value += 5_000;
    expect(room.answer(player, correctChoice(room))).toBe(true);
    expect(room.phase).toBe('reveal');
    expect(room.state().standings?.[0]?.rawScore).toBeGreaterThan(0);
    expect(room.drainEvents().some(event => event.type === 'audio_problem')).toBe(false);
  });

  it('extends a nearly expired clock after late cue playback and still caps retries', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('LATE-CUE', { bank, now: () => now.value });
    const player = joined(room);
    room.advance(player);
    room.advance(player);
    room.ready(room.state().loadingGeneration);
    now.value = TRIVIA_COUNTDOWN_MS;
    room.tick();
    const question = room.state().question!;
    const attempt = room.state().questionAttemptId!;
    const prompt = room.beginPromptDelivery(player, question.id, attempt)!;
    room.questionPromptReady(player, question.id, attempt, prompt);
    const firstEnd = room.state().questionEndsAtMs!;
    const cue = room.beginAnswerCueDelivery(player, question.id, attempt)!;
    now.value = firstEnd + 1_000;
    expect(room.tick()).toBe(false);
    expect(room.phase).toBe('answer_cue');
    expect(room.questionAnswerCueReady(player, question.id, attempt, cue)).toBe(true);
    expect(room.state().questionEndsAtMs).toBeGreaterThanOrEqual(now.value + TRIVIA_MIN_POST_CUE_ANSWER_MS);
    now.value += 6_000;
    expect(room.answer(player, correctChoice(room))).toBe(true);
    expect(room.phase).toBe('reveal');

    const delayed = new TriviaRoom('BOUNDED-CUE', { bank, now: () => now.value });
    const next = joined(delayed);
    delayed.advance(next);
    delayed.advance(next);
    delayed.ready(delayed.state().loadingGeneration);
    now.value += TRIVIA_COUNTDOWN_MS;
    delayed.tick();
    const delayedQuestion = delayed.state().question!;
    const delayedAttempt = delayed.state().questionAttemptId!;
    const delayedPrompt = delayed.beginPromptDelivery(next, delayedQuestion.id, delayedAttempt)!;
    delayed.questionPromptReady(next, delayedQuestion.id, delayedAttempt, delayedPrompt);
    const secondStart = now.value;
    for (const delay of [0, 20_000, 40_000, 60_000, 80_000, 100_000, 120_000]) {
      now.value = secondStart + delay;
      expect(delayed.tick()).toBe(false);
      expect(delayed.beginAnswerCueDelivery(next, delayedQuestion.id, delayedAttempt)).not.toBeNull();
    }
    now.value = secondStart + TRIVIA_MAX_QUESTION_WINDOW_MS - TRIVIA_MIN_POST_CUE_ANSWER_MS + 1_000;
    expect(delayed.tick()).toBe(true);
    expect(delayed.phase).toBe('audio_problem');
  });

  it('reserves an answer heard during a still-playing cue after its first estimated end', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('LATE-SPEECH', { bank, now: () => now.value });
    const player = joined(room);
    room.advance(player);
    room.advance(player);
    room.ready(room.state().loadingGeneration);
    now.value = TRIVIA_COUNTDOWN_MS;
    room.tick();
    const question = room.state().question!;
    const attempt = room.state().questionAttemptId!;
    const prompt = room.beginPromptDelivery(player, question.id, attempt)!;
    room.questionPromptReady(player, question.id, attempt, prompt);
    room.beginAnswerCueDelivery(player, question.id, attempt);
    now.value = room.state().questionEndsAtMs! + 1_000;
    expect(room.tick()).toBe(false);
    const reservation = room.beginSemanticAnswerResolution(player, question.id, attempt);
    expect(reservation).not.toBeNull();
    expect(room.state().questionEndsAtMs).toBeGreaterThanOrEqual(now.value + TRIVIA_MIN_POST_CUE_ANSWER_MS);
    expect(room.answerAt(player, correctChoice(room), true, now.value, reservation!)).toBe(true);
    expect(room.phase).toBe('reveal');
  });

  it('gives the last of two callers a full answer window after their choice cue finishes', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('TWO-CUES', { bank, now: () => now.value });
    const first = joined(room, 'Ada');
    const second = joined(room, 'Grace');
    room.advance(first);
    room.advance(first);
    room.ready(room.state().loadingGeneration);
    now.value = TRIVIA_COUNTDOWN_MS;
    room.tick();
    const question = room.state().question!;
    const attempt = room.state().questionAttemptId!;
    for (const player of [first, second]) {
      const prompt = room.beginPromptDelivery(player, question.id, attempt)!;
      room.questionPromptReady(player, question.id, attempt, prompt);
    }
    const firstEnd = room.state().questionEndsAtMs!;
    const firstCue = room.beginAnswerCueDelivery(first, question.id, attempt)!;
    const secondCue = room.beginAnswerCueDelivery(second, question.id, attempt)!;
    now.value += 2_000;
    expect(room.questionAnswerCueReady(first, question.id, attempt, firstCue)).toBe(true);
    now.value = firstEnd + 1_000;
    expect(room.tick()).toBe(false);
    expect(room.answer(first, correctChoice(room))).toBe(true);
    expect(room.phase).toBe('answer_cue');
    expect(room.questionAnswerCueReady(second, question.id, attempt, secondCue)).toBe(true);
    expect(room.phase).toBe('question');
    expect(room.state().questionEndsAtMs).toBeGreaterThanOrEqual(now.value + TRIVIA_MIN_POST_CUE_ANSWER_MS);
    now.value += TRIVIA_MIN_POST_CUE_ANSWER_MS - 1_000;
    expect(room.answer(second, correctChoice(room))).toBe(true);
    expect(room.phase).toBe('reveal');
  });

  it('holds the next question until two staggered voice reveals finish after the visual minimum', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('REVEAL-VOICES', { bank, now: () => now.value });
    const first = joined(room, 'Ada');
    const second = joined(room, 'Grace');
    startQuestion(room, first, now);
    const question = room.state().question!;
    const attemptId = room.state().questionAttemptId!;
    expect(room.answer(first, correctChoice(room))).toBe(true);
    expect(room.answer(second, correctChoice(room))).toBe(true);
    const firstDelivery = room.beginRevealDelivery(first, question.id, attemptId)!;
    const secondDelivery = room.beginRevealDelivery(second, question.id, attemptId)!;
    expect(firstDelivery).not.toBe(secondDelivery);

    now.value = room.state().revealEndsAtMs! - 1;
    expect(room.questionRevealReady(first, question.id, attemptId, firstDelivery)).toBe(true);
    expect(room.tick()).toBe(false);
    now.value += 1;
    expect(room.tick()).toBe(false);
    expect(room.phase).toBe('reveal');
    now.value += 5_000;
    expect(room.questionRevealReady(second, question.id, attemptId, secondDelivery)).toBe(true);
    expect(room.tick()).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'question_prompt', questionIndex: 1 });
  });

  it('releases disconnected callers but rejects stale generations and old-question callbacks', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('REVEAL-STALE', { bank, now: () => now.value });
    const first = joined(room, 'Ada');
    const second = joined(room, 'Grace');
    startQuestion(room, first, now);
    const question = room.state().question!;
    const attemptId = room.state().questionAttemptId!;
    room.answer(first, correctChoice(room));
    room.answer(second, correctChoice(room));
    const staleGeneration = room.beginRevealDelivery(first, question.id, attemptId)!;
    const currentGeneration = room.beginRevealDelivery(first, question.id, attemptId)!;
    const disconnectedGeneration = room.beginRevealDelivery(second, question.id, attemptId)!;
    expect(room.questionRevealReady(first, question.id, attemptId, staleGeneration)).toBe(false);
    expect(room.setPlayerConnected(second, false)).toBe(true);
    now.value = room.state().revealEndsAtMs!;
    expect(room.tick()).toBe(false);
    expect(room.questionRevealReady(first, question.id, attemptId, currentGeneration)).toBe(true);
    expect(room.questionRevealReady(second, question.id, attemptId, disconnectedGeneration)).toBe(false);
    expect(room.tick()).toBe(true);
    expect(room.phase).toBe('question_prompt');
    expect(room.questionRevealReady(first, question.id, attemptId, currentGeneration)).toBe(false);
  });

  it('unblocks a failed or lost voice reveal at the hard deadline without delaying touch-only rounds', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('REVEAL-DEADLINE', { bank, now: () => now.value });
    const player = joined(room);
    startQuestion(room, player, now);
    const question = room.state().question!;
    const attemptId = room.state().questionAttemptId!;
    room.answer(player, correctChoice(room));
    const generation = room.beginRevealDelivery(player, question.id, attemptId)!;
    const revealedAt = room.state().revealEndsAtMs! - TRIVIA_REVEAL_MS;
    now.value = room.state().revealEndsAtMs!;
    expect(room.tick()).toBe(false);
    now.value = revealedAt + TRIVIA_REVEAL_MAX_MS - 1;
    expect(room.tick()).toBe(false);
    now.value += 1;
    expect(room.tick()).toBe(true);
    expect(room.phase).toBe('question_prompt');
    expect(room.questionRevealReady(player, question.id, attemptId, generation)).toBe(false);

    settlePrompt(room, now);
    room.answer(player, correctChoice(room));
    now.value = room.state().revealEndsAtMs!;
    expect(room.tick()).toBe(true);
    expect(room.phase).toBe('question_prompt');
  });
  it('enforces 1-4 confirmed players and freezes a four-player standalone roster', () => {
    const room = new TriviaRoom('FOUR', { bank, seed: 1 });
    const players = [
      joined(room, 'One', false), joined(room, 'Two'), joined(room, 'Three'), joined(room, 'Four'),
    ];
    expect(room.expectedPlayerCount).toBe(4);
    expect(room.addPlayer('Five')).toEqual({ error: 'room_full' });
    expect(room.advance()).toBe(false);
    expect(room.setName(players[0]!, 'Ada')).toBe(true);
    expect(room.advance()).toBe(true);
    expect(room.phase).toBe('category_select');
    expect(room.addPlayer('Replacement')).toEqual({ error: 'round_in_progress' });
    expect(room.state().players).toHaveLength(4);
    expect(room.state().players.every(player => player.nameConfirmed)).toBe(true);
  });

  it('keeps station expected-player setup fixed and requires its caller to advance', () => {
    const room = new TriviaRoom('STATION', { bank });
    expect(room.expectHumanPlayers(2, true, { stationFixed: true, allowReplay: false })).toBe(true);
    const first = joined(room, 'One');
    expect(room.advance(first)).toBe(false);
    const second = joined(room, 'Two');
    expect(room.advance()).toBe(false);
    expect(room.advance(second)).toBe(true);
    expect(room.state()).toMatchObject({ automaticSetup: true, expectedPlayerCount: 2, hasExpectedPlayers: true });
    expect(room.stationFixed).toBe(true);
    expect(room.allowReplay).toBe(false);
  });

  it('focuses shared category taps in assigned seat order even when calls arrive backward', () => {
    const room = new TriviaRoom('REVERSE-VOTES', { bank });
    room.expectHumanPlayers(3, true, { stationFixed: true, allowReplay: false });
    const seats = [2, 1, 0].map(index => {
      const result = room.addPlayer(`Player ${index}`, true, index);
      if ('error' in result) throw new Error(result.error);
      return { index, playerId: result.playerId };
    });
    expect(room.advance(seats[0]!.playerId)).toBe(true);
    const bySeat = (index: number) => seats.find(seat => seat.index === index)!.playerId;
    expect(room.state().categoryVotingSeat?.playerId).toBe(bySeat(0));
    expect(room.voteCategoryFromDisplay(bySeat(2), 'science')).toBe(false);
    expect(room.voteCategoryFromDisplay(bySeat(0), 'history')).toBe(true);
    expect(room.state().categoryVotingSeat?.playerId).toBe(bySeat(1));
    expect(room.voteCategory(bySeat(1), 'geography')).toBe(true);
    expect(room.state().categoryVotingSeat?.playerId).toBe(bySeat(2));
    expect(room.voteCategoryFromDisplay(bySeat(2), 'sports')).toBe(true);
    expect(room.state().categoryVotingSeat).toBeNull();
    expect(room.voteCategoryFromDisplay(bySeat(0), 'science')).toBe(false);
  });

  it.each(['lobby', 'category_select', 'loading'] as const)(
    'reconciles a station no-show from %s and admits a replacement into the vacated slot',
    phase => {
      const room = new TriviaRoom(`RECONCILE-${phase}`, { bank });
      room.expectHumanPlayers(2, true, { stationFixed: true, allowReplay: false });
      const first = room.addPlayer('Ada', true, 0);
      const dropped = room.addPlayer('Grace', true, 1);
      if ('error' in first || 'error' in dropped) throw new Error('station join failed');
      if (phase !== 'lobby') {
        room.advance(first.playerId);
        room.voteCategory(first.playerId, 'science');
        room.voteCategory(dropped.playerId, 'history');
      }
      if (phase === 'loading') room.advance(first.playerId);
      const staleGeneration = room.state().loadingGeneration;

      expect(room.reconcilePregameRoster(2, [first.playerId], [first.playerId, null])).toBe(true);
      expect(room.state()).toMatchObject({
        phase: 'lobby', expectedPlayerCount: 2, displayReady: false,
        players: [{ playerId: first.playerId, name: 'Ada', playerOrder: 0 }],
        categoryVoteCounts: { science: 0, history: 0 },
      });
      if (phase === 'loading') expect(room.ready(staleGeneration)).toBe(false);

      const replacement = room.addPlayer('Linus', true, 1);
      expect(replacement).not.toHaveProperty('error');
      expect(room.state().players.map(player => [player.name, player.playerOrder])).toEqual([
        ['Ada', 0], ['Linus', 1],
      ]);
      expect(room.advance(first.playerId)).toBe(true);
    },
  );

  it('reduces the expected station roster without a replacement and clears abandoned setup votes', () => {
    const room = new TriviaRoom('RECONCILE-REDUCE', { bank });
    room.expectHumanPlayers(2, true, { stationFixed: true, allowReplay: false });
    const first = room.addPlayer('Ada', true, 0);
    const dropped = room.addPlayer('Grace', true, 1);
    if ('error' in first || 'error' in dropped) throw new Error('station join failed');
    room.advance(first.playerId);
    room.voteCategory(first.playerId, 'science');
    room.voteCategory(dropped.playerId, 'history');

    expect(room.reconcilePregameRoster(1, [first.playerId], [first.playerId])).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'lobby', expectedPlayerCount: 1, hasExpectedPlayers: true,
      categoryVoteCounts: { science: 0, history: 0 },
      players: [{ playerId: first.playerId, name: 'Ada' }],
    });
    expect(room.advance(first.playerId)).toBe(true);
  });

  it('preserves a station expected roster when pregame expiry happens before reconciliation', () => {
    const room = new TriviaRoom('EXPIRE-BEFORE-RECONCILE', { bank });
    room.expectHumanPlayers(2, true, { stationFixed: true, allowReplay: false });
    const first = room.addPlayer('Ada', true, 0);
    const expired = room.addPlayer('Grace', true, 1);
    if ('error' in first || 'error' in expired) throw new Error('station join failed');
    room.advance(first.playerId);

    expect(room.permanentlyRemovePlayer(expired.playerId)).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'category_select', expectedPlayerCount: 2, hasExpectedPlayers: false,
      players: [{ playerId: first.playerId, playerOrder: 0 }],
    });
    expect(room.reconcilePregameRoster(1, [first.playerId], [first.playerId])).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'lobby', expectedPlayerCount: 1, hasExpectedPlayers: true,
      players: [{ playerId: first.playerId, playerOrder: 0 }],
    });
  });

  it('compacts retained players in authoritative reconciliation order', () => {
    const room = new TriviaRoom('COMPACT', { bank });
    room.expectHumanPlayers(4, true, { stationFixed: true, allowReplay: false });
    const players = [0, 1, 2, 3].map(index => {
      const result = room.addPlayer(`Player ${index}`, true, index);
      if ('error' in result) throw new Error(result.error);
      return result.playerId;
    });
    room.advance(players[0]);

    expect(room.reconcilePregameRoster(
      2, [players[3]!, players[1]!], [players[3]!, players[1]!],
    )).toBe(true);
    expect(room.state().players.map(player => [player.playerId, player.playerOrder])).toEqual([
      [players[3], 0], [players[1], 1],
    ]);
  });

  it('preserves sparse station orders so a middle-seat replacement can join and proceed', () => {
    const room = new TriviaRoom('SPARSE-MIDDLE', { bank });
    room.expectHumanPlayers(4, true, { stationFixed: true, allowReplay: false });
    const players = [0, 1, 2, 3].map(index => {
      const result = room.addPlayer(`Player ${index}`, true, index);
      if ('error' in result) throw new Error(result.error);
      return result.playerId;
    });
    room.advance(players[0]);

    expect(room.reconcilePregameRoster(
      4,
      [players[0]!, players[2]!, players[3]!],
      [players[0]!, null, players[2]!, players[3]!],
    )).toBe(true);
    expect(room.state().players.map(player => [player.playerId, player.playerOrder])).toEqual([
      [players[0], 0], [players[2], 2], [players[3], 3],
    ]);
    const replacement = room.addPlayer('Replacement', true, 1);
    if ('error' in replacement) throw new Error(replacement.error);
    expect(room.state().players.map(player => player.playerOrder)).toEqual([0, 1, 2, 3]);

    expect(room.advance(players[0])).toBe(true);
    for (const player of room.state().players) expect(room.voteCategory(player.playerId, 'science')).toBe(true);
    expect(room.advance(replacement.playerId)).toBe(true);
    expect(room.phase).toBe('loading');
  });

  it('uses indexed slots to shrink around a pending caller and move retained players into range', () => {
    const room = new TriviaRoom('SHRINK-PENDING', { bank });
    room.expectHumanPlayers(4, true, { stationFixed: true, allowReplay: false });
    const players = [0, 1, 2, 3].map(index => {
      const result = room.addPlayer(`Player ${index}`, true, index);
      if ('error' in result) throw new Error(result.error);
      return result.playerId;
    });
    room.advance(players[0]);

    expect(room.reconcilePregameRoster(
      3,
      [players[2]!, players[3]!],
      [null, players[2]!, players[3]!],
    )).toBe(true);
    expect(room.state().players.map(player => [player.playerId, player.playerOrder])).toEqual([
      [players[2], 1], [players[3], 2],
    ]);
    const pending = room.addPlayer('Pending', true, 0);
    if ('error' in pending) throw new Error(pending.error);
    expect(room.state().players.map(player => player.playerOrder)).toEqual([0, 1, 2]);
    expect(room.advance(pending.playerId)).toBe(true);
  });

  it('rejects malformed indexed slots without mutating or wedging setup', () => {
    const room = new TriviaRoom('MALFORMED-SLOTS', { bank, now: () => 0 });
    room.expectHumanPlayers(4, true, { stationFixed: true, allowReplay: false });
    const players = [0, 1, 2, 3].map(index => {
      const result = room.addPlayer(`Player ${index}`, true, index);
      if ('error' in result) throw new Error(result.error);
      return result.playerId;
    });
    room.advance(players[0]);
    const before = room.state();

    expect(room.reconcilePregameRoster(4, [players[0]!], [players[0]!, null, null])).toBe(false);
    expect(room.reconcilePregameRoster(
      4, [players[0]!], [players[0]!, players[0]!, null, null],
    )).toBe(false);
    expect(room.reconcilePregameRoster(
      4, [players[0]!, players[3]!], [players[0]!, null, players[2]!, null],
    )).toBe(false);
    expect(room.reconcilePregameRoster(
      4, [players[0]!, 'missing'], [players[0]!, 'missing', null, null],
    )).toBe(false);
    expect(room.state()).toEqual(before);

    expect(room.reconcilePregameRoster(
      4,
      [players[0]!, players[2]!, players[3]!],
      [players[0]!, null, players[2]!, players[3]!],
    )).toBe(true);
    expect(room.phase).toBe('lobby');
  });

  it('uses trusted station indexes for stable order and deterministic tie ranking', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('INDEXED', { bank, now: () => now.value });
    room.expectHumanPlayers(4, true, { stationFixed: true, allowReplay: false });
    const players = [3, 2, 1, 0].map(index => {
      const joinedPlayer = room.addPlayer(`Player ${index}`, true, index);
      if ('error' in joinedPlayer) throw new Error(joinedPlayer.error);
      return joinedPlayer.playerId;
    });
    expect(room.state().players.map(player => [player.name, player.playerOrder])).toEqual([
      ['Player 0', 0], ['Player 1', 1], ['Player 2', 2], ['Player 3', 3],
    ]);
    expect(room.addPlayer('Duplicate', true, 2)).toEqual({ error: 'player_order_taken' });
    expect(room.addPlayer('Invalid', true, 4)).toEqual({ error: 'invalid_player_order' });

    room.advance(players[0]);
    room.advance(players[0]);
    room.ready(room.state().loadingGeneration);
    now.value = room.state().countdownEndsAtMs!;
    room.tick();
    for (let questionIndex = 0; questionIndex < 8; questionIndex++) {
      settlePrompt(room, now);
      const sharedChoice = room.state().question!.choices[0]!.id;
      for (const playerId of players) room.answer(playerId, sharedChoice);
      now.value = room.state().revealEndsAtMs!;
      room.tick();
    }
    expect(room.state().result?.players.map(player => [player.name, player.playerOrder, player.rank])).toEqual([
      ['Player 0', 0, 1], ['Player 1', 1, 2], ['Player 2', 2, 3], ['Player 3', 3, 4],
    ]);
  });

  it('keeps automatic roster setup while allowing standalone replay but rejecting station replay', () => {
    const standaloneNow = { value: 0 };
    const standalone = new TriviaRoom('STANDALONE-REPLAY', { bank, now: () => standaloneNow.value });
    standalone.expectHumanPlayers(1, true, { stationFixed: false, allowReplay: true });
    const standalonePlayer = joined(standalone);
    finishRound(standalone, standalonePlayer, standaloneNow);
    expect(standalone.state()).toMatchObject({ phase: 'results', automaticSetup: true });
    expect(standalone.advance()).toBe(false);
    expect(standalone.advance(standalonePlayer)).toBe(true);
    expect(standalone.state()).toMatchObject({ phase: 'category_select', automaticSetup: true });

    const stationNow = { value: 0 };
    const station = new TriviaRoom('STATION-REPLAY', { bank, now: () => stationNow.value });
    station.expectHumanPlayers(1, true, { stationFixed: true, allowReplay: false });
    const stationPlayer = joined(station);
    finishRound(station, stationPlayer, stationNow);
    expect(station.advance(stationPlayer)).toBe(false);
    expect(station.phase).toBe('results');
    const terminal = station.state();
    expect(station.permanentlyRemovePlayer(stationPlayer)).toBe(false);
    expect(station.state()).toEqual(terminal);
  });

  it('keeps a completed standalone result until a new caller explicitly starts a session', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('SOLO-FINISHED', { bank, now: () => now.value });
    room.expectHumanPlayers(1, true, { stationFixed: false, allowReplay: true });
    const oldPlayer = joined(room, 'Ada');
    finishRound(room, oldPlayer, now);
    const result = room.state().result;

    expect(room.prepareForNewCaller()).toBe(false);
    expect(room.setPlayerConnected(oldPlayer, false)).toBe(true);
    expect(room.state().result).toEqual(result);
    expect(room.prepareForNewCaller()).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'lobby', result: null, players: [] });
    const newcomer = joined(room, 'Grace');
    expect(room.state().players).toEqual([expect.objectContaining({ playerId: newcomer, name: 'Grace' })]);
  });

  it('accepts revisable votes and resolves plurality ties and no-vote rounds to mixed', () => {
    const tied = new TriviaRoom('TIE', { bank, seed: 2 });
    const players = [joined(tied, 'One'), joined(tied, 'Two'), joined(tied, 'Three'), joined(tied, 'Four')];
    tied.advance();
    expect(tied.voteCategory(players[0]!, 'science')).toBe(true);
    expect(tied.voteCategory(players[0]!, 'history')).toBe(true);
    expect(tied.voteCategory(players[1]!, 'history')).toBe(true);
    expect(tied.voteCategory(players[2]!, 'science')).toBe(true);
    expect(tied.voteCategory(players[3]!, 'science')).toBe(true);
    expect(tied.state().categoryVoteCounts).toMatchObject({ history: 2, science: 2 });
    expect(tied.advance()).toBe(true);
    expect(tied.state().category).toBe('mixed');

    const empty = new TriviaRoom('NO-VOTES', { bank, seed: 3 });
    joined(empty);
    empty.advance();
    empty.advance();
    expect(empty.state().category).toBe('mixed');
  });

  it('uses the core selector for deterministic mixed and 2/4/2 category plans', () => {
    const run = (code: string, category: 'mixed' | 'science') => {
      const now = { value: 0 };
      const room = new TriviaRoom(code, { bank, seed: 'same', now: () => now.value });
      const player = joined(room);
      room.advance();
      room.voteCategory(player, category);
      room.advance();
      room.ready(room.state().loadingGeneration);
      now.value = TRIVIA_COUNTDOWN_MS;
      room.tick();
      settlePrompt(room, now);
      const selected: { id: string; category: string; difficulty: string }[] = [];
      for (let index = 0; index < 8; index++) {
        selected.push(room.state().question!);
        room.answer(player, correctChoice(room));
        now.value = room.state().revealEndsAtMs!;
        room.tick();
        if (index < 7) settlePrompt(room, now);
      }
      return selected;
    };
    expect(run('DETERMINISTIC', 'science')).toEqual(run('DETERMINISTIC', 'science'));
    const mixed = run('MIXED', 'mixed');
    expect(new Set(mixed.map(question => question.category))).toHaveLength(8);
    const science = run('SCIENCE', 'science');
    expect(science.every(question => question.category === 'science')).toBe(true);
    expect(Object.fromEntries(['easy', 'medium', 'hard'].map(difficulty => [
      difficulty, science.filter(question => question.difficulty === difficulty).length,
    ]))).toEqual(TRIVIA_DIFFICULTY_DISTRIBUTION);
  });

  it('generates readiness versions, invalidates display loss, and times loading out', () => {
    const now = { value: 1_000 };
    const room = new TriviaRoom('LOAD', { bank, now: () => now.value, loadingTimeoutMs: 2_000 });
    const player = joined(room);
    room.advance();
    room.voteCategory(player, 'science');
    room.advance();
    const generation = room.state().loadingGeneration;
    expect(room.ready(generation + 1)).toBe(false);
    expect(room.invalidateDisplayReady()).toBe(true);
    expect(room.state().loadingGeneration).toBe(generation + 1);
    expect(room.retryLoading(generation)).toBe(false);
    now.value += 1_999;
    expect(room.tick()).toBe(false);
    now.value += 1;
    expect(room.tick()).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'category_select', category: null, displayReady: false,
      categoryVoteCounts: { science: 0 },
    });
    const timedOutGeneration = room.state().loadingGeneration;
    expect(room.tick()).toBe(false);
    expect(room.state().loadingGeneration).toBe(timedOutGeneration);
    expect(room.drainEvents().at(-1)).toEqual({
      type: 'loading_timeout', loadingGeneration: generation + 1, displayReady: false, atMs: now.value,
    });
  });

  it('publishes a redacted prompt and starts the clock after the question, before choices', () => {
    const now = { value: 10_000 };
    const room = new TriviaRoom('CLOCK', { bank, now: () => now.value });
    const player = joined(room);
    room.advance();
    room.advance();
    room.ready(room.state().loadingGeneration);
    const endsAt = now.value + TRIVIA_COUNTDOWN_MS;
    now.value = endsAt + 500;
    room.tick();
    expect(room.state()).toMatchObject({
      phase: 'question_prompt',
      countdownEndsAtMs: null,
      answerCueEndsAtMs: null,
      answeringStartsAtMs: null,
      questionEndsAtMs: null,
    });
    const questionId = room.state().question!.id;
    const attemptId = room.state().questionAttemptId!;
    expect(room.questionPromptReady(player, questionId, attemptId, 1)).toBe(false);
    expect(room.questionAnswerCueReady(player, questionId, attemptId, 1)).toBe(false);
    const promptDelivery = room.beginPromptDelivery(player, questionId, attemptId)!;
    expect(room.questionPromptReady(player, questionId, attemptId, promptDelivery)).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'answer_cue', answeringStartsAtMs: now.value,
      questionEndsAtMs: now.value + TRIVIA_ANSWER_WINDOW_MS });
    const cueDelivery = room.beginAnswerCueDelivery(player, questionId, attemptId)!;
    expect(room.questionAnswerCueReady(player, questionId, attemptId, cueDelivery)).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'question', answeringStartsAtMs: now.value,
      questionEndsAtMs: now.value + TRIVIA_ANSWER_WINDOW_MS });
    expect(room.drainEvents()).toEqual(expect.arrayContaining([
      { type: 'countdown', count: 3, atMs: 10_000 },
      { type: 'countdown', count: 2, atMs: 11_000 },
      { type: 'countdown', count: 1, atMs: 12_000 },
      { type: 'question_started', questionId, questionAttemptId: attemptId,
        questionIndex: 0, promptDeadlineAtMs: now.value + 60_000 },
      { type: 'answering_started', questionId, questionAttemptId: attemptId,
        startsAtMs: now.value, endsAtMs: now.value + TRIVIA_ANSWER_WINDOW_MS },
    ]));
    expect(JSON.stringify(room.state())).not.toMatch(/correctChoiceId|aliases|explanation/);
  });

  it('starts one shared clock after all four question prompts and keeps it through cue playback', () => {
    const now = { value: 5_000 };
    const room = new TriviaRoom('PROMPT-FOUR', { bank, now: () => now.value });
    const players = [joined(room, 'One'), joined(room, 'Two'), joined(room, 'Three'), joined(room, 'Four')];
    room.advance();
    room.advance();
    room.ready(room.state().loadingGeneration);
    now.value += TRIVIA_COUNTDOWN_MS;
    room.tick();
    const questionId = room.state().question!.id;
    const attemptId = room.state().questionAttemptId!;
    expect(room.phase).toBe('question_prompt');
    expect(room.questionPromptReady(players[0]!, 'stale-question', attemptId, 1)).toBe(false);
    const firstDelivery = room.beginPromptDelivery(players[0]!, questionId, attemptId)!;
    expect(room.questionPromptReady(players[0]!, questionId, attemptId, firstDelivery)).toBe(true);
    expect(room.phase).toBe('question_prompt');
    for (const player of players.slice(1)) {
      const delivery = room.beginPromptDelivery(player, questionId, attemptId)!;
      expect(room.questionPromptReady(player, questionId, attemptId, delivery)).toBe(true);
    }
    expect(room.phase).toBe('answer_cue');
    const clockStartedAt = now.value;
    expect(room.state().answeringStartsAtMs).toBe(clockStartedAt);
    expect(room.questionAnswerCueReady(players[0]!, 'stale-question', attemptId, 1)).toBe(false);
    for (const player of players.slice(0, -1)) {
      const delivery = room.beginAnswerCueDelivery(player, questionId, attemptId)!;
      expect(room.questionAnswerCueReady(player, questionId, attemptId, delivery)).toBe(true);
    }
    expect(room.phase).toBe('answer_cue');
    now.value += 321;
    const lastCue = room.beginAnswerCueDelivery(players[3]!, questionId, attemptId)!;
    expect(room.questionAnswerCueReady(players[3]!, questionId, attemptId, lastCue)).toBe(true);
    expect(room.phase).toBe('question');
    expect(room.state()).toMatchObject({ answeringStartsAtMs: clockStartedAt,
      questionEndsAtMs: clockStartedAt + TRIVIA_ANSWER_WINDOW_MS });
    expect(room.drainEvents().filter(event => event.type === 'answering_started')).toEqual([{
      type: 'answering_started', questionId, questionAttemptId: attemptId,
      startsAtMs: clockStartedAt, endsAtMs: clockStartedAt + TRIVIA_ANSWER_WINDOW_MS,
    }]);
  });

  it('keeps shared question timestamps stable across caller disconnects', () => {
    const disconnectedNow = { value: 10_000 };
    const disconnected = new TriviaRoom('PROMPT-DISCONNECT', { bank, now: () => disconnectedNow.value });
    const first = joined(disconnected, 'One');
    const second = joined(disconnected, 'Two');
    disconnected.advance();
    disconnected.advance();
    disconnected.ready(disconnected.state().loadingGeneration);
    disconnectedNow.value += TRIVIA_COUNTDOWN_MS;
    disconnected.tick();
    settlePrompt(disconnected, disconnectedNow);
    const published = disconnected.state();
    expect(published.phase).toBe('question');
    expect(disconnected.setPlayerConnected(second, false)).toBe(true);
    expect(disconnected.setPlayerConnected(first, false)).toBe(true);
    expect(disconnected.phase).toBe('question');
    expect(disconnected.permanentlyRemovePlayer(second)).toBe(true);
    expect(disconnected.phase).toBe('question');
    expect(disconnected.setPlayerConnected(first, true)).toBe(true);
    expect(disconnected.setPlayerConnected(first, false)).toBe(true);
    expect(disconnected.phase).toBe('question');
    expect(disconnected.setPlayerConnected(first, true)).toBe(true);
    expect(disconnected.phase).toBe('question');
    expect(disconnected.state()).toMatchObject({
      phase: 'question', answeringStartsAtMs: published.answeringStartsAtMs,
      questionEndsAtMs: published.questionEndsAtMs,
    });
  });

  it('physically purges a departed active player and excludes them from the final result', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('PERMANENT-DEPARTURE', { bank, now: () => now.value });
    const survivor = joined(room, 'Ada');
    const departed = joined(room, 'Grace');
    startQuestion(room, survivor, now);
    expect(room.setPlayerConnected(departed, false)).toBe(true);
    expect(room.hasPlayer(departed)).toBe(true);
    expect(room.permanentlyRemovePlayer(departed)).toBe(true);
    expect(room.hasPlayer(departed)).toBe(false);

    for (let index = 0; index < 8; index++) {
      room.answer(survivor, correctChoice(room));
      now.value = room.state().revealEndsAtMs!;
      room.tick();
      if (index < 7) settlePrompt(room, now);
    }
    expect(room.state().result?.players).toEqual([
      expect.objectContaining({ playerId: survivor, name: 'Ada' }),
    ]);
  });

  it('keeps the station expected count while excluding an active departure from results', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('STATION-ACTIVE-DEPARTURE', { bank, now: () => now.value });
    room.expectHumanPlayers(2, true, { stationFixed: true, allowReplay: false });
    const survivorResult = room.addPlayer('Ada', true, 0);
    const departedResult = room.addPlayer('Grace', true, 1);
    if ('error' in survivorResult || 'error' in departedResult) throw new Error('station join failed');
    const survivor = survivorResult.playerId;
    const departed = departedResult.playerId;
    startQuestion(room, survivor, now);

    expect(room.permanentlyRemovePlayer(departed)).toBe(true);
    expect(room.state()).toMatchObject({ expectedPlayerCount: 2, hasExpectedPlayers: false });
    for (let index = 0; index < 8; index++) {
      room.answer(survivor, correctChoice(room));
      now.value = room.state().revealEndsAtMs!;
      room.tick();
      if (index < 7) settlePrompt(room, now);
    }
    expect(room.state()).toMatchObject({
      phase: 'results', expectedPlayerCount: 2,
      result: { players: [expect.objectContaining({ playerId: survivor })] },
    });
    expect(room.state().result?.players.some(player => player.playerId === departed)).toBe(false);
  });

  it('rejects pregame reconciliation after countdown without mutating the frozen roster', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('NO-ACTIVE-RECONCILE', { bank, now: () => now.value });
    room.expectHumanPlayers(2, true, { stationFixed: true, allowReplay: false });
    const first = room.addPlayer('Ada', true, 0);
    const second = room.addPlayer('Grace', true, 1);
    if ('error' in first || 'error' in second) throw new Error('station join failed');
    room.advance(first.playerId);
    room.advance(first.playerId);
    room.ready(room.state().loadingGeneration);
    const before = room.state();

    expect(room.reconcilePregameRoster(1, [first.playerId], [first.playerId])).toBe(false);
    expect(room.state()).toEqual(before);
  });

  it('freezes public aggregates throughout active answering', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('CUE-SCORE-FREEZE', { bank, now: () => now.value });
    const first = joined(room, 'One');
    const second = joined(room, 'Two');
    room.advance(first);
    room.advance(first);
    room.ready(room.state().loadingGeneration);
    now.value = TRIVIA_COUNTDOWN_MS;
    room.tick();
    settlePrompt(room, now);
    expect(room.state()).toMatchObject({
      phase: 'question', answeringStartsAtMs: now.value,
      players: [{ answered: false, rawScore: 0 }, { answered: false, rawScore: 0 }],
    });
    expect(room.answer(first, correctChoice(room))).toBe(true);
    expect(room.state().players[0]).toMatchObject({ answered: true, rawScore: 0, correctCount: 0 });
    now.value = room.state().answeringStartsAtMs!;
    expect(room.answer(first, correctChoice(room))).toBe(false);
    expect(room.state()).toMatchObject({
      phase: 'question',
      players: [{ answered: true, rawScore: 0, correctCount: 0, bestStreak: 0 },
        { answered: false, rawScore: 0, correctCount: 0, bestStreak: 0 }],
    });
  });

  it('rejects pre-publication timestamps and accepts speech and DTMF immediately at publication', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('PRESTART-LOCKS', { bank, now: () => now.value });
    const correctPlayer = joined(room, 'Correct');
    const wrongPlayer = joined(room, 'Wrong');
    const dtmfPlayer = joined(room, 'DTMF');
    room.advance(correctPlayer);
    room.advance(correctPlayer);
    room.ready(room.state().loadingGeneration);
    now.value = TRIVIA_COUNTDOWN_MS;
    room.tick();
    settlePrompt(room, now);
    const start = room.state().answeringStartsAtMs!;
    const correct = correctChoice(room);
    const wrong = room.state().question!.choices.find(choice => choice.id !== correct)!.id;
    expect(start).toBe(now.value);

    expect(room.answerAt(correctPlayer, correct, true, start - 1)).toBe(false);
    expect(room.answer(correctPlayer, 'unknown answer')).toBe(false);
    expect(room.state().players.find(player => player.playerId === correctPlayer)?.answered).toBe(false);
    expect(room.answer(correctPlayer, correct)).toBe(true);
    expect(room.answer(correctPlayer, wrong)).toBe(false);
    expect(room.answer(wrongPlayer, wrong)).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'question',
      players: [
        { answered: true, rawScore: 0, correctCount: 0, bestStreak: 0 },
        { answered: true, rawScore: 0, correctCount: 0, bestStreak: 0 },
        { answered: false, rawScore: 0, correctCount: 0, bestStreak: 0 },
      ],
    });
    expect(room.drainEvents().filter(event => event.type === 'answer_result')).toEqual([]);

    expect(room.answer(dtmfPlayer, '1')).toBe(true);
    const results = room.drainEvents().filter(event => event.type === 'answer_result');
    expect(results.find(event => event.playerId === correctPlayer)).toMatchObject({
      correct: true, points: 1_300, rawScore: 1_300,
    });
    expect(results.find(event => event.playerId === wrongPlayer)).toMatchObject({
      correct: false, points: 0, rawScore: 0,
    });
    expect(results.every(event => event.points >= 0)).toBe(true);
  });

  it('redacts active answer data and exposes only a lock indicator until reveal', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('REDACT', { bank, now: () => now.value });
    const first = joined(room, 'One');
    joined(room, 'Two');
    startQuestion(room, first, now);
    const before = JSON.stringify(room.state());
    expect(before).not.toContain('correctChoiceId');
    expect(before).not.toContain('aliases');
    expect(before).not.toContain('explanation');
    expect(room.answer(first, correctChoice(room))).toBe(true);
    const active = room.state();
    expect(active.phase).toBe('question');
    expect(active.players.find(player => player.playerId === first)?.answered).toBe(true);
    const serialized = JSON.stringify(active);
    expect(serialized).not.toContain('submittedChoiceId');
    expect(serialized).not.toContain('correctChoiceId');
    expect(active.question?.choices.map(choice => choice.id).sort()).toEqual([...TRIVIA_CHOICE_IDS]);
  });

  it('makes correct and wrong locks indistinguishable before reveal for multiple players', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('NO-SIDE-CHANNEL', { bank, now: () => now.value });
    const correctPlayer = joined(room, 'Correct lock');
    const wrongPlayer = joined(room, 'Wrong lock');
    const pendingPlayer = joined(room, 'Pending');
    startQuestion(room, correctPlayer, now);
    room.drainEvents();
    const question = room.state().question!;
    const correct = correctChoice(room);
    const wrong = question.choices.find(choice => choice.id !== correct)!.id;

    expect(room.answer(correctPlayer, correct)).toBe(true);
    expect(room.drainEvents()).toEqual([]);
    expect(room.answer(wrongPlayer, wrong)).toBe(true);
    expect(room.drainEvents()).toEqual([]);

    const active = room.state();
    expect(active.phase).toBe('question');
    const aggregates = active.players.map(player => ({
      answered: player.answered,
      rawScore: player.rawScore,
      correctCount: player.correctCount,
      bestStreak: player.bestStreak,
    }));
    expect(aggregates).toEqual([
      { answered: true, rawScore: 0, correctCount: 0, bestStreak: 0 },
      { answered: true, rawScore: 0, correctCount: 0, bestStreak: 0 },
      { answered: false, rawScore: 0, correctCount: 0, bestStreak: 0 },
    ]);
    expect(JSON.stringify(active)).not.toMatch(/correctChoiceId|answer_result|submittedCorrect/);

    expect(room.answer(pendingPlayer, wrong)).toBe(true);
    expect(room.state().players.find(player => player.playerId === correctPlayer)).toMatchObject({
      rawScore: 1_300, correctCount: 1, bestStreak: 1,
    });
    expect(room.drainEvents().filter(event => event.type === 'answer_result')).toHaveLength(3);
  });

  it('locks the first valid final answer including a wrong answer', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('WRONG', { bank, now: () => now.value });
    const player = joined(room);
    startQuestion(room, player, now);
    const question = room.state().question!;
    const correct = correctChoice(room);
    const wrong = question.choices.find(choice => choice.id !== correct)!.id;
    expect(room.answer(player, correct, false)).toBe(false);
    expect(room.answer(player, 'not an option')).toBe(false);
    expect(room.answer(player, wrong)).toBe(true);
    expect(room.answer(player, correct)).toBe(false);
    expect(room.state()).toMatchObject({ phase: 'reveal', players: [{ rawScore: 0, correctCount: 0, bestStreak: 0 }] });
    const revealEvents = room.drainEvents();
    expect(revealEvents.findIndex(event => event.type === 'question_revealed')).toBeLessThan(
      revealEvents.findIndex(event => event.type === 'answer_result'),
    );
    expect(revealEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'answer_result', playerId: player, correct: false, points: 0 }),
    ]));
  });

  it.each([
    [0, 1_300],
    [7_999, 1_300],
    [8_000, 1_200],
    [15_999, 1_200],
    [16_000, 1_100],
    [22_999, 1_100],
    [23_000, 1_000],
    [25_000, 1_000],
  ])('uses the exact core speed boundary at %i ms', (elapsedMs, expectedPoints) => {
    const now = { value: 0 };
    const room = new TriviaRoom(`SPEED-${elapsedMs}`, { bank, now: () => now.value });
    const player = joined(room);
    startQuestion(room, player, now);
    const answeringStartsAt = room.state().answeringStartsAtMs!;
    now.value = answeringStartsAt + elapsedMs;
    expect(room.answerAt(player, correctChoice(room), true, answeringStartsAt + elapsedMs)).toBe(true);
    expect(room.state().players[0]!.rawScore).toBe(expectedPoints);
  });

  it('scores an on-time onset received during grace and rejects stale/out-of-window timestamps', () => {
    const acceptedNow = { value: 0 };
    const accepted = new TriviaRoom('LATE-OK', { bank, now: () => acceptedNow.value });
    const acceptedPlayer = joined(accepted);
    startQuestion(accepted, acceptedPlayer, acceptedNow);
    const answeringStartsAt = accepted.state().answeringStartsAtMs!;
    const questionEnd = accepted.state().questionEndsAtMs!;
    acceptedNow.value = questionEnd + TRIVIA_FINAL_ANSWER_GRACE_MS;
    expect(accepted.answerAt(acceptedPlayer, correctChoice(accepted), true, answeringStartsAt - 1)).toBe(false);
    expect(accepted.answerAt(acceptedPlayer, correctChoice(accepted), true, questionEnd + 1)).toBe(false);
    expect(accepted.answerAt(
      acceptedPlayer, correctChoice(accepted), true, answeringStartsAt + 2_999,
    )).toBe(true);
    expect(accepted.state().players[0]!.rawScore).toBe(1_300);
    expect(accepted.state().revealEndsAtMs).toBe(acceptedNow.value + TRIVIA_REVEAL_MS);

    const rejectedNow = { value: 0 };
    const rejected = new TriviaRoom('LATE-NO', { bank, now: () => rejectedNow.value });
    const rejectedPlayer = joined(rejected);
    startQuestion(rejected, rejectedPlayer, rejectedNow);
    const rejectedStart = rejected.state().answeringStartsAtMs!;
    rejectedNow.value = rejected.state().questionEndsAtMs! + TRIVIA_FINAL_ANSWER_GRACE_MS + 1;
    expect(rejected.answerAt(rejectedPlayer, correctChoice(rejected), true, rejectedStart + 1_000)).toBe(false);
    expect(rejected.tick()).toBe(true);
    expect(rejected.state()).toMatchObject({ phase: 'reveal', players: [{ answered: false, rawScore: 0 }] });

    const staleNow = { value: 0 };
    const stale = new TriviaRoom('STALE-ONSET', { bank, now: () => staleNow.value });
    const stalePlayer = joined(stale);
    startQuestion(stale, stalePlayer, staleNow);
    const oldStart = stale.state().answeringStartsAtMs!;
    stale.answer(stalePlayer, correctChoice(stale));
    staleNow.value = stale.state().revealEndsAtMs!;
    stale.tick();
    settlePrompt(stale, staleNow);
    expect(stale.answerAt(stalePlayer, correctChoice(stale), true, oldStart)).toBe(false);
  });

  it('holds only a pending on-time semantic answer long enough to resolve after the normal grace', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('SEMANTIC-DEADLINE', { bank, now: () => now.value });
    const player = joined(room);
    startQuestion(room, player, now);
    const state = room.state();
    const end = state.questionEndsAtMs!;
    const receivedAtMs = end - 100;
    now.value = receivedAtMs;
    const resolutionId = room.beginSemanticAnswerResolution(player, state.question!.id,
      state.questionAttemptId!);
    expect(resolutionId).not.toBeNull();

    now.value = end + TRIVIA_FINAL_ANSWER_GRACE_MS + 1;
    expect(room.tick()).toBe(false);
    expect(room.state().phase).toBe('question');
    now.value = receivedAtMs + TRIVIA_SEMANTIC_ANSWER_MAX_MS - 1;
    expect(room.answerAt(player, correctChoice(room), true, receivedAtMs, resolutionId!)).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'reveal', players: [{ answered: true, rawScore: 1_000 }] });
  });

  it('reserves a paraphrased answer heard before time runs out without awarding an early speed bonus', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('SEMANTIC-PARAPHRASE', { bank, now: () => now.value });
    const player = joined(room);
    startQuestion(room, player, now);
    const state = room.state();
    const end = state.questionEndsAtMs!;
    now.value = end + 400;
    const id = room.beginSemanticAnswerResolution(player, state.question!.id,
      state.questionAttemptId!, { atMs: end });
    expect(id).not.toBeNull();
    expect(room.beginSemanticAnswerResolution(player, state.question!.id,
      state.questionAttemptId!, { atMs: end + 1 })).toBeNull();

    now.value = end + TRIVIA_FINAL_ANSWER_GRACE_MS + 1;
    expect(room.tick()).toBe(false);
    expect(room.answerAt(player, correctChoice(room), true, end, id!)).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'reveal', players: [{ answered: true, rawScore: 1_000 }] });
  });

  it('ends a pending semantic hold after correction or its strict three-second limit', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('SEMANTIC-CANCEL', { bank, now: () => now.value });
    const player = joined(room);
    startQuestion(room, player, now);
    const state = room.state();
    const end = state.questionEndsAtMs!;
    now.value = end - 100;
    const oldId = room.beginSemanticAnswerResolution(player, state.question!.id, state.questionAttemptId!);
    expect(oldId).not.toBeNull();
    expect(room.finishSemanticAnswerResolution(player, state.question!.id, state.questionAttemptId!, oldId!))
      .toBe(true);
    now.value = end + TRIVIA_FINAL_ANSWER_GRACE_MS;
    expect(room.tick()).toBe(true);
    expect(room.state().phase).toBe('reveal');
    expect(room.answerAt(player, correctChoice(room), true, end - 100, oldId!)).toBe(false);

    const secondNow = { value: 0 };
    const second = new TriviaRoom('SEMANTIC-EXPIRE', { bank, now: () => secondNow.value });
    const secondPlayer = joined(second);
    startQuestion(second, secondPlayer, secondNow);
    const secondState = second.state();
    secondNow.value = secondState.questionEndsAtMs! - 100;
    const id = second.beginSemanticAnswerResolution(secondPlayer, secondState.question!.id,
      secondState.questionAttemptId!);
    expect(id).not.toBeNull();
    secondNow.value += TRIVIA_SEMANTIC_ANSWER_MAX_MS;
    expect(second.tick()).toBe(true);
    expect(second.state().phase).toBe('reveal');
  });

  it('reserves a delayed ASR final only for its matching on-time interim choice', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('SEMANTIC-ASR-GRACE', { bank, now: () => now.value });
    const player = joined(room);
    startQuestion(room, player, now);
    const state = room.state();
    const end = state.questionEndsAtMs!;
    const onsetAtMs = end - 200;
    const correct = correctChoice(room);
    const wrong = state.question!.choices.find(choice => choice.id !== correct)!.id;
    now.value = end + 1_000;
    expect(room.beginSemanticAnswerResolution(player, state.question!.id, state.questionAttemptId!))
      .toBeNull();
    const resolutionId = room.beginSemanticAnswerResolution(player, state.question!.id,
      state.questionAttemptId!, { choiceId: correct, atMs: onsetAtMs });
    expect(resolutionId).not.toBeNull();

    now.value = end + TRIVIA_FINAL_ANSWER_GRACE_MS + 1;
    expect(room.tick()).toBe(false);
    now.value = end + 3_499;
    expect(room.answerAt(player, wrong, true, onsetAtMs, resolutionId!)).toBe(false);
    expect(room.answerAt(player, correct, true, onsetAtMs, resolutionId!)).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'reveal', players: [{ answered: true, rawScore: 1_000 }] });
  });

  it('resets streak on wrong/no-answer, shows reveal standings for four seconds, and always completes', () => {
    const now = { value: 0 };
    const room = new TriviaRoom('COMPLETE', {
      bank, seed: 9, now: () => now.value, contentRevision: 'questions-2026-08-29',
    });
    const player = joined(room);
    startQuestion(room, player, now);

    room.answer(player, correctChoice(room));
    expect(room.state()).toMatchObject({ phase: 'reveal', revealEndsAtMs: now.value + TRIVIA_REVEAL_MS });
    expect(room.state().standings?.[0]).toMatchObject({ correctCount: 1, bestStreak: 1, rank: 1 });
    now.value = room.state().revealEndsAtMs!;
    room.tick();
    settlePrompt(room, now);
    const second = room.state().question!;
    room.answer(player, second.choices.find(choice => choice.id !== correctChoice(room))!.id);
    now.value = room.state().revealEndsAtMs!;
    room.tick();
    settlePrompt(room, now);

    // Let question three expire; a delayed tick must still move through every remaining absolute deadline.
    now.value = room.state().questionEndsAtMs! + TRIVIA_FINAL_ANSWER_GRACE_MS;
    room.tick();
    now.value = room.state().revealEndsAtMs!;
    room.tick();
    for (let index = 3; index < 8; index++) {
      settlePrompt(room, now);
      room.answer(player, correctChoice(room));
      now.value = room.state().revealEndsAtMs!;
      room.tick();
    }

    const state = room.state();
    expect(state.phase).toBe('results');
    expect(state.result).toMatchObject({
      resultId: expect.stringMatching(/^trivia-[a-z0-9]+-1$/),
      generation: 1,
      category: 'mixed',
      contentRevision: 'questions-2026-08-29',
      completedAtMs: now.value,
      players: [expect.objectContaining({
        playerId: player, rank: 1, normalizedScore: expect.any(Number), correctCount: 6,
        bestStreak: 5, cumulativeCorrectTimeMs: expect.any(Number),
      })],
    });
    expect(Object.isFrozen(state.result)).toBe(true);
    expect(Object.isFrozen(state.result!.players)).toBe(true);
    expect(Object.isFrozen(state.result!.players[0])).toBe(true);
    expect(room.tick()).toBe(false);
    expect(room.drainEvents().at(-1)).toMatchObject({ type: 'round_finished', result: state.result });
    expect(room.setName(player, 'PLAYER')).toBe(true);
    expect(state.result!.players[0]!.name).toBe('Ada');
    expect(room.state().result).toMatchObject({
      resultId: state.result!.resultId,
      players: [expect.objectContaining({ name: 'PLAYER' })],
    });
    expect(Object.isFrozen(room.state().result)).toBe(true);
  });
});
