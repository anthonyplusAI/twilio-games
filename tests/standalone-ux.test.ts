import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const readClient = (path: string) => readFileSync(new URL(`../client/${path}`, import.meta.url), 'utf8');

describe('standalone and station display UX', () => {
  it('presents station game selection as a player vote with automatic fallback', () => {
    const home = readClient('home.ts');
    const css = readClient('home.css');
    expect(home).toContain("selectionEyebrow: 'Player choice'");
    expect(home).toContain("selectionTitle: 'Choose the next game.'");
    expect(home).toContain('If time runs out or votes tie, the station chooses automatically.');
    expect(home).not.toContain("classList.toggle('focused'");
    expect(css).not.toContain('.game-card.focused');
  });

  it('does not require station pairing for the standalone launcher', () => {
    const home = readClient('home.ts');
    const fighter = readClient('fighter/fighter.ts');
    const fighterCss = readClient('fighter/fighter.css');
    const trivia = readClient('trivia/trivia.ts');
    const refresh = /async function refresh\(\)[\s\S]*?\n}/.exec(home)?.[0] ?? '';
    expect(refresh.indexOf('if (standaloneMode)')).toBeLessThan(refresh.indexOf('fetchPublicStation(displayToken)'));
    expect(refresh).toMatch(/if \(standaloneMode\) \{[\s\S]*?return;/);
    expect(home).not.toContain('validateStandaloneDisplay()');
    expect(home).toContain('enabledGames = localStandalonePreview || (config.channels.voice');
    expect(home).toContain("config.channels.voice && Boolean(bootstrap.voiceNumbers?.[locale])");
    expect(home).toContain("trivia: '/video/vt-demo.mp4'");
    expect(home).toContain('const url = new URL(game.route, location.origin)');
    expect(fighter).toContain('connection.setDisplayAuth(roomCode, isDisplay ? stationDisplay.displayToken : null)');
    expect(fighter.indexOf("const isDisplay = params.get('display') === '1'")).toBeLessThan(fighter.indexOf('localizeStaticUi();'));
    expect(fighter).not.toContain("params.get('hostToken')");
    expect(fighter).toContain("pageUrl.searchParams.delete('hostToken')");
    expect(fighter).not.toContain("t('lobby.room', { room: roomCode })");
    expect(fighter).toContain('connection.spectate(roomCode');
    const triviaConnect = /function connect\(\): void \{[\s\S]*?\n}/.exec(trivia)?.[0] ?? '';
    expect(triviaConnect).toContain('if (stationLaunchRequested) connection.setDisplayAuth(roomCode, stationDisplay.displayToken)');
    expect(triviaConnect.match(/setDisplayAuth/g)).toHaveLength(1);
    expect(fighterCss).toMatch(/@media \(orientation:portrait\) and \(min-width:721px\) \{[\s\S]*?\.lobby-layout \{ flex:none;grid-template-columns:1fr/);
    expect(fighterCss).toMatch(/@media \(orientation:portrait\) and \(min-width:721px\) \{[\s\S]*?\.select-grid\.fighter-grid \{ grid-template-columns:repeat\(4,minmax\(0,1fr\)\);grid-template-rows:repeat\(3,minmax\(0,1fr\)\)/);
    expect(fighterCss).toContain('.fighter-grid .card-preview { background-size:cover;background-position:center; }');
    expect(fighterCss).toContain('.select-grid.map-grid { grid-template-columns:1fr;grid-template-rows:repeat(5,minmax(0,1fr));overflow:hidden; }');
    expect(fighterCss).toContain('.map-grid .select-card { display:grid;grid-template-columns:minmax(0,68%) minmax(0,32%);');
    expect(fighterCss).toContain('.lobby-panel { position:relative;top:-96px;');
    expect(fighterCss).toContain('margin-bottom:clamp(80px,5vh,104px)');
    expect(fighterCss).toContain('.lobby-layout { flex:none;grid-template-columns:1fr;gap:0;padding:28px;border:1px solid var(--theme-border);border-top:3px solid #ef223a;border-radius:18px;background:var(--vf-panel); }');
    expect(fighterCss).toContain('.qr-card { min-height:280px;padding:0 0 28px;border:0;border-bottom:1px solid var(--theme-border);border-radius:0;background:transparent; }');
    expect(fighter).toContain('const localAction=isDisplay');
    expect(fighter).toContain("isHost||isDisplay ? ''");
    expect(fighter).toContain('`<p class="phone-play-notice">${t(\'lobby.phonePlay\')}</p>`');
    expect(fighter).toContain('function toggleLocalPlayer(): void { if (stationDisplay.active) return;');
    expect(fighter).toContain("key === 'p'");
    expect(fighter).not.toContain("t(playerId ? 'lobby.playingHere' : 'lobby.pressP')");
  });

  it('allows Racer and Monsters menus to scroll in a narrow viewport', () => {
    const racer = readClient('racer.css');
    const monsters = readClient('monsters.css');
    expect(racer).toMatch(/@media \(max-width: 520px\)[\s\S]*?#screens \{[^}]*overflow-y: auto/);
    expect(racer).toContain('grid-template-columns: repeat(2,minmax(0,1fr)) !important');
    expect(monsters).toMatch(/@media \(max-width: 520px\)[\s\S]*?#overlay \{[^}]*overflow-y: auto/);
    expect(monsters).toContain('grid-auto-rows: minmax(150px,auto)');
  });

  it('keeps one shared Racer HUD around two named split-screen views', () => {
    const html = readClient('play.html');
    const script = readClient('main.ts');
    expect(html.match(/class="game-home"/g)).toHaveLength(1);
    expect(html.match(/id="hint"/g)).toHaveLength(1);
    expect(html.match(/id="gauge"/g)).toHaveLength(1);
    expect(html.match(/id="split-name-[12]"/g)).toHaveLength(2);
    expect(script).toContain('renderer.render(snap, { splitScreen })');
    expect(script).toContain('splitNameEls[index]!.textContent = car.name');
  });

  it('keeps a join QR discoverable between recruiting and gameplay', () => {
    const html = readClient('index.html');
    const home = readClient('home.ts');
    const stationDisplay = readClient('station-display.ts');
    expect(html).toContain('id="persistentJoinQr"');
    expect(home).toContain("station.phase==='ATTRACT'||station.phase==='RECRUITING'||station.phase==='RESULTS'");
    expect(home).toContain("station.phase === 'RESULTS' ? station.nextReadyCount : station.currentReadyCount");
    expect(home).toContain("document.getElementById('persistentJoinQr')");
    expect(stationDisplay).toContain("if(railMode==='always')return true");
    expect(stationDisplay).toContain("latest?.station.phase==='LAUNCHING'||latest?.station.phase==='PLAYING'||latest?.station.phase==='RESULTS'");
    expect(stationDisplay).toContain("portuguese ? 'Entrar na próxima partida do Twilio Games'");
    expect(stationDisplay).toContain("portuguese ? 'Código QR para entrar no Twilio Games'");
    expect(stationDisplay).toContain("root.setAttribute('aria-label', railLabel)");
    expect(stationDisplay).toContain('role="img" aria-label="${qrLabel}"');
  });

  it('warms a playable Racer scene before releasing a station countdown, even without optional assets', () => {
    const script = readClient('main.ts');
    expect(script).toContain('loadRaceLevelWithinBudget(mapName, generation)');
    expect(script).toContain('RACER_STATION_SCENE_BUDGET_MS = 24_000');
    expect(script).toContain('RACER_STANDALONE_SCENE_BUDGET_MS = 12_000');
    expect(script).toContain('selectedMapPrefetch.start(');
    expect(script).toContain('conn.join(roomCode, name, true)');
    expect(script).toContain('resetToGeneratedRaceScene()');
    expect(script).toContain('renderer.render(first, { splitScreen })');
    expect(script).toContain('conn.ready()');
    expect(script).toMatch(/conn\.onItems\([\s\S]*?raceSceneReady = false;[\s\S]*?prepareRaceScene\(items, map \?\? urlMap, generation\)/);
    expect(script).toContain('buffer.clear()');
    expect(script).toContain('() => !raceLive');
    expect(script).toContain('cancelPendingRaceSnapshot()');
    expect(script).toMatch(/conn\.onLobby[\s\S]*?if \(raceLive\)[\s\S]*?liftVeil\(\)/);
  });

  it('earns challenge coins from one trusted click after opening the destination', () => {
    const html = readClient('challenge/index.html');
    const script = readClient('challenge/challenge.ts');
    expect(html).toContain('id="challenge-list"');
    expect(script).toContain("history.replaceState(history.state,'',`${location.pathname}${location.search}`)");
    expect(script).toContain("request<PortalStatus>('status')");
    expect(script).toContain("request<{destinationUrl:string}>('visit'");
    expect(script).toContain("request('claim',challenge.id)");
    expect(script).toContain('Open challenge and earn +${challenge.rewardCoins} coins');
    expect(script).toContain("window.open('about:blank','_blank')");
    expect(script).toContain('if(event.isTrusted)');
    expect(script).not.toMatch(/dispatchEvent|button\.click\(|form\.submit\(/);
    expect(script.indexOf('history.replaceState')).toBeLessThan(script.indexOf("request<PortalStatus>('status')"));
    expect(script.indexOf("window.open('about:blank','_blank')")).toBeLessThan(script.indexOf("request<{destinationUrl:string}>('visit'"));
    expect(script.indexOf("request<{destinationUrl:string}>('visit'")).toBeLessThan(script.indexOf("request('claim',challenge.id)"));
  });
});
