import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import {
  TRIVIA_ANSWER_WINDOW_MS,
  TRIVIA_MAX_PLAYERS,
  TRIVIA_MIN_PLAYERS,
  TRIVIA_ROUND_CATEGORY_IDS,
  buildTriviaRound,
  rankTriviaPlayers,
  resolveTriviaChoiceId,
  scoreTriviaAnswer,
  triviaSeed,
  type TriviaQuestionBank,
  type TriviaQuestionDefinition,
  type TriviaRoundCategoryId,
  type TriviaRoundQuestion,
} from '../shared/trivia';
import {
  projectTriviaState,
  type TriviaAuthoritativePlayer,
  type TriviaCategoryVoteCounts,
  type TriviaEvent,
  type TriviaPhase,
  type TriviaPublicStanding,
  type TriviaResult,
  type TriviaResultPlayer,
  type TriviaState,
} from '../shared/trivia-protocol';

export const TRIVIA_COUNTDOWN_MS = 3_000;
export const TRIVIA_LOADING_TIMEOUT_MS = 30_000;
/** Maximum wait for question prompt delivery to start before audio recovery is needed. */
export const TRIVIA_QUESTION_PROMPT_TIMEOUT_MS = 60_000;
export const TRIVIA_ANSWER_CUE_TIMEOUT_MS = 25_000;
export const TRIVIA_ANSWER_START_DELAY_MS = 0;
/** The last caller to hear the choices still gets time to answer. */
export const TRIVIA_MIN_POST_CUE_ANSWER_MS = 8_000;
/** Caps late playback and retry extensions for a single question. */
export const TRIVIA_MAX_QUESTION_WINDOW_MS = 135_000;
const TRIVIA_CUE_ESTIMATE_BUFFER_MS = 2_000;
const TRIVIA_CUE_DELIVERY_BUFFER_MS = 7_000;
const TRIVIA_MAX_ESTIMATED_CUE_MS = 120_000;
export const TRIVIA_FINAL_ANSWER_GRACE_MS = 1_500;
/** A received spoken final can hold only its own question while semantic intent resolves. */
export const TRIVIA_SEMANTIC_ANSWER_MAX_MS = 3_000;
export const TRIVIA_REVEAL_MS = 4_000;
/** Reveal audio may outlast the visual minimum, but must never stall a round indefinitely. */
export const TRIVIA_REVEAL_MAX_MS = 18_000;
export const TRIVIA_AUDIO_RECOVERY_MS = 120_000;

export interface TriviaRoomOptions {
  bank: TriviaQuestionBank | readonly TriviaQuestionDefinition[];
  now?: () => number;
  seed?: string | number;
  preferredLocale?: SupportedLocale;
  contentRevision?: string;
  countdownMs?: number;
  loadingTimeoutMs?: number;
  questionPromptTimeoutMs?: number;
  answerCueTimeoutMs?: number;
  finalAnswerGraceMs?: number;
  revealMs?: number;
}

export interface TriviaRosterPolicy {
  readonly stationFixed?: boolean;
  readonly allowReplay?: boolean;
}

interface RoomPlayer extends TriviaAuthoritativePlayer {
  name: string;
  nameConfirmed: boolean;
  connected: boolean;
  categoryVote: TriviaRoundCategoryId | null;
  rawScore: number;
  correctCount: number;
  bestStreak: number;
  currentStreak: number;
  cumulativeCorrectTimeMs: number;
  submittedChoiceId: string | null;
  submittedElapsedMs: number | null;
  submittedCorrect: boolean | null;
  submittedPoints: number;
  earlyChoiceId: string | null;
  rank?: number;
  normalizedScore?: number;
}

export class TriviaRoom {
  phase: TriviaPhase = 'lobby';
  private readonly players: RoomPlayer[] = [];
  private nextPlayer = 1;
  private nextPlayerOrder = 0;
  private expectedPlayerCountValue: 1 | 2 | 3 | 4 = 1;
  private automaticSetupValue = false;
  private stationFixedValue = false;
  private allowReplayValue = true;
  private rosterFrozen = false;
  private locale: SupportedLocale;
  private readonly questions: TriviaQuestionBank | readonly TriviaQuestionDefinition[];
  private readonly now: () => number;
  private readonly seed: string | number;
  private readonly contentRevision: string;
  private readonly countdownMs: number;
  private readonly loadingTimeoutMs: number;
  private readonly questionPromptTimeoutMs: number;
  private readonly answerCueTimeoutMs: number;
  private readonly answerCueTimeoutCustomized: boolean;
  private readonly finalAnswerGraceMs: number;
  private readonly revealMs: number;
  private categoryValue: TriviaRoundCategoryId | null = null;
  private round: readonly TriviaRoundQuestion[] = [];
  private loadingGenerationValue = 0;
  private displayReadyValue = false;
  private loadingDeadlineAt: number | null = null;
  private countdownEndsAt: number | null = null;
  private countdownValue: 1 | 2 | 3 | null = null;
  private questionIndexValue: number | null = null;
  private questionAttemptIdValue = 0;
  private questionPromptEndsAt: number | null = null;
  private answerCueEndsAt: number | null = null;
  private answeringStartsAt: number | null = null;
  private questionEndsAt: number | null = null;
  private finalAnswerDeadlineAt: number | null = null;
  private nextSemanticResolutionId = 1;
  private readonly semanticAnswerResolutions = new Map<string, {
    id: number;
    questionId: string;
    questionAttemptId: number;
    expiresAtMs: number;
    lateOnset?: { choiceId?: string; atMs: number };
  }>();
  private revealEndsAt: number | null = null;
  private revealHardEndsAt: number | null = null;
  private readonly revealDeliveries = new Map<string, number>();
  private readonly revealReadyPlayerIds = new Set<string>();
  private readonly promptReadyPlayerIds = new Set<string>();
  private readonly answerCueReadyPlayerIds = new Set<string>();
  private nextDeliveryGeneration = 1;
  private readonly promptDeliveries = new Map<string, { generation: number; deadlineAtMs: number }>();
  private readonly cueDeliveries = new Map<string, { generation: number; deadlineAtMs: number }>();
  private audioProblemValue: { questionId: string; questionAttemptId: number; recoveryDeadlineAtMs: number } | null = null;
  private resultValue: TriviaResult | null = null;
  private events: TriviaEvent[] = [];

  constructor(readonly code: string, options: TriviaRoomOptions) {
    if (!options?.bank) throw new TypeError('a parsed trivia question bank is required');
    this.questions = options.bank;
    this.now = options.now ?? Date.now;
    this.seed = options.seed ?? code;
    this.locale = options.preferredLocale ?? DEFAULT_LOCALE;
    this.contentRevision = cleanRevision(options.contentRevision
      ?? String('version' in options.bank ? options.bank.version : 1));
    this.countdownMs = positiveDuration(options.countdownMs ?? TRIVIA_COUNTDOWN_MS, 'countdownMs');
    this.loadingTimeoutMs = positiveDuration(options.loadingTimeoutMs ?? TRIVIA_LOADING_TIMEOUT_MS, 'loadingTimeoutMs');
    this.questionPromptTimeoutMs = boundedPromptDuration(
      options.questionPromptTimeoutMs ?? TRIVIA_QUESTION_PROMPT_TIMEOUT_MS,
    );
    this.answerCueTimeoutMs = boundedCueDuration(options.answerCueTimeoutMs ?? TRIVIA_ANSWER_CUE_TIMEOUT_MS);
    this.answerCueTimeoutCustomized = options.answerCueTimeoutMs !== undefined;
    this.finalAnswerGraceMs = nonNegativeDuration(
      options.finalAnswerGraceMs ?? TRIVIA_FINAL_ANSWER_GRACE_MS,
      'finalAnswerGraceMs',
    );
    this.revealMs = positiveDuration(options.revealMs ?? TRIVIA_REVEAL_MS, 'revealMs');
  }

