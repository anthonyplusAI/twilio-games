// Browser smoke for the shared-screen Trivia menus. Vite must already be running.
// A public-state WebSocket stub exercises the real client and CSS without Twilio calls.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const client = process.env.CLIENT_URL || 'http://localhost:5173';
const screenshotDir = process.env.SCREENSHOT_DIR || tmpdir();
mkdirSync(screenshotDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.setRequestInterception(true);
page.on('request', request => {
  if (new URL(request.url()).pathname === '/api/config') {
    void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ phoneNumber: '+15551234567' }) });
  } else void request.continue();
});

await page.evaluateOnNewDocument(() => {
  window.__triviaSent = [];
  class QuietEventSource { addEventListener() {} close() {} }
  Object.defineProperty(window, 'EventSource', { value: QuietEventSource, configurable: true });
  let socket;
  const names = ['Ada', 'Grace', 'Lin', 'Katherine'];
  const counts = () => ({
    general: 0, science: 1, geography: 1, history: 0, entertainment: 0,
    sports: 0, technology: 1, twilio: 0, mixed: 0,
  });
  const state = (phase, count = 4) => {
    const playerList = names.slice(0, count).map((name, index) => {
      const status = phase === 'lobby'
        ? ['ready', 'phone', 'name', 'ready'][index]
        : phase === 'category_select'
          ? ['ready', 'phone', 'category', 'ready'][index]
          : phase === 'category_wait'
            ? ['ready', 'phone', 'ready', 'ready'][index]
            : ['replay_ready', 'replay', 'phone', 'replay_ready'][index];
      return {
        playerId: `p${index + 1}`, name, playerOrder: index,
        nameConfirmed: status !== 'name', connected: true, setupStatus: status,
        categoryVoted: phase === 'category_wait' || phase === 'category_select' && index !== 2,
        replayReady: status === 'replay_ready',
        answered: false, rawScore: (count - index) * 1300,
        correctCount: count - index, bestStreak: count - index,
      };
    });
    const resultPlayers = playerList.map((player, index) => ({
      playerId: player.playerId, name: player.name, playerOrder: index,
      rank: index + 1, rawScore: player.rawScore,
      normalizedScore: player.rawScore + 1000, correctCount: player.correctCount,
      bestStreak: player.bestStreak, cumulativeCorrectTimeMs: 1000 * (index + 1),
    }));
    const countsValue = counts();
    if (phase === 'category_wait') countsValue.science += 1;
    return {
      type: 'trivia_state', roomCode: 'SHARED',
      phase: phase === 'category_wait' ? 'category_select' : phase,
      expectedPlayerCount: count, hasExpectedPlayers: true, automaticSetup: true,
      preferredLocale: 'en-US', category: phase === 'lobby' ? null : 'science',
      categoryVoteCounts: countsValue, players: playerList, serverNowMs: Date.now(),
      categoryVotingSeat: phase === 'category_select' ? { playerId: 'p3', name: 'Lin' } : null,
      replayVotingSeat: phase === 'results' ? { playerId: 'p2', name: 'Grace' } : null,
      loadingGeneration: 1, displayReady: false,
      questionIndex: null, countdownEndsAtMs: null, questionPromptEndsAtMs: null,
      answerCueEndsAtMs: null, answeringStartsAtMs: null, questionEndsAtMs: null,
      revealEndsAtMs: null, question: null, reveal: null, standings: null,
      result: phase === 'results' ? {
        resultId: `shared-${count}`, generation: 1, category: 'science',
        contentRevision: 'smoke', completedAtMs: Date.now(), players: resultPlayers,
      } : null,
    };
  };
  const emit = message => queueMicrotask(() => socket?.onmessage?.({ data: JSON.stringify(message) }));
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
        emit({ type: 'trivia_capabilities', displayAuth: false });
      }, 0);
    }
    send(raw) {
      const message = JSON.parse(String(raw));
      window.__triviaSent.push(message);
      if (message.type === 'spectate') {
        emit({ type: 'host_identity', isHost: true });
        emit(state('lobby'));
      } else if (message.type === 'clock_sync') {
        emit({ type: 'clock_sync', clientSentAtMs: message.clientSentAtMs, serverNowMs: Date.now() });
      }
    }
    close() { this.readyState = SmokeWebSocket.CLOSED; this.onclose?.({ code: 1000 }); }
  }
  Object.defineProperty(window, 'WebSocket', { value: SmokeWebSocket, configurable: true });
  window.__triviaSmokeState = (phase, count = 4) => emit(state(phase, count));
});

const observations = [];
async function observe(label) {
  // Scene-in is 360 ms; capture after it settles so opacity is representative.
  await new Promise(resolve => setTimeout(resolve, 420));
  const value = await page.evaluate(() => {
    const stage = document.getElementById('trivia-stage');
    const view = stage?.querySelector('[data-view]');
    const roster = [...document.querySelectorAll('.roster-player strong')].map(node => node.textContent);
    const setup = [...document.querySelectorAll('.setup-seat')].map(node => ({
      name: node.querySelector('strong')?.textContent,
      status: node.querySelector('small')?.textContent,
    }));
    return {
      view: view?.getAttribute('data-view'), viewport: `${innerWidth}x${innerHeight}`,
      roster, setup,
      categoryCount: document.querySelectorAll('.category-card').length,
      resultCount: document.querySelectorAll('.final-row').length,
      replayText: document.querySelector('#trivia-replay')?.textContent,
      scrollTop: stage?.scrollTop ?? null,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        || Boolean(stage && stage.scrollWidth > stage.clientWidth),
      verticalScroll: Boolean(stage && stage.scrollHeight > stage.clientHeight),
    };
  });
  observations.push({ label, ...value });
  await page.screenshot({ path: `${screenshotDir}/trivia-${label}.png` });
  return value;
}

