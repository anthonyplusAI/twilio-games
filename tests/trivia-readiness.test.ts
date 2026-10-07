import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TriviaRoom, TRIVIA_AUDIO_RECOVERY_MS, TRIVIA_COUNTDOWN_MS } from '../server/trivia-room';
import { TRIVIA_ANSWER_WINDOW_MS, parseTriviaQuestionBankJson } from '../shared/trivia';

const bank = parseTriviaQuestionBankJson(
  readFileSync(new URL('../content/trivia/questions.json', import.meta.url), 'utf8'),
);

function openQuestion(now: { value: number }, station = false) {
  const room = new TriviaRoom('FAIR', { bank, now: () => now.value, questionPromptTimeoutMs: 20_000 });
  if (station) room.expectHumanPlayers(2, true, { stationFixed: true, allowReplay: false });
  const first = room.addPlayer('Ada');
  const second = room.addPlayer('Grace');
  if ('error' in first || 'error' in second) throw new Error('join failed');
  expect(room.advance(first.playerId)).toBe(true);
  expect(room.advance(first.playerId)).toBe(true);
  expect(room.ready(room.state().loadingGeneration)).toBe(true);
  now.value += TRIVIA_COUNTDOWN_MS;
  room.tick();
  return { room, first: first.playerId, second: second.playerId };
}

describe('trivia audible readiness', () => {
  it('keeps the ten-second clock closed until every player hears or skips the prompt and cue', () => {
    const now = { value: 1000 };
    const { room, first, second } = openQuestion(now);
    const prompt = room.state();
    expect(prompt).toMatchObject({
      phase: 'question_prompt', answeringStartsAtMs: null, questionEndsAtMs: null,
    });
    const questionId = prompt.question!.id;
    const attemptId = prompt.questionAttemptId!;
    const firstDelivery = room.beginPromptDelivery(first, questionId, attemptId)!;
    expect(room.questionPromptReady(first, questionId, attemptId, firstDelivery)).toBe(true);
    now.value += TRIVIA_ANSWER_WINDOW_MS + 1;
    room.tick();
    expect(room.state()).toMatchObject({ phase: 'question_prompt', questionEndsAtMs: null });
    const secondDelivery = room.beginPromptDelivery(second, questionId, attemptId)!;
    expect(room.questionPromptReady(second, questionId, attemptId, secondDelivery)).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'answer_cue', questionEndsAtMs: null });
    const firstCue = room.beginAnswerCueDelivery(first, questionId, attemptId)!;
    const secondCue = room.beginAnswerCueDelivery(second, questionId, attemptId)!;
    expect(room.questionAnswerCueReady(first, questionId, attemptId, firstCue)).toBe(true);
    expect(room.state().phase).toBe('answer_cue');
    expect(room.questionAnswerCueReady(second, questionId, attemptId, secondCue)).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'question', answeringStartsAtMs: now.value,
      questionEndsAtMs: now.value + TRIVIA_ANSWER_WINDOW_MS,
    });
  });

  it('holds an early answer for the common start and rejects old delivery generations', () => {
    const now = { value: 0 };
    const { room, first, second } = openQuestion(now);
    const { id: questionId } = room.state().question!;
    const attemptId = room.state().questionAttemptId!;
    const stale = room.beginPromptDelivery(first, questionId, attemptId)!;
    const current = room.beginPromptDelivery(first, questionId, attemptId)!;
    expect(room.questionPromptReady(first, questionId, attemptId, stale)).toBe(false);
    expect(room.queueEarlyAnswer(first, questionId, attemptId, 'a')).toBe(true);
    expect(room.questionPromptReady(first, questionId, attemptId, current)).toBe(false);
    expect(room.state().phase).toBe('question_prompt');
    const other = room.beginPromptDelivery(second, questionId, attemptId)!;
    expect(room.questionPromptReady(second, questionId, attemptId, other)).toBe(true);
    expect(room.state().phase).toBe('answer_cue');
    const cue = room.beginAnswerCueDelivery(second, questionId, attemptId)!;
    expect(room.questionAnswerCueReady(second, questionId, attemptId, cue)).toBe(true);
    expect(room.state().phase).toBe('question');
    expect(room.state().players.find(player => player.playerId === first)?.answered).toBe(true);
    expect(room.answer(first, 'b')).toBe(false);
  });

  it('pauses a station question instead of starting an unheard timer, then rejects stale attempt callbacks', () => {
    const now = { value: 0 };
    const { room, first, second } = openQuestion(now, true);
    const questionId = room.state().question!.id;
    const attemptId = room.state().questionAttemptId!;
    const delivery = room.beginPromptDelivery(first, questionId, attemptId)!;
    expect(room.questionPromptReady(first, questionId, attemptId, delivery)).toBe(true);
    room.setPlayerConnected(second, false);
    now.value += 20_001;
    room.tick();
    expect(room.state()).toMatchObject({ phase: 'audio_problem', questionEndsAtMs: null });
    expect(room.retryQuestion(questionId, attemptId)).toBe(true);
    const retried = room.state();
    expect(retried).toMatchObject({ phase: 'question_prompt', question: { id: questionId } });
    expect(retried.questionAttemptId).toBeGreaterThan(attemptId);
    expect(room.questionPromptReady(first, questionId, attemptId, delivery)).toBe(false);
    expect(room.queueEarlyAnswer(first, questionId, attemptId, 'a')).toBe(false);
    expect(room.retryQuestion(questionId, attemptId)).toBe(false);
  });

  it('ends an unattended audio pause at its deadline and rejects retry of the expired attempt', () => {
    const now = { value: 0 };
    const { room, first } = openQuestion(now);
    const questionId = room.state().question!.id;
    const attemptId = room.state().questionAttemptId!;
    room.drainEvents();
    now.value += 20_001;
    expect(room.tick()).toBe(true);
    expect(room.state().phase).toBe('audio_problem');
    expect(room.isTimingActive).toBe(true);
    room.drainEvents();

    now.value += TRIVIA_AUDIO_RECOVERY_MS;
    expect(room.tick()).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'audio_expired', question: null,
      questionAttemptId: attemptId, audioProblem: null });
    expect(room.isTimingActive).toBe(false);
    expect(room.retryQuestion(questionId, attemptId)).toBe(false);
    expect(room.queueEarlyAnswer(first, questionId, attemptId, 'a')).toBe(false);
    expect(room.drainEvents()).toEqual([{ type: 'audio_recovery_expired', questionId,
      questionAttemptId: attemptId, atMs: now.value }]);
    expect(room.tick()).toBe(false);
    expect(room.drainEvents()).toEqual([]);
  });
});
