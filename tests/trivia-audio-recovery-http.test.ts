import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpServer } from '../server/http-server';
import type { ArcadeApi } from '../server/arcade-api';
import type { TriviaServer } from '../server/trivia-server';
import type { TriviaRoom } from '../server/trivia-room';

let server: HttpServer | null = null;
afterEach(async () => { await server?.stop(); server = null; vi.restoreAllMocks(); });

describe('operator Trivia audio recovery', () => {
  it('authenticates, checks the active match and attempt, then retries only the paused question', async () => {
    server = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      operatorAuthRequired: false });
    const port = await server.start();
    let phase = 'audio_problem';
    let attempt = 4;
    const room = { state: () => ({ phase, questionAttemptId: attempt,
      audioProblem: phase === 'audio_problem'
        ? { questionId: 'q1', questionAttemptId: attempt, recoveryDeadlineAtMs: 10_000 }
        : null }) } as unknown as TriviaRoom;
    const internals = server as unknown as { arcadeApi: ArcadeApi; trivia: TriviaServer };
    internals.arcadeApi = {
      authorizeOperatorRequest: (request: { headers: { authorization?: string } }) =>
        request.headers.authorization === 'Bearer staff' ? { email: 'operator@example.com' } : null,
      activeStationEngineRoom: (_game: string, matchId: string) => matchId === 'current-match' ? 'ROOM' : null,
      stop: async () => undefined,
    } as unknown as ArcadeApi;
    internals.trivia.findRoom = code => code === 'ROOM' ? room : undefined;
    internals.trivia.retryQuestion = (_code, questionId, attemptId) => {
      if (phase !== 'audio_problem' || questionId !== 'q1' || attemptId !== attempt) return false;
      phase = 'question_prompt'; attempt += 1; return true;
    };
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const url = `http://127.0.0.1:${port}/api/admin/arcade/trivia/audio-recovery`;
    const get = (matchId: string, authorized = true) => fetch(`${url}?matchId=${matchId}`, {
      headers: authorized ? { Authorization: 'Bearer staff' } : {},
    });
    expect((await get('current-match', false)).status).toBe(401);
    expect(await (await get('old-match')).json()).toEqual({ available: false });
    expect(await (await get('current-match')).json()).toEqual({ available: true,
      matchId: 'current-match', questionId: 'q1', questionAttemptId: 4, recoveryDeadlineAtMs: 10_000 });

    const post = (questionAttemptId: number, origin?: string) => fetch(url, {
      method: 'POST', headers: { Authorization: 'Bearer staff', 'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ matchId: 'current-match', questionId: 'q1', questionAttemptId }),
    });
    expect((await post(4)).status).toBe(403);
    expect((await post(3, 'http://localhost')).status).toBe(409);
    const retried = await post(4, 'http://localhost');
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ retried: true, matchId: 'current-match', nextAttemptId: 5 });
    expect((await post(4, 'http://localhost')).status).toBe(409);
    expect(await (await get('current-match')).json()).toEqual({ available: false });
  });
});
