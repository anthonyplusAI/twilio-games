import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDisplaySession } from '../client/display-session';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('standalone display session identity', () => {
  it('keeps one browser-tab identity across game page URLs and reconnects', () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    });
    vi.stubGlobal('crypto', {
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
    });

    const racer = new URL(withDisplaySession('wss://example.test/game?display=1&source=screen'));
    const fighter = new URL(withDisplaySession('wss://example.test/fighter?display=1'));
    expect(racer.searchParams.get('displaySessionId')).toBe('11111111-1111-4111-8111-111111111111');
    expect(fighter.searchParams.get('displaySessionId')).toBe(racer.searchParams.get('displaySessionId'));
    expect(racer.searchParams.get('source')).toBe('screen');
    expect(withDisplaySession('wss://example.test/game?source=phone'))
      .toBe('wss://example.test/game?source=phone');
  });

  it('uses secure random bytes when randomUUID is unavailable', () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    });
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => { bytes.fill(0xab); return bytes; },
    });
    const first = new URL(withDisplaySession('ws://localhost:8081/chess?display=1'));
    const second = new URL(withDisplaySession('ws://localhost:8081/trivia?display=1'));
    expect(first.searchParams.get('displaySessionId')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second.searchParams.get('displaySessionId')).toBe(first.searchParams.get('displaySessionId'));
  });

  it('lets the home page build an iframe link without claiming the active display', async () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    });
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
    const active = new Map<string, string>();
    const getItem = vi.fn((key: string) => active.get(key) ?? null);
    const setItem = vi.fn((key: string, value: string) => { active.set(key, value); });
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem: (key: string) => active.delete(key) });
    const addEventListener = vi.fn();
    vi.stubGlobal('window', { addEventListener });
    vi.resetModules();
    const { ensureDisplaySessionId } = await import('../client/display-session');
    expect(ensureDisplaySessionId()).toBe('11111111-1111-4111-8111-111111111111');
    expect(setItem.mock.calls.some(([key, value]) =>
      key.startsWith('twilio-games:display-storage-probe:') && value === '1')).toBe(true);
    expect([...active.keys()]).toEqual([]);
    expect(setItem.mock.calls.every(([key]) =>
      key.startsWith('twilio-games:display-storage-probe:'))).toBe(true);
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it.each(['read', 'write'] as const)('omits a shared tab hint when localStorage %s access is denied', async denied => {
    const entries = new Map<string, string>([
      ['twilio-games:display-session:v1', '11111111-1111-4111-8111-111111111111'],
    ]);
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    });
    vi.stubGlobal('crypto', { randomUUID: () => '22222222-2222-4222-8222-222222222222' });
    vi.stubGlobal('localStorage', {
      getItem: () => { if (denied === 'read') throw new Error('storage denied'); return null; },
      setItem: () => { if (denied === 'write') throw new Error('storage denied'); },
      removeItem: vi.fn(),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.resetModules();
    const { ensureDisplaySessionId, withDisplaySession: withHint } = await import('../client/display-session');
    expect(ensureDisplaySessionId()).toBeNull();
    expect(withHint('ws://example.test/fighter?display=1')).toBe('ws://example.test/fighter?display=1');
    expect(withHint('ws://example.test/fighter?display=1&displaySessionId=11111111-1111-4111-8111-111111111111&source=screen'))
      .toBe('ws://example.test/fighter?display=1&source=screen');
  });

  it('omits a shared tab hint when sessionStorage cannot persist it', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('storage denied'); },
      setItem: vi.fn(),
    });
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    vi.resetModules();
    const { ensureDisplaySessionId, withDisplaySession: withHint } = await import('../client/display-session');
    expect(ensureDisplaySessionId()).toBeNull();
    expect(withHint('ws://example.test/fighter?display=1')).toBe('ws://example.test/fighter?display=1');
    expect(withHint('ws://example.test/fighter?display=1&displaySessionId=11111111-1111-4111-8111-111111111111'))
      .toBe('ws://example.test/fighter?display=1');
  });

  it('rotates an ID cloned with window.name but reuses same-tab navigation after pagehide', async () => {
    let sequence = 0;
    vi.stubGlobal('crypto', {
      randomUUID: () => `${(++sequence).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    });
    const active = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => active.get(key) ?? null,
      setItem: (key: string, value: string) => { active.set(key, value); },
      removeItem: (key: string) => { active.delete(key); },
    });
    const originalStorage = new Map<string, string>();
    const useStorage = (entries: Map<string, string>) => vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    });
    const originalWindow = { name: 'copied-name', addEventListener: vi.fn() };
    vi.stubGlobal('window', originalWindow);
    useStorage(originalStorage);
    vi.resetModules();
    const first = await import('../client/display-session');
    const firstId = new URL(first.withDisplaySession('ws://example.test/game?display=1'))
      .searchParams.get('displaySessionId');
    expect(firstId).toBeTruthy();

    // Navigating in the same tab releases the old document's active claim.
    const pagehide = originalWindow.addEventListener.mock.calls.find(([type]) => type === 'pagehide')?.[1];
    expect(pagehide).toBeTypeOf('function');
    pagehide();
    vi.stubGlobal('window', { name: originalWindow.name, addEventListener: vi.fn() });
    vi.resetModules();
    const nextPage = await import('../client/display-session');
    const sameTabId = new URL(nextPage.withDisplaySession('ws://example.test/battle?display=1'))
      .searchParams.get('displaySessionId');
    expect(sameTabId).toBe(firstId);

    // A duplicated tab can copy *both* sessionStorage and window.name; the live claim still
    // causes a fresh ID before it opens its WebSocket.
    const clonedStorage = new Map(originalStorage);
    vi.stubGlobal('window', { name: originalWindow.name, addEventListener: vi.fn() });
    useStorage(clonedStorage);
    vi.resetModules();
    const newTab = await import('../client/display-session');
    const clonedTabId = new URL(newTab.withDisplaySession('ws://example.test/trivia?display=1'))
      .searchParams.get('displaySessionId');
    expect(clonedTabId).toBeTruthy();
    expect(clonedTabId).not.toBe(firstId);
  });
});
