import { KARAOKE_SONG_DURATION_MS, type KaraokeLane, type KaraokeSong } from '../shared/karaoke';
import { KARAOKE_DEVELOPMENT_SONGS } from '../shared/karaoke-songs';
import {
  KARAOKE_COUNTDOWN_MS,
  KARAOKE_LOADING_TIMEOUT_MS,
  KARAOKE_MAX_SCORE,
  type KaraokeEvent,
  type KaraokeJudgment,
  type KaraokePhase,
  type KaraokeResult,
  type KaraokeSinger,
  type KaraokeState,
} from '../shared/karaoke-protocol';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';

export interface KaraokeRoomOptions {
  now?: () => number;
  songs?: readonly KaraokeSong[];
  preferredLocale?: SupportedLocale;
  countdownMs?: number;
  loadingTimeoutMs?: number;
}

export interface KaraokeHit {
  wordId: string;
  judgment: KaraokeJudgment;
  points: number;
}

export class KaraokeRoom {
  phase: KaraokePhase = 'lobby';
  private singer: KaraokeSinger | null = null;
  private nextPlayer = 1;
  private expectedPlayerCountValue: 1 = 1;
  private automaticSetupValue = false;
  private locale: SupportedLocale;
  private selectedSongValue: KaraokeSong | null = null;
  private selectedByPlayerId: string | null = null;
  private selectionGenerationValue = 0;
  private loadingGenerationValue = 0;
  private displayReadyValue = false;
  private mediaReadyValue = false;
  private mediaSongStartTimestamp: number | null = null;
  private countdownEndsAt: number | null = null;
  private loadingDeadlineAt: number | null = null;
  private countdownValue: number | null = null;
  private performanceStartedAt: number | null = null;
  private performanceEndsAt: number | null = null;
  private scoreValue = 0;
  private comboValue = 0;
  private bestComboValue = 0;
  private resultValue: KaraokeResult | null = null;
  private judgedWords = new Set<string>();
  private events: KaraokeEvent[] = [];
  private keyboardScoringPlayerId: string | null = null;
  private readonly now: () => number;
  private songs: readonly KaraokeSong[];
  private readonly countdownMs: number;
  private readonly loadingTimeoutMs: number;

  constructor(readonly code: string, options: KaraokeRoomOptions = {}) {
    this.now = options.now ?? Date.now;
    this.songs = options.songs ?? KARAOKE_DEVELOPMENT_SONGS;
    this.locale = options.preferredLocale ?? DEFAULT_LOCALE;
    this.countdownMs = Math.max(3, options.countdownMs ?? KARAOKE_COUNTDOWN_MS);
    this.loadingTimeoutMs = Math.max(1_000, options.loadingTimeoutMs ?? KARAOKE_LOADING_TIMEOUT_MS);
  }

  addPlayer(name: string, nameConfirmed = true): { playerId: string } | { error: string } {
    if (this.singer || (this.phase !== 'lobby' && this.phase !== 'song_select')) return { error: 'room_full' };
    const playerId = `k${this.nextPlayer++}`;
    this.singer = { playerId, name: cleanName(name), nameConfirmed };
    if (!nameConfirmed && this.phase === 'song_select') this.phase = 'lobby';
    return { playerId };
  }

  removePlayer(playerId: string): void {
    if (this.singer?.playerId !== playerId) return;
    this.singer = null;
    this.keyboardScoringPlayerId = null;
    this.resetRound('lobby');
    this.automaticSetupValue = false;
  }

  setName(playerId: string, name: string): boolean {
    if (this.singer?.playerId !== playerId) return false;
    const cleaned = cleanName(name);
    this.singer.name = cleaned;
    this.singer.nameConfirmed = true;
    if (this.resultValue?.playerId === playerId) {
      this.resultValue = Object.freeze({ ...this.resultValue, name: cleaned });
    }
    return true;
  }

  hasConfirmedName(playerId: string): boolean {
    return this.singer?.playerId === playerId && this.singer.nameConfirmed;
  }

