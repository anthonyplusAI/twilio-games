import { describe, expect, it } from 'vitest';
import { KaraokeRoom } from '../server/karaoke-room';
import { KARAOKE_SONG_DURATION_MS, type KaraokeSong } from '../shared/karaoke';
import { NEVER_GONNA_GIVE_YOU_UP, PT_BR_ORIGINAL_DEVELOPMENT_SONG } from '../shared/karaoke-songs';
import { KARAOKE_COUNTDOWN_MS, KARAOKE_MAX_SCORE } from '../shared/karaoke-protocol';

function joined(room: KaraokeRoom, name = 'Ada', confirmed = true): string {
  const result = room.addPlayer(name, confirmed);
  if ('error' in result) throw new Error(result.error);
  return result.playerId;
}

function loadSong(room: KaraokeRoom, playerId: string, songId = NEVER_GONNA_GIVE_YOU_UP.id): number {
  expect(room.advance(playerId)).toBe(true);
  expect(room.selectSong(playerId, songId)).toBe(true);
  expect(room.advance(playerId)).toBe(true);
  return room.state().loadingGeneration;
}

function finalHits(song: KaraokeSong, score: number) {
  return song.chart.words.map((word, index) => ({
    wordId: word.id, judgment: index === 0 ? 'perfect' as const : 'miss' as const, points: index === 0 ? score : 0,
  }));
}

