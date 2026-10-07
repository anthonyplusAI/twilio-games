import { describe, expect, it, vi } from 'vitest';
import { ChessRoom } from '../server/chess-room';

function whiteRoom(fen?: string): ChessRoom {
  const room = new ChessRoom('MAGIC', { humanColor: 'w', initialFen: fen, random: () => 0.2 });
  room.setPlayerConnected(true);
  return room;
}

describe('Voice Chess room', () => {
  it('assigns a random side and makes the opening move when the human is black', () => {
    const white = new ChessRoom('WHITE', { random: () => 0.1 });
    const black = new ChessRoom('BLACK', { random: () => 0.9, aiDepth: 1 });
    expect(white.state()).toMatchObject({ humanColor: 'w', computerColor: 'b', phase: 'waiting', ply: 0 });
    expect(black.state()).toMatchObject({ humanColor: 'b', computerColor: 'w', phase: 'waiting', ply: 1, turn: 'b' });
    expect(black.state().lastMove).toMatchObject({ actor: 'computer', color: 'w', ply: 1 });
    expect(black.drainEvents()).toContainEqual(expect.objectContaining({ type: 'move', move: expect.objectContaining({ actor: 'computer' }) }));
  });

  it('proposes without moving, confirms only the human move, then plays the computer turn separately', () => {
    const room = whiteRoom();
    const startFen = room.state().fen;
    const proposed = room.handleVoiceCommand('E2 to E4');
    expect(proposed.code).toBe('proposed');
    expect(room.state()).toMatchObject({ phase: 'pending', fen: startFen, revision: 0,
      pendingMove: { from: 'e2', to: 'e4', piece: 'p', baseRevision: 0 } });
    expect(room.drainEvents()).toContainEqual(expect.objectContaining({ type: 'proposal' }));

    const confirmed = room.handleVoiceCommand('confirm');
    expect(confirmed.code).toBe('confirmed');
    expect(room.state()).toMatchObject({ phase: 'playing', revision: 1, ply: 1, turn: 'b', pendingMove: null,
      lastMove: { actor: 'human', from: 'e2', to: 'e4', ply: 1, revision: 1 } });
    expect(room.state().pieces).toContainEqual({ square: 'e4', color: 'w', type: 'p' });
    const humanEvents = room.drainEvents();
    expect(humanEvents.filter(event => event.type === 'move')).toHaveLength(1);

    const ai = room.playComputerMove(room.state().revision);
    expect(ai).not.toBeNull();
    expect(room.state()).toMatchObject({ revision: 2, ply: 2, turn: 'w', lastMove: { actor: 'computer', ply: 2 } });
    expect(room.drainEvents().filter(event => event.type === 'move')).toHaveLength(1);
  });

  it('exposes only current legal human moves for semantic speech interpretation', () => {
    const room = whiteRoom();
    const opening = room.legalVoiceMoves('en-US');
    expect(opening).toContainEqual(expect.objectContaining({ id: 'e2e4', label: expect.stringMatching(/pawn.*E2.*E4/i) }));
    expect(opening.some(move => move.id === 'e2e5')).toBe(false);
    expect(room.handleVoiceCommand('pawn from E2 to E4').code).toBe('proposed');
    expect(room.legalVoiceMoves('en-US').some(move => move.id === 'e2e4')).toBe(true);
    expect(room.handleVoiceCommand('confirm').code).toBe('confirmed');
    expect(room.legalVoiceMoves('en-US')).toEqual([]);
    room.playComputerMove(room.state().revision);
    expect(room.legalVoiceMoves('pt-BR').length).toBeGreaterThan(0);
    room.setPlayerConnected(false);
    expect(room.legalVoiceMoves('en-US')).toEqual([]);
  });

  it('cancels proposals and refuses stale or illegal commands without changing the board', () => {
    const room = whiteRoom();
    const fen = room.state().fen;
    expect(room.handleVoiceCommand('knight to E5').code).toBe('illegal');
    expect(room.state().fen).toBe(fen);
    expect(room.handleVoiceCommand('pawn to E4').code).toBe('proposed');
    expect(room.handleVoiceCommand('cancel').code).toBe('cancelled');
    expect(room.state()).toMatchObject({ fen, pendingMove: null, phase: 'playing' });
    expect(room.handleVoiceCommand('confirm').code).toBe('no_pending');
    expect(room.handleVoiceCommand('pawn to E4').code).toBe('proposed');
    expect(room.confirmMove(99).code).toBe('stale');
    expect(room.state().fen).toBe(fen);
  });

  it('asks for the full move with its source square when two pieces can reach one destination', () => {
    const room = whiteRoom('4k3/8/8/8/8/3N1N2/8/4K3 w - - 0 1');
    const fen = room.state().fen;
    const result = room.handleVoiceCommand('knight to E5');
    expect(result.code).toBe('ambiguous');
    expect(result.message).toMatch(/repeat the full move/i);
    expect(result.candidates?.map(move => move.from).sort()).toEqual(['d3', 'f3']);
    expect(room.state().fen).toBe(fen);
    expect(room.handleVoiceCommand('knight from F3 to E5').code).toBe('proposed');
    expect(room.state().pendingMove).toMatchObject({ from: 'f3', to: 'e5' });
  });

  it('resolves conversational piece and destination requests only when one legal source fits', () => {
    const unique = whiteRoom('4k3/p7/8/8/8/8/1B6/4K3 w - - 0 1');
    const startFen = unique.state().fen;
    expect(unique.handleVoiceCommand('move my bishop to C3').code).toBe('proposed');
    expect(unique.state()).toMatchObject({ fen: startFen, pendingMove: { from: 'b2', to: 'c3', piece: 'b' } });

    const ambiguous = whiteRoom('4k3/p7/8/8/8/8/1B1B4/4K3 w - - 0 1');
    const answer = ambiguous.handleVoiceCommand('move my bishop to C3');
    expect(answer.code).toBe('ambiguous');
    expect(answer.candidates?.map(move => move.from).sort()).toEqual(['b2', 'd2']);
    expect(ambiguous.state().pendingMove).toBeNull();
  });

  it('uses file and column hints against the live board without bypassing confirmation', () => {
    const room = whiteRoom('4k3/p7/8/8/8/8/8/1N1NK3 w - - 0 1');
    const startFen = room.state().fen;
    for (const speech of ['move the knight on B to C3', 'B-file knight to C3', 'knight B to C3', 'knight from column B to C3']) {
      expect(room.handleVoiceCommand(speech).code).toBe('proposed');
      expect(room.state()).toMatchObject({ fen: startFen, pendingMove: { from: 'b1', to: 'c3', piece: 'n' } });
      expect(room.handleVoiceCommand('cancel').code).toBe('cancelled');
    }
    expect(room.handleVoiceCommand('cavalo da coluna B para C3', 'pt-BR').code).toBe('proposed');
    expect(room.state()).toMatchObject({ fen: startFen, pendingMove: { from: 'b1', to: 'c3', piece: 'n' } });
  });

  it('resolves a file-only piece selection now and accepts the destination after a pause', () => {
    vi.useFakeTimers();
    try {
      const room = whiteRoom('4k3/p7/8/8/8/8/8/1N1NK3 w - - 0 1');
      const startFen = room.state().fen;
      expect(room.handleVoiceCommand('move the knight on B').code).toBe('selected');
      expect(room.state().selection).toEqual({ from: 'b1', piece: 'n' });
      vi.advanceTimersByTime(120_000);
      expect(room.handleVoiceCommand('to C3').code).toBe('proposed');
      expect(room.state()).toMatchObject({ fen: startFen, pendingMove: { from: 'b1', to: 'c3' } });
      expect(room.handleVoiceCommand('cancel').code).toBe('cancelled');
      expect(room.handleVoiceCommand('B-file knight').code).toBe('selected');
      expect(room.state().selection).toEqual({ from: 'b1', piece: 'n' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clarifies a file-only reference when two own pieces of that type are on the file', () => {
    const room = whiteRoom('4k3/p7/8/8/8/1N6/8/1N2K3 w - - 0 1');
    const answer = room.handleVoiceCommand('move the knight on B');
    expect(answer.code).toBe('ambiguous');
    expect(answer.message).toMatch(/B1.*B3|B3.*B1/);
    expect(room.state().selection).toBeNull();
    expect(room.state().pendingMove).toBeNull();
  });

  it('lets a newly named file override an earlier selected source', () => {
    const room = whiteRoom('4k3/p7/8/8/8/8/4N3/1N2K3 w - - 0 1');
    expect(room.handleVoiceCommand('knight on B').code).toBe('selected');
    expect(room.state().selection).toEqual({ from: 'b1', piece: 'n' });
    expect(room.handleVoiceCommand('the E-file knight to C3').code).toBe('proposed');
    expect(room.state().pendingMove).toMatchObject({ from: 'e2', to: 'c3', piece: 'n' });
    expect(room.state().selection).toBeNull();
  });

  it('rejects a source file with no matching legal move instead of choosing another piece', () => {
    const room = whiteRoom('4k3/p7/8/8/8/8/8/3NK3 w - - 0 1');
    const startFen = room.state().fen;
    expect(room.handleVoiceCommand('knight to C3').code).toBe('proposed');
    expect(room.handleVoiceCommand('knight on B to C3').code).toBe('illegal');
    expect(room.state()).toMatchObject({ fen: startFen, pendingMove: null });
    expect(room.handleVoiceCommand('confirm').code).toBe('no_pending');
  });

  it('accepts two-step selection of a piece and target square', () => {
    const room = whiteRoom();
    expect(room.handleVoiceCommand('select E2').code).toBe('selected');
    expect(room.state().selection).toEqual({ from: 'e2', piece: 'p' });
    expect(room.handleVoiceCommand('E4').code).toBe('proposed');
    expect(room.state().pendingMove).toMatchObject({ from: 'e2', to: 'e4' });
  });

  it('retains a naturally named starting square through a long thinking pause', () => {
    vi.useFakeTimers();
    try {
      const room = whiteRoom();
      expect(room.handleVoiceCommand('pawn E2').code).toBe('selected');
      expect(room.state().selection).toEqual({ from: 'e2', piece: 'p' });
      vi.advanceTimersByTime(120_000);
      expect(room.handleVoiceCommand('E4').code).toBe('proposed');
      expect(room.state().pendingMove).toMatchObject({ from: 'e2', to: 'e4' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers position-independent voice help without an illegal opening example', () => {
    const room = whiteRoom();
    for (const command of ['help', 'gibberish']) {
      const message = room.handleVoiceCommand(command).message;
      expect(message).toMatch(/piece.*destination/i);
      expect(message).not.toMatch(/knight to E six/i);
    }
  });

  it('includes castling rook travel in the committed move', () => {
    const room = whiteRoom('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const proposal = room.handleVoiceCommand('castle kingside');
    expect(proposal.code).toBe('proposed');
    expect(proposal.message).toMatch(/castle kingside/i);
    expect(proposal.message).not.toMatch(/O-O/);
    expect(room.confirmMove().code).toBe('confirmed');
    expect(room.state().lastMove).toMatchObject({ from: 'e1', to: 'g1', castle: 'king', rookFrom: 'h1', rookTo: 'f1' });
    expect(room.state().pieces).toContainEqual({ square: 'f1', color: 'w', type: 'r' });
  });

  it('clarifies a bare castle when both sides are legal, without selecting a rook move', () => {
    const room = whiteRoom('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    const answer = room.handleVoiceCommand('castle');
    expect(answer.code).toBe('ambiguous');
    expect(answer.message).toMatch(/kingside.*queenside/i);
    expect(room.state().pendingMove).toBeNull();
  });

  it('lets bare castle propose the only legal side and commits both king and rook after confirmation', () => {
    const room = whiteRoom('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
    expect(room.handleVoiceCommand('castle').code).toBe('proposed');
    expect(room.state().pendingMove).toMatchObject({ castle: 'king', from: 'e1', to: 'g1' });
    expect(room.confirmMove().code).toBe('confirmed');
    expect(room.state().lastMove).toMatchObject({ from: 'e1', to: 'g1', rookFrom: 'h1', rookTo: 'f1' });
  });

  it('reports the actual captured square for en passant', () => {
    const room = whiteRoom('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    expect(room.handleVoiceCommand('pawn from E5 to D6').code).toBe('proposed');
    expect(room.confirmMove().code).toBe('confirmed');
    expect(room.state().lastMove).toMatchObject({ captured: 'p', capturedSquare: 'd5', enPassant: true });
    expect(room.state().pieces).not.toContainEqual({ square: 'd5', color: 'b', type: 'p' });
  });

  it('supports explicit underpromotion and sensible default queen promotion', () => {
    const rookRoom = whiteRoom('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    expect(rookRoom.handleVoiceCommand('pawn from A7 to A8 promote to rook').code).toBe('proposed');
    rookRoom.confirmMove();
    expect(rookRoom.state().lastMove).toMatchObject({ promotion: 'r' });

    const queenRoom = whiteRoom('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    expect(queenRoom.handleVoiceCommand('pawn to A8').code).toBe('proposed');
    queenRoom.confirmMove();
    expect(queenRoom.state().pieces).toContainEqual({ square: 'a8', color: 'w', type: 'q' });
  });

  it('recognizes a fifty-move draw and starts a fresh game only when asked', () => {
    const room = whiteRoom('4k3/8/8/8/8/8/7p/4K3 w - - 99 50');
    expect(room.handleVoiceCommand('king from E1 to D1').code).toBe('proposed');
    room.confirmMove();
    expect(room.state()).toMatchObject({ phase: 'finished', result: { reason: 'fifty_move', winner: null } });
    const revision = room.state().revision;
    const gameId = room.state().gameId;
    expect(room.handleVoiceCommand('play again').code).toBe('reset');
    expect(room.state()).toMatchObject({ phase: 'playing', result: null, ply: 0, gameId: gameId + 1 });
    expect(room.state().revision).toBeGreaterThan(revision);
  });

  it('recognizes checkmate and announces the human winner without scheduling another turn', () => {
    const room = whiteRoom('7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1');
    expect(room.handleVoiceCommand('queen to G7').code).toBe('proposed');
    expect(room.confirmMove().code).toBe('confirmed');
    expect(room.state()).toMatchObject({
      phase: 'finished', result: { reason: 'checkmate', winner: 'w' },
      lastMove: { captured: 'p', check: true, checkmate: true },
    });
    expect(room.playComputerMove(room.state().revision)).toBeNull();
  });

  it('takes a hanging queen instead of making the first legal move', () => {
    const room = new ChessRoom('TACTIC', {
      humanColor: 'b', initialFen: '4k3/8/8/8/4q3/8/8/4Q1K1 w - - 0 1',
      random: () => 0.99, aiDepth: 2, aiNodeBudget: 5_000, aiTimeBudgetMs: 1_000,
    });
    expect(room.state().lastMove).toMatchObject({ actor: 'computer', from: 'e1', to: 'e4', captured: 'q' });
  });

  it('varies sensible opening moves instead of repeating one fixed move', () => {
    const openings = [0, 0.2, 0.4, 0.6, 0.8, 0.999].map(randomValue => {
      const room = new ChessRoom('OPEN', { humanColor: 'b', random: () => randomValue });
      const move = room.state().lastMove;
      expect(move?.actor).toBe('computer');
      return move?.san;
    });
    expect(new Set(openings).size).toBeGreaterThanOrEqual(3);
    expect(openings.every(move => ['e4', 'd4', 'c4', 'Nf3', 'Nc3'].includes(move ?? ''))).toBe(true);
  });

  it('does not offer a knight for the d4 pawn when deeper search runs out of nodes', () => {
    // After 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3 Nf6 5.d4, ...Nxd4?
    // loses the c6 knight to 6.cxd4. Force an incomplete two-ply search.
    const room = new ChessRoom('ITALIAN', {
      humanColor: 'w', random: () => 0,
      aiNodeBudget: 200, aiTimeBudgetMs: 1_000,
      initialFen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2BPP3/2P2N2/PP3PPP/RNBQK2R b KQkq - 0 5',
    });
    expect(room.state().lastMove).not.toMatchObject({ from: 'c6', to: 'd4' });
  });

  it('sometimes passes over a pawn capture for a quiet continuation', () => {
    const initialFen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2BPP3/2P2N2/PP3PPP/RNBQK2R b KQkq - 0 5';
    const precise = new ChessRoom('PRECISE', { humanColor: 'w', initialFen, random: () => 0 });
    const forgiving = new ChessRoom('FORGIVING', { humanColor: 'w', initialFen, random: () => 0.999 });
    expect(precise.state().lastMove?.captured).toBe('p');
    expect(forgiving.state().lastMove?.captured).toBeNull();
  });

  it('guards a delayed AI turn after reset or disconnect', () => {
    const room = whiteRoom();
    room.handleVoiceCommand('E2 to E4');
    room.confirmMove();
    const oldRevision = room.state().revision;
    room.reset();
    expect(room.playComputerMove(oldRevision)).toBeNull();

    room.handleVoiceCommand('E2 to E4');
    room.confirmMove();
    room.setPlayerConnected(false);
    expect(room.playComputerMove(room.state().revision)).toBeNull();
    expect(room.state().phase).toBe('waiting');
  });
});
