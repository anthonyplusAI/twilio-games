/** Keep one selected Racer map ready while players vote, before the race's loading deadline begins.
 * Ownership of the decoded scene passes to `take`; every superseded or abandoned scene is disposed. */
interface PrefetchRecord<T> {
  name: string;
  controller: AbortController;
  promise: Promise<T | null>;
  settle: (world: T | null) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  world: T | null;
  loading: boolean;
  failedAt: number | null;
}

// Allow slower map downloads during voting without waiting forever on a stalled request.
// Race loading has its own deadline through the AbortSignal passed to take().
export const SELECTED_MAP_PREFETCH_TIMEOUT_MS = 25_000;
// A failed early attempt should get another chance while players are still choosing a track,
// without retrying on every frequent select_state broadcast when a venue link is offline.
const FAILED_PREFETCH_RETRY_MS = 3_000;

export class SelectedMapPrefetch<T> {
  private current: PrefetchRecord<T> | null = null;

  constructor(
    private readonly load: (name: string, signal: AbortSignal) => Promise<T | null>,
    private readonly dispose: (world: T) => void,
  ) {}

  get isLoading(): boolean { return this.current?.loading === true; }

  /** Read metadata from a fully decoded selection without transferring scene ownership. */
  peekReady(name: string): T | null {
    const record = this.current;
    return record?.name === name && !record.loading ? record.world : null;
  }

  start(name: string | null): void {
    if (!name) { this.clear(); return; }
    if (this.current?.name === name && (this.current.loading || this.current.world
      || this.current.failedAt === null || Date.now() - this.current.failedAt < FAILED_PREFETCH_RETRY_MS)) return;
    this.clear();
    let settle!: (world: T | null) => void;
    const promise = new Promise<T | null>(resolve => { settle = resolve; });
    const record: PrefetchRecord<T> = {
      name, controller: new AbortController(), promise, settle, timeout: null,
      world: null, loading: true, failedAt: null,
    };
    this.current = record;
    record.timeout = setTimeout(() => {
      record.controller.abort();
      this.complete(record, null);
    }, SELECTED_MAP_PREFETCH_TIMEOUT_MS);
    // The load may ignore AbortSignal (for example, a half-open fetch). The record's own promise
    // still settles at the deadline; any scene produced after cancellation is disposed below.
    void Promise.resolve().then(() => this.load(name, record.controller.signal)).then(
      world => this.complete(record, world),
      () => this.complete(record, null),
    );
  }

  private complete(record: PrefetchRecord<T>, world: T | null): void {
    if (!record.loading) {
      if (world) this.dispose(world);
      return;
    }
    record.loading = false;
    if (record.timeout !== null) clearTimeout(record.timeout);
    record.timeout = null;
    if (this.current === record && !record.controller.signal.aborted) {
      record.world = world;
      if (!world) record.failedAt = Date.now();
      record.settle(world);
      return;
    }
    if (this.current === record) record.failedAt = Date.now();
    if (world) this.dispose(world);
    record.settle(null);
  }

  async take(name: string, signal?: AbortSignal): Promise<T | null> {
    const record = this.current;
    if (!record || record.name !== name) return null;
    if (signal?.aborted) { this.clear(); return null; }
    const abort = () => { if (this.current === record) this.clear(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const world = await record.promise;
      if (!world || signal?.aborted || this.current !== record) return null;
      this.current = null;
      record.world = null; // caller now owns the scene
      return world;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  clear(): void {
    const record = this.current;
    if (!record) return;
    this.current = null;
    record.controller.abort();
    if (record.loading) this.complete(record, null);
    if (record.world) {
      this.dispose(record.world);
      record.world = null;
    }
  }
}
