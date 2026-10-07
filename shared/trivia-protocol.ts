import { isSupportedLocale, type SupportedLocale } from './i18n/locales';
import {
  TRIVIA_CATEGORY_IDS,
  TRIVIA_CHOICE_IDS,
  TRIVIA_MAX_PLAYERS,
  TRIVIA_MIN_PLAYERS,
  TRIVIA_ROUND_CATEGORY_IDS,
  normalizeTriviaScore,
  projectPublicTriviaQuestion,
  projectPublicTriviaReveal,
  type PublicTriviaQuestion,
  type PublicTriviaReveal,
  type TriviaRoundCategoryId,
  type TriviaRoundQuestion,
} from './trivia';

export const TRIVIA_PROTOCOL_MAX_JSON_LENGTH = 16 * 1024;

export type TriviaPhase =
  | 'lobby'
  | 'category_select'
  | 'loading'
  | 'countdown'
  | 'question_prompt'
  | 'answer_cue'
  | 'audio_problem'
  | 'audio_expired'
  | 'question'
  | 'reveal'
  | 'results';

export interface TriviaPublicPlayer {
  readonly playerId: string;
  readonly name: string;
  readonly nameConfirmed: boolean;
  readonly playerOrder: number;
  readonly connected: boolean;
  /** Whether this player locked an answer. The submitted choice is never public. */
  readonly answered: boolean;
  readonly rawScore: number;
  readonly correctCount: number;
  readonly bestStreak: number;
}

export interface TriviaPublicStanding extends TriviaPublicPlayer {
  readonly rank: number;
  readonly normalizedScore: number;
  readonly cumulativeCorrectTimeMs: number;
}

export type TriviaCategoryVoteCounts = Readonly<Record<TriviaRoundCategoryId, number>>;

export interface TriviaCategoryVotingSeat {
  readonly playerId: string;
  readonly name: string;
}

export interface TriviaAudioProblem {
  readonly questionId: string;
  readonly questionAttemptId: number;
  readonly recoveryDeadlineAtMs: number;
}

export interface TriviaResultPlayer {
  readonly playerId: string;
  readonly name: string;
  readonly playerOrder: number;
  readonly rank: number;
  readonly rawScore: number;
  readonly normalizedScore: number;
  readonly correctCount: number;
  readonly bestStreak: number;
  readonly cumulativeCorrectTimeMs: number;
}

export interface TriviaResult {
  readonly resultId: string;
  readonly generation: number;
  readonly category: TriviaRoundCategoryId;
  readonly contentRevision: string;
  readonly players: readonly TriviaResultPlayer[];
  readonly completedAtMs: number;
}

interface TriviaStateBase {
  readonly roomCode: string;
  readonly phase: TriviaPhase;
  readonly expectedPlayerCount: 1 | 2 | 3 | 4;
  readonly hasExpectedPlayers: boolean;
  readonly automaticSetup: boolean;
  readonly preferredLocale: SupportedLocale;
  readonly category: TriviaRoundCategoryId | null;
  readonly categoryVoteCounts: TriviaCategoryVoteCounts;
  readonly categoryVotingSeat: TriviaCategoryVotingSeat | null;
  readonly players: readonly TriviaPublicPlayer[];
  readonly serverNowMs: number;
  readonly loadingGeneration: number;
  readonly displayReady: boolean;
  readonly questionIndex: number | null;
  readonly questionAttemptId: number | null;
  /** Changes when an acknowledged question or cue view must be repainted. */
  readonly renderRevision: number;
  readonly countdownEndsAtMs: number | null;
  readonly questionPromptEndsAtMs: number | null;
  readonly answerCueEndsAtMs: number | null;
  readonly answeringStartsAtMs: number | null;
  readonly questionEndsAtMs: number | null;
  readonly revealEndsAtMs: number | null;
  readonly question: PublicTriviaQuestion | null;
  readonly reveal: PublicTriviaReveal | null;
  readonly standings: readonly TriviaPublicStanding[] | null;
  readonly result: TriviaResult | null;
  readonly audioProblem: TriviaAudioProblem | null;
}

export interface TriviaHiddenState extends TriviaStateBase {
  readonly phase: 'lobby' | 'category_select' | 'loading' | 'countdown' | 'audio_expired' | 'results';
  readonly question: null;
  readonly reveal: null;
}

export interface TriviaQuestionState extends TriviaStateBase {
  readonly phase: 'question';
  readonly question: PublicTriviaQuestion;
  readonly reveal: null;
}

