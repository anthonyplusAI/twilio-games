interface ChessResultDialogElements {
  root: HTMLElement;
  overlay: HTMLElement;
  card: HTMLElement;
  title: HTMLElement;
  replay: HTMLButtonElement;
  exit: HTMLAnchorElement;
  announcer: HTMLElement;
  statusTitle: HTMLElement;
}

/** The result covers the board; keep keyboard and screen-reader focus on what is visible. */
export function createChessResultDialog(
  elements: ChessResultDialogElements,
  stationManaged: boolean,
  getActiveElement: () => Element | null = () => document.activeElement,
): { show(): void; hide(): void; trapTab(event: KeyboardEvent): void } {
  const { root, overlay, card, title, replay, exit, announcer, statusTitle } = elements;
  card.setAttribute('role', stationManaged ? 'region' : 'dialog');
  card.setAttribute('aria-describedby', 'result-detail');
  if (stationManaged) card.removeAttribute('aria-modal');
  else card.setAttribute('aria-modal', 'true');

  let backgroundInert: Map<HTMLElement, boolean> | null = null;
  let previousFocus: HTMLElement | null = null;

  return {
    show(): void {
      if (stationManaged || backgroundInert) return;
      const active = getActiveElement() as HTMLElement | null;
      previousFocus = active && typeof active.focus === 'function' && !overlay.contains(active) ? active : null;
      backgroundInert = new Map([...root.children]
        .filter(child => child !== overlay && child !== announcer)
        .map(child => [child as HTMLElement, (child as HTMLElement).inert]));
      for (const element of backgroundInert.keys()) element.inert = true;
      const firstAction = !replay.hidden && !replay.disabled ? replay : !exit.hidden ? exit : title;
      firstAction.focus({ preventScroll: true });
    },
    hide(): void {
      if (stationManaged || !backgroundInert) return;
      for (const [element, wasInert] of backgroundInert) element.inert = wasInert;
      backgroundInert = null;
      const target = previousFocus?.isConnected && !previousFocus.closest('[hidden],[inert]')
        ? previousFocus : statusTitle;
      previousFocus = null;
      target.focus({ preventScroll: true });
    },
    trapTab(event: KeyboardEvent): void {
      if (stationManaged || !backgroundInert || event.key !== 'Tab') return;
      const focusable = [...card.querySelectorAll<HTMLElement>('button,a[href],summary,[tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.closest('[hidden],[inert]')
          && !('disabled' in element && element.disabled)
          && element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        title.focus({ preventScroll: true });
        return;
      }
      const active = getActiveElement();
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (active === first || active === title)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    },
  };
}
