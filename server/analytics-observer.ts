import type { Room } from './room';
import type { BattleRoom } from './battle-room';
import type { FighterRoom } from './fighter-room';
import type { KaraokeRoom } from './karaoke-room';
import type { TriviaRoom } from './trivia-room';
import type { ChessRoom } from './chess-room';
import { AnalyticsStore } from './analytics-store';
import type { AnalyticsGame } from '../shared/analytics';

interface ActiveMatch {
  key: string;
  startedAt: number;
  participants: string[];
  map?: string | null;
  song?: string | null;
  category?: string | null;
  characters: string[];
}

export type KaraokeAnalyticsSetupAction =
  | 'confirm_name'
  | 'open_song_selection'
  | 'select_song'
  | 'start_song'
  | 'sing_again';

export class AnalyticsObserver {
  private racerActive = new Map<string, ActiveMatch>();
  private battleActive = new Map<string, ActiveMatch>();
  private fighterActive = new Map<string, ActiveMatch>();
  private karaokeActive = new Map<string, ActiveMatch>();
  private triviaActive = new Map<string, ActiveMatch>();
  private chessActive = new Map<string, ActiveMatch>();

  constructor(private readonly store: AnalyticsStore, private readonly now: () => number = Date.now) {}

  raceStarted(room: Room): void {
    this.racerActive.set(room.code, { key: String(this.now()), startedAt: this.now(),
      participants: room.lobbyPlayers().map(player => `racer:${room.code}:${player.playerId}`), map: room.selectedMap,
      characters: room.lobbyPlayers().map(player => room.carName(player.carIndex ?? 0)) });
  }

  raceFinished(room: Room): void {
    const results = room.results(); if (!results.length) return;
    const active = this.racerActive.get(room.code);
    const duration = active ? (this.now() - active.startedAt) / 1000 : Math.max(0, ...results.map(result => result.finishT));
    this.store.recordMatch({ game: 'racer', participantIds: active?.participants ?? results.map(result => `racer:${room.code}:${result.playerId}`),
      durationSeconds: duration, completed: results.some(result => result.finished), map: room.selectedMap,
      vehicles: results.map(result => room.carName(result.carIndex)), at: this.now() });
    this.racerActive.delete(room.code);
  }

  raceAbandoned(room: Room): void {
    const active = this.racerActive.get(room.code); if (!active) return;
    this.store.recordMatch({ game: 'racer', participantIds: active.participants,
      durationSeconds: (this.now() - active.startedAt) / 1000, completed: false, map: active.map,
      vehicles: active.characters, at: this.now() });
    this.racerActive.delete(room.code);
  }

  battleState(room: BattleRoom): void {
    const active = this.battleActive.get(room.code);
    if (room.phase === 'battle' && (!active || active.key !== String(room.generation))) {
      if (active) this.finish('monsters', room.code, active, false);
      const players = room.lobbyPlayers().filter(player => !player.isAi);
      const snapshot = room.snapshot();
      this.battleActive.set(room.code, { key: String(room.generation), startedAt: this.now(),
        participants: players.map(player => `monsters:${room.code}:${player.playerId}`),
        characters: [snapshot?.a.monsterId, snapshot?.b.monsterId].filter((id): id is string => Boolean(id)) });
      return;
    }
    if (!active || room.phase === 'battle') return;
    this.finish('monsters', room.code, active, room.phase === 'results');
  }

  fighterState(room: FighterRoom): void {
    const state = room.state(); const active = this.fighterActive.get(room.code);
    if (state.phase === 'fight' && (!active || active.key !== String(state.loadingGeneration))) {
      if (active) this.finish('fighter', room.code, active, false);
      const players = state.players.filter(player => !player.isAi);
      this.fighterActive.set(room.code, { key: String(state.loadingGeneration), startedAt: this.now(),
        participants: players.map(player => `fighter:${room.code}:${player.playerId}`), map: state.selectedMap,
        characters: state.players.map(player => player.fighterId).filter((id): id is string => Boolean(id)) });
      return;
    }
    if (!active || state.phase === 'fight') return;
    this.finish('fighter', room.code, active, state.phase === 'victory' || state.phase === 'results');
  }

