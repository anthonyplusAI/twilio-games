export interface FullscreenGameShell {
  readonly active: boolean;
  launch(target: string): boolean;
}

interface FullscreenGameShellOptions {
  onOpen?(): void;
}

export function createFullscreenGameShell(options: FullscreenGameShellOptions = {}): FullscreenGameShell {
  let frame: HTMLIFrameElement | null = null;
  const observedDocuments = new WeakSet<Document>();

  const homeDestination = (href: string): URL | null => {
    const destination = new URL(href, location.href);
    return destination.origin === location.origin && ['/', '/index.html'].includes(destination.pathname)
      ? destination
      : null;
  };

  const handleGameClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // The click originated in an iframe, so its Element belongs to another realm.
    const target = event.target as Element | null;
    const anchor = typeof target?.closest === 'function' ? target.closest<HTMLAnchorElement>('a[href]') : null;
    const destination = anchor ? homeDestination(anchor.href) : null;
    if (!destination) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.assign(destination.href);
  };

  const handleLoad = (): void => {
    if (!frame) return;
    try {
      const childUrl = frame.contentWindow?.location.href;
      const destination = childUrl ? homeDestination(childUrl) : null;
      if (destination) {
        location.assign(destination.href);
        return;
      }
      const childDocument = frame.contentDocument;
      if (childDocument && !observedDocuments.has(childDocument)) {
        // Let game handlers send their explicit leave/cleanup messages first.
        childDocument.addEventListener('click', handleGameClick);
        observedDocuments.add(childDocument);
      }
    } catch {
      // An unexpected cross-origin page cannot be inspected by the shell.
    }
    frame.contentWindow?.focus();
  };

  return {
    get active(): boolean { return frame !== null; },
    launch(target: string): boolean {
      if (!document.fullscreenElement) return false;
      const targetUrl = new URL(target, location.href);
      if (targetUrl.origin !== location.origin || ['/', '/index.html'].includes(targetUrl.pathname)) return false;

      if (frame) {
        frame.src = targetUrl.href;
        return true;
      }

      frame = document.createElement('iframe');
      frame.className = 'fullscreen-game-frame';
      frame.title = 'Twilio Games gameplay';
      frame.allow = 'autoplay; fullscreen';
      frame.addEventListener('load', handleLoad);
      frame.src = targetUrl.href;
      for (const child of document.body.children) {
        const launcherElement = child as HTMLElement;
        launcherElement.inert = true;
        launcherElement.setAttribute('aria-hidden', 'true');
      }
      document.body.classList.add('fullscreen-game-active');
      document.body.append(frame);
      options.onOpen?.();
      return true;
    },
  };
}
