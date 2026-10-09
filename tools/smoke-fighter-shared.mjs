// Browser visual smoke for two-caller Fighter menus with public server frames.
// Run while Vite serves client/; no phone calls or game server are required.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';

const client = process.env.CLIENT_URL || 'http://localhost:5173';
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const screenshotDir = process.env.SCREENSHOT_DIR || tmpdir();
mkdirSync(screenshotDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new',
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
await page.setRequestInterception(true);
page.on('request', request => {
  if (new URL(request.url()).pathname === '/api/config') {
    void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ phoneNumber: '+15551234567' }) });
  } else void request.continue();
});

await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true, effectiveType: '4g' } });
  class QuietEventSource { addEventListener() {} close() {} }
  Object.defineProperty(window, 'EventSource', { configurable: true, value: QuietEventSource });
  window.__fighterSent = [];
  const ids = ['nyx', 'wraith', 'remy-riot', 'cinder-capone', 'rune-warden', 'shroom-boom',
    'gran-slam', 'bass-nova', 'velvet-thunder', 'iron-oni', 'bulkhead', 'sir-knockout'];
  const names = ['Nyx', 'Wraith', 'Remy Riot', 'Cinder Capone', 'Rune Warden', 'Shroom Boom',
    'Gran Slam', 'Bass Nova', 'Velvet Thunder', 'Iron Oni', 'Bulkhead', 'Sir Knockout'];
  const fighters = ids.map((id, index) => ({
    id, name: names[index], title: 'Voice fighter', color: index % 2 ? '#2dd4bf' : '#ef223a',
    file: `${id}.fbx`, preview: '',
  }));
  const maps = [
    { id: 'foundry', name: 'Neon Foundry', blurb: 'A red-hot industrial fight pit.', color: '#ef223a', bounds: [-9, 9] },
    { id: 'void', name: 'Void Circuit', blurb: 'A cold arena at the edge of space.', color: '#2dd4bf', bounds: [-11, 11] },
    { id: 'cyberpunk-city', name: 'Cyberpunk City', blurb: 'A neon skyline.', color: '#ff50e5', bounds: [-10, 10] },
    { id: 'inakaya', name: 'Inakaya', blurb: 'A warm evening arena.', color: '#ff9c5b', bounds: [-10, 10] },
    { id: 'rain', name: 'Rain', blurb: 'A wet stone stage.', color: '#9edfff', bounds: [-10, 10] },
  ];
  let socket;
  function state(phase) {
    const players = [
      { playerId: 'a', name: 'Ada', nameConfirmed: true, side: 'p1', isAi: false,
        fighterId: ['fighter_select', 'map_select', 'results'].includes(phase) ? 'nyx' : null },
      { playerId: 'g', name: 'Grace', nameConfirmed: phase !== 'lobby', side: 'p2', isAi: false,
        fighterId: ['map_select', 'results'].includes(phase) ? 'wraith' : null },
    ];
    return {
      type: 'fighter_state', roomCode: 'FIGHT', phase, players,
      aiFighterId: null, selectedMap: null,
      mapVotesByPlayerId: phase === 'map_select' ? { a: 'foundry' } : {}, mapVoteTied: false,
      world: null, expectedPlayerCount: 2, hasExpectedPlayers: true, automaticSetup: true,
      advanceReadyPlayerIds: ['a'], backReadyPlayerIds: [],
      phonePendingPlayerIds: phase === 'lobby' ? ['g'] : phase === 'results' ? ['g'] : ['a'],
      phoneTurnPendingPlayerIds: [], phoneRetryPlayerIds: [],
      phoneDisconnectedPlayerIds: [], loadingGeneration: 1,
      hudPresented: true, resultsPresented: true,
      intro: null, countdown: null,
      result: phase === 'results' ? { winner: 'p1', winnerName: 'Ada' } : null,
    };
  }
  const emit = value => queueMicrotask(() => socket?.onmessage?.({ data: JSON.stringify(value) }));
  class SmokeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = SmokeWebSocket.CONNECTING;
    onopen = null; onmessage = null; onclose = null; onerror = null;
    constructor(url) {
      this.url = url;
      socket = this;
      setTimeout(() => {
        this.readyState = SmokeWebSocket.OPEN;
        this.onopen?.({ type: 'open' });
        emit({ type: 'fighter_capabilities', displayAuth: false });
      }, 0);
    }
    send(raw) {
      const message = JSON.parse(String(raw));
      window.__fighterSent.push(message);
      if (message.type === 'spectate') {
        emit({ type: 'host_identity', roomCode: 'FIGHT', isHost: true, loadingGeneration: 1 });
        emit({ type: 'fighter_roster', fighters, maps });
        emit(state('lobby'));
      }
    }
    close() { this.readyState = SmokeWebSocket.CLOSED; this.onclose?.({ code: 1000 }); }
  }
  Object.defineProperty(window, 'WebSocket', { configurable: true, value: SmokeWebSocket });
  window.__fighterSmokeState = phase => emit(state(phase));
});

