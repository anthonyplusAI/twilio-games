import { isSupportedLocale, type SupportedLocale } from './i18n/locales';
import { normalizeForMatching } from './i18n/translate';

export const TRIVIA_CATEGORY_IDS = [
  'general',
  'science',
  'geography',
  'history',
  'entertainment',
  'sports',
  'technology',
  'twilio',
] as const;
export type TriviaCategoryId = typeof TRIVIA_CATEGORY_IDS[number];
export const TRIVIA_ROUND_CATEGORY_IDS = [...TRIVIA_CATEGORY_IDS, 'mixed'] as const;
export type TriviaRoundCategoryId = typeof TRIVIA_ROUND_CATEGORY_IDS[number];

export const TRIVIA_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type TriviaDifficulty = typeof TRIVIA_DIFFICULTIES[number];
export const TRIVIA_DIFFICULTY_DISTRIBUTION = Object.freeze({ easy: 2, medium: 4, hard: 2 });

export const TRIVIA_MIN_PLAYERS = 1;
export const TRIVIA_MAX_PLAYERS = 4;
export const TRIVIA_QUESTION_BANK_VERSION = 1;
export const TRIVIA_QUESTIONS_PER_CATEGORY = 25;
export const TRIVIA_QUESTION_BANK_SIZE = 200;
export const TRIVIA_ROUND_QUESTION_COUNT = 8;
export const TRIVIA_CHOICE_COUNT = 4;
// The clock begins before four choices are spoken, so it must include time to
// hear them as well as time to answer over a phone connection.
export const TRIVIA_ANSWER_WINDOW_MS = 25_000;
export const TRIVIA_MAX_RAW_SCORE = 12_900;
export const TRIVIA_MAX_NORMALIZED_SCORE = 100_000;
export const TRIVIA_MAX_JSON_LENGTH = 2 * 1024 * 1024;
export const TRIVIA_MAX_ID_LENGTH = 64;
export const TRIVIA_CHOICE_IDS = ['a', 'b', 'c', 'd'] as const;

export type TriviaChoiceId = string;

/** Server-only localized content. Aliases must never be projected to a browser. */
export interface TriviaLocalizedChoiceDefinition {
  readonly id: TriviaChoiceId;
  readonly text: string;
  readonly aliases: readonly string[];
}

/** Server-only localized content. Explanations are disclosed only during reveal. */
export interface TriviaLocalizedDefinition {
  readonly prompt: string;
  readonly choices: readonly TriviaLocalizedChoiceDefinition[];
  readonly explanation: string;
}

export interface TriviaSource {
  readonly url: string;
  readonly title: string;
  readonly accessed: string;
}

export interface TriviaReviewMetadata {
  readonly status: 'reviewed';
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly factChecked: true;
  readonly provenance: 'human-authored' | 'ai-assisted-draft';
}

/** Full question definition. Import and retain this object on the server only. */
export interface TriviaQuestionDefinition {
  readonly id: string;
  readonly category: TriviaCategoryId;
  readonly difficulty: TriviaDifficulty;
  readonly correctChoiceId: TriviaChoiceId;
  readonly locales: Readonly<Record<SupportedLocale, TriviaLocalizedDefinition>>;
  readonly source: TriviaSource;
  readonly review: TriviaReviewMetadata;
}

export interface TriviaQuestionBank {
  readonly version: typeof TRIVIA_QUESTION_BANK_VERSION;
  readonly questions: readonly TriviaQuestionDefinition[];
}

export interface PublicTriviaChoice {
  readonly id: TriviaChoiceId;
  readonly text: string;
}

/** Explicit answer-key-free projection safe to send while a question is active. */
export interface PublicTriviaQuestion {
  readonly id: string;
  readonly category: TriviaCategoryId;
  readonly difficulty: TriviaDifficulty;
  readonly prompt: string;
  readonly choices: readonly PublicTriviaChoice[];
}

/** Reveal payload. Aliases remain server-only even after an answer is disclosed. */
export interface PublicTriviaReveal {
  readonly questionId: string;
  readonly correctChoiceId: TriviaChoiceId;
  readonly explanation: string;
}

export interface TriviaRoundQuestion {
  readonly question: TriviaQuestionDefinition;
  readonly choiceOrder: readonly TriviaChoiceId[];
}

export interface TriviaAnswerScore {
  readonly correct: boolean;
  readonly elapsedMs: number;
  readonly basePoints: number;
  readonly streakBonus: number;
  readonly points: number;
  readonly newStreak: number;
}