  expectHumanPlayers(_count: number, _fixed = true): void {
    this.expectedPlayerCountValue = 1;
    this.automaticSetupValue = true;
    this.keyboardScoringPlayerId = null;
  }

  enableKeyboardScoring(playerId: string): boolean {
    if (this.singer?.playerId !== playerId) return false;
    this.keyboardScoringPlayerId = playerId;
    return true;
  }

  setPreferredLocale(locale: SupportedLocale): boolean {
    if ((this.phase !== 'lobby' && this.phase !== 'song_select') || this.selectedSongValue) return false;
    this.locale = locale;
    return true;
  }

  setSongs(songs: readonly KaraokeSong[]): void {
    this.songs = songs;
  }

  catalog(): readonly KaraokeSong[] {
    const localized = this.songs.filter(song => song.locale === this.locale);
    if (localized.length) return localized;
    const fallback = this.songs.filter(song => song.locale === DEFAULT_LOCALE);
    return fallback.length ? fallback : this.songs;
  }

  selectSong(playerId: string, songId: string): boolean {
    if (this.phase !== 'song_select' || this.singer?.playerId !== playerId) return false;
    const song = this.catalog().find(candidate => candidate.id === songId);
    if (!song) return false;
    this.selectedSongValue = song;
    this.selectedByPlayerId = playerId;
    this.selectionGenerationValue += 1;
    return true;
  }

  advance(playerId?: string): boolean {
    if (this.automaticSetupValue && (!playerId || !this.hasPlayer(playerId))) return false;
    if (this.phase === 'lobby' && this.singer?.nameConfirmed) {
      this.phase = 'song_select';
      return true;
    }
    if (this.phase === 'song_select' && this.selectedSongValue
      && this.selectedByPlayerId === this.singer?.playerId) {
      this.beginLoading();
      return true;
    }
    if (this.phase === 'results' && this.singer?.nameConfirmed && playerId === this.singer.playerId) {
      this.resetRound('song_select');
      return true;
    }
    return false;
  }

  ready(generation: number): boolean {
    if (this.phase !== 'loading' || generation !== this.loadingGenerationValue || !this.selectedSongValue) return false;
    this.displayReadyValue = true;
    this.maybeStartCountdown();
    return true;
  }

  /** Trusted Media Streams seam; browser messages cannot mark media ready. */
  mediaReady(playerId: string, songId: string, generation: number, songStartTimestampMs: number): boolean {
    if (this.phase !== 'loading' || !this.automaticSetupValue
      || this.singer?.playerId !== playerId || this.selectedSongValue?.id !== songId
      || generation !== this.loadingGenerationValue || !Number.isSafeInteger(songStartTimestampMs)
      || songStartTimestampMs !== this.countdownMs) return false;
    if (this.mediaReadyValue) return this.mediaSongStartTimestamp === songStartTimestampMs;
    this.mediaReadyValue = true;
    this.mediaSongStartTimestamp = songStartTimestampMs;
    this.maybeStartCountdown();
    return true;
  }

  retryLoading(generation: number): boolean {
    if (this.phase !== 'loading' || generation !== this.loadingGenerationValue) return false;
    this.loadingGenerationValue += 1;
    this.resetReadiness();
    this.loadingDeadlineAt = this.now() + this.loadingTimeoutMs;
    return true;
  }

  invalidateDisplayReady(): boolean {
    if (this.phase !== 'loading' || !this.displayReadyValue || this.mediaReadyValue) return false;
    this.loadingGenerationValue += 1;
    this.countdownEndsAt = null;
    this.countdownValue = null;
    this.resetReadiness();
    this.loadingDeadlineAt = this.now() + this.loadingTimeoutMs;
    return true;
  }