export interface TriviaQuestionPromptState extends TriviaStateBase {
  readonly phase: 'question_prompt';
  readonly question: PublicTriviaQuestion;
  readonly reveal: null;
}

export interface TriviaAnswerCueState extends TriviaStateBase {
  readonly phase: 'answer_cue';
  readonly question: PublicTriviaQuestion;
  readonly reveal: null;
}

export interface TriviaAudioProblemState extends TriviaStateBase {
  readonly phase: 'audio_problem';
  readonly question: PublicTriviaQuestion;
  readonly reveal: null;
  readonly audioProblem: TriviaAudioProblem;
}

export interface TriviaRevealState extends TriviaStateBase {
  readonly phase: 'reveal';
  readonly question: PublicTriviaQuestion;
  readonly reveal: PublicTriviaReveal;
}

/** Browser-safe state. It can never represent an answer key during an active question. */
export type TriviaState = TriviaHiddenState | TriviaQuestionPromptState | TriviaAnswerCueState | TriviaAudioProblemState
  | TriviaQuestionState | TriviaRevealState;

export type TriviaEvent =
  | { readonly type: 'player_joined'; readonly playerId: string; readonly name: string; readonly playerOrder: number; readonly atMs: number }
  | { readonly type: 'player_left'; readonly playerId: string; readonly atMs: number }
  | { readonly type: 'countdown'; readonly count: 3 | 2 | 1; readonly atMs: number }
  | { readonly type: 'question_started'; readonly questionId: string; readonly questionAttemptId: number; readonly questionIndex: number; readonly promptDeadlineAtMs: number }
  | { readonly type: 'answer_cue_started'; readonly questionId: string; readonly questionAttemptId: number; readonly endsAtMs: number }
  | { readonly type: 'answering_started'; readonly questionId: string; readonly questionAttemptId: number; readonly startsAtMs: number; readonly endsAtMs: number }
  | { readonly type: 'answer_result'; readonly questionAttemptId: number; readonly playerId: string; readonly correct: boolean; readonly points: number; readonly rawScore: number }
  | { readonly type: 'question_revealed'; readonly questionId: string; readonly questionAttemptId: number; readonly atMs: number }
  | { readonly type: 'audio_problem'; readonly questionId: string; readonly questionAttemptId: number; readonly recoveryDeadlineAtMs: number; readonly atMs: number }
  | { readonly type: 'audio_recovery_expired'; readonly questionId: string; readonly questionAttemptId: number; readonly atMs: number }
  | { readonly type: 'round_finished'; readonly standings: readonly TriviaPublicStanding[]; readonly result: TriviaResult; readonly atMs: number }
  | { readonly type: 'loading_timeout'; readonly loadingGeneration: number; readonly displayReady: boolean; readonly atMs: number };

/** Browser commands. Generic answers and all scoring remain outside this union. */
export type TriviaClientMessage =
  | { type: 'join'; roomCode: string; name: string; sessionId?: string; locale?: SupportedLocale }
  | { type: 'spectate'; roomCode: string; locale?: SupportedLocale }
  | { type: 'display_auth'; roomCode: string; token: string }
  | { type: 'clock_sync'; clientSentAtMs: number }
  | { type: 'select_category'; category: TriviaRoundCategoryId }
  | { type: 'display_select_category'; playerId: string; category: TriviaRoundCategoryId }
  | { type: 'view_rendered'; questionId: string; questionAttemptId: number; phase: 'question_prompt' | 'answer_cue'; renderRevision: number }
  | { type: 'keyboard_answer'; choiceId: string }
  | { type: 'advance' }
  | { type: 'ready'; loadingGeneration: number }
  | { type: 'retry_loading'; loadingGeneration: number }
  | { type: 'leave'; sessionId?: string };

export type TriviaErrorMessage = { type: 'error'; code: string; message: string };

export type TriviaServerMessage =
  | { type: 'trivia_capabilities'; displayAuth: boolean }
  | { type: 'clock_sync'; clientSentAtMs: number; serverNowMs: number }
  | { type: 'joined'; playerId: string; roomCode: string }
  | { type: 'host_identity'; roomCode: string; isHost: boolean; loadingGeneration: number }
  | ({ type: 'trivia_state' } & TriviaState)
  | { type: 'trivia_events'; events: readonly TriviaEvent[] }
  | TriviaErrorMessage;

