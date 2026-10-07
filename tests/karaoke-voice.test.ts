import { describe, expect, it } from 'vitest';
import {
  KaraokeVoiceSession,
  matchKaraokeSong,
  type KaraokeVoiceEndHandoff,
  type KaraokeVoiceSnapshot,
  type KaraokeSpeechOutcome,
  type KaraokeIntentRequest,
  type KaraokeIntentResult,
} from '../server/karaoke-voice';
import { KaraokeRoom } from '../server/karaoke-room';
import { KARAOKE_RUNTIME_SONGS } from '../shared/karaoke-songs';
import type { SupportedLocale } from '../shared/i18n/locales';
import { KARAOKE_SONG_DURATION_MS, type KaraokeSong } from '../shared/karaoke';
import { KARAOKE_COUNTDOWN_MS } from '../shared/karaoke-protocol';

const finalHits = (song: KaraokeSong, score: number) => song.chart.words.map((word, index) => ({
  wordId: word.id, judgment: index === 0 ? 'perfect' as const : 'miss' as const, points: index === 0 ? score : 0,
}));

describe('KaraokeVoiceSession', () => {
  it('never starts Media Stream scoring when disclosure playback was unverified', () => {
    const game = karaokeVoiceGame('en-US', false, true);
    const singer = game.connect('CA-UNVERIFIED');
    singer.prompt('Ada');
    singer.prompt('song one');
    singer.prompt('start');
    expect(game.room.phase).toBe('song_select');
    expect(game.handoffs).toHaveLength(0);
  });

  it('does not replay optional loading speech when the caller barges in', async () => {
    const game = karaokeVoiceGame('en-US', true);
    const singer = game.connect('CA-BARGE');
    singer.prompt('Ada');
    singer.prompt('song one');
    game.playAllSpeech();
    await Promise.resolve();
    singer.prompt('start');
    expect(game.room.phase).toBe('loading');
    const before = singer.spoken.length;
    singer.interrupt();
    expect(singer.spoken).toHaveLength(before);
  });

  it('uses the current confirmed name when a caller skips the name prompt and chooses a song', () => {
    const game = karaokeVoiceGame('en-US');
    const singer = game.connect('CA-EXTERNAL-NAME');
    expect(game.room.setName(singer.playerId, 'Ada')).toBe(true);
    expect(game.room.advance(singer.playerId)).toBe(true);
    game.stateChanged();
    singer.prompt('A Thousand Miles');
    expect(game.room.state().singer?.name).toBe('Ada');
    expect(game.room.state().selectedSong?.id).toBe('a-thousand-miles');
  });

  it('invalidates queued name and catalog speech as soon as the screen advances', () => {
    const game = karaokeVoiceGame('en-US', true);
    const singer = game.connect('CA-STALE-MENU');
    const nameIndex = singer.spoken.findIndex(line => /first name/i.test(line));
    expect(singer.guards[nameIndex]?.()).toBe(true);
    singer.prompt('Ada');
    expect(singer.guards[nameIndex]?.()).toBe(false);

    const catalogIndex = singer.spoken.findIndex(line => /Available songs/i.test(line));
    expect(singer.guards[catalogIndex]?.()).toBe(true);
    singer.prompt('song one');
    expect(singer.guards[catalogIndex]?.()).toBe(false);
  });

  it('invalidates consent when a shared display reselects the same song', async () => {
    const game = karaokeVoiceGame('en-US', true);
    const singer = game.connect('CA-SAME-SONG');
    singer.prompt('Ada');
    singer.prompt('song one');
    game.playAllSpeech();
    await Promise.resolve();
    expect(game.room.selectSong(singer.playerId, 'never-gonna-give-you-up')).toBe(true);
    game.stateChanged();
    singer.prompt('start');
    expect(game.room.phase).toBe('song_select');
  });

  it('uses a later keypad start after a completed disclosure but repeats an incomplete disclosure', async () => {
    const game = karaokeVoiceGame('en-US', true);
    const singer = game.connect('CA-KEYPAD-START');
    singer.prompt('Ada');
    singer.prompt('song one');
    singer.dtmf('#');
    expect(game.room.phase).toBe('song_select');
    game.playAllSpeech();
    await Promise.resolve();
    singer.dtmf('#');
    expect(game.room.phase).toBe('loading');
  });

  it('uses a semantic choice only after validating it against the live song catalog', async () => {
    const game = karaokeVoiceGame('en-US', false, false, async () => ({
      kind: 'action', actionId: 'select_song', targetId: 'a-thousand-miles',
    }));
    const singer = game.connect('CA-SEMANTIC');
    singer.prompt('Ada');
    singer.prompt('I am in the mood for the piano-pop one');
    await flushMicrotasks();
    expect(game.room.state().selectedSong?.id).toBe('a-thousand-miles');
  });


  it('discards a late semantic choice when the screen selection changes first', async () => {
    let resolve!: (value: { kind: 'action'; actionId: string; targetId: string }) => void;
    const pending = new Promise<{ kind: 'action'; actionId: string; targetId: string }>(finish => { resolve = finish; });
    const game = karaokeVoiceGame('en-US', false, false, () => pending);
    const singer = game.connect('CA-STALE-SEMANTIC');
    singer.prompt('Ada');
    singer.prompt('Play that piano-pop one');
    expect(game.room.selectSong(singer.playerId, 'never-gonna-give-you-up')).toBe(true);
    game.stateChanged();
    const generation = game.room.state().selectionGeneration;
    resolve({ kind: 'action', actionId: 'select_song', targetId: 'a-thousand-miles' });
    await Promise.resolve();
    expect(game.room.state().selectedSong?.id).toBe('never-gonna-give-you-up');
    expect(game.room.state().selectionGeneration).toBe(generation);
  });
  it.each([
    {
      locale: 'en-US' as const,
      name: 'Ada',
      selection: 'Never Gonna Give You Up',
      title: 'Never Gonna Give You Up',
      start: 'start singing',
      gameplay: /number or title.*say Start.*watch the display.*each word.*target/i,
      consent: /live voice.*sent to a third-party speech recognition service.*scoring.*Say Start to consent/i,
      result: /Ada, your score is 1,234, with a best combo of 1/i,
      station: /results are on the display.*check your messages.*game coin/i,
    },
    {
      locale: 'pt-BR' as const,
      name: 'Ana',
      selection: 'número um',
      title: 'Luz no Ritmo',
      start: 'começar a cantar',
      gameplay: /número ou título.*diga Começar.*olhe para a tela.*cada palavra.*alvo/i,
      consent: /voz ao vivo.*enviada a um serviço terceirizado de reconhecimento de fala.*pontuação.*Diga Começar para consentir/i,
      result: /Ana, sua pontuação é 1\.234, com melhor combo de 1/i,
      station: /resultados estão na tela.*mensagens.*moedas do jogo/i,
    },
  ])('runs the final-only setup, explicit start, media handoff, and station result in $locale', async row => {
    const game = karaokeVoiceGame(row.locale);
    const singer = game.connect(`CA-${row.locale}`, true);

    expect(singer.spoken).toHaveLength(2);
    expect(singer.spoken.at(-1)).toMatch(row.locale === 'pt-BR' ? /primeiro nome/i : /first name/i);
    singer.prompt(row.name, false);
    expect(game.room.phase).toBe('lobby');
    singer.prompt(row.name);

    expect(game.room.phase).toBe('song_select');
    expect(game.room.hasConfirmedName(singer.playerId)).toBe(true);
    expect(singer.spoken.join(' ')).toMatch(row.gameplay);
    expect(singer.spoken.join(' ')).toContain(row.title);
    expect(singer.spoken.join(' ')).not.toContain(row.locale === 'pt-BR' ? 'Never Gonna Give You Up' : 'Luz no Ritmo');

    singer.prompt(row.selection);
    await Promise.resolve();
    expect(game.room.state().selectedSong?.title).toBe(row.title);
    expect(game.room.state().selectedByPlayerId).toBe(singer.playerId);
    expect(singer.spoken.at(-1)).toMatch(row.consent);
    singer.prompt(row.locale === 'pt-BR' ? 'sim' : 'yes');
    expect(game.room.phase).toBe('song_select');

    const beforeStartSpeech = singer.spoken.length;
    singer.prompt(row.start);
    expect(game.room.phase).toBe('loading');
    expect(singer.spoken).toHaveLength(beforeStartSpeech + 1);
    expect(singer.spoken.at(-1)).toMatch(row.locale === 'pt-BR' ? /preparando.*faixa/i : /preparing.*backing track/i);
    const afterStartSpeech = singer.spoken.length;
    expect(game.handoffs).toHaveLength(0);
    const generation = game.room.state().loadingGeneration;
    expect(game.room.ready(generation)).toBe(true);
    game.stateChanged();
    expect(game.handoffs).toHaveLength(1);
    expect(game.handoffs[0]?.type).toBe('end');
    expect(JSON.parse(game.handoffs[0]!.handoffData)).toEqual({
      reasonCode: 'karaoke-media',
      roomCode: 'VOICE',
      playerId: singer.playerId,
      songId: game.room.state().selectedSong?.id,
      loadingGeneration: game.room.state().loadingGeneration,
      locale: row.locale,
    });
    game.stateChanged();
    game.stateChanged();
    expect(game.handoffs).toHaveLength(1);

    expect(game.room.mediaReady(
      singer.playerId, game.room.state().selectedSong!.id, generation, KARAOKE_COUNTDOWN_MS,
    )).toBe(true);
    game.stateChanged();
    singer.prompt('these sung words must not be processed');
    singer.dtmf('1');
    expect(singer.spoken).toHaveLength(afterStartSpeech);

    game.setNow(KARAOKE_COUNTDOWN_MS);
    game.room.tick();
    game.stateChanged();
    singer.prompt(row.locale === 'pt-BR' ? 'cantando a letra' : 'singing the lyrics');
    singer.interrupt();
    expect(singer.spoken).toHaveLength(afterStartSpeech);

    const wordId = game.room.state().selectedSong!.chart.words[0]!.id;
    expect(game.room.recordHit(singer.playerId, wordId, 'perfect', 1_234)).toBe(true);
    game.setNow(KARAOKE_COUNTDOWN_MS + KARAOKE_SONG_DURATION_MS);
    game.room.tick();
    expect(game.room.phase).toBe('finalizing');
    expect(game.room.finalizeMediaScore(
      singer.playerId,
      game.room.state().score,
      finalHits(game.room.state().selectedSong!, game.room.state().score),
    )).toBe(true);
    game.stateChanged();
    game.stateChanged();

    expect(game.room.phase).toBe('results');
    expect(singer.spoken.join(' ')).toMatch(row.result);
    expect(singer.spoken.join(' ')).toMatch(row.station);
    expect(singer.spoken.filter(line => row.result.test(line))).toHaveLength(1);

    singer.interrupt();
    expect(singer.spoken.filter(line => row.result.test(line))).toHaveLength(1);
    expect(singer.spoken.filter(line => row.station.test(line))).toHaveLength(1);
    singer.dtmf('1');
    expect(singer.spoken.filter(line => row.result.test(line))).toHaveLength(2);
    expect(singer.spoken.filter(line => row.station.test(line))).toHaveLength(2);
    singer.prompt('...');
    expect(singer.spoken.filter(line => row.result.test(line))).toHaveLength(2);
    expect(singer.spoken.filter(line => row.station.test(line))).toHaveLength(2);
    singer.prompt('partial', false);
    expect(singer.spoken.filter(line => row.result.test(line))).toHaveLength(2);
    expect(singer.spoken.filter(line => row.station.test(line))).toHaveLength(2);
  });

  it('deduplicates repeated finals across setup boundaries and accepts a correction after interrupt', () => {
    const game = karaokeVoiceGame('en-US');
    const singer = game.connect('CA-DUPLICATE');

    singer.prompt('Ada');
    const afterName = singer.spoken.length;
    singer.prompt('Ada');
    expect(singer.spoken).toHaveLength(afterName);
    expect(game.room.state().selectedSong).toBeNull();

    singer.prompt('Never Gonna Give You Up', false);
    expect(game.room.state().selectedSong).toBeNull();
    singer.interrupt();
    singer.prompt('Never Gonna Give You Up');
    const afterSelection = singer.spoken.length;
    singer.prompt('Never Gonna Give You Up');
    expect(singer.spoken).toHaveLength(afterSelection);
    expect(game.selectionCalls).toBe(1);
  });

  it('requires completed consent disclosure but never blocks media handoff on preparation TTS', async () => {
    const game = karaokeVoiceGame('en-US', true);
    const singer = game.connect('CA-CONSENT');
    singer.prompt('Ada');
    singer.prompt('Never Gonna Give You Up');
    singer.prompt('start');
    expect(game.room.phase).toBe('song_select');

    game.playAllSpeech();
    await Promise.resolve();
    singer.prompt('start');
    expect(game.room.phase).toBe('loading');
    game.room.ready(game.room.state().loadingGeneration);
    game.stateChanged();
    expect(game.handoffs).toHaveLength(1);
    singer.prompt('is it ready');
    expect(game.handoffs).toHaveLength(1);

    game.playAllSpeech('failed');
    await Promise.resolve();
    expect(game.handoffs).toHaveLength(1);
  });

  it('accepts a conservatively estimated disclosure only before a later explicit final consent', async () => {
    const game = karaokeVoiceGame('en-US', true);
    const singer = game.connect('CA-ESTIMATED-CONSENT');
    singer.prompt('Ada');
    singer.prompt('song one');
    singer.prompt('start');
    expect(game.room.phase).toBe('song_select');

    game.playAllSpeech('estimated');
    await Promise.resolve();
    expect(game.room.phase).toBe('song_select');
    singer.prompt('start', false);
    expect(game.room.phase).toBe('song_select');
    singer.prompt('start');
    expect(game.room.phase).toBe('loading');
  });

  it('maps DTMF selection and repeat while requiring an explicit spoken start', async () => {
    const game = karaokeVoiceGame('pt-BR');
    const singer = game.connect('CA-DTMF');
    singer.dtmf('1');
    expect(game.room.phase).toBe('lobby');
    expect(singer.spoken.at(-1)).toMatch(/primeiro nome/i);

    singer.prompt('Ana');
    const beforeRepeat = singer.spoken.length;
    singer.dtmf('*');
    expect(singer.spoken.length).toBe(beforeRepeat + 1);
    singer.dtmf('1');
    expect(game.room.state().selectedSong?.title).toBe('Luz no Ritmo');
    singer.dtmf('#');
    expect(game.room.phase).toBe('song_select');
    expect(singer.spoken.at(-1)).toMatch(/Diga Começar para consentir/i);
    await Promise.resolve();
    singer.prompt('começar');

    expect(game.room.phase).toBe('loading');
    game.room.ready(game.room.state().loadingGeneration);
    game.stateChanged();
    expect(game.handoffs).toHaveLength(1);
  });

  it('resumes the same singer and selected song without changing ownership', async () => {
    const game = karaokeVoiceGame('en-US');
    const first = game.connect('CA-RESUME');
    first.prompt('Ada');
    first.prompt('one');
    const playerId = first.playerId;
    first.session.handleReplaced();

    const resumed = game.connect('CA-RESUME');
    expect(resumed.playerId).toBe(playerId);
    expect(game.room.state().selectedByPlayerId).toBe(playerId);
    expect(resumed.spoken).toEqual([
      'You are back, Ada.',
      'Your song is Never Gonna Give You Up.',
      'When scoring is enabled, your live voice is sent to a third-party speech recognition service for scoring. Say Start to consent and begin.',
    ]);
    await Promise.resolve();
    resumed.prompt('start');
    game.room.ready(game.room.state().loadingGeneration);
    game.stateChanged();
    expect(game.handoffs).toHaveLength(1);
  });

  it('speaks one guarded station result after a results reconnect', async () => {
    const game = karaokeVoiceGame('en-US');
    const first = game.connect('CA-RESULT', true);
    first.prompt('Ada');
    first.prompt('Never Gonna Give You Up');
    await Promise.resolve();
    first.prompt('start');
    game.room.ready(game.room.state().loadingGeneration);
    game.stateChanged();
    game.room.mediaReady(first.playerId, game.room.state().selectedSong!.id,
      game.room.state().loadingGeneration, KARAOKE_COUNTDOWN_MS);
    game.setNow(KARAOKE_COUNTDOWN_MS);
    game.room.tick();
    const wordId = game.room.state().selectedSong!.chart.words[0]!.id;
    game.room.recordHit(first.playerId, wordId, 'perfect', 900);
    game.setNow(KARAOKE_COUNTDOWN_MS + KARAOKE_SONG_DURATION_MS);
    game.room.tick();
    game.room.finalizeMediaScore(
      first.playerId,
      game.room.state().score,
      finalHits(game.room.state().selectedSong!, game.room.state().score),
    );
    first.session.handleReplaced();

    const resumed = game.connect('CA-RESULT', true);
    game.stateChanged();
    game.stateChanged();

    expect(resumed.spoken).toHaveLength(2);
    expect(resumed.spoken[0]).toContain('score is 900');
    expect(resumed.spoken[1]).toMatch(/check your messages/i);
    expect(resumed.guards.every(guard => guard?.())).toBe(true);
    resumed.session.handleClose();
    expect(game.leaveCalls).toBe(0);
  });

  it('waits for result lines and conversational score readbacks to settle', async () => {
    const game = karaokeVoiceGame('en-US', true, false,
      async () => ({ kind: 'answer', factId: 'result' }));
    const singer = game.connect('CA-RESULT-DRAIN', true);
    singer.prompt('Ada');
    singer.prompt('Never Gonna Give You Up');
    game.playAllSpeech();
    await flushMicrotasks();
    singer.prompt('start');
    expect(game.room.phase).toBe('loading');
    game.playAllSpeech();
    await flushMicrotasks();

    const generation = game.room.state().loadingGeneration;
    expect(game.room.ready(generation)).toBe(true);
    expect(game.room.mediaReady(singer.playerId, game.room.state().selectedSong!.id,
      generation, KARAOKE_COUNTDOWN_MS)).toBe(true);
    game.setNow(KARAOKE_COUNTDOWN_MS);
    game.room.tick();
    game.setNow(KARAOKE_COUNTDOWN_MS + KARAOKE_SONG_DURATION_MS);
    game.room.tick();
    expect(game.room.finalizeMediaScore(singer.playerId, 900,
      finalHits(game.room.state().selectedSong!, 900))).toBe(true);
    game.stateChanged();
    expect(singer.spoken.slice(-2)).toEqual([
      expect.stringContaining('score is 900'),
      expect.stringMatching(/check your messages/i),
    ]);

    let settled = false;
    const drain = singer.session.whenResultSpeechSettled().then(() => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(false);
    game.playNextSpeech();
    await flushMicrotasks();
    expect(settled).toBe(false);
    game.playNextSpeech();
    await drain;
    expect(settled).toBe(true);

    singer.prompt('Tell me how that performance went');
    await flushMicrotasks();
    expect(singer.spoken.at(-1)).toContain('score is 900');
    let answerSettled = false;
    const answerDrain = singer.session.whenResultSpeechSettled().then(() => { answerSettled = true; });
    await flushMicrotasks();
    expect(answerSettled).toBe(false);
    game.playNextSpeech('interrupted');
    await answerDrain;
    expect(answerSettled).toBe(true);
  });

  it('uses an authoritative station name without asking the caller to repeat it', () => {
    const game = karaokeVoiceGame('en-US');
    const singer = game.connect('CA-NAMED', true, 'Ada');

    expect(game.room.state()).toMatchObject({
      phase: 'song_select', singer: { name: 'Ada', nameConfirmed: true },
    });
    expect(singer.spoken.join(' ')).toContain('Welcome to Voice Karaoke, Ada.');
    expect(singer.spoken.join(' ')).not.toMatch(/first name/i);
  });

  it.each([
    {
      locale: 'en-US' as const,
      name: 'Ada',
      selection: 'Never Gonna Give You Up',
      start: 'start',
      advertisedRematch: /say Choose another song/i,
      rematch: 'choose another song',
    },
    {
      locale: 'pt-BR' as const,
      name: 'Ana',
      selection: 'Luz no Ritmo',
      start: 'começar',
      advertisedRematch: /diga Escolher outra música/i,
      rematch: 'escolher outra música',
    },
  ])('accepts the advertised result phrase and starts the next $locale generation deterministically', async row => {
    const game = karaokeVoiceGame(row.locale);
    const singer = game.connect(`CA-REMATCH-${row.locale}`);
    singer.prompt(row.name);
    singer.prompt(row.selection);
    await Promise.resolve();
    singer.prompt(row.start);
    const firstGeneration = game.room.state().loadingGeneration;
    game.room.ready(firstGeneration);
    game.stateChanged();
    game.room.mediaReady(
      singer.playerId, game.room.state().selectedSong!.id, firstGeneration, KARAOKE_COUNTDOWN_MS,
    );
    game.setNow(KARAOKE_COUNTDOWN_MS);
    game.room.tick();
    game.setNow(KARAOKE_COUNTDOWN_MS + KARAOKE_SONG_DURATION_MS);
    game.room.tick();
    expect(game.room.finalizeMediaScore(
      singer.playerId, 12_345, finalHits(game.room.state().selectedSong!, 12_345),
    )).toBe(true);
    game.stateChanged();

    expect(singer.spoken.at(-1)).toMatch(row.advertisedRematch);
    singer.prompt(row.rematch);
    expect(game.room.phase).toBe('song_select');
    singer.prompt(row.selection);
    await Promise.resolve();
    singer.prompt(row.start);
    expect(game.room.state().loadingGeneration).toBe(firstGeneration + 1);
    expect(game.handoffs).toHaveLength(1);
    game.room.ready(firstGeneration + 1);
    game.stateChanged();
    expect(game.handoffs).toHaveLength(2);
  });
});

describe('matchKaraokeSong', () => {
  it('honors a spoken correction without acting on the first or negated song', () => {
    expect(matchKaraokeSong('Song one, no, actually song two', KARAOKE_RUNTIME_SONGS)?.id)
      .toBe('a-thousand-miles');
    expect(matchKaraokeSong("Don't play song one", KARAOKE_RUNTIME_SONGS)).toBeNull();
  });
  it('matches locale numbers and complete normalized titles', () => {
    const songs = KARAOKE_RUNTIME_SONGS;
    expect(matchKaraokeSong('song number 1', songs, 'en-US')?.id).toBe('never-gonna-give-you-up');
    expect(matchKaraokeSong('song number 2', songs, 'en-US')?.id).toBe('a-thousand-miles');
    expect(matchKaraokeSong('the first song', songs, 'en-US')?.id).toBe('never-gonna-give-you-up');
    expect(matchKaraokeSong('the second one', songs, 'en-US')?.id).toBe('a-thousand-miles');
    expect(matchKaraokeSong('primeiro', songs, 'pt-BR')?.id).toBe('never-gonna-give-you-up');
    expect(matchKaraokeSong('segundo', songs, 'pt-BR')?.id).toBe('a-thousand-miles');
    expect(matchKaraokeSong('thousand miles', songs, 'en-US')?.id).toBe('a-thousand-miles');
    expect(matchKaraokeSong('quero Luz no Ritmo', songs, 'pt-BR')?.id).toBe('luz-no-ritmo-dev');
    expect(matchKaraokeSong('start', songs, 'en-US')).toBeNull();
  });
});

function karaokeVoiceGame(
  locale: SupportedLocale,
  asynchronousSpeech = false,
  unverifiedSpeech = false,
  resolveIntent?: (request: KaraokeIntentRequest) => Promise<KaraokeIntentResult>,
) {
  let now = 0;
  const room = new KaraokeRoom('VOICE', {
    now: () => now,
    songs: KARAOKE_RUNTIME_SONGS,
    preferredLocale: locale,
  });
  const sessions: KaraokeVoiceSession[] = [];
  const bindings = new Map<string, string>();
  const handoffs: KaraokeVoiceEndHandoff[] = [];
  let selectionCalls = 0;
  let leaveCalls = 0;
  const speechResolvers: Array<(outcome: KaraokeSpeechOutcome) => void> = [];

  const snapshot = (playerId: string): KaraokeVoiceSnapshot | null => {
    const state = room.state();
    if (state.singer?.playerId !== playerId) return null;
    return {
      phase: state.phase,
      myName: state.singer.name,
      nameConfirmed: state.singer.nameConfirmed,
      catalog: state.catalog,
      selectedSong: state.selectedSong,
      selectedByPlayerId: state.selectedByPlayerId,
      selectionGeneration: state.selectionGeneration,
      loadingGeneration: state.loadingGeneration,
      displayReady: state.displayReady === true,
      score: state.score,
      bestCombo: state.bestCombo,
      result: state.result,
    };
  };
  const stateChanged = () => sessions.forEach(session => session.onStateChanged());

  const connect = (callSid: string, stationManaged = false, authoritativeName: string | null = null) => {
    const spoken: string[] = [];
    const guards: (((() => boolean) | undefined))[] = [];
    const session = new KaraokeVoiceSession({
      bind: (_code, name, sid, commandLocale, nameConfirmed) => {
        const existing = bindings.get(sid);
        if (existing && room.hasPlayer(existing)) return { playerId: existing, resumed: true };
        room.setPreferredLocale(commandLocale);
        room.expectHumanPlayers(1);
        const joined = room.addPlayer(name, nameConfirmed);
        if ('error' in joined) return null;
        bindings.set(sid, joined.playerId);
        return { playerId: joined.playerId, resumed: false };
      },
      leave: (_code, playerId, sid) => {
        leaveCalls += 1;
        room.removePlayer(playerId);
        if (bindings.get(sid) === playerId) bindings.delete(sid);
        stateChanged();
      },
      setName: (_code, playerId, name) => {
        const accepted = room.setName(playerId, name);
        stateChanged();
        return accepted;
      },
      selectSong: (_code, playerId, songId) => {
        selectionCalls += 1;
        const selected = room.selectSong(playerId, songId);
        stateChanged();
        return selected;
      },
      advance: (_code, playerId) => {
        const advanced = room.advance(playerId);
        stateChanged();
        return advanced;
      },
      snapshot: (_code, playerId) => snapshot(playerId),
      say: (text, guard) => {
        spoken.push(text);
        guards.push(guard);
        if (unverifiedSpeech) return undefined as unknown as Promise<KaraokeSpeechOutcome>;
        if (asynchronousSpeech) return new Promise<KaraokeSpeechOutcome>(resolve => speechResolvers.push(resolve));
        return Promise.resolve('played' as const);
      },
      resolveIntent,
      requestMediaHandoff: handoff => handoffs.push(handoff),
    });
    session.setStationManaged(stationManaged);
    session.setAuthoritativeName(authoritativeName);
    sessions.push(session);
    session.handleMessage(JSON.stringify({
      type: 'setup',
      callSid,
      customParameters: { roomCode: ' voice ', commandLocale: locale },
    }));
    return {
      session,
      spoken,
      guards,
      get playerId() { return session.boundPlayerId!; },
      prompt(voicePrompt: string, last = true) {
        session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt, last }));
      },
      dtmf(digit: string) { session.handleMessage(JSON.stringify({ type: 'dtmf', digit })); },
      interrupt() {
        session.handleMessage(JSON.stringify({
          type: 'interrupt',
          utteranceUntilInterrupt: '',
          durationUntilInterruptMs: 100,
        }));
      },
    };
  };

  return {
    room,
    connect,
    stateChanged,
    handoffs,
    playAllSpeech(outcome: KaraokeSpeechOutcome = 'played') {
      for (const resolve of speechResolvers.splice(0)) resolve(outcome);
    },
    playNextSpeech(outcome: KaraokeSpeechOutcome = 'played') {
      const resolve = speechResolvers.shift();
      if (!resolve) throw new Error('No queued speech to complete');
      resolve(outcome);
    },
    setNow(value: number) { now = value; },
    get selectionCalls() { return selectionCalls; },
    get leaveCalls() { return leaveCalls; },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
