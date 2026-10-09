// Shared-screen Racer menus: lobby, car selection, track vote, and results. The server
// supplies the current room and eligible caller seat for voice, keyboard, or touch selection.
// Gameplay input remains on the phone; styling lives in racer.css.
import type { LobbyPlayer, RaceResult, MenuTouchState, RacerSetupStatus } from '../shared/types';
import { controlsLegendHtml } from './controls-legend';
import { resultTechHtml } from './result-tech';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import { RACER_MESSAGES, type RacerMessageKey } from '../shared/i18n/racer';
import { createTranslator } from '../shared/i18n/translate';
import { trackName as localizedTrackName, playerName as localizedPlayerName } from '../shared/i18n/content';

/** One row of the persistent global leaderboard (best all-time times). */
export interface GlobalEntry { name: string; map: string; carIndex: number; finishT: number; at: number }

/** Live map-vote tally for the track-select screen: per-map counts + whether the current leader is a
 *  random-broken tie. */
export interface MapVotes { counts: Record<string, number>; tie: boolean }

export interface ScreensCallbacks {
  onAdvance(roomCode: string, phase: 'lobby' | 'car_select' | 'map_select' | 'results', playerId: string | null): void;
  onBack(roomCode: string, phase: 'car_select' | 'map_select'): void;
  onSelectCar(roomCode: string, playerId: string, index: number): void;
  onSelectMap(roomCode: string, playerId: string, map: string): void;
}

const BUG = '/brand/Twilio_Logo_Bug_White.svg';
const PLACE_COLOR = ['var(--gold)', 'var(--silver)', 'var(--bronze)'];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** Defense-in-depth: only let an obvious CSS color literal into a style attribute (server also
 *  sanitizes; never trust a single layer for values that land in style="..."). */
