import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFullscreenGameShell } from '../client/fullscreen-game-shell';
import { wireFullscreenToggle } from '../client/fullscreen-toggle';

function createButton(lifecycleWindow?: EventTarget): HTMLButtonElement {
  const attributes = new Map<string, string>();
  return Object.assign(new EventTarget(), {
    hidden: false,
    innerHTML: '',
    title: '',
    ownerDocument: lifecycleWindow ? { defaultView: lifecycleWindow } : undefined,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  }) as unknown as HTMLButtonElement;
}

function createDocument(fullscreenEnabled = true): Document {
  const stub = Object.assign(new EventTarget(), {
    fullscreenEnabled,
    fullscreenElement: null as Element | null,
    documentElement: {} as HTMLElement,
    exitFullscreen: vi.fn(async () => {
      stub.fullscreenElement = null;
      stub.dispatchEvent(new Event('fullscreenchange'));
    }),
  });
  stub.documentElement = {
    requestFullscreen: vi.fn(async () => {
      stub.fullscreenElement = stub.documentElement as Element;
      stub.dispatchEvent(new Event('fullscreenchange'));
    }),
  } as unknown as HTMLElement;
  return stub as unknown as Document;
}

function createShellEnvironment(fullscreen = true): {
  document: Document;
  frame: HTMLIFrameElement;
  classes: Set<string>;
} {
  const classes = new Set<string>();
  const frameWindow = {
    location: { href: 'about:blank' },
    focus: vi.fn(),
  };
  const childDocument = { addEventListener: vi.fn() } as unknown as Document;
  const frame = Object.assign(new EventTarget(), {
    className: '', title: '', allow: '', src: '', contentWindow: frameWindow, contentDocument: childDocument,
    setAttribute: vi.fn(), remove: vi.fn(),
  }) as unknown as HTMLIFrameElement;
  const body = {
    children: [] as Element[],
    classList: {
      add: (value: string) => classes.add(value),
      remove: (value: string) => classes.delete(value),
      contains: (value: string) => classes.has(value),
    },
    append: vi.fn(),
  };
  const documentStub = {
    body,
    fullscreenElement: fullscreen ? {} : null,
    createElement: vi.fn(() => frame),
  } as unknown as Document;
  return { document: documentStub, frame, classes };
}

afterEach(() => vi.unstubAllGlobals());

