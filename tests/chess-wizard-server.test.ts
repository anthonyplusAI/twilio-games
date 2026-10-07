import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChessServer, CHESS_WIZARD_ORPHAN_READY_MS } from '../server/chess-server';
import { ChessRoom } from '../server/chess-room';
import { WIZARD_CHESS_RESOLVED_DURATION_MS, WIZARD_CHESS_STORY_DURATION_MS } from '../shared/wizard-chess-scene';

let chess: ChessServer | null = null;

afterEach(() => {
  chess?.stopLoopOnly();
  chess = null;
  vi.useRealTimers();
});

function server(humanColor: 'w' | 'b' = 'w'): ChessServer {
  chess = new ChessServer({ random: () => 0,
    roomFactory: code => new ChessRoom(code, { humanColor, random: () => 0,
      aiDepth: 1, aiNodeBudget: 150, aiTimeBudgetMs: 40 }) });
  return chess;
}

function attachFakeDisplay(game: ChessServer): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  const ws = { readyState: 1,
    send: (text: string) => frames.push(JSON.parse(text) as Record<string, unknown>),
    terminate: () => {} };
  (game as unknown as { displays: Set<unknown> }).displays.add({ ws, roomCode: 'WIZ',
    locale: 'en-US', authenticatedRoomCode: null, alive: true });
  return frames;
}

function sendFakeDisplay(game: ChessServer, message: Record<string, unknown>): void {
  const display = [...(game as unknown as { displays: Set<unknown> }).displays][0]!;
  (game as unknown as { onMessage: (display: unknown, raw: string) => void })
    .onMessage(display, JSON.stringify(message));
}