const cssColor = (c: string, fallback = '#888') =>
  /^(#[0-9a-fA-F]{3,8}|rgb\([\d,\s]+\)|hsl\([\d,%\s]+\))$/.test(c?.trim?.() ?? '') ? c.trim() : fallback;

export class Screens {
  private root: HTMLElement;
  private text: ReturnType<typeof createTranslator<RacerMessageKey>>;
  private carNames: string[] = [];
  private carThumbs: string[] = [];
  private unavailableCarThumbs = new Set<number>();
  private mapPreviews: Record<string, string> = {};
  /** Rendered boost-orb thumbnail (data-URL) for the lobby "How to play" NITRO row; '' until it lands. */
  private boostThumb = '';
  /** The phone number players CALL to join (from /api/config); '' until it loads → lobby shows a
   *  "set GAME_PHONE_NUMBER" placeholder so a misconfigured deploy is obvious on screen. */
  private phoneNumber = '';
  private phoneQr = '/brand/join-qr.png?v=2';
  private arcadeQr = '';
  private visible = false;
  private phase: 'lobby' | 'car_select' | 'map_select' | 'results' | null = null;
  private menuRoomCode = '';
  private menuTouch: MenuTouchState | null = null;
  private lastMapArgs: { maps: string[]; selectedMap: string | null; players: LobbyPlayer[]; votes: MapVotes } | null = null;
  /** Signature of the last rendered state. The server re-broadcasts the roster ~2x/s; rebuilding
   *  innerHTML each time replays the CSS entrance animations → the "flicker" the user saw. We skip
   *  the rebuild when nothing meaningful changed. */
  private lastKey = '';
  /** Shared-screen only: whether the operator opted to also play on this keyboard (P toggle). Shown
   *  in the lobby footer so the screen's state ("spectating" vs "you're racing") is never ambiguous. */
  private selfPlaying = false;

  constructor(host: HTMLElement, private cb: ScreensCallbacks,
              private locale: SupportedLocale = DEFAULT_LOCALE,
              private stationManaged = false) {
    this.text = createTranslator(locale, RACER_MESSAGES);
    this.root = document.createElement('div');
    this.root.id = 'screens';
    host.appendChild(this.root);
    this.root.addEventListener('click', event => {
      const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>('button[data-menu-action]');
      if (!button || !this.root.contains(button) || button.disabled) return;
      const action = button.dataset.menuAction;
      if (action === 'advance') this.advance();
      else if (action === 'back') this.back();
      else if (action === 'car') this.selectCar(Number(button.dataset.index));
      else if (action === 'map' && button.dataset.map) this.selectMap(button.dataset.map);
    });
  }

  /** The server labels the exact caller seat a tap can select for, and validates it again. */
  setMenuTouch(roomCode: string, touch?: MenuTouchState): void {
    const next = touch ?? null;
    const same = this.menuRoomCode === roomCode && JSON.stringify(this.menuTouch) === JSON.stringify(next);
    this.menuRoomCode = roomCode;
    this.menuTouch = next;
    if (!same) this.lastKey = '';
  }

  selectCar(index: number): void {
    if (!this.visible || this.phase !== 'car_select' || !Number.isInteger(index) || index < 0) return;
    const playerId = this.menuTouch?.activePlayerId;
    if (playerId) this.cb.onSelectCar(this.menuRoomCode, playerId, index);
  }
  selectMap(map: string): void {
    if (!this.visible || this.phase !== 'map_select' || !map) return;
    const playerId = this.menuTouch?.activePlayerId;
    if (playerId) this.cb.onSelectMap(this.menuRoomCode, playerId, map);
  }
  private advance(): void {
    if (!this.visible || !this.phase || !this.menuTouch?.canAdvance) return;
    this.cb.onAdvance(this.menuRoomCode, this.phase, this.menuTouch.advancePlayerId);
  }
  private back(): void {
    if (!this.visible || !this.menuTouch?.canBack
      || (this.phase !== 'car_select' && this.phase !== 'map_select')) return;
    this.cb.onBack(this.menuRoomCode, this.phase);
  }

  /** Supply the join phone number (from /api/config); re-render the lobby if it's up so the QR-flow
   *  copy shows the real number instead of the placeholder. */
  setPhoneNumber(num: string, qr = ''): void {
    if (num === this.phoneNumber && qr === this.phoneQr) return;
    this.phoneNumber = num;
    this.phoneQr = qr;
    if (this.visible && this.phase === 'lobby' && this.lastLobby) {
      this.lastKey = '';
      this.renderLobby(this.lastLobby.roomCode, this.lastLobby.players);
    }
  }

  setArcadeQr(url: string): void {
    if (!url || url === this.arcadeQr) return;
    this.arcadeQr = url;
    if (this.visible && this.phase === 'lobby' && this.lastLobby) {
      this.lastKey = '';
      this.renderLobby(this.lastLobby.roomCode, this.lastLobby.players);
    }
  }

  /** Supply the rendered boost-orb thumbnail; re-render the lobby if it's up so the NITRO row shows it. */
  setBoostThumb(url: string): void {
    if (!url || url === this.boostThumb) return;
    this.boostThumb = url;
    if (this.visible && this.phase === 'lobby' && this.lastLobby) {
      this.lastKey = '';   // force past the dedup
      this.renderLobby(this.lastLobby.roomCode, this.lastLobby.players);
    }
  }

  /** Reflect the shared-screen "I'm playing" toggle in the lobby footer. */
  setSelfPlaying(on: boolean): void {
    this.selfPlaying = on;
    this.lastKey = '';   // force the next render past the dedup so the footer updates
    if (this.visible && this.phase === 'lobby') this.lastLobby && this.renderLobby(this.lastLobby.roomCode, this.lastLobby.players);
  }
  private lastLobby: { roomCode: string; players: LobbyPlayer[] } | null = null;

  /** Stable, order-sensitive fingerprint of the roster for the dedup guard. */
  private rosterKey(players: LobbyPlayer[]): string {
    return players.map(p => `${p.playerId}:${p.name}:${p.color}:${p.carIndex}:${p.ready ? 1 : 0}:${p.setupStatus ?? ''}`).join('|');
  }
  /** True if this exact view was already rendered (skip the rebuild). Stores the new key otherwise. */
  private unchanged(key: string): boolean {
    if (key === this.lastKey) return true;
    this.lastKey = key;
    return false;
  }

  setCarCatalog(names: string[], thumbs: string[]): void {
    this.carNames = names; this.carThumbs = thumbs.length ? thumbs : this.carThumbs;
    if (this.visible && this.phase === 'car_select') this.rerenderCarSelect(true);   // names changed
  }
  /** Progressive thumbnails: a portrait finished — store it and live-swap that tile's <img> (no
   *  rebuild, so no animation replay). Only rebuilds if the tile isn't in the DOM yet. */
  setCarThumb(i: number, url: string): void {
    if (url) { this.carThumbs[i] = url; this.unavailableCarThumbs.delete(i); }
    else this.unavailableCarThumbs.add(i);
    const img = this.root.querySelector(`img[data-car-thumb="${i}"]`);
    if (url && img instanceof HTMLImageElement) {
      img.src = url; img.style.opacity = '1';
      // Remove the "CAR N" + spinner placeholder — it's position:absolute; inset:0, so if left in
      // place it sits ON TOP of the finished portrait forever (the "stuck loading" overlay bug).
      this.root.querySelector(`span.ph[data-ph="${i}"]`)?.remove();
    } else if (!url) {
      this.root.querySelector(`span.ph[data-ph="${i}"]`)?.classList.add('unavailable');
    } else if (this.visible && this.phase === 'car_select') {
      this.rerenderCarSelect(true);
    }
  }
  setMapPreviews(previews: Record<string, string>): void {
    this.mapPreviews = previews;
    // If the map-select screen is already showing, re-render so the previews replace the placeholders.
    if (this.visible && this.phase === 'map_select' && this.lastMapArgs) {
      const a = this.lastMapArgs;
      this.lastKey = '';   // force past the dedup
      this.renderMapSelect(a.maps, a.selectedMap, a.players, a.votes);
    }
  }

  show(results = false): void {
    this.visible = true; this.root.style.display = 'flex';
    document.body.classList.add('in-menu');
    this.root.classList.remove('is-race');
    this.root.classList.toggle('results-screen', results);
    this.root.classList.toggle('station-result', results && this.stationManaged);
  }
  hide(): void {
    this.visible = false; this.root.style.display = 'none'; this.phase = null;
    this.lastKey = '';   // re-entering a screen later should render fresh
    document.body.classList.remove('in-menu');
  }
  get isVisible(): boolean { return this.visible; }

  // ── Lobby ──────────────────────────────────────────────────────────────────────────────────────
  renderLobby(roomCode: string, players: LobbyPlayer[]): void {
    this.show(); this.phase = 'lobby';
    this.lastLobby = { roomCode, players };
    void roomCode;   // no longer shown — calls bind straight to the single game (instant join)
    if (this.unchanged(`lobby:${this.stationManaged ? 'station' : 'standalone'}:${this.selfPlaying ? 'P' : 'p'}:${this.phoneNumber}:${this.phoneQr ? 'phoneqr' : 'nophoneqr'}:${this.arcadeQr ? 'coin' : 'nocoin'}:${this.boostThumb ? 'orb' : 'noorb'}:${this.rosterKey(players)}`)) return;
    const n = players.length;
    const sub = n === 0 ? this.text('screen.lobby.emptySubtitle')
      : this.text(n === 1 ? 'screen.lobby.oneRacer' : 'screen.lobby.manyRacers', { count: n });
    // JOIN FLOW: scan the QR → it dials the number → you're IN the race (no room code to type — the
    // call binds straight to this game). The number comes from /api/config (placeholder if unset).
    const num = this.phoneNumber
      ? `<a class="num" href="tel:${esc(this.phoneNumber)}">${esc(this.phoneNumber)}</a>`
      : `<span class="num num-unset">${this.text('screen.lobby.phoneUnset')}</span>`;
    const foot = n === 0
      ? this.text('screen.lobby.everyoneCanJoin')
      : this.text('screen.lobby.sayStart');
    const joinFlow = this.stationManaged
      ? `<div class="join-flow station-call-flow">
          <div class="join-flow-message"><strong>${this.text('screen.lobby.stationTitle')}</strong><span>${this.text('screen.lobby.stationBody')}</span></div>
          <ol class="join-steps">
            <li><span class="step-n">1</span> <span class="step-t">${this.text('screen.lobby.stationStep1')}</span></li>
            <li><span class="step-n">2</span> <span class="step-t">${this.text('screen.lobby.stationStep2')}</span></li>
            <li><span class="step-n">3</span> <span class="step-t">${this.text('screen.lobby.stationStep3')}</span></li>
          </ol>
        </div>`
      : `<div class="join-flow">
          <div class="join-qrs">
            <div class="join-qr">
              ${this.phoneQr ? `<img src="${this.phoneQr}" alt="${this.text('screen.lobby.qrAlt')}">` : ''}
              <div class="join-qr-cap">${this.text('screen.lobby.qrCaption')}</div>
            </div>
            ${this.arcadeQr ? `<div class="join-qr coin-qr"><img src="${this.arcadeQr}" alt="${this.text('screen.lobby.coinQrAlt')}"><div class="join-qr-cap">${this.text('screen.lobby.coinQrCaption')}</div></div>` : ''}
          </div>
          <ol class="join-steps">
            <li><span class="step-n">1</span> <span class="step-t">${this.text('screen.lobby.scanStep')}</span></li>
            <li><span class="step-n">2</span> <span class="step-t">${this.text('screen.lobby.callStep')} ${num}</span></li>
            <li><span class="step-n">3</span> <span class="step-t">${this.text('screen.lobby.joinStep')}</span></li>
          </ol>
        </div>`;
    this.root.innerHTML = `
      ${this.head(this.text('screen.lobby.title'), sub)}
      <div class="scr-center lobby-grid">
        <div class="lobby-main">
          ${joinFlow}
          ${this.chips(players)}
          ${this.menuFooter(foot, 'lobby')}
        </div>
        ${controlsLegendHtml(this.boostThumb, this.locale)}
      </div>`;
  }

  // ── Car select — the SSB grid ────────────────────────────────────────────────────────────────
  renderCarSelect(players: LobbyPlayer[]): void {
    this.show(); this.phase = 'car_select'; this.lastPlayers = players;
    this.rerenderCarSelect();
  }
  private lastPlayers: LobbyPlayer[] = [];
  private rerenderCarSelect(force = false): void {
    const players = this.lastPlayers;
    // Dedup on roster + car-name count (names arrive after first paint). Thumbnails stream in via
    // setCarThumb's in-place <img> swap, so they don't need a full rebuild. force=true bypasses
    // (used when the catalog/names change and the grid must be rebuilt).
    if (!force && this.unchanged(`cars:${this.carNames.length}:${this.rosterKey(players)}`)) return;
    const claims = new Map<number, LobbyPlayer[]>();
    for (const p of players) if (p.carIndex !== null) {
      const a = claims.get(p.carIndex) ?? []; a.push(p); claims.set(p.carIndex, a);
    }
    const allReady = players.length >= (this.menuTouch?.expectedPlayers ?? players.length)
      && players.length > 0 && players.every(p => p.ready && (!p.setupStatus || p.setupStatus === 'ready'));
    const tiles = this.carNames.map((nm, i) => this.carTile(i, nm, claims.get(i) ?? [])).join('');
    // Pick a column count that keeps the grid roughly landscape (≈16:9) so all cars fit on one
    // screen without scrolling — e.g. 19 cars → 7 cols × 3 rows. CSS rows are 1fr (fill the height).
    const n = this.carNames.length;
    const cols = Math.max(4, Math.min(8, Math.ceil(Math.sqrt(n * 1.9))));
    this.root.innerHTML = `
      ${this.head(this.text('screen.car.title'), allReady
        ? this.text('screen.car.readySubtitle') : this.text('screen.car.pickSubtitle'))}
      ${this.chips(players)}
      ${this.touchSeat(players)}
      <div class="scr-body"><div class="grid" style="--cols:${cols}">${tiles}</div></div>
      ${this.menuFooter(this.text(allReady ? 'screen.car.readyFooter' : 'screen.car.pickFooter'), 'car_select')}`;
  }

  private carTile(i: number, name: string, claimedBy: LobbyPlayer[]): string {
    const claimed = claimedBy.length > 0;
    const claim = claimed ? cssColor(claimedBy[0]!.color) : '';
    const url = this.carThumbs[i];
    const unavailable = this.unavailableCarThumbs.has(i);
    const portrait = url
      ? `<div class="portrait"><img data-car-thumb="${i}" src="${url}" alt="" style="opacity:1"></div>`
      : `<div class="portrait"><img data-car-thumb="${i}" alt="" style="opacity:0"><span class="ph${unavailable ? ' unavailable' : ''}" data-ph="${i}">${this.text('screen.car.placeholder', { number: i + 1 })}</span></div>`;
    const badges = claimedBy.map(p =>
      `<span class="badge" style="background:${cssColor(p.color)}">${esc(p.name)}</span>`).join('');
    const active = this.lastPlayers.find(player => player.playerId === this.menuTouch?.activePlayerId);
    const label = this.text('screen.car.touchChoose', { car: name, name: active?.name ?? '' });
    return `
      <button type="button" class="tile${claimed ? ' claimed' : ''}" data-menu-action="car" data-index="${i}"
        aria-label="${esc(label)}" aria-pressed="${claimedBy.some(player => player.playerId === active?.playerId)}"
        ${active ? '' : 'disabled'}${claimed ? ` style="--claim:${claim}"` : ''}>
        <div class="num">${i + 1}</div>
        ${portrait}
        <div class="cname">${esc(name)}</div>
        <div class="badges">${badges}</div>
      </button>`;
  }

  // ── Map select ───────────────────────────────────────────────────────────────────────────────
  renderMapSelect(maps: string[], selectedMap: string | null, players: LobbyPlayer[], votes: MapVotes = { counts: {}, tie: false }): void {
    this.show(); this.phase = 'map_select';
    this.lastMapArgs = { maps, selectedMap, players, votes };
    const counts = votes.counts;
    const totalVotes = Object.values(counts).reduce((s, n) => s + n, 0);
    // Dedup key includes the vote tally + tie so the UI live-updates as votes come in.
    const havePrev = maps.some(m => this.mapPreviews[m]) ? 'p' : 'n';
    const voteKey = maps.map(m => `${m}=${counts[m] ?? 0}`).join(',') + (votes.tie ? '|tie' : '');
    if (this.unchanged(`map:${selectedMap}:${maps.join(',')}:${havePrev}:${voteKey}:${this.rosterKey(players)}`)) return;
    const tiles = maps.map((m, i) => {
      const n = counts[m] ?? 0;
      const leading = m === selectedMap;   // the current vote winner
      const prev = this.mapPreviews[m];
      const thumb = prev
        ? `<img src="${esc(prev)}" alt="">`
        : `<span class="ph">${this.text('screen.map.placeholder', { number: i + 1 })}</span>`;
      // A vote badge (count + label) so it's clear this is a vote, and which track is winning.
      const voteBadge = `<div class="votes${n > 0 ? ' has' : ''}">${this.text(n === 1 ? 'screen.map.oneVote' : 'screen.map.manyVotes', { count: n })}</div>`;
      return `
        <button type="button" class="map${leading ? ' sel' : ''}" data-menu-action="map" data-map="${esc(m)}"
          aria-label="${esc(this.text('screen.map.touchVote', { map: localizedTrackName(this.locale, m),
            name: players.find(player => player.playerId === this.menuTouch?.activePlayerId)?.name ?? '' }))}"
          ${this.menuTouch?.activePlayerId ? '' : 'disabled'}>
          <div class="thumb">${thumb}<div class="num">${i + 1}</div>${voteBadge}</div>
          <div class="mname">${esc(localizedTrackName(this.locale, m))}${leading ? ` <span class="check">▶ ${this.text('screen.map.leading')}</span>` : ''}</div>
        </button>`;
    }).join('');
    // Headline messaging that makes the vote (and tie-break) explicit.
    const sub = totalVotes === 0 ? this.text('screen.map.noVotesSubtitle')
      : votes.tie ? this.text('screen.map.tieSubtitle')
      : this.text('screen.map.leadingSubtitle', {
          count: totalVotes, plural: totalVotes === 1 ? '' : 's', map: esc(selectedMap ? localizedTrackName(this.locale, selectedMap) : '—'),
        });
    this.root.innerHTML = `
      ${this.head(this.text('screen.map.title'), sub)}
      ${this.chips(players)}
      ${this.touchSeat(players)}
      <div class="scr-center"><div class="maps">${tiles}</div></div>
      ${this.menuFooter(selectedMap ? this.text(votes.tie ? 'screen.map.startTieFooter' : 'screen.map.startWinnerFooter')
        : this.text('screen.map.pickFooter'), 'map_select')}`;
  }

  // ── Results — this race + all-time board ─────────────────────────────────────────────────────
  renderResults(results: RaceResult[], carNameFor: (i: number) => string,
                global?: { map: string | null; entries: GlobalEntry[] }): void {
    const active = this.root.ownerDocument.activeElement;
    const focusSelector = active && this.root.contains(active)
      ? active.matches('button[data-menu-action="advance"]') ? 'button[data-menu-action="advance"]'
        : active.matches('a.menu-button[href]') ? 'a.menu-button[href]'
          : active.matches('a[href]') && active.closest('.racer-result-tech') ? '.racer-result-tech a[href]'
            : null
      : null;
    const preserveView = this.visible && this.phase === 'results' ? {
      page: this.root.scrollTop,
      standings: this.root.querySelector<HTMLElement>('.res-list')?.scrollTop ?? 0,
      board: this.root.querySelector<HTMLElement>('.board')?.scrollTop ?? 0,
      expanded: [...this.root.querySelectorAll<HTMLDetailsElement>('details')].map((detail, index) => detail.open ? index : -1),
    } : null;
    this.show(true); this.phase = 'results';
    // Dedup: the server re-broadcasts results ~2x/s → rebuilding innerHTML replayed the title +
    // row entrance animations = flicker. Key on the standings + the global board so the only
    // legit re-render is when the all-time board folds in after its fetch.
    const key = 'res:' + results.map(r => `${r.place}:${r.name}:${r.finishT}:${r.finished?1:0}`).join('|')
      + '#' + (global ? `${global.map}:` + global.entries.map(e => `${e.name}:${e.finishT}`).join(',') : 'nob');
    if (this.unchanged(key)) return;
    const rows = results.map((r) => {
      const win = r.place === 1 && r.finished && r.finishT > 0;
      const accent = PLACE_COLOR[r.place - 1] ?? 'var(--cyan)';
      const time = r.finished && r.finishT > 0 ? this.formatSeconds(r.finishT) : this.text('screen.results.dnf');
      return `
        <div class="res-row${win ? ' win' : ''}">
          <div class="place" style="color:${accent};font-size:${win ? '30px' : '22px'}">${this.placeLabel(r.place)}</div>
          <div class="rname" style="font-size:${win ? '26px' : '19px'}">${esc(r.name)}</div>
          <div class="rcar">${esc(carNameFor(r.carIndex))}</div>
          <div class="rtime" style="font-size:${win ? '24px' : '19px'}">${time}</div>
        </div>`;
    }).join('');
    const winner = results.find(row => row.place === 1 && row.finished && row.finishT > 0);
    const heroTitle = winner
      ? this.text('screen.results.winner', { name: localizedPlayerName(this.locale, winner.name) })
      : this.text('screen.results.complete');
    const heroDetail = winner
      ? this.text('screen.results.winningTime', { time: this.formatSeconds(winner.finishT) }) : '';
    const board = global ? this.boardHtml(global.map, global.entries, carNameFor) : '';
    const replayStatuses = this.menuTouch?.sharedReplayRequiresCalls
      ? this.menuTouch.sharedReplayStatuses ?? [] : [];
    const replayProgress = replayStatuses.length ? `<div class="replay-progress" role="status" aria-live="polite" aria-label="${esc(this.text('screen.results.replay.title'))}">
      ${replayStatuses.map(({ playerId, state }) => {
        const name = results.find(result => result.playerId === playerId)?.name ?? playerId;
        return `<div class="replay-progress-player is-${state}"><strong>${esc(name)}</strong><span>${esc(this.text(`screen.results.replay.${state}` as RacerMessageKey))}</span></div>`;
      }).join('')}
    </div>` : '';
    const resultFooter = this.stationManaged ? 'screen.results.stationFooter'
      : replayStatuses.some(status => status.state === 'left') ? 'screen.results.sharedLeftFooter'
      : this.menuTouch?.sharedReplayRequiresCalls ? 'screen.results.sharedFooter'
      : this.menuTouch?.canAdvance ? 'screen.results.againFooter'
        : this.menuTouch?.advancePlayerId ? 'screen.results.waitCurrentFooter'
          : 'screen.results.waitJoinFooter';
    this.root.innerHTML = `
      ${this.head(this.text('screen.results.title'), '')}
      <div class="res-hero">
        <div class="res-hero-copy"><span class="res-hero-kicker">${this.text('screen.results.title')}</span>
          <h1>${esc(heroTitle)}</h1>${heroDetail ? `<p>${esc(heroDetail)}</p>` : ''}</div>
      </div>
      ${this.menuFooter(this.text(resultFooter), 'results')}
      ${replayProgress}
      <div class="results-wrap">
        <div class="res-list"><div class="col-label">${this.text('screen.results.thisRace')}</div>${rows}</div>
        ${board}
      </div>
      <div class="racer-result-tech">${resultTechHtml('racer', this.locale, { stationManaged: this.stationManaged })}</div>`;
    if (preserveView) {
      this.root.scrollTop = preserveView.page;
      const standings = this.root.querySelector<HTMLElement>('.res-list');
      const boardEl = this.root.querySelector<HTMLElement>('.board');
      if (standings) standings.scrollTop = preserveView.standings;
      if (boardEl) boardEl.scrollTop = preserveView.board;
      this.root.querySelectorAll<HTMLDetailsElement>('details').forEach((detail, index) => {
        detail.open = preserveView.expanded.includes(index);
      });
      if (focusSelector) this.root.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
    }
  }

  private boardHtml(map: string | null, entries: GlobalEntry[], carNameFor: (i: number) => string): string {
    const rows = entries.length ? entries.map((e, i) => `
      <div class="board-row">
        <div class="bn">${i + 1}</div>
        <div class="rname">${esc(localizedPlayerName(this.locale, e.name))}</div>
        <div class="rcar">${esc(carNameFor(e.carIndex))}</div>
        <div class="rtime">${this.formatSeconds(e.finishT)}</div>
      </div>`).join('')
      : `<div class="board-empty">${this.text('screen.results.noRecords')}</div>`;
    return `<div class="board"><div class="col-label">${this.text('screen.results.allTime')}${map ? ' · ' + esc(localizedTrackName(this.locale, map)) : ''}</div>${rows}</div>`;
  }

  // ── shared bits ──────────────────────────────────────────────────────────────────────────────
  // Header brand stack: "Twilio" eyebrow (line 1) → red "VOICE RACER" wordmark (the game name) →
  // the current screen state ("Press Start", "Choose Your Ride", …) as a smaller caption, then the
  // dynamic subtitle line. `state` is the per-screen label; `sub` is the contextual hint.
  private head(state: string, sub: string): string {
    return `
      <div class="scr-head">
        <div class="scr-eyebrow"><img src="${BUG}" alt="">Twilio</div>
        <div class="scr-title">${this.text('game.title')}</div>
        <div class="scr-state">${esc(state)}</div>
        ${sub ? `<div class="scr-sub">${sub}</div>` : ''}
      </div>`;
  }

  private touchSeat(players: LobbyPlayer[]): string {
    const active = players.find(player => player.playerId === this.menuTouch?.activePlayerId);
    return active ? `<div class="touch-seat">${esc(this.text('screen.touchFor', { name: active.name }))}</div>` : '';
  }

  private menuFooter(hint: string, phase: 'lobby' | 'car_select' | 'map_select' | 'results'): string {
    const touch = this.menuTouch;
    const back = touch?.canBack && (phase === 'car_select' || phase === 'map_select')
      ? `<button type="button" class="menu-button secondary" data-menu-action="back">${this.text('screen.action.back')}</button>` : '';
    const actionKey = phase === 'lobby' ? 'screen.action.start'
      : phase === 'car_select' ? 'screen.action.next'
        : phase === 'map_select' ? 'screen.action.race' : 'screen.action.replay';
    const advance = touch && !(this.stationManaged && phase === 'results')
      && !(phase === 'results' && touch.sharedReplayRequiresCalls)
      ? `<button type="button" class="menu-button" data-menu-action="advance" ${touch.canAdvance ? '' : 'disabled'}>${this.text(actionKey)}</button>` : '';
    const exit = phase === 'results' && !this.stationManaged
      ? `<a class="menu-button secondary" href="/">${this.text('screen.results.exit')}</a>` : '';
    return `<div class="scr-foot"><span>${hint}</span>${back || advance || exit ? `<div class="menu-actions">${back}${advance}${exit}</div>` : ''}</div>`;
  }

  private chips(players: LobbyPlayer[]): string {
    const expected = Math.max(players.length, this.menuTouch?.expectedPlayers ?? 0);
    if (expected === 0)
      return `<div class="chips"><div class="chip-empty">${this.text('screen.waitingPlayers')}</div></div>`;
    const chips = Array.from({ length: expected }, (_, i) => {
      const p = players.find(player => player.lane === i);
      if (!p) return `<div class="chip chip-awaiting"><span class="setup-status is-waiting">${esc(this.text('screen.setup.waitingSeat', { number: i + 1 }))}</span></div>`;
      const col = cssColor(p.color);
      // Only show a car label once the player has actually picked one. In the lobby nobody has
      // chosen yet, so showing a placeholder "…" on every pill looked broken.
      const carLabel = p.carIndex !== null
        ? `<span class="car">${esc(this.carNames[p.carIndex]
            ?? this.text('screen.carFallback', { number: p.carIndex + 1 }))}</span>` : '';
      const status = this.setupStatusLabel(p.setupStatus);
      // Two-line identity stack: a small "Player N" eyebrow over the player's NAME (the main text).
      return `
        <div class="chip${p.ready ? ' ready' : ''}${p.playerId === this.menuTouch?.activePlayerId ? ' touch-target' : ''}"${p.ready ? ` style="border-color:${col}"` : ''}>
          <span class="dot" style="background:${col};color:${col}"></span>
          <span class="who">
            <span class="plabel">${this.text('screen.playerLabel', { number: i + 1 })}</span>
            <span class="nm">${esc(p.name)}</span>
          </span>
          ${carLabel}
          ${status ? `<span class="setup-status is-${p.setupStatus}">${esc(status)}</span>` : ''}
        </div>`;
    }).join('');
    return `<div class="chips">${chips}</div>`;
  }

  private setupStatusLabel(status: RacerSetupStatus | undefined): string {
    if (!status) return '';
    return this.text(`screen.setup.${status}` as RacerMessageKey);
  }

  private placeLabel(place: number): string {
    if (this.locale === 'pt-BR') return `${place}º`;
    return place === 1 ? '1st' : place === 2 ? '2nd' : place === 3 ? '3rd' : `${place}th`;
  }

  private formatSeconds(seconds: number): string {
    return `${new Intl.NumberFormat(this.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(seconds)}s`;
  }

  /** Wire host keyboard: ← back, → / Enter advance. Returns a disposer. */
  bindHostKeys(): () => void {
    const handler = (e: KeyboardEvent) => {
      if (!this.visible) return;
      if ((e.target as Element | null)?.closest?.('button,a,input,textarea,select')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.back(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); this.advance(); }
    };
    addEventListener('keydown', handler);
    return () => removeEventListener('keydown', handler);
  }
}
