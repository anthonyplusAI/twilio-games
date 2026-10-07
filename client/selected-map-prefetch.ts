/** Keep one selected Racer map ready while players vote, before the race's loading deadline begins.
 * Ownership of the decoded scene passes to `take`; every superseded or abandoned scene is disposed. */
interface PrefetchRecord<T> {
  name: string;
  controller: AbortController;
  promise: Promise<T | null>;
  world: T | null;
  loading: boolean;
}

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
    if (this.current?.name === name) return;
    this.clear();
    const record: PrefetchRecord<T> = {
      name, controller: new AbortController(), promise: Promise.resolve(null),
      world: null, loading: true,
    };
    this.current = record;
    record.promise = Promise.resolve().then(() => this.load(name, record.controller.signal))
      .catch(() => null)
      .then(world => {
        record.loading = false;
        if (record.controller.signal.aborted || this.current !== record) {
          if (world) this.dispose(world);
          return null;
        }
        record.world = world;
        return world;
      });
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
    if (record.world) {
      this.dispose(record.world);
      record.world = null;
    }
  }
}
