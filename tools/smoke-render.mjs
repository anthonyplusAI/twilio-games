// Headless render smoke for the racer. Drives a real Chrome (puppeteer-core + system Chrome,
// SwiftShader/ANGLE for WebGL), drives the shared-screen menus with a local player, and asserts:
//   - the display reaches the actual race (not just the spectator lobby)
//   - the start (z=0) and finish (z=RACE_LEN) gantry MODELS load + sit at the authored track ends
//   - the barrier and gantry GLBs serve 200 through the real loader path
//   - no console errors / page errors
// Also writes screenshots for eyeballing. This is the renderer's only automated coverage
// (the GL view code has no unit tests), so run it after touching renderer/asset wiring.
//
// Usage (dev servers must be up — npm run dev:server & npm run dev:client):
//   CLIENT_URL=http://localhost:5173 node tools/smoke-render.mjs
//   npm run smoke         (uses CLIENT_URL or the 5173 default)
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CLIENT = process.env.CLIENT_URL || 'http://localhost:5173';
const RACE_LEN = 2100;   // TRACK_LEN(700) * LAP_TARGET(3) — keep in sync with shared/constants.ts
const SHOT_DIR = process.env.SHOT_DIR || 'tools/.smoke';
const ROOM = `SMOKE${process.pid}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-webgl',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swapchain', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const consoleErrors = [], pageErrors = [], glb = new Map();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('response', (r) => { if (r.url().endsWith('.glb')) glb.set(r.url().split('/').pop(), r.status()); });

let player;
let raceVisible = false;
try {
  // Display mode keeps game, station, and config streams open, so network-idle is not reachable.
  await page.goto(`${CLIENT}/play.html?display=1&room=${ROOM}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#screens .chip-empty', { timeout: 30_000 });

  // A spectator alone cannot start. Join a local test player, then use the real display menu
  // actions so this smoke actually reaches gameplay and covers touch-driven setup as well.
  const clientUrl = new URL(CLIENT);
  const gameUrl = `${clientUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${clientUrl.host}/game`;
  player = new WebSocket(gameUrl);
  await new Promise((resolve, reject) => {
    player.once('open', resolve);
    player.once('error', reject);
  });
  player.send(JSON.stringify({ type: 'join', roomCode: ROOM, name: 'Smoke Tester', locale: 'en-US' }));
  await page.waitForSelector('#screens .chip .nm', { timeout: 45_000 });
  await page.waitForSelector('#screens button[data-menu-action="advance"]:not(:disabled)', { timeout: 30_000 });
  await clickMenu('advance');
  await page.waitForSelector('#screens button[data-menu-action="car"]:not(:disabled)', { timeout: 45_000 });
  await clickMenu('car');
  await page.waitForFunction(() => !document.querySelector('#screens button[data-menu-action="advance"]')?.disabled,
    { timeout: 30_000 });
  await clickMenu('advance');
  await page.waitForSelector('#screens button[data-menu-action="map"]:not(:disabled)', { timeout: 30_000 });
  await clickMenu('map');
  await page.waitForFunction(() => !document.querySelector('#screens button[data-menu-action="advance"]')?.disabled,
    { timeout: 30_000 });
  await clickMenu('advance');
  await page.waitForFunction(() => !document.body.classList.contains('in-menu')
    && document.getElementById('screens')?.style.display === 'none', { timeout: 75_000 });
  raceVisible = true;

  await wait(6000);
  await fs_mkdir(SHOT_DIR);
  await page.screenshot({ path: `${SHOT_DIR}/start.png` });
  await wait(6000);
  await page.screenshot({ path: `${SHOT_DIR}/mid.png` });
} catch (error) {
  console.error('Racer menu-to-race smoke failed:', error);
  await fs_mkdir(SHOT_DIR);
  await page.screenshot({ path: `${SHOT_DIR}/flow-failure.png` }).catch(() => undefined);
  player?.close();
  await browser.close();
  process.exit(1);
}

const lines = await page.evaluate(() => {
  const r = window.__renderer;
  if (!r || !r.getScene) return { error: 'no __renderer (is this a dev/localhost build?)' };
  const scene = r.getScene(); scene.updateMatrixWorld(true);
  const round = (n) => Math.round(n * 10) / 10;
  const wrappers = [];
  scene.traverse((o) => {
    if (o.userData && o.userData.lineZ !== undefined) {
      const z = o.userData.lineZ;
      const expected = o.position.clone();
      const offset = o.userData.offset;
      if (offset?.pos) {
        expected.fromArray(offset.pos);
      } else if (r.path) {
        const sample = r.path.sample(z, 0);
        expected.set(sample.pos.x, sample.pos.y + 0.6, sample.pos.z);
      } else {
        expected.set(0, 0, z);
      }
      const expectedWorld = o.parent.localToWorld(expected);
      const actualWorld = o.getWorldPosition(o.position.clone());
      wrappers.push({ lineZ: o.userData.lineZ, fallback: !!o.userData.fallbackLine,
        world: actualWorld.toArray().map(round), expected: expectedWorld.toArray().map(round),
        positionError: round(actualWorld.distanceTo(expectedWorld)), visible: o.visible });
    }
  });
  return { wrappers };
});

const want = ['starting_line.glb', 'finish_line.glb', 'danger_barrier_proops.glb'];
const glbMissing = want.filter((w) => glb.get(w) !== 200);
const start = lines.wrappers?.find((w) => w.lineZ === 0 && !w.fallback);
const finish = lines.wrappers?.find((w) => w.lineZ === RACE_LEN && !w.fallback);
const autoplayErrors = consoleErrors.filter((e) => e.includes('NotAllowedError: play() failed'));
const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('NotAllowedError: play() failed'));

console.log('\n=== gantry models ===');
console.log(JSON.stringify(lines, null, 2));
console.log('actual race visible:', raceVisible);
console.log('\n=== key GLBs ===');
for (const w of want) console.log(`  ${w}: ${glb.get(w) ?? 'NOT REQUESTED'}`);
console.log('\nconsole errors:', unexpectedConsoleErrors.length ? unexpectedConsoleErrors : '(none)');
console.log('autoplay blocks:', autoplayErrors.length ? autoplayErrors.length : '(none)');
console.log('page errors:', pageErrors.length ? pageErrors : '(none)');

const ok = raceVisible && glbMissing.length === 0 && pageErrors.length === 0 && unexpectedConsoleErrors.length === 0
  && !!start && start.positionError < 1 && start.visible
  && !!finish && finish.positionError < 1 && finish.visible;
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) {
  if (glbMissing.length) console.log('  missing/failed GLBs:', glbMissing.join(', '));
  if (!start) console.log('  start gantry model not found at z=0');
  if (!finish) console.log('  finish gantry model not found at z=RACE_LEN');
}
player?.close();
await browser.close();
process.exit(ok ? 0 : 1);

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fs_mkdir(d) { const { mkdir } = await import('node:fs/promises'); await mkdir(d, { recursive: true }); }
async function clickMenu(action) {
  // The server can replace a menu node during a pointer's scroll/click sequence. Resolve the
  // current enabled button and dispatch its click in one browser task to avoid a false failure.
  await page.evaluate((name) => {
    const button = document.querySelector(`#screens button[data-menu-action="${name}"]`);
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      throw new Error(`Menu action ${name} unavailable`);
    }
    button.click();
  }, action);
}
