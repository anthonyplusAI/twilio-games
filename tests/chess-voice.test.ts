import { describe, expect, it, vi } from 'vitest';
import { ChessVoiceSession, type ChessVoiceInterpretContext } from '../server/chess-voice';
import { ChessRoom } from '../server/chess-room';
import type { VoiceInterpretResult } from '../server/voice-interpreter';
import type { ChessCommandResult, ChessEvent, ChessMoveRecord, ChessState } from '../shared/chess-protocol';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function state(overrides: Partial<ChessState> = {}): ChessState {
  return {
    roomCode: '4821', gameId: 1, phase: 'playing', playerConnected: true,
    humanColor: 'w', computerColor: 'b', turn: 'w', fen: START_FEN, pieces: [],
    revision: 0, ply: 0, selection: null, pendingMove: null, lastMove: null,
    result: null, feedback: null, hintsRemaining: 3, hint: null, ...overrides,
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

function liveRoomHarness(room: ChessRoom, locale: 'en-US' | 'pt-BR' = 'en-US',
  interpret?: (context: ChessVoiceInterpretContext) => Promise<VoiceInterpretResult>) {
  room.setPlayerConnected(true);
  const spoken: string[] = [];
  const commands: string[] = [];
  const session = new ChessVoiceSession({
    bind: () => ({ playerId: 'c1', resumed: false }), leave: () => {},
    command: (_code, _sid, text, commandLocale) => {
      commands.push(text);
      return room.handleVoiceCommand(text, commandLocale);
    },
    restart: () => false, snapshot: () => room.state(),
    legalMoves: (_code, _sid, commandLocale) => room.legalVoiceMoves(commandLocale),
    ...(interpret ? { interpret: async (_spoken: string, _locale: 'en-US' | 'pt-BR', context: ChessVoiceInterpretContext) => interpret(context) } : {}),
    say: line => { spoken.push(line); },
  });
  session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-chess',
    customParameters: { roomCode: '4821', locale } }));
  const prompt = (voicePrompt: string) => session.handleMessage(JSON.stringify({
    type: 'prompt', voicePrompt, last: true,
  }));
  return { room, spoken, commands, session, prompt };
}

const computerCapture: ChessMoveRecord = {
  actor: 'computer', color: 'b', piece: 'n', from: 'c6', to: 'd4', san: 'Nxd4',
  captured: 'b', capturedSquare: 'd4', promotion: null, castle: null,
  rookFrom: null, rookTo: null, enPassant: false, ply: 12, revision: 12,
  fen: 'r1bqkbnr/pppppppp/2n5/8/3n4/8/PPPPPPPP/RNBQK1NR w KQkq - 0 7',
  check: false, checkmate: false,
};