export interface TriviaRankingInput {
  readonly playerId: string;
  readonly rawScore: number;
  readonly correctCount: number;
  readonly cumulativeCorrectTimeMs: number;
  /** Join/seat order. Lower values win otherwise exact ties. */
  readonly playerOrder: number;
}

export interface RankedTriviaPlayer extends TriviaRankingInput {
  readonly rank: number;
  readonly normalizedScore: number;
}

export class TriviaValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'TriviaValidationError';
  }
}

const BANK_KEYS = ['version', 'questions'] as const;
const QUESTION_KEYS = ['id', 'category', 'difficulty', 'correctChoiceId', 'locales', 'source', 'review'] as const;
const LOCALE_KEYS = ['prompt', 'choices', 'explanation'] as const;
const CHOICE_KEYS = ['id', 'text', 'aliases'] as const;
const SOURCE_KEYS = ['url', 'title', 'accessed'] as const;
const REVIEW_KEYS = ['status', 'reviewedBy', 'reviewedAt', 'factChecked', 'provenance'] as const;

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TriviaValidationError(path, 'must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TriviaValidationError(path, 'must be a plain object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  const extra = Object.keys(value).find(key => !expected.has(key));
  if (extra) throw new TriviaValidationError(`${path}.${extra}`, 'is not supported');
  const missing = keys.find(key => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) throw new TriviaValidationError(`${path}.${missing}`, 'is required');
}

function text(value: unknown, path: string, maxCharacters: number): string {
  if (typeof value !== 'string') throw new TriviaValidationError(path, 'must be a string');
  const normalized = value.normalize('NFC').trim();
  if (!normalized) throw new TriviaValidationError(path, 'must not be empty');
  if (/\p{Cc}/u.test(normalized)) throw new TriviaValidationError(path, 'contains control characters');
  if (Array.from(normalized).length > maxCharacters
    || Array.from(normalized.normalize('NFKC')).length > maxCharacters) {
    throw new TriviaValidationError(path, `must be at most ${maxCharacters} characters`);
  }
  return normalized;
}

/** IDs are bounded lowercase path-segment-safe slugs. */
export function isSafeTriviaId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= TRIVIA_MAX_ID_LENGTH
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}

function identifier(value: unknown, path: string): string {
  if (!isSafeTriviaId(value)) {
    throw new TriviaValidationError(path, `must be a lowercase slug no longer than ${TRIVIA_MAX_ID_LENGTH} characters`);
  }
  return value;
}

function isoDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TriviaValidationError(path, 'must be an ISO calendar date');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TriviaValidationError(path, 'must be a valid ISO calendar date');
  }
  return value;
}

function httpsUrl(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 512 || value !== value.trim() || /[\s\p{Cc}]/u.test(value)) {
    throw new TriviaValidationError(path, 'must be a bounded HTTPS URL');
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new Error();
  } catch {
    throw new TriviaValidationError(path, 'must be a bounded HTTPS URL');
  }
  return value;
}

function parseLocalizedDefinition(value: unknown, locale: SupportedLocale, path: string): TriviaLocalizedDefinition {
  const raw = plainRecord(value, path);
  exactKeys(raw, LOCALE_KEYS, path);
  if (!Array.isArray(raw.choices) || raw.choices.length !== TRIVIA_CHOICE_COUNT) {
    throw new TriviaValidationError(`${path}.choices`, `must contain exactly ${TRIVIA_CHOICE_COUNT} choices`);
  }

  const choiceIds = new Set<string>();
  const spokenForms = new Map<string, string>();
  const choices = raw.choices.map((value, index): TriviaLocalizedChoiceDefinition => {
    const choicePath = `${path}.choices[${index}]`;
    const choice = plainRecord(value, choicePath);
    exactKeys(choice, CHOICE_KEYS, choicePath);
    const id = identifier(choice.id, `${choicePath}.id`);
    if (id !== TRIVIA_CHOICE_IDS[index]) {
      throw new TriviaValidationError(`${choicePath}.id`, `must equal opaque choice ID ${TRIVIA_CHOICE_IDS[index]}`);
    }
    if (choiceIds.has(id)) throw new TriviaValidationError(`${choicePath}.id`, `duplicates ${id}`);
    choiceIds.add(id);
    const choiceText = text(choice.text, `${choicePath}.text`, 100);
    if (!Array.isArray(choice.aliases) || choice.aliases.length > 12) {
      throw new TriviaValidationError(`${choicePath}.aliases`, 'must contain at most 12 aliases');
    }
    const aliases = choice.aliases.map((alias, aliasIndex) => text(alias, `${choicePath}.aliases[${aliasIndex}]`, 100));
    for (const spoken of [choiceText, ...aliases]) {
      const normalized = normalizeForMatching(spoken, locale);
      if (!normalized) throw new TriviaValidationError(choicePath, 'must have a matchable spoken form');
      const priorChoice = spokenForms.get(normalized);
      if (priorChoice && priorChoice !== id) {
        throw new TriviaValidationError(choicePath, `spoken form collides with choice ${priorChoice}`);
      }
      spokenForms.set(normalized, id);
    }
    return Object.freeze({ id, text: choiceText, aliases: Object.freeze(aliases) });
  });

  return Object.freeze({
    prompt: text(raw.prompt, `${path}.prompt`, 240),
    choices: Object.freeze(choices),
    explanation: text(raw.explanation, `${path}.explanation`, 360),
  });
}