  /** Advances only absolute countdown/performance deadlines. Returns true when observable state changed. */
  tick(): boolean {
    const now = this.now();
    let changed = false;
    if (this.phase === 'loading' && this.loadingDeadlineAt !== null && now >= this.loadingDeadlineAt) {
      const generation = this.loadingGenerationValue;
      const displayReady = this.displayReadyValue;
      const mediaReady = this.mediaReadyValue;
      this.phase = 'song_select';
      this.loadingGenerationValue += 1;
      this.loadingDeadlineAt = null;
      this.resetReadiness();
      this.events.push({ type: 'loading_timeout', generation, displayReady, mediaReady, atMs: now });
      changed = true;
    }
    if (this.phase === 'countdown' && this.countdownEndsAt !== null) {
      const countdownStepMs = this.countdownMs / 3;
      const remaining = Math.max(0, Math.ceil((this.countdownEndsAt - now) / countdownStepMs));
      const displayed = Math.min(3, remaining) as 0 | 1 | 2 | 3;
      const previous = this.countdownValue ?? 3;
      for (let count = previous - 1; count >= Math.max(1, displayed); count--) {
        this.events.push({
          type: 'countdown',
          count: count as 1 | 2 | 3,
          atMs: this.countdownEndsAt - count * countdownStepMs,
        });
      }
      if (displayed !== previous) {
        this.countdownValue = displayed || null;
        changed = true;
      }
      if (now >= this.countdownEndsAt) {
        this.startPerformance(this.countdownEndsAt);
        changed = true;
      }
    }
    if (this.phase === 'performing' && this.performanceEndsAt !== null && now >= this.performanceEndsAt) {
      this.phase = 'finalizing';
      if (this.keyboardScoringPlayerId === this.singer?.playerId) this.finalizeKeyboardScore();
      changed = true;
    }
    return changed;
  }

  keyboardLane(playerId: string, lane: KaraokeLane): boolean {
    this.tick();
    if (this.phase !== 'performing' || this.keyboardScoringPlayerId !== playerId
      || this.singer?.playerId !== playerId || !this.selectedSongValue || this.performanceStartedAt === null) return false;
    const elapsedMs = this.now() - this.performanceStartedAt;
    const words = this.selectedSongValue.chart.words;
    let word = words.find(candidate => !this.judgedWords.has(candidate.id));
    while (word && elapsedMs > word.startMs + 5_000) {
      this.applyHit({ wordId: word.id, judgment: 'miss', points: 0 });
      word = words.find(candidate => !this.judgedWords.has(candidate.id));
    }
    if (!word || elapsedMs < word.startMs - 5_000) return false;
    const deltaMs = Math.abs(elapsedMs - word.startMs);
    const judgment: KaraokeJudgment = lane !== word.lane || deltaMs > 5_000
      ? 'miss'
      : deltaMs <= 60 ? 'perfect' : 'good';
    const share = KARAOKE_MAX_SCORE / words.length;
    this.applyHit({ wordId: word.id, judgment, points: judgment === 'perfect' ? share : share * .7 });
    return true;
  }

  /** Trusted score commit seam. Browser lane input never supplies a score. */
  updateScore(playerId: string, score: number): boolean {
    this.tick();
    if (this.phase !== 'performing' || this.singer?.playerId !== playerId || !Number.isFinite(score)) return false;
    this.scoreValue = boundedScore(score);
    return true;
  }

  /** Records one trusted judgment per chart word and emits ordered word/combo events. */
  recordHit(playerId: string, hit: KaraokeHit): boolean;
  recordHit(playerId: string, wordId: string, judgment: KaraokeJudgment, points: number): boolean;
  recordHit(playerId: string, hitOrWordId: KaraokeHit | string, judgment?: KaraokeJudgment, points?: number): boolean {
    const hit: KaraokeHit = typeof hitOrWordId === 'string'
      ? { wordId: hitOrWordId, judgment: judgment as KaraokeJudgment, points: points ?? Number.NaN }
      : hitOrWordId;
    this.tick();
    if (this.phase !== 'performing' || this.singer?.playerId !== playerId || !this.selectedSongValue
      || this.judgedWords.has(hit.wordId) || !this.selectedSongValue.chart.words.some(word => word.id === hit.wordId)
      || !isJudgment(hit.judgment) || !Number.isFinite(hit.points)) return false;

    this.applyHit(hit);
    return true;
  }

