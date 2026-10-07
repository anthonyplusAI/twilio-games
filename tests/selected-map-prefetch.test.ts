import { describe, expect, it, vi } from 'vitest';
import { SelectedMapPrefetch, SELECTED_MAP_PREFETCH_TIMEOUT_MS } from '../client/selected-map-prefetch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('SelectedMapPrefetch', () => {
  it('loads the voted authored map before race start and transfers its scene without a second load', async () => {
    const world = { name: 'Silver Lake' };
    const load = vi.fn(async () => world);
    const dispose = vi.fn();
    const prefetch = new SelectedMapPrefetch(load, dispose);

    prefetch.start('Silver Lake');
    await vi.waitFor(() => expect(prefetch.peekReady('Silver Lake')).toBe(world));
    expect(prefetch.peekReady('Other Track')).toBeNull();
    const selected = await prefetch.take('Silver Lake');

    expect(selected).toBe(world);
    expect(prefetch.peekReady('Silver Lake')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    prefetch.clear();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('aborts and disposes an obsolete map when the winning vote changes', async () => {
    const first = deferred<{ name: string } | null>();
    const stale = { name: 'Old Track' };
    const next = { name: 'New Track' };
    const signals: AbortSignal[] = [];
    const dispose = vi.fn();
    const prefetch = new SelectedMapPrefetch(async (name, signal) => {
      signals.push(signal);
      return name === 'Old Track' ? first.promise : next;
    }, dispose);

    prefetch.start('Old Track');
    await Promise.resolve();
    prefetch.start('New Track');
    first.resolve(stale);
    expect(await prefetch.take('New Track')).toBe(next);
    await Promise.resolve();

    expect(signals[0]?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(stale);
  });

  it('disposes a ready map if players leave selection without starting a race', async () => {
    const world = { name: 'Silver Lake' };
    const dispose = vi.fn();
    const prefetch = new SelectedMapPrefetch(async () => world, dispose);
    prefetch.start('Silver Lake');
    await vi.waitFor(() => expect(prefetch.isLoading).toBe(false));
    prefetch.clear();

    expect(dispose).toHaveBeenCalledExactlyOnceWith(world);
    expect(await prefetch.take('Silver Lake')).toBeNull();
  });

  it('abandons a pending map when the race loading deadline expires', async () => {
    const pending = deferred<{ name: string } | null>();
    const world = { name: 'Late Track' };
    const dispose = vi.fn();
    const prefetch = new SelectedMapPrefetch((_name, signal) => {
      expect(signal.aborted).toBe(false);
      return pending.promise;
    }, dispose);
    prefetch.start('Late Track');
    await Promise.resolve();
    const deadline = new AbortController();
    const selection = prefetch.take('Late Track', deadline.signal);
    deadline.abort();
    pending.resolve(world);

    expect(await selection).toBeNull();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledExactlyOnceWith(world));
  });

  it('retries a failed selected map after a short cooldown without hammering each menu update', async () => {
    vi.useFakeTimers();
    try {
      const world = { name: 'Silver Lake' };
      const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(world);
      const prefetch = new SelectedMapPrefetch(load, vi.fn());

      prefetch.start('Silver Lake');
      await vi.waitFor(() => expect(prefetch.isLoading).toBe(false));
      prefetch.start('Silver Lake');
      expect(load).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      prefetch.start('Silver Lake');
      expect(await prefetch.take('Silver Lake')).toBe(world);
      expect(load).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('keeps a slow voted map download alive and reuses its scene at race start', async () => {
    vi.useFakeTimers();
    try {
      const world = { name: 'Silver Lake' };
      const load = vi.fn((_name: string, signal: AbortSignal) => new Promise<typeof world | null>(resolve => {
        const timer = setTimeout(() => resolve(world), 9_500);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve(null);
        }, { once: true });
      }));
      const dispose = vi.fn();
      const prefetch = new SelectedMapPrefetch(load, dispose);

      prefetch.start('Silver Lake');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(9_500);

      expect(prefetch.peekReady('Silver Lake')).toBe(world);
      prefetch.start('Silver Lake'); // another menu update must keep the decoded scene
      expect(await prefetch.take('Silver Lake')).toBe(world);
      expect(load).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('settles a half-open vote prefetch, disposes a late scene, and retries after cooldown', async () => {
    vi.useFakeTimers();
    try {
      const halfOpen = deferred<{ name: string } | null>();
      const stale = { name: 'stale scene' };
      const ready = { name: 'ready scene' };
      const signals: AbortSignal[] = [];
      const load = vi.fn((_name: string, signal: AbortSignal) => {
        signals.push(signal);
        return signals.length === 1 ? halfOpen.promise : Promise.resolve(ready);
      });
      const dispose = vi.fn();
      const prefetch = new SelectedMapPrefetch(load, dispose);

      prefetch.start('Silver Lake');
      await Promise.resolve();
      const selection = prefetch.take('Silver Lake');
      await vi.advanceTimersByTimeAsync(SELECTED_MAP_PREFETCH_TIMEOUT_MS);

      expect(signals[0]?.aborted).toBe(true);
      expect(prefetch.isLoading).toBe(false);
      await expect(selection).resolves.toBeNull();
      prefetch.start('Silver Lake');
      expect(load).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      prefetch.start('Silver Lake');
      await expect(prefetch.take('Silver Lake')).resolves.toBe(ready);
      expect(load).toHaveBeenCalledTimes(2);

      halfOpen.resolve(stale);
      await Promise.resolve();
      await Promise.resolve();
      expect(dispose).toHaveBeenCalledExactlyOnceWith(stale);
    } finally { vi.useRealTimers(); }
  });
});
