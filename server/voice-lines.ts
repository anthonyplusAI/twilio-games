// Pure, testable text lines the game SPEAKS TO A CALLER over their Conversation Relay call (Relay
// TTS-synthesizes each returned string). The AI host talks throughout — greeting, the menu phases
// (pick your car / track), reactions to the caller's own picks, the 3-2-1-GO countdown, mid-race
// arcade quips (throttled), and their finish. No I/O here; the adapter decides WHEN to send these.
import type { GameEvent } from '../shared/types';
import { countdownCue } from '../shared/countdown';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import { RACER_MESSAGES, type RacerMessageKey } from '../shared/i18n/racer';
import { createTranslator } from '../shared/i18n/translate';
import { carName, trackName } from '../shared/i18n/content';

type Text = ReturnType<typeof createTranslator<RacerMessageKey>>;

/** The connect greeting, as SEPARATE sentences. Sending each as its own TTS utterance gives natural
 *  pauses between them — one long run-on string was read without breaths (the "no pause" issue). */
export function greetingLines(locale: SupportedLocale = DEFAULT_LOCALE): string[] {
  const text = createTranslator(locale, RACER_MESSAGES);
  return [
    text('voice.greeting.0'),
    text('voice.greeting.1'),
    text('voice.greeting.2'),
  ];
}
/** Back-compat single-line greeting (kept for any caller that wants one string). */
export function greetingLine(locale: SupportedLocale = DEFAULT_LOCALE): string { return greetingLines(locale).join(' '); }

const CAR_SELECT = ['voice.carSelect.0', 'voice.carSelect.1'] as const;
const MAP_SELECT = ['voice.mapSelect.0', 'voice.mapSelect.1'] as const;
const CAR_PICKED = ['voice.carPicked.0', 'voice.carPicked.1', 'voice.carPicked.2', 'voice.carPicked.3'] as const;

const STREAK = ['voice.streak.0', 'voice.streak.1', 'voice.streak.2', 'voice.streak.3', 'voice.streak.4'] as const;
const LAST = ['voice.last.0', 'voice.last.1', 'voice.last.2', 'voice.last.3', 'voice.last.4'] as const;
const LEAD = ['voice.lead.0', 'voice.lead.1', 'voice.lead.2', 'voice.lead.3', 'voice.lead.4'] as const;
// A NITRO dash blasting through a barrier — the special move paying off. Big, hype, spoken to the caller.
const SMASH = ['voice.smash.0', 'voice.smash.1', 'voice.smash.2', 'voice.smash.3', 'voice.smash.4'] as const;

/** What to SAY (if anything) for a game event, from THIS caller's perspective. Returns null when the
 *  event shouldn't be spoken to THIS caller. `myPlayerId` is the caller's bound player id, so we only
 *  voice events about THEIR car. `seq` picks a phrase-bank variant (pass a per-adapter counter).
 *  Mid-race arcade lines (streak/fell-to-last/lead) are OPT-IN via `chatty` + the caller decides how
 *  often to actually speak them (the adapter throttles) so TTS never buries the caller's commands. */
export function lineForEvent(ev: GameEvent, myPlayerId: string | null, seq = 0,
                             locale: SupportedLocale = DEFAULT_LOCALE): string | null {
  const text = createTranslator(locale, RACER_MESSAGES);
  const mine = (id: string) => myPlayerId !== null && id === myPlayerId;
  switch (ev.kind) {
    case 'enter_car_select': return pick(CAR_SELECT, seq, text);
    case 'enter_map_select': return pick(MAP_SELECT, seq, text);
    case 'car_picked':       return mine(ev.playerId)
      ? text('voice.carPickedLine', { reaction: pick(CAR_PICKED, seq, text), car: carName(locale, ev.car) }) : null;
    case 'map_picked':       return ev.playerId && mine(ev.playerId)
      ? text('voice.voteTrack', { map: trackName(locale, ev.map) }) : null;
    case 'countdown':
      return ev.n <= 3 ? countdownCue(ev.n, locale) : null;
    case 'go':
      return text('voice.go');
    case 'finish':
      return mine(ev.playerId) ? placeLine(ev.place, locale) : null;
    case 'hit_streak':
      return mine(ev.playerId) ? pick(STREAK, seq, text) : null;
    case 'fell_to_last':
      return mine(ev.playerId) ? pick(LAST, seq, text) : null;
    case 'lead_change':
      return mine(ev.playerId) ? pick(LEAD, seq, text) : null;
    case 'barrier_smashed':
      return mine(ev.playerId) ? pick(SMASH, seq, text) : null;   // NITRO paid off — hype it up
    // hit / boost_taken / race_over → not spoken to the caller (screen announcer covers them).
    default:
      return null;
  }
}

const pick = (arr: readonly RacerMessageKey[], seq: number, text: Text): string => text(arr[Math.abs(seq) % arr.length]!);

/** Which event kinds are the mid-race "arcade" lines — the adapter throttles these so spoken audio
 *  doesn't step on the caller's own commands. Countdown/go/finish are key moments, always spoken. */
export function isChattyEvent(kind: GameEvent['kind']): boolean {
  return kind === 'hit_streak' || kind === 'fell_to_last' || kind === 'lead_change' || kind === 'barrier_smashed';
}

/** A result callout by finishing place. Scripted fallback when the LLM host is off. */
export function placeLine(place: number, locale: SupportedLocale = DEFAULT_LOCALE): string {
  const text = createTranslator(locale, RACER_MESSAGES);
  switch (place) {
    case 1: return text('voice.place.first');
    case 2: return text('voice.place.second');
    case 3: return text('voice.place.third');
    default: return text('voice.place.other', { place: ordinal(place, locale) });
  }
}

export function raceOverLine(place: number | null, locale: SupportedLocale = DEFAULT_LOCALE): string {
  const text = createTranslator(locale, RACER_MESSAGES);
  if (place === 1) return text('voice.raceOver.first');
  if (place && place > 1) return text('voice.raceOver.other', { place: ordinal(place, locale) });
  return text('voice.raceOver.none');
}

/** 1→"1st", 2→"2nd", 3→"3rd", 4→"4th", … (spoken form). */
export function ordinal(n: number, locale: SupportedLocale = DEFAULT_LOCALE): string {
  if (locale === 'pt-BR') return `${n}º`;
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
