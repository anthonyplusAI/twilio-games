import { afterEach, describe, expect, it } from 'vitest';
import type { ArcadeApi } from '../server/arcade-api';
import type { StationMatchParticipantsChangedHandler } from '../server/arcade-station-runtime';
import { ChessServer } from '../server/chess-server';
import { HttpServer } from '../server/http-server';

let server: HttpServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

describe('station Chess participant reconciliation', () => {
  it('retires a no-show before turning the remaining waiting caller into a solo player', () => {
    let participantsChanged: StationMatchParticipantsChangedHandler | undefined;
    const arcadeApi = {
      setStationParticipantCountHandler(handler: StationMatchParticipantsChangedHandler) {
        participantsChanged = handler;
      },
      stationEnginePhase: () => 'WAITING',
      stationEngineStarted: () => {},
      isStationEngineRoom: () => true,
      stop: async () => {},
    } as unknown as ArcadeApi;
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost',
      validateSignatures: false, arcadeApi });
    const internals = server as unknown as {
      chess: ChessServer;
      chessVoiceCallBindings: Map<string, {
        code: string; playerId: string; locale: 'en-US'; stationManaged: boolean;
        activeSession: null; leaveTimer: null;
      }>;
    };
    const { chess, chessVoiceCallBindings } = internals;
    const roomCode = 'CHESS-NO-SHOW';
    expect(chess.configureMatch(roomCode, 2)).toBe(true);
    expect(chess.voiceJoin(roomCode, 'Ada', 'CA-white', 'en-US', true, 0, false))
      .toMatchObject({ playerId: 'c1' });
    expect(chess.voiceJoin(roomCode, 'Ben', 'CA-black', 'en-US', true, 1, true))
      .toMatchObject({ playerId: 'c2' });
    for (const [callSid, playerId] of [['CA-white', 'c1'], ['CA-black', 'c2']] as const) {
      chessVoiceCallBindings.set(callSid, { code: roomCode, playerId,
        locale: 'en-US', stationManaged: true, activeSession: null, leaveTimer: null });
    }
    expect(chess.findRoom(roomCode)?.state()).toMatchObject({ mode: 'pvp', phase: 'waiting' });

    participantsChanged?.('chess', roomCode, 1, ['c2'], [null, 'c2']);

    expect(chessVoiceCallBindings.has('CA-white')).toBe(false);
    expect(chessVoiceCallBindings.has('CA-black')).toBe(true);
    expect(chess.findRoom(roomCode)?.state()).toMatchObject({ mode: 'solo', phase: 'playing',
      players: [expect.objectContaining({ playerId: 'c2', name: 'Ben' })] });
    expect(chess.findRoom(roomCode)?.state().players?.[0]?.color)
      .toBe(chess.findRoom(roomCode)?.state().humanColor);
    expect(chess.voiceLegalMoves(roomCode, 'CA-black', 'en-US').length).toBeGreaterThan(0);
  });
});
