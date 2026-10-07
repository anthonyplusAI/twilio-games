import { describe, expect, it } from 'vitest';
import { createChessResultDialog } from '../client/chess/chess-result-dialog';

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  parent: FakeElement | null = null;
  inert = false;
  hidden = false;
  disabled = false;
  isConnected = true;
  onFocus?: () => void;

  append(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  contains(candidate: FakeElement | null): boolean {
    return candidate === this || this.children.some(child => child.contains(candidate));
  }

  closest(_selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parent) {
      if (node.hidden || node.inert) return node;
    }
    return null;
  }

  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  focus(): void { this.onFocus?.(); }
}

function fixture(stationManaged = false) {
  const root = new FakeElement();
  const topbar = new FakeElement();
  const board = new FakeElement();
  const overlay = new FakeElement();
  const card = new FakeElement();
  const title = new FakeElement();
  const replay = new FakeElement();
  const exit = new FakeElement();
  const announcer = new FakeElement();
  const statusTitle = new FakeElement();
  root.append(topbar);
  root.append(board);
  root.append(overlay);
  root.append(announcer);
  overlay.append(card);
  card.append(title);
  card.append(replay);
  card.append(exit);
  topbar.append(statusTitle);
  let focused: FakeElement = topbar;
  for (const element of [topbar, board, overlay, card, title, replay, exit, announcer, statusTitle]) {
    element.onFocus = () => { focused = element; };
  }
  const dialog = createChessResultDialog({
    root, overlay, card, title, replay, exit, announcer, statusTitle,
  } as never, stationManaged, () => focused as never);
  return { dialog, topbar, board, overlay, card, title, replay, exit, announcer,
    statusTitle, get focused() { return focused; }, setFocused(element: FakeElement) { focused = element; } };
}

describe('Voice Chess result dialog focus', () => {
  it('makes standalone results modal, focuses Replay, and restores background focus on replay', () => {
    const view = fixture();
    view.board.inert = true;
    view.dialog.show();
    expect(view.card.attributes.get('role')).toBe('dialog');
    expect(view.card.attributes.get('aria-modal')).toBe('true');
    expect(view.topbar.inert).toBe(true);
    expect(view.board.inert).toBe(true);
    expect(view.announcer.inert).toBe(false);
    expect(view.focused).toBe(view.replay);

    view.setFocused(view.exit);
    view.dialog.show();
    expect(view.focused).toBe(view.exit);
    view.dialog.hide();
    expect(view.topbar.inert).toBe(false);
    expect(view.board.inert).toBe(true);
    expect(view.focused).toBe(view.topbar);
  });

  it('focuses Exit when Replay is unavailable and uses the status heading if prior focus disappears', () => {
    const view = fixture();
    view.replay.disabled = true;
    view.dialog.show();
    expect(view.focused).toBe(view.exit);
    view.topbar.isConnected = false;
    view.dialog.hide();
    expect(view.focused).toBe(view.statusTitle);
  });

  it('leaves the station display as a non-modal region without moving focus', () => {
    const view = fixture(true);
    view.dialog.show();
    expect(view.card.attributes.get('role')).toBe('region');
    expect(view.card.attributes.has('aria-modal')).toBe(false);
    expect(view.topbar.inert).toBe(false);
    expect(view.focused).toBe(view.topbar);
    view.dialog.hide();
    expect(view.focused).toBe(view.topbar);
  });
});
