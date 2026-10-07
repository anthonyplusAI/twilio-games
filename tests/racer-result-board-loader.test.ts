import { afterEach, describe, expect, it, vi } from 'vitest';
import { RacerResultBoardLoader, fetchRacerLeaderboardEntries } from '../client/racer-result-board-loader';
import type { GlobalEntry } from '../client/screens';

const oldRow: GlobalEntry = { name: 'Old winner', map: 'Silver Lake', carIndex: 0, finishT: 55, at: 1 };
const newRow: GlobalEntry = { name: 'New winner', map: 'Silver Lake', carIndex: 1, finishT: 42, at: 2 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => { vi.useRealTimers(); });

describe('Racer result leaderboard loader', () => {
  it('makes one request for repeated broadcasts of a race and keeps its successful board', async () => {
    const pending = deferred<GlobalEntry[]>();
    const requestedMaps: Array<string | null> = [];
    const painted: GlobalEntry[][] = [];
    const loader = new RacerResultBoardLoader(map => {
      requestedMaps.push(map);
      return pending.promise;
    });

    expect(loader.show('room-1/race-a', 'Silver Lake', board => painted.push(board.entries))).toBeUndefined();
    expect(loader.show('room-1/race-a', 'Silver Lake', board => painted.push(board.entries))).toBeUndefined();
    expect(requestedMaps).toEqual(['Silver Lake']);

    pending.resolve([newRow]);
    await pending.promise;
    await Promise.resolve();
    expect(painted).toEqual([[newRow]]);
    expect(loader.show('room-1/race-a', 'Silver Lake', board => painted.push(board.entries))).toEqual({
      map: 'Silver Lake', entries: [newRow],
    });
    expect(requestedMaps).toEqual(['Silver Lake']);
    expect(painted).toHaveLength(1);
  });

  it('refreshes the same map on a new round and ignores the older race response', async () => {
    const oldRequest = deferred<GlobalEntry[]>();
    const newRequest = deferred<GlobalEntry[]>();
    const requests: Array<string | null> = [];
    const painted: GlobalEntry[][] = [];
    const loader = new RacerResultBoardLoader(map => {
      requests.push(map);
      return requests.length === 1 ? oldRequest.promise : newRequest.promise;
    });

    loader.show('room-1/race-a', 'Silver Lake', board => painted.push(board.entries));
    loader.clear(); // the next round passed through lobby/racing
    expect(loader.show('room-1/race-a', 'Silver Lake', board => painted.push(board.entries))).toBeUndefined();
    expect(requests).toEqual(['Silver Lake', 'Silver Lake']);

    oldRequest.resolve([oldRow]);
    await oldRequest.promise;
    await Promise.resolve();
    expect(painted).toEqual([]);

    newRequest.resolve([newRow]);
    await newRequest.promise;
    await Promise.resolve();
    expect(painted).toEqual([[newRow]]);
  });

  it('retries a failed request slowly instead of retrying on each broadcast', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const painted: GlobalEntry[][] = [];
    const loader = new RacerResultBoardLoader(() => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error('network down')) : Promise.resolve([newRow]);
    }, 5_000);

    loader.show('room-1/race-a', 'Silver Lake', board => painted.push(board.entries));
    await Promise.resolve();
    loader.show('room-1/race-a', 'Silver Lake', board => painted.push(board.entries));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(attempts).toBe(1);
    expect(painted).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    expect(painted).toEqual([[newRow]]);
    loader.show('room-1/race-a', 'Silver Lake', board => painted.push(board.entries));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(2);
  });

  it('aborts a stalled leaderboard fetch so a later retry can recover', async () => {
    vi.useFakeTimers();
    let requests = 0;
    const painted: GlobalEntry[][] = [];
    const fetcher = (_url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
      requests++;
      if (requests > 1) return Promise.resolve(new Response(JSON.stringify({ entries: [newRow] }), { status: 200 }));
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
      });
    };
    const loader = new RacerResultBoardLoader(
      map => fetchRacerLeaderboardEntries(map, fetcher as typeof fetch, 8_000), 5_000,
    );
    loader.show('room-1/race-a', 'Silver Lake', board => painted.push(board.entries));

    await vi.advanceTimersByTimeAsync(7_999);
    expect(requests).toBe(1);
    expect(painted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests).toBe(2);
    expect(painted).toEqual([[newRow]]);
  });
});
