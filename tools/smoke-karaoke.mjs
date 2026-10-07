// Real-browser Karaoke stage smoke. Run with the game server and Vite client already running.
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import puppeteer from 'puppeteer-core';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const client = process.env.CLIENT_URL || 'http://localhost:5173';
const room = `KS${Date.now().toString(36).slice(-8)}`.toUpperCase();
const screenshot = process.env.SHOT_PATH || 'tools/.smoke/karaoke-desktop.png';
const crowdScreenshot = screenshot.replace(/(\.[^.]+)$/, '-crowd$1');
const expectedModels = ['backup-singer.glb', 'drummer.glb', 'guitarist.glb', 'lead-singer.glb', 'stage.glb'];
const expectedRoles = ['backup-singer', 'drummer', 'guitarist', 'lead-singer', 'stage'];
const expectedModelVersion = '20260827-rendering-3';
const expectedGuideVersion = '20260828-calibration-1';
const angleBackend = process.env.CHROME_ANGLE_BACKEND || 'swiftshader';

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: [
    '--no-sandbox', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle', `--use-angle=${angleBackend}`, '--enable-unsafe-swiftshader', '--enable-unsafe-swapchain',
    '--window-size=1920,1080',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => {
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalSend = WebSocket.prototype.send;
  window.__karaokeCountdownPlayback = [];
  window.__karaokeLaneInputs = [];
  WebSocket.prototype.send = function (value) {
    try {
      const message = JSON.parse(String(value));
      if (message.type === 'lane_input') window.__karaokeLaneInputs.push(message);
    } catch { /* diagnostics only */ }
    return originalSend.call(this, value);
  };
  HTMLMediaElement.prototype.play = function (...args) {
    if (new URL(this.currentSrc || this.src, location.href).pathname === '/audio/sfx/countdown.mp3') {
      window.__karaokeCountdownPlayback.push(document.getElementById('countdown-number')?.textContent ?? '');
    }
    return originalPlay.apply(this, args);
  };
});

