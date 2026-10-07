import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const readClient=(path:string)=>readFileSync(new URL(`../client/${path}`,import.meta.url),'utf8');

describe('shared theme contract', () => {
  const pages=['index.html','play.html','monsters.html','fighter.html','karaoke.html','chess.html','join/index.html','arcade/index.html','instructions/index.html'];

  it.each(pages)('%s applies the theme before page styles', page => {
    const html=readClient(page);
    expect(html).toContain('src="/theme-init.js"');
    expect(html.indexOf('src="/theme-init.js"')).toBeLessThan(html.lastIndexOf('rel="stylesheet"'));
  });

  it('uses one validated storage key with legacy home migration', () => {
    const init=readClient('public/theme-init.js'),runtime=readClient('theme.ts');
    expect(init).toContain("var key = 'twilio-theme'");
    expect(init).toContain("var legacyKey = 'twilio-home-theme'");
    expect(init).toContain("window.addEventListener('storage'");
    expect(runtime).toContain("const STORAGE_KEY = 'twilio-theme'");
    expect(`${readClient('home.ts')}\n${readClient('join/join.ts')}\n${readClient('arcade/arcade.ts')}`).not.toContain('twilio-home-theme');
  });

  it('defines light surfaces for every game selection UI and station rail', () => {
    expect(readClient('racer.css')).toContain('html[data-theme="light"] #screens');
    expect(readClient('monsters.css')).toContain('html[data-theme="light"] #overlay');
    expect(readClient('fighter/fighter.css')).toContain('html[data-theme="light"]');
    expect(readClient('karaoke/karaoke.css')).toContain('html[data-theme="light"]');
    expect(readClient('chess/chess.css')).toContain('html[data-theme="light"] .chess-app');
    expect(readClient('station-display.css')).toContain('background:var(--theme-bg)');
  });

  it('opens Chess in the app light theme with an accessible toggle on both board and results', () => {
    const html = readClient('chess.html');
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('id="result-theme-toggle"');
    const runtime = readClient('chess/chess.ts');
    expect(runtime).toContain('scene.setTheme(currentTheme())');
    expect(runtime).toContain('board?.setTheme(theme)');
  });
});