describe('ChessVoiceSession', () => {
  it('treats a spoken hint request as an action even when phrased as a question', () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    const game = liveRoomHarness(room);
    game.prompt('Can you give me a hint?');
    expect(game.commands).toEqual(['Can you give me a hint?']);
    expect(room.state().hintsRemaining).toBe(2);
    expect(game.spoken.at(-1)).toMatch(/hint.*from.*to/i);
  });

  it('handles polite hint requests immediately when semantic interpretation is unavailable', () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    const game = liveRoomHarness(room);
    game.prompt('Can I get a hint?');
    expect(room.state().hintsRemaining).toBe(2);
    expect(game.spoken.at(-1)).toMatch(/hint.*from.*to/i);
    game.prompt('hint please');
    expect(game.spoken.at(-1)).toMatch(/hint.*from.*to/i);
    expect(room.state().hintsRemaining).toBe(2); // Same-position reminder is free.
  });

  it('queues the station checkmate recap before the room completion callback snapshots speech', async () => {
    const room = new ChessRoom('4821', { humanColor: 'w',
      initialFen: '7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1' });
    room.setPlayerConnected(true);
    const queued: Array<{ text: string; guard: (() => boolean) | undefined; release: () => void }> = [];
    let retirement: Promise<void> | null = null;
    let retirementSettled = false;
    let session!: ChessVoiceSession;
    session = new ChessVoiceSession({
      bind: () => ({ playerId: 'c1', resumed: false }), leave: () => {},
      command: (_code, _sid, utterance, locale) => {
        const result = room.handleVoiceCommand(utterance, locale);
        session.onRoomEvents(room.drainEvents()); // ChessServer.flush, before pushState.
        if (room.phase === 'finished') {
          retirement = session.whenSpeechSettled(); // Station lifecycle callback.
          void retirement.then(() => { retirementSettled = true; });
        }
        return result;
      },
      restart: () => false, snapshot: () => room.state(),
      say: (line, guard) => {
        if (!/Checkmate!/i.test(line)) return Promise.resolve(true);
        return new Promise<boolean>(resolve => queued.push({ text: line, guard, release: () => resolve(true) }));
      },
    });
    session.setStationManaged(true);
    session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-station-mate',
      customParameters: { roomCode: '4821' } }));
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'queen to G7', last: true }));
    session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'confirm', last: true }));

    expect(room.state().phase).toBe('finished');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.text).toMatch(/queen.*G seven.*Checkmate!.*Twilio Conversation Relay/i);
    expect(queued[0]!.guard?.()).toBe(true);
    expect(retirement).not.toBeNull();
    await Promise.resolve();
    expect(retirementSettled).toBe(false);
    queued[0]!.release();
    await retirement;
    expect(retirementSettled).toBe(true);
  });

  it('answers hint allowance questions without spending a hint or needing the interpreter', () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    const game = liveRoomHarness(room);
    game.prompt('How many hints do I have left?');
    expect(game.spoken.at(-1)).toMatch(/3 hints left/i);
    expect(game.commands).toEqual([]);
    game.prompt('Can I get a hint?');
    expect(room.state().hintsRemaining).toBe(2);
    game.prompt('Do I have any hints remaining?');
    expect(game.spoken.at(-1)).toMatch(/2 hints left/i);
    expect(game.commands).toEqual(['Can I get a hint?']);
  });

  it('answers Portuguese hint allowance questions from the room state', () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    const game = liveRoomHarness(room, 'pt-BR');
    game.prompt('Quantas dicas ainda tenho?');
    expect(game.spoken.at(-1)).toMatch(/3 dicas restantes/i);
    expect(game.commands).toEqual([]);
  });

  it('lets the grounded interpreter route an open-ended suggestion to the authoritative hint budget', async () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    const game = liveRoomHarness(room, 'en-US', async context => {
      expect(context.readOnlyInquiry).toBe(false);
      return { kind: 'action', actionId: 'hint' };
    });
    game.prompt('I am stuck, pick out a safe plan for me');
    await game.session.whenSpeechSettled();
    expect(game.commands).toEqual(['hint']);
    expect(room.state().hintsRemaining).toBe(2);
    expect(room.state().pendingMove).toBeNull();
  });

  it('treats recommendation questions as actions while keeping hint counts read-only', async () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    const game = liveRoomHarness(room, 'en-US', async context => {
      return context.readOnlyInquiry
        ? { kind: 'answer', factId: 'hints_remaining' }
        : { kind: 'action', actionId: 'hint' };
    });
    game.prompt('How many hints do I have left?');
    await game.session.whenSpeechSettled();
    expect(room.state().hintsRemaining).toBe(3);
    expect(game.spoken.at(-1)).toMatch(/3 hints left/i);
    game.prompt('Could you explain what a good move is?');
    await game.session.whenSpeechSettled();
    expect(room.state().hintsRemaining).toBe(3);
    game.prompt('Which move would you recommend here?');
    await game.session.whenSpeechSettled();
    expect(room.state().hintsRemaining).toBe(2);
    game.prompt('What is the best move now?');
    await game.session.whenSpeechSettled();
    expect(room.state().hintsRemaining).toBe(2);
    game.prompt('Could you help me choose?');
    await game.session.whenSpeechSettled();
    expect(room.state().hintsRemaining).toBe(2);
    expect(game.commands).toEqual([
      'Which move would you recommend here?',
      'What is the best move now?',
      'hint',
    ]);
  });

  it('starts the board without a setup menu and announces the assigned side', () => {
    const game = harness(state({ humanColor: 'b', computerColor: 'w', turn: 'b', ply: 1, lastMove: {
      ...computerCapture, color: 'w', piece: 'p', from: 'e2', to: 'e4', san: 'e4',
      captured: null, capturedSquare: null, actor: 'computer', ply: 1, revision: 1,
    } }));
    game.setup();

    expect(game.calls).toEqual(['bind:4821:Ada:CA-chess:en-US']);
    expect(game.spoken.join(' ')).toMatch(/Voice Chess.*Black/i);
    expect(game.spoken.join(' ')).toMatch(/Twilio Conversation Relay/i);
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

  it('keeps a delayed human-move cue ahead of the 900 ms computer reply until caller barge-in', () => {
    vi.useFakeTimers();
    try {
      let current = state();
      const queued: Array<{ text: string; guard?: () => boolean }> = [];
      const humanMove: ChessMoveRecord = { ...computerCapture, actor: 'human', color: 'w', piece: 'p',
        from: 'e2', to: 'e4', san: 'e4', captured: null, capturedSquare: null, ply: 1, revision: 1 };
      const computerMove: ChessMoveRecord = { ...computerCapture, piece: 'p', from: 'e7', to: 'e5',
        san: 'e5', captured: null, capturedSquare: null, ply: 2, revision: 2 };
      const session = new ChessVoiceSession({
        bind: () => ({ playerId: 'c1', resumed: false }), leave: () => {}, restart: () => false,
        snapshot: () => current,
        command: () => {
          current = state({ revision: 1, ply: 1, turn: 'b', lastMove: humanMove });
          return { code: 'confirmed', state: current, message: 'confirmed' };
        },
        // A deliberately unresolved Relay playback models slow ElevenLabs audio.
        say: (text, guard) => { queued.push({ text, guard }); return new Promise<boolean>(() => {}); },
      });
      session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-chess', customParameters: { roomCode: '4821' } }));
      session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'confirm', last: true }));
      const humanCue = queued.at(-1)!;
      expect(humanCue.text).toMatch(/E four/i);
      expect(humanCue.guard?.()).toBe(true);
      setTimeout(() => {
        current = state({ revision: 2, ply: 2, turn: 'w', lastMove: computerMove });
        session.onRoomEvents([{ type: 'move', move: computerMove }]);
      }, 900);
      vi.advanceTimersByTime(900);
      expect(humanCue.guard?.()).toBe(true);
      expect(queued.at(-1)?.text).toMatch(/rival moves/i);
      session.handleMessage(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 100 }));
      expect(humanCue.guard?.()).toBe(false);
      expect(queued.at(-1)?.guard?.()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('does not cut the Black-side introduction when the opening computer move arrives', () => {
    let current = state({ humanColor: 'b', computerColor: 'w', turn: 'w' });
    const queued: Array<{ text: string; guard?: () => boolean }> = [];
    const opening: ChessMoveRecord = { ...computerCapture, actor: 'computer', color: 'w', piece: 'p',
      from: 'e2', to: 'e4', san: 'e4', captured: null, capturedSquare: null, ply: 1, revision: 1 };
    const session = new ChessVoiceSession({
      bind: () => ({ playerId: 'c1', resumed: false }), leave: () => {}, command: () => null,
      restart: () => false, snapshot: () => current,
      say: (text, guard) => { queued.push({ text, guard }); return new Promise<boolean>(() => {}); },
    });
    session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-chess', customParameters: { roomCode: '4821' } }));
    const intro = queued[0]!;
    current = state({ humanColor: 'b', computerColor: 'w', turn: 'b', revision: 1, ply: 1, lastMove: opening });
    session.onRoomEvents([{ type: 'move', move: opening }]);
    expect(intro.guard?.()).toBe(true);
    expect(queued.at(-1)?.text).toMatch(/rival moves a pawn.*E four/i);
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

  it('answers castling availability from the current legal moves without proposing a castle', () => {
    const castlePosition = new ChessRoom('4821', {
      humanColor: 'w', initialFen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    });
    const legal = liveRoomHarness(castlePosition);
    const firstFen = castlePosition.state().fen;
    legal.prompt('Can I castle?');
    expect(legal.spoken.at(-1)).toMatch(/both kingside and queenside castling are legal/i);
    expect(legal.commands).toEqual([]);
    expect(castlePosition.state().pendingMove).toBeNull();
    expect(castlePosition.state().fen).toBe(firstFen);

    const blockedPosition = new ChessRoom('4821', { humanColor: 'w' });
    const blocked = liveRoomHarness(blockedPosition);
    blocked.prompt('Can I castle?');
    expect(blocked.spoken.at(-1)).toMatch(/castling is not legal/i);
    expect(blocked.commands).toEqual([]);
    expect(blockedPosition.state().pendingMove).toBeNull();
  });

  it('distinguishes the two castling sides without guessing why a side is blocked', () => {
    const room = new ChessRoom('4821', {
      humanColor: 'w', initialFen: 'r3k2r/8/8/8/8/8/8/R2QK2R w KQkq - 0 1',
    });
    const game = liveRoomHarness(room);
    game.prompt('Can I castle kingside?');
    expect(game.spoken.at(-1)).toMatch(/Yes.*Kingside castling is legal/i);
    game.prompt('Can I castle queenside?');
    expect(game.spoken.at(-1)).toMatch(/No.*Queenside castling is not legal/i);
    expect(game.commands).toEqual([]);
    expect(room.state().pendingMove).toBeNull();
    game.prompt('castle');
    expect(game.commands).toEqual(['castle']);
    expect(room.state().pendingMove?.castle).toBe('king');
    expect(room.state().ply).toBe(0);
  });

  it('answers a named piece’s live destinations without selecting or moving that piece', () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    const game = liveRoomHarness(room);
    game.prompt('Where can my knight move?');
    expect(game.spoken.at(-1)).toMatch(/knight on B one can move to A three and C three/i);
    expect(game.spoken.at(-1)).toMatch(/knight on G one can move to F three and H three/i);
    expect(game.commands).toEqual([]);
    expect(room.state().selection).toBeNull();
    expect(room.state().pendingMove).toBeNull();
  });

  it('answers legal and illegal square questions while leaving the board untouched', () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    const game = liveRoomHarness(room);
    const firstFen = room.state().fen;
    game.prompt('Can my knight move from B one to C three?');
    expect(game.spoken.at(-1)).toMatch(/Yes.*knight.*B one.*C three/i);
    game.prompt('Is my knight allowed to go from B one to E three?');
    expect(game.spoken.at(-1)).toMatch(/No.*B one.*E three.*not legal/i);
    expect(game.commands).toEqual([]);
    expect(room.state().pendingMove).toBeNull();
    expect(room.state().fen).toBe(firstFen);
  });

  it('uses the moving piece when a capture question also names the target piece', () => {
    const room = new ChessRoom('4821', {
      humanColor: 'w', initialFen: '4k3/8/2n5/1B6/8/8/8/4K3 w - - 0 1',
    });
    const game = liveRoomHarness(room);
    game.prompt('Can my bishop capture the knight on C six?');
    expect(game.spoken.at(-1)).toMatch(/Yes.*Your bishop on B five.*C six/i);
    expect(game.commands).toEqual([]);
    expect(room.state().pendingMove).toBeNull();
  });

  it('never turns an open-ended legality question into a model-selected action', async () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    const game = liveRoomHarness(room, 'en-US', async context => {
      expect(context.readOnlyInquiry).toBe(true);
      expect(context.facts.some(fact => fact.id === 'legal_piece_n')).toBe(true);
      return { kind: 'action', actionId: 'propose_move', targetId: 'e2e4' };
    });
    game.prompt('Is that a legal thing for me to try');
    await game.session.whenSpeechSettled();
    expect(game.commands).toEqual([]);
    expect(room.state().pendingMove).toBeNull();
    expect(game.spoken.at(-1)).toMatch(/which piece or starting square/i);
  });

  it('drops a delayed legal-move answer after the board changes', async () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    let resolve!: (result: VoiceInterpretResult) => void;
    const decision = new Promise<VoiceInterpretResult>(done => { resolve = done; });
    const game = liveRoomHarness(room, 'en-US', async context => {
      expect(context.readOnlyInquiry).toBe(true);
      return decision;
    });
    game.prompt('What is that move called');
    const before = game.spoken.length;
    room.handleVoiceCommand('pawn from E2 to E4');
    room.confirmMove();
    resolve({ kind: 'answer', factId: 'legal_moves' });
    await game.session.whenSpeechSettled();
    expect(game.spoken).toHaveLength(before);
  });

  it('keeps a polite request for a move actionable and still requires confirmation', async () => {
    const room = new ChessRoom('4821', { humanColor: 'w' });
    const game = liveRoomHarness(room, 'en-US', async context => {
      expect(context.readOnlyInquiry).toBe(false);
      return { kind: 'action', actionId: 'propose_move', targetId: 'g1f3' };
    });
    game.prompt('Could you move my knight to F three?');
    await game.session.whenSpeechSettled();
    expect(room.state().pendingMove).toMatchObject({ from: 'g1', to: 'f3' });
    expect(room.state().ply).toBe(0);
    expect(game.spoken.at(-1)).toMatch(/confirm or cancel/i);
  });

  it.each([
    { spoken: 'Move my bishop to C3?', fen: '4k3/4p3/8/8/8/8/1B6/4K3 w - - 0 1', from: 'b2' },
    { spoken: 'Knight on B to C3?', fen: '4k3/4p3/8/8/8/8/4N3/1N2K3 w - - 0 1', from: 'b1' },
  ])('treats a punctuated direct request as a move proposal: $spoken', ({ spoken, fen, from }) => {
    const room = new ChessRoom('4821', { humanColor: 'w', initialFen: fen });
    const game = liveRoomHarness(room);
    game.prompt(spoken);
    expect(game.commands).toEqual([spoken]);
    expect(room.state().pendingMove).toMatchObject({ from, to: 'c3' });
    expect(room.state().ply).toBe(0);
  });

  it.each(['Can my bishop move to C3?', 'Can my bishop move to C3', 'What if I move my bishop to C3?'])
    ('keeps a legality question read-only even when it names a valid move: %s', async spoken => {
      const room = new ChessRoom('4821', {
        humanColor: 'w', initialFen: '4k3/4p3/8/8/8/8/1B6/4K3 w - - 0 1',
      });
      const game = liveRoomHarness(room, 'en-US', async context => {
        expect(context.readOnlyInquiry).toBe(true);
        return { kind: 'action', actionId: 'propose_move', targetId: 'b2c3' };
      });
      game.prompt(spoken);
      await game.session.whenSpeechSettled();
      expect(game.commands).toEqual([]);
      expect(room.state().pendingMove).toBeNull();
    });

  it('lets the semantic interpreter recover a misheard direct request without committing it', async () => {
    const room = new ChessRoom('4821', {
      humanColor: 'w', initialFen: '4k3/4p3/8/8/8/8/8/1N2K3 w - - 0 1',
    });
    const interpret = vi.fn(async (context: ChessVoiceInterpretContext) => {
      expect(context.readOnlyInquiry).toBe(false);
      return { kind: 'action' as const, actionId: 'propose_move', targetId: 'b1c3' };
    });
    const game = liveRoomHarness(room, 'en-US', interpret);
    game.prompt('Could you move my nite to C3?');
    await game.session.whenSpeechSettled();
    expect(interpret).toHaveBeenCalledOnce();
    expect(room.state().pendingMove).toMatchObject({ from: 'b1', to: 'c3' });
    expect(room.state().ply).toBe(0);
  });

  it.each([
    {
      spoken: 'Move the knight on B to C3',
      fen: '4k3/4p3/8/8/8/8/4N3/1N2K3 w - - 0 1', from: 'b1', to: 'c3',
    },
    {
      spoken: 'Could you please move my knight on the B file to C3?',
      fen: '4k3/4p3/8/8/8/8/4N3/1N2K3 w - - 0 1', from: 'b1', to: 'c3',
    },
    {
      spoken: 'Move my bishop to C3',
      fen: '4k3/4p3/8/8/8/8/1B6/4K3 w - - 0 1', from: 'b2', to: 'c3',
    },
    {
      spoken: 'I only have one bishop left; could you move it to C3?',
      fen: '4k3/4p3/8/8/8/8/1B6/4K3 w - - 0 1', from: 'b2', to: 'c3',
    },
  ])('proposes "$spoken" from the current board without waiting for a model', ({ spoken, fen, from, to }) => {
    const room = new ChessRoom('4821', { humanColor: 'w', initialFen: fen });
    const interpret = vi.fn(async () => ({ kind: 'none' as const }));
    const game = liveRoomHarness(room, 'en-US', interpret);
    game.prompt(spoken);
    expect(interpret).not.toHaveBeenCalled();
    expect(room.state().pendingMove).toMatchObject({ from, to });
    expect(room.state().ply).toBe(0);
    expect(game.spoken.at(-1)).toMatch(/confirm or cancel/i);
    game.prompt('confirm');
    expect(room.state().lastMove).toMatchObject({ actor: 'human', from, to });
  });

  it('speaks Portuguese castling and piece facts from the same legal board', () => {
    const room = new ChessRoom('4821', {
      humanColor: 'w', initialFen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    });
    const game = liveRoomHarness(room, 'pt-BR');
    game.prompt('Posso fazer roque pequeno');
    expect(game.spoken.at(-1)).toMatch(/Sim.*roque pequeno.*legal/i);
    game.prompt('Onde meu rei pode ir?');
    expect(game.spoken.at(-1)).toMatch(/Seu rei em E um pode ir para/i);
    expect(game.commands).toEqual([]);
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

  it.each([
    { locale: 'en-US', station: false, outcome: /you won the wizard duel/i,
      technology: /Twilio Conversation Relay.*spoken moves.*pieces on screen.*result over your call/i, next: /say play again/i },
    { locale: 'en-US', station: true, outcome: /you won the wizard duel/i,
      technology: /Twilio Conversation Relay.*spoken moves.*pieces on screen.*result over your call/i, next: /station will prepare/i },
    { locale: 'pt-BR', station: false, outcome: /você venceu o duelo de magos/i,
      technology: /Twilio Conversation Relay.*lances pelo telefone.*peças na tela.*resultado na chamada/i, next: /diga jogar de novo/i },
    { locale: 'pt-BR', station: true, outcome: /você venceu o duelo de magos/i,
      technology: /Twilio Conversation Relay.*lances pelo telefone.*peças na tela.*resultado na chamada/i, next: /estação prepara/i },
  ])('explains $locale Chess voice technology after the result in station=$station', row => {
    const finished = state({ phase: 'finished', result: { reason: 'checkmate', winner: 'w' } });
    const game = harness(finished, row.station, false, row.locale);
    game.setup();
    const line = game.spoken.at(-1) ?? '';
    expect(line).toMatch(row.outcome);
    expect(line).toMatch(row.technology);
    expect(line).toMatch(row.next);
    expect(line.search(row.technology)).toBeGreaterThan(line.search(row.outcome));
    expect(line.search(row.next)).toBeGreaterThan(line.search(row.technology));
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
