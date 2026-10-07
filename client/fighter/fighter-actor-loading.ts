import type { FighterState } from '../../shared/fighter-protocol';

const ACTOR_PHASES = new Set<FighterState['phase']>(['loading', 'intro', 'countdown', 'fight']);

export interface FighterActorLoadContext {
  key: string;
  p1Id: string;
  p2Id: string;
}

export function fighterActorLoadContext(state: FighterState | null): FighterActorLoadContext | null {
  if (!state || !ACTOR_PHASES.has(state.phase)) return null;
  const p1Id = state.players.find(player => player.side === 'p1')?.fighterId;
  const p2Id = state.players.find(player => player.side === 'p2')?.fighterId;
  if (!p1Id || !p2Id) return null;
  return { key: `${state.loadingGeneration}:${p1Id}:${p2Id}`, p1Id, p2Id };
}

/** Warm only the chosen pair during setup. The roster includes models larger
 *  than 100 MB, so fetching every character at the QR/name screen would crowd out
 *  the call and the eventual chosen arena on slower connections. */
export function fighterWarmupCandidates(state:FighterState|null):string[]{
  if(!state||(state.phase!=='fighter_select'&&state.phase!=='map_select'))return [];
  return [...new Set([...state.players.filter(player=>!player.isAi&&player.fighterId)
    .map(player=>player.fighterId!), ...(state.aiFighterId ? [state.aiFighterId] : [])])].slice(0,2);
}

export function fighterShouldRetainActor(state:FighterState|null,id:string):boolean{
  if(fighterWarmupCandidates(state).includes(id))return true;
  const match=fighterActorLoadContext(state);
  return match?.p1Id===id||match?.p2Id===id;
}

/** A failed setup fetch gets one later chance while its fighter is still selected. */
export class FighterWarmupRetryBudget {
  private failures = new Map<string, { count: number; retryAt: number }>();

  constructor(private readonly retryDelayMs = 3_500, private readonly maxFailures = 2) {}

  canStart(id: string, now: number): boolean {
    const failure = this.failures.get(id);
    return !failure || failure.count < this.maxFailures && now >= failure.retryAt;
  }

  failed(id: string, now: number): number | null {
    const count = (this.failures.get(id)?.count ?? 0) + 1;
    this.failures.set(id, { count, retryAt: now + this.retryDelayMs });
    return count < this.maxFailures ? this.retryDelayMs : null;
  }

  succeeded(id: string): void { this.failures.delete(id); }

  retainOnly(ids: ReadonlySet<string>): void {
    for (const id of this.failures.keys()) if (!ids.has(id)) this.failures.delete(id);
  }

  clear(): void { this.failures.clear(); }
}

export class FighterActorLoadCoordinator {
  private key = '';
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly fallbackAfterMs: number) {}

  start(
    key: string,
    load: () => Promise<void>,
    isCurrent: () => boolean,
    onReady: () => void,
    onFallback: (error?: unknown) => void,
  ): void {
    if (key === this.key) return;
    this.clear();
    this.key = key;
    const revision = this.revision;
    const useFallback = (error?: unknown) => {
      if (revision !== this.revision || key !== this.key || !isCurrent()) return;
      this.clear();
      onFallback(error);
    };
    this.timer = setTimeout(() => useFallback(), this.fallbackAfterMs);
    void Promise.resolve().then(load).then(() => {
      if (revision !== this.revision || key !== this.key || !isCurrent()) return;
      this.clear();
      onReady();
    }, useFallback);
  }

  clear(): void {
    this.revision += 1;
    this.key = '';
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