  /** Authenticated scorer commit: final evidence atomically replaces provisional judgments and combo. */
  finalizeMediaScore(playerId: string, score: number, hits: readonly KaraokeHit[]): boolean {
    this.tick();
    if (this.phase !== 'finalizing' || this.resultValue || this.singer?.playerId !== playerId
      || !this.selectedSongValue || !Number.isFinite(score)) return false;
    const chartWords = this.selectedSongValue.chart.words;
    const chartWordIds = new Set(chartWords.map(word => word.id));
    const suppliedWordIds = new Set<string>();
    for (const hit of hits) {
      if (!chartWordIds.has(hit.wordId) || suppliedWordIds.has(hit.wordId)
        || !isJudgment(hit.judgment) || !Number.isFinite(hit.points)
        || hit.points < 0 || hit.points > KARAOKE_MAX_SCORE) return false;
      suppliedWordIds.add(hit.wordId);
    }
    if (suppliedWordIds.size !== chartWords.length) return false;
    const hitsById = new Map(hits.map(hit => [hit.wordId, hit]));
    const ordered = chartWords.map(word => hitsById.get(word.id)!);
    const finalScore = boundedScore(ordered.reduce((total, hit) => total + (hit.judgment === 'miss' ? 0 : hit.points), 0));
    if (boundedScore(score) !== finalScore) return false;
    this.judgedWords.clear();
    this.scoreValue = 0;
    this.comboValue = 0;
    this.bestComboValue = 0;
    for (const hit of ordered) {
      this.judgedWords.add(hit.wordId);
      this.scoreValue = boundedScore(this.scoreValue + (hit.judgment === 'miss' ? 0 : hit.points));
      this.comboValue = hit.judgment === 'miss' ? 0 : this.comboValue + 1;
      this.bestComboValue = Math.max(this.bestComboValue, this.comboValue);
    }
    this.finishPerformance(this.performanceEndsAt ?? this.now());
    return true;
  }

  drainEvents(): KaraokeEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  state(): KaraokeState {
    return {
      roomCode: this.code,
      phase: this.phase,
      singer: this.singer ? { ...this.singer } : null,
      expectedPlayerCount: this.expectedPlayerCountValue,
      hasExpectedPlayers: this.singer !== null,
      automaticSetup: this.automaticSetupValue,
      preferredLocale: this.locale,
      catalog: this.catalog(),
      selectedSong: this.selectedSongValue,
      selectedByPlayerId: this.selectedByPlayerId,
      selectionGeneration: this.selectionGenerationValue,
      loadingGeneration: this.loadingGenerationValue,
      displayReady: this.displayReadyValue,
      mediaReady: this.mediaReadyValue,
      mediaSongStartTimestampMs: this.mediaSongStartTimestamp,
      serverNowMs: this.now(),
      countdown: this.phase === 'countdown' ? this.countdownValue : null,
      countdownEndsAtMs: this.countdownEndsAt,
      performanceStartedAtMs: this.performanceStartedAt,
      performanceEndsAtMs: this.performanceEndsAt,
      score: this.scoreValue,
      combo: this.comboValue,
      bestCombo: this.bestComboValue,
      result: this.resultValue,
    };
  }

  hasPlayer(playerId: string): boolean { return this.singer?.playerId === playerId; }
  canControlSetup(playerId: string): boolean { return this.hasPlayer(playerId); }
  get playerCount(): number { return this.singer ? 1 : 0; }
  get expectedPlayerCount(): 1 { return this.expectedPlayerCountValue; }
  get hasExpectedPlayers(): boolean { return this.singer !== null; }
  get isEmpty(): boolean { return this.singer === null; }
  get isTimingActive(): boolean { return this.phase === 'loading' || this.phase === 'countdown' || this.phase === 'performing'; }

  private beginLoading(): void {
    this.phase = 'loading';
    this.loadingGenerationValue += 1;
    this.loadingDeadlineAt = this.now() + this.loadingTimeoutMs;
    this.resetReadiness();
    this.countdownEndsAt = null;
    this.countdownValue = null;
    this.performanceStartedAt = null;
    this.performanceEndsAt = null;
    this.scoreValue = 0;
    this.comboValue = 0;
    this.bestComboValue = 0;
    this.resultValue = null;
    this.judgedWords.clear();
    this.events = [];
  }

