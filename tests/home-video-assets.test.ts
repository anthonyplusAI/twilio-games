import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';

const readClient = (path: string) => readFileSync(new URL(`../client/${path}`, import.meta.url), 'utf8');
const home = readClient('home.ts');
const html = readClient('index.html');
const css = readClient('home.css');

type Mp4Box = { type: string; start: number; dataStart: number; end: number };

function mp4Boxes(bytes: Buffer, start = 0, end = bytes.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const shortSize = bytes.readUInt32BE(offset);
    const headerSize = shortSize === 1 ? 16 : 8;
    const size = shortSize === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : shortSize || end - offset;
    if (size < headerSize || offset + size > end) break;
    boxes.push({ type: bytes.toString('ascii', offset + 4, offset + 8), start: offset,
      dataStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function childBox(bytes: Buffer, parent: Mp4Box, type: string, prefix = 0): Mp4Box {
  const box = mp4Boxes(bytes, parent.dataStart + prefix, parent.end).find(candidate => candidate.type === type);
  if (!box) throw new Error(`Missing ${type} box in ${parent.type}`);
  return box;
}

function mp4VideoMetadata(bytes: Buffer) {
  const moov = mp4Boxes(bytes).find(box => box.type === 'moov');
  if (!moov) throw new Error('Missing moov box');
  const tracks = mp4Boxes(bytes, moov.dataStart, moov.end).filter(box => box.type === 'trak');
  const handlers = tracks.map(track => {
    const mdia = childBox(bytes, track, 'mdia');
    const handler = bytes.toString('ascii', childBox(bytes, mdia, 'hdlr').dataStart + 8,
      childBox(bytes, mdia, 'hdlr').dataStart + 12);
    return { handler, mdia };
  });
  const video = handlers.find(track => track.handler === 'vide');
  if (!video) throw new Error('Missing video track');
  const mdhd = childBox(bytes, video.mdia, 'mdhd');
  const version = bytes.readUInt8(mdhd.dataStart);
  const timescale = bytes.readUInt32BE(mdhd.dataStart + (version === 1 ? 20 : 12));
  const duration = version === 1
    ? Number(bytes.readBigUInt64BE(mdhd.dataStart + 24))
    : bytes.readUInt32BE(mdhd.dataStart + 16);
  const minf = childBox(bytes, video.mdia, 'minf');
  const stbl = childBox(bytes, minf, 'stbl');
  const sample = mp4Boxes(bytes, childBox(bytes, stbl, 'stsd').dataStart + 8,
    childBox(bytes, stbl, 'stsd').end)[0]!;
  const stts = childBox(bytes, stbl, 'stts');
  const entryCount = bytes.readUInt32BE(stts.dataStart + 4);
  let sampleCount = 0;
  for (let index = 0; index < entryCount; index += 1) sampleCount += bytes.readUInt32BE(stts.dataStart + 8 + index * 8);
  return {
    codec: sample.type,
    width: bytes.readUInt16BE(sample.start + 32),
    height: bytes.readUInt16BE(sample.start + 34),
    framesPerSecond: sampleCount * timescale / duration,
    handlers: handlers.map(track => track.handler),
  };
}

function mp4TopLevelBoxes(bytes: Buffer): string[] {
  const boxes: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const shortSize = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const size = shortSize === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : shortSize || bytes.length - offset;
    if (size < 8 || offset + size > bytes.length) break;
    boxes.push(type);
    offset += size;
  }
  return boxes;
}

describe('home preview media and standalone catalog', () => {
  it('keeps the Racer preview below 2 MiB with fast-start metadata', () => {
    const asset = new URL('../client/public/video/vr-demo.mp4', import.meta.url);
    expect(statSync(asset).size).toBeLessThan(2 * 1024 * 1024);
    const boxes = mp4TopLevelBoxes(readFileSync(asset));
    expect(boxes).toContain('moov');
    expect(boxes).toContain('mdat');
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
  });

  it('keeps the Karaoke runtime preview optimized, fast-start, and silent', () => {
    const asset = new URL('../client/public/video/vk-demo.mp4', import.meta.url);
    const bytes = readFileSync(asset);
    expect(statSync(asset).size).toBeGreaterThan(2_000_000);
    expect(statSync(asset).size).toBeLessThan(2_200_000);
    const boxes = mp4TopLevelBoxes(bytes);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
    const metadata = mp4VideoMetadata(bytes);
    expect(metadata).toMatchObject({ codec: 'avc1', width: 1280, height: 692 });
    expect(metadata.framesPerSecond).toBeCloseTo(24, 3);
    expect(metadata.handlers).not.toContain('soun');
  });

  it('wires the Karaoke preview only through runtime-enabled game cards', () => {
    expect(home).toContain("karaoke: '/video/vk-demo.mp4'");
    expect(html).not.toContain('/video/vk-demo.mp4');
    expect(home).toContain('orderByConfiguredIds(PLAYABLE_ARCADE_GAMES,standaloneGameOrder)');
    expect(home.match(/\/video\/vk-demo\.mp4/g)).toHaveLength(1);
  });

  it('ships and wires an optimized, fast-start, silent Trivia preview', () => {
    const asset = new URL('../client/public/video/vt-demo.mp4', import.meta.url);
    const bytes = readFileSync(asset);
    expect(statSync(asset).size).toBeLessThan(2 * 1024 * 1024);
    const boxes = mp4TopLevelBoxes(bytes);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
    const metadata = mp4VideoMetadata(bytes);
    expect(metadata).toMatchObject({ codec: 'avc1', width: 1280, height: 692 });
    expect(metadata.framesPerSecond).toBeCloseTo(24, 3);
    expect(metadata.handlers).not.toContain('soun');
    expect(home).toContain("trivia: '/video/vt-demo.mp4'");
    expect(home.match(/\/video\/vt-demo\.mp4/g)).toHaveLength(1);
  });

  it('ships and wires a compact, silent Voice Chess gameplay preview', () => {
    const asset = new URL('../client/public/video/vc-demo.mp4', import.meta.url);
    const bytes = readFileSync(asset);
    expect(statSync(asset).size).toBeLessThan(2 * 1024 * 1024);
    const boxes = mp4TopLevelBoxes(bytes);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
    const metadata = mp4VideoMetadata(bytes);
    expect(metadata).toMatchObject({ codec: 'avc1', width: 1280, height: 692 });
    expect(metadata.framesPerSecond).toBeCloseTo(24, 3);
    expect(metadata.handlers).not.toContain('soun');
    expect(home).toContain("chess: '/video/vc-demo.mp4'");
    expect(home.match(/\/video\/vc-demo\.mp4/g)).toHaveLength(1);
    expect(html).not.toContain('/video/vc-demo.mp4');
  });

  it('uses exact Conversation Relay product copy in fallback and both locales', () => {
    const english = 'Powered by Twilio Conversation Relay. Your voice is the controller.';
    const portuguese = 'Com tecnologia Twilio ConversationRelay. Sua voz é o controle.';
    expect(html).toContain(`<p id="standaloneDescription">${english}</p>`);
    expect(home).toContain(`standaloneDescription: '${english}'`);
    expect(home).toContain(`standaloneDescription: '${portuguese}'`);
    expect(`${html}\n${home}`).not.toContain('Choose a game on the shared screen. Players call from any phone and use their voices as controllers.');
  });

  it('removes the Trivia coming-soon surface and assigns stable playable options through Chess at 6', () => {
    expect(html).not.toContain('id="standaloneFuture"');
    expect(html).not.toContain('id="futureTrivia"');
    expect(home).not.toContain('renderComingSoon');
    expect(home).toContain('racer: 1, monsters: 2, fighter: 3, karaoke: 4, trivia: 5, chess: 6');
    expect(css).toContain('[hidden] { display:none !important; }');
  });

  it('rebuilds standalone videos only when enabled games change and never requests autoplay', () => {
    const launcher = /function renderStandaloneLauncher\(\): void \{[\s\S]*?\n\}/.exec(home)?.[0] ?? '';
    expect(launcher).toContain("games.map(game=>game.id).join(',')");
    expect(launcher).toContain('const key=lineupKey');
    expect(launcher).toContain('if(key===standaloneGamesKey)return;');
    expect(launcher).toContain('standaloneGames.replaceChildren();');
    expect(launcher).toContain('standaloneGames.append(');
    expect(`${html}\n${home}`).not.toMatch(/\bautoplay\b/i);
  });

  it('ships complete localized pagination controls', () => {
    const previous = /<button id="standalonePreviousPage"[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
    const next = /<button id="standaloneNextPage"[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
    expect(previous).toContain('aria-label="Previous page"');
    expect(previous).toContain('aria-controls="standaloneGames"');
    expect(previous).toContain('hidden');
    expect(next).toContain('aria-label="Next page"');
    expect(next).toContain('aria-controls="standaloneGames"');
    expect(html).toContain('id="standalonePageStatus"');
    expect(html).toContain('aria-live="polite"');
    for (const localized of ['Previous page', 'Next page', 'Page {page} of {pages}',
      'Página anterior', 'Próxima página', 'Página {page} de {pages}']) expect(home).toContain(localized);
    expect(css).toContain('.standalone-page-button-previous { grid-column:1;grid-row:1');
    expect(css).toContain('.standalone-page-button-next { grid-column:3;grid-row:1');
    expect(css).toContain('.standalone-page-placeholder { visibility:hidden;pointer-events:none; }');
    expect(css).toContain('@media (max-width:900px), (orientation:portrait)');
  });

  it('fails closed on missing game settings and keeps portrait previews landscape', () => {
    expect(home).toContain('let enabledGames = new Set<PlayableArcadeGame>()');
    expect(home).toMatch(/catch \{[\s\S]*?enabledGames = new Set<PlayableArcadeGame>\(\)/);
    expect(css).toMatch(/@media \(orientation:portrait\) and \(min-width:601px\)/);
    expect(css).toContain('.standalone-view::-webkit-scrollbar { display:none; }');
    expect(css).toMatch(/\.standalone-game \{ aspect-ratio:16\/9/);
    expect(css).toMatch(/\.game-card-media \{ aspect-ratio:16\/9/);
    expect(css).toMatch(/\.standalone-heading \{ padding-top:clamp\(80px,8vh,150px\);text-align:center/);
    expect(css).toContain('.standalone-heading h1 { margin:22px 0 24px;font-size:clamp(64px,8vw,92px); }');
    expect(css).toContain('.standalone-heading p { max-width:920px;margin-inline:auto;font-size:clamp(20px,2.2vw,28px); }');
    expect(css).toContain('.standalone-view:has(.standalone-games>.standalone-game:only-child)');
    expect(css).toMatch(/standalone-game:only-child\) \{ gap:0;padding-top:clamp\(100px,10vh,200px\)/);
    expect(html).toContain('class="standalone-footer-bug"');
    expect(css).toContain('width:clamp(240px,28vw,320px)');
    expect(html).toContain('class="standalone-quick-start"');
    expect(css).toContain('.standalone-quick-start { display:grid;grid-template-columns:repeat(3,1fr)');
    expect(home).toContain("const localStandalonePreview = standaloneMode && ['localhost', '127.0.0.1', '::1'].includes(location.hostname)");
    expect(home).toContain('enabledGames = localStandalonePreview || (config.channels.voice');
    expect(home).toContain('Boolean(bootstrap.voiceNumbers?.[locale])');
  });

  it('plays only active-view previews and honors constrained clients', () => {
    const playback = /function previewPlaybackAllowed\(\): boolean \{[\s\S]*?function show/.exec(home)?.[0] ?? '';
    expect(playback).toContain('reducedMotionPreference.matches');
    expect(playback).toContain('previewConnection?.saveData');
    expect(playback).toContain("['slow-2g', '2g']");
    expect(playback).toContain("document.visibilityState !== 'hidden'");
    expect(playback).toContain('activeView.contains(video)');
    expect(playback).toContain('hiddenStandaloneCard');
    expect(playback).toContain("video.removeAttribute('src')");
    expect(playback).toContain("if(source&&!video.getAttribute('src'))video.src=source");
    expect(playback).toContain('video.pause()');
    expect(playback).toContain('if (video.paused)');
    expect(home.match(/\.play\(/g)).toHaveLength(1);
    expect(html.match(/preload="none"/g)).toHaveLength(3);
    expect(home).toContain('preload="none"');
    expect(`${html}\n${home}`).not.toMatch(/<video\s+src=/);
    expect(home).toContain("document.addEventListener('visibilitychange',syncPreviewPlayback)");
    expect(home).toContain("if(standaloneMode){renderStandaloneLauncher();show('standalone');}");
    expect(home).toContain("document.body.classList.toggle('standalone-mode',standaloneMode)");
  });
});