describe('Voice Chess wizard scene', () => {
  it('lets a caller summon the scene once at the opening, then restores a fresh ordinary board after the finale', () => {
    vi.useFakeTimers();
    const game = server();
    expect(game.voiceJoin('WIZ', 'Ada', 'CA-wizard', 'en-US')).toMatchObject({ resumed: false });
    const before = game.snapshot('WIZ')!;
    expect(before).toMatchObject({ wizardAvailable: true, wizardScene: null, ply: 0, result: null });

    const started = game.voiceCommand('WIZ', 'CA-wizard', 'Let’s play Harry Potter chess', 'en-US');
    expect(started).toMatchObject({ code: 'wizard_started', state: { wizardAvailable: false,
      wizardScene: { phase: 'story' } } });
    expect(game.voiceLegalMoves('WIZ', 'CA-wizard', 'en-US')).toEqual([]);
    expect(game.findRoom('WIZ')!.state()).toMatchObject({ fen: before.fen, revision: before.revision,
      ply: before.ply, phase: 'playing', result: null });
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'pawn from E2 to E4', 'en-US')).toMatchObject({
      code: 'wizard_waiting', state: { fen: before.fen, pendingMove: null },
    });
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'hint', 'en-US')).toMatchObject({
      code: 'wizard_hint', state: { hintsRemaining: 3, wizardScene: { phase: 'ready' } },
    });
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'Ron to H three', 'en-US')).toMatchObject({
      code: 'wizard_resolved', state: { wizardScene: { phase: 'resolved' }, fen: before.fen,
        revision: before.revision, ply: before.ply, result: null },
    });
    expect(game.findRoom('WIZ')!.phase).toBe('playing');

    vi.advanceTimersByTime(WIZARD_CHESS_RESOLVED_DURATION_MS - 1);
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
    vi.advanceTimersByTime(1);
    expect(game.snapshot('WIZ')).toMatchObject({ gameId: before.gameId + 1, wizardScene: null,
      wizardAvailable: false, ply: 0, phase: 'playing', result: null });
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'wizard chess', 'en-US')?.code).not.toBe('wizard_started');
    game.voiceLeave('WIZ', 'CA-wizard');
    expect(game.voiceJoin('WIZ', 'Grace', 'CA-new', 'en-US')).toMatchObject({ resumed: false });
    expect(game.snapshot('WIZ')?.wizardAvailable).toBe(true);
  });

  it('accepts a pending opening as still before a human move and leaves the underlying board intact on exit', () => {
    const game = server();
    game.voiceJoin('WIZ', 'Ada', 'CA-wizard', 'en-US');
    const fen = game.findRoom('WIZ')!.state().fen;
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'pawn E2 to E4', 'en-US')?.code).toBe('proposed');
    expect(game.snapshot('WIZ')?.wizardAvailable).toBe(true);
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'wizard chess', 'en-US')).toMatchObject({
      code: 'wizard_started', state: { pendingMove: null, fen },
    });
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'back to normal chess', 'en-US')).toMatchObject({
      code: 'wizard_exited', state: { wizardScene: null, wizardAvailable: false, fen,
        ply: 0, revision: 0 },
    });
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'wizard chess', 'en-US')?.code).not.toBe('wizard_started');
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'pawn E2 to E4', 'en-US')?.code).toBe('proposed');
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'confirm', 'en-US')?.code).toBe('confirmed');
    expect(game.snapshot('WIZ')).toMatchObject({ wizardAvailable: false, ply: 1 });
  });

  it('lets an authorized screen skip the story without allowing a stale or cross-room tap', () => {
    vi.useFakeTimers();
    const game = server();
    const frames = attachFakeDisplay(game);
    game.voiceJoin('WIZ', 'Ada', 'CA-wizard', 'en-US');
    game.voiceCommand('WIZ', 'CA-wizard', 'wizard chess', 'en-US');
    const sceneId = game.snapshot('WIZ')!.wizardScene!.id;
    sendFakeDisplay(game, { type: 'display_wizard_skip', roomCode: 'OTHER', sceneId });
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('story');
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'bad_display_auth' });
    sendFakeDisplay(game, { type: 'display_wizard_skip', roomCode: 'WIZ', sceneId: sceneId + 1 });
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('story');
    sendFakeDisplay(game, { type: 'display_wizard_skip', roomCode: 'WIZ', sceneId });
    expect(game.snapshot('WIZ')?.wizardScene).toMatchObject({ id: sceneId, phase: 'ready' });
    vi.advanceTimersByTime(WIZARD_CHESS_STORY_DURATION_MS);
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
  });

  it('requires the station display token before a shared-screen skip', () => {
    const game = server();
    game.setDisplayAuthenticationRequirement(code => code === 'WIZ');
    const frames = attachFakeDisplay(game);
    game.voiceJoin('WIZ', 'Ada', 'CA-station', 'en-US', true);
    game.voiceCommand('WIZ', 'CA-station', 'wizard chess', 'en-US');
    const sceneId = game.snapshot('WIZ')!.wizardScene!.id;
    sendFakeDisplay(game, { type: 'display_wizard_skip', roomCode: 'WIZ', sceneId });
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('story');
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'bad_display_auth' });
    const display = [...(game as unknown as { displays: Set<{ authenticatedRoomCode: string | null }> }).displays][0]!;
    display.authenticatedRoomCode = 'WIZ';
    sendFakeDisplay(game, { type: 'display_wizard_skip', roomCode: 'WIZ', sceneId });
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
  });

  it('does not summon the scene after the first committed human move', () => {
    const game = server();
    game.voiceJoin('WIZ', 'Ada', 'CA-wizard', 'en-US');
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'pawn E2 to E4', 'en-US')?.code).toBe('proposed');
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'confirm', 'en-US')?.code).toBe('confirmed');
    const moved = game.findRoom('WIZ')!.state();
    expect(game.snapshot('WIZ')?.wizardAvailable).toBe(false);
    expect(game.voiceCommand('WIZ', 'CA-wizard', 'Harry Potter chess', 'en-US')?.code).not.toBe('wizard_started');
    expect(game.findRoom('WIZ')!.state()).toMatchObject({ fen: moved.fen,
      revision: moved.revision });
  });

  it('offers the scene after the computer opens for Black, and keeps it over a transient disconnect', () => {
    vi.useFakeTimers();
    const game = server('b');
    game.voiceJoin('WIZ', 'Ada', 'CA-black', 'en-US');
    const before = game.snapshot('WIZ')!;
    expect(before).toMatchObject({ wizardAvailable: true, humanColor: 'b', ply: 1,
      lastMove: { actor: 'computer' } });
    expect(game.voiceCommand('WIZ', 'CA-black', 'Sorcerer’s Stone chess', 'en-US')?.code).toBe('wizard_started');
    expect(game.voiceSetConnected('WIZ', 'CA-black', false)).toBe(true);
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('story');
    vi.advanceTimersByTime(WIZARD_CHESS_STORY_DURATION_MS);
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    expect(game.voiceJoin('WIZ', 'Ada', 'CA-black', 'en-US')).toMatchObject({ resumed: true });
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    expect(game.voiceCommand('WIZ', 'CA-black', 'skip to the move', 'en-US')?.code).toBe('wizard_skipped');
    expect(game.voiceCommand('WIZ', 'CA-black', 'knight to H3', 'en-US')?.code).toBe('wizard_resolved');
    expect(game.findRoom('WIZ')!.state()).toMatchObject({ fen: before.fen,
      revision: before.revision, ply: 1, result: null });
  });

  it('cannot let an old scene timer reset a new caller’s game', () => {
    vi.useFakeTimers();
    const game = server();
    attachFakeDisplay(game);
    game.voiceJoin('WIZ', 'Ada', 'CA-old', 'en-US');
    game.voiceCommand('WIZ', 'CA-old', 'wizard chess', 'en-US');
    game.voiceCommand('WIZ', 'CA-old', 'knight to H3', 'en-US');
    game.voiceLeave('WIZ', 'CA-old');
    game.voiceJoin('WIZ', 'Grace', 'CA-new', 'en-US');
    const next = game.snapshot('WIZ')!;
    vi.advanceTimersByTime(WIZARD_CHESS_STORY_DURATION_MS + WIZARD_CHESS_RESOLVED_DURATION_MS);
    expect(game.snapshot('WIZ')).toMatchObject({ gameId: next.gameId, fen: next.fen,
      wizardScene: null, wizardAvailable: true });
  });

  it('lets the story finish on an attended screen after the caller leaves', () => {
    vi.useFakeTimers();
    const game = server();
    const frames = attachFakeDisplay(game);
    game.voiceJoin('WIZ', 'Ada', 'CA-old', 'en-US');
    const before = game.snapshot('WIZ')!;
    game.voiceCommand('WIZ', 'CA-old', 'wizard chess', 'en-US');
    game.voiceLeave('WIZ', 'CA-old');
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('story');
    vi.advanceTimersByTime(WIZARD_CHESS_STORY_DURATION_MS);
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    vi.advanceTimersByTime(CHESS_WIZARD_ORPHAN_READY_MS - 1);
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('ready');
    vi.advanceTimersByTime(1);
    expect(game.snapshot('WIZ')).toMatchObject({ wizardScene: null, fen: before.fen,
      gameId: before.gameId, playerConnected: false });
    expect(frames.some(frame => frame.type === 'chess_state'
      && (frame.wizardScene as { phase?: string } | null)?.phase === 'ready')).toBe(true);
  });

  it('keeps a resolved victory on an attended screen for its full countdown after hangup', () => {
    vi.useFakeTimers();
    const game = server();
    attachFakeDisplay(game);
    game.voiceJoin('WIZ', 'Ada', 'CA-old', 'en-US');
    const before = game.snapshot('WIZ')!;
    game.voiceCommand('WIZ', 'CA-old', 'wizard chess', 'en-US');
    game.voiceCommand('WIZ', 'CA-old', 'H3', 'en-US');
    game.voiceLeave('WIZ', 'CA-old');
    vi.advanceTimersByTime(WIZARD_CHESS_RESOLVED_DURATION_MS - 1);
    expect(game.snapshot('WIZ')?.wizardScene?.phase).toBe('resolved');
    vi.advanceTimersByTime(1);
    expect(game.snapshot('WIZ')).toMatchObject({ wizardScene: null,
      gameId: before.gameId + 1, phase: 'waiting', result: null });
  });
});
