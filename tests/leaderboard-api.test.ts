import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { HttpServer } from '../server/http-server';
import { unlink, writeFile, mkdir } from 'node:fs/promises';
import type { Server as NodeHttpServer } from 'node:http';

// Unique temp leaderboard path per test (concurrent files / leftover .tmp can't race).
let LB = 'data/_test-lb.json';
let KARAOKE_LB = 'data/_test-karaoke-lb.json';
let n = 0;
beforeEach(async () => {
  await mkdir('data', { recursive: true });
  const suffix = `${process.pid}-${n++}`;
  LB = `data/_test-lb-${suffix}.json`;
  KARAOKE_LB = `data/_test-karaoke-lb-${suffix}.json`;
});
let srv: HttpServer;
afterEach(async () => {
  await srv?.stop();
  for (const file of [LB, KARAOKE_LB]) try { await unlink(file); } catch {}
});

function makeServer() {
  return new HttpServer({
    port: 0,
    publicBaseUrl: 'http://localhost',
    validateSignatures: false,
    leaderboardPath: LB,
    karaokeLeaderboardPath: KARAOKE_LB,
  });
}

const seed = [
  { name: 'A', map: 'Silver Lake', carIndex: 0, finishT: 50, at: 1, enginePlayerId: 'ROOM:p1' },
  { name: 'B', map: 'Silver Lake', carIndex: 1, finishT: 40, at: 2 },
  { name: 'C', map: 'Neon City',  carIndex: 2, finishT: 30, at: 3 },
];

describe('leaderboard API', () => {
  it('GET returns global best times ascending', async () => {
    await writeFile(LB, JSON.stringify(seed));
    srv = makeServer(); const port = await srv.start();
    const data = await (await fetch(`http://127.0.0.1:${port}/api/leaderboard`)).json();
    expect(data.entries.map((e: any) => e.name)).toEqual(['C', 'B', 'A']);   // 30, 40, 50
    expect(JSON.stringify(data)).not.toContain('enginePlayerId');
  });

  it('GET ?map= filters to one track', async () => {
    await writeFile(LB, JSON.stringify(seed));
    srv = makeServer(); const port = await srv.start();
    const data = await (await fetch(`http://127.0.0.1:${port}/api/leaderboard?map=Silver%20Lake`)).json();
    expect(data.entries.map((e: any) => e.name)).toEqual(['B', 'A']);
  });

  it('GET ?limit= caps the rows', async () => {
    await writeFile(LB, JSON.stringify(seed));
    srv = makeServer(); const port = await srv.start();
    const data = await (await fetch(`http://127.0.0.1:${port}/api/leaderboard?limit=1`)).json();
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].name).toBe('C');
  });

  it('GET with no file yet returns an empty board (not an error)', async () => {
    srv = makeServer(); const port = await srv.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/leaderboard`);
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toEqual([]);
  });

  it('waits for an in-progress race write before returning an uncached board', async () => {
    await writeFile(LB, JSON.stringify(seed));
    srv = makeServer(); const port = await srv.start();
    let finishWrite!: () => void;
    const heldWrite = new Promise<void>(resolve => { finishWrite = resolve; });
    (srv as unknown as { leaderboardWrite: Promise<void> }).leaderboardWrite = heldWrite.then(() =>
      writeFile(LB, JSON.stringify([
        ...seed,
        { name: 'New winner', map: 'Silver Lake', carIndex: 3, finishT: 20, at: 4 },
      ])));

    let requestArrived!: () => void;
    const arrival = new Promise<void>(resolve => { requestArrived = resolve; });
    (srv as unknown as { server: NodeHttpServer }).server.prependOnceListener('request', requestArrived);
    const responsePromise = fetch(`http://127.0.0.1:${port}/api/leaderboard?map=Silver%20Lake`);
    await arrival;
    const responseBeforeWrite = await Promise.race([
      responsePromise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 40)),
    ]);
    finishWrite();
    expect(responseBeforeWrite).toBe(false);
    const response = await responsePromise;
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = await response.json() as { entries: Array<{ name: string }> };
    expect(payload.entries.map(entry => entry.name)).toEqual(['New winner', 'B', 'A']);
  });

  it('returns Karaoke scores descending per song without private engine identities', async () => {
    await writeFile(KARAOKE_LB, JSON.stringify([
      { name: 'Ada', songId: 'song-a', score: 80_000, bestCombo: 40, at: 2, enginePlayerId: 'ROOM:p1' },
      { name: 'Bo', songId: 'song-a', score: 90_000, bestCombo: 30, at: 1 },
      { name: 'Cy', songId: 'song-b', score: 100_000, bestCombo: 50, at: 3 },
    ]));
    srv = makeServer();
    const port = await srv.start();
    const response = await fetch(`http://127.0.0.1:${port}/api/karaoke/leaderboard?song=song-a&limit=10`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = await response.json() as { entries: Array<{ name: string }> };
    expect(payload.entries.map(entry => entry.name)).toEqual(['Bo', 'Ada']);
    expect(JSON.stringify(payload)).not.toContain('enginePlayerId');
    expect((await fetch(`http://127.0.0.1:${port}/api/karaoke/leaderboard`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/api/karaoke/leaderboard?song=song-a&limit=10x`)).status).toBe(400);
  });
});