  karaokeState(room: KaraokeRoom): void {
    const state = room.state();
    const active = this.karaokeActive.get(room.code);
    const generation = String(state.loadingGeneration);
    const live = state.loadingGeneration > 0
      && (state.phase === 'performing' || state.phase === 'finalizing')
      && state.performanceStartedAtMs !== null
      && state.singer !== null
      && state.selectedSong !== null;
    if (live && (!active || active.key !== generation)) {
      if (active) this.finish('karaoke', room.code, active, false);
      this.karaokeActive.set(room.code, {
        key: generation,
        startedAt: state.performanceStartedAtMs!,
        participants: [`karaoke:${room.code}:${state.singer!.playerId}`],
        song: state.selectedSong!.id,
        characters: [],
      });
      return;
    }
    if (!active || live) return;
    const completed = state.phase === 'results' && state.result?.generation === Number(active.key);
    this.finish('karaoke', room.code, active, completed, completed ? state.result!.completedAtMs : this.now());
  }

  /** Finalizes an in-progress performance before its room is removed without another state callback. */
  karaokeAborted(roomCode: string): void {
    const active = this.karaokeActive.get(roomCode);
    if (active) this.finish('karaoke', roomCode, active, false);
  }

  triviaState(room: TriviaRoom): void {
    const state = room.state();
    const active = this.triviaActive.get(room.code);
    const generation = String(state.loadingGeneration);
    const live = state.loadingGeneration > 0
      && state.category !== null
      && (state.phase === 'loading' || state.phase === 'countdown'
        || state.phase === 'question_prompt' || state.phase === 'answer_cue'
        || state.phase === 'question' || state.phase === 'reveal'
        || state.phase === 'audio_problem');
    if (live && (!active || active.key !== generation)) {
      if (active) this.finish('trivia', room.code, active, false);
      this.triviaActive.set(room.code, {
        key: generation,
        startedAt: this.now(),
        participants: state.players.map(player => `trivia:${room.code}:slot:${player.playerOrder}`),
        category: state.category,
        characters: [],
      });
      return;
    }
    if (!active || live) return;
    const completed = state.phase === 'results' && state.result?.generation === Number(active.key);
    this.finish('trivia', room.code, active, completed, completed ? state.result!.completedAtMs : this.now());
  }

  /** Finalizes a live generation before its room is removed without another state callback. */
  triviaAborted(roomCode: string): void {
    const active = this.triviaActive.get(roomCode);
    if (active) this.finish('trivia', roomCode, active, false);
  }

  chessState(room: ChessRoom): void {
    const state = room.state();
    const active = this.chessActive.get(room.code);
    const gameKey = String(state.gameId);
    const live = state.playerConnected && (state.phase === 'playing' || state.phase === 'pending');
    if (live && (!active || active.key !== gameKey)) {
      if (active) this.finish('chess', room.code, active, false);
      this.chessActive.set(room.code, {
        key: gameKey,
        startedAt: this.now(),
        participants: [`chess:${room.code}:caller`],
        characters: [],
      });
      return;
    }
    if (active && state.phase === 'finished' && active.key === gameKey) {
      this.finish('chess', room.code, active, true);
    }
  }

  /** Replaces the room fallback with the call identity while keeping the raw SID out of persisted rollups. */
  chessBound(roomCode: string, callSid: string): void {
    const active = this.chessActive.get(roomCode);
    const sid = callSid.trim();
    if (active && sid) active.participants = [`chess:call:${sid}`];
  }

  chessAborted(roomCode: string): void {
    const active = this.chessActive.get(roomCode);
    if (active) this.finish('chess', roomCode, active, false);
  }

  /** Counts an authoritative accepted command; no command text or recognition payload is accepted. */
  voiceCommand(game: Exclude<AnalyticsGame, 'karaoke'>): void {
    this.store.recordVoiceCommand(game, this.now());
  }

  /** Counts accepted setup intents; raw singing audio, lyrics, and transcripts have no analytics seam. */
  karaokeSetupAction(action: KaraokeAnalyticsSetupAction): void {
    switch (action) {
      case 'confirm_name':
      case 'open_song_selection':
      case 'select_song':
      case 'start_song':
      case 'sing_again':
        this.store.recordVoiceCommand('karaoke', this.now());
    }
  }

  private finish(
    game: 'monsters' | 'fighter' | 'karaoke' | 'trivia' | 'chess',
    roomCode: string,
    match: ActiveMatch,
    completed: boolean,
    finishedAt = this.now(),
  ): void {
    this.store.recordMatch({ game, participantIds: match.participants, durationSeconds: (finishedAt - match.startedAt) / 1000,
      completed, map: match.map, song: match.song, category: match.category, characters: match.characters, at: finishedAt });
    switch (game) {
      case 'monsters': this.battleActive.delete(roomCode); break;
      case 'fighter': this.fighterActive.delete(roomCode); break;
      case 'karaoke': this.karaokeActive.delete(roomCode); break;
      case 'trivia': this.triviaActive.delete(roomCode); break;
      case 'chess': this.chessActive.delete(roomCode); break;
    }
  }
}
