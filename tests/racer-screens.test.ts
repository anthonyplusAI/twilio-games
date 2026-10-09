import { afterEach, describe, expect, it, vi } from 'vitest';
import { Screens } from '../client/screens';
import type { LobbyPlayer } from '../shared/types';

afterEach(() => vi.unstubAllGlobals());

function screen(): { screens: Screens; html: () => string } {
  const classes = { add() {}, remove() {}, toggle() {} };
  const view = { id: '', style: { display: '' }, classList: classes, innerHTML: '',
    ownerDocument: { activeElement: null }, addEventListener() {} };
  vi.stubGlobal('document', { createElement: () => view, body: { classList: classes } });
  const host = { appendChild: () => {} };
  const screens = new Screens(host as unknown as HTMLElement, {
    onAdvance() {}, onBack() {}, onSelectCar() {}, onSelectMap() {},
  });
  return { screens, html: () => view.innerHTML };
}

const ada: LobbyPlayer = { playerId: 'p1', name: 'Ada', color: '#36d1dc', lane: 0,
  carIndex: null, ready: false, setupStatus: 'phone' };

describe('Racer shared-screen menu', () => {
  it('shows each caller’s current setup state and the missing second seat', () => {
    const display = screen();
    display.screens.setMenuTouch('ROOM', { activePlayerId: null, advancePlayerId: 'p1',
      canAdvance: false, canBack: false, expectedPlayers: 2 });
    display.screens.renderLobby('ROOM', [ada]);
    expect(display.html()).toContain('Ada');
    expect(display.html()).toContain('Hearing instructions');
    expect(display.html()).toContain('Waiting for Player 2');

    display.screens.renderCarSelect([ada, { ...ada, playerId: 'p2', name: 'Bo', lane: 1,
      setupStatus: 'car' }]);
    expect(display.html()).toContain('Ada');
    expect(display.html()).toContain('Hearing instructions');
    expect(display.html()).toContain('Bo');
    expect(display.html()).toContain('Choose car');
  });

  it('requires each caller to request a rematch after the result recap', () => {
    const display = screen();
    display.screens.setMenuTouch('ROOM', { activePlayerId: null, advancePlayerId: null,
      canAdvance: false, canBack: false, expectedPlayers: 2,
      sharedReplayRequiresCalls: true,
      sharedReplayStatuses: [{ playerId: 'p1', state: 'ready' },
        { playerId: 'p2', state: 'recap' }] });
    display.screens.renderResults([
      { playerId: 'p1', name: 'Ada', carIndex: 0, place: 1, finishT: 42, finished: true },
      { playerId: 'p2', name: 'Bo', carIndex: 0, place: 2, finishT: 48, finished: true },
    ], () => 'Car');
    expect(display.html()).toContain('each caller says');
    expect(display.html()).toContain('race again');
    expect(display.html()).toContain('Ada');
    expect(display.html()).toContain('Ready for rematch');
    expect(display.html()).toContain('Bo');
    expect(display.html()).toContain('Hearing result');
    expect(display.html()).not.toContain('data-menu-action="advance"');
  });

  it('explains why a shared rematch cannot continue after a caller leaves', () => {
    const display = screen();
    display.screens.setMenuTouch('ROOM', { activePlayerId: null, advancePlayerId: 'p1',
      canAdvance: false, canBack: false, expectedPlayers: 2,
      sharedReplayRequiresCalls: true,
      sharedReplayStatuses: [{ playerId: 'p1', state: 'ready' },
        { playerId: 'p2', state: 'left' }] });
    display.screens.renderResults([
      { playerId: 'p1', name: 'Ada', carIndex: 0, place: 1, finishT: 42, finished: true },
      { playerId: 'p2', name: 'Bo', carIndex: 0, place: 2, finishT: 48, finished: true },
    ], () => 'Car');
    expect(display.html()).toContain('Bo');
    expect(display.html()).toContain('Call ended');
    expect(display.html()).toContain('End the remaining call and launch a new race');
  });
});