function check(condition, label) {
  if (!condition) throw new Error(label);
}

async function canReach(selector) {
  return page.evaluate(target => {
    const node = document.querySelector(target);
    if (!node) return false;
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    const stage = document.getElementById('trivia-stage')?.getBoundingClientRect();
    const actions = document.querySelector('.results-actions')?.getBoundingClientRect();
    return Boolean(stage && rect.top >= stage.top && rect.bottom <= stage.bottom
      && (!actions || rect.bottom <= actions.top || rect.top >= actions.bottom));
  }, selector);
}

try {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${client}/trivia.html?locale=en-US&room=SHARED&players=4`, { waitUntil: 'networkidle2', timeout: 30_000 });
  await page.waitForSelector('[data-view="lobby"] .roster-player', { timeout: 10_000 });
  const lobby = await observe('four-lobby-desktop');
  check(lobby.roster.join(',') === 'Ada,Grace,Lin,Katherine', 'four-seat lobby roster is missing or unordered');
  check(!lobby.horizontalOverflow, 'desktop lobby has horizontal overflow');
  check(await page.evaluate(() => window.__triviaSent.some(message => message.type === 'spectate'
    && message.roomCode === 'SHARED' && message.count === 4)
    && !window.__triviaSent.some(message => message.type === 'configure_seats')),
  'the display did not register atomically with four seats');

  await page.evaluate(() => window.__triviaSmokeState('category_select'));
  await page.waitForSelector('[data-view="category_select"] .category-tap[data-voter="p3"]');
  const category = await observe('four-category-desktop');
  check(category.setup.length === 4 && category.categoryCount === 9, 'four-seat category view is incomplete');
  check(!category.horizontalOverflow, 'desktop category view has horizontal overflow');
  await page.click('[data-category="science"][data-voter="p3"]');
  check(await page.evaluate(() => window.__triviaSent.some(message => message.type === 'display_select_category'
    && message.playerId === 'p3' && message.category === 'science')), 'display category vote did not target Lin');
  await page.evaluate(() => window.__triviaSmokeState('category_wait'));
  await page.waitForFunction(() => document.querySelector('.category-voting-seat')?.textContent?.includes('hear their category choice'));
  const waiting = await observe('four-category-wait-desktop');
  check(waiting.setup.some(seat => seat.name === 'Grace' && seat.status === 'Finishing phone prompt'),
    'category screen does not identify the caller still hearing confirmation');

  await page.evaluate(() => window.__triviaSmokeState('results'));
  await page.waitForSelector('[data-view="results"] .final-row');
  const results = await observe('four-results-desktop');
  check(results.setup.length === 4 && results.resultCount === 4, 'four-seat results are incomplete');
  check(results.replayText === 'Play again for Grace', 'results do not name the replay seat');
  check(!results.horizontalOverflow, 'desktop results have horizontal overflow');
  await page.click('#trivia-replay');
  check(await page.evaluate(() => window.__triviaSent.some(message => message.type === 'display_replay'
    && message.playerId === 'p2')), 'display replay did not target Grace');

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.evaluate(() => window.__triviaSmokeState('lobby'));
  await page.waitForSelector('[data-view="lobby"] .roster-player');
  const mobileLobby = await observe('four-lobby-mobile');
  check(!mobileLobby.horizontalOverflow, 'mobile lobby has horizontal overflow');
  check(await canReach('.roster-player:last-child'), 'mobile lobby cannot reach the fourth caller');
  await page.evaluate(() => window.__triviaSmokeState('category_select'));
  await page.waitForSelector('[data-view="category_select"] .category-card');
  const mobileCategory = await observe('four-category-mobile');
  check(!mobileCategory.horizontalOverflow, 'mobile category view has horizontal overflow');
  check(mobileCategory.scrollTop === 0, 'mobile category starts below its heading after the lobby was scrolled');
  check(await canReach('.category-card:last-child'), 'mobile category view cannot reach the last category');
  await page.evaluate(() => window.__triviaSmokeState('results'));
  await page.waitForSelector('[data-view="results"] .final-row');
  const mobileResults = await observe('four-results-mobile');
  check(!mobileResults.horizontalOverflow, 'mobile results have horizontal overflow');
  check(mobileResults.scrollTop === 0, 'mobile results start below the winner after categories were scrolled');
  check(await canReach('.final-row:last-child'), 'mobile results cannot show the fourth caller above replay controls');

  await page.evaluate(() => window.__triviaSmokeState('results', 2));
  await page.waitForFunction(() => document.querySelectorAll('.final-row').length === 2);
  const twoResults = await observe('two-results-mobile');
  check(twoResults.setup.length === 2 && !twoResults.horizontalOverflow, 'two-seat mobile results are incomplete');
  check(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ result: 'PASS', observations, errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: String(error), observations, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
