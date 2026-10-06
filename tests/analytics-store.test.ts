import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { AnalyticsStore, dateRange, validDate } from '../server/analytics-store';
import { AnalyticsObserver } from '../server/analytics-observer';
import { KaraokeRoom } from '../server/karaoke-room';
import { TriviaRoom } from '../server/trivia-room';
import { ChessRoom } from '../server/chess-room';
import { analyticsPdf } from '../server/analytics-pdf';
import { ANALYTICS_GAMES } from '../shared/analytics';
import { EN_US_ORIGINAL_DEVELOPMENT_SONG } from '../shared/karaoke-songs';
import type { KaraokeSong } from '../shared/karaoke';
import { parseTriviaQuestionBankJson } from '../shared/trivia';

const files: string[] = [];
afterEach(async () => { await Promise.all(files.splice(0).map(file => rm(file, { force: true }))); });
const triviaBank = parseTriviaQuestionBankJson(
  readFileSync(new URL('../content/trivia/questions.json', import.meta.url), 'utf8'),
);
const finalHits = (song: KaraokeSong, score: number) => song.chart.words.map((word, index) => ({
  wordId: word.id, judgment: index === 0 ? 'perfect' as const : 'miss' as const, points: index === 0 ? score : 0,
}));

describe('activation analytics', () => {
  it('records an anonymous Voice Chess match and accepted speech without a leaderboard', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-chess.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    let now = Date.parse(`${today}T12:00:00Z`);
    const store = new AnalyticsStore(file, 'secret');
    const observer = new AnalyticsObserver(store, () => now);
    const room = new ChessRoom('CHESS', { humanColor: 'w' });
    observer.chessState(room);
    room.setPlayerConnected(true);
    observer.chessState(room);
    observer.voiceCommand('chess');
    now += 31_000;
    observer.chessAborted(room.code);
    await store.flush();

    const report = store.report(today, today, 'chess');
    expect(report.summary).toMatchObject({ participants: 1, sessions: 1, abandoned: 1, playSeconds: 31, voiceCommands: 1 });
    expect(report.games.chess.sessions).toBe(1);
  });

  it('counts distinct Voice Chess callers in a reused room without persisting call IDs', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-chess-callers.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    let now = Date.parse(`${today}T12:00:00Z`);
    const store = new AnalyticsStore(file, 'secret');
    const observer = new AnalyticsObserver(store, () => now);
    const room = new ChessRoom('CHESS', { humanColor: 'w', random: () => 0 });

    for (const callSid of ['CA-first-caller', 'CA-second-caller', 'CA-second-caller']) {
      room.setPlayerConnected(true);
      observer.chessState(room);
      observer.chessBound(room.code, callSid);
      now += 10_000;
      observer.chessAborted(room.code);
      room.setPlayerConnected(false);
      room.reset();
    }
    await store.flush();

    expect(store.report(today, today, 'chess').summary).toMatchObject({
      participants: 2, sessions: 3, completed: 0, abandoned: 3, playSeconds: 30,
    });
    const persisted = readFileSync(file, 'utf8');
    expect(persisted).not.toMatch(/CA-first-caller|CA-second-caller|CHESS/);
  });

  it('finalizes a Chess checkmate once and tracks a replay as a separate abandoned session', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-chess-lifecycle.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    let now = Date.parse(`${today}T12:00:00Z`);
    const store = new AnalyticsStore(file, 'secret');
    const observer = new AnalyticsObserver(store, () => now);
    const room = new ChessRoom('MATE', {
      initialFen: '7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1', humanColor: 'w', random: () => 0,
    });
    room.setPlayerConnected(true);
    observer.chessState(room);
    observer.chessBound(room.code, 'CA-same-caller');
    expect(room.handleVoiceCommand('queen from G six to G seven').code).toBe('proposed');
    observer.chessState(room);
    now += 14_000;
    expect(room.handleVoiceCommand('confirm').code).toBe('confirmed');
    expect(room.state().result).toEqual({ reason: 'checkmate', winner: 'w' });
    observer.chessState(room);
    observer.chessState(room);
    observer.chessAborted(room.code);

    room.reset();
    observer.chessState(room);
    observer.chessBound(room.code, 'CA-same-caller');
    now += 9_000;
    observer.chessAborted(room.code);
    observer.chessAborted(room.code);
    await store.flush();

    expect(store.report(today, today, 'chess').summary).toMatchObject({
      participants: 1, sessions: 2, completed: 1, abandoned: 1, playSeconds: 23,
    });
  });

  it('persists anonymous daily rollups and aggregates a range', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}.json`; files.push(file);
    const store = new AnalyticsStore(file, 'secret');
    const today = new Date().toISOString().slice(0, 10), at = Date.parse(`${today}T12:00:00Z`);
    store.recordMatch({ game: 'racer', participantIds: ['room:p1', 'room:p2'], durationSeconds: 91.4,
      completed: true, map: 'neon-city', vehicles: ['Roadster', 'Truck'], at });
    store.recordMatch({ game: 'fighter', participantIds: ['fight:f1'], durationSeconds: 45,
      completed: false, map: 'rain', characters: ['nyx', 'wraith'], at });
    store.recordVoiceCommand('fighter', at); await store.flush();

    const reloaded = new AnalyticsStore(file, 'secret'); await reloaded.load();
    const report = reloaded.report(today, today);
    expect(report.summary).toMatchObject({ participants: 3, sessions: 2, completed: 1, abandoned: 1, playSeconds: 136, voiceCommands: 1 });
    expect(report.games.racer.completionRate).toBe(1);
    expect(report.games.karaoke.sessions).toBe(0);
    expect(ANALYTICS_GAMES).toEqual(['racer', 'monsters', 'fighter', 'karaoke', 'trivia', 'chess']);
    expect(report.selections.maps.map(item => item.name)).toEqual(['neon-city', 'rain']);
    expect(JSON.stringify(await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8')))).not.toContain('room:p1');
  });

  it('adds Karaoke buckets to existing version-1 days without losing old metrics', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-legacy.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    const empty = { participants: [], sessions: 0, completed: 0, abandoned: 0, playSeconds: 0,
      voiceCommands: 0, maps: {}, characters: {}, vehicles: {} };
    await writeFile(file, JSON.stringify({ version: 1, days: {
      [today]: { games: { racer: { ...empty, sessions: 2 }, monsters: empty, fighter: empty } },
    } }));
    const store = new AnalyticsStore(file, 'secret');
    await store.load();
    store.recordVoiceCommand('karaoke', Date.parse(`${today}T12:00:00Z`));
    await store.flush();

    const report = store.report(today, today);
    expect(report.games.racer.sessions).toBe(2);
    expect(report.games.karaoke.voiceCommands).toBe(1);
  });

  it('lazily adds Trivia/category buckets to version-1 days without losing old metrics', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-legacy-trivia.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    const empty = { participants: [], sessions: 0, completed: 0, abandoned: 0, playSeconds: 0,
      voiceCommands: 0, maps: {}, songs: {}, characters: {}, vehicles: {} };
    await writeFile(file, JSON.stringify({ version: 1, days: {
      [today]: { games: { racer: { ...empty, sessions: 2 }, monsters: empty, fighter: empty, karaoke: empty } },
    } }));
    const store = new AnalyticsStore(file, 'secret');
    await store.load();
    store.recordMatch({ game: 'trivia', participantIds: ['trivia:ROOM:slot:0'], durationSeconds: 10,
      completed: true, category: 'science', at: Date.parse(`${today}T12:00:00Z`) });
    await store.flush();

    const report = store.report(today, today, 'trivia');
    expect(report.summary).toMatchObject({ participants: 1, sessions: 1, completed: 1 });
    expect(report.games.racer.sessions).toBe(2);
    expect(report.selections.categories).toEqual([{ name: 'science', count: 1 }]);
    expect(JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8'))).version).toBe(1);
  });

  it('records each Trivia generation once with room-scoped slots, categories, and accepted command counts', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-trivia.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    let now = Date.parse(`${today}T12:00:00Z`);
    const store = new AnalyticsStore(file, 'secret');
    const observer = new AnalyticsObserver(store, () => now);
    const room = new TriviaRoom('QUIZ', { bank: triviaBank, now: () => now, countdownMs: 1,
      questionPromptTimeoutMs: 1, answerCueTimeoutMs: 1, finalAnswerGraceMs: 0, revealMs: 1 });
    const first = room.addPlayer('Private Ada');
    const second = room.addPlayer('Private Grace');
    if ('error' in first || 'error' in second) throw new Error('players did not join');
    room.advance();
    room.voteCategory(first.playerId, 'science');
    room.voteCategory(second.playerId, 'science');
    room.advance();
    observer.triviaState(room);
    observer.triviaState(room);
    observer.voiceCommand('trivia');
    observer.voiceCommand('trivia');

    expect(room.retryLoading(room.state().loadingGeneration)).toBe(true);
    observer.triviaState(room);
    observer.triviaState(room);
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    now = room.state().countdownEndsAtMs!;
    room.tick();
    for (let questionIndex = 0; questionIndex < 8; questionIndex++) {
      now = room.state().questionEndsAtMs!;
      room.tick();
      now = room.state().revealEndsAtMs!;
      room.tick();
    }
    observer.triviaState(room);
    observer.triviaState(room);

    room.advance();
    room.voteCategory(first.playerId, 'history');
    room.voteCategory(second.playerId, 'history');
    room.advance();
    observer.triviaState(room);
    now += 5_000;
    observer.triviaAborted(room.code);
    observer.triviaAborted(room.code);
    await store.flush();

    const report = store.report(today, today, 'trivia');
    expect(report.filter).toBe('trivia');
    expect(report.summary).toMatchObject({
      participants: 2, sessions: 3, completed: 1, abandoned: 2, voiceCommands: 2,
    });
    expect(report.games.trivia).toEqual(report.summary);
    expect(report.selections.categories).toEqual([
      { name: 'science', count: 2 }, { name: 'history', count: 1 },
    ]);
    expect(report.selections.maps).toEqual([]);
    const persisted = await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8'));
    expect(persisted).not.toMatch(/Private Ada|Private Grace|question|answer|transcript|QUIZ|slot/i);
  });

  it('records Karaoke generations, song selection, completion, abandonment, and semantic setup actions', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-karaoke.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    let now = Date.parse(`${today}T12:00:00Z`);
    const store = new AnalyticsStore(file, 'secret');
    const observer = new AnalyticsObserver(store, () => now);
    const room = new KaraokeRoom('SING', {
      now: () => now,
      songs: [EN_US_ORIGINAL_DEVELOPMENT_SONG],
      countdownMs: 3_000,
    });
    const singer = room.addPlayer('Ada');
    if ('error' in singer) throw new Error(singer.error);
    expect(room.advance(singer.playerId)).toBe(true);
    expect(room.selectSong(singer.playerId, EN_US_ORIGINAL_DEVELOPMENT_SONG.id)).toBe(true);
    observer.karaokeSetupAction('select_song');
    expect(room.advance(singer.playerId)).toBe(true);
    observer.karaokeSetupAction('start_song');
    observer.karaokeSetupAction('raw lyric transcript' as never);
    observer.karaokeState(room);
    now += 12_000;
    const firstGeneration = room.state().loadingGeneration;
    expect(room.retryLoading(firstGeneration)).toBe(true);
    observer.karaokeState(room);
    now += 8_000;
    expect(store.report(today, today).games.karaoke).toMatchObject({ sessions: 0, abandoned: 0, playSeconds: 0 });
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    observer.karaokeState(room);
    expect(store.report(today, today).games.karaoke.sessions).toBe(0);
    now += 3_000;
    room.tick();
    now += 7_000;
    observer.karaokeState(room);
    now += EN_US_ORIGINAL_DEVELOPMENT_SONG.durationMs - 7_000;
    room.tick();
    observer.karaokeState(room);
    expect(room.finalizeMediaScore(singer.playerId, 42_000, finalHits(room.state().selectedSong!, 42_000))).toBe(true);
    observer.karaokeState(room);

    expect(room.advance(singer.playerId)).toBe(true);
    expect(room.selectSong(singer.playerId, EN_US_ORIGINAL_DEVELOPMENT_SONG.id)).toBe(true);
    expect(room.advance(singer.playerId)).toBe(true);
    observer.karaokeState(room);
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    observer.karaokeState(room);
    now += 3_000;
    room.tick();
    observer.karaokeState(room);
    now += 45_000;
    room.removePlayer(singer.playerId);
    observer.karaokeState(room);
    await store.flush();

    const report = store.report(today, today);
    expect(report.games.karaoke).toMatchObject({
      participants: 1, sessions: 2, completed: 1, abandoned: 1,
      playSeconds: EN_US_ORIGINAL_DEVELOPMENT_SONG.durationMs / 1_000 + 45, voiceCommands: 2,
    });
    expect(report.selections.songs).toEqual([{ name: EN_US_ORIGINAL_DEVELOPMENT_SONG.id, count: 2 }]);
    const persisted = await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8'));
    expect(persisted).toContain(EN_US_ORIGINAL_DEVELOPMENT_SONG.id);
    expect(persisted).not.toMatch(/Ada|Neon Hello|audioUrl|chart|word_judgment|lyrics/i);
  });

  it('ignores pre-performance hard aborts and finalizes an active Karaoke performance once', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-abort.json`; files.push(file);
    const today = new Date().toISOString().slice(0, 10);
    let now = Date.parse(`${today}T15:00:00Z`);
    const store = new AnalyticsStore(file, 'secret');
    const observer = new AnalyticsObserver(store, () => now);
    const room = new KaraokeRoom('ABORT', {
      now: () => now, songs: [EN_US_ORIGINAL_DEVELOPMENT_SONG], countdownMs: 3_000,
    });
    const singer = room.addPlayer('Ada');
    if ('error' in singer) throw new Error(singer.error);
    room.advance(singer.playerId);
    room.selectSong(singer.playerId, EN_US_ORIGINAL_DEVELOPMENT_SONG.id);
    room.advance(singer.playerId);
    observer.karaokeState(room);
    observer.karaokeAborted(room.code);
    expect(store.report(today, today).games.karaoke.sessions).toBe(0);

    room.ready(room.state().loadingGeneration);
    now += 3_000;
    room.tick();
    observer.karaokeState(room);
    now += 45_000;
    observer.karaokeAborted(room.code);
    observer.karaokeAborted(room.code);
    await store.flush();

    expect(store.report(today, today).games.karaoke).toMatchObject({
      participants: 1, sessions: 1, completed: 0, abandoned: 1, playSeconds: 45,
    });
  });

  it('validates bounded UTC date ranges', () => {
    expect(validDate('2026-07-14')).toBe('2026-07-14');
    expect(validDate('2026-02-30')).toBeNull();
    expect(validDate('nope')).toBeNull();
    expect(dateRange('2026-07-13', '2026-07-15')).toEqual(['2026-07-13', '2026-07-14', '2026-07-15']);
    expect(() => dateRange('2026-07-15', '2026-07-13')).toThrow();
  });

  it('creates a downloadable PDF with visible abandonment and sub-minute play time', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-pdf.json`; files.push(file);
    const store = new AnalyticsStore(file, 'secret');
    store.recordMatch({ game: 'karaoke', participantIds: ['karaoke:room:p1'], durationSeconds: 45,
      completed: false, song: 'short-song', at: Date.parse('2026-07-14T12:00:00Z') });
    await store.flush();
    const report = store.report('2026-07-14', '2026-07-14');
    const pdf = analyticsPdf(report);
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.toString()).toContain('TWILIO GAMES');
    expect(pdf.toString()).toContain('Abandoned: 1');
    expect(pdf.toString()).toContain('Active play time: 45s');
    expect(pdf.toString()).toContain('%%EOF');
    expect(report.insights).toContain('1 session was abandoned before completion.');
  });

  it('renders Trivia filters, categories, and labels in reports and PDFs', async () => {
    const file = `data/_test-analytics-${process.pid}-${Date.now()}-trivia-pdf.json`; files.push(file);
    const store = new AnalyticsStore(file, 'secret');
    store.recordMatch({ game: 'trivia', participantIds: ['trivia:room:slot:0'], durationSeconds: 80,
      completed: true, category: 'technology', at: Date.parse('2026-07-14T12:00:00Z') });
    await store.flush();
    const report = store.report('2026-07-14', '2026-07-14', 'trivia');
    const pdf = analyticsPdf(report).toString();
    expect(report.selections.categories).toEqual([{ name: 'technology', count: 1 }]);
    expect(pdf).toContain('Voice Trivia');
    expect(pdf).toContain('Categories: technology \\(1\\)');
  });

  it('offers Karaoke and Trivia in the private analytics dashboard', () => {
    const html = readFileSync(new URL('../client/analytics/index.html', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../client/analytics/analytics.ts', import.meta.url), 'utf8');
    expect(html).toContain('<option value="karaoke">Voice Karaoke</option>');
    expect(html).toContain('<option value="trivia">Voice Trivia</option>');
    expect(client).toContain("karaoke:'Karaoke'");
    expect(client).toContain("trivia:'Trivia'");
    expect(client).toContain("['Categories',report.selections.categories]");
    expect(client).toContain("'Abandoned sessions'");
    expect(client).toContain('return `${total}s`');
  });
});
