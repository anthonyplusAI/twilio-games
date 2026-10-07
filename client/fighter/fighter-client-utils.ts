import type { FighterConnectionState } from './fighter-net';

export type FighterResultActionState = 'station' | 'rematch' | 'viewer' | 'reconnecting' | 'unavailable';

/** Match the visible result action to the authority held by this browser socket. */
export function fighterResultActionState(
  stationManaged: boolean,
  isHost: boolean,
  connection: FighterConnectionState,
  phase: string | undefined,
): FighterResultActionState {
  if (stationManaged) return 'station';
  if (phase !== 'results') return 'unavailable';
  if (connection !== 'connected') return 'reconnecting';
  return isHost ? 'rematch' : 'viewer';
}

export interface NumericSelection {
  buffer: string;
  selection: number | null;
  waiting: boolean;
}

export function resolveNumericSelection(buffer: string, key: string, total: number): NumericSelection {
  if (!/^\d$/.test(key) || total < 1) return { buffer: '', selection: null, waiting: false };
  const candidate = `${buffer}${key}`.slice(-2);
  const value = Number(candidate);
  if (buffer && value >= 1 && value <= total) return { buffer: '', selection: value, waiting: false };
  if (value >= 1 && value <= total && value * 10 > total) return { buffer: '', selection: value, waiting: false };
  if (value * 10 <= total || candidate === '0') return { buffer: candidate, selection: null, waiting: true };
  const single = Number(key);
  return single >= 1 && single <= total
    ? { buffer: '', selection: single, waiting: false }
    : { buffer: '', selection: null, waiting: false };
}

export function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return !!element?.closest?.('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="button"]');
}