/** Parses one untrusted server-side question definition without applying bank cardinality rules. */
export function parseTriviaQuestion(value: unknown, path = '$'): TriviaQuestionDefinition {
  const raw = plainRecord(value, path);
  exactKeys(raw, QUESTION_KEYS, path);
  const id = identifier(raw.id, `${path}.id`);
  if (!TRIVIA_CATEGORY_IDS.includes(raw.category as TriviaCategoryId)) {
    throw new TriviaValidationError(`${path}.category`, 'must be a supported category');
  }
  if (!TRIVIA_DIFFICULTIES.includes(raw.difficulty as TriviaDifficulty)) {
    throw new TriviaValidationError(`${path}.difficulty`, 'must be easy, medium, or hard');
  }
  const correctChoiceId = identifier(raw.correctChoiceId, `${path}.correctChoiceId`);
  if (!TRIVIA_CHOICE_IDS.includes(correctChoiceId as typeof TRIVIA_CHOICE_IDS[number])) {
    throw new TriviaValidationError(`${path}.correctChoiceId`, 'must be one of the opaque choice IDs a, b, c, or d');
  }

  const rawLocales = plainRecord(raw.locales, `${path}.locales`);
  exactKeys(rawLocales, ['en-US', 'pt-BR'], `${path}.locales`);
  const locales = {
    'en-US': parseLocalizedDefinition(rawLocales['en-US'], 'en-US', `${path}.locales.en-US`),
    'pt-BR': parseLocalizedDefinition(rawLocales['pt-BR'], 'pt-BR', `${path}.locales.pt-BR`),
  } satisfies Record<SupportedLocale, TriviaLocalizedDefinition>;
  const enIds = locales['en-US'].choices.map(choice => choice.id);
  const ptIds = locales['pt-BR'].choices.map(choice => choice.id);
  if (enIds.some((choiceId, index) => choiceId !== ptIds[index])) {
    throw new TriviaValidationError(`${path}.locales.pt-BR.choices`, 'choice IDs and order must match en-US');
  }
  if (!enIds.includes(correctChoiceId)) {
    throw new TriviaValidationError(`${path}.correctChoiceId`, 'must identify one of the four choices');
  }

  const rawSource = plainRecord(raw.source, `${path}.source`);
  exactKeys(rawSource, SOURCE_KEYS, `${path}.source`);
  const source: TriviaSource = Object.freeze({
    url: httpsUrl(rawSource.url, `${path}.source.url`),
    title: text(rawSource.title, `${path}.source.title`, 160),
    accessed: isoDate(rawSource.accessed, `${path}.source.accessed`),
  });

  const rawReview = plainRecord(raw.review, `${path}.review`);
  exactKeys(rawReview, REVIEW_KEYS, `${path}.review`);
  if (rawReview.status !== 'reviewed') throw new TriviaValidationError(`${path}.review.status`, 'must be reviewed');
  if (rawReview.factChecked !== true) throw new TriviaValidationError(`${path}.review.factChecked`, 'must be true');
  if (rawReview.provenance !== 'human-authored' && rawReview.provenance !== 'ai-assisted-draft') {
    throw new TriviaValidationError(`${path}.review.provenance`, 'must describe the content provenance');
  }
  const review: TriviaReviewMetadata = Object.freeze({
    status: 'reviewed',
    reviewedBy: text(rawReview.reviewedBy, `${path}.review.reviewedBy`, 100),
    reviewedAt: isoDate(rawReview.reviewedAt, `${path}.review.reviewedAt`),
    factChecked: true,
    provenance: rawReview.provenance,
  });

  return Object.freeze({
    id,
    category: raw.category as TriviaCategoryId,
    difficulty: raw.difficulty as TriviaDifficulty,
    correctChoiceId,
    locales: Object.freeze(locales),
    source,
    review,
  });
}

