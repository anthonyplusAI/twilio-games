import { describe, expect, it, vi } from 'vitest';
import { SelectedMapPrefetch } from '../client/selected-map-prefetch';

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
    expect(dispose).toHaveBeenCalledExactlyOnceWith(world);
  });
});