export interface TriviaAuthoritativePlayer extends Omit<TriviaPublicPlayer, 'answered' | 'nameConfirmed'> {
  readonly nameConfirmed?: boolean;
  /** Internal recognition state, intentionally absent from TriviaPublicPlayer. */
  readonly submittedChoiceId?: string | null;
  readonly cumulativeCorrectTimeMs: number;
  readonly normalizedScore?: number;
  readonly rank?: number;
}

/** Input used by the server to create a phase-aware browser projection. */
export interface TriviaAuthoritativeState {
  readonly roomCode: string;
  readonly phase: TriviaPhase;
  readonly expectedPlayerCount: number;
  readonly automaticSetup: boolean;
  readonly preferredLocale: SupportedLocale;
  readonly category: TriviaRoundCategoryId | null;
  readonly categoryVoteCounts?: TriviaCategoryVoteCounts;
  readonly categoryVotingSeat?: TriviaCategoryVotingSeat | null;
  readonly players: readonly TriviaAuthoritativePlayer[];
  readonly serverNowMs: number;
  readonly loadingGeneration: number;
  readonly displayReady: boolean;
  readonly questionIndex: number | null;
  readonly questionAttemptId?: number | null;
  readonly renderRevision?: number;
  readonly countdownEndsAtMs: number | null;
  readonly questionPromptEndsAtMs?: number | null;
  readonly answerCueEndsAtMs?: number | null;
  readonly answeringStartsAtMs?: number | null;
  readonly questionEndsAtMs: number | null;
  readonly revealEndsAtMs?: number | null;
  readonly currentQuestion: TriviaRoundQuestion | null;
  readonly result?: TriviaResult | null;
  readonly audioProblem?: TriviaAudioProblem | null;
}

/**
 * Removes submitted choices and only discloses the answer/explanation in the reveal phase.
 * Future questions are never accepted by this projection, so they cannot accidentally cross the wire.
 */
export function projectTriviaState(state: TriviaAuthoritativeState, locale: SupportedLocale): TriviaState {
  if (!isSupportedLocale(locale)) throw new Error('unsupported trivia locale');
  if (!Number.isInteger(state.expectedPlayerCount)
    || state.expectedPlayerCount < TRIVIA_MIN_PLAYERS || state.expectedPlayerCount > TRIVIA_MAX_PLAYERS) {
    throw new Error('expectedPlayerCount must be from 1 to 4');
  }
  if ((state.phase === 'question_prompt' || state.phase === 'answer_cue' || state.phase === 'audio_problem'
    || state.phase === 'question' || state.phase === 'reveal')
    && !state.currentQuestion) {
    throw new Error(`${state.phase} requires a current question`);
  }

  const players = Object.freeze(state.players.map(player => Object.freeze({
    playerId: player.playerId,
    name: player.name,
    nameConfirmed: player.nameConfirmed ?? true,
    playerOrder: player.playerOrder,
    connected: player.connected,
    answered: (state.phase === 'answer_cue' || state.phase === 'question' || state.phase === 'reveal')
      && player.submittedChoiceId != null,
    rawScore: player.rawScore,
    correctCount: player.correctCount,
    bestStreak: player.bestStreak,
  })));
  const standings = state.phase === 'reveal' || state.phase === 'results'
    ? Object.freeze(state.players.slice().sort((a, b) => b.rawScore - a.rawScore
      || b.correctCount - a.correctCount
      || a.cumulativeCorrectTimeMs - b.cumulativeCorrectTimeMs
      || a.playerOrder - b.playerOrder)
      .map((player, index) => Object.freeze({
        playerId: player.playerId,
        name: player.name,
        nameConfirmed: player.nameConfirmed ?? true,
        playerOrder: player.playerOrder,
        connected: player.connected,
        answered: (state.phase === 'answer_cue' || state.phase === 'question' || state.phase === 'reveal')
          && player.submittedChoiceId != null,
        rawScore: player.rawScore,
        correctCount: player.correctCount,
        bestStreak: player.bestStreak,
        rank: player.rank ?? index + 1,
        normalizedScore: player.normalizedScore ?? normalizeTriviaScore(player.rawScore),
        cumulativeCorrectTimeMs: player.cumulativeCorrectTimeMs,
      })))
    : null;
  const visibleQuestion = state.phase === 'question_prompt' || state.phase === 'answer_cue' || state.phase === 'audio_problem'
    || state.phase === 'question' || state.phase === 'reveal'
    ? projectPublicTriviaQuestion(state.currentQuestion!.question, locale, state.currentQuestion!.choiceOrder)
    : null;
  const reveal = state.phase === 'reveal'
    ? projectPublicTriviaReveal(state.currentQuestion!.question, locale)
    : null;
  const base = {
    roomCode: state.roomCode,
    phase: state.phase,
    expectedPlayerCount: state.expectedPlayerCount as 1 | 2 | 3 | 4,
    hasExpectedPlayers: state.players.length === state.expectedPlayerCount,
    automaticSetup: state.automaticSetup,
    preferredLocale: state.preferredLocale,
    category: state.category,
    categoryVoteCounts: state.categoryVoteCounts ?? emptyCategoryVoteCounts(),
    categoryVotingSeat: state.categoryVotingSeat ?? null,
    players,
    serverNowMs: state.serverNowMs,
    loadingGeneration: state.loadingGeneration,
    displayReady: state.displayReady,
    questionIndex: state.questionIndex,
    questionAttemptId: state.questionAttemptId ?? null,
    renderRevision: state.renderRevision ?? 0,
    countdownEndsAtMs: state.countdownEndsAtMs,
    questionPromptEndsAtMs: state.questionPromptEndsAtMs ?? null,
    answerCueEndsAtMs: state.answerCueEndsAtMs ?? null,
    answeringStartsAtMs: state.answeringStartsAtMs ?? null,
    questionEndsAtMs: state.questionEndsAtMs,
    revealEndsAtMs: state.revealEndsAtMs ?? null,
    standings,
    result: state.result ?? null,
    audioProblem: state.audioProblem ?? null,
  };
  if (state.phase === 'question_prompt') {
    return Object.freeze({ ...base, phase: 'question_prompt', question: visibleQuestion!, reveal: null });
  }
  if (state.phase === 'answer_cue') {
    return Object.freeze({ ...base, phase: 'answer_cue', question: visibleQuestion!, reveal: null });
  }
  if (state.phase === 'audio_problem') {
    return Object.freeze({ ...base, phase: 'audio_problem', question: visibleQuestion!, reveal: null,
      audioProblem: state.audioProblem! });
  }
  if (state.phase === 'question') return Object.freeze({ ...base, phase: 'question', question: visibleQuestion!, reveal: null });
  if (state.phase === 'reveal') return Object.freeze({ ...base, phase: 'reveal', question: visibleQuestion!, reveal: reveal! });
  return Object.freeze({ ...base, phase: state.phase, question: null, reveal: null });
}