/** Strictly parses the complete production bank: exactly 25 reviewed questions per category. */
export function parseTriviaQuestionBank(value: unknown): TriviaQuestionBank {
  const raw = plainRecord(value, '$');
  exactKeys(raw, BANK_KEYS, '$');
  if (raw.version !== TRIVIA_QUESTION_BANK_VERSION) {
    throw new TriviaValidationError('$.version', `must equal ${TRIVIA_QUESTION_BANK_VERSION}`);
  }
  if (!Array.isArray(raw.questions) || raw.questions.length !== TRIVIA_QUESTION_BANK_SIZE) {
    throw new TriviaValidationError('$.questions', `must contain exactly ${TRIVIA_QUESTION_BANK_SIZE} questions`);
  }
  const ids = new Set<string>();
  const categoryCounts = new Map<TriviaCategoryId, number>();
  const difficultyCounts = new Map<string, number>();
  const questions = raw.questions.map((question, index) => {
    const parsed = parseTriviaQuestion(question, `$.questions[${index}]`);
    if (ids.has(parsed.id)) throw new TriviaValidationError(`$.questions[${index}].id`, `duplicates ${parsed.id}`);
    ids.add(parsed.id);
    categoryCounts.set(parsed.category, (categoryCounts.get(parsed.category) ?? 0) + 1);
    const difficultyKey = `${parsed.category}:${parsed.difficulty}`;
    difficultyCounts.set(difficultyKey, (difficultyCounts.get(difficultyKey) ?? 0) + 1);
    return parsed;
  });
  for (const category of TRIVIA_CATEGORY_IDS) {
    if (categoryCounts.get(category) !== TRIVIA_QUESTIONS_PER_CATEGORY) {
      throw new TriviaValidationError('$.questions', `${category} must contain exactly ${TRIVIA_QUESTIONS_PER_CATEGORY} questions`);
    }
    for (const difficulty of TRIVIA_DIFFICULTIES) {
      const required = TRIVIA_DIFFICULTY_DISTRIBUTION[difficulty];
      if ((difficultyCounts.get(`${category}:${difficulty}`) ?? 0) < required) {
        throw new TriviaValidationError('$.questions', `${category} needs at least ${required} ${difficulty} questions`);
      }
    }
  }
  return Object.freeze({ version: TRIVIA_QUESTION_BANK_VERSION, questions: Object.freeze(questions) });
}

export function parseTriviaQuestionBankJson(json: string): TriviaQuestionBank {
  if (typeof json !== 'string' || json.length > TRIVIA_MAX_JSON_LENGTH) {
    throw new TriviaValidationError('$', `JSON must not exceed ${TRIVIA_MAX_JSON_LENGTH} characters`);
  }
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new TriviaValidationError('$', 'must be valid JSON'); }
  return parseTriviaQuestionBank(value);
}

export function validateTriviaQuestionBank(value: unknown): asserts value is TriviaQuestionBank {
  void parseTriviaQuestionBank(value);
}

export function isTriviaQuestionBank(value: unknown): value is TriviaQuestionBank {
  try { parseTriviaQuestionBank(value); return true; } catch { return false; }
}