  addPlayer(name: string, nameConfirmed = true, assignedPlayerOrder?: number): { playerId: string } | { error: string } {
    if (this.rosterFrozen || this.phase !== 'lobby') return { error: 'round_in_progress' };
    if (assignedPlayerOrder !== undefined
      && (!Number.isSafeInteger(assignedPlayerOrder) || assignedPlayerOrder < 0 || assignedPlayerOrder >= TRIVIA_MAX_PLAYERS)) {
      return { error: 'invalid_player_order' };
    }
    if (assignedPlayerOrder !== undefined && this.stationFixedValue
      && (assignedPlayerOrder >= this.expectedPlayerCountValue || !this.hasValidStationPlayerOrder())) {
      return { error: 'invalid_player_order' };
    }
    if (assignedPlayerOrder !== undefined
      && this.players.some(player => player.playerOrder === assignedPlayerOrder)) {
      return { error: 'player_order_taken' };
    }
    if (this.players.length >= TRIVIA_MAX_PLAYERS
      || (this.automaticSetupValue && this.players.length >= this.expectedPlayerCountValue)) {
      return { error: 'room_full' };
    }
    const playerId = `t${this.nextPlayer++}`;
    let playerOrder = assignedPlayerOrder ?? this.nextPlayerOrder;
    if (assignedPlayerOrder === undefined) {
      while (this.players.some(player => player.playerOrder === playerOrder)) playerOrder += 1;
      this.nextPlayerOrder = playerOrder + 1;
    }
    const player: RoomPlayer = {
      playerId,
      name: cleanName(name),
      nameConfirmed,
      playerOrder,
      connected: true,
      categoryVote: null,
      rawScore: 0,
      correctCount: 0,
      bestStreak: 0,
      currentStreak: 0,
      cumulativeCorrectTimeMs: 0,
      submittedChoiceId: null,
      submittedElapsedMs: null,
      submittedCorrect: null,
      submittedPoints: 0,
      earlyChoiceId: null,
    };
    this.players.push(player);
    this.players.sort((a, b) => a.playerOrder - b.playerOrder);
    if (!this.automaticSetupValue) this.expectedPlayerCountValue = this.players.length as 1 | 2 | 3 | 4;
    this.events.push({ type: 'player_joined', playerId, name: player.name, playerOrder, atMs: this.now() });
    return { playerId };
  }

  /** Permanently removes a participant. Temporary transport loss uses setPlayerConnected instead. */
  permanentlyRemovePlayer(playerId: string): boolean {
    const index = this.players.findIndex(player => player.playerId === playerId);
    if (index < 0) return false;
    if (this.stationFixedValue && this.phase === 'results' && this.resultValue) return false;
    if (this.stationFixedValue && (this.phase === 'question_prompt' || this.phase === 'answer_cue')) {
      this.pauseAudio(this.currentQuestion()?.question.id ?? '', this.questionAttemptIdValue);
    }
    this.players.splice(index, 1);
    this.semanticAnswerResolutions.delete(playerId);
    this.promptReadyPlayerIds.delete(playerId);
    this.answerCueReadyPlayerIds.delete(playerId);
    this.promptDeliveries.delete(playerId);
    this.cueDeliveries.delete(playerId);
    this.revealDeliveries.delete(playerId);
    this.revealReadyPlayerIds.delete(playerId);
    this.events.push({ type: 'player_left', playerId, atMs: this.now() });
    if (!this.players.length) {
      const stationPregame = this.stationFixedValue
        && (this.phase === 'lobby' || this.phase === 'category_select' || this.phase === 'loading');
      if (!stationPregame) this.resetEmptyRoom();
      return true;
    }
    if (!this.stationFixedValue) this.expectedPlayerCountValue = this.players.length as 1 | 2 | 3 | 4;
    if (this.phase === 'question_prompt') this.maybeStartAnswerCue(this.now());
    else if (this.phase === 'answer_cue') this.maybeStartAnswering(this.now());
    else if (this.phase === 'question'
      && this.players.every(player => player.submittedChoiceId !== null)) this.revealQuestion(this.now());
    return true;
  }

  /** Reconciles authoritative station participants without ever rewriting an active round roster. */
  reconcilePregameRoster(
    expectedPlayerCount: number,
    activePlayerIds: readonly string[],
    participantSlots: readonly (string | null)[],
  ): boolean {
    if (!Number.isSafeInteger(expectedPlayerCount)
      || expectedPlayerCount < TRIVIA_MIN_PLAYERS || expectedPlayerCount > TRIVIA_MAX_PLAYERS
      || !['lobby', 'category_select', 'loading'].includes(this.phase)) return false;
    if (participantSlots.length !== expectedPlayerCount
      || activePlayerIds.length > expectedPlayerCount
      || new Set(activePlayerIds).size !== activePlayerIds.length) return false;
    const slottedPlayerIds = participantSlots.filter((playerId): playerId is string => playerId !== null);
    const activePlayers = new Set(activePlayerIds);
    if (new Set(slottedPlayerIds).size !== slottedPlayerIds.length
      || slottedPlayerIds.length !== activePlayers.size
      || slottedPlayerIds.some(playerId => !activePlayers.has(playerId))) return false;
    const playersById = new Map(this.players.map(player => [player.playerId, player]));
    if (slottedPlayerIds.some(playerId => !playersById.has(playerId))) return false;
    const retained = new Set(slottedPlayerIds);

    const removed = this.players.filter(player => !retained.has(player.playerId));
    for (const player of removed) {
      this.events.push({ type: 'player_left', playerId: player.playerId, atMs: this.now() });
    }
    const orderedPlayers = participantSlots.flatMap((playerId, playerOrder): RoomPlayer[] => (
      playerId === null ? [] : [{ ...playersById.get(playerId)!, playerOrder }]
    ));
    this.players.splice(0, this.players.length, ...orderedPlayers);
    if (this.phase === 'loading') this.loadingGenerationValue += 1;
    this.phase = 'lobby';
    this.expectedPlayerCountValue = expectedPlayerCount as 1 | 2 | 3 | 4;
    this.automaticSetupValue = true;
    this.stationFixedValue = true;
    this.allowReplayValue = false;
    this.rosterFrozen = false;
    this.categoryValue = null;
    this.round = [];
    this.displayReadyValue = false;
    this.loadingDeadlineAt = null;
    this.countdownEndsAt = null;
    this.countdownValue = null;
    this.questionIndexValue = null;
    this.audioProblemValue = null;
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.revealEndsAt = null;
    this.revealHardEndsAt = null;
    this.promptReadyPlayerIds.clear();
    this.answerCueReadyPlayerIds.clear();
    this.promptDeliveries.clear();
    this.cueDeliveries.clear();
    this.revealDeliveries.clear();
    this.revealReadyPlayerIds.clear();
    this.resultValue = null;
    this.resetPlayersForRound();
    return true;
  }