const observations = [];
async function observe(label) {
  await new Promise(resolve => setTimeout(resolve, 360));
  const value = await page.evaluate(() => {
    const overlay = document.getElementById('overlay');
    const result = document.getElementById('result');
    const visibleResult = Boolean(result && !result.hidden);
    const titleBox = document.getElementById('result-title')?.getBoundingClientRect();
    const controlsBox = document.getElementById('music-toggle-container')?.getBoundingClientRect();
    const resultTitleOverlap = Boolean(visibleResult && titleBox && controlsBox
      && controlsBox.width > 0 && controlsBox.height > 0
      && titleBox.left < controlsBox.right && titleBox.right > controlsBox.left
      && titleBox.top < controlsBox.bottom && titleBox.bottom > controlsBox.top);
    return {
      viewport: `${innerWidth}x${innerHeight}`, phase: document.body.dataset.phase,
      scrollTop: overlay?.scrollTop ?? null,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        || Boolean(overlay && overlay.scrollWidth > overlay.clientWidth),
      lobbyPlayers: [...document.querySelectorAll('.player-chip strong')].map(node => node.textContent),
      sharedSeats: [...document.querySelectorAll('.shared-setup-seat')].map(node => ({
        name: node.querySelector('strong')?.textContent,
        status: node.querySelector('span')?.textContent,
      })),
      selectionCards: document.querySelectorAll('.select-card').length,
      title: document.querySelector('.flow-panel h1')?.textContent,
      resultVisible: visibleResult,
      resultTitleOverlap,
      resultStatus: visibleResult ? document.getElementById('result-action-status')?.textContent : null,
      resultSeats: [...document.querySelectorAll('.result-setup-seat')].map(node => ({
        name: node.querySelector('strong')?.textContent,
        status: node.querySelector('span')?.textContent,
      })),
    };
  });
  observations.push({ label, ...value });
  await page.screenshot({ path: `${screenshotDir}/fighter-${label}.png` });
  return value;
}

async function go(phase, selector) {
  await page.evaluate(next => window.__fighterSmokeState(next), phase);
  await page.waitForSelector(selector, { timeout: 10_000 });
}

try {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${client}/fighter.html?display=1&room=FIGHT&players=2`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('.lobby-panel .shared-setup-seat', { timeout: 15_000 });
  await observe('two-lobby-desktop');
  await go('fighter_select', '.selection-panel .shared-setup-seat');
  await observe('two-fighter-select-desktop');
  await go('map_select', '.selection-panel .map-grid');
  await observe('two-map-select-desktop');
  await go('results', '#result:not([hidden])');
  await observe('two-results-desktop');

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await go('lobby', '.lobby-panel .shared-setup-seat');
  await observe('two-lobby-mobile');
  await page.evaluate(() => { const overlay = document.getElementById('overlay'); if (overlay) overlay.scrollTop = overlay.scrollHeight; });
  await go('fighter_select', '.selection-panel .shared-setup-seat');
  await observe('two-fighter-select-mobile');
  await go('map_select', '.selection-panel .map-grid');
  await observe('two-map-select-mobile');
  await go('results', '#result:not([hidden])');
  const mobileResults = await observe('two-results-mobile');
  const desktopResults = observations.find(item => item.label === 'two-results-desktop');
  if (desktopResults?.resultSeats.map(seat => seat.name).join(',') !== 'Ada,Grace'
    || mobileResults.resultSeats.map(seat => seat.name).join(',') !== 'Ada,Grace') {
    throw new Error('results lack named per-caller rematch status');
  }
  if (mobileResults.resultTitleOverlap) throw new Error('mobile result controls cover the winner title');
  console.log(JSON.stringify({ result: errors.length ? 'FAIL' : 'PASS', observations, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: String(error), observations, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