/** FNV-1a over UTF-16 code units; stable across supported Node and browser runtimes. */
export function triviaSeed(seed: string | number): number {
  const value = typeof seed === 'number' ? String(seed) : seed;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function shuffleTriviaItems<T>(items: readonly T[], seed: string | number): T[] {
  const shuffled = items.slice();
  let state = triviaSeed(seed) || 0x9e3779b9;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled;
}

function pickDifficulty(
  questions: readonly TriviaQuestionDefinition[],
  category: TriviaCategoryId,
  difficulty: TriviaDifficulty,
  count: number,
  seed: string | number,
): TriviaQuestionDefinition[] {
  const candidates = questions.filter(question => question.category === category && question.difficulty === difficulty);
  if (candidates.length < count) throw new Error(`not enough ${category}/${difficulty} trivia questions`);
  return shuffleTriviaItems(candidates, `${seed}:questions:${category}:${difficulty}`).slice(0, count);
}

/** Selects eight server definitions with 2/4/2 difficulty and one/category for Mixed. */
export function selectTriviaRoundQuestions(
  bank: TriviaQuestionBank | readonly TriviaQuestionDefinition[],
  category: TriviaRoundCategoryId,
  seed: string | number,
): TriviaQuestionDefinition[] {
  if (!TRIVIA_ROUND_CATEGORY_IDS.includes(category)) throw new Error('unsupported trivia round category');
  const questions: readonly TriviaQuestionDefinition[] = 'questions' in bank ? bank.questions : bank;
  const selected: TriviaQuestionDefinition[] = [];
  if (category === 'mixed') {
    const categories = shuffleTriviaItems(TRIVIA_CATEGORY_IDS, `${seed}:mixed-categories`);
    const difficulties = shuffleTriviaItems<TriviaDifficulty>(
      ['easy', 'easy', 'medium', 'medium', 'medium', 'medium', 'hard', 'hard'],
      `${seed}:mixed-difficulties`,
    );
    categories.forEach((mixedCategory, index) => {
      selected.push(...pickDifficulty(questions, mixedCategory, difficulties[index]!, 1, `${seed}:mixed:${index}`));
    });
  } else {
    for (const difficulty of TRIVIA_DIFFICULTIES) {
      selected.push(...pickDifficulty(
        questions,
        category,
        difficulty,
        TRIVIA_DIFFICULTY_DISTRIBUTION[difficulty],
        seed,
      ));
    }
  }
  return shuffleTriviaItems(selected, `${seed}:round-order`);
}

export function shuffledTriviaChoiceIds(question: TriviaQuestionDefinition, seed: string | number): TriviaChoiceId[] {
  return shuffleTriviaItems(question.locales['en-US'].choices.map(choice => choice.id), `${seed}:choices:${question.id}`);
}

export function buildTriviaRound(
  bank: TriviaQuestionBank | readonly TriviaQuestionDefinition[],
  category: TriviaRoundCategoryId,
  seed: string | number,
): TriviaRoundQuestion[] {
  return selectTriviaRoundQuestions(bank, category, seed).map(question => Object.freeze({
    question,
    choiceOrder: Object.freeze(shuffledTriviaChoiceIds(question, seed)),
  }));
}

/** The sole active-question projection: no correct ID, aliases, explanation, source, or review data. */
export function projectPublicTriviaQuestion(
  question: TriviaQuestionDefinition,
  locale: SupportedLocale,
  choiceOrder: readonly TriviaChoiceId[] = question.locales[locale].choices.map(choice => choice.id),
): PublicTriviaQuestion {
  if (!isSupportedLocale(locale)) throw new Error('unsupported trivia locale');
  const localized = question.locales[locale];
  const choicesById = new Map(localized.choices.map(choice => [choice.id, choice]));
  if (choiceOrder.length !== TRIVIA_CHOICE_COUNT || new Set(choiceOrder).size !== TRIVIA_CHOICE_COUNT
    || choiceOrder.some(choiceId => !choicesById.has(choiceId))) {
    throw new Error('choice order must contain each question choice exactly once');
  }
  return Object.freeze({
    id: question.id,
    category: question.category,
    difficulty: question.difficulty,
    prompt: localized.prompt,
    choices: Object.freeze(choiceOrder.map(choiceId => {
      const choice = choicesById.get(choiceId)!;
      return Object.freeze({ id: choice.id, text: choice.text });
    })),
  });
}

export function projectPublicTriviaReveal(question: TriviaQuestionDefinition, locale: SupportedLocale): PublicTriviaReveal {
  if (!isSupportedLocale(locale)) throw new Error('unsupported trivia locale');
  return Object.freeze({
    questionId: question.id,
    correctChoiceId: question.correctChoiceId,
    explanation: question.locales[locale].explanation,
  });
}

/** Maps a bounded spoken form to one choice. The answer key remains a separate server concern. */
export function resolveTriviaChoiceId(
  question: TriviaQuestionDefinition,
  locale: SupportedLocale,
  spoken: unknown,
): TriviaChoiceId | null {
  if (typeof spoken !== 'string' || Array.from(spoken).length > 100 || /\p{Cc}/u.test(spoken)) return null;
  const normalized = normalizeForMatching(spoken.normalize('NFC'), locale);
  if (!normalized) return null;
  for (const choice of question.locales[locale].choices) {
    if ([choice.text, ...choice.aliases].some(alias => normalizeForMatching(alias, locale) === normalized)) return choice.id;
  }
  return null;
}

export function triviaBasePoints(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > TRIVIA_ANSWER_WINDOW_MS) return 0;
  if (elapsedMs < 8_000) return 1_300;
  if (elapsedMs < 16_000) return 1_200;
  if (elapsedMs < 23_000) return 1_100;
  return 1_000;
}