  private startPerformance(startedAtMs: number): void {
    if (this.phase !== 'countdown') return;
    this.phase = 'performing';
    this.countdownValue = null;
    this.loadingDeadlineAt = null;
    this.performanceStartedAt = startedAtMs;
    this.performanceEndsAt = startedAtMs + (this.selectedSongValue?.durationMs ?? KARAOKE_SONG_DURATION_MS);
    this.events.push({ type: 'start', startedAtMs, endsAtMs: this.performanceEndsAt });
  }

  private finishPerformance(completedAtMs: number): void {
    if (this.phase !== 'finalizing' || this.resultValue || !this.singer || !this.selectedSongValue) return;
    this.phase = 'results';
    this.resultValue = Object.freeze({
      generation: this.loadingGenerationValue,
      playerId: this.singer.playerId,
      name: this.singer.name,
      songId: this.selectedSongValue.id,
      score: boundedScore(this.scoreValue),
      bestCombo: this.bestComboValue,
      completedAtMs,
    });
    this.events.push({ type: 'result', result: this.resultValue });
  }

  private finalizeKeyboardScore(): void {
    if (!this.selectedSongValue) return;
    for (const word of this.selectedSongValue.chart.words) {
      if (!this.judgedWords.has(word.id)) this.applyHit({ wordId: word.id, judgment: 'miss', points: 0 });
    }
    this.finishPerformance(this.performanceEndsAt ?? this.now());
  }

  private resetRound(phase: 'lobby' | 'song_select'): void {
    this.phase = phase;
    this.selectedSongValue = null;
    this.selectedByPlayerId = null;
    this.resetReadiness();
    this.countdownEndsAt = null;
    this.loadingDeadlineAt = null;
    this.countdownValue = null;
    this.performanceStartedAt = null;
    this.performanceEndsAt = null;
    this.scoreValue = 0;
    this.comboValue = 0;
    this.bestComboValue = 0;
    this.resultValue = null;
    this.judgedWords.clear();
    this.events = [];
  }

  private maybeStartCountdown(): void {
    if (this.phase !== 'loading' || !this.selectedSongValue || !this.displayReadyValue
      || (this.automaticSetupValue && !this.mediaReadyValue)) return;
    const now = this.now();
    this.phase = 'countdown';
    this.loadingDeadlineAt = null;
    this.countdownEndsAt = now + this.countdownMs;
    this.countdownValue = 3;
    this.events.push({ type: 'countdown', count: 3, atMs: now });
  }

  private resetReadiness(): void {
    this.displayReadyValue = false;
    this.mediaReadyValue = false;
    this.mediaSongStartTimestamp = null;
  }

  private applyHit(hit: KaraokeHit): void {
    this.judgedWords.add(hit.wordId);
    const awardedPoints = hit.judgment === 'miss' ? 0 : boundedScore(hit.points);
    this.scoreValue = boundedScore(this.scoreValue + awardedPoints);
    this.comboValue = hit.judgment === 'miss' ? 0 : this.comboValue + 1;
    this.bestComboValue = Math.max(this.bestComboValue, this.comboValue);
    const atMs = this.now();
    this.events.push({
      type: 'word_judgment',
      wordId: hit.wordId,
      judgment: hit.judgment,
      points: awardedPoints,
      score: this.scoreValue,
      combo: this.comboValue,
      atMs,
    });
    this.events.push({ type: 'combo', combo: this.comboValue, bestCombo: this.bestComboValue, atMs });
  }
}

function cleanName(name: string): string {
  return name.normalize('NFC').trim().slice(0, 40) || 'Singer';
}

function boundedScore(value: number): number {
  return Math.max(0, Math.min(KARAOKE_MAX_SCORE, Math.round(value)));
}

function isJudgment(value: unknown): value is KaraokeJudgment {
  return value === 'perfect' || value === 'good' || value === 'miss';
}
