import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { ANALYTICS_GAMES, type AnalyticsGame, type AnalyticsGameMetrics, type AnalyticsReport } from '../shared/analytics';

interface GameBucket {
  participants: string[];
  sessions: number;
  completed: number;
  abandoned: number;
  playSeconds: number;
  voiceCommands: number;
  maps: Record<string, number>;
  songs: Record<string, number>;
  categories: Record<string, number>;
  characters: Record<string, number>;
  vehicles: Record<string, number>;
}

interface DayBucket { games: Record<AnalyticsGame, GameBucket>; }
interface AnalyticsFile { version: 1; days: Record<string, DayBucket>; }

export interface MatchRecord {
  game: AnalyticsGame;
  participantIds: string[];
  durationSeconds: number;
  completed: boolean;
  map?: string | null;
  song?: string | null;
  category?: string | null;
  characters?: string[];
  vehicles?: string[];
  at?: number;
}

const MAX_DAYS = 730;

export class AnalyticsStore {
  private data: AnalyticsFile = { version: 1, days: {} };
  private writeQueue: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly file: string, private readonly salt: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AnalyticsFile>;
      if (parsed.version === 1 && parsed.days && typeof parsed.days === 'object') this.data = parsed as AnalyticsFile;
    } catch { /* first boot or invalid file: begin with an empty rollup */ }
  }

  recordMatch(record: MatchRecord): void {
    const day = this.day(record.at);
    const bucket = day.games[record.game];
    for (const id of record.participantIds) {
      const anonymous = this.anonymize(id);
      if (!bucket.participants.includes(anonymous)) bucket.participants.push(anonymous);
    }
    bucket.sessions++;
    if (record.completed) bucket.completed++; else bucket.abandoned++;
    bucket.playSeconds += Math.max(0, Math.round(record.durationSeconds));
    increment(bucket.maps, record.map);
    increment(bucket.songs, record.song);
    increment(bucket.categories, record.category);
    for (const character of record.characters ?? []) increment(bucket.characters, character);
    for (const vehicle of record.vehicles ?? []) increment(bucket.vehicles, vehicle);
    this.persist();
  }

  recordVoiceCommand(game: AnalyticsGame, at = Date.now()): void {
    this.day(at).games[game].voiceCommands++;
    this.persist();
  }

  report(from: string, to: string, filter: AnalyticsGame | 'all' = 'all'): AnalyticsReport {
    const dates = dateRange(from, to);
    const games = Object.fromEntries(ANALYTICS_GAMES.map(game => [game, this.metrics(dates, game)])) as Record<AnalyticsGame, AnalyticsGameMetrics>;
    const selected = filter === 'all' ? ANALYTICS_GAMES : [filter];
    const summary = this.combinedMetrics(dates, selected);
    const dimensions = { maps: {} as Record<string, number>, songs: {} as Record<string, number>, categories: {} as Record<string, number>, characters: {} as Record<string, number>, vehicles: {} as Record<string, number> };
    for (const date of dates) for (const game of selected) {
      const bucket = this.data.days[date]?.games[game];
      if (!bucket) continue;
      mergeCounts(dimensions.maps, bucket.maps);
      mergeCounts(dimensions.songs, bucket.songs ?? {});
      mergeCounts(dimensions.categories, bucket.categories ?? {});
      mergeCounts(dimensions.characters, bucket.characters);
      mergeCounts(dimensions.vehicles, bucket.vehicles);
    }
    const trend = dates.map(date => {
      const dayMetrics = this.combinedMetrics([date], selected);
      return { date, participants: dayMetrics.participants, sessions: dayMetrics.sessions,
        completed: dayMetrics.completed, playSeconds: dayMetrics.playSeconds, voiceCommands: dayMetrics.voiceCommands };
    });
    return {
      generatedAt: new Date().toISOString(), range: { from, to, days: dates.length }, filter, summary, games, trend,
      selections: { maps: ranked(dimensions.maps), songs: ranked(dimensions.songs), categories: ranked(dimensions.categories), characters: ranked(dimensions.characters), vehicles: ranked(dimensions.vehicles) },
      insights: insights(summary, games, filter),
    };
  }

  async flush(): Promise<void> {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; this.enqueueWrite(); }
    await this.writeQueue;
  }

  private metrics(dates: string[], game: AnalyticsGame): AnalyticsGameMetrics {
    return this.combinedMetrics(dates, [game]);
  }

  private combinedMetrics(dates: string[], games: readonly AnalyticsGame[]): AnalyticsGameMetrics {
    const people = new Set<string>();
    let sessions = 0, completed = 0, abandoned = 0, playSeconds = 0, voiceCommands = 0;
    for (const date of dates) for (const game of games) {
      const bucket = this.data.days[date]?.games[game];
      if (!bucket) continue;
      for (const id of bucket.participants) people.add(id);
      sessions += bucket.sessions; completed += bucket.completed; abandoned += bucket.abandoned;
      playSeconds += bucket.playSeconds; voiceCommands += bucket.voiceCommands;
    }
    return { participants: people.size, sessions, completed, abandoned, playSeconds, voiceCommands,
      completionRate: sessions ? completed / sessions : 0, averageSessionSeconds: sessions ? playSeconds / sessions : 0 };
  }

  private day(at = Date.now()): DayBucket {
    const key = new Date(at).toISOString().slice(0, 10);
    this.data.days[key] ??= { games: Object.fromEntries(ANALYTICS_GAMES.map(game => [game, emptyBucket()])) as Record<AnalyticsGame, GameBucket> };
    const day = this.data.days[key]!;
    // Older version-1 rollups predate newer games and are upgraded lazily without dropping metrics.
    for (const game of ANALYTICS_GAMES) {
      day.games[game] ??= emptyBucket();
      day.games[game]!.songs ??= {};
      day.games[game]!.categories ??= {};
    }
    return day;
  }

  private anonymize(id: string): string {
    return createHash('sha256').update(`${this.salt}:${id}`).digest('hex').slice(0, 20);
  }

  private persist(): void {
    const cutoff = new Date(Date.now() - MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const date of Object.keys(this.data.days)) if (date < cutoff) delete this.data.days[date];
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.enqueueWrite(); }, 250);
    (this.persistTimer as { unref?: () => void }).unref?.();
  }

  private enqueueWrite(): void {
    const snapshot = JSON.stringify(this.data);
    this.writeQueue = this.writeQueue.then(async () => {
      const dir = path.dirname(this.file); if (dir !== '.') await mkdir(dir, { recursive: true });
      const temp = `${this.file}.tmp-${process.pid}`;
      await writeFile(temp, snapshot); await rename(temp, this.file);
    }).catch(error => console.error('[analytics] persist failed:', (error as Error).message));
  }
}