export function scoreTriviaAnswer(correct: boolean, elapsedMs: number, previousStreak: number): TriviaAnswerScore;
export function scoreTriviaAnswer(input: { correct: boolean; elapsedMs: number; previousStreak: number }): TriviaAnswerScore;
export function scoreTriviaAnswer(
  correctOrInput: boolean | { correct: boolean; elapsedMs: number; previousStreak: number },
  elapsedArgument?: number,
  streakArgument?: number,
): TriviaAnswerScore {
  const correct = typeof correctOrInput === 'boolean' ? correctOrInput : correctOrInput.correct;
  const elapsedMs = typeof correctOrInput === 'boolean' ? elapsedArgument! : correctOrInput.elapsedMs;
  const previousStreak = typeof correctOrInput === 'boolean' ? streakArgument! : correctOrInput.previousStreak;
  if (!Number.isSafeInteger(previousStreak) || previousStreak < 0 || previousStreak > TRIVIA_ROUND_QUESTION_COUNT) {
    throw new RangeError('previousStreak must be an integer from 0 to 8');
  }
  const basePoints = correct ? triviaBasePoints(elapsedMs) : 0;
  const scoredCorrect = correct && basePoints > 0;
  const newStreak = scoredCorrect ? previousStreak + 1 : 0;
  const streakBonus = scoredCorrect ? Math.min(500, (newStreak - 1) * 100) : 0;
  return Object.freeze({
    correct: scoredCorrect,
    elapsedMs,
    basePoints,
    streakBonus,
    points: basePoints + streakBonus,
    newStreak,
  });
}

export function normalizeTriviaScore(rawScore: number): number {
  if (!Number.isSafeInteger(rawScore) || rawScore < 0 || rawScore > TRIVIA_MAX_RAW_SCORE) {
    throw new RangeError(`rawScore must be an integer from 0 to ${TRIVIA_MAX_RAW_SCORE}`);
  }
  return Math.round(rawScore * TRIVIA_MAX_NORMALIZED_SCORE / TRIVIA_MAX_RAW_SCORE);
}

export function compareTriviaPlayers(a: TriviaRankingInput, b: TriviaRankingInput): number {
  return b.rawScore - a.rawScore
    || b.correctCount - a.correctCount
    || a.cumulativeCorrectTimeMs - b.cumulativeCorrectTimeMs
    || a.playerOrder - b.playerOrder;
}

export function rankTriviaPlayers(players: readonly TriviaRankingInput[]): RankedTriviaPlayer[] {
  const playerIds = new Set<string>();
  const playerOrders = new Set<number>();
  for (const player of players) {
    if (!isSafeTriviaId(player.playerId) || playerIds.has(player.playerId)) throw new Error('players need unique safe IDs');
    if (!Number.isSafeInteger(player.rawScore) || player.rawScore < 0 || player.rawScore > TRIVIA_MAX_RAW_SCORE) {
      throw new Error('invalid raw trivia score');
    }
    if (!Number.isSafeInteger(player.correctCount) || player.correctCount < 0 || player.correctCount > TRIVIA_ROUND_QUESTION_COUNT) {
      throw new Error('invalid correct trivia count');
    }
    if (!Number.isSafeInteger(player.cumulativeCorrectTimeMs) || player.cumulativeCorrectTimeMs < 0
      || player.cumulativeCorrectTimeMs > TRIVIA_ROUND_QUESTION_COUNT * TRIVIA_ANSWER_WINDOW_MS) {
      throw new Error('invalid cumulative correct time');
    }
    if (!Number.isSafeInteger(player.playerOrder) || player.playerOrder < 0 || playerOrders.has(player.playerOrder)) {
      throw new Error('players need unique non-negative player order');
    }
    playerIds.add(player.playerId);
    playerOrders.add(player.playerOrder);
  }
  if (players.length < TRIVIA_MIN_PLAYERS || players.length > TRIVIA_MAX_PLAYERS) {
    throw new Error(`trivia requires ${TRIVIA_MIN_PLAYERS} to ${TRIVIA_MAX_PLAYERS} players`);
  }
  return players.slice().sort(compareTriviaPlayers).map((player, index) => Object.freeze({
    ...player,
    rank: index + 1,
    normalizedScore: normalizeTriviaScore(player.rawScore),
  }));
}