function emptyCategoryVoteCounts(): TriviaCategoryVoteCounts {
  return Object.freeze(Object.fromEntries(
    [...TRIVIA_CATEGORY_IDS, 'mixed'].map(category => [category, 0]),
  ) as unknown as Record<TriviaRoundCategoryId, number>);
}

/** Strict parser for untrusted browser frames. There is deliberately no generic answer or score case. */
export function parseTriviaClientMessage(raw: string): TriviaClientMessage | TriviaErrorMessage {
  if (typeof raw !== 'string' || raw.length > TRIVIA_PROTOCOL_MAX_JSON_LENGTH) {
    return error('bad_json', 'message is too large');
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return error('bad_json', 'invalid JSON'); }
  if (!isRecord(value)) return error('bad_message', 'message must be an object');

  switch (value.type) {
    case 'join': {
      if (!hasOnlyKeys(value, ['type', 'roomCode', 'name', 'sessionId', 'locale'])) return badFields('bad_join');
      const roomCode = room(value.roomCode);
      const name = boundedText(value.name, 40);
      if (!roomCode || !name) return error('bad_join', 'valid roomCode + name required');
      const sessionId = value.sessionId === undefined ? undefined : opaque(value.sessionId, 128);
      if (value.sessionId !== undefined && !sessionId) return error('bad_join', 'invalid sessionId');
      if (value.locale !== undefined && !isSupportedLocale(value.locale)) return error('bad_join', 'invalid locale');
      return {
        type: 'join', roomCode, name,
        ...(sessionId ? { sessionId } : {}),
        ...(isSupportedLocale(value.locale) ? { locale: value.locale } : {}),
      };
    }
    case 'spectate': {
      if (!hasOnlyKeys(value, ['type', 'roomCode', 'locale'])) return badFields('bad_spectate');
      const roomCode = room(value.roomCode);
      if (!roomCode) return error('bad_spectate', 'valid roomCode required');
      if (value.locale !== undefined && !isSupportedLocale(value.locale)) return error('bad_spectate', 'invalid locale');
      return { type: 'spectate', roomCode, ...(isSupportedLocale(value.locale) ? { locale: value.locale } : {}) };
    }
    case 'display_auth': {
      if (!hasOnlyKeys(value, ['type', 'roomCode', 'token'])) return badFields('bad_display_auth');
      const roomCode = room(value.roomCode);
      const token = opaque(value.token, 256);
      if (!roomCode || !token) return error('bad_display_auth', 'valid roomCode + token required');
      return { type: 'display_auth', roomCode, token };
    }
    case 'clock_sync':
      if (!hasOnlyKeys(value, ['type', 'clientSentAtMs']) || !nonNegativeSafeInteger(value.clientSentAtMs)) {
        return error('bad_clock_sync', 'clientSentAtMs must be a non-negative safe integer');
      }
      return { type: 'clock_sync', clientSentAtMs: value.clientSentAtMs };
    case 'select_category':
      if (!hasOnlyKeys(value, ['type', 'category'])
        || !TRIVIA_ROUND_CATEGORY_IDS.includes(value.category as TriviaRoundCategoryId)) {
        return error('bad_select_category', 'valid category required');
      }
      return { type: 'select_category', category: value.category as TriviaRoundCategoryId };
    case 'display_select_category': {
      const playerId = opaque(value.playerId, 32);
      if (!hasOnlyKeys(value, ['type', 'playerId', 'category']) || !playerId
        || !TRIVIA_ROUND_CATEGORY_IDS.includes(value.category as TriviaRoundCategoryId)) {
        return error('bad_select_category', 'valid voting seat and category required');
      }
      return { type: 'display_select_category', playerId, category: value.category as TriviaRoundCategoryId };
    }
    case 'view_rendered': {
      const questionId = opaque(value.questionId, 128);
      if (!hasOnlyKeys(value, ['type', 'questionId', 'questionAttemptId', 'phase', 'renderRevision'])
        || !questionId || !nonNegativeSafeInteger(value.questionAttemptId) || value.questionAttemptId < 1
        || (value.phase !== 'question_prompt' && value.phase !== 'answer_cue')
        || !nonNegativeSafeInteger(value.renderRevision) || value.renderRevision < 1) {
        return error('bad_view_rendered', 'valid current question paint required');
      }
      return { type: 'view_rendered', questionId, questionAttemptId: value.questionAttemptId,
        phase: value.phase, renderRevision: value.renderRevision };
    }
    case 'keyboard_answer':
      if (!hasOnlyKeys(value, ['type', 'choiceId'])
        || !TRIVIA_CHOICE_IDS.includes(value.choiceId as typeof TRIVIA_CHOICE_IDS[number])) {
        return error('bad_keyboard_answer', 'valid choiceId required');
      }
      return { type: 'keyboard_answer', choiceId: value.choiceId as string };
    case 'advance':
      return hasOnlyKeys(value, ['type']) ? { type: 'advance' } : badFields('bad_advance');
    case 'ready':
    case 'retry_loading':
      if (!hasOnlyKeys(value, ['type', 'loadingGeneration'])
        || !nonNegativeSafeInteger(value.loadingGeneration) || value.loadingGeneration < 1) {
        return error('bad_ready', 'loadingGeneration must be a positive safe integer');
      }
      return { type: value.type, loadingGeneration: value.loadingGeneration };
    case 'leave': {
      if (!hasOnlyKeys(value, ['type', 'sessionId'])) return badFields('bad_leave');
      const sessionId = value.sessionId === undefined ? undefined : opaque(value.sessionId, 128);
      if (value.sessionId !== undefined && !sessionId) return error('bad_leave', 'invalid sessionId');
      return { type: 'leave', ...(sessionId ? { sessionId } : {}) };
    }
    default:
      return error('unknown_type', `unknown type ${String(value.type)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function boundedText(value: unknown, maxCharacters: number): string | null {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) return null;
  const normalized = value.normalize('NFC').trim();
  return normalized && Array.from(normalized).length <= maxCharacters ? normalized : null;
}

function room(value: unknown): string | null {
  const normalized = boundedText(value, 16);
  return normalized && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(normalized) ? normalized : null;
}

function opaque(value: unknown, maxCharacters: number): string | null {
  const normalized = boundedText(value, maxCharacters);
  return normalized && !/\s/u.test(normalized) ? normalized : null;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function badFields(code: string): TriviaErrorMessage {
  return error(code, 'unsupported message fields');
}

function error(code: string, message: string): TriviaErrorMessage {
  return { type: 'error', code, message };
}