  setPlayerConnected(playerId: string, connected: boolean): boolean {
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player || player.connected === connected) return false;
    player.connected = connected;
    return true;
  }

  /** A completed standalone display keeps its result until a fresh call starts another session. */
  prepareForNewCaller(): boolean {
    if (this.phase !== 'results' || this.stationFixedValue || this.players.some(player => player.connected)) {
      return false;
    }
    this.players.length = 0;
    this.nextPlayerOrder = 0;
    this.resetEmptyRoom();
    return true;
  }

  setName(playerId: string, name: string): boolean {
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player) return false;
    player.name = cleanName(name);
    player.nameConfirmed = true;
    if (this.resultValue) {
      const resultPlayers = this.resultValue.players.map(resultPlayer => resultPlayer.playerId === playerId
        ? Object.freeze({ ...resultPlayer, name: player.name })
        : resultPlayer);
      this.resultValue = Object.freeze({ ...this.resultValue, players: Object.freeze(resultPlayers) });
    }
    return true;
  }

  hasConfirmedName(playerId: string): boolean {
    return this.players.some(player => player.playerId === playerId && player.nameConfirmed);
  }

  expectHumanPlayers(count: number, automaticSetup = true, policy: TriviaRosterPolicy = {}): boolean {
    if (!Number.isSafeInteger(count) || count < TRIVIA_MIN_PLAYERS || count > TRIVIA_MAX_PLAYERS) return false;
    if (this.rosterFrozen && this.phase !== 'results') return count === this.expectedPlayerCountValue;
    this.expectedPlayerCountValue = count as 1 | 2 | 3 | 4;
    this.automaticSetupValue = automaticSetup;
    this.stationFixedValue = policy.stationFixed ?? false;
    this.allowReplayValue = policy.allowReplay ?? !this.stationFixedValue;
    return true;
  }

  setRosterPolicy(policy: TriviaRosterPolicy): boolean {
    if (this.rosterFrozen || this.phase !== 'lobby') return false;
    this.stationFixedValue = policy.stationFixed ?? this.stationFixedValue;
    this.allowReplayValue = policy.allowReplay ?? !this.stationFixedValue;
    return true;
  }

  setPreferredLocale(locale: SupportedLocale): boolean {
    if (this.rosterFrozen || this.phase !== 'lobby') return false;
    this.locale = locale;
    return true;
  }

  voteCategory(playerId: string, category: TriviaRoundCategoryId): boolean {
    if (this.phase !== 'category_select' || !TRIVIA_ROUND_CATEGORY_IDS.includes(category)) return false;
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player) return false;
    player.categoryVote = category;
    return true;
  }

  /** A shared display may cast only the currently named unvoted seat's vote. */
  voteCategoryFromDisplay(playerId: string, category: TriviaRoundCategoryId): boolean {
    if (this.categoryVotingSeat()?.playerId !== playerId) return false;
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player || player.categoryVote !== null) return false;
    return this.voteCategory(playerId, category);
  }

  advance(playerId?: string): boolean {
    this.tick();
    if (this.phase !== 'results' && this.automaticSetupValue && (!playerId || !this.hasPlayer(playerId))) return false;
    if (this.phase === 'lobby' && this.canFreezeRoster()) {
      this.rosterFrozen = true;
      this.phase = 'category_select';
      this.categoryValue = null;
      this.resultValue = null;
      return true;
    }
    if (this.phase === 'category_select' && this.canFreezeRoster()) {
      this.beginLoading();
      return true;
    }
    if (this.phase === 'results' && this.allowReplayValue && playerId && this.hasPlayer(playerId)) {
      this.resetPlayersForRound();
      this.phase = 'category_select';
      this.categoryValue = null;
      this.resultValue = null;
      return true;
    }
    return false;
  }

  ready(generation: number): boolean {
    if (this.phase !== 'loading' || generation !== this.loadingGenerationValue || !this.round.length) return false;
    if (this.displayReadyValue) return true;
    this.displayReadyValue = true;
    this.startCountdown(this.now());
    return true;
  }

  retryLoading(generation: number): boolean {
    if (this.phase !== 'loading' || generation !== this.loadingGenerationValue) return false;
    this.loadingGenerationValue += 1;
    this.displayReadyValue = false;
    this.loadingDeadlineAt = this.now() + this.loadingTimeoutMs;
    return true;
  }

  invalidateDisplayReady(): boolean {
    if (this.phase !== 'loading') return false;
    this.loadingGenerationValue += 1;
    this.displayReadyValue = false;
    this.loadingDeadlineAt = this.now() + this.loadingTimeoutMs;
    return true;
  }

  beginPromptDelivery(playerId: string, questionId: string, questionAttemptId: number,
    estimatedSpeechMs = 0): number | null {
    if (!this.canDeliver(playerId, questionId, questionAttemptId, 'question_prompt')
      || this.promptReadyPlayerIds.has(playerId)) return null;
    const generation = this.nextDeliveryGeneration++;
    this.promptDeliveries.set(playerId, {
      generation,
      deadlineAtMs: this.now() + Math.max(20_000, Math.min(90_000, estimatedSpeechMs + 10_000)),
    });
    return generation;
  }

  beginAnswerCueDelivery(playerId: string, questionId: string, questionAttemptId: number): number | null {
    if (!this.canDeliver(playerId, questionId, questionAttemptId, 'answer_cue')
      || this.answerCueReadyPlayerIds.has(playerId)) return null;
    const now = this.now();
    const startedAtMs = this.answeringStartsAt;
    const current = this.currentQuestion();
    if (startedAtMs === null || !current) return null;
    const latestCueAt = startedAtMs + TRIVIA_MAX_QUESTION_WINDOW_MS - TRIVIA_MIN_POST_CUE_ANSWER_MS;
    if (now > latestCueAt) return null;
    const estimatedCueMs = estimateAnswerCueMs(current, this.locale);
    const deadlineAtMs = Math.min(latestCueAt, this.answerCueTimeoutCustomized
      ? now + Math.max(20_000, this.answerCueTimeoutMs)
      : Math.max(now + this.answerCueTimeoutMs,
        startedAtMs + estimatedCueMs + TRIVIA_CUE_DELIVERY_BUFFER_MS,
        (this.questionEndsAt ?? startedAtMs) + TRIVIA_CUE_ESTIMATE_BUFFER_MS));
    const generation = this.nextDeliveryGeneration++;
    this.cueDeliveries.set(playerId, { generation, deadlineAtMs });
    return generation;
  }

  /** Trusted phone-prompt seam. Only a current delivery's completed playback can ready it. */
  questionPromptReady(playerId: string, questionId: string, questionAttemptId: number,
    deliveryGeneration: number): boolean {
    const current = this.currentQuestion();
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (this.phase !== 'question_prompt' || current?.question.id !== questionId || !player?.connected
      || this.questionAttemptIdValue !== questionAttemptId
      || this.promptDeliveries.get(playerId)?.generation !== deliveryGeneration) return false;
    this.promptDeliveries.delete(playerId);
    this.promptReadyPlayerIds.add(playerId);
    this.maybeStartAnswerCue(this.now());
    return true;
  }

  questionPromptSkipped(playerId: string, questionId: string, questionAttemptId: number): boolean {
    if (!this.canDeliver(playerId, questionId, questionAttemptId, 'question_prompt')) return false;
    this.promptDeliveries.delete(playerId);
    this.promptReadyPlayerIds.add(playerId);
    this.maybeStartAnswerCue(this.now());
    return true;
  }

  /** Trusted answer-cue seam. Readiness is scoped to this playback attempt. */
  questionAnswerCueReady(playerId: string, questionId: string, questionAttemptId: number,
    deliveryGeneration: number): boolean {
    const current = this.currentQuestion();
    const player = this.players.find(candidate => candidate.playerId === playerId);
    const delivery = this.cueDeliveries.get(playerId);
    if (this.phase !== 'answer_cue' || current?.question.id !== questionId || !player?.connected
      || this.questionAttemptIdValue !== questionAttemptId
      || delivery?.generation !== deliveryGeneration) return false;
    const receivedAtMs = this.now();
    if (receivedAtMs > delivery.deadlineAtMs || !this.extendAnswerWindowAfterCue(receivedAtMs)) {
      this.pauseAudio(questionId, questionAttemptId);
      return false;
    }
    this.cueDeliveries.delete(playerId);
    this.answerCueReadyPlayerIds.add(playerId);
    this.maybeStartAnswering(receivedAtMs);
    return true;
  }

  questionAnswerCueSkipped(playerId: string, questionId: string, questionAttemptId: number): boolean {
    if (!this.canDeliver(playerId, questionId, questionAttemptId, 'answer_cue')
      || this.answerCueReadyPlayerIds.has(playerId)) return false;
    const skippedAtMs = this.now();
    if ((this.answerCueEndsAt !== null && skippedAtMs > this.answerCueEndsAt
      && !this.cueDeliveryActiveFor(playerId, skippedAtMs))
      || !this.extendAnswerWindowAfterCue(skippedAtMs)) {
      this.pauseAudio(questionId, questionAttemptId);
      return false;
    }
    this.cueDeliveries.delete(playerId);
    this.answerCueReadyPlayerIds.add(playerId);
    this.maybeStartAnswering(skippedAtMs);
    return true;
  }

  private extendAnswerWindowAfterCue(receivedAtMs: number): boolean {
    if (this.answeringStartsAt === null || this.questionEndsAt === null
      || receivedAtMs > this.answeringStartsAt + TRIVIA_MAX_QUESTION_WINDOW_MS
        - TRIVIA_MIN_POST_CUE_ANSWER_MS) return false;
    const deadlineAtMs = receivedAtMs + TRIVIA_MIN_POST_CUE_ANSWER_MS;
    if (deadlineAtMs > this.questionEndsAt) {
      this.questionEndsAt = deadlineAtMs;
      this.finalAnswerDeadlineAt = deadlineAtMs + this.finalAnswerGraceMs;
    }
    return true;
  }

  private cueDeliveryActiveFor(playerId: string, receivedAtMs: number): boolean {
    const delivery = this.cueDeliveries.get(playerId);
    return Boolean(delivery && receivedAtMs <= delivery.deadlineAtMs);
  }

  private sharedCueDeliveryActiveAt(receivedAtMs: number): boolean {
    return this.players.some(player => player.connected && !this.answerCueReadyPlayerIds.has(player.playerId)
      && this.cueDeliveryActiveFor(player.playerId, receivedAtMs));
  }

  /** Each voice transport gets a fresh generation, so a replaced or retried cue cannot acknowledge its successor. */
  beginRevealDelivery(playerId: string, questionId: string, questionAttemptId: number): number | null {
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (this.phase !== 'reveal' || this.currentQuestion()?.question.id !== questionId
      || this.questionAttemptIdValue !== questionAttemptId || !player?.connected
      || this.revealReadyPlayerIds.has(playerId)) return null;
    const generation = this.nextDeliveryGeneration++;
    this.revealDeliveries.set(playerId, generation);
    return generation;
  }

  /** Relay-confirmed, estimated, or caller-interrupted playback releases this caller's reveal barrier. */
  questionRevealReady(playerId: string, questionId: string, questionAttemptId: number,
    deliveryGeneration: number): boolean {
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (this.phase !== 'reveal' || this.currentQuestion()?.question.id !== questionId
      || this.questionAttemptIdValue !== questionAttemptId || !player?.connected
      || this.revealDeliveries.get(playerId) !== deliveryGeneration) return false;
    this.revealDeliveries.delete(playerId);
    this.revealReadyPlayerIds.add(playerId);
    return true;
  }

  /** Holds a final early choice for the shared start; it never exposes the answer key. */
  queueEarlyAnswer(playerId: string, questionId: string, questionAttemptId: number,
    spokenOrChoiceId: string): boolean {
    if ((this.phase !== 'question_prompt' && this.phase !== 'answer_cue')
      || this.questionAttemptIdValue !== questionAttemptId) return false;
    const current = this.currentQuestion();
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!current || current.question.id !== questionId || !player?.connected || player.earlyChoiceId) return false;
    const choiceId = this.resolveChoice(current, spokenOrChoiceId);
    if (!choiceId) return false;
    // The answer clock is already running while numbered choices are spoken.
    // A caller who interrupts that reading must lock at the actual speech time.
    if (this.phase === 'answer_cue') {
      const now = this.now();
      return this.commitAnswer(playerId, choiceId, true, now, now);
    }
    player.earlyChoiceId = choiceId;
    return this.questionPromptSkipped(playerId, questionId, questionAttemptId);
  }

  pauseAudio(questionId: string, questionAttemptId: number): boolean {
    if ((this.phase !== 'question_prompt' && this.phase !== 'answer_cue')
      || this.currentQuestion()?.question.id !== questionId
      || this.questionAttemptIdValue !== questionAttemptId) return false;
    this.phase = 'audio_problem';
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.promptDeliveries.clear();
    this.cueDeliveries.clear();
    this.audioProblemValue = { questionId, questionAttemptId,
      recoveryDeadlineAtMs: this.now() + TRIVIA_AUDIO_RECOVERY_MS };
    this.events.push({ type: 'audio_problem', questionId, questionAttemptId,
      recoveryDeadlineAtMs: this.audioProblemValue.recoveryDeadlineAtMs, atMs: this.now() });
    return true;
  }

  retryQuestion(questionId: string, questionAttemptId: number): boolean {
    if (this.phase !== 'audio_problem' || this.audioProblemValue?.questionId !== questionId
      || this.audioProblemValue.questionAttemptId !== questionAttemptId
      || this.questionIndexValue === null) return false;
    this.startQuestion(this.questionIndexValue, this.now());
    return true;
  }

  private canDeliver(playerId: string, questionId: string, questionAttemptId: number,
    phase: 'question_prompt' | 'answer_cue'): boolean {
    return this.phase === phase && this.questionAttemptIdValue === questionAttemptId
      && this.currentQuestion()?.question.id === questionId
      && Boolean(this.players.find(player => player.playerId === playerId && player.connected));
  }

  /** Trusted voice/DTMF seam. Non-final transcripts never lock an answer. */
  answer(playerId: string, spokenOrChoiceId: string, final = true): boolean {
    const answeredAtMs = this.now();
    return this.commitAnswer(playerId, spokenOrChoiceId, final, answeredAtMs, answeredAtMs);
  }

  /** Reserve bounded interpretation time only for a final heard during this attempt's answer clock. */
  beginSemanticAnswerResolution(playerId: string, questionId: string, questionAttemptId: number,
    onset?: { choiceId?: string; atMs: number }): number | null {
    const receivedAtMs = this.now();
    const current = this.currentQuestion();
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (this.phase === 'answer_cue' && current?.question.id === questionId
      && this.questionAttemptIdValue === questionAttemptId && player?.connected
      && player.submittedChoiceId === null && receivedAtMs > (this.questionEndsAt ?? Infinity)
      && this.sharedCueDeliveryActiveAt(receivedAtMs)) this.extendAnswerWindowAfterCue(receivedAtMs);
    if ((this.phase !== 'question' && this.phase !== 'answer_cue') || !current || current.question.id !== questionId
      || this.questionAttemptIdValue !== questionAttemptId
      || !player?.connected || player.submittedChoiceId !== null
      || this.answeringStartsAt === null || this.questionEndsAt === null
      || this.finalAnswerDeadlineAt === null || receivedAtMs < this.answeringStartsAt
      || receivedAtMs > this.finalAnswerDeadlineAt) return null;
    const lateOnset = receivedAtMs > this.questionEndsAt ? onset : undefined;
    if (receivedAtMs > this.questionEndsAt && (!lateOnset
      || !Number.isSafeInteger(lateOnset.atMs) || lateOnset.atMs < this.answeringStartsAt
      || lateOnset.atMs > this.questionEndsAt || lateOnset.atMs > receivedAtMs
      || (lateOnset.choiceId !== undefined
        && !current.question.locales[this.locale].choices.some(choice => choice.id === lateOnset.choiceId)))) return null;
    const id = this.nextSemanticResolutionId++;
    this.semanticAnswerResolutions.set(playerId, {
      id, questionId, questionAttemptId,
      expiresAtMs: receivedAtMs + TRIVIA_SEMANTIC_ANSWER_MAX_MS,
      ...(lateOnset ? { lateOnset } : {}),
    });
    return id;
  }

  /** Release a canceled, failed, or non-answer interpretation without extending the round. */
  finishSemanticAnswerResolution(playerId: string, questionId: string, questionAttemptId: number,
    resolutionId: number): boolean {
    const pending = this.semanticAnswerResolutions.get(playerId);
    if (!pending || pending.id !== resolutionId || pending.questionId !== questionId
      || pending.questionAttemptId !== questionAttemptId) return false;
    this.semanticAnswerResolutions.delete(playerId);
    return true;
  }

  /** Trusted final seam using the matching interim/onset timestamp for speed scoring. */
  answerAt(playerId: string, spokenOrChoiceId: string, final: boolean, answeredAtMs: number,
    semanticResolutionId?: number): boolean {
    return this.commitAnswer(playerId, spokenOrChoiceId, final, answeredAtMs, this.now(), semanticResolutionId);
  }

  private commitAnswer(playerId: string, spokenOrChoiceId: string, final: boolean,
    answeredAtMs: number, receivedAtMs: number, semanticResolutionId?: number): boolean {
    if (this.phase !== 'question' && this.phase !== 'answer_cue') this.tick();
    const pending = this.semanticAnswerResolutions.get(playerId);
    const current = this.currentQuestion();
    const reservation = semanticResolutionId === undefined ? null
      : pending?.id === semanticResolutionId && pending.questionAttemptId === this.questionAttemptIdValue
        && pending.questionId === current?.question.id && receivedAtMs <= pending.expiresAtMs
        ? pending : null;
    if (semanticResolutionId !== undefined && !reservation) return false;
    const player = this.players.find(candidate => candidate.playerId === playerId);
    if (!player?.connected || player.submittedChoiceId !== null || !current) return false;
    const choiceId = this.resolveChoice(current, spokenOrChoiceId);
    if (!choiceId) return false;
    if (this.phase === 'answer_cue' && receivedAtMs > (this.questionEndsAt ?? Infinity)
      && this.sharedCueDeliveryActiveAt(receivedAtMs)) this.extendAnswerWindowAfterCue(receivedAtMs);
    const receivedDeadlineAt = reservation?.expiresAtMs ?? this.finalAnswerDeadlineAt;
    if ((this.phase !== 'question' && this.phase !== 'answer_cue') || !final || this.answeringStartsAt === null
      || this.questionEndsAt === null || receivedDeadlineAt === null
      || !Number.isSafeInteger(answeredAtMs)
      || answeredAtMs < this.answeringStartsAt
      || answeredAtMs > this.questionEndsAt
      || !Number.isFinite(receivedAtMs) || receivedAtMs < answeredAtMs
      || receivedAtMs > receivedDeadlineAt) return false;
    if (reservation?.lateOnset && (answeredAtMs !== reservation.lateOnset.atMs
      || (reservation.lateOnset.choiceId !== undefined
        && choiceId !== reservation.lateOnset.choiceId))) return false;

    // The published deadline can lengthen for speech. Scoring retains the
    // established 25-second scale and leaderboard validation bounds.
    const elapsedMs = Math.min(TRIVIA_ANSWER_WINDOW_MS, answeredAtMs - this.answeringStartsAt);
    const scored = scoreTriviaAnswer(choiceId === current.question.correctChoiceId, elapsedMs, player.currentStreak);
    player.submittedChoiceId = choiceId;
    this.semanticAnswerResolutions.delete(playerId);
    player.submittedElapsedMs = elapsedMs;
    player.submittedCorrect = scored.correct;
    player.submittedPoints = scored.points;
    if (this.phase === 'answer_cue') {
      this.answerCueReadyPlayerIds.add(playerId);
      this.cueDeliveries.delete(playerId);
    }
    if (this.players.every(candidate => candidate.submittedChoiceId !== null)) {
      if (this.phase === 'answer_cue') this.beginAnswering(receivedAtMs);
      this.revealQuestion(receivedAtMs);
    } else if (this.phase === 'answer_cue') this.maybeStartAnswering(receivedAtMs);
    return true;
  }

  /** Advances absolute deadlines and catches up across delayed event-loop ticks. */
  tick(): boolean {
    const now = this.now();
    let changed = false;
    for (let transitions = 0; transitions < 48; transitions++) {
      if (this.phase === 'loading' && this.loadingDeadlineAt !== null && now >= this.loadingDeadlineAt) {
        const generation = this.loadingGenerationValue;
        const displayReady = this.displayReadyValue;
        this.phase = 'category_select';
        this.loadingGenerationValue += 1;
        this.displayReadyValue = false;
        this.loadingDeadlineAt = null;
        this.categoryValue = null;
        this.round = [];
        for (const player of this.players) player.categoryVote = null;
        this.events.push({ type: 'loading_timeout', loadingGeneration: generation, displayReady, atMs: now });
        changed = true;
        continue;
      }
      if (this.phase === 'countdown' && this.countdownEndsAt !== null) {
        changed = this.emitCountdownEvents(now) || changed;
        if (now >= this.countdownEndsAt) {
          this.startQuestion(0, now);
          changed = true;
          continue;
        }
      }
      if (this.phase === 'question_prompt') {
        const expiredDelivery = this.players.some(player => !this.promptReadyPlayerIds.has(player.playerId)
          && (this.promptDeliveries.get(player.playerId)?.deadlineAtMs ?? Infinity) <= now);
        const neverStarted = this.questionPromptEndsAt !== null && now >= this.questionPromptEndsAt
          && this.players.some(player => !this.promptReadyPlayerIds.has(player.playerId)
            && !this.promptDeliveries.has(player.playerId));
        if (expiredDelivery || neverStarted) {
          this.pauseAudio(this.currentQuestion()!.question.id, this.questionAttemptIdValue);
          changed = true;
          continue;
        }
      }
      if (this.phase === 'answer_cue') {
        // A conservative estimate starts the countdown with the question;
        // an active, bounded delivery may still finish after that estimate.
        if (this.answeringStartsAt !== null
          && now >= this.answeringStartsAt + TRIVIA_MAX_QUESTION_WINDOW_MS) {
          this.pauseAudio(this.currentQuestion()!.question.id, this.questionAttemptIdValue);
          changed = true;
          continue;
        }
        const expiredDelivery = this.players.some(player => !this.answerCueReadyPlayerIds.has(player.playerId)
          && (this.cueDeliveries.get(player.playerId)?.deadlineAtMs ?? Infinity) <= now);
        const neverStarted = this.answerCueEndsAt !== null && now >= this.answerCueEndsAt
          && this.players.some(player => !this.answerCueReadyPlayerIds.has(player.playerId)
            && !this.cueDeliveries.has(player.playerId));
        if (expiredDelivery || neverStarted) {
          this.pauseAudio(this.currentQuestion()!.question.id, this.questionAttemptIdValue);
          changed = true;
          continue;
        }
      }
      if (this.phase === 'audio_problem' && this.audioProblemValue
        && now >= this.audioProblemValue.recoveryDeadlineAtMs) {
        this.events.push({ type: 'audio_recovery_expired', questionId: this.audioProblemValue.questionId,
          questionAttemptId: this.audioProblemValue.questionAttemptId, atMs: now });
        this.phase = 'audio_expired';
        this.audioProblemValue = null;
        changed = true;
        continue;
      }
      if (this.phase === 'question' && this.finalAnswerDeadlineAt !== null && now >= this.finalAnswerDeadlineAt) {
        const currentQuestionId = this.currentQuestion()?.question.id;
        const pendingUntil = Math.max(this.finalAnswerDeadlineAt, ...[...this.semanticAnswerResolutions]
          .filter(([playerId, pending]) => pending.questionId === currentQuestionId
            && pending.questionAttemptId === this.questionAttemptIdValue
            && this.players.some(player => player.playerId === playerId && player.submittedChoiceId === null))
          .map(([, pending]) => pending.expiresAtMs));
        if (now < pendingUntil) break;
        this.revealQuestion(pendingUntil);
        changed = true;
        continue;
      }
      if (this.phase === 'reveal' && this.revealEndsAt !== null && now >= this.revealEndsAt
        && (this.revealHardEndsAt !== null && now >= this.revealHardEndsAt
          || !this.players.some(player => player.connected && this.revealDeliveries.has(player.playerId)))) {
        const nextIndex = (this.questionIndexValue ?? -1) + 1;
        if (nextIndex < this.round.length) this.startQuestion(nextIndex, now);
        else this.finishRound(now);
        changed = true;
        continue;
      }
      break;
    }
    return changed;
  }

  drainEvents(): TriviaEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  state(locale: SupportedLocale = this.locale): TriviaState {
    return projectTriviaState({
      roomCode: this.code,
      phase: this.phase,
      expectedPlayerCount: this.expectedPlayerCountValue,
      automaticSetup: this.automaticSetupValue,
      preferredLocale: this.locale,
      category: this.categoryValue,
      categoryVoteCounts: this.categoryVoteCounts(),
      categoryVotingSeat: this.categoryVotingSeat(),
      players: this.players,
      serverNowMs: this.now(),
      loadingGeneration: this.loadingGenerationValue,
      displayReady: this.displayReadyValue,
      questionIndex: this.questionIndexValue,
      questionAttemptId: this.questionIndexValue === null ? null : this.questionAttemptIdValue,
      renderRevision: this.questionIndexValue === null ? 0
        : this.questionAttemptIdValue * 8 + (({ question_prompt: 1, answer_cue: 2,
          question: 3, reveal: 4, audio_problem: 5 } as Partial<Record<TriviaPhase, number>>)[this.phase] ?? 0),
      countdownEndsAtMs: this.countdownEndsAt,
      questionPromptEndsAtMs: this.questionPromptEndsAt,
      answerCueEndsAtMs: this.answerCueEndsAt,
      answeringStartsAtMs: this.answeringStartsAt,
      questionEndsAtMs: this.questionEndsAt,
      revealEndsAtMs: this.revealEndsAt,
      currentQuestion: this.currentQuestion(),
      result: this.resultValue,
      audioProblem: this.audioProblemValue,
    }, locale);
  }

  hasPlayer(playerId: string): boolean { return this.players.some(player => player.playerId === playerId); }
  categoryVoteFor(playerId: string): TriviaRoundCategoryId | null {
    return this.players.find(player => player.playerId === playerId)?.categoryVote ?? null;
  }
  promptReadyFor(playerId: string): boolean { return this.promptReadyPlayerIds.has(playerId); }
  answerCueReadyFor(playerId: string): boolean { return this.answerCueReadyPlayerIds.has(playerId); }
  canControlSetup(playerId: string): boolean { return this.hasPlayer(playerId); }
  get playerCount(): number { return this.players.length; }
  get expectedPlayerCount(): 1 | 2 | 3 | 4 { return this.expectedPlayerCountValue; }
  get hasExpectedPlayers(): boolean { return this.players.length === this.expectedPlayerCountValue; }
  get stationFixed(): boolean { return this.stationFixedValue; }
  get allowReplay(): boolean { return this.allowReplayValue; }
  get isEmpty(): boolean { return this.players.length === 0; }
  get isUnattendedResult(): boolean {
    return !this.stationFixedValue && this.phase === 'results'
      && this.players.every(player => !player.connected);
  }
  get isTimingActive(): boolean {
    return this.phase === 'loading' || this.phase === 'countdown'
      || this.phase === 'question_prompt' || this.phase === 'answer_cue'
      || this.phase === 'question' || this.phase === 'reveal' || this.phase === 'audio_problem';
  }

  private canFreezeRoster(): boolean {
    return this.players.length >= TRIVIA_MIN_PLAYERS
      && this.players.length === this.expectedPlayerCountValue
      && (!this.stationFixedValue || this.hasValidStationPlayerOrder())
      && this.players.every(player => player.nameConfirmed);
  }

  private hasValidStationPlayerOrder(): boolean {
    return this.players.every(player => (
      player.playerOrder >= 0 && player.playerOrder < this.expectedPlayerCountValue
    )) && new Set(this.players.map(player => player.playerOrder)).size === this.players.length;
  }

  private beginLoading(): void {
    this.categoryValue = this.resolveCategoryVote();
    this.round = Object.freeze(buildTriviaRound(
      this.questions,
      this.categoryValue,
      `${this.seed}:generation:${this.loadingGenerationValue + 1}`,
    ));
    this.phase = 'loading';
    this.loadingGenerationValue += 1;
    this.displayReadyValue = false;
    this.loadingDeadlineAt = this.now() + this.loadingTimeoutMs;
    this.countdownEndsAt = null;
    this.countdownValue = null;
    this.questionIndexValue = null;
    this.audioProblemValue = null;
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.revealEndsAt = null;
    this.revealHardEndsAt = null;
    this.revealDeliveries.clear();
    this.revealReadyPlayerIds.clear();
    this.promptDeliveries.clear();
    this.cueDeliveries.clear();
    this.resultValue = null;
    this.resetPlayersForRound(false);
  }

  private startCountdown(startedAtMs: number): void {
    this.phase = 'countdown';
    this.loadingDeadlineAt = null;
    this.countdownEndsAt = startedAtMs + this.countdownMs;
    this.countdownValue = 3;
    this.events.push({ type: 'countdown', count: 3, atMs: startedAtMs });
  }

  private emitCountdownEvents(now: number): boolean {
    if (this.countdownEndsAt === null || this.countdownValue === null) return false;
    const step = this.countdownMs / 3;
    const startedAt = this.countdownEndsAt - this.countdownMs;
    let changed = false;
    for (const [count, atMs] of [[2, startedAt + step], [1, startedAt + step * 2]] as const) {
      if (this.countdownValue > count && now >= atMs) {
        this.countdownValue = count;
        this.events.push({ type: 'countdown', count, atMs });
        changed = true;
      }
    }
    return changed;
  }

  private startQuestion(index: number, publishedAtMs: number): void {
    const current = this.round[index];
    if (!current) throw new Error('trivia round is missing a planned question');
    this.phase = 'question_prompt';
    this.countdownEndsAt = null;
    this.countdownValue = null;
    this.questionIndexValue = index;
    this.questionAttemptIdValue += 1;
    this.questionPromptEndsAt = publishedAtMs + this.questionPromptTimeoutMs;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.semanticAnswerResolutions.clear();
    this.revealEndsAt = null;
    this.revealHardEndsAt = null;
    this.revealDeliveries.clear();
    this.revealReadyPlayerIds.clear();
    this.audioProblemValue = null;
    this.promptReadyPlayerIds.clear();
    this.answerCueReadyPlayerIds.clear();
    this.promptDeliveries.clear();
    this.cueDeliveries.clear();
    for (const player of this.players) this.clearSubmittedAnswer(player);
    this.events.push({
      type: 'question_started',
      questionId: current.question.id,
      questionAttemptId: this.questionAttemptIdValue,
      questionIndex: index,
      promptDeadlineAtMs: this.questionPromptEndsAt,
    });
  }

  private maybeStartAnswerCue(startedAtMs: number): void {
    if (this.phase !== 'question_prompt') return;
    if (this.players.length > 0
      && this.players.every(player => this.promptReadyPlayerIds.has(player.playerId))) this.beginAnswerCue(startedAtMs);
  }

  private beginAnswerCue(startedAtMs: number): void {
    if (this.phase !== 'question_prompt') return;
    const current = this.currentQuestion();
    if (!current) return;
    this.phase = 'answer_cue';
    this.questionPromptEndsAt = null;
    this.answeringStartsAt = startedAtMs + TRIVIA_ANSWER_START_DELAY_MS;
    const estimatedCueMs = estimateAnswerCueMs(current, this.locale);
    const latestCueAt = this.answeringStartsAt + TRIVIA_MAX_QUESTION_WINDOW_MS
      - TRIVIA_MIN_POST_CUE_ANSWER_MS;
    this.answerCueEndsAt = Math.min(latestCueAt, startedAtMs + (this.answerCueTimeoutCustomized
      ? this.answerCueTimeoutMs
      : Math.max(this.answerCueTimeoutMs, estimatedCueMs + TRIVIA_CUE_DELIVERY_BUFFER_MS)));
    this.questionEndsAt = this.answeringStartsAt + Math.min(TRIVIA_MAX_QUESTION_WINDOW_MS,
      Math.max(TRIVIA_ANSWER_WINDOW_MS, estimatedCueMs + TRIVIA_MIN_POST_CUE_ANSWER_MS
        + TRIVIA_CUE_ESTIMATE_BUFFER_MS));
    this.finalAnswerDeadlineAt = this.questionEndsAt + this.finalAnswerGraceMs;
    this.answerCueReadyPlayerIds.clear();
    this.promptDeliveries.clear();
    for (const player of this.players) if (player.earlyChoiceId) this.answerCueReadyPlayerIds.add(player.playerId);
    this.events.push({
      type: 'answer_cue_started',
      questionId: current.question.id,
      questionAttemptId: this.questionAttemptIdValue,
      endsAtMs: this.answerCueEndsAt,
    });
    this.events.push({
      type: 'answering_started', questionId: current.question.id,
      questionAttemptId: this.questionAttemptIdValue,
      startsAtMs: this.answeringStartsAt,
      endsAtMs: this.questionEndsAt,
    });
    for (const player of this.players) {
      if (this.phase !== 'answer_cue' && this.phase !== 'question') break;
      if (player.earlyChoiceId) this.commitAnswer(player.playerId, player.earlyChoiceId, true,
        this.answeringStartsAt, this.answeringStartsAt);
    }
    this.maybeStartAnswering(startedAtMs);
  }

  private maybeStartAnswering(startedAtMs: number): void {
    if (this.phase !== 'answer_cue') return;
    if (this.players.length > 0
      && this.players.every(player => this.answerCueReadyPlayerIds.has(player.playerId))) this.beginAnswering(startedAtMs);
  }

  private beginAnswering(transitionedAtMs: number): void {
    if (this.phase !== 'answer_cue') return;
    this.phase = 'question';
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.cueDeliveries.clear();
    void transitionedAtMs;
  }

  private revealQuestion(revealedAtMs: number): void {
    if (this.phase !== 'question') return;
    const current = this.currentQuestion();
    if (!current) return;
    this.phase = 'reveal';
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.semanticAnswerResolutions.clear();
    this.revealEndsAt = revealedAtMs + this.revealMs;
    this.revealHardEndsAt = revealedAtMs + Math.max(this.revealMs, TRIVIA_REVEAL_MAX_MS);
    this.revealDeliveries.clear();
    this.revealReadyPlayerIds.clear();
    this.events.push({ type: 'question_revealed', questionId: current.question.id,
      questionAttemptId: this.questionAttemptIdValue, atMs: revealedAtMs });
    for (const player of this.players) {
      player.rawScore += player.submittedPoints;
      player.currentStreak = player.submittedCorrect ? player.currentStreak + 1 : 0;
      player.bestStreak = Math.max(player.bestStreak, player.currentStreak);
      if (player.submittedCorrect && player.submittedElapsedMs !== null) {
        player.correctCount += 1;
        player.cumulativeCorrectTimeMs += player.submittedElapsedMs;
      }
      if (player.submittedCorrect !== null) {
        this.events.push({
          type: 'answer_result',
          questionAttemptId: this.questionAttemptIdValue,
          playerId: player.playerId,
          correct: player.submittedCorrect,
          points: player.submittedPoints,
          rawScore: player.rawScore,
        });
      }
    }
  }

  private finishRound(completedAtMs: number): void {
    if (this.phase !== 'reveal' || !this.categoryValue) return;
    const ranked = rankTriviaPlayers(this.players.map(player => ({
      playerId: player.playerId,
      rawScore: player.rawScore,
      correctCount: player.correctCount,
      cumulativeCorrectTimeMs: player.cumulativeCorrectTimeMs,
      playerOrder: player.playerOrder,
    })));
    const playersById = new Map(this.players.map(player => [player.playerId, player]));
    const resultPlayers = ranked.map((rankedPlayer): TriviaResultPlayer => {
      const player = playersById.get(rankedPlayer.playerId)!;
      player.rank = rankedPlayer.rank;
      player.normalizedScore = rankedPlayer.normalizedScore;
      return Object.freeze({
        playerId: player.playerId,
        name: player.name,
        playerOrder: player.playerOrder,
        rank: rankedPlayer.rank,
        rawScore: player.rawScore,
        normalizedScore: rankedPlayer.normalizedScore,
        correctCount: player.correctCount,
        bestStreak: player.bestStreak,
        cumulativeCorrectTimeMs: player.cumulativeCorrectTimeMs,
      });
    });
    const questionIds = this.round.map(item => item.question.id).join(':');
    this.resultValue = Object.freeze({
      resultId: `trivia-${triviaSeed(`${this.seed}:${this.code}:${this.loadingGenerationValue}:${questionIds}`).toString(36)}-${this.loadingGenerationValue}`,
      generation: this.loadingGenerationValue,
      category: this.categoryValue,
      contentRevision: this.contentRevision,
      players: Object.freeze(resultPlayers),
      completedAtMs,
    });
    this.phase = 'results';
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.promptReadyPlayerIds.clear();
    this.answerCueReadyPlayerIds.clear();
    this.revealEndsAt = null;
    this.revealHardEndsAt = null;
    this.revealDeliveries.clear();
    this.revealReadyPlayerIds.clear();
    const standings = this.state().standings as readonly TriviaPublicStanding[];
    this.events.push({ type: 'round_finished', standings, result: this.resultValue, atMs: completedAtMs });
  }

  private resolveChoice(current: TriviaRoundQuestion, answer: string): string | null {
    if (typeof answer !== 'string') return null;
    const trimmed = answer.normalize('NFC').trim();
    if (/^[1-4]$/.test(trimmed)) return current.choiceOrder[Number(trimmed) - 1] ?? null;
    const direct = trimmed.toLowerCase();
    if (current.question.locales[this.locale].choices.some(choice => choice.id === direct)) return direct;
    return resolveTriviaChoiceId(current.question, this.locale, trimmed);
  }

  private resolveCategoryVote(): TriviaRoundCategoryId {
    const counts = this.categoryVoteCounts();
    const highest = Math.max(...TRIVIA_ROUND_CATEGORY_IDS.map(category => counts[category]));
    if (highest === 0) return 'mixed';
    const winners = TRIVIA_ROUND_CATEGORY_IDS.filter(category => counts[category] === highest);
    return winners.length === 1 ? winners[0]! : 'mixed';
  }

  private categoryVoteCounts(): TriviaCategoryVoteCounts {
    const counts = Object.fromEntries(
      TRIVIA_ROUND_CATEGORY_IDS.map(category => [category, 0]),
    ) as unknown as Record<TriviaRoundCategoryId, number>;
    for (const player of this.players) if (player.categoryVote) counts[player.categoryVote] += 1;
    return Object.freeze(counts);
  }

  private categoryVotingSeat(): { playerId: string; name: string } | null {
    if (this.phase !== 'category_select') return null;
    const player = this.players.find(candidate => candidate.categoryVote === null && candidate.connected);
    return player ? { playerId: player.playerId, name: player.name } : null;
  }

  private currentQuestion(): TriviaRoundQuestion | null {
    if (this.questionIndexValue === null
      || (this.phase !== 'question_prompt' && this.phase !== 'answer_cue'
        && this.phase !== 'question' && this.phase !== 'reveal' && this.phase !== 'audio_problem')) return null;
    return this.round[this.questionIndexValue] ?? null;
  }

  private resetPlayersForRound(clearVotes = true): void {
    for (const player of this.players) {
      player.rawScore = 0;
      player.correctCount = 0;
      player.bestStreak = 0;
      player.currentStreak = 0;
      player.cumulativeCorrectTimeMs = 0;
      player.rank = undefined;
      player.normalizedScore = undefined;
      if (clearVotes) player.categoryVote = null;
      this.clearSubmittedAnswer(player);
    }
  }

  private clearSubmittedAnswer(player: RoomPlayer): void {
    player.submittedChoiceId = null;
    player.submittedElapsedMs = null;
    player.submittedCorrect = null;
    player.submittedPoints = 0;
    player.earlyChoiceId = null;
  }

  private resetEmptyRoom(): void {
    this.phase = 'lobby';
    this.expectedPlayerCountValue = 1;
    this.automaticSetupValue = false;
    this.stationFixedValue = false;
    this.allowReplayValue = true;
    this.rosterFrozen = false;
    this.categoryValue = null;
    this.round = [];
    this.displayReadyValue = false;
    this.loadingDeadlineAt = null;
    this.countdownEndsAt = null;
    this.countdownValue = null;
    this.questionIndexValue = null;
    this.audioProblemValue = null;
    this.questionPromptEndsAt = null;
    this.answerCueEndsAt = null;
    this.answeringStartsAt = null;
    this.questionEndsAt = null;
    this.finalAnswerDeadlineAt = null;
    this.semanticAnswerResolutions.clear();
    this.revealEndsAt = null;
    this.revealHardEndsAt = null;
    this.revealDeliveries.clear();
    this.revealReadyPlayerIds.clear();
    this.promptReadyPlayerIds.clear();
    this.answerCueReadyPlayerIds.clear();
    this.promptDeliveries.clear();
    this.cueDeliveries.clear();
    this.resultValue = null;
  }
}

