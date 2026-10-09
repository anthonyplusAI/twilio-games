import { describe, expect, it } from 'vitest';
import { ChessRoom } from '../server/chess-room';
import { chessPvpCaptureBanner, chessPvpMoveCaption, chessPvpScreenCopy } from '../client/chess/chess-pvp-view';

describe('shared-screen Chess copy', () => {
  it('explains how to clear a previous Chess mode before relaunching the selected mode', async () => {
    const view = await import('../client/chess/chess-pvp-view') as typeof import('../client/chess/chess-pvp-view') & {
      chessModeConflictScreenCopy?: (mode: 'solo' | 'pvp', locale: 'en-US' | 'pt-BR') => {
        title: string; detail: string; turnLabel: string; prompt: string;
      };
    };
    expect(view.chessModeConflictScreenCopy?.('pvp', 'en-US')).toMatchObject({
      title: expect.stringMatching(/solo/i),
      detail: expect.stringMatching(/previous.*call/i),
      turnLabel: expect.stringMatching(/mode/i),
      prompt: expect.stringMatching(/end.*call.*30 seconds.*Back.*2 players/i),
    });
    expect(view.chessModeConflictScreenCopy?.('solo', 'pt-BR')).toMatchObject({
      title: expect.stringMatching(/dois jogadores/i),
      prompt: expect.stringMatching(/encerre.*ligações.*30 segundos.*voltar.*1 jogador/i),
    });
  });

  it('names the callers whose phone guidance is still playing before the board starts', () => {
    const room = new ChessRoom('DUEL', { mode: 'pvp' });
    room.setPlayerSeat('w', 'c1', 'Ada', true, true, false);
    room.setPlayerSeat('b', 'c2', 'Ben', true, true, false);
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      title: '0 of 2 players ready',
      whiteLabel: expect.stringMatching(/Ada.*phone guidance playing/i),
      blackLabel: expect.stringMatching(/Ben.*phone guidance playing/i),
      detail: expect.stringMatching(/Ada and Ben.*phone guidance|phone guidance.*Ada and Ben/i),
    });
    room.markPlayerWelcomeReady('w');
    expect(chessPvpScreenCopy(room.state(), 'pt-BR')).toMatchObject({
      title: '1 de 2 jogadores prontos',
      blackLabel: expect.stringMatching(/Ben.*ouvindo orientações/i),
      detail: expect.stringMatching(/Ben/),
    });
    const finishQuestion = room.beginWaitingPhoneTurn('w');
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      whiteLabel: expect.stringMatching(/Ada.*phone conversation in progress/i),
      detail: expect.stringMatching(/Ada.*phone conversation/i),
    });
    finishQuestion?.();
  });

  it('tells the caller how to recover when phone guidance did not play', () => {
    const room = new ChessRoom('DUEL', { mode: 'pvp' });
    room.setPlayerSeat('w', 'c1', 'Ada', true, true, false);
    room.setPlayerSeat('b', 'c2', 'Ben', true, true, false);
    room.markPlayerWelcomeReady('b');
    room.markPlayerWelcomeFailed('w');
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      title: '1 of 2 players ready',
      whiteLabel: expect.stringMatching(/Ada.*say repeat/i),
      detail: expect.stringMatching(/Ada.*repeat.*reconnect/i),
    });
  });

  it('names the caller whose AI phone answer failed while keeping the board waiting', () => {
    const room = new ChessRoom('DUEL', { mode: 'pvp' });
    room.setPlayerSeat('w', 'c1', 'Ada', true, true);
    room.setPlayerSeat('b', 'c2', 'Ben', true, true, false);
    room.markWaitingPhoneTurnFailed('w');
    room.markPlayerWelcomeReady('b');
    expect(room.state()).toMatchObject({ phase: 'waiting', phoneRetryPlayerIds: ['c1'] });
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      title: '1 of 2 players ready',
      whiteLabel: expect.stringMatching(/Ada.*say repeat/i),
      detail: expect.stringMatching(/Ada.*phone answer.*repeat.*reconnect/i),
    });
  });

  it('shows each caller exactly what the shared board is waiting for', () => {
    const room = new ChessRoom('DUEL', { mode: 'pvp' });
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      title: '0 of 2 players ready', whiteLabel: expect.stringMatching(/White.*waiting/i),
      blackLabel: expect.stringMatching(/Black.*waiting/i),
    });
    room.setPlayerSeat('w', 'c1', 'Player 1', true, false);
    room.setPlayerSeat('b', 'c2', 'Player 1', true, false);
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      whiteLabel: 'White · Player 1 · Name needed',
      blackLabel: 'Black · Player 2 · Name needed',
    });
    room.setPlayerSeat('w', 'c1', 'Ada', true, true);
    room.setPlayerSeat('b', 'c2', 'Player 2', true, false);
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      title: '1 of 2 players ready', whiteLabel: expect.stringMatching(/Ada.*ready/i),
      blackLabel: expect.stringMatching(/name/i),
    });
    room.confirmPlayerName('b', 'Ben');
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      title: "Ada's turn", whiteLabel: expect.stringMatching(/Ada.*ready/i),
      blackLabel: expect.stringMatching(/Ben.*ready/i),
    });
    room.handleVoiceCommand('E2 to E4', 'en-US', 'w');
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      title: 'Ada confirms', detail: expect.stringMatching(/Ada.*confirm.*cancel/i),
    });
    room.handleVoiceCommand('confirm', 'en-US', 'w');
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      title: "Ben's turn", lastMoveLabel: 'Ada · e4',
    });
    room.setPlayerSeatConnected('b', false);
    expect(chessPvpScreenCopy(room.state(), 'en-US')).toMatchObject({
      title: 'Match paused', blackLabel: expect.stringMatching(/Ben.*reconnecting/i),
    });
  });

  it('attributes each move and capture to the named callers', () => {
    const room = new ChessRoom('DUEL', { mode: 'pvp' });
    room.setPlayerSeat('w', 'c1', 'Ada', true, true);
    room.setPlayerSeat('b', 'c2', 'Ben', true, true);
    room.handleVoiceCommand('pawn from E2 to E4', 'en-US', 'w');
    room.handleVoiceCommand('confirm', 'en-US', 'w');
    expect(chessPvpMoveCaption(room.state(), 'en-US')).toBe('Ada moved a pawn to E4.');
    room.handleVoiceCommand('pawn from D7 to D5', 'en-US', 'b');
    room.handleVoiceCommand('confirm', 'en-US', 'b');
    expect(chessPvpMoveCaption(room.state(), 'en-US')).toBe('Ben moved a pawn to D5.');
    room.handleVoiceCommand('pawn from E4 to D5', 'en-US', 'w');
    room.handleVoiceCommand('confirm', 'en-US', 'w');
    expect(chessPvpMoveCaption(room.state(), 'en-US'))
      .toBe("Ada's pawn captured Ben's pawn on D5.");
    expect(chessPvpCaptureBanner(room.state(), 'en-US')).toBe('Ada captured a pawn!');
    expect(chessPvpMoveCaption(room.state(), 'pt-BR'))
      .toBe('O peão de Ada capturou o peão de Ben em D5.');
    const queenCapture = { ...room.state(), lastMove: { ...room.state().lastMove!,
      piece: 'q' as const, captured: 'r' as const } };
    expect(chessPvpMoveCaption(queenCapture, 'pt-BR'))
      .toBe('A dama de Ada capturou a torre de Ben em D5.');
    expect(chessPvpCaptureBanner(queenCapture, 'pt-BR')).toBe('Ada capturou uma torre!');
  });
});