describe('fullscreen toggle', () => {
  it('enters and exits browser fullscreen while keeping its accessible state current', async () => {
    const documentStub = createDocument();
    const button = createButton();
    vi.stubGlobal('document', documentStub);

    wireFullscreenToggle(button, { enter: 'Enter fullscreen', exit: 'Exit fullscreen' });
    expect(button.title).toBe('Enter fullscreen');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    button.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(documentStub.documentElement.requestFullscreen).toHaveBeenCalledOnce());
    expect(button.title).toBe('Exit fullscreen');
    expect(button.getAttribute('aria-pressed')).toBe('true');

    button.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(documentStub.exitFullscreen).toHaveBeenCalledOnce());
    expect(button.title).toBe('Enter fullscreen');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('hides the control when fullscreen is unavailable', () => {
    const button = createButton();
    vi.stubGlobal('document', createDocument(false));

    wireFullscreenToggle(button, { enter: 'Enter fullscreen', exit: 'Exit fullscreen' });

    expect(button.hidden).toBe(true);
  });

  it('keeps its listeners while cached and removes them when the page is discarded', () => {
    const lifecycleWindow = new EventTarget();
    const documentStub = createDocument();
    const button = createButton(lifecycleWindow);
    vi.stubGlobal('document', documentStub);
    wireFullscreenToggle(button, { enter: 'Enter fullscreen', exit: 'Exit fullscreen' });

    const cached = new Event('pagehide');
    Object.defineProperty(cached, 'persisted', { value: true });
    lifecycleWindow.dispatchEvent(cached);
    (documentStub as unknown as { fullscreenElement: Element | null }).fullscreenElement = documentStub.documentElement;
    documentStub.dispatchEvent(new Event('fullscreenchange'));
    expect(button.title).toBe('Exit fullscreen');

    const discarded = new Event('pagehide');
    Object.defineProperty(discarded, 'persisted', { value: false });
    lifecycleWindow.dispatchEvent(discarded);
    (documentStub as unknown as { fullscreenElement: Element | null }).fullscreenElement = null;
    documentStub.dispatchEvent(new Event('fullscreenchange'));
    expect(button.title).toBe('Exit fullscreen');
  });

  it('places the control in the upper-right header icon group', () => {
    const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
    const controls = html.slice(html.indexOf('<div id="header-controls">'), html.indexOf('</header>'));
    expect(controls).toContain('id="fullscreenToggle"');
    expect(controls).toContain('class="header-icon-button"');
  });

  it('returns both Home clicks and game-initiated Home navigation to the fullscreen owner page', () => {
    const environment = createShellEnvironment();
    const onOpen = vi.fn();
    const ownerLocation = {
      origin: 'https://games.example', href: 'https://games.example/', assign: vi.fn(),
    };
    vi.stubGlobal('document', environment.document);
    vi.stubGlobal('location', ownerLocation);
    const shell = createFullscreenGameShell({ onOpen });

    expect(shell.launch('/play.html?display=1')).toBe(true);
    expect(environment.frame.src).toBe('https://games.example/play.html?display=1');
    expect(environment.classes).toContain('fullscreen-game-active');
    expect(shell.active).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();

    (environment.frame.contentWindow!.location as unknown as { href: string }).href = 'https://games.example/play.html?display=1';
    environment.frame.dispatchEvent(new Event('load'));
    expect(environment.frame.contentWindow!.focus).toHaveBeenCalledOnce();
    const clickListener = vi.mocked(environment.frame.contentDocument!.addEventListener).mock.calls[0]?.[1] as (event: MouseEvent) => void;
    expect(clickListener).toBeTypeOf('function');
    const exit = { href: 'https://games.example/?locale=en-US' } as HTMLAnchorElement;
    const click = {
      button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      defaultPrevented: false,
      target: { closest: () => exit },
      preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
    } as unknown as MouseEvent;
    clickListener(click);
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(click.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(ownerLocation.assign).toHaveBeenCalledWith('https://games.example/?locale=en-US');

    // A game can prevent the click while it sends a leave message; its later
    // iframe navigation is still caught by the load fallback below.
    clickListener({ ...click, defaultPrevented: true } as MouseEvent);
    expect(ownerLocation.assign).toHaveBeenCalledOnce();

    (environment.frame.contentWindow!.location as unknown as { href: string }).href = 'https://games.example/?locale=en-US';
    environment.frame.dispatchEvent(new Event('load'));
    expect(ownerLocation.assign).toHaveBeenCalledTimes(2);
    expect(environment.frame.remove).not.toHaveBeenCalled();
    expect(environment.classes).toContain('fullscreen-game-active');
    expect(shell.active).toBe(true);
  });

  it('uses normal navigation outside fullscreen and exposes a toggle in every game', () => {
    const environment = createShellEnvironment(false);
    vi.stubGlobal('document', environment.document);
    vi.stubGlobal('location', { origin: 'https://games.example', href: 'https://games.example/' });
    expect(createFullscreenGameShell().launch('/play.html')).toBe(false);
    expect(environment.document.body.append).not.toHaveBeenCalled();

    for (const path of ['main.ts', 'battle/monsters.ts', 'fighter/fighter.ts', 'karaoke/karaoke.ts', 'trivia/trivia.ts']) {
      const source = readFileSync(new URL(`../client/${path}`, import.meta.url), 'utf8');
      expect(source, path).toContain('injectFullscreenToggle(');
    }
  });
});