function estimateAnswerCueMs(current: TriviaRoundQuestion, locale: SupportedLocale): number {
  const localized = current.question.locales[locale];
  const choices = current.choiceOrder.map(id => localized.choices.find(choice => choice.id === id)?.text ?? '');
  // Mirror Relay's conservative 9/10-character speech estimate. The extra
  // characters allow for the spoken option numbers, separators, and preamble.
  const characterCount = choices.reduce((count, choice) => count + Array.from(choice).length, 48);
  const punctuationCount = choices.join(' ').match(/[.!?;:]/g)?.length ?? 0;
  const charactersPerSecond = locale === 'pt-BR' ? 9 : 10;
  return Math.min(TRIVIA_MAX_ESTIMATED_CUE_MS,
    Math.ceil(characterCount / charactersPerSecond * 1_000)
      + (punctuationCount + 4) * 180 + 1_500);
}

function cleanName(name: string): string {
  if (typeof name !== 'string') return 'Player';
  return name.normalize('NFC').trim().slice(0, 40) || 'Player';
}

function cleanRevision(revision: string): string {
  if (typeof revision !== 'string' || !revision.trim() || revision.length > 128 || /\p{Cc}/u.test(revision)) {
    throw new TypeError('contentRevision must be a bounded non-empty string');
  }
  return revision.trim();
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function boundedPromptDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new RangeError('questionPromptTimeoutMs must be an integer from 1 to 120000');
  }
  return value;
}

function boundedCueDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError('answerCueTimeoutMs must be an integer from 1 to 60000');
  }
  return value;
}
