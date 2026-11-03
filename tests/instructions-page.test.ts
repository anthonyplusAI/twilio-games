import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../client/instructions/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../client/instructions/instructions.css',import.meta.url),'utf8');
const vite=readFileSync(new URL('../client/vite.config.ts',import.meta.url),'utf8');
const server=readFileSync(new URL('../server/http-server.ts',import.meta.url),'utf8');

async function renderInstructions(url: string, savedLocale: string) {
  vi.resetModules();
  const storage = new Map([['twilio-games-locale', savedLocale]]);
  const brandAttributes = new Map<string, string>();
  const brand = {
    href: 'http://localhost:5173/',
    setAttribute(name: string, value: string) { brandAttributes.set(name, value); },
    getAttribute(name: string) { return brandAttributes.get(name) ?? null; },
  };
  const toggleAttributes = new Map<string, string>();
  const toggle = {
    innerHTML: '',
    setAttribute(name: string, value: string) { toggleAttributes.set(name, value); },
    getAttribute(name: string) { return toggleAttributes.get(name) ?? null; },
    removeAttribute(name: string) { toggleAttributes.delete(name); },
    addEventListener() {},
  };
  const nodes = [...html.matchAll(/data-copy="([^"]+)"/g)]
    .map(([, key]) => ({ dataset: { copy: key }, textContent: '' }));
  const document = {
    documentElement: { lang: 'en-US', dir: 'ltr', dataset: { theme: 'light' } },
    title: '',
    querySelectorAll(selector: string) {
      if (selector === 'a[href]') return [brand];
      if (selector === '[data-copy]') return nodes;
      return [];
    },
    querySelector(selector: string) { return selector === '.instructions-brand' ? brand : null; },
    getElementById(id: string) { return id === 'themeToggle' ? toggle : null; },
  };
  vi.stubGlobal('location', new URL(url));
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', { addEventListener() {} });

  await import('../client/instructions/instructions');
  return {
    lang: document.documentElement.lang,
    title: document.title,
    text: Object.fromEntries(nodes.map(node => [node.dataset.copy, node.textContent])),
    homeHref: brand.href,
    homeAria: brand.getAttribute('aria-label'),
    themeAria: toggle.getAttribute('aria-label'),
    savedLocale: storage.get('twilio-games-locale'),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Localized instructions page', () => {
  it('offers an English fallback with the full voice and QR flow', () => {
    expect(html).toContain('<html lang="en-US"');
    expect(html).toContain('<title>How to play | Twilio Games</title>');
    expect(html).toContain('Use your voice to play.');
    expect(html).toContain('The screen responds to touch.');
    expect(html).toContain('Scan the QR code');
    expect(html).toContain('Make the call');
    expect(html).toContain('Listen to the voice guide');
    expect(html).toContain('Use voice commands for the game you chose.');
    expect(html).not.toContain('números brasileiros (+55)');
    expect(html.match(/<li>/g)).toHaveLength(6);
  });

  it('uses English from the URL even when Portuguese was saved', async () => {
    const page = await renderInstructions('http://localhost:5173/instructions/?locale=en-US', 'pt-BR');
    expect(page.lang).toBe('en-US');
    expect(page.title).toBe('How to play | Twilio Games');
    expect(page.text.heroTitle).toBe('Use your voice to play.');
    expect(page.text.step3Body).toBe('Use your phone camera to open the call link.');
    expect(page.homeHref).toBe('http://localhost:5173/?locale=en-US');
    expect(page.homeAria).toBe('Back to Twilio Games');
    expect(page.themeAria).toBe('Dark theme');
    expect(page.savedLocale).toBe('en-US');
    expect(Object.values(page.text).every(Boolean)).toBe(true);
  });

  it('uses saved Portuguese on a direct visit', async () => {
    const page = await renderInstructions('http://localhost:5173/instructions/', 'pt-BR');
    expect(page.lang).toBe('pt-BR');
    expect(page.title).toBe('Como jogar | Twilio Games');
    expect(page.text.heroTitle).toBe('Use sua voz para jogar.');
    expect(page.text.step3Title).toBe('Escaneie o código QR');
    expect(page.text.footerNote).toBe('Acompanhe sua vez na tela compartilhada.');
    expect(page.homeHref).toBe('http://localhost:5173/?locale=pt-BR');
    expect(page.homeAria).toBe('Voltar para Twilio Games');
    expect(page.themeAria).toBe('Tema escuro');
    expect(Object.values(page.text).every(Boolean)).toBe(true);
  });

  it('uses existing Twilio branding and is registered as a clean route', () => {
    expect(html).toContain('/brand/Twilio_Logo_Bug_White.svg');
    expect(html).toContain('/theme-init.js');
    expect(css).toContain('Twilio Sans Display');
    expect(css).toContain('@media(max-width:480px)');
    expect(vite).toContain("instructions: resolve(__dirname, 'instructions/index.html')");
    expect(server).toContain("rel === '/instructions' || rel === '/instructions/'");
  });
});
