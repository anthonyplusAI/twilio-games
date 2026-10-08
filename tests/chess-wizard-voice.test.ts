import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChessServer } from '../server/chess-server';
import { ChessVoiceSession, type ChessVoiceInterpretContext } from '../server/chess-voice';
import type { VoiceInterpretResult } from '../server/voice-interpreter';
import { WIZARD_CHESS_RESOLVED_DURATION_MS,
  WIZARD_CHESS_STORY_DURATION_MS, WIZARD_CHESS_VICTORY_AT_MS } from '../shared/wizard-chess-scene';

let server: ChessServer | null = null;

afterEach(() => {
  server?.stopLoopOnly();
  server = null;
  vi.useRealTimers();
});

function harness(interpret?: (spoken: string, context: ChessVoiceInterpretContext) => Promise<VoiceInterpretResult>) {
  server = new ChessServer({ random: () => 0 });
  const calls: string[] = [];
  const speech: Array<{ line: string; guard?: () => boolean }> = [];
  const session = new ChessVoiceSession({
    bind: (code, name, callSid, locale) => server!.voiceJoin(code, name, callSid, locale),
    leave: (code, _playerId, callSid) => server!.voiceLeave(code, callSid),
    command: (code, callSid, text, locale) => {
      calls.push(text);
      return server!.voiceCommand(code, callSid, text, locale);
    },
    restart: (code, callSid) => server!.voiceRestart(code, callSid),
    snapshot: code => server!.snapshot(code),
    legalMoves: (code, callSid, locale) => server!.voiceLegalMoves(code, callSid, locale),
    ...(interpret ? { interpret: (spoken: string, _locale: 'en-US' | 'pt-BR',
      context: ChessVoiceInterpretContext) => interpret(spoken, context) } : {}),
    say: (line, guard) => { speech.push({ line, guard }); },
  });
  session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA-voice',
    customParameters: { roomCode: 'WIZ', locale: 'en-US' } }));
  const prompt = (voicePrompt: string) => session.handleMessage(JSON.stringify({
    type: 'prompt', voicePrompt, last: true,
  }));
  return { server, session, calls, speech, prompt };
}