function emptyBucket(): GameBucket {
  return { participants: [], sessions: 0, completed: 0, abandoned: 0, playSeconds: 0, voiceCommands: 0,
    maps: {}, songs: {}, categories: {}, characters: {}, vehicles: {} };
}
function increment(counts: Record<string, number>, value?: string | null): void { if (value) counts[value] = (counts[value] ?? 0) + 1; }
function mergeCounts(target: Record<string, number>, source: Record<string, number>): void { for (const [key, count] of Object.entries(source)) target[key] = (target[key] ?? 0) + count; }
function ranked(counts: Record<string, number>): { name: string; count: number }[] { return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10); }

export function validDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
export function dateRange(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > 366 * 86_400_000) throw new Error('date range must be 1 to 366 days');
  const out: string[] = []; for (let at = start; at <= end; at += 86_400_000) out.push(new Date(at).toISOString().slice(0, 10)); return out;
}

function insights(summary: AnalyticsGameMetrics, games: Record<AnalyticsGame, AnalyticsGameMetrics>, filter: AnalyticsGame | 'all'): string[] {
  if (!summary.sessions) return ['No completed activation sessions were recorded for this range.'];
  const out = [`${summary.participants} participants started ${summary.sessions} sessions with a ${Math.round(summary.completionRate * 100)}% completion rate.`];
  if (filter === 'all') {
    const best = ANALYTICS_GAMES.map(game => ({ game, sessions: games[game].sessions })).sort((a, b) => b.sessions - a.sessions)[0]!;
    out.push(`${label(best.game)} led engagement with ${best.sessions} sessions.`);
  }
  if (summary.abandoned) {
    out.push(`${summary.abandoned} ${summary.abandoned === 1 ? 'session was' : 'sessions were'} abandoned before completion.`);
  }
  out.push(`Average active play time was ${Math.round(summary.averageSessionSeconds)} seconds per session.`);
  if (summary.voiceCommands) out.push(`Players issued ${summary.voiceCommands} accepted voice commands during the activation.`);
  return out;
}
const GAME_LABELS: Readonly<Record<AnalyticsGame, string>> = {
  racer: 'Voice Racer', monsters: 'Voice Monsters', fighter: 'Voice Fighter', karaoke: 'Voice Karaoke',
  trivia: 'Voice Trivia', chess: 'Voice Chess',
};
function label(game: AnalyticsGame): string { return GAME_LABELS[game]; }
