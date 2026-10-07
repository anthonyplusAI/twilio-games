import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChessServer } from '../server/chess-server';
import { ChessVoiceSession, type ChessVoiceInterpretContext } from '../server/chess-voice';
import type { VoiceInterpretResult } from '../server/voice-interpreter';
import { WIZARD_CHESS_RESOLVED_DURATION_MS,
  WIZARD_CHESS_VICTORY_AT_MS } from '../shared/wizard-chess-scene';

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
  it('grounds a semantic summon and the H3 action in the current scene', async () => {
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
    expect(contexts[1]).toMatchObject({ wizardAvailable: false,
      wizardScene: { phase: 'ready' }, legalMoves: [] });
    expect(game.calls).toEqual(['wizard chess', 'skip to the move', 'knight to H3']);
    expect(game.server.snapshot('WIZ')).toMatchObject({ fen: ordinaryFen,
      wizardScene: { phase: 'resolved' }, phase: 'playing', result: null });
  });

  it('drops stale semantic decisions after the caller exits during interpretation', async () => {
    let answer!: (decision: VoiceInterpretResult) => void;
    const game = harness(() => new Promise(resolve => { answer = resolve; }));
    game.prompt('wizard chess');
    const intro = game.speech[0]!;
    const started = game.speech.at(-1)!;
    expect(intro.guard?.()).toBe(false);
    expect(started.guard?.()).toBe(true);

    game.prompt('Ron should make the brave leap');
    game.prompt('exit wizard chess');
    expect(started.guard?.()).toBe(false);
    expect(game.server.snapshot('WIZ')?.wizardScene).toBeNull();
    answer({ kind: 'action', actionId: 'wizard_final' });
    await game.session.whenSpeechSettled();
    expect(game.calls).toEqual(['wizard chess', 'skip to the move', 'exit wizard chess']);
    expect(game.server.findRoom('WIZ')!.state()).toMatchObject({ ply: 0, result: null });
  });

  it('routes an immediate spoken H3 through the scene while normal chess commands remain suspended', () => {
    vi.useFakeTimers();
    const game = harness();
    const fen = game.server.snapshot('WIZ')!.fen;
    game.prompt('wizard chess');
    game.prompt('pawn E2 to E4');
    expect(game.speech.at(-1)?.line).toMatch(/in this scene/i);
    expect(game.server.snapshot('WIZ')).toMatchObject({ fen, pendingMove: null,
      wizardScene: { phase: 'ready' } });
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

  it('stops screen narration as soon as Relay reports caller speech, before the final command', () => {
    const game = harness();
    game.prompt('wizard chess');
    game.session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: 'Ron', last: false }));
    expect(game.calls).toEqual(['wizard chess', 'skip to the move']);
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    game.prompt('Ron’s knight to H3');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
  });

  it('stops the story on a Relay barge-in event even before a transcript is available', () => {
    const game = harness();
    game.prompt('wizard chess');
    game.session.handleMessage(JSON.stringify({ type: 'interrupt',
      utteranceUntilInterrupt: 'Wizard Chess is', durationUntilInterruptMs: 350 }));
    expect(game.calls).toEqual(['wizard chess', 'skip to the move']);
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
  });

  it('cancels the delayed checkmate cue if the caller exits before the victory animation', () => {
    vi.useFakeTimers();
    const game = harness();
    game.prompt('wizard chess');
    game.prompt('knight to H3');
    game.prompt('exit wizard chess');
    vi.advanceTimersByTime(WIZARD_CHESS_VICTORY_AT_MS);
    expect(game.server.snapshot('WIZ')?.wizardScene).toBeNull();
    expect(game.speech.some(item => /checkmate/i.test(item.line))).toBe(false);
  });

  it('accepts a pending semantic final move after speech interrupts the story', async () => {
    let answer!: (decision: VoiceInterpretResult) => void;
    const game = harness(() => new Promise(resolve => { answer = resolve; }));
    game.prompt('wizard chess');
    game.prompt('Ron should take the brave leap');
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    answer({ kind: 'action', actionId: 'wizard_final' });
    await game.session.whenSpeechSettled();
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
  });

  it('stops screen dialogue for a question without letting an answer become Ron’s move', async () => {
    const game = harness(async () => ({ kind: 'action', actionId: 'wizard_final' }));
    game.prompt('wizard chess');
    game.prompt('What happens if Ron moves to H3?');
    await game.session.whenSpeechSettled();
    expect(game.calls).toEqual(['wizard chess', 'skip to the move']);
    expect(game.server.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
  });
});