const responses = new Map();
const modelVersions = new Map();
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const requestFailures = [];
const httpErrors = [];
let guideAudio = null;
page.on('response', response => {
  const url = new URL(response.url());
  if (response.status() >= 400) httpErrors.push(`${response.status()} ${url.pathname}`);
  if (url.pathname.endsWith('.glb') || url.pathname.includes('/draco/')) {
    responses.set(url.pathname.split('/').pop(), response.status());
  }
  if (url.pathname.endsWith('.glb')) modelVersions.set(url.pathname.split('/').pop(), url.searchParams.get('v'));
  if (url.pathname === '/audio/karaoke/classic-45s.mp3') {
    guideAudio = { status: response.status(), version: url.searchParams.get('v') };
  }
});
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
  if (message.type() === 'warn') consoleWarnings.push(message.text());
});
page.on('pageerror', error => pageErrors.push(String(error)));
page.on('requestfailed', request => {
  if (/\.glb|\/draco\//.test(request.url())) requestFailures.push(`${request.url()}: ${request.failure()?.errorText}`);
});

try {
  await page.goto(`${client}/karaoke.html?guide=1&locale=en-US&room=${room}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const veilInitiallyVisible = await page.$eval('#stage-loading', node => !node.classList.contains('done'));
  await page.waitForFunction(roles => {
    const loaded = (document.getElementById('arena')?.dataset.karaokeAssets ?? '').split(',');
    return roles.every(role => loaded.includes(role));
  }, { timeout: 30_000 }, expectedRoles);

  await page.keyboard.press('p');
  await page.waitForSelector('#advance-flow', { timeout: 10_000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-song]', { timeout: 10_000 });
  const songChoices = await page.$$eval('[data-song] strong', nodes => nodes.map(node => node.textContent?.trim() ?? ''));
  const songCardCopy = await page.$$eval('[data-song]', nodes => nodes.map(node => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
  await page.click('[data-song]');
  await page.waitForSelector('#advance-flow', { timeout: 10_000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.dataset.phase === 'performing', { timeout: 30_000 });
  const targets = await page.evaluate(() => {
    const current = Number(document.getElementById('arena')?.dataset.karaokeSongTimeMs ?? 0);
    const words = [...(window.__karaokeSmokeChart?.chart.words ?? [])]
      .sort((left, right) => left.startMs - right.startMs);
    const mouseIndex = Math.max(0, words.findIndex(word => word.startMs >= current - 100));
    const mouse = words[mouseIndex];
    const keyboard = words[mouseIndex + 1];
    if (!mouse || !keyboard) throw new Error('smoke chart has no playable words');
    return { mouse, keyboard };
  });
  const triggerLaneAt = (startMs, lane, mode) => page.evaluate(({ startMs, lane, mode }) => (
    new Promise((resolve, reject) => {
      const deadline = performance.now() + Math.max(12_000, Math.min(50_000, startMs + 5_000));
      const tick = () => {
        const arena = document.getElementById('arena');
        const songTime = Number(arena?.dataset.karaokeSongTimeMs);
        if (performance.now() >= deadline) { reject(new Error('lane trigger timed out')); return; }
        if (!arena || !Number.isFinite(songTime) || songTime < startMs - 750) {
          requestAnimationFrame(tick);
          return;
        }
        if (mode === 'mouse') {
          const bounds = arena.getBoundingClientRect();
          arena.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: bounds.left + bounds.width * ((lane + .5) / 4),
            clientY: bounds.top + bounds.height * .5,
          }));
        } else {
          dispatchEvent(new KeyboardEvent('keydown', { key: String(lane + 1), bubbles: true }));
        }
        const scoreBefore = Number((document.getElementById('hud-score')?.textContent ?? '0').replace(/\D/g, ''));
        resolve({ songTime, scoreBefore });
      };
      requestAnimationFrame(tick);
    })
  ), { startMs, lane, mode });
  const mouseTrigger = await triggerLaneAt(targets.mouse.startMs, targets.mouse.lane, 'mouse');
  const mouseTriggeredAt = mouseTrigger.songTime;
  await page.waitForFunction(baseline => {
    const score = Number((document.getElementById('hud-score')?.textContent ?? '0').replace(/\D/g, ''));
    return score > baseline;
  }, { timeout: 2_000 }, mouseTrigger.scoreBefore);
  const mouseLaneSent = await page.evaluate(lane => window.__karaokeLaneInputs?.some(message => message.lane === lane) === true,
    targets.mouse.lane);
  const mouseScore = await page.$eval('#hud-score', value => Number((value.textContent ?? '0').replace(/\D/g, '')));
  const keyboardTrigger = await triggerLaneAt(targets.keyboard.startMs, targets.keyboard.lane, 'keyboard');
  const keyboardTriggeredAt = keyboardTrigger.songTime;
  await page.waitForFunction(baseline => {
    const score = Number((document.getElementById('hud-score')?.textContent ?? '0').replace(/\D/g, ''));
    return score > baseline;
  }, { timeout: 2_000 }, keyboardTrigger.scoreBefore);
  const keyboardLaneSent = await page.evaluate(lane => window.__karaokeLaneInputs?.some(message => message.lane === lane) === true,
    targets.keyboard.lane);
  const keyboardHit = await page.evaluate(() => ({
    score: Number((document.getElementById('hud-score')?.textContent ?? '0').replace(/\D/g, '')),
    combo: Number(document.getElementById('hud-combo')?.textContent ?? '0'),
    judgment: document.querySelector('.judgment-burst')?.textContent ?? '',
  }));
  const keyboardScoreIncreased = keyboardHit.score > keyboardTrigger.scoreBefore;

  const state = await page.evaluate(async () => {
    const arena = document.getElementById('arena');
    const rail = document.getElementById('guide-calibration-rail');
    const hud = document.getElementById('performance-hud');
    const judgment = document.getElementById('judgment-layer');
    const rect = element => {
      const value = element?.getBoundingClientRect();
      return value ? { top: value.top, right: value.right, bottom: value.bottom, left: value.left,
        width: value.width, height: value.height } : null;
    };
    const overlaps = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left
      && a.top < b.bottom && a.bottom > b.top);
    const clockSamples = [];
    for (let index = 0; index < 3; index++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      clockSamples.push(Number(arena?.dataset.karaokePresentationSongTimeMs));
    }
    const arenaRect = rect(arena);
    const railRect = rect(rail);
    const hudRect = rect(hud);
    const judgmentRect = rect(judgment);
    return {
      assets: (arena?.dataset.karaokeAssets ?? '').split(',').sort(),
      drumAnchor: (arena?.dataset.karaokeDrumAnchor ?? '').split(',').map(Number),
      leadMaterials: Number(arena?.dataset.karaokeLeadMaterials),
      leadTextures: arena?.dataset.karaokeLeadTextures,
      crowd: arena?.dataset.karaokeCrowd,
      cameraShot: arena?.dataset.karaokeCameraShot,
      fallback: document.body.classList.contains('karaoke-webgl-fallback'),
      sceneSettled: document.getElementById('stage-loading')?.classList.contains('done') === true,
      canvases: document.querySelectorAll('#arena canvas').length,
      phase: document.body.dataset.phase,
      score: Number((document.getElementById('hud-score')?.textContent ?? '0').replace(/\D/g, '')),
      combo: Number(document.getElementById('hud-combo')?.textContent ?? '0'),
      judgment: document.querySelector('.judgment-burst')?.textContent ?? '',
      countdownPlayback: window.__karaokeCountdownPlayback ?? [],
      guideMode: document.body.dataset.karaokeGuide,
      guideLabel: document.getElementById('guide-mode-label')?.textContent ?? '',
      calibrationVisible: rail ? !rail.hidden && getComputedStyle(rail).display !== 'none' : false,
      calibrationButtons: [...document.querySelectorAll('#guide-calibration-rail button')]
        .map(button => button.textContent?.trim()),
      clock: {
        raw: Number(arena?.dataset.karaokeRawSongTimeMs),
        presentation: Number(arena?.dataset.karaokePresentationSongTimeMs),
        latency: Number(arena?.dataset.karaokeOutputLatencyMs),
        source: arena?.dataset.karaokeLatencySource,
        samples: clockSamples,
      },
      layout: {
        arena: arenaRect,
        rail: railRect,
        compact: Boolean(railRect && railRect.height <= 120),
        belowStage: Boolean(arenaRect && railRect && arenaRect.bottom <= railRect.top + 1),
        clearsHud: !overlaps(railRect, hudRect),
        clearsJudgment: !overlaps(railRect, judgmentRect),
      },
    };
  });
  await mkdir(dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot });
  await page.waitForFunction(() => Number(document.getElementById('arena')?.dataset.karaokeSongTimeMs) >= 8_100,
    { timeout: 10_000 });
  const crowdCameraShot = await page.$eval('#arena', arena => arena.dataset.karaokeCameraShot);
  await page.screenshot({ path: crowdScreenshot });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  const mobileLayout = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const arena = document.getElementById('arena')?.getBoundingClientRect();
    const railElement = document.getElementById('guide-calibration-rail');
    const rail = railElement?.getBoundingClientRect();
    const hud = document.getElementById('performance-hud')?.getBoundingClientRect();
    const judgment = document.getElementById('judgment-layer')?.getBoundingClientRect();
    const overlaps = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left
      && a.top < b.bottom && a.bottom > b.top);
    return {
      compact: Boolean(rail && rail.height <= 200),
      belowStage: Boolean(arena && rail && arena.bottom <= rail.top + 1),
      clearsHud: !overlaps(rail, hud),
      clearsJudgment: !overlaps(rail, judgment),
      contained: Boolean(railElement && railElement.scrollWidth <= railElement.clientWidth
        && railElement.scrollHeight <= railElement.clientHeight),
    };
  });
  await page.goto(`${client}/karaoke.html?locale=en-US&room=${room}-VIEW`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const normalGameRail = await page.evaluate(() => {
    document.body.dataset.phase = 'performing';
    const rail = document.getElementById('guide-calibration-rail');
    const arena = document.getElementById('arena');
    return {
      hidden: rail?.hidden === true,
      display: rail ? getComputedStyle(rail).display : '',
      arenaBottom: arena ? getComputedStyle(arena).bottom : '',
      guideClass: document.body.classList.contains('karaoke-guide'),
    };
  });

  const modelFailures = expectedModels.filter(file => responses.get(file) !== 200);
  const versionFailures = expectedModels.filter(file => modelVersions.get(file) !== expectedModelVersion);
  const anchorValid = state.drumAnchor.length === 3 && state.drumAnchor.every(Number.isFinite);
  const anchorRotated = anchorValid && state.drumAnchor.every((value, index) => Math.abs(value - [-.048, .659, -4.990][index]) < .002);
  const assetHttpErrors = httpErrors.filter(entry => /\.glb|\/draco\//.test(entry));
  const ok = modelFailures.length === 0 && versionFailures.length === 0
    && requestFailures.length === 0 && assetHttpErrors.length === 0
    && httpErrors.length === 0 && consoleErrors.length === 0 && pageErrors.length === 0
    && !state.fallback && state.canvases === 1 && anchorRotated
    && state.leadMaterials === 17 && state.leadTextures === '25/25'
    && state.crowd === '126/8'
    && typeof state.cameraShot === 'string' && state.cameraShot.length > 0
    // Fast asset loads may settle the veil before DOMContentLoaded; gameplay below proves readiness.
    && state.sceneSettled
    && state.countdownPlayback.length <= 1 && state.countdownPlayback.every(value => value === '3')
    && songChoices.includes('Never Gonna Give You Up') && songChoices.includes('A Thousand Miles')
    && songCardCopy.every(value => !/\bBPM\b|licensed recording|gravação licenciada/i.test(value))
    && mouseLaneSent && keyboardLaneSent && keyboardScoreIncreased
    && guideAudio?.status === 200 && guideAudio?.version === expectedGuideVersion
    && state.guideMode === '1' && /guide vocal/i.test(state.guideLabel)
    && state.calibrationVisible && state.calibrationButtons.length === 3
    && [state.clock.raw, state.clock.presentation, state.clock.latency].every(Number.isFinite)
    && state.clock.raw >= state.clock.presentation && state.clock.latency >= 0
    && ['output-timestamp', 'output-latency', 'base-latency', 'none'].includes(state.clock.source)
    && state.clock.samples.every((value, index, samples) => Number.isFinite(value)
      && (index === 0 || value >= samples[index - 1]))
    && state.layout.compact && state.layout.belowStage && state.layout.clearsHud && state.layout.clearsJudgment
    && Object.values(mobileLayout).every(Boolean)
    && normalGameRail.hidden && normalGameRail.display === 'none'
    && normalGameRail.arenaBottom === '0px' && !normalGameRail.guideClass
    && expectedRoles.every(role => state.assets.includes(role));
  console.log(JSON.stringify({ ok, room, screenshot, crowdScreenshot, crowdCameraShot, veilInitiallyVisible, songChoices, songCardCopy, targets, state, mouseTriggeredAt, mouseLaneSent, mouseScore, keyboardTriggeredAt, keyboardLaneSent, keyboardScoreIncreased, keyboardHit, responses: Object.fromEntries(responses),
    mobileLayout, normalGameRail, modelVersions: Object.fromEntries(modelVersions), guideAudio, consoleWarnings, consoleErrors, pageErrors,
    requestFailures, httpErrors, modelFailures, versionFailures }, null, 2));
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  const state = await page.evaluate(() => ({
    assets: document.getElementById('arena')?.dataset.karaokeAssets ?? '',
    drumAnchor: document.getElementById('arena')?.dataset.karaokeDrumAnchor ?? '',
    fallback: document.body.classList.contains('karaoke-webgl-fallback'),
    phase: document.body.dataset.phase,
    songTimeMs: document.getElementById('arena')?.dataset.karaokeSongTimeMs ?? '',
    rawSongTimeMs: document.getElementById('arena')?.dataset.karaokeRawSongTimeMs ?? '',
    score: document.getElementById('hud-score')?.textContent ?? '',
    combo: document.getElementById('hud-combo')?.textContent ?? '',
    judgment: document.querySelector('.judgment-burst')?.textContent ?? '',
    countdownPlayback: window.__karaokeCountdownPlayback ?? [],
  })).catch(() => null);
  console.error(JSON.stringify({ error: String(error), room, state, responses: Object.fromEntries(responses), consoleWarnings,
    consoleErrors, pageErrors, requestFailures, httpErrors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
