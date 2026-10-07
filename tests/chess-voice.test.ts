import { describe, expect, it } from 'vitest';
import { ChessVoiceSession } from '../server/chess-voice';
import { ChessRoom } from '../server/chess-room';
import type { VoiceInterpretResult } from '../server/voice-interpreter';
import type { ChessCommandResult, ChessEvent, ChessMoveRecord, ChessState } from '../shared/chess-protocol';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function state(overrides: Partial<ChessState> = {}): ChessState {
  return {
    roomCode: '4821', gameId: 1, phase: 'playing', playerConnected: true,
    humanColor: 'w', computerColor: 'b', turn: 'w', fen: START_FEN, pieces: [],
    revision: 0, ply: 0, selection: null, pendingMove: null, lastMove: null,
    result: null, feedback: null, ...overrides,
  };
}

function harness(initial = state(), stationManaged = false, resumed = false, locale = 'en-US') {
  let snapshot = initial;
  const spoken: string[] = [];
  const calls: string[] = [];
  const session = new ChessVoiceSession({
    bind: (code, name, callSid, locale) => {
      calls.push(`bind:${code}:${name}:${callSid}:${locale}`);
      return { playerId: 'c1', resumed };
    },
    leave: (code, playerId, callSid) => { calls.push(`leave:${code}:${playerId}:${callSid}`); },
    command: (_code, _callSid, text, commandLocale) => {
      calls.push(`command:${text}`);
      if (snapshot.result) return { code: 'finished', state: snapshot, message: commandLocale === 'pt-BR'
        ? 'A partida acabou. Diga jogar de novo para começar outra.'
        : 'The match is over. Say play again for a new game.' };
      return { code: 'proposed', message: 'Knight from F four to E six. Say confirm or cancel.', state: snapshot };
    },
    restart: () => { calls.push('restart'); return true; },
    snapshot: () => snapshot,
    say: text => { spoken.push(text); },
  });
  session.setAuthoritativeName('Ada');
  session.setStationManaged(stationManaged);
  const setup = () => session.handleMessage(JSON.stringify({
    type: 'setup', callSid: 'CA-chess', customParameters: { roomCode: '4821', locale },
  }));
  const prompt = (voicePrompt: string, last = true) => session.handleMessage(JSON.stringify({
    type: 'prompt', voicePrompt, last,
  }));
  return { session, spoken, calls, setup, prompt, setState(next: ChessState) { snapshot = next; } };
}

const computerCapture: ChessMoveRecord = {
  actor: 'computer', color: 'b', piece: 'n', from: 'c6', to: 'd4', san: 'Nxd4',
  captured: 'b', capturedSquare: 'd4', promotion: null, castle: null,
  rookFrom: null, rookTo: null, enPassant: false, ply: 12, revision: 12,
  fen: 'r1bqkbnr/pppppppp/2n5/8/3n4/8/PPPPPPPP/RNBQK1NR w KQkq - 0 7',
  check: false, checkmate: false,
};

