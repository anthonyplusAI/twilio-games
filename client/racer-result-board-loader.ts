import type { GlobalEntry } from './screens';

export interface RacerLeaderboardBoard {
  map: string | null;
  entries: GlobalEntry[];
}

/** Bound slow or stalled network requests so the loader's retry can recover. */
export async function fetchRacerLeaderboardEntries(
  map: string | null,
  fetcher: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<GlobalEntry[]> {
  const query = new URLSearchParams({ limit: '10' });
  if (map) query.set('map', map);
  const controller = new AbortController();
  let timeout!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Racer leaderboard request timed out'));
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetcher(`/api/leaderboard?${query}`, {
      cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Racer leaderboard request failed: ${response.status}`);
    const data = await response.json() as { entries?: GlobalEntry[] };
    if (!data || !Array.isArray(data.entries)) throw new Error('Racer leaderboard response has no entries');
    return data.entries;
  })();
  try { return await Promise.race([request, deadline]); }
  finally { clearTimeout(timeout); }
}

interface ActiveResult {
  key: string;
  map: string | null;
  board?: RacerLeaderboardBoard;
  onBoard: (board: RacerLeaderboardBoard) => void;
  pending: boolean;
  retry?: ReturnType<typeof setTimeout>;
}

/** One board fetch per race, even when the server keeps broadcasting the same results. */
export class RacerResultBoardLoader {
  private active: ActiveResult | null = null;

  constructor(
    private readonly loadEntries: (map: string | null) => Promise<GlobalEntry[]>,
    private readonly retryDelayMs = 5_000,
  ) {}

  show(key: string, map: string | null, onBoard: (board: RacerLeaderboardBoard) => void): RacerLeaderboardBoard | undefined {
    if (!this.active || this.active.key !== key || this.active.map !== map) {
      this.clear();
      this.active = { key, map, onBoard, pending: false };
      this.request(this.active);
    } else {
      this.active.onBoard = onBoard;
    }
    return this.active.board;
  }

  /** A lobby or race transition invalidates the prior board, even if the next race looks identical. */
  clear(): void {
    if (this.active?.retry) clearTimeout(this.active.retry);
    this.active = null;
  }

  private request(result: ActiveResult): void {
    if (this.active !== result || result.pending) return;
    result.pending = true;
    this.loadEntries(result.map).then(entries => {
      result.pending = false;
      if (this.active !== result) return;
      result.board = { map: result.map, entries };
      result.onBoard(result.board);
    }, () => {
      result.pending = false;
      if (this.active !== result) return;
      result.retry = setTimeout(() => {
        result.retry = undefined;
        this.request(result);
      }, this.retryDelayMs);
    });
  }
}
