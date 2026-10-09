/** Identifies one browser tab while its standalone game pages change. This is a routing hint,
 * never an authorization token; station display authentication remains separate. */
const DISPLAY_SESSION_KEY = 'twilio-games:display-session:v1';
const DISPLAY_ACTIVE_PREFIX = 'twilio-games:display-active:';
const DISPLAY_STORAGE_PROBE_KEY = 'twilio-games:display-storage-probe';
const TOP_CLAIM_KEY = '__twilioGamesDisplayClaim';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_CLAIM_TTL_MS = 60 * 60 * 1_000;
const ACTIVE_CLAIM_REFRESH_MS = 60 * 1_000;
let documentId: string | null = null;
let claimedSessionId: string | null = null;
let pagehideRegistered = false;
let claimRefreshTimer: ReturnType<typeof setInterval> | null = null;
let activeClaimAvailable: boolean | null = null;

type TopClaimHost = Window & { [TOP_CLAIM_KEY]?: { sessionId: string; owner: string } };

function topClaimHost(): TopClaimHost | null {
  if (typeof window === 'undefined') return null;
  let host = window as TopClaimHost;
  // A same-origin Home page may itself be framed by another site. Its game iframe and Home
  // still need the same claim host, so climb only as far as parent access permits.
  while (true) {
    try {
      const parent = host.parent as TopClaimHost | undefined;
      if (!parent || parent === host) return host;
      void parent[TOP_CLAIM_KEY];
      host = parent;
    } catch { return host; }
  }
}

function sameTopClaim(sessionId: string, owner: string): boolean {
  try {
    const claim = topClaimHost()?.[TOP_CLAIM_KEY];
    return claim?.sessionId === sessionId && claim.owner === owner;
  } catch { return false; }
}

function readClaim(key: string): { owner?: unknown; at?: unknown } | null {
  const value = localStorage.getItem(key);
  return value ? JSON.parse(value) as { owner?: unknown; at?: unknown } : null;
}

function canUseActiveClaims(): boolean {
  if (typeof window === 'undefined') return true;
  if (activeClaimAvailable !== null) return activeClaimAvailable;
  try {
    // A per-document key avoids two tabs racing each other's capability probe.
    const probeId = createSessionId();
    if (!probeId) return activeClaimAvailable = false;
    const key = `${DISPLAY_STORAGE_PROBE_KEY}:${probeId}`;
    localStorage.setItem(key, '1');
    const verified = localStorage.getItem(key) === '1';
    localStorage.removeItem(key);
    activeClaimAvailable = verified;
  } catch {
    activeClaimAvailable = false;
  }
  return activeClaimAvailable;
}