describe('ChessVoiceSession', () => {
  it('starts the board without a setup menu and announces the assigned side', () => {
    const game = harness(state({ humanColor: 'b', computerColor: 'w', turn: 'b', ply: 1, lastMove: {
      ...computerCapture, color: 'w', piece: 'p', from: 'e2', to: 'e4', san: 'e4',
      captured: null, capturedSquare: null, actor: 'computer', ply: 1, revision: 1,
    } }));
    game.setup();

    expect(game.calls).toEqual(['bind:4821:Ada:CA-chess:en-US']);
    expect(game.spoken.join(' ')).toMatch(/Voice Chess.*Black/i);
    expect(game.spoken.join(' ')).toMatch(/confirm/i);
    expect(game.spoken.join(' ')).toMatch(/rival moves a pawn.*E four/i);
    expect(game.spoken.join(' ')).not.toMatch(/choose a (game|piece set|mode)/i);
  });

  it('never forwards interim transcripts as chess moves', () => {
    const game = harness();
    game.setup();
    game.prompt('knight to E6', false);
    expect(game.calls.filter(call => call.startsWith('command:'))).toEqual([]);
    game.prompt('knight to E6');
    expect(game.calls.filter(call => call.startsWith('command:'))).toEqual(['command:knight to E6']);
    expect(game.spoken.at(-1)).toMatch(/confirm or cancel/i);
  });

  it('announces a captured bishop when the computer move arrives', () => {
    const game = harness();
    game.setup();
    game.setState(state({ revision: 12, ply: 12, lastMove: computerCapture }));
    const event: ChessEvent = { type: 'move', move: computerCapture };
    game.session.onRoomEvents([event]);
    expect(game.spoken.at(-1)).toMatch(/captures your bishop on D four/i);
  });

  it('reannounces a computer capture after the same call reconnects', () => {
    const game = harness(state({ revision: 12, ply: 12, lastMove: computerCapture }), false, true);
    game.setup();
    expect(game.spoken.join(' ')).toMatch(/Welcome back to Voice Chess/);
    expect(game.spoken.at(-1)).toMatch(/captures your bishop on D four/i);
  });

  it('on a finished-board reconnect reports the result without asking for another move', () => {
    const finished = state({ phase: 'finished', result: { reason: 'checkmate', winner: 'w' } });
    const game = harness(finished, false, true);
    game.setup();
    expect(game.spoken).toHaveLength(1);
    expect(game.spoken[0]).toMatch(/checkmate|won/i);
    expect(game.spoken[0]).not.toMatch(/say your move|select a piece/i);
  });

  it('invalidates queued speech when a newer socket replaces the session', () => {
    let isCurrent: (() => boolean) | undefined;
    const session = new ChessVoiceSession({
      bind: () => ({ playerId: 'c1', resumed: false }),
      leave: () => {},
      command: () => null,
      restart: () => false,
      snapshot: () => state(),
      say: (_text, guard) => { isCurrent = guard; },
    });
    session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-chess',
      customParameters: { roomCode: '4821' } }));
    expect(isCurrent?.()).toBe(true);
    session.handleReplaced();
    expect(isCurrent?.()).toBe(false);
  });

  it('cancels queued introduction speech as soon as the caller interrupts', () => {
    let isCurrent: (() => boolean) | undefined;
    const session = new ChessVoiceSession({
      bind: () => ({ playerId: 'c1', resumed: false }), leave: () => {},
      command: () => null, restart: () => false, snapshot: () => state(),
      say: (_text, guard) => { isCurrent = guard; },
    });
    session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-chess',
      customParameters: { roomCode: '4821' } }));
    expect(isCurrent?.()).toBe(true);
    session.handleMessage(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'Welcome',
      durationUntilInterruptMs: 120 }));
    expect(isCurrent?.()).toBe(false);
  });

  it('cancels queued speech when a new interim utterance begins', () => {
    let isCurrent: (() => boolean) | undefined;
    const session = new ChessVoiceSession({
      bind: () => ({ playerId: 'c1', resumed: false }), leave: () => {},
      command: () => null, restart: () => false, snapshot: () => state(),
      say: (_text, guard) => { isCurrent = guard; },
    });
    session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-chess',
      customParameters: { roomCode: '4821' } }));
    expect(isCurrent?.()).toBe(true);
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'queen to', last: false }));
    expect(isCurrent?.()).toBe(false);
  });

  it('announces a display-initiated standalone replay once the board resets', () => {
    const game = harness(state({ phase: 'finished', result: { reason: 'checkmate', winner: 'w' } }));
    game.setup(); game.spoken.length = 0;
    game.setState(state({ gameId: 2, revision: 1 }));
    game.session.onRoomEvents([{ type: 'reset', gameId: 2, revision: 1 }]);
    expect(game.spoken.join(' ')).toMatch(/Welcome to Voice Chess.*White/i);
    expect(game.spoken.join(' ')).not.toMatch(/say play again/i);
  });

  it('does not double-announce a replay initiated by the same caller', () => {
    let current=state({ phase: 'finished', result: { reason: 'checkmate', winner: 'w' } });
    const spoken:string[]=[];
    let session!:ChessVoiceSession;
    session=new ChessVoiceSession({
      bind:()=>({playerId:'c1',resumed:false}),leave:()=>{},command:()=>null,
      snapshot:()=>current,
      restart:()=>{current=state({gameId:2,revision:1});session.onRoomEvents([{type:'reset',gameId:2,revision:1}]);return true;},
      say:line=>{spoken.push(line);},
    });
    session.handleMessage(JSON.stringify({type:'setup',callSid:'CA-chess',customParameters:{roomCode:'4821'}}));
    spoken.length=0;
    session.handleMessage(JSON.stringify({type:'prompt',voicePrompt:'play again',last:true}));
    expect(spoken.filter(line=>/Welcome to Voice Chess/i.test(line))).toHaveLength(1);
  });

  it('uses a grounded semantic choice only to propose a legal move, then requires confirmation', async () => {
    const room = new ChessRoom('4821', { humanColor: 'w', random: () => 0 });
    room.setPlayerConnected(true);
    const spoken: string[] = [];
    const session = new ChessVoiceSession({
      bind: () => ({ playerId: 'c1', resumed: false }), leave: () => {},
      command: (_code, _sid, text, locale) => room.handleVoiceCommand(text, locale),
      restart: () => false, snapshot: () => room.state(),
      legalMoves: () => room.legalVoiceMoves('en-US'),
      interpret: async (_spoken, _locale, context) => {
        expect(context.legalMoves.some(move => move.id === 'e2e4')).toBe(true);
        return { kind: 'action', actionId: 'propose_move', targetId: 'e2e4' };
      },
      say: line => { spoken.push(line); },
    });
    session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-chess',
      customParameters: { roomCode: '4821' } }));
    const startFen = room.state().fen;
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'push the center soldier two', last: true }));
    await session.whenSpeechSettled();
    expect(room.state().pendingMove).toMatchObject({ from: 'e2', to: 'e4' });
    expect(room.state().fen).toBe(startFen);
    expect(spoken.at(-1)).toMatch(/confirm/i);
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'yes, go ahead and make that move', last: true }));
    expect(room.state().fen).not.toBe(startFen);
  });

  it('rejects a semantic move when a newer spoken turn has changed the proposal', async () => {
    const room = new ChessRoom('4821', { humanColor: 'w', random: () => 0 });
    room.setPlayerConnected(true);
    let resolve!: (result: VoiceInterpretResult) => void;
    const decision = new Promise<VoiceInterpretResult>(r => { resolve = r; });
    const session = new ChessVoiceSession({
      bind: () => ({ playerId: 'c1', resumed: false }), leave: () => {},
      command: (_code, _sid, text, locale) => room.handleVoiceCommand(text, locale),
      restart: () => false, snapshot: () => room.state(),
      legalMoves: () => room.legalVoiceMoves('en-US'),
      interpret: async () => decision,
      say: () => {},
    });
    session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-chess',
      customParameters: { roomCode: '4821' } }));
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'push the center soldier', last: true }));
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'pawn from E2 to E4', last: true }));
    resolve({ kind: 'action', actionId: 'propose_move', targetId: 'e2e3' });
    await session.whenSpeechSettled();
    expect(room.state().pendingMove).toMatchObject({ from: 'e2', to: 'e4' });
  });

  it('never proposes a semantic move missing from the authoritative legal candidates', async () => {
    const room = new ChessRoom('4821', { humanColor: 'w', random: () => 0 });
    room.setPlayerConnected(true);
    const session = new ChessVoiceSession({
      bind: () => ({ playerId: 'c1', resumed: false }), leave: () => {},
      command: (_code, _sid, text, locale) => room.handleVoiceCommand(text, locale),
      restart: () => false, snapshot: () => room.state(),
      legalMoves: () => room.legalVoiceMoves('en-US'),
      interpret: async () => ({ kind: 'action', actionId: 'propose_move', targetId: 'e2e5' }),
      say: () => {},
    });
    session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-chess',
      customParameters: { roomCode: '4821' } }));
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'push the center soldier two', last: true }));
    await session.whenSpeechSettled();
    expect(room.state().pendingMove).toBeNull();
    expect(room.state().ply).toBe(0);
  });

  it('allows spoken replay after a standalone result and blocks it during a station match', () => {
    const finished = state({ phase: 'finished', result: { reason: 'checkmate', winner: 'b' } });
    const standalone = harness(finished);
    standalone.setup();
    standalone.prompt('play again');
    expect(standalone.calls).toContain('restart');

    const station = harness(finished, true);
    station.setup();
    station.prompt('play again');
    expect(station.calls).not.toContain('restart');
    expect(station.spoken.at(-1)).toMatch(/station|next game/i);
  });

  it.each([
    { locale: 'en-US', drawn: 'draw', replay: 'say play again', station: 'station will prepare' },
    { locale: 'pt-BR', drawn: 'Empate', replay: 'diga jogar de novo', station: 'estação prepara' },
  ])('gives $locale draw and replay guidance appropriate to the match', ({ locale, drawn, replay, station }) => {
    const finished = state({ phase: 'finished', result: { reason: 'stalemate', winner: null } });
    const standaloneGame = harness(finished, false, false, locale);
    standaloneGame.setup();
    expect(standaloneGame.spoken.at(-1)).toContain(drawn);
    expect(standaloneGame.spoken.at(-1)?.toLowerCase()).toContain(replay);

    const stationGame = harness(finished, true, false, locale);
    stationGame.setup();
    expect(stationGame.spoken.at(-1)).toContain(drawn);
    expect(stationGame.spoken.at(-1)?.toLowerCase()).toContain(station);
    expect(stationGame.spoken.at(-1)?.toLowerCase()).not.toContain(replay);
    stationGame.prompt(locale === 'pt-BR' ? 'ajuda' : 'help');
    expect(stationGame.spoken.at(-1)?.toLowerCase()).toContain(station);
    expect(stationGame.spoken.at(-1)?.toLowerCase()).not.toContain(replay);
  });

  it('announces a station win without offering an unavailable phone replay', () => {
    const finished = state({ phase: 'finished', result: { reason: 'checkmate', winner: 'w' } });
    const station = harness(finished, true);
    station.setup();
    expect(station.spoken.at(-1)).toMatch(/you won the wizard duel/i);
    expect(station.spoken.at(-1)).toMatch(/station will prepare/i);
    expect(station.spoken.at(-1)).not.toMatch(/say play again/i);
  });

  it('releases the caller on close while a replaced transport preserves the binding', () => {
    const first = harness();
    first.setup();
    first.session.handleReplaced();
    first.session.handleClose();
    expect(first.calls).not.toContain('leave:4821:c1:CA-chess');

    const second = harness();
    second.setup();
    second.session.handleClose();
    expect(second.calls).toContain('leave:4821:c1:CA-chess');
  });
});