describe('wizard scene Conversation Relay routing', () => {
  it('grounds a semantic summon and waits for the screen cue before interpreting Ron’s move', async () => {
    const contexts: ChessVoiceInterpretContext[] = [];
    const game = harness(async (_spoken, context) => {
      contexts.push(context);
      return context.wizardAvailable
        ? { kind: 'action', actionId: 'wizard_start' }
        : { kind: 'action', actionId: 'wizard_final' };
    });
    const ordinaryFen = game.server.snapshot('WIZ')!.fen;
    game.prompt('Let’s visit the great hall chess battle');
    await game.session.whenSpeechSettled();
    expect(contexts[0]).toMatchObject({ wizardAvailable: true, wizardScene: null });
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('story');
    game.prompt('Ron should take the brave path now');
    await game.session.whenSpeechSettled();
    expect(contexts).toHaveLength(1);
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('story');
    game.prompt('skip to the move');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    game.prompt('I think Ron should move his knight to H3');
    await game.session.whenSpeechSettled();
    expect(contexts[1]).toMatchObject({ wizardAvailable: false,
      wizardScene: { phase: 'ready' }, legalMoves: [] });
    expect(game.calls).toEqual(['wizard chess', 'Ron should take the brave path now',
      'skip to the move', 'knight to H3']);
    expect(game.server.snapshot('WIZ')).toMatchObject({ fen: ordinaryFen,
      wizardScene: { phase: 'resolved' }, phase: 'playing', result: null });
  });

  it('drops stale semantic decisions after the caller exits during interpretation', async () => {
    let answer!: (decision: VoiceInterpretResult) => void;
    const game = harness(() => new Promise(resolve => { answer = resolve; }));
    game.prompt('wizard chess');
    const intro = game.speech[0]!;
    expect(game.speech).toHaveLength(1); // Harry's first screen line starts immediately.
    expect(intro.guard?.()).toBe(false);

    game.prompt('skip to the move');
    game.prompt('Ron should make the brave leap');
    game.prompt('exit wizard chess');
    expect(game.server.snapshot('WIZ')?.wizardScene).toBeNull();
    answer({ kind: 'action', actionId: 'wizard_final' });
    await game.session.whenSpeechSettled();
    expect(game.calls).toEqual(['wizard chess', 'skip to the move', 'exit wizard chess']);
    expect(game.server.findRoom('WIZ')!.state()).toMatchObject({ ply: 0, result: null });
  });

  it('holds an early H3 until the dialogue reaches Ron’s move cue', () => {
    vi.useFakeTimers();
    const game = harness();
    const fen = game.server.snapshot('WIZ')!.fen;
    game.prompt('wizard chess');
    const startedSpeechCount = game.speech.length;
    game.prompt('pawn E2 to E4');
    expect(game.speech).toHaveLength(startedSpeechCount);
    expect(game.server.snapshot('WIZ')).toMatchObject({ fen, pendingMove: null,
      wizardScene: { phase: 'story' } });
    game.prompt('knight to H3');
    expect(game.server.snapshot('WIZ')).toMatchObject({ fen, pendingMove: null,
      wizardScene: { phase: 'story' } });
    expect(game.speech.at(-1)?.line).toMatch(/hold|wait/i);
    const spokenCount = game.speech.length;
    game.prompt('knight to H3');
    expect(game.speech).toHaveLength(spokenCount); // Repeated early speech stays out of the dialogue.
    vi.advanceTimersByTime(WIZARD_CHESS_STORY_DURATION_MS);
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    vi.advanceTimersByTime(700);
    game.prompt('knight to H3');
    expect(game.server.snapshot('WIZ')).toMatchObject({ fen, pendingMove: null,
      wizardScene: { phase: 'resolved' } });
    expect(game.speech.at(-1)?.line).toMatch(/watch the board/i);
    expect(game.speech.some(item => /checkmate/i.test(item.line))).toBe(false);
    vi.advanceTimersByTime(WIZARD_CHESS_VICTORY_AT_MS - 1);
    expect(game.speech.some(item => /checkmate/i.test(item.line))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(game.speech.at(-1)?.line).toMatch(/checkmate.*conversation relay/i);
    expect(game.speech.at(-1)?.guard?.()).toBe(true);
    vi.advanceTimersByTime(WIZARD_CHESS_RESOLVED_DURATION_MS - WIZARD_CHESS_VICTORY_AT_MS);
    expect(game.server.snapshot('WIZ')?.wizardScene).toBeNull();
  });

  it('keeps screen narration playing during partial caller speech, and rejects a move begun before readiness', () => {
    const game = harness();
    game.prompt('wizard chess');
    game.session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'knight to', last: false }));
    expect(game.calls).toEqual(['wizard chess']);
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('story');
    game.server.voiceCommand('WIZ', 'CA-voice', 'skip to the move', 'en-US');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    game.prompt('knight to H3');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    game.session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'Ron’s knight to', last: false }));
    game.prompt('Ron’s knight to H3');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
  });

  it('accepts a new ready-phase partial after a story interrupt with no transcript', () => {
    const game = harness();
    game.prompt('wizard chess');
    game.session.handleMessage(JSON.stringify({ type: 'interrupt',
      utteranceUntilInterrupt: 'Wizard chess', durationUntilInterruptMs: 350 }));
    game.server.voiceCommand('WIZ', 'CA-voice', 'skip to the move', 'en-US');
    game.session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'knight to', last: false }));
    game.prompt('knight to H3');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
  });

  it('rejects one partial utterance that spans the story-to-ready transition', () => {
    const game = harness();
    game.prompt('wizard chess');
    game.session.handleMessage(JSON.stringify({ type: 'interrupt',
      utteranceUntilInterrupt: 'Wizard chess', durationUntilInterruptMs: 350 }));
    game.session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'Ron’s knight to', last: false }));
    game.server.voiceCommand('WIZ', 'CA-voice', 'skip to the move', 'en-US');
    game.session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'Ron’s knight to H', last: false }));
    game.prompt('Ron’s knight to H3');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    expect(game.speech.at(-1)?.line).toMatch(/say.*again/i);
  });

  it('asks for a final-only H3 transcript again when it lands immediately after the screen cue', () => {
    vi.useFakeTimers();
    const game = harness();
    game.prompt('wizard chess');
    game.server.voiceCommand('WIZ', 'CA-voice', 'skip to the move', 'en-US');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    game.prompt('knight to H3');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    expect(game.speech.at(-1)?.line).toMatch(/say.*again/i);
    vi.advanceTimersByTime(700);
    game.prompt('knight to H3');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
  });

  it('accepts an H3 utterance whose partial transcript starts after the screen cue', () => {
    vi.useFakeTimers();
    const game = harness();
    game.prompt('wizard chess');
    game.server.voiceCommand('WIZ', 'CA-voice', 'skip to the move', 'en-US');
    game.session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'knight to', last: false }));
    game.prompt('knight to H3');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
  });

  it('does not delay a non-move question during the ready cue grace', async () => {
    vi.useFakeTimers();
    const game = harness(async () => ({ kind: 'answer', factId: 'wizard_scene' }));
    game.prompt('wizard chess');
    game.server.voiceCommand('WIZ', 'CA-voice', 'skip to the move', 'en-US');
    game.prompt('What happens next?');
    await game.session.whenSpeechSettled();
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    expect(game.speech.at(-1)?.line).toMatch(/your turn/i);
    expect(game.speech.at(-1)?.line).not.toMatch(/say.*again/i);
  });

  it('keeps the screen story playing after a Relay phone barge-in event', () => {
    const game = harness();
    game.prompt('wizard chess');
    game.session.handleMessage(JSON.stringify({ type: 'interrupt',
      utteranceUntilInterrupt: 'Wizard Chess is', durationUntilInterruptMs: 350 }));
    expect(game.calls).toEqual(['wizard chess']);
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('story');
  });

  it('cancels the delayed checkmate cue if the caller exits before the victory animation', () => {
    vi.useFakeTimers();
    const game = harness();
    game.prompt('wizard chess');
    game.prompt('skip to the move');
    game.prompt('knight to H3');
    game.prompt('exit wizard chess');
    vi.advanceTimersByTime(WIZARD_CHESS_VICTORY_AT_MS);
    expect(game.server.snapshot('WIZ')?.wizardScene).toBeNull();
    expect(game.speech.some(item => /checkmate/i.test(item.line))).toBe(false);
  });

  it('accepts a pending semantic final move once the scene is ready', async () => {
    let answer!: (decision: VoiceInterpretResult) => void;
    const game = harness(() => new Promise(resolve => { answer = resolve; }));
    game.prompt('wizard chess');
    game.prompt('skip to the move');
    game.prompt('I think Ron should move his knight to H3');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    answer({ kind: 'action', actionId: 'wizard_final' });
    await game.session.whenSpeechSettled();
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
  });

  it('requires the caller to name H3 even if the semantic model guesses the move', async () => {
    const game = harness(async () => ({ kind: 'action', actionId: 'wizard_final' }));
    game.prompt('wizard chess');
    game.prompt('skip to the move');
    game.prompt('Ron should take the brave path now');
    await game.session.whenSpeechSettled();
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    expect(game.calls).toEqual(['wizard chess', 'skip to the move']);
    expect(game.speech.at(-1)?.line).toMatch(/knight move/i);
    game.prompt('Don’t move Ron’s knight to H3');
    await game.session.whenSpeechSettled();
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
  });

  it('accepts a conversational H-tree transcription of Ron’s explicit move', async () => {
    const game = harness(async () => ({ kind: 'action', actionId: 'wizard_final' }));
    game.prompt('wizard chess');
    game.prompt('skip to the move');
    game.prompt('I think Ron should move his knight to H tree');
    await game.session.whenSpeechSettled();
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
  });

  it.each(['age three', 'H free'])(
    'accepts conversational Ron move intent despite an %s transcription', async square => {
      const interpreted: string[] = [];
      const game = harness(async spoken => {
        interpreted.push(spoken);
        return { kind: 'action', actionId: 'wizard_final' };
      });
      game.prompt('wizard chess');
      game.prompt('skip to the move');
      const command = `I think Ron should move his knight to ${square}`;
      game.prompt(command);
      await game.session.whenSpeechSettled();
      expect(interpreted).toEqual([command]);
      expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
    },
  );

  it.each(['What if Ron moves his knight to age three?',
    'Don’t move Ron’s knight to H free'])(
    'rejects a non-command %s even when the model guesses wizard_final', async command => {
      const game = harness(async () => ({ kind: 'action', actionId: 'wizard_final' }));
      game.prompt('wizard chess');
      game.prompt('skip to the move');
      game.prompt(command);
      await game.session.whenSpeechSettled();
      expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    },
  );

  it('keeps a story question from stopping dialogue or becoming Ron’s move', async () => {
    const game = harness(async () => ({ kind: 'action', actionId: 'wizard_final' }));
    game.prompt('wizard chess');
    game.prompt('What happens if Ron moves to H3?');
    await game.session.whenSpeechSettled();
    expect(game.calls).toEqual(['wizard chess', 'What happens if Ron moves to H3?']);
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('story');
  });
});
