import type { SupportedLocale } from '../../shared/i18n/locales';
import type { KaraokeSong } from '../../shared/karaoke';
import { KARAOKE_MAX_SCORE } from '../../shared/karaoke-protocol';
import { resultTechHtml } from '../result-tech';
import { karaokeCopy } from './karaoke-copy';

export interface KaraokeResultViewInput {
  locale: SupportedLocale;
  singerName: string;
  score: number;
  bestCombo: number;
  song: Pick<KaraokeSong, 'title' | 'artist'> | null;
  leaderboardEntries: readonly { name: string; score: number; bestCombo: number }[];
  leaderboardLoading: boolean;
  canReplayOnDisplay: boolean;
  stationManaged: boolean;
  guideMode?: boolean;
}

export function renderKaraokeResultsHtml(input: KaraokeResultViewInput): string {
  const copy = karaokeCopy(input.locale);
  const song = input.song
    ? `<span class="result-song"><b>${escapeHtml(input.song.title)}</b><small>${escapeHtml(input.song.artist)}</small></span>`
    : '';
  const resultNote = input.stationManaged
    ? `<p class="result-station-note">${escapeHtml(copy.stationNextRound)}</p>`
    : input.canReplayOnDisplay ? '' : `<p class="result-phone-note">${escapeHtml(copy.againByPhone)}</p>`;
  const actions = input.stationManaged ? '' : `<div class="flow-actions result-actions">${input.canReplayOnDisplay
    ? `<button id="advance-flow" class="primary-action" type="button">${escapeHtml(copy.again)}</button>` : ''}<a id="karaoke-exit" class="secondary-action" href="/">${escapeHtml(copy.exit)}</a></div>`;
  return `<section class="flow-panel results-panel${input.stationManaged ? ' station-managed' : ''}" aria-live="off">
    <div class="flow-kicker"><img src="/brand/Twilio_Logo_Bug_White.svg" alt=""><span>${escapeHtml(copy.appKicker)}</span>${input.guideMode ? `<b class="guide-mode-label">${escapeHtml(copy.guideMode)}</b>` : ''}</div>
    <h1>${escapeHtml(copy.results)}</h1><p>${escapeHtml(input.singerName)}</p>
    <div class="results-grid">
      <div class="flow-card result-card"><span class="result-score-label">${escapeHtml(copy.score)}</span><div class="result-score">${formatScore(input.score, input.locale)}</div>
        <div class="result-meta"><span>${escapeHtml(copy.bestCombo)} <b>${Math.max(0, Math.floor(input.bestCombo))}x</b></span>${song}</div>${resultNote}</div>
      <section class="flow-card karaoke-board" aria-label="${escapeHtml(copy.leaderboard)}"><h2>${escapeHtml(copy.leaderboard)}</h2>${input.song ? `<p>${escapeHtml(input.song.title)}</p>` : ''}
        <div class="karaoke-board-list" aria-busy="${input.leaderboardLoading}">${renderKaraokeLeaderboardRowsHtml(input.leaderboardEntries, input.leaderboardLoading, input.locale)}</div>
      </section>
    </div>${actions}
    ${resultTechHtml('karaoke', input.locale, { stationManaged: input.stationManaged })}
  </section>`;
}

export function karaokeResultAnnouncement(
  input: Pick<KaraokeResultViewInput, 'locale' | 'singerName' | 'score' | 'bestCombo'>,
): string {
  const copy = karaokeCopy(input.locale);
  return `${copy.results}. ${input.singerName}. ${copy.score}: ${formatScore(input.score, input.locale)}. `
    + `${copy.bestCombo}: ${Math.max(0, Math.floor(input.bestCombo))}x.`;
}

export function renderKaraokeLeaderboardRowsHtml(
  entries: readonly { name: string; score: number; bestCombo: number }[],
  loading: boolean,
  locale: SupportedLocale,
): string {
  const copy = karaokeCopy(locale);
  return entries.length
    ? entries.slice(0, 10).map((entry, index) => `<div class="karaoke-board-row"><span>${index + 1}</span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(copy.bestCombo)} ${Math.max(0, Math.floor(entry.bestCombo))}x</small><b>${formatScore(entry.score, locale)}</b></div>`).join('')
    : `<p class="karaoke-board-empty">${escapeHtml(loading ? copy.leaderboardLoading : copy.noRecords)}</p>`;
}

function formatScore(score: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
    .format(Math.max(0, Math.min(KARAOKE_MAX_SCORE, score)));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