describe('authoritative karaoke room', () => {
  it('enforces one singer, a confirmed name, explicit advances, and singer-owned selection', () => {
    expect(KARAOKE_COUNTDOWN_MS).toBe(3_000);
    const room = new KaraokeRoom('VOICE');
    room.expectHumanPlayers(1);
    const singer = joined(room, 'Caller', false);
    expect(room.addPlayer('Second')).toEqual({ error: 'room_full' });
    expect(room.advance()).toBe(false);
    expect(room.advance(singer)).toBe(false);
    room.setName(singer, 'Ada');
    expect(room.phase).toBe('lobby');
    expect(room.advance()).toBe(false);
    expect(room.advance(singer)).toBe(true);
    expect(room.phase).toBe('song_select');
    expect(room.selectSong('forged', NEVER_GONNA_GIVE_YOU_UP.id)).toBe(false);
    expect(room.selectSong(singer, NEVER_GONNA_GIVE_YOU_UP.id)).toBe(true);
    expect(room.phase).toBe('song_select');
    expect(room.advance('forged')).toBe(false);
    expect(room.advance(singer)).toBe(true);
    expect(room.phase).toBe('loading');
  });

  it('offers only the locale-appropriate catalog and rejects a song from another locale', () => {
    const room = new KaraokeRoom('BR', { preferredLocale: 'pt-BR' });
    const singer = joined(room);
    room.advance();
    expect(room.catalog().map(song => song.id)).toEqual([PT_BR_ORIGINAL_DEVELOPMENT_SONG.id]);
    expect(room.selectSong(singer, NEVER_GONNA_GIVE_YOU_UP.id)).toBe(false);
    expect(room.selectSong(singer, PT_BR_ORIGINAL_DEVELOPMENT_SONG.id)).toBe(true);
    expect(room.setPreferredLocale('en-US')).toBe(false);
    expect(room.state()).toMatchObject({ preferredLocale: 'pt-BR', selectedByPlayerId: singer });
  });

  it('invalidates disclosure readiness when the singer deliberately reselects the same song', () => {
    const room = new KaraokeRoom('RESELECT');
    const singer = joined(room);
    expect(room.advance(singer)).toBe(true);
    expect(room.state().selectionGeneration).toBe(0);
    expect(room.selectSong(singer, NEVER_GONNA_GIVE_YOU_UP.id)).toBe(true);
    expect(room.state().selectionGeneration).toBe(1);
    expect(room.selectSong(singer, NEVER_GONNA_GIVE_YOU_UP.id)).toBe(true);
    expect(room.state().selectionGeneration).toBe(2);
    expect(room.selectSong('stale', NEVER_GONNA_GIVE_YOU_UP.id)).toBe(false);
    expect(room.state().selectionGeneration).toBe(2);
  });

  it('rejects an unbound or stale caller replay without clearing the visible result', () => {
    let now = 0;
    const room = new KaraokeRoom('REPLAY-GATE', { now: () => now });
    const singer = joined(room);
    const generation = loadSong(room, singer);
    expect(room.ready(generation)).toBe(true);
    now = KARAOKE_COUNTDOWN_MS + KARAOKE_SONG_DURATION_MS;
    room.tick();
    expect(room.finalizeMediaScore(singer, 1_000, finalHits(room.state().selectedSong!, 1_000))).toBe(true);
    const before = room.state().result;
    expect(room.advance()).toBe(false);
    expect(room.advance('stale')).toBe(false);
    expect(room.state().result).toBe(before);
    expect(room.advance(singer)).toBe(true);
  });

  it('accepts display readiness only for the current loading generation', () => {
    let now = 1_000;
    const room = new KaraokeRoom('READY', { now: () => now });
    room.expectHumanPlayers(1);
    const singer = joined(room);
    const generation = loadSong(room, singer);
    expect(room.ready(generation + 1)).toBe(false);
    expect(room.retryLoading(generation)).toBe(true);
    expect(room.state().loadingGeneration).toBe(generation + 1);
    expect(room.ready(generation)).toBe(false);
    expect(room.ready(generation + 1)).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'loading',
      displayReady: true,
      countdownEndsAtMs: null,
    });
    expect(room.invalidateDisplayReady()).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'loading', loadingGeneration: generation + 2, countdownEndsAtMs: null });
    expect(room.invalidateDisplayReady()).toBe(false);
  });

  it('returns a stalled loading round to song selection after a bounded timeout', () => {
    let now = 1_000;
    const room = new KaraokeRoom('TIMEOUT', { now: () => now, loadingTimeoutMs: 2_000 });
    const singer = joined(room);
    const generation = loadSong(room, singer);
    expect(room.isTimingActive).toBe(true);
    now += 1_999;
    expect(room.tick()).toBe(false);
    now += 1;
    expect(room.tick()).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'song_select', loadingGeneration: generation + 1,
      selectedSong: { id: NEVER_GONNA_GIVE_YOU_UP.id },
      displayReady: false, mediaReady: false,
    });
    expect(room.drainEvents()).toEqual([
      { type: 'loading_timeout', generation, displayReady: false, mediaReady: false, atMs: now },
    ]);
  });

  it('keeps automatic setup loading until display and authenticated media are both ready', () => {
    let now = 5_000;
    const room = new KaraokeRoom('DUAL', { now: () => now });
    room.expectHumanPlayers(1);
    const singer = joined(room);
    const generation = loadSong(room, singer);

    expect(room.ready(generation)).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'loading', displayReady: true, mediaReady: false, mediaSongStartTimestampMs: null,
    });
    now = 5_250;
    expect(room.mediaReady(singer, NEVER_GONNA_GIVE_YOU_UP.id, generation, KARAOKE_COUNTDOWN_MS - 1)).toBe(false);
    expect(room.mediaReady(singer, NEVER_GONNA_GIVE_YOU_UP.id, generation, KARAOKE_COUNTDOWN_MS)).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'countdown', displayReady: true, mediaReady: true,
      mediaSongStartTimestampMs: KARAOKE_COUNTDOWN_MS,
      countdownEndsAtMs: now + KARAOKE_COUNTDOWN_MS,
    });

    const mediaFirst = new KaraokeRoom('MEDIA-FIRST', { now: () => now });
    mediaFirst.expectHumanPlayers(1);
    const secondSinger = joined(mediaFirst);
    const secondGeneration = loadSong(mediaFirst, secondSinger);
    expect(mediaFirst.mediaReady(
      secondSinger, NEVER_GONNA_GIVE_YOU_UP.id, secondGeneration, KARAOKE_COUNTDOWN_MS,
    )).toBe(true);
    now += 400;
    expect(mediaFirst.ready(secondGeneration)).toBe(true);
    expect(mediaFirst.state()).toMatchObject({
      phase: 'countdown', mediaSongStartTimestampMs: KARAOKE_COUNTDOWN_MS,
      countdownEndsAtMs: now + KARAOKE_COUNTDOWN_MS,
    });
  });

  it('anchors countdown and performance to absolute deadlines even when a tick arrives late', () => {
    let now = 10_000;
    const room = new KaraokeRoom('CLOCK', { now: () => now });
    const singer = joined(room);
    const generation = loadSong(room, singer);
    room.ready(generation);
    const countdownEndsAt = now + KARAOKE_COUNTDOWN_MS;
    now = countdownEndsAt + 1_250;
    expect(room.tick()).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'performing',
      performanceStartedAtMs: countdownEndsAt,
      performanceEndsAtMs: countdownEndsAt + KARAOKE_SONG_DURATION_MS,
    });
    expect(room.drainEvents()).toEqual([
      { type: 'countdown', count: 3, atMs: 10_000 },
      { type: 'countdown', count: 2, atMs: 11_000 },
      { type: 'countdown', count: 1, atMs: 12_000 },
      { type: 'start', startedAtMs: countdownEndsAt, endsAtMs: countdownEndsAt + KARAOKE_SONG_DURATION_MS },
    ]);
  });

  it('records each chart judgment once, maintains combo, and bounds trusted score updates', () => {
    let now = 0;
    const room = new KaraokeRoom('SCORE', { now: () => now });
    const singer = joined(room);
    room.ready(loadSong(room, singer));
    now = KARAOKE_COUNTDOWN_MS;
    room.tick();
    room.drainEvents();
    const [first, second, third] = NEVER_GONNA_GIVE_YOU_UP.chart.words;
    expect(room.recordHit('forged', { wordId: first!.id, judgment: 'perfect', points: 100 })).toBe(false);
    expect(room.recordHit(singer, { wordId: 'missing', judgment: 'perfect', points: 100 })).toBe(false);
    expect(room.recordHit(singer, { wordId: first!.id, judgment: 'perfect', points: 600 })).toBe(true);
    expect(room.recordHit(singer, { wordId: first!.id, judgment: 'perfect', points: 600 })).toBe(false);
    expect(room.recordHit(singer, { wordId: second!.id, judgment: 'good', points: 400 })).toBe(true);
    expect(room.recordHit(singer, { wordId: third!.id, judgment: 'miss', points: 500 })).toBe(true);
    expect(room.state()).toMatchObject({ score: 1_000, combo: 0, bestCombo: 2 });
    expect(room.updateScore(singer, KARAOKE_MAX_SCORE + 50_000)).toBe(true);
    expect(room.state().score).toBe(KARAOKE_MAX_SCORE);
    expect(room.updateScore(singer, -50)).toBe(true);
    expect(room.state().score).toBe(0);
    expect(room.drainEvents().filter(event => event.type === 'word_judgment')).toHaveLength(3);
    expect(room.drainEvents()).toEqual([]);
  });

  it('scores server-timed keyboard lanes and finalizes a hidden local test performance', () => {
    let now = 0;
    const room = new KaraokeRoom('KEYBOARD', { now: () => now });
    const singer = joined(room);
    expect(room.enableKeyboardScoring('forged')).toBe(false);
    expect(room.enableKeyboardScoring(singer)).toBe(true);
    const generation = loadSong(room, singer);
    expect(room.ready(generation)).toBe(true);
    const startedAt = KARAOKE_COUNTDOWN_MS;
    const first = NEVER_GONNA_GIVE_YOU_UP.chart.words[0]!;
    now = startedAt + first.startMs;
    room.tick();
    room.drainEvents();
    expect(room.keyboardLane('forged', first.lane)).toBe(false);
    expect(room.keyboardLane(singer, first.lane)).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'performing', combo: 1, bestCombo: 1 });
    expect(room.state().score).toBeGreaterThan(0);
    expect(room.drainEvents().find(event => event.type === 'word_judgment')).toMatchObject({
      wordId: first.id, judgment: 'perfect',
    });

    now = startedAt + KARAOKE_SONG_DURATION_MS;
    expect(room.tick()).toBe(true);
    expect(room.state()).toMatchObject({
      phase: 'results', result: { playerId: singer, score: room.state().score, bestCombo: 1 },
    });
    expect(room.drainEvents().at(-1)).toMatchObject({ type: 'result' });
  });

  it('creates and emits exactly one immutable result at the authoritative end time', () => {
    let now = 5_000;
    const room = new KaraokeRoom('RESULT', { now: () => now });
    const singer = joined(room);
    room.ready(loadSong(room, singer));
    const startedAt = now + KARAOKE_COUNTDOWN_MS;
    now = startedAt;
    room.tick();
    const [first, second] = room.state().selectedSong!.chart.words;
    room.recordHit(singer, first!.id, 'perfect', 100);
    room.recordHit(singer, second!.id, 'perfect', 100);
    expect(room.state().bestCombo).toBe(2);
    room.updateScore(singer, 88_888);
    room.drainEvents();
    now = startedAt + KARAOKE_SONG_DURATION_MS + 9_999;
    expect(room.tick()).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'finalizing', result: null });
    expect(room.updateScore(singer, 1)).toBe(false);
    expect(room.finalizeMediaScore(singer, 88_888, finalHits(room.state().selectedSong!, 88_888))).toBe(true);
    const result = room.state().result;
    expect(result).toMatchObject({
      playerId: singer,
      score: 88_888,
      bestCombo: 1,
      completedAtMs: startedAt + KARAOKE_SONG_DURATION_MS,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(room.drainEvents()).toEqual([{ type: 'result', result }]);
    expect(room.setName(singer, 'PLAYER')).toBe(true);
    expect(room.state().result).toMatchObject({ name: 'PLAYER' });
    expect(Object.isFrozen(room.state().result)).toBe(true);
    expect(room.tick()).toBe(false);
    expect(room.drainEvents()).toEqual([]);
    expect(room.updateScore(singer, 1)).toBe(false);
    expect(room.advance(singer)).toBe(true);
    expect(room.state()).toMatchObject({ phase: 'song_select', selectedSong: null, result: null, score: 0 });
  });

  it('resets active state when the singer really leaves', () => {
    const room = new KaraokeRoom('LEAVE');
    const singer = joined(room);
    loadSong(room, singer);
    room.removePlayer('forged');
    expect(room.phase).toBe('loading');
    room.removePlayer(singer);
    expect(room.state()).toMatchObject({ phase: 'lobby', singer: null, selectedSong: null, automaticSetup: false });
    expect(room.isEmpty).toBe(true);
  });
});