function createSessionId(): string | null {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

/** Return the stored tab identity without claiming it. A page that actually launches a
 * game must use navigationDisplaySessionId so copied Home tabs reserve different IDs. */
export function ensureDisplaySessionId(): string | null {
  if (!canUseActiveClaims()) return null;
  try {
    const stored = sessionStorage.getItem(DISPLAY_SESSION_KEY);
    if (stored && UUID.test(stored)) return stored;
    const id = createSessionId();
    if (!id) return null;
    sessionStorage.setItem(DISPLAY_SESSION_KEY, id);
    return id;
  } catch {
    return null;
  }
}

/** Reserve the page-navigation hint at launch time. A duplicated Home tab inherits
 * sessionStorage, but not the other tab's top-level window. Claiming here rotates its
 * copied ID before the HTTP request, and the game iframe can take over the same claim. */
export function navigationDisplaySessionId(): string | null {
  return displaySessionId();
}

function displaySessionId(): string | null {
  const id = ensureDisplaySessionId();
  return id ? claimDisplaySession(id) : null;
}

function releaseDisplayClaim(): void {
  if (claimRefreshTimer) clearInterval(claimRefreshTimer);
  claimRefreshTimer = null;
  if (!claimedSessionId || !documentId) return;
  try {
    const top = topClaimHost();
    if (top?.[TOP_CLAIM_KEY]?.sessionId === claimedSessionId
      && top[TOP_CLAIM_KEY]?.owner === documentId) delete top[TOP_CLAIM_KEY];
  } catch { /* The claim still expires in storage. */ }
  try {
    const key = `${DISPLAY_ACTIVE_PREFIX}${claimedSessionId}`;
    const claim = readClaim(key);
    if (claim?.owner === documentId) localStorage.removeItem(key);
  } catch { /* A denied storage API must never block the game. */ }
}

function refreshDisplayClaim(): void {
  if (!claimedSessionId || !documentId) return;
  try {
    const key = `${DISPLAY_ACTIVE_PREFIX}${claimedSessionId}`;
    const claim = readClaim(key);
    if (claim?.owner === documentId) {
      localStorage.setItem(key, JSON.stringify({ owner: documentId, at: Date.now() }));
    }
  } catch { /* The game still works when browser storage is unavailable. */ }
}

function claimDisplaySession(initialId: string): string | null {
  if (typeof window === 'undefined') return initialId;
  if (!canUseActiveClaims()) return null;
  documentId ??= createSessionId();
  if (!documentId) return null;
  let id = initialId;
  // An opener or Duplicate Tab can copy sessionStorage and window.name. Another *live*
  // document's claim means this is a separate active tab, so rotate before opening its socket.
  // Ordinary navigation releases its old claim in pagehide; crash leftovers expire.
  try {
    const key = `${DISPLAY_ACTIVE_PREFIX}${id}`;
    const prior = readClaim(key);
    if (prior && (typeof prior.owner !== 'string' || typeof prior.at !== 'number')) return null;
    const otherActive = prior && prior.owner !== documentId
      && typeof prior.at === 'number' && Date.now() - prior.at < ACTIVE_CLAIM_TTL_MS
      && !sameTopClaim(id, prior.owner as string);
    if (otherActive) {
      const replacement = createSessionId();
      if (replacement) {
        id = replacement;
        sessionStorage.setItem(DISPLAY_SESSION_KEY, id);
      } else {
        return null;
      }
    }
    if (claimedSessionId && claimedSessionId !== id) releaseDisplayClaim();
    localStorage.setItem(`${DISPLAY_ACTIVE_PREFIX}${id}`,
      JSON.stringify({ owner: documentId, at: Date.now() }));
    if (readClaim(`${DISPLAY_ACTIVE_PREFIX}${id}`)?.owner !== documentId) return null;
    claimedSessionId = id;
    try {
      const top = topClaimHost();
      if (top) top[TOP_CLAIM_KEY] = { sessionId: id, owner: documentId };
    } catch { /* A blocked top window must not prevent the game from opening. */ }
  } catch {
    activeClaimAvailable = false;
    return null;
  }
  if (!pagehideRegistered) {
    window.addEventListener('pagehide', releaseDisplayClaim);
    pagehideRegistered = true;
  }
  if (claimedSessionId && !claimRefreshTimer) {
    claimRefreshTimer = setInterval(refreshDisplayClaim, ACTIVE_CLAIM_REFRESH_MS);
    (claimRefreshTimer as { unref?: () => void }).unref?.();
  }
  return id;
}

/** Preserve the supplied WebSocket URL, including test/venue overrides, and identify only
 * connections explicitly opened as standalone displays. */
export function withDisplaySession(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return url; }
  if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
    || parsed.searchParams.get('display') !== '1') return url;
  const id = displaySessionId();
  if (!id) {
    // A page URL may carry Home's earlier ID even though this document cannot claim it.
    // Never let an unclaimed ID make two tabs look like a trusted same-tab handoff.
    parsed.searchParams.delete('displaySessionId');
    return parsed.toString();
  }
  parsed.searchParams.set('displaySessionId', id);
  return parsed.toString();
}
