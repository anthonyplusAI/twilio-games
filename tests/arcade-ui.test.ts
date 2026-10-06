import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../client/arcade/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../client/arcade/arcade.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../client/arcade/arcade.css', import.meta.url), 'utf8');
const home = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const join = readFileSync(new URL('../client/join/index.html', import.meta.url), 'utf8');
const joinScript = readFileSync(new URL('../client/join/join.ts', import.meta.url), 'utf8');
const joinCss = readFileSync(new URL('../client/join/join.css', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../client/vite.config.ts', import.meta.url), 'utf8');
const racerMain = readFileSync(new URL('../client/main.ts', import.meta.url), 'utf8');
const racerScreens = readFileSync(new URL('../client/screens.ts', import.meta.url), 'utf8');
const homeScript = readFileSync(new URL('../client/home.ts', import.meta.url), 'utf8');
const homeCss = readFileSync(new URL('../client/home.css', import.meta.url), 'utf8');
const stationClient = readFileSync(new URL('../client/station-client.ts', import.meta.url), 'utf8');
const stationDisplay = readFileSync(new URL('../client/station-display.ts', import.meta.url), 'utf8');
const stationDisplayCss = readFileSync(new URL('../client/station-display.css', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};
const monsters = readFileSync(new URL('../client/battle/monsters.ts', import.meta.url), 'utf8');
const fighter = readFileSync(new URL('../client/fighter/fighter.ts', import.meta.url), 'utf8');
const musicToggle = readFileSync(new URL('../client/music-toggle.ts', import.meta.url), 'utf8');
const iconControls = readFileSync(new URL('../client/icon-controls.ts', import.meta.url), 'utf8');
const coinInsertion = readFileSync(new URL('../client/coin-insertion.ts', import.meta.url), 'utf8');
const coinInsertionCss = readFileSync(new URL('../client/coin-insertion.css', import.meta.url), 'utf8');
const serverIndex = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
const stationGameSelect = /<select id="station-game">[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';

describe('Arcade browser UI', () => {
  it('preserves the player fallback and makes live station controls primary for operators', () => {
    expect(home).not.toContain('href="/arcade/"');
    expect(joinScript).toContain("'Continue in browser'");
    expect(join).not.toContain('fallback form');
    expect(join).not.toContain('<details');
    expect(joinScript).toContain('requestedStation ?? arcade.arcade.cabinetId');
    for (const id of [
      'registration-form', 'wallet-panel', 'challenge-panel', 'join-form',
      'queue-actions', 'station-panel', 'station-phase', 'station-revision',
      'station-deadline', 'station-round', 'station-match', 'station-ready',
      'mode-form',
      'admin-voice-en-us', 'admin-voice-pt-br', 'voice-number-status',
      'admin-challenge-panel', 'admin-challenges', 'admin-challenge-form',
      'post-game-status',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html.indexOf('id="station-panel"')).toBeLessThan(html.indexOf('class="panel settings-panel"'));
    expect(html).not.toContain('diagnostics-panel');
    expect(html).not.toContain('seed-challenge');
    expect(script).not.toContain('seedChallenge');
    expect(html).not.toContain('Advanced diagnostics');
    for (const endpoint of [
      '/api/arcade/session', '/api/arcade/register', '/api/arcade/wallet',
      '/api/arcade/challenges', '/api/arcade/station/coin', '/api/admin/arcade/station',
    ]) expect(script).toContain(endpoint);
  });

  it('restores a clean video-card launcher when station mode is off', () => {
    expect(home).toContain('id="standaloneView"');
    expect(homeScript).toContain("show('standalone')");
    expect(homeScript).toContain("if(standaloneMode){renderStandaloneLauncher();show('standalone');}");
    expect(homeScript).toContain('orderByConfiguredIds(PLAYABLE_ARCADE_GAMES,standaloneGameOrder)');
    for (const video of ['vr-demo.mp4','vm-demo.mp4','vf-demo.mp4']) expect(homeScript).toContain(video);
    expect(homeScript).not.toContain('Arcade station mode is off');
    expect(homeScript).not.toContain('Joining unavailable');
    const standaloneRenderer=/function renderStandaloneLauncher\(\)[\s\S]*?\n}\n/.exec(homeScript)?.[0]??'';
    expect(standaloneRenderer).not.toMatch(/playNow|keepPriority|currentReadyCount/);
  });

  it('renders selection as a stable video-backed vote display with automatic fallback copy', () => {
    expect(stationClient).toContain('choices: number');
    expect(homeScript).toContain('racer: 1, monsters: 2, fighter: 3, karaoke: 4, trivia: 5, chess: 6');
    expect(homeScript).toContain('impact.choices');
    expect(homeScript).toContain('Ready players: text the number shown or the game name.');
    expect(homeScript).not.toContain('In a browser, choose on your player page.');
    expect(homeScript).not.toContain('Ready players: text 1, 2, 3');
    expect(homeScript).toContain('If time runs out or votes tie, the station chooses automatically.');
    expect(homeScript).toContain('Playing this round: {count}');
    expect(homeScript).toContain('Waiting for next game: {count}');
    expect(homeScript).not.toContain("'{count} keep priority'");
    expect(homeScript).toContain('Jogadores prontos: respondam por mensagem com o número mostrado ou o nome do jogo.');
    expect(homeScript).not.toContain('No navegador, escolham na página do jogador.');
    for (const video of ['vr-demo.mp4','vm-demo.mp4','vf-demo.mp4']) expect(homeScript).toContain(video);
    expect(homeScript).toContain("document.createElement('article')");
    expect(homeScript).not.toContain("card.addEventListener('click'");
    expect(homeScript).toContain('if (lineup !== selectionLineup)');
    expect(homeScript).toContain('buildGameCard(impact)');
    expect(homeScript).toContain('gameCards.querySelector<HTMLElement>');
    const cardUpdater = /function renderGameCards\(station: PublicStation\)[\s\S]*?\n}/.exec(homeScript)?.[0] ?? '';
    expect(cardUpdater.match(/replaceChildren/g)).toHaveLength(1);
    expect(homeScript).toContain('data-src="${preview}"');
    expect(homeScript).toContain('preload="none"');
    expect(homeScript).toContain('game-media-fallback');
    expect(homeScript).toContain("?.addEventListener(\n    'error'");
    expect(homeCss).toContain('.game-command strong');
    expect(homeCss).toMatch(/@media \(max-width:600px\)[\s\S]*?\.game-card \{/);
  });

  it('offers every phase-sensitive station transition with playable games only', () => {
    for (const id of [
      'close-recruiting', 'select-station-game', 'request-launch',
      'fail-launch', 'emergency-complete', 'advance-results', 'hold-results', 'open-station-reset',
    ]) expect(html).toContain(`id="${id}"`);
    for (const route of [
      '/api/admin/arcade/station/recruiting/close',
      '/api/admin/arcade/station/game/select',
      '/api/admin/arcade/station/launch/request',
      '/api/admin/arcade/station/launch/fail',
      '/api/admin/arcade/station/match/complete',
      '/api/admin/arcade/station/results/advance',
      '/api/admin/arcade/station/results/hold',
      '/api/admin/arcade/station/reset',
    ]) expect(script).toContain(route);
    expect(stationGameSelect).toContain('value="racer"');
    expect(stationGameSelect).toContain('value="monsters"');
    expect(stationGameSelect).toContain('value="fighter"');
    expect(stationGameSelect).toContain('value="karaoke"');
    expect(stationGameSelect).toContain('value="trivia"');
    expect(script).toContain("show('recruiting-control',!paused&&phase==='RECRUITING')");
    expect(script).toContain("show('selection-control',!paused&&phase==='GAME_SELECTION')");
    expect(script).toContain("show('playing-control',!paused&&phase==='PLAYING')");
    expect(script).toContain("show('results-control',!paused&&phase==='RESULTS')");
    expect(html).toContain('End game + disconnect calls');
    expect(script).toContain('End the live game and disconnect all player calls now?');
  });

  it('keeps emergency reset in one clear confirmation dialog', () => {
    for (const id of [
      'reset-control', 'station-reset-dialog', 'station-reset-form', 'confirm-station-reset',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('RESET EVENT');
    expect(html).not.toContain('station-reset-reason');
    expect(html.indexOf('id="operations"')).toBeLessThan(html.indexOf('id="reset-control"'));
    expect(script).toContain("show('reset-control',actionable)");
    expect(script).toContain("state.operatorStation?.station.phase==='ATTRACT'");
    expect(script).toContain("stationAction('reset')");
    expect(script).toContain('if(stationActionSaving)return');
    expect(script).toContain('stationResetIdempotencyKey??=crypto.randomUUID()');
    expect(script).toContain('stationResetEtag??=state.operatorStationEtag');
    expect(script).toMatch(/function cancelStationReset\(\):void\{\s*if\(stationActionSaving\)return;/);
    expect(css).toContain('.reset-danger-zone{');
    expect(css).toContain('.reset-dialog::backdrop{');
  });

  it('uses automatic audit reasons, station ETags, idempotency, and conflict refresh for transitions', () => {
    expect(script).toContain("response.headers.get('ETag')");
    expect(script).toContain('stationAuditReason(action,game)');
    expect(script).toContain("'Operator closed results and continued'");
    expect(script).toContain("'If-Match':state.operatorStationEtag");
    expect(script).toContain("'Idempotency-Key':crypto.randomUUID()");
    expect(script).toContain('error.status===412');
    expect(script).toContain('await refreshOperatorStation()');
    expect(script).toContain('The event changed before this action finished.');
    expect(script).toContain("const body=action==='select'?{game,reason}:{reason}");
    expect(script).not.toContain('authorization:');
    expect(html).not.toMatch(/name="(?:stationId|roundId|matchId|readyEntryId|authorization)"/);
  });

  it('refreshes the station over SSE with a polling fallback', () => {
    expect(script).toContain("new EventSource('/api/arcade/events')");
    expect(script).toContain("addEventListener('arcade_station_updated'");
    expect(script).toContain('startOperatorPolling()');
    expect(script).toContain('setInterval(');
    expect(script).toContain(',5000)');
    expect(script).toContain('refreshOperatorStation(),refreshOperatorConfiguration()');
    expect(script).toContain("error instanceof ApiError&&error.status===412");
  });

  it('keeps local browser traffic same-origin through Vite', () => {
    expect(vite).toContain("'/api':");
    expect(vite).toContain('GAME_SERVER_EXPECTED_ORIGIN');
    expect(vite).toContain('forwardedGameServerOrigin(origin, request.headers.host, expectedGameServerOrigin)');
    expect(vite).toContain("proxyRequest.setHeader('origin', forwardedOrigin)");
    expect(packageJson.scripts['dev:arcade:client']).toContain('GAME_SERVER_EXPECTED_ORIGIN=http://localhost:5173');
    expect(vite).toContain("'/auth':");
    expect(vite).toContain("'/karaoke':");
    expect(vite).toContain("karaoke: resolve(__dirname, 'karaoke.html')");
    expect(vite).toContain("arcade: resolve(__dirname, 'arcade/index.html')");
    expect(vite).toContain("url === '/arcade'");
    expect(vite).toContain("url === '/operator'");
    expect(vite).toContain("url === '/player'");
  });

  it('uses Twilio typography, theme tokens, and a persistent theme toggle', () => {
    expect(css).toContain("font-family:'Twilio Sans Display'");
    expect(css).toContain('--th-bg:#000D25');
    expect(css).toContain('--red:#EF223A');
    expect(html).toContain('src="/theme-init.js"');
    expect(script).toContain('wireThemeToggle');
    expect(css).not.toMatch(/purple|amber|emerald|green|orange|yellow/i);
    expect(script).not.toContain('selectedOperatorEntries');
    expect(script).not.toContain('/api/admin/arcade/queue');
  });

  it('uses compact header controls and exposes the authenticated operator from home', () => {
    expect(home).toContain('id="operatorLink"');
    expect(home).toContain('href="/operator"');
    expect(home).toMatch(/id="themeToggle"[^>]*>[\s\S]*?<svg/);
    expect(join).toMatch(/id="themeToggle"[^>]*>[\s\S]*?<svg/);
    expect(html).toContain('class="button quiet icon-button"');
    expect(html).toMatch(/id="refresh"[^>]*icon-button[^>]*aria-label="Refresh page data"[^>]*>\s*<svg/);
    expect(html).toContain('id="operator-logout"');
    expect(script).toContain("location.replace('/analytics?auth=session_expired&returnTo=%2Foperator')");
    expect(serverIndex).toContain('analyticsAuth.currentOperatorUser(request)');
    expect(serverIndex).toContain("operatorAuthRequired ? null : { email: 'operator-console@local.invalid' }");
    expect(serverIndex).not.toContain('ARCADE_ADMIN_EMAILS');
    expect(css).toContain('white-space:normal');
    expect(script).toContain("refresh.setAttribute('aria-label','Atualizar dados')");
    expect(script).not.toContain("el('refresh').textContent='Atualizar'");
    expect(css).toMatch(/@media\(max-width:560px\)[\s\S]*?\.top-actions\{width:100%;justify-content:flex-start}/);
    expect(css).toContain('.top-actions #view-link{flex:1 1 auto');
    expect(iconControls).toContain('updateThemeToggleIcon');
    expect(musicToggle).not.toContain("className = 'music-toggle-label'");
    expect(musicToggle).toContain("btn.setAttribute('aria-label', label)");
  });

  it('separates player/operator views and renders the persistent join QR', () => {
    expect(script).not.toContain("get('operator') === '1'");
    expect(script).toContain("location.pathname === '/operator'");
    expect(html).toContain('href="/operator"');
    expect(html).toContain('TWILIO GAMES');
    expect(html).not.toMatch(/TWILIO ARCADE|ARCADE COINS/);
    expect(joinScript).toContain('`/player?cabinet=');
    expect(script).toContain('effectivePublicVisitorBaseUrl(state.deployment?.publicBaseUrl)');
    expect(script).toContain("selectedMode!=='off'&&!Object.values(station.games).some");
    expect(script).toContain("state.config?.arcade.mode==='coin_only'");
    expect(html).toContain('id="player-qr"');
    expect(html).toContain('id="sms-status"');
    expect(html).toContain('id="whatsapp-status"');
    for (const value of ['per_player', 'free']) {
      expect(html).toContain(`option value="${value}"`);
    }
    expect(html).not.toContain('option value="per_match"');
    expect(html).not.toContain('option value="host_sponsors"');
    expect(html).toContain('id="admin-starting-coins"');
    expect(html).toMatch(/id="admin-starting-coins"[^>]*min="1"[^>]*max="100"/);
    expect(html).toContain('One coin per player');
    expect(script).toContain("const minimumBalance=chargePolicy==='free'?0:1");
    expect(script).toContain("chargePolicy==='free'?0:startingBalance");
    expect(script).toContain('renderRuntimeSummary');
    expect(script).toContain("voiceNumbers={'en-US':voiceEn||null,'pt-BR':voicePt||null}");
    expect(racerMain).toContain('stationQrAsset(locale,cfg.arcade.cabinetId,base)');
    expect(racerMain).toContain('stationDisplay.active || cfg.arcade?.mode === \'off\'');
    expect(racerScreens).toContain('screen.lobby.coinQrCaption');
  });

  it('uses a semantic operator information architecture with linked live summaries', () => {
    expect(html).toContain('<main id="operations"');
    const consoleMarkup = /<div id="admin-console"[\s\S]*?<\/main>/.exec(html)?.[0] ?? '';
    for (const [label, target] of [
      ['Overview', 'operator-overview'],
      ['Live event', 'live-event'],
      ['Messages', 'messages'],
      ['Setup', 'setup'],
    ]) expect(consoleMarkup).toMatch(new RegExp(`<button[^>]+role="tab"[^>]+aria-controls="${target}"[^>]*>${label}</button>`));
    expect(consoleMarkup).toContain('role="tablist"');
    expect(consoleMarkup.match(/role="tabpanel"/g)).toHaveLength(4);
    expect(consoleMarkup.match(/role="tab"/g)).toHaveLength(4);
    expect(consoleMarkup).toMatch(/id="operator-overview"[^>]*role="tabpanel"(?![^>]*hidden)/);
    for (const id of ['live-event','messages','setup']) expect(consoleMarkup).toMatch(new RegExp(`id="${id}"[^>]*role="tabpanel"[^>]*hidden`));
    const sectionPositions = ['operator-overview', 'live-event', 'messages', 'setup'].map(id => consoleMarkup.indexOf(`id="${id}"`));
    expect(sectionPositions).toEqual([...sectionPositions].sort((left, right) => left - right));
    for (const label of ['Event', 'Live game', 'Players', 'Messaging']) {
      expect(consoleMarkup).toContain(`<span>${label}</span>`);
    }
    expect(script).toContain('function renderOperatorOverview():void');
    expect(script).toContain("!station?'Waiting for players'");
    expect(script).toContain("entry.status!=='LEFT'");
    expect(script).toContain('messaging?.counts.FAILED??0');
    expect(script).toMatch(/function renderRuntimeSummary\([\s\S]*?renderOperatorOverview\(\);\s*}/);
    expect(script).toMatch(/function renderOperatorStation\([\s\S]*?renderOperatorOverview\(\);\s*}/);
    expect(script).toMatch(/function renderMessagingStatus\([\s\S]*?renderOperatorOverview\(\);/);
    expect(script).toContain('function initializeOperatorTabs():void');
    expect(script).toContain("event.key==='ArrowRight'");
    expect(script).toContain("event.key==='ArrowLeft'");
    expect(script).toContain("event.key==='Home'");
    expect(script).toContain("event.key==='End'");
    expect(script).toContain("window.addEventListener('popstate'");
    expect(script).toContain("window.addEventListener('hashchange'");
    expect(script).toContain("tab.setAttribute('aria-selected',String(active))");
    expect(script.indexOf('const OPERATOR_TABS')).toBeLessThan(script.indexOf('initializeOperatorTabs();'));
    expect(css).toContain('.operator-page .shell{width:min(1200px');
    expect(css).toContain('.operator-nav{position:sticky');
    expect(css).toContain('.operator-page .notice{position:static');
    expect(css).toContain('overflow-x:auto');
    expect(css).toContain('.operator-nav button[aria-selected="true"]');
    expect(css).toContain('.operator-section:focus-visible');
    expect(css).toContain('.overview-grid{display:grid;grid-template-columns:repeat(auto-fit');
    expect(css).toContain('@media(max-width:999px){.operator-page .overview-grid{grid-template-columns:repeat(2');
    expect(css).toContain('.operator-page .overview-grid{grid-template-columns:1fr}');
    const operatorReordering = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(match => match[1]?.includes('.operator-page') && /(?:^|;)\s*order\s*:/.test(match[2] ?? ''));
    expect(operatorReordering).toEqual([]);
  });

  it('keeps secondary operator tools collapsed and primary operations visible', () => {
    expect(html).toMatch(/<details class="operator-details station-activity-details">\s*<summary>Recent activity<\/summary>/);
    expect(html).toMatch(/<details class="operator-details messaging-details">\s*<summary>Delivery metrics<\/summary>/);
    expect(html).toMatch(/<details class="advanced-settings">\s*<summary>Timing<\/summary>/);
    expect(html).toMatch(/<details id="admin-challenge-panel"[^>]*setup-details/);
    expect(html).toMatch(/<details class="panel compact qr-operator-panel setup-details">/);
    expect(html).toMatch(/id="operator-overview"[\s\S]*id="display-connect-panel"[\s\S]*id="live-event"/);
    for (const id of ['station-phase', 'station-controls', 'station-ready', 'messaging-failure-list']) {
      const beforeControl = html.slice(0, html.indexOf(`id="${id}"`));
      expect(beforeControl.lastIndexOf('<details')).toBeLessThanOrEqual(beforeControl.lastIndexOf('</details>'));
    }
    expect(html).toMatch(/id="settings-savebar" class="settings-savebar" hidden/);
    expect(script).toContain("el('settings-savebar').hidden=!dirty");
    expect(script).toContain("el('voice-number-fields').hidden=!voice");
    expect(script).toContain('refreshOperatorConfiguration(true)');
    expect(css).toContain('.settings-savebar{position:sticky');
    expect(css).toContain('.operator-page .settings-savebar{position:static');
    expect(css).toContain('.settings-layout{display:grid;grid-template-columns:repeat(2');
    expect(css).toContain('.operator-page .challenge-form{grid-template-columns:repeat(2');
  });

  it('exposes Trivia as the fifth playable game and retires its coming-soon control', () => {
    expect(html).toContain('id="admin-game-karaoke"');
    expect(html).toContain('id="admin-game-trivia"');
    expect(html).toMatch(/data-game-choice="karaoke"><span>4<\/span><b>Voice Karaoke<\/b>/);
    expect(html).toMatch(/data-game-choice="trivia"><span>5<\/span><b>Voice Trivia<\/b>/);
    expect(html).not.toContain('admin-coming-soon-trivia');
    expect(html).not.toContain('coming-soon-concepts');
    expect(stationGameSelect).toContain('Voice Karaoke · 1 player');
    expect(stationGameSelect).toContain('Voice Trivia · up to 4');
    expect(script).toContain('station.comingSoon.trivia.enabled=false');
    expect(script).not.toContain('const HOME_CONCEPTS');
    expect(script).not.toContain('admin-coming-soon-karaoke');
    expect(html).toContain('id="admin-console"');
    expect(homeScript).toContain('isPlayableArcadeGame(entry[0]) && entry[1].enabled');
    expect(homeScript).toContain('.filter(impact => enabledGames.has(impact.id))');
  });

  it('offers Voice Chess as choice 6 and an operator game without a leaderboard', () => {
    expect(html).toMatch(/data-game-choice="chess"><span>6<\/span><b>Voice Chess<\/b>/);
    expect(stationGameSelect).toContain('<option value="chess">Voice Chess · 1 player</option>');
    expect(html).toContain('id="admin-game-chess"');
    const prioritySelects = [...html.matchAll(/<select id="admin-game-priority-[1-6]"[^>]*>[\s\S]*?<\/select>/g)]
      .map(match => match[0]);
    expect(prioritySelects).toHaveLength(6);
    for (const select of prioritySelects) expect(select).toContain('<option value="chess">Voice Chess</option>');
    const leaderboardSelect = /<select id="leaderboard-reset-game">[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
    expect(leaderboardSelect).not.toContain('value="chess"');
  });

  it('renders aggregate vote counts and allows a capacity-one no-show replacement', () => {
    expect(script).toContain('voteCounts:Array<{game:PlayableGame;count:number}>');
    expect(script).toContain("['Votes',formatVoteCounts(view.voteCounts)]");
    expect(script).toContain('(view?.match?.overflowReadyEntryIds.length??0)>0');
    expect(script).not.toContain("gameName(game??'racer')");
  });

  it('manages configured challenges through the staff-only versioned config editor', () => {
    expect(html.indexOf('id="admin-console"')).toBeLessThan(html.indexOf('id="admin-challenge-panel"'));
    for (const id of [
      'add-admin-challenge', 'admin-challenge-id', 'admin-challenge-title', 'admin-challenge-url',
      'admin-challenge-message',
      'admin-challenge-reward', 'admin-challenge-claims', 'admin-challenge-enabled',
      'admin-challenge-order', 'admin-challenge-starts', 'admin-challenge-ends',
      'cancel-admin-challenge',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/id="admin-challenge-url"[^>]*type="url"/);
    expect(script).toContain('renderAdminChallenges()');
    expect(script).toContain('(settings.earning as AdminConfig[\'earning\']).challenges=challenges');
    expect(script).toContain('message:message||null');
    expect(script).toContain("message.textContent=challenge.message??'No custom player message.'");
    expect(script).toContain('const saved=await updateConfig(version,settings)');
    expect(html).toContain('Shown on the reward page opened from the MORE/MAIS link.');
    expect(script).toContain("if(challenges.length>0)(settings.postGame as AdminConfig['postGame']).includeChallenges=true");
    expect(script).toContain("method:'PATCH'");
    expect(script).toContain("'If-Match':`\"arcade-config-${version}\"`");
    expect(script).toContain('Challenge settings changed in another operator session.');
    expect(script).toContain("destination.protocol!=='https:'");
    expect(script).not.toMatch(/seedChallenge|voice-docs|Voice Docs/i);
    expect(css).toContain('.challenge-admin-panel{grid-column:1/-1}');
  });

  it('configures zero-balance result messages and challenge discovery', () => {
    for (const id of [
      'admin-post-game-enabled', 'admin-post-game-balance', 'admin-post-game-challenges',
      'admin-post-game-sms', 'admin-post-game-whatsapp',
    ]) expect(html).toContain(`id="${id}"`);
    expect(script).toContain("postGame.includeChallenges=el<HTMLInputElement>('admin-post-game-challenges').checked");
    expect(html).toContain('asks players to reply MORE or MAIS');
  });

  it('reports only the implemented post-game delivery capability', () => {
    expect(html).toContain('<b>Result messages</b>');
    expect(script).toContain("postGame.includeCoinBalance?' with coin balance':''");
    expect(html).not.toMatch(/includeScore|includeLeaderboard|includeRematchLink|includeAchievement|includeIntelligenceTip/);
  });

  it('separates onboarding from proactive messaging and exposes reasoned retries', () => {
    for (const id of [
      'messaging-effective', 'messaging-onboarding-sms', 'messaging-onboarding-whatsapp',
      'messaging-identities', 'messaging-capacity', 'messaging-drafts', 'messaging-cleanup',
      'messaging-outbound-sms', 'messaging-outbound-whatsapp', 'messaging-last-error',
      'messaging-counts', 'messaging-failure-list',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('See which channels players can use and whether game updates are being delivered.');
    expect(script).toContain("api<AdminStatus>('/api/admin/arcade/status')");
    expect(script).toContain('messaging?.storage?.cleanupEligible');
    expect(script).toContain('failure.retryEligible');
    expect(script).toContain("requestOperatorReason('Try this message again'");
    expect(script).toContain('/api/admin/arcade/messaging/notifications/${encodeURIComponent(failure.notificationId)}/retry');
    expect(script).toContain("'Idempotency-Key':crypto.randomUUID()");
    expect(script).toContain('operatorMessagingPoll=window.setInterval');
    expect(css).toContain('.messaging-panel{grid-column:1/-1');
  });

  it('offers a destructive fresh-start reset only for safe test-player states', () => {
    expect(script).toContain("['READY','OVERFLOW','COMPLETED'].includes(entry.status)");
    expect(script).toContain('reset.textContent=resetPlayerLabel()');
    expect(script).toContain('reason:`Operator reset ${entry.displayName} from live roster`');
    expect(script).toContain('/reset-test-player`');
    expect(script).toContain("'If-Match':state.operatorStationEtag");
    expect(script).toContain('window.confirm(`Reset ${entry.displayName}?');
  });

  it('shows an all-mode player directory with independent restore and full-reset actions', () => {
    for (const id of ['player-recovery-panel','player-recovery-count','player-recovery-list','load-more-players']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(script).toContain('`/api/admin/arcade/players?limit=100');
    expect(script).toContain('/restore-starting-balance`');
    expect(script).toContain("'If-Match':`\"arcade-config-${page.configVersion}\"`");
    expect(script).toContain("reason:'Operator restored configured starting balance'");
    expect(html).toContain('Player directory');
    expect(script).toContain("reset.textContent='Reset everything'");
    expect(script).toContain('/reset`,{');
    expect(script).toContain('player.canRestoreStartingBalance');
    expect(script).toContain('player.canReset');
    expect(script).not.toContain('restore-starting-balance`,{amount');
  });

  it('puts the current booth action on the default operator overview', () => {
    for(const id of ['overview-current-action','overview-action-title','overview-action-description','overview-action-button'])expect(html).toContain(`id="${id}"`);
    expect(script).toContain("phase==='RECRUITING'");
    expect(script).toContain("label:'Choose game now'");
    expect(script).toContain("label:'Continue now'");
    expect(script).toContain("label:'Hold results'");
    expect(script).toContain("title:'Results are held'");
    expect(script).toContain("actionButton.dataset.stationAction=!paused&&phase==='RESULTS'");
    expect(script).toContain("button.dataset.stationAction==='hold'");
  });

  it('shows a one-shot arcade coin insertion cue on home and active game displays', () => {
    expect(homeScript).toContain('createCoinInsertionPresenter');
    expect(stationDisplay).toContain('createCoinInsertionPresenter');
    expect(stationClient).toContain("source.addEventListener('arcade_ready_entry_added'");
    expect(coinInsertion).toContain("event.admission==='coin'?'COIN ACCEPTED':'READY CONFIRMED'");
    expect(coinInsertion).not.toMatch(/new Audio|\.play\(|AudioContext/);
    expect(coinInsertionCss).toContain('@keyframes coin-drop');
    expect(coinInsertionCss).toContain('@media(prefers-reduced-motion:reduce)');
  });

  it('does not wire browser speech synthesis into the Voice Racer display', () => {
    expect(racerMain).toContain('new Announcer({ sink: null');
    expect(racerMain).not.toContain('browserSpeechSink');
  });

  it('keeps kiosk authorization out of navigation URLs and disables local station players', () => {
    expect(stationClient).toContain("fragment.has('displayToken')");
    expect(stationClient).toContain("fragment.delete('displayToken')");
    expect(stationClient).toContain("history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)");
    expect(stationClient).not.toContain("fragment.get('displayToken')");
    expect(stationClient).not.toContain("url.searchParams.get('displayToken')");
    expect(stationClient).not.toContain("url.searchParams.set('displayToken'");
    expect(stationDisplay).not.toContain("homeUrl.searchParams.set('displayToken'");
    expect(stationDisplay).toContain("!['LAUNCHING', 'PLAYING', 'RESULTS'].includes(latest.station.phase)");
    expect(stationDisplay).toContain("latest.station.phase === 'RESULTS'");
    expect(stationDisplay).toContain("if(latest.station.phase==='RESULTS'&&!engineResultsReady)");
    expect(stationDisplay).toContain('Detailed results were unavailable after recovery.');
    expect(racerMain).toContain('stationDisplay.markEngineResultsReady()');
    expect(homeScript).not.toContain("url.searchParams.set('displayToken'");
    expect(fighter).not.toContain("params.get('hostToken')");
    expect(fighter).toContain("pageUrl.searchParams.delete('hostToken')");
    expect(racerMain).toContain('isDisplay && !stationDisplay.active');
    expect(racerMain).toContain('locale, stationDisplay.active');
    expect(racerMain).toContain("/game${isDisplay?'?display=1':''}");
    expect(racerScreens).toContain("this.stationManaged ? 'station' : 'standalone'");
    expect(racerScreens).toContain("screen.lobby.stationTitle");
    expect(racerScreens).toContain("this.stationManaged?'screen.results.stationFooter':'screen.results.againFooter'");
    expect(monsters).toContain('!isDisplay || stationDisplay.active');
    expect(monsters).toContain('if (stationDisplay.active) {');
    expect(monsters).toContain('stationDisplay.active\n    ? `<div class="vm-station-call"');
    expect(monsters).toContain("/battle${isDisplay?'?display=1':''}");
    expect(fighter).toContain('if (stationDisplay.active) return');
    expect(fighter).toContain('stationDisplay.active\n      ? `<div class="station-call-card"');
    expect(fighter).toContain('rematch.hidden = stationDisplay.active');
    expect(fighter).toContain("/fighter${isDisplay?'?display=1':''}");
    expect(stationDisplay).not.toContain('if (rail.root.hidden === !visible) return');
    expect(stationDisplay).toContain("latest?.station.phase==='PLAYING'||latest?.station.phase==='RESULTS'");
    expect(stationDisplay).not.toContain('next round automatic');
    expect(stationDisplayCss).toContain('.station-rail[hidden] { display:none !important; }');
    expect(racerMain).toContain('watchVoiceNumber(locale');
    expect(monsters).toContain('watchVoiceNumber(locale');
    expect(fighter).toContain('watchVoiceNumber(locale');
    expect(racerMain).toContain('QRCode.toDataURL(`tel:${number}`');
    expect(monsters).toContain('QRCode.toDataURL(`tel:${number}`');
    expect(fighter).toContain('QRCode.toDataURL(`tel:${number}`');
    expect(racerScreens).toContain('/brand/join-qr.png?v=2');
    expect(monsters).toContain("phoneQr = '/brand/join-qr.png?v=2'");
    expect(fighter).toContain("phoneQr = '/brand/join-qr.png?v=2'");
  });

  it('directs missing and rejected displays to the secure operator flow without a credential form', () => {
    for (const id of ['displaySetupPanel','displaySetupOperator']) expect(home).toContain(`id="${id}"`);
    expect(home).toContain('Only the booth display may launch shared games.');
    expect(home).toMatch(/id="displaySetupOperator" href="\/operator"/);
    expect(home).not.toContain('displayTokenInput');
    expect(home).not.toContain('type="password"');
    expect(home).not.toMatch(/<form id="displaySetupPanel"/);
    expect(homeScript).toContain("showDisplaySetup(displayTokenRejected ? 'invalid' : 'missing')");
    expect(homeScript).toContain('rejectDisplayToken(displayToken)');
    expect(homeScript).toContain('displayToken = null');
    expect(homeScript).toContain('!displayToken && displayTokenWasRejected()');
    expect(homeScript).not.toContain('configureDisplay');
    expect(homeScript).not.toContain('storeDisplayToken');
    expect(homeScript).toContain("current.phase === 'LOCKED'");
    expect(homeScript).not.toContain("lockedCountdown.textContent = current?.phase === 'RESULTS' ? String(current.nextReadyCount) : '10'");
    expect(homeScript).toMatch(/station\.phase === 'RESULTS'[\s\S]*?show\('recruiting'\)/);
    expect(homeScript).not.toContain('lockedGame.textContent = copy.gameComplete');
    expect(homeCss).toContain('.display-setup-panel');
  });

  it('installs and confirms booth access independently from the operator session', () => {
    expect(html).toContain('id="display-connect-panel"');
    expect(html).toContain('id="connect-booth-display"');
    expect(html).toMatch(/href="\/analytics"[^>]*>View analytics<\/a>/);
    expect(html).toContain('id="overview-display"');
    expect(script).toContain("config&&config.arcade.mode!=='off'&&display?.configured&&!displayConnected&&!display.checking");
    expect(script).toContain("show('display-connect-panel',pairingRequired)");
    expect(script).toContain('function isDisplayConnected(');
    expect(html).toContain('id="overview-display-card"');
    expect(html).toContain('Pair this tab as the big screen');
    expect(html).toContain('Pair a dedicated big screen');
    expect(html).not.toContain('sign in with Google');
    expect(html).not.toContain('Google session');
    const flow = /async function connectBoothDisplay\(\):Promise<void>\{[\s\S]*?\n}/.exec(script)?.[0] ?? '';
    expect(flow).toContain("'/api/admin/arcade/display/connect'");
    expect(flow).toContain("'Content-Type':'application/json'");
    expect(flow).toContain("body:'{}'");
    expect(flow).toContain("keys.length!==1||keys[0]!=='displayToken'");
    expect(flow).toContain('new TextEncoder().encode(token).byteLength<16');
    expect(flow).toContain('storeDisplayToken(token)');
    expect(flow).toContain('await fetchPublicStation(token)');
    expect(flow).toContain("location.replace('/')");
    expect(flow).toContain('rejectDisplayToken(installedToken)');
    expect(flow.indexOf('storeDisplayToken(token)')).toBeLessThan(flow.indexOf('fetchPublicStation(token)'));
    expect(flow.indexOf('fetchPublicStation(token)')).toBeLessThan(flow.indexOf("location.replace('/')"));
    expect(flow).not.toContain("fetch('/auth/logout'");
    expect(flow).not.toContain('searchParams');
    expect(flow).not.toContain('console.');
  });

  it('returns a launched display home after GET or readiness authorization is rejected', () => {
    expect(stationDisplay).toContain('rejectDisplayToken(displayToken)');
    expect(stationDisplay).toContain('cause instanceof StationRequestError && [401, 403].includes(cause.status)');
    expect(stationDisplay).toContain('if (authorizationRejected) return');
    expect(stationDisplay).toContain('authorizationRejected = true');
    expect(stationDisplay).toContain('unsubscribe()');
    expect(stationDisplay).toContain('clearInterval(polling)');
    expect(stationDisplay).toContain('location.replace(homeUrl.toString())');
    const readiness = /async function acknowledge\([\s\S]*?\n}/.exec(stationDisplay)?.[0] ?? '';
    expect(readiness).toContain('throw new StationRequestError(response.status)');
  });

  it('makes lead capture mode and collected fields explicit while keeping entry cost separate', () => {
    expect(html).toContain('Standalone play - choose and call');
    expect(html).toContain('Messaging entry - first name only');
    expect(html).toContain('Lead capture entry - full registration');
    expect(html).toContain('id="lead-capture-summary"');
    expect(html).toContain('>Entry cost<');
    expect(script).toContain('Browser entry collects first and last name, work email, company, phone number, country or region');
    expect(script).toContain('terms acknowledgement when required, and optional marketing consent');
    expect(script).toContain('Messaging entry uses the sender phone and asks for first and last name, work email, company, and country or region');
    expect(script).toContain('It asks for terms only when required and never asks for marketing consent');
    expect(html).toContain('<summary>Information collected</summary>');
    expect(script).toContain('termsAcknowledgementRequired');
    expect(script).toContain('Messaging entry collects first name only');
    expect(script).toContain('First name is collected for the game display. No lead form is created');
    expect(script).toContain('Standalone play skips messaging entry and lead capture');
    expect(script).toContain("output.textContent='Standalone'");
    expect(script).toContain('Standalone play is active. This previous event queue is preserved until you reset it.');
    expect(script).toContain("state.adminConfig?.arcade.mode!=='off'&&entry.status==='ADMITTED'");
    expect(html).toContain('id="settings-open-blocker"');
    expect(html).toContain('Changing the player journey resets the active event flow.');
    expect(script).toContain("state.adminConfig?.arcade.mode!==modeSelect.value");
    expect(script).toContain("error.code==='ACTIVE_STATION_CONFIG_LOCKED'");
    expect(script).toContain('config.arcade.mode!==selectedMode');
    expect(script).toContain('await queueOpenAfterReset(version,settings,selectedMode)');
    expect(script).toContain('await saveOpenAfterReset(openSettings)');
    expect(script).toContain("openSettings.mode==='off'?'Previous queue reset. Standalone play is active.'");
    expect(script).toContain('The live messaging event is using these settings. Switch to Standalone play before changing them');
    expect(script).toContain('A previous event queue is still preserved. Reset it from Live event before changing these settings');
    expect(script).toContain('Settings were saved, but the console could not reload them.');
    expect(script).toContain("refreshAll(false)");
  });

  it('localizes Portuguese browser registration and protects newer operator state', () => {
    expect(script).toContain("document.documentElement.lang='pt-BR'");
    expect(script).toContain('Tudo pronto');
    expect(script).toContain('state.operatorStation&&(!view||');
    expect(script).toContain("ATTRACT:'Waiting for players'");
  });

  it('explains standalone play in the localized player panel', () => {
    expect(script).toContain("renderPlayer();startPlayerUpdates();setNotice('')");
    expect(script).toContain("playerText('Open a lobby on the big screen, scan its call QR, and start playing.'");
    expect(html).toContain('Open a game lobby, scan its call QR, and use your voice as the controller.');
    expect(script).toContain("'Abra a sala do jogo, escaneie o QR da ligação e use sua voz como controle.'");
    expect(css).toContain('.notice:empty{display:none}');
  });

  it('keeps player copy simple and groups operator settings by task', () => {
    for (const phrase of ['HttpOnly', 'lead PII', 'Coin ledger', 'ready pool', "cabinet's"]) {
      expect(html).not.toContain(phrase);
    }
    expect(html).toContain("Tell us who's playing");
    expect(html).toContain('Join the next game');
    for (const heading of ['Event', 'Ways to join and play', 'Games shown on the home screen', 'Timing']) {
      expect(html).toContain(`>${heading}<`);
    }
    expect(css).toContain('.settings-layout{display:grid;grid-template-columns:repeat(2');
    expect(css).toContain('.choice-card:has(input:checked)');
    expect(script).toContain("document.body.classList.add(operatorView?'operator-page':'player-page')");
    expect(script).toContain("config.arcade.mode==='off'&&selectedMode!=='off'&&!postGame.enabled");
    expect(script).toContain('postGame.enabled=postGame.channels.length>0');
    expect(joinScript).toContain('link.className = `channel channel--${kind}`');
    expect(joinScript).not.toContain('messageCommandPanel');
    expect(joinScript).not.toContain('available.length === 0');
    expect(joinCss).not.toContain('.channel.primary');
    expect(joinCss).toContain('.channel:focus-visible');
    expect(joinCss).toContain('box-shadow:var(--action-shadow)');
    expect(joinCss).toContain('.channel:active{transform:translateY(5px)');
    expect(joinCss).toContain('.channel--browser{--channel-accent:var(--muted)');
    expect(joinCss).toContain('background:transparent;box-shadow:none');
    expect(joinCss).toContain('.channel-fallback-label');
  });

  it('provides a guarded, game-neutral operator control for persistent scores', () => {
    expect(html).toContain('id="leaderboard-reset-panel"');
    expect(html).toContain('Persistent game leaderboards can be reset here.');
    expect(html).toContain('<label>Leaderboard<select id="leaderboard-reset-map">');
    expect(script).toContain("request<LeaderboardAdminSummary>('/api/admin/arcade/leaderboards')");
    expect(script).toContain("'If-Match':state.leaderboardEtag");
    expect(script).toContain('does not store persistent scores, so there is nothing to reset');
    expect(script).toContain('This cannot be undone.');
    expect(html).toContain('<option value="karaoke">Voice Karaoke</option>');
    expect(html).toContain('<option value="trivia">Voice Trivia</option>');
    expect(script).toContain('payload.games.find(item=>item.game===game)??{game,resettable:false,maps:[]}');
  });

  it('renders all six priority positions and score-based station fallback results', () => {
    const prioritySelects = [...html.matchAll(/<select id="admin-game-priority-[1-6]"[^>]*>[\s\S]*?<\/select>/g)].map(match => match[0]);
    expect(prioritySelects).toHaveLength(6);
    for (const select of prioritySelects) expect(select).toContain('<option value="trivia">Voice Trivia</option>');
    expect(stationDisplay).toContain('result.score!==null');
    expect(stationDisplay).toContain('result.score.toLocaleString(locale)');
    expect(stationDisplay).toContain("className='station-result-metric'");
    expect(stationDisplayCss).toContain('.station-result-metric{font-family:');
  });

  it('shows and saves the six-game display order under every selection policy', () => {
    expect(html).toContain('id="selection-policy-field"');
    expect(html).toContain('id="game-order-label"');
    expect(html).toContain('id="game-order-help"');
    expect(html).toContain('id="priority-order-field" class="priority-order-field"><span');
    expect(script).toContain("el('priority-order-field').hidden=false");
    expect(script).toContain("standalone?'Standalone display order':fixedPriority?'Priority order':'Display order'");
    expect(script).toContain("if(!validOrder){setNotice('Choose each game once in the display order.','error');return;}");
    expect(script).toContain('swapPriorityOrder');
  });

  it('advertises the coin emoji and plays selection cues for committed choices', () => {
    expect(homeScript).toContain('reply COIN or 🪙');
    expect(homeScript).toContain('responda MOEDA ou 🪙');
    expect(homeScript).toContain('getSoundEffectsManager().playSelect()');
    expect(script).toContain('getSoundEffectsManager().playSelect()');
    expect(coinInsertion).toContain('getSoundEffectsManager().playSelect()');
  });

  it('describes Racer setup as caller-advanced and other games as automatic', () => {
    const racerCopy=readFileSync(new URL('../shared/i18n/racer.ts',import.meta.url),'utf8');
    const monstersCopy=readFileSync(new URL('../shared/i18n/monsters.ts',import.meta.url),'utf8');
    expect(racerCopy).toContain("'voice.helpCar': 'Choose your own car");
    expect(racerCopy).toContain('After every racer votes, either racer can say start.');
    expect(monstersCopy).toContain("'voice.helpSelect': 'Choose your own monster");
    expect(monstersCopy).toContain("'voice.resumeLobbyNamed': 'You are back, {name}. Waiting for the other player.'");
  });

  it('offers Portuguese WhatsApp and lead-capture browser entry while excluding SMS',()=>{
    expect(joinScript).toContain('const sms = !portuguese && arcade.channels.sms && Boolean(smsNumber)');
    expect(joinScript).toContain("if (mode === 'lead_capture')");
    expect(joinScript).toContain("portuguese ? 'Continuar no navegador' : 'Continue in browser'");
    expect(homeScript).toContain("smsAvailable = locale !== 'pt-BR' && config.channels.sms");
    expect(homeScript).toContain('WhatsApp recomendado · navegador como alternativa');
    expect(homeScript).toContain("leadCaptureMode = config.arcade.mode === 'lead_capture'");
    expect(stationDisplay).toContain('Entre pelo WhatsApp e responda <b>MOEDA</b>');
    expect(stationDisplay).toContain('WhatsApp recomendado · navegador como alternativa após escanear.');
  });
});
