import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { GameServer, RACER_BROADCAST_HZ, RACER_STANDALONE_RENDER_READY_TIMEOUT_MS, parseClientMessage } from '../server/game-server';
import { HttpServer, isLateRacerGameplayPrompt } from '../server/http-server';
import { clearSelectionIndex } from '../server/game-host';
import type { GameEvent, ServerMessage } from '../shared/types';
import { STEP } from '../shared/constants';
import { mkdir, unlink, writeFile } from 'node:fs/promises';

let server: GameServer;
afterEach(async () => { await server?.stop(); });

function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: ServerMessage[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  return { ws, inbox, open: () => new Promise<void>(r => ws.on('open', () => r())) };
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('GameServer integration', () => {
  it('publishes each caller’s result recap and rematch state to the shared display', async () => {
    server = new GameServer({ port: 0 });
    server.setRoomConfigProvider(() => ({ carCount: 2, maps: ['Silver Lake'] }));
    const port = await server.start();
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'REPLAY-STATE' }));
    await vi.waitFor(() => expect(server.findRoom('REPLAY-STATE')).toBeDefined());
    server.voiceConfigureStandaloneSeats('REPLAY-STATE', 2);
    const room = server.findRoom('REPLAY-STATE')!;
    const ada = room.addPlayer('Ada') as { playerId: string };
    const bo = room.addPlayer('Bo') as { playerId: string };
    room.registerVoicePlayer(ada.playerId);
    room.registerVoicePlayer(bo.playerId);
    room.beginMenuAudio(ada.playerId, 'lobby')();
    room.beginMenuAudio(bo.playerId, 'lobby')();
    room.advance(ada.playerId);
    display.ws.send(JSON.stringify({ type: 'configure_seats', roomCode: room.code, count: 2 }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'select_state'
      && message.phase === 'car_select')).toBe(true));
    expect(display.inbox.some(message => message.type === 'error'
      && message.code === 'setup_locked')).toBe(false);
    room.selectCar(ada.playerId, 0);
    room.selectCar(bo.playerId, 1);
    room.beginMenuAudio(ada.playerId, 'car_select')();
    room.beginMenuAudio(bo.playerId, 'car_select')();
    room.advance(ada.playerId);
    room.selectMap('Silver Lake', ada.playerId);
    room.selectMap('Silver Lake', bo.playerId);
    room.beginMenuAudio(ada.playerId, 'map_select')();
    room.beginMenuAudio(bo.playerId, 'map_select')();
    room.advance(ada.playerId);
    for (let i = 0; i < 60 * 120 && room.phase !== 'results'; i++) room.tick(STEP);
    expect(room.phase).toBe('results');

    const finishAdaRecap = room.beginMenuAudio(ada.playerId, 'results');
    room.beginMenuAudio(bo.playerId, 'results');
    server.voiceSetupChanged(room.code, 'results');
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'results')).toBe(true));
    const duringRecaps = [...display.inbox].reverse().find(message => message.type === 'results');
    expect(duringRecaps).toMatchObject({ touch: { sharedReplayStatuses: [
      { playerId: ada.playerId, state: 'recap' }, { playerId: bo.playerId, state: 'recap' },
    ] } });

    finishAdaRecap();
    expect(room.advance(ada.playerId)).toBe(false);
    server.voiceSetupChanged(room.code, 'results');
    await vi.waitFor(() => expect([...display.inbox].reverse().find(message => message.type === 'results'))
      .toMatchObject({ touch: { sharedReplayStatuses: [
        { playerId: ada.playerId, state: 'ready' }, { playerId: bo.playerId, state: 'recap' },
      ] } }));
    display.ws.close();
  });
  it('accepts a two-seat setup only from the display bound to that standalone room', async () => {
    server = new GameServer({ port: 0 });
    const port = await server.start();
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'LOCAL-TWO' }));
    await vi.waitFor(() => expect(server.findRoom('LOCAL-TWO')).toBeDefined());
    display.ws.send(JSON.stringify({ type: 'configure_seats', roomCode: 'LOCAL-TWO', count: 2 }));
    await vi.waitFor(() => expect(server.findRoom('LOCAL-TWO')?.humanPlayerTarget).toBe(2));
    expect([...display.inbox].reverse().find(message => message.type === 'lobby'))
      .toMatchObject({ touch: { expectedPlayers: 2 } });

    const caller = connect(port); await caller.open();
    caller.ws.send(JSON.stringify({ type: 'join', roomCode: 'LOCAL-TWO', name: 'Ada' }));
    await vi.waitFor(() => expect(server.findRoom('LOCAL-TWO')?.playerCount).toBe(1));
    caller.ws.send(JSON.stringify({ type: 'configure_seats', roomCode: 'LOCAL-TWO', count: 1 }));
    await vi.waitFor(() => expect(caller.inbox.some(message => message.type === 'error'
      && message.code === 'bad_display_auth')).toBe(true));
    expect(server.findRoom('LOCAL-TWO')?.humanPlayerTarget).toBe(2);
    display.ws.close(); caller.ws.close();
  });
  it('sets two seats in the first display message before a caller can advance', async () => {
    server = new GameServer({ port: 0 });
    const port = await server.start();
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'ATOMIC-TWO', count: 2 }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'lobby')).toBe(true));
    const room = server.findRoom('ATOMIC-TWO')!;
    expect(room.humanPlayerTarget).toBe(2);
    expect([...display.inbox].reverse().find(message => message.type === 'lobby'))
      .toMatchObject({ touch: { expectedPlayers: 2 } });
    const phone = room.addPlayer('Ada') as { playerId: string };
    expect(room.canAdvance(phone.playerId)).toBe(false);
    display.ws.close();
  });
  it('sets two seats before admitting a keyboard player whose socket wins the display race', async () => {
    server = new GameServer({ port: 0 });
    const port = await server.start();
    const keyboard = connect(port); await keyboard.open();
    keyboard.ws.send(JSON.stringify({ type: 'join', roomCode: 'KEYBOARD-FIRST', name: 'Keyboard',
      keyboardSession: { id: '33333333333333333333333333333333', generation: 1, seats: 2 } }));
    await vi.waitFor(() => expect(keyboard.inbox.some(message => message.type === 'joined')).toBe(true));
    const room = server.findRoom('KEYBOARD-FIRST')!;
    const first = room.lobbyPlayers()[0]!;
    expect(room.humanPlayerTarget).toBe(2);
    expect(room.canAdvance(first.playerId)).toBe(false);

    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'KEYBOARD-FIRST' }));
    display.ws.send(JSON.stringify({ type: 'configure_seats', roomCode: 'KEYBOARD-FIRST', count: 2 }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'lobby'
      && message.touch?.expectedPlayers === 2)).toBe(true));
    expect(display.inbox.some(message => message.type === 'error' && message.code === 'setup_locked')).toBe(false);
    const phone = room.addPlayer('Phone');
    expect(phone).not.toHaveProperty('error');
    keyboard.ws.close(); display.ws.close();
  });
  it('accepts the display two-seat choice after the first phone caller begins its lobby cue', async () => {
    server = new GameServer({ port: 0 });
    const port = await server.start();
    const room = server.getOrCreateRoom('PHONE-FIRST');
    const phone = room.addPlayer('Ada') as { playerId: string };
    room.registerVoicePlayer(phone.playerId);
    const finishPhoneCue = room.beginMenuAudio(phone.playerId, 'lobby');

    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'PHONE-FIRST' }));
    display.ws.send(JSON.stringify({ type: 'configure_seats', roomCode: 'PHONE-FIRST', count: 2 }));
    await vi.waitFor(() => expect(room.humanPlayerTarget).toBe(2));
    expect(display.inbox.some(message => message.type === 'error' && message.code === 'setup_locked')).toBe(false);
    expect(room.lobbyPlayers()[0]).toMatchObject({ name: 'Ada', setupStatus: 'phone' });
    finishPhoneCue();
    expect(room.canAdvance(phone.playerId)).toBe(false);
    display.ws.close();
  });
  it('keeps an organic two-caller menu stable against display Ready, Restart, and Back', async () => {
    server = new GameServer({ port: 0 });
    server.setRoomConfigProvider(() => ({ carCount: 2, maps: ['Silver Lake'] }));
    const port = await server.start();
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'ORGANIC-DUO' }));
    const ada = connect(port); await ada.open();
    const bo = connect(port); await bo.open();
    ada.ws.send(JSON.stringify({ type: 'join', roomCode: 'ORGANIC-DUO', name: 'Ada' }));
    bo.ws.send(JSON.stringify({ type: 'join', roomCode: 'ORGANIC-DUO', name: 'Bo' }));
    await vi.waitFor(() => expect(server.findRoom('ORGANIC-DUO')?.playerCount).toBe(2));
    const room = server.findRoom('ORGANIC-DUO')!;

    display.ws.send(JSON.stringify({ type: 'ready' }));
    display.ws.send(JSON.stringify({ type: 'restart' }));
    await wait(30);
    expect(room.phase).toBe('lobby');
    expect(room.snapshot()).toBeNull();

    expect(room.advance(room.lobbyPlayers()[0]!.playerId)).toBe(true);
    display.ws.send(JSON.stringify({ type: 'display_back', roomCode: room.code, expectedPhase: 'car_select' }));
    ada.ws.send(JSON.stringify({ type: 'back' }));
    display.ws.send(JSON.stringify({ type: 'restart' }));
    await wait(30);
    expect(room.phase).toBe('car_select');
    expect(room.snapshot()).toBeNull();
    display.ws.close(); ada.ws.close(); bo.ws.close();
  });
  it('recognizes only the currently bound standalone display socket', async () => {
    server = new GameServer({ port: 0, displayToken: 'station-display-token' });
    server.setBrowserPlayerAdmission(code => code !== 'PAID');
    const port = await server.start();
    const display = connect(port); await display.open();
    const serverSocket = [...(server as unknown as { conns: Set<{ ws: WebSocket }> }).conns][0]!.ws;
    expect(server.hasStandaloneDisplay(serverSocket, 'SOLO')).toBe(false);

    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'SOLO' }));
    await vi.waitFor(() => expect(server.hasStandaloneDisplay(serverSocket, 'SOLO')).toBe(true));
    expect(server.hasStandaloneDisplay(serverSocket, 'OTHER')).toBe(false);

    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'OTHER' }));
    await vi.waitFor(() => expect(server.hasStandaloneDisplay(serverSocket, 'OTHER')).toBe(true));
    expect(server.hasStandaloneDisplay(serverSocket, 'SOLO')).toBe(false);

    display.ws.send(JSON.stringify({ type: 'leave' }));
    await vi.waitFor(() => expect(server.hasStandaloneDisplay(serverSocket, 'OTHER')).toBe(false));

    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'PAID', displayToken: 'station-display-token' }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'lobby' && message.roomCode === 'PAID')).toBe(true));
    expect(server.hasStandaloneDisplay(serverSocket, 'PAID')).toBe(false);

    display.ws.close();
    await new Promise<void>(resolve => display.ws.once('close', () => resolve()));
    expect(server.hasStandaloneDisplay(serverSocket, 'PAID')).toBe(false);
  });

  it('releases old room and roster bindings when one socket switches identity', async () => {
    server = new GameServer({ port: 0 });
    const port = await server.start();
    const client = connect(port); await client.open();
    const serverSocket = [...(server as unknown as { conns: Set<{ ws: WebSocket }> }).conns][0]!.ws;

    client.ws.send(JSON.stringify({ type: 'join', roomCode: 'FIRST', name: 'Ada' }));
    await vi.waitFor(() => expect(client.inbox.some(message => message.type === 'joined' && message.roomCode === 'FIRST')).toBe(true));
    expect(server.findRoom('FIRST')?.lobbyPlayers()).toHaveLength(1);

    client.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'SECOND' }));
    await vi.waitFor(() => expect(client.inbox.some(message => message.type === 'lobby' && message.roomCode === 'SECOND')).toBe(true));
    expect(server.findRoom('FIRST')).toBeUndefined();
    expect(server.findRoom('SECOND')?.lobbyPlayers()).toEqual([]);
    expect(server.hasStandaloneDisplay(serverSocket, 'SECOND')).toBe(true);

    client.ws.send(JSON.stringify({ type: 'join', roomCode: 'THIRD', name: 'Ada' }));
    await vi.waitFor(() => expect(client.inbox.some(message => message.type === 'joined' && message.roomCode === 'THIRD')).toBe(true));
    expect(server.findRoom('SECOND')).toBeUndefined();
    expect(server.findRoom('THIRD')?.lobbyPlayers()).toHaveLength(1);
    expect(server.hasStandaloneDisplay(serverSocket, 'THIRD')).toBe(false);
    client.ws.close();
  });

  it('parses phase-bound display selections and rejects malformed target seats', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'display_select_car', roomCode: 'RACE', expectedPhase: 'car_select', forPlayerId: 'p1', carIndex: 2 })))
      .toEqual({ type: 'display_select_car', roomCode: 'RACE', expectedPhase: 'car_select', forPlayerId: 'p1', carIndex: 2 });
    expect(parseClientMessage(JSON.stringify({ type: 'display_select_map', roomCode: 'RACE', expectedPhase: 'map_select', forPlayerId: 'p1', map: 'Drift' })))
      .toEqual({ type: 'display_select_map', roomCode: 'RACE', expectedPhase: 'map_select', forPlayerId: 'p1', map: 'Drift' });
    expect(parseClientMessage(JSON.stringify({ type: 'display_select_car', roomCode: 'RACE', expectedPhase: 'car_select', carIndex: 2 })))
      .toMatchObject({ type: 'error' });
  });

  it('uses 30Hz snapshots by default',()=>{expect(RACER_BROADCAST_HZ).toBe(30);});
  it('a client can join and receive a joined ack with a lane', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '4821', name: 'You' }));
    await wait(100);
    const joined = c.inbox.find(m => m.type === 'joined') as any;
    expect(joined).toBeDefined();
    expect(joined.lane).toBe(0);
    expect(joined.roomCode).toBe('4821');
  });

  it('after ready, the client receives items then snapshots', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '5000', name: 'You' }));
    await wait(50);
    c.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(200);
    expect(c.inbox.some(m => m.type === 'items')).toBe(true);
    expect(c.inbox.some(m => m.type === 'snapshot')).toBe(true);
    expect(c.inbox.find(m=>m.type==='snapshot')?.snapshot.items).toEqual([]);
  });

  it('sends course items to a player joining a live race',async()=>{
    server=new GameServer({port:0});const port=await server.start(),first=connect(port);await first.open();
    first.ws.send(JSON.stringify({type:'join',roomCode:'LATE',name:'Ada'}));await wait(20);
    first.ws.send(JSON.stringify({type:'ready'}));await wait(50);
    const late=connect(port);await late.open();late.ws.send(JSON.stringify({type:'join',roomCode:'LATE',name:'Bo'}));await wait(50);
    expect(late.inbox.some(message=>message.type==='items'&&message.items.length>0)).toBe(true);
  });

  it('holds a station countdown until its authenticated display finishes renderer warmup', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30, displayToken: 'station-display-token' });
    let starts = 0; server.setOnRaceStarted(() => { starts += 1; });
    server.setBrowserPlayerAdmission(() => false);
    server.setRoomConfigProvider(() => ({ carCount: 2, maps: ['Silver Lake'] }));
    const port = await server.start();
    const room = server.getOrCreateRoom('WARMUP');
    room.expectHumanPlayers(1);
    const player = room.addPlayer('Ada', undefined, 0); if ('error' in player) throw new Error(player.error);
    expect(server.voiceAdvance('WARMUP', player.playerId)).toBe(true);
    expect(server.voiceSelectCar('WARMUP', player.playerId, 0)).toBe(true);
    expect(server.voiceAdvance('WARMUP', player.playerId)).toBe(true);
    expect(server.voiceSelectMap('WARMUP', 'Silver Lake', player.playerId)).toBe(true);
    expect(server.voiceAdvance('WARMUP', player.playerId)).toBe(true);
    const before = room.snapshot()!.countdown;
    server.stepRoomForTest(room, 2);
    expect(room.snapshot()!.countdown).toBe(before);
    expect(starts).toBe(0);
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({
      type: 'spectate', roomCode: 'WARMUP', displayToken: 'station-display-token',
    }));
    await wait(30);
    server.stepRoomForTest(room, 1);
    expect(room.snapshot()!.countdown).toBe(before);
    expect(starts).toBe(0);
    display.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(30);
    server.stepRoomForTest(room, .5);
    expect(room.snapshot()!.countdown).toBeLessThan(before);
    expect(starts).toBe(1);
    const staleDisplay = connect(port); await staleDisplay.open();
    staleDisplay.ws.send(JSON.stringify({
      type: 'spectate', roomCode: 'WARMUP', displayToken: 'station-display-token',
    }));
    await wait(30);
    staleDisplay.ws.close();
    await wait(30);
    const beforeStaleClose = room.snapshot()!.countdown;
    server.stepRoomForTest(room, .25);
    expect(room.snapshot()!.countdown).toBeLessThan(beforeStaleClose);
    display.ws.close();
    await wait(30);
    const beforeDisconnect = room.snapshot()!.countdown;
    server.stepRoomForTest(room, 1);
    expect(room.snapshot()!.countdown).toBe(beforeDisconnect);
  });

  it('holds a standalone countdown for its displayed map, then starts on display readiness', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    let starts = 0;
    server.setOnRaceStarted(() => { starts += 1; });
    const port = await server.start();
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'SOLO-MAP' }));
    const player = connect(port); await player.open();
    player.ws.send(JSON.stringify({ type: 'join', roomCode: 'SOLO-MAP', name: 'Ada', rendererReadyGate: true }));
    await wait(30);
    player.ws.send(JSON.stringify({ type: 'ready' }));
    await vi.waitFor(() => expect(server.findRoom('SOLO-MAP')?.phase).toBe('countdown'));
    const room = server.findRoom('SOLO-MAP')!;
    const before = room.snapshot()!.countdown;
    server.stepRoomForTest(room, 1);
    expect(room.snapshot()!.countdown).toBe(before);
    expect(starts).toBe(0);
    expect(display.inbox.some(message => message.type === 'items')).toBe(true);

    // A player saying start again cannot release the display's loading hold.
    player.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(20);
    expect(room.snapshot()!.countdown).toBe(before);
    display.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(20);
    server.stepRoomForTest(room, .5);
    expect(room.snapshot()!.countdown).toBeLessThan(before);
    expect(starts).toBe(1);
    player.ws.close(); display.ws.close();
  });

  it('releases a standalone countdown after the bounded map-loading timeout', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'SLOW-MAP' }));
    const player = connect(port); await player.open();
    player.ws.send(JSON.stringify({ type: 'join', roomCode: 'SLOW-MAP', name: 'Ada' }));
    await wait(30);
    player.ws.send(JSON.stringify({ type: 'ready' }));
    await vi.waitFor(() => expect(server.findRoom('SLOW-MAP')?.phase).toBe('countdown'));
    const room = server.findRoom('SLOW-MAP')!;
    const before = room.snapshot()!.countdown;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + RACER_STANDALONE_RENDER_READY_TIMEOUT_MS + 1);
    try {
      server.stepRoomForTest(room, .5);
      expect(room.snapshot()!.countdown).toBeLessThan(before);
    } finally { clock.mockRestore(); }
    player.ws.close(); display.ws.close();
  });

  it('lets a local browser player prepare the map when no shared display is attached', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const player = connect(port); await player.open();
    player.ws.send(JSON.stringify({ type: 'join', roomCode: 'LOCAL-MAP', name: 'Ada', rendererReadyGate: true }));
    await wait(20);
    player.ws.send(JSON.stringify({ type: 'ready' }));
    await vi.waitFor(() => expect(server.findRoom('LOCAL-MAP')?.phase).toBe('countdown'));
    const room = server.findRoom('LOCAL-MAP')!;
    const before = room.snapshot()!.countdown;
    server.stepRoomForTest(room, .5);
    expect(room.snapshot()!.countdown).toBe(before);

    player.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(20);
    server.stepRoomForTest(room, .5);
    expect(room.snapshot()!.countdown).toBeLessThan(before);
    player.ws.close();
  });

  it('applies shared-screen taps only to the current station caller seat and current menu', async () => {
    server = new GameServer({ port: 0, displayToken: 'station-display-token' });
    const events: GameEvent[] = [];
    server.setOnRoomEvents((_roomCode, emitted) => events.push(...emitted));
    server.setBrowserPlayerAdmission(() => false);
    server.setRoomConfigProvider(() => ({ carCount: 3, maps: ['Silver Lake', 'Drift'] }));
    const port = await server.start();
    const room = server.getOrCreateRoom('TAP');
    room.expectHumanPlayers(2);
    const ada = room.addPlayer('Ada', undefined, 0) as { playerId: string };
    const rex = room.addPlayer('Rex', undefined, 1) as { playerId: string };
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'TAP', displayToken: 'station-display-token' }));
    await wait(30);
    display.ws.send(JSON.stringify({ type: 'display_advance', roomCode: 'TAP', expectedPhase: 'lobby', forPlayerId: ada.playerId }));
    await wait(30);
    expect(room.phase).toBe('car_select');
    expect((display.inbox.find(message => message.type === 'select_state') as any).touch.activePlayerId).toBe(ada.playerId);

    display.ws.send(JSON.stringify({ type: 'display_select_car', roomCode: 'TAP', expectedPhase: 'car_select', forPlayerId: rex.playerId, carIndex: 2 }));
    await wait(30);
    expect(room.lobbyPlayers().map(player => player.carIndex)).toEqual([null, null]);
    display.ws.send(JSON.stringify({ type: 'display_select_car', roomCode: 'TAP', expectedPhase: 'car_select', forPlayerId: ada.playerId, carIndex: 1 }));
    await wait(30);
    expect(room.lobbyPlayers().map(player => player.carIndex)).toEqual([1, null]);
    display.ws.send(JSON.stringify({ type: 'display_select_car', roomCode: 'TAP', expectedPhase: 'car_select', forPlayerId: ada.playerId, carIndex: 0 }));
    display.ws.send(JSON.stringify({ type: 'display_select_car', roomCode: 'TAP', expectedPhase: 'car_select', forPlayerId: rex.playerId, carIndex: 2 }));
    await wait(30);
    expect(room.lobbyPlayers().map(player => player.carIndex)).toEqual([1, 2]);
    display.ws.send(JSON.stringify({ type: 'display_advance', roomCode: 'TAP', expectedPhase: 'lobby', forPlayerId: ada.playerId }));
    await wait(30);
    expect(room.phase).toBe('car_select');
    display.ws.send(JSON.stringify({ type: 'display_advance', roomCode: 'TAP', expectedPhase: 'car_select', forPlayerId: ada.playerId }));
    await wait(30);
    expect(room.phase).toBe('map_select');
    display.ws.send(JSON.stringify({ type: 'display_select_map', roomCode: 'TAP', expectedPhase: 'map_select', forPlayerId: rex.playerId, map: 'Drift' }));
    await wait(30);
    expect(room.mapVotes().counts).toEqual({});
    display.ws.send(JSON.stringify({ type: 'display_select_map', roomCode: 'TAP', expectedPhase: 'map_select', forPlayerId: ada.playerId, map: 'Drift' }));
    display.ws.send(JSON.stringify({ type: 'display_select_map', roomCode: 'TAP', expectedPhase: 'map_select', forPlayerId: rex.playerId, map: 'Silver Lake' }));
    await wait(30);
    expect(room.mapVotes().counts).toEqual({ Drift: 1, 'Silver Lake': 1 });
    const touchVote = events.filter(event => event.kind === 'map_picked').at(-1);
    expect(touchVote).toMatchObject({ kind: 'map_picked', map: 'Silver Lake', playerId: rex.playerId });
    expect(touchVote).not.toHaveProperty('spokenReplyPlayerId');
    expect(server.voiceSelectMap('TAP', 'Silver Lake', ada.playerId, true)).toBe(true);
    expect(events.filter(event => event.kind === 'map_picked').at(-1)).toMatchObject({
      kind: 'map_picked', map: 'Silver Lake', playerId: ada.playerId, spokenReplyPlayerId: ada.playerId,
    });
  });

  it('holds results on a connected display after the last voice caller leaves, then admits a new round', async () => {
    server = new GameServer({ port: 0 });
    server.setRoomConfigProvider(() => ({ carCount: 1, maps: ['Silver Lake'] }));
    const port = await server.start();
    const room = server.getOrCreateRoom('SCORE-HOLD');
    const first = room.addPlayer('Ada') as { playerId: string };
    room.start();
    for (let i = 0; i < 60 * 120 && room.phase !== 'results'; i++) room.tick(STEP);
    expect(room.phase).toBe('results');
    const standings = room.results();

    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: room.code }));
    await wait(30);
    server.voiceLeave(room.code, first.playerId);
    await wait(30);
    expect(room.phase).toBe('results');
    expect(room.results()).toEqual(standings);
    expect([...display.inbox].reverse().find(message => message.type === 'results'))
      .toMatchObject({ type: 'results', touch: { canAdvance: false } });

    const next = room.addPlayer('Bo') as { playerId: string };
    server.voiceSetupChanged(room.code, 'results');
    await wait(30);
    expect([...display.inbox].reverse().find(message => message.type === 'results'))
      .toMatchObject({ type: 'results', touch: { canAdvance: true, advancePlayerId: null } });
    display.ws.send(JSON.stringify({ type: 'display_advance', roomCode: room.code, expectedPhase: 'results' }));
    await wait(30);
    expect(room.phase).toBe('lobby');
    expect(room.lobbyPlayers().map(player => player.playerId)).toEqual([next.playerId]);
    display.ws.close();
  });

  it('restores a finished standalone race after a brief display outage, then reaps it after the grace period', async () => {
    server = new GameServer({ port: 0, resultReconnectGraceMs: 300 });
    server.setRoomConfigProvider(() => ({ carCount: 1, maps: ['Silver Lake'] }));
    const port = await server.start();
    const room = server.getOrCreateRoom('RACE-RECONNECT');
    const player = room.addPlayer('Ada') as { playerId: string };
    room.start();
    for (let index = 0; index < 60 * 120 && room.phase !== 'results'; index++) room.tick(STEP);
    expect(room.phase).toBe('results');
    const finished = room.results();
    const first = connect(port); await first.open();
    first.ws.send(JSON.stringify({ type: 'spectate', roomCode: room.code }));
    await vi.waitFor(() => expect(first.inbox.some(message => message.type === 'results')).toBe(true));
    server.voiceLeave(room.code, player.playerId);
    first.ws.close();
    await new Promise<void>(resolve => first.ws.once('close', () => resolve()));
    expect(server.findRoom(room.code)).toBe(room);

    const restored = connect(port); await restored.open();
    restored.ws.send(JSON.stringify({ type: 'spectate', roomCode: room.code }));
    await vi.waitFor(() => expect(restored.inbox.some(message => message.type === 'results')).toBe(true));
    expect(room.results()).toEqual(finished);
    await wait(350);
    expect(server.findRoom(room.code)).toBe(room);

    restored.ws.close();
    await new Promise<void>(resolve => restored.ws.once('close', () => resolve()));
    await vi.waitFor(() => expect(server.findRoom(room.code)).toBeUndefined());
  });

  it('enables a results Replay tap only for a caller allowed to advance that round', async () => {
    server = new GameServer({ port: 0 });
    server.setRoomConfigProvider(() => ({ carCount: 1, maps: ['Silver Lake'] }));
    const port = await server.start();
    const room = server.getOrCreateRoom('LATE-REPLAY');
    const current = room.addPlayer('Ada') as { playerId: string };
    room.start();
    for (let i = 0; i < 60 * 120 && room.phase !== 'results'; i++) room.tick(STEP);
    expect(room.phase).toBe('results');

    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: room.code }));
    const late = connect(port); await late.open();
    late.ws.send(JSON.stringify({ type: 'join', roomCode: room.code, name: 'Bo' }));
    await vi.waitFor(() => expect(late.inbox.some(message => message.type === 'results')).toBe(true));
    const lateId = (late.inbox.find(message => message.type === 'joined') as { playerId: string }).playerId;
    expect(room.isWaitingForNextRound(lateId)).toBe(true);
    expect(room.canAdvance(current.playerId)).toBe(true);
    expect(room.canAdvance(lateId)).toBe(false);
    expect([...late.inbox].reverse().find(message => message.type === 'results'))
      .toMatchObject({ touch: { canAdvance: false } });
    expect([...display.inbox].reverse().find(message => message.type === 'results'))
      .toMatchObject({ touch: { canAdvance: true, advancePlayerId: current.playerId } });

    // The display must use the phase-bound touch action; a generic player
    // command without a player identity cannot skip that authorization.
    display.ws.send(JSON.stringify({ type: 'advance' }));
    await wait(30);
    expect(room.phase).toBe('results');
    late.ws.send(JSON.stringify({ type: 'advance' }));
    await wait(30);
    expect(room.phase).toBe('results');
    display.ws.send(JSON.stringify({ type: 'display_advance', roomCode: room.code,
      expectedPhase: 'results', forPlayerId: current.playerId }));
    await vi.waitFor(() => expect(room.phase).toBe('lobby'));
    display.ws.close();
    late.ws.close();
  });

  it('two clients in the same room both appear in the snapshot', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    server.setRoomConfigProvider(() => ({ carCount: 2, maps: ['Silver Lake'] }));
    const port = await server.start();
    const a = connect(port); await a.open();
    const b = connect(port); await b.open();
    a.ws.send(JSON.stringify({ type: 'join', roomCode: '7777', name: 'You' }));
    b.ws.send(JSON.stringify({ type: 'join', roomCode: '7777', name: 'Ada' }));
    await wait(50);
    a.ws.send(JSON.stringify({ type: 'advance' }));
    await vi.waitFor(() => expect(server.findRoom('7777')?.phase).toBe('car_select'));
    a.ws.send(JSON.stringify({ type: 'select_car', carIndex: 0 }));
    b.ws.send(JSON.stringify({ type: 'select_car', carIndex: 1 }));
    await vi.waitFor(() => expect(server.findRoom('7777')?.lobbyPlayers().every(player => player.carIndex !== null)).toBe(true));
    a.ws.send(JSON.stringify({ type: 'advance' }));
    await vi.waitFor(() => expect(server.findRoom('7777')?.phase).toBe('map_select'));
    a.ws.send(JSON.stringify({ type: 'select_map', map: 'Silver Lake' }));
    b.ws.send(JSON.stringify({ type: 'select_map', map: 'Silver Lake' }));
    await vi.waitFor(() => expect(server.findRoom('7777')?.allMapVotesComplete).toBe(true));
    a.ws.send(JSON.stringify({ type: 'advance' }));
    await vi.waitFor(() => expect(server.findRoom('7777')?.phase).toBe('countdown'));
    await vi.waitFor(() => expect(a.inbox.some(message => message.type === 'snapshot')).toBe(true));
    const snap = [...a.inbox].reverse().find(m => m.type === 'snapshot') as any;
    expect(snap.snapshot.cars).toHaveLength(2);
  });

  it('events reach all clients in a room, not just the first', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    server.setRoomConfigProvider(() => ({ carCount: 2, maps: ['Silver Lake'] }));
    const port = await server.start();
    const a = connect(port); await a.open();
    const b = connect(port); await b.open();
    a.ws.send(JSON.stringify({ type: 'join', roomCode: '9090', name: 'You' }));
    b.ws.send(JSON.stringify({ type: 'join', roomCode: '9090', name: 'Ada' }));
    await wait(50);
    a.ws.send(JSON.stringify({ type: 'advance' }));
    await vi.waitFor(() => expect(server.findRoom('9090')?.phase).toBe('car_select'));
    a.ws.send(JSON.stringify({ type: 'select_car', carIndex: 0 }));
    b.ws.send(JSON.stringify({ type: 'select_car', carIndex: 1 }));
    await vi.waitFor(() => expect(server.findRoom('9090')?.allCarChoicesComplete).toBe(true));
    a.ws.send(JSON.stringify({ type: 'advance' }));
    await vi.waitFor(() => expect(server.findRoom('9090')?.phase).toBe('map_select'));
    a.ws.send(JSON.stringify({ type: 'select_map', map: 'Silver Lake' }));
    b.ws.send(JSON.stringify({ type: 'select_map', map: 'Silver Lake' }));
    await vi.waitFor(() => expect(server.findRoom('9090')?.allMapVotesComplete).toBe(true));
    a.ws.send(JSON.stringify({ type: 'advance' }));
    await vi.waitFor(() => expect(server.findRoom('9090')?.phase).toBe('countdown'));
    await vi.waitFor(() => expect(a.inbox.some(message => message.type === 'event')
      && b.inbox.some(message => message.type === 'event')).toBe(true));
    expect(a.inbox.some(m => m.type === 'event')).toBe(true);
    expect(b.inbox.some(m => m.type === 'event')).toBe(true);
  });

  it('two players in lobby both receive a lobby roster with both names', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const a = connect(port); await a.open();
    const b = connect(port); await b.open();
    a.ws.send(JSON.stringify({ type: 'join', roomCode: '8200', name: 'Ada' }));
    b.ws.send(JSON.stringify({ type: 'join', roomCode: '8200', name: 'Rex' }));
    await wait(250);
    const lob = [...b.inbox].reverse().find((m: any) => m.type === 'lobby') as any;
    expect(lob).toBeDefined();
    const names = lob.players.map((p: any) => p.name).sort();
    expect(names).toEqual(['Ada', 'Rex']);
    expect(lob.phase).toBe('lobby');
  });

  it('a spectator occupies no roster slot (shared screen is not a phantom player)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const screen = connect(port); await screen.open();
    screen.ws.send(JSON.stringify({ type: 'spectate', roomCode: '6100' }));
    await wait(150);
    const lob = [...screen.inbox].reverse().find((m: any) => m.type === 'lobby') as any;
    expect(lob).toBeDefined();
    expect(lob.players).toEqual([]);   // spectating display adds NO player
  });

  it('leave drops the player slot but keeps the connection (play-toggle off)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '6200', name: 'Tester' }));
    await wait(120);
    let lob = [...c.inbox].reverse().find((m: any) => m.type === 'lobby') as any;
    expect(lob.players.map((p: any) => p.name)).toEqual(['Tester']);
    c.inbox.length = 0;
    c.ws.send(JSON.stringify({ type: 'leave' }));
    await wait(120);
    lob = [...c.inbox].reverse().find((m: any) => m.type === 'lobby') as any;
    expect(lob).toBeDefined();           // still connected → still receives lobby broadcasts
    expect(lob.players).toEqual([]);     // but no longer a player
  });

  it('transfers a rapid P-on to the same keyboard seat before the old socket closes', async () => {
    server = new GameServer({ port: 0 });
    server.setRoomConfigProvider(() => ({ carCount: 1, maps: ['Silver Lake'] }));
    const port = await server.start();
    server.voiceConfigureStandaloneSeats('P-TOGGLE', 1);
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'P-TOGGLE' }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'lobby')).toBe(true));

    const old = connect(port); await old.open();
    old.ws.send(JSON.stringify({ type: 'join', roomCode: 'P-TOGGLE', name: 'Keyboard',
      keyboardSession: { id: '0123456789abcdef0123456789abcdef', generation: 1 } }));
    await vi.waitFor(() => expect(old.inbox.some(message => message.type === 'joined')).toBe(true));
    const original = old.inbox.find(message => message.type === 'joined');
    if (!original || original.type !== 'joined') throw new Error('missing original join');
    const room = server.findRoom('P-TOGGLE')!;
    expect(room.advance(original.playerId)).toBe(true);
    expect(room.selectCar(original.playerId, 0)).toBe(true);
    expect(room.advance(original.playerId)).toBe(true);
    expect(room.selectMap('Silver Lake', original.playerId)).toBe(true);
    expect(room.advance(original.playerId)).toBe(true);
    for (let step = 0; step < 2000 && room.phase !== 'racing'; step++) room.tick(STEP);
    expect(room.phase).toBe('racing');
    const oldBinding = [...(server as unknown as { conns: Set<{ playerId?: string }> }).conns]
      .find(conn => conn.playerId === original.playerId)!;

    // The new socket's join reaches the server before the old socket's leave/close.
    const next = connect(port); await next.open();
    next.ws.send(JSON.stringify({ type: 'join', roomCode: 'P-TOGGLE', name: 'Keyboard',
      keyboardSession: { id: '0123456789abcdef0123456789abcdef', generation: 2 } }));
    await vi.waitFor(() => expect(next.inbox.some(message => message.type === 'joined'
      || message.type === 'error')).toBe(true));
    expect(next.inbox.find(message => message.type === 'joined')).toMatchObject({
      playerId: original.playerId, roomCode: 'P-TOGGLE',
    });
    expect(server.findRoom('P-TOGGLE')?.lobbyPlayers().map(player => player.name)).toEqual(['Keyboard']);
    expect(room.phase).toBe('racing');

    display.ws.send(JSON.stringify({ type: 'release_keyboard_session', roomCode: 'P-TOGGLE',
      keyboardSession: { id: '0123456789abcdef0123456789abcdef', generation: 1 } }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'keyboard_session_released')).toBe(true));
    expect(room.lobbyPlayers().map(player => player.playerId)).toEqual([original.playerId]);

    // A queued old leave and its later close must not remove the transferred player.
    (server as unknown as { onMessage: (conn: unknown, raw: string) => void })
      .onMessage(oldBinding, JSON.stringify({ type: 'leave' }));
    old.ws.close();
    await vi.waitFor(() => expect(old.ws.readyState).toBe(WebSocket.CLOSED));
    expect(server.findRoom('P-TOGGLE')?.lobbyPlayers().map(player => player.playerId))
      .toEqual([original.playerId]);
    expect(room.phase).toBe('racing');
    display.ws.close(); next.ws.close();
  });

  it('releases the keyboard seat through the live display if the player socket never closes', async () => {
    server = new GameServer({ port: 0 });
    const port = await server.start();
    server.voiceConfigureStandaloneSeats('P-RELEASE', 1);
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'P-RELEASE' }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'lobby')).toBe(true));
    const keyboard = connect(port); await keyboard.open();
    keyboard.ws.send(JSON.stringify({ type: 'join', roomCode: 'P-RELEASE', name: 'Keyboard',
      keyboardSession: { id: '11111111111111111111111111111111', generation: 1 } }));
    await vi.waitFor(() => expect(keyboard.inbox.some(message => message.type === 'joined')).toBe(true));

    // No leave or close is sent from the old keyboard connection.
    display.ws.send(JSON.stringify({ type: 'release_keyboard_session', roomCode: 'P-RELEASE',
      keyboardSession: { id: '11111111111111111111111111111111', generation: 1 } }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'keyboard_session_released')).toBe(true));
    expect(server.findRoom('P-RELEASE')?.playerCount).toBe(0);
    expect(server.connectionCount).toBeGreaterThanOrEqual(1);
    const phone = server.findRoom('P-RELEASE')?.addPlayer('Phone caller');
    expect(phone).not.toHaveProperty('error');
    if (!phone || 'error' in phone) throw new Error('phone caller could not join');
    display.ws.send(JSON.stringify({ type: 'release_keyboard_session', roomCode: 'P-RELEASE',
      keyboardSession: { id: '11111111111111111111111111111111', generation: 2 } }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'keyboard_session_released'
      && message.keyboardSession.generation === 2)).toBe(true));
    expect(server.findRoom('P-RELEASE')?.lobbyPlayers().map(player => player.playerId))
      .toEqual([phone.playerId]);
    display.ws.close(); keyboard.ws.close();
  });

  it('blocks a delayed old keyboard join after its display already released that toggle', async () => {
    server = new GameServer({ port: 0 });
    const port = await server.start();
    server.voiceConfigureStandaloneSeats('P-EARLY', 1);
    const display = connect(port); await display.open();
    display.ws.send(JSON.stringify({ type: 'spectate', roomCode: 'P-EARLY' }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'lobby')).toBe(true));
    display.ws.send(JSON.stringify({ type: 'release_keyboard_session', roomCode: 'P-EARLY',
      keyboardSession: { id: '22222222222222222222222222222222', generation: 1 } }));
    await vi.waitFor(() => expect(display.inbox.some(message => message.type === 'keyboard_session_released')).toBe(true));

    const delayed = connect(port); await delayed.open();
    delayed.ws.send(JSON.stringify({ type: 'join', roomCode: 'P-EARLY', name: 'Stale keyboard',
      keyboardSession: { id: '22222222222222222222222222222222', generation: 1 } }));
    await vi.waitFor(() => expect(delayed.inbox.some(message => message.type === 'error')).toBe(true));
    expect(server.findRoom('P-EARLY')?.playerCount).toBe(0);
    const fresh = connect(port); await fresh.open();
    fresh.ws.send(JSON.stringify({ type: 'join', roomCode: 'P-EARLY', name: 'Keyboard',
      keyboardSession: { id: '22222222222222222222222222222222', generation: 2 } }));
    await vi.waitFor(() => expect(fresh.inbox.some(message => message.type === 'joined')).toBe(true));
    expect(server.findRoom('P-EARLY')?.lobbyPlayers().map(player => player.name)).toEqual(['Keyboard']);
    display.ws.close(); delayed.ws.close(); fresh.ws.close();
  });

  it('ignores an older keyboard join delivered after its replacement', async () => {
    server = new GameServer({ port: 0 });
    const port = await server.start();
    server.voiceConfigureStandaloneSeats('P-ORDER', 2);
    const newer = connect(port); await newer.open();
    newer.ws.send(JSON.stringify({ type: 'join', roomCode: 'P-ORDER', name: 'Keyboard',
      keyboardSession: { id: 'fedcba9876543210fedcba9876543210', generation: 2 } }));
    await vi.waitFor(() => expect(newer.inbox.some(message => message.type === 'joined')).toBe(true));
    const joined = newer.inbox.find(message => message.type === 'joined');
    if (!joined || joined.type !== 'joined') throw new Error('missing newer join');

    const older = connect(port); await older.open();
    older.ws.send(JSON.stringify({ type: 'join', roomCode: 'P-ORDER', name: 'Stale keyboard',
      keyboardSession: { id: 'fedcba9876543210fedcba9876543210', generation: 1 } }));
    await vi.waitFor(() => expect(older.inbox.some(message => message.type === 'error')).toBe(true));
    expect(server.findRoom('P-ORDER')?.lobbyPlayers().map(player => player.playerId))
      .toEqual([joined.playerId]);
    newer.ws.close(); older.ws.close();
  });

  it('does not replace a caller or a different keyboard session at capacity', async () => {
    server = new GameServer({ port: 0 });
    const port = await server.start();
    server.voiceConfigureStandaloneSeats('P-CALLER', 1);
    server.voiceConfigureStandaloneSeats('P-OTHER', 1);
    const callerRoom = server.findRoom('P-CALLER')!;
    const caller = callerRoom.addPlayer('Phone caller') as { playerId: string };
    callerRoom.registerVoicePlayer(caller.playerId);
    const first = connect(port); await first.open();
    first.ws.send(JSON.stringify({ type: 'join', roomCode: 'P-OTHER', name: 'Other keyboard',
      keyboardSession: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', generation: 1 } }));
    await vi.waitFor(() => expect(first.inbox.some(message => message.type === 'joined')).toBe(true));

    const second = connect(port); await second.open();
    second.ws.send(JSON.stringify({ type: 'join', roomCode: 'P-OTHER', name: 'New tab',
      keyboardSession: { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', generation: 1 } }));
    const third = connect(port); await third.open();
    third.ws.send(JSON.stringify({ type: 'join', roomCode: 'P-CALLER', name: 'Keyboard',
      keyboardSession: { id: 'cccccccccccccccccccccccccccccccc', generation: 1 } }));
    await vi.waitFor(() => expect(second.inbox.some(message => message.type === 'error')).toBe(true));
    await vi.waitFor(() => expect(third.inbox.some(message => message.type === 'error')).toBe(true));
    expect(server.findRoom('P-OTHER')?.lobbyPlayers().map(player => player.name)).toEqual(['Other keyboard']);
    expect(callerRoom.lobbyPlayers().map(player => player.playerId)).toEqual([caller.playerId]);
    first.ws.close(); second.ws.close(); third.ws.close();
  });

  it('reclaims a room once its last player disconnects (no leak)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '3030', name: 'You' }));
    await wait(80);
    expect(server.roomCount).toBe(1);
    c.ws.close();
    await wait(120);
    expect(server.roomCount).toBe(0);
  });

  it('voiceLeave reaps a voice-only room (a phone caller never hits the WS reap path)', async () => {
    // A caller who joined ONLY by voice (no /game WS conn) must still reap on hangup, or the room leaks.
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const room = server.getOrCreateRoom('9090');
    const res = room.addPlayer('Caller') as { playerId: string };
    expect(server.roomCount).toBe(1);
    server.voiceLeave('9090', res.playerId);   // caller hangs up
    expect(server.roomCount).toBe(0);          // reaped, no leak
  });

  it('restart rebuilds a fresh race with a NEW procedural course (per-race variety)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const c = connect(port); await c.open();
    c.ws.send(JSON.stringify({ type: 'join', roomCode: '3131', name: 'You' }));
    await wait(50);
    c.ws.send(JSON.stringify({ type: 'ready' }));
    await wait(150);
    const first = [...c.inbox].reverse().find(m => m.type === 'items') as any;
    const firstSig = JSON.stringify(first.items);
    // Host hits restart (the 'r' key) — must reroll to a different course, not replay the same one.
    c.ws.send(JSON.stringify({ type: 'restart' }));
    await wait(150);
    const items2 = [...c.inbox].filter(m => m.type === 'items') as any[];
    const secondSig = JSON.stringify(items2[items2.length - 1].items);
    expect(items2.length).toBeGreaterThanOrEqual(2);   // restart sent a fresh items message
    expect(secondSig).not.toEqual(firstSig);            // and the course actually changed
  });

  it('a spectator receives snapshots without occupying a player slot', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    const port = await server.start();
    const player = connect(port); await player.open();
    const spec = connect(port); await spec.open();
    player.ws.send(JSON.stringify({ type:'join', roomCode:'8800', name:'P1' }));
    spec.ws.send(JSON.stringify({ type:'spectate', roomCode:'8800' }));
    await wait(50);
    player.ws.send(JSON.stringify({ type:'ready' }));
    await wait(200);
    const snap = [...spec.inbox].reverse().find(m => m.type === 'snapshot') as any;
    expect(snap).toBeDefined();
    expect(snap.snapshot.cars).toHaveLength(1);  // spectator added no car
  });

  it('drives the Smash-style flow over the wire: select car → map → race with chosen model', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    server.setRoomConfigProvider(() => ({ carCount: 19, maps: ['Silver Lake', 'Neon City'] }));
    const port = await server.start();
    const host = connect(port); await host.open();
    host.ws.send(JSON.stringify({ type: 'join', roomCode: 'SMASH', name: 'Ada' }));
    await wait(60);
    host.ws.send(JSON.stringify({ type: 'advance' }));                  // → car_select
    await wait(60);
    const sel = [...host.inbox].reverse().find((m: any) => m.type === 'select_state') as any;
    expect(sel).toBeDefined();
    expect(sel.phase).toBe('car_select');
    expect(sel.maps).toEqual(['Silver Lake', 'Neon City']);
    host.ws.send(JSON.stringify({ type: 'select_car', carIndex: 12 }));
    await wait(60);
    host.ws.send(JSON.stringify({ type: 'advance' }));                  // → map_select
    await wait(60);
    host.ws.send(JSON.stringify({ type: 'select_map', map: 'Neon City' }));
    await wait(60);
    host.ws.send(JSON.stringify({ type: 'advance' }));                  // → race
    await wait(200);
    const snap = [...host.inbox].reverse().find((m: any) => m.type === 'snapshot') as any;
    expect(snap).toBeDefined();
    expect(snap.snapshot.cars[0].carIndex).toBe(12);                    // raced the chosen model
  });

  it('fires onRaceFinished EXACTLY ONCE when a race reaches results (leaderboard persistence)', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    server.setRoomConfigProvider(() => ({ carCount: 19, maps: ['Silver Lake'] }));
    let fired = 0; let reportedMap: string | null = null; let reportedResults: any[] = [];
    server.setOnRaceFinished((room) => { fired++; reportedMap = room.selectedMap; reportedResults = room.results(); });
    const port = await server.start();
    // Build a solo race directly on the room (fast — sync), then drive stepRoom to completion.
    const room = server.getOrCreateRoom('FINISH');
    room.addPlayer('Solo');
    room.advance(); room.selectCar(room.lobbyPlayers()[0]!.playerId, 4);
    room.advance(); room.selectMap('Silver Lake'); room.advance();
    // Pump the sim via the SAME stepRoom path the loop uses, in big dt slices, until results.
    for (let i = 0; i < 2000 && room.phase !== 'results'; i++) server.stepRoomForTest(room, 0.1);
    expect(room.phase).toBe('results');
    // a few more steps in results must NOT re-fire the report
    for (let i = 0; i < 5; i++) server.stepRoomForTest(room, 0.1);
    expect(fired).toBe(1);
    expect(reportedMap).toBe('Silver Lake');
    expect(reportedResults[0]).toMatchObject({ name: 'Solo', place: 1, carIndex: 4, finished: true });
  });

  it('reports authoritative race starts and abandonment once', async () => {
    server = new GameServer({ port: 0 });
    server.setRoomConfigProvider(() => ({ carCount: 2, maps: ['Silver Lake'] }));
    let starts = 0, abandoned = 0;
    server.setOnRaceStarted(() => starts++); server.setOnRaceAbandoned(() => abandoned++);
    await server.start();
    const room = server.getOrCreateRoom('DROP'); const joined = room.addPlayer('Solo') as { playerId: string };
    room.advance(); room.selectCar(joined.playerId, 0); room.advance(); room.selectMap('Silver Lake'); room.advance();
    server.stepRoomForTest(room, 0.1); expect(starts).toBe(1);
    room.removePlayer(joined.playerId); server.stepRoomForTest(room, 0.1); server.stepRoomForTest(room, 0.1);
    expect(abandoned).toBe(1);
  });

  it('broadcasts the selected map after no-show recovery and explicit caller advance',async()=>{
    server=new GameServer({port:0,broadcastHz:30});server.setRoomConfigProvider(()=>({carCount:2,maps:['Silver Lake']}));
    let starts=0;server.setOnRaceStarted(()=>starts++);const port=await server.start();
    const display=new WebSocket(`ws://127.0.0.1:${port}`),inbox:any[]=[];display.on('message',data=>inbox.push(JSON.parse(data.toString())));
    await new Promise<void>(resolve=>display.on('open',resolve));display.send(JSON.stringify({type:'spectate',roomCode:'RECOVER'}));await wait(30);
    const room=server.getOrCreateRoom('RECOVER');room.expectHumanPlayers(2);
    const a=room.addPlayer('Ada',undefined,0) as {playerId:string};const b=room.addPlayer('Bo',undefined,1) as {playerId:string};
    server.voiceAdvance('RECOVER',a.playerId);server.voiceSelectCar('RECOVER',a.playerId,0);server.voiceSelectCar('RECOVER',b.playerId,1);
    server.voiceAdvance('RECOVER',b.playerId);server.voiceSelectMap('RECOVER','Silver Lake',a.playerId);
    server.voiceExpectHumanPlayers('RECOVER',1,[a.playerId]);await wait(30);
    expect(room.phase).toBe('map_select');expect(server.voiceAdvance('RECOVER',a.playerId)).toBe(true);await wait(30);
    expect(starts).toBe(0);expect(room.phase).toBe('countdown');
    expect(inbox).toContainEqual(expect.objectContaining({type:'items',map:'Silver Lake'}));display.close();
    expect(server.markStationRendererReady('RECOVER')).toBe(true);server.stepRoomForTest(room,.1);expect(starts).toBe(1);
  });

  it('releases a disconnected station slot before an overflow caller replaces it',async()=>{
    server=new GameServer({port:0});server.setRoomConfigProvider(()=>({carCount:2,maps:['Silver Lake']}));await server.start();
    const room=server.getOrCreateRoom('PROMOTE');room.expectHumanPlayers(2);
    const first=room.addPlayer('Ada',undefined,0) as {playerId:string};
    const dropped=room.addPlayer('Bo',undefined,1) as {playerId:string};
    server.voiceExpectHumanPlayers('PROMOTE',2,[first.playerId]);
    expect(room.lobbyPlayers().map(player=>player.playerId)).toEqual([first.playerId]);
    const replacement=room.addPlayer('Cy',undefined,1);
    expect(replacement).not.toHaveProperty('error');
    expect(room.lobbyPlayers().some(player=>player.playerId===dropped.playerId)).toBe(false);
  });

  it('keeps an active voice race moving while the display reconnects',async()=>{
    server=new GameServer({port:0,broadcastHz:30});server.setRoomConfigProvider(()=>({carCount:1,maps:['Silver Lake']}));
    const heard:string[]=[];server.setOnRoomEvents((_roomCode,events)=>heard.push(...events.map(event=>event.kind)));
    const port=await server.start();const display=new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>(resolve=>display.on('open',resolve));display.send(JSON.stringify({type:'spectate',roomCode:'VOICE-ONLY'}));
    const room=server.getOrCreateRoom('VOICE-ONLY');const player=room.addPlayer('Ada') as {playerId:string};
    room.advance();room.selectCar(player.playerId,0);room.advance();room.selectMap('Silver Lake');room.advance();
    display.close();await new Promise<void>(resolve=>display.on('close',()=>resolve()));
    server.stepRoomForTest(room,3.3);expect(heard).toContain('countdown');
    for(let index=0;index<100&&room.phase!=='racing';index++)server.stepRoomForTest(room,0.1);
    const before=room.snapshot()!.cars[0]!.z;
    await wait(120);
    expect(room.snapshot()!.cars[0]!.z).toBeGreaterThan(before);
    const reconnected=new WebSocket(`ws://127.0.0.1:${port}`),inbox:any[]=[];
    reconnected.on('message',data=>inbox.push(JSON.parse(data.toString())));
    await new Promise<void>(resolve=>reconnected.on('open',resolve));
    reconnected.send(JSON.stringify({type:'spectate',roomCode:'VOICE-ONLY'}));await wait(30);
    expect(inbox).toContainEqual(expect.objectContaining({type:'items',map:'Silver Lake'}));reconnected.close();
  });

  it('flushes final finish/race_over events when a race enters results', async () => {
    server = new GameServer({ port: 0, broadcastHz: 30 });
    server.setRoomConfigProvider(() => ({ carCount: 19, maps: ['Silver Lake'] }));
    const heard: string[] = [];
    server.setOnRoomEvents((_code, events) => heard.push(...events.map(e => e.kind)));
    server.setOnRaceFinished(() => heard.push('reported'));
    await server.start();

    const room = server.getOrCreateRoom('VOICEEND');
    room.addPlayer('Solo');
    room.advance(); room.selectCar(room.lobbyPlayers()[0]!.playerId, 4);
    room.advance(); room.selectMap('Silver Lake'); room.advance();
    for (let i = 0; i < 2000 && room.phase !== 'results'; i++) server.stepRoomForTest(room, 0.1);

    expect(room.phase).toBe('results');
    expect(heard).toContain('finish');
    expect(heard).toContain('race_over');
    expect(heard.indexOf('race_over')).toBeLessThan(heard.indexOf('reported'));
  });

  it('hard-aborts a station room', async () => {
    server = new GameServer({ port: 0 });
    await server.start();
    server.getOrCreateRoom('ABORT').addPlayer('Caller');
    expect(server.abortRoom('ABORT')).toBe(true);
    expect(server.findRoom('ABORT')).toBeUndefined();
    expect(server.abortRoom('ABORT')).toBe(false);
  });

  it('rejects every replay path once a paid station race reaches results', async () => {
    const displayToken='paid-station-display-token';
    server=new GameServer({port:0,displayToken});
    server.setBrowserPlayerAdmission(code=>code!=='PAID');
    server.setRoomConfigProvider(()=>({carCount:1,maps:['Silver Lake']}));
    const port=await server.start();
    const room=server.getOrCreateRoom('PAID');const player=room.addPlayer('Ada') as {playerId:string};
    room.advance();room.selectCar(player.playerId,0);room.advance();room.selectMap('Silver Lake');room.advance();
    for(let i=0;i<100&&room.phase!=='racing';i++)server.stepRoomForTest(room,0.1);
    const display=connect(port);await display.open();
    display.ws.send(JSON.stringify({type:'spectate',roomCode:'PAID',displayToken}));await wait(20);
    display.ws.send(JSON.stringify({type:'restart'}));await wait(20);
    expect(room.phase).toBe('racing');
    for(let i=0;i<2000&&room.phase!=='results';i++)server.stepRoomForTest(room,0.1);
    expect(room.phase).toBe('results');

    for(const type of ['advance','ready','restart'])display.ws.send(JSON.stringify({type}));
    await wait(50);

    expect(room.phase).toBe('results');
    expect(server.voiceAdvance('PAID',player.playerId)).toBe(false);
    expect(display.inbox).toContainEqual(expect.objectContaining({type:'error',code:'station_requeue_required'}));
    display.ws.close();
  });
});

describe('HttpServer voice routing seams', () => {
  let http: HttpServer;
  let LB = '';
  afterEach(async () => { await http?.stop(); if (LB) { try { await unlink(LB); } catch {} } });

  it('distinguishes late racing commands from explicit rematch requests', () => {
    expect(isLateRacerGameplayPrompt('go')).toBe(true);
    expect(isLateRacerGameplayPrompt('go now please')).toBe(true);
    expect(isLateRacerGameplayPrompt('left right boost')).toBe(true);
    expect(isLateRacerGameplayPrompt('go again')).toBe(false);
    expect(isLateRacerGameplayPrompt('race again')).toBe(false);
    expect(isLateRacerGameplayPrompt('rematch')).toBe(false);
    expect(isLateRacerGameplayPrompt('vai agora', 'pt-BR')).toBe(true);
    expect(isLateRacerGameplayPrompt('vai de novo', 'pt-BR')).toBe(false);
    expect(isLateRacerGameplayPrompt('correr de novo', 'pt-BR')).toBe(false);
    expect(isLateRacerGameplayPrompt('revanche', 'pt-BR')).toBe(false);
  });

  it('does not capture Portuguese advance phrases as a caller name', async () => {
    http = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    await http.start();
    const game = (http as unknown as { game: GameServer }).game;
    game.setRoomConfigProvider(() => ({ carCount: 1, carNames: ['Roadster'], maps: ['Silver Lake'] }));
    const room = game.getOrCreateRoom('PTADV');
    const result = room.addPlayer('Piloto 9999') as { playerId: string };

    const reply = http.directSelectionForTest(room, result.playerId, 'vamos começar', 'pt-BR');

    expect(room.phase).toBe('car_select');
    expect(room.lobbyPlayers()[0]?.name).toBe('Piloto 9999');
    expect(reply).toContain('Escolha seu carro');
  });

  it('does not treat internal race-over recap prompts as rematch commands', async () => {
    http = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      mapsPath: 'assets/maps/maps.json',
    });
    await http.start();
    const game = (http as unknown as { game: GameServer }).game;
    game.setRoomConfigProvider(() => ({ carCount: 19, maps: ['Silver Lake'] }));
    const room = game.getOrCreateRoom('NOAUTO');
    const res = room.addPlayer('Ada') as { playerId: string };
    room.advance(); room.selectCar(res.playerId, 0);
    room.advance(); room.selectMap('Silver Lake'); room.advance();
    for (let i = 0; i < 2000 && room.phase !== 'results'; i++) game.stepRoomForTest(room, 0.1);

    const reply = http.directSelectionForTest(room, res.playerId, '(The race is over. Invite a rematch.)');

    expect(reply).toBeNull();
    expect(room.phase).toBe('results');
  });

  it('keeps rematch guidance in lobby while a late caller still needs a name', async () => {
    http=new HttpServer({port:0,publicBaseUrl:'http://localhost',validateSignatures:false});await http.start();
    const game=(http as unknown as {game:GameServer}).game;
    game.setRoomConfigProvider(()=>({carCount:1,carNames:['Roadster'],maps:['Silver Lake']}));
    const room=game.getOrCreateRoom('REMATCH-NAME');const player=room.addPlayer('Ada') as {playerId:string};
    room.advance();room.selectCar(player.playerId,0);room.advance();room.selectMap('Silver Lake');room.advance();
    room.addPlayer('Racer 5678',undefined,undefined,false);
    for(let i=0;i<2000&&room.phase!=='results';i++)game.stepRoomForTest(room,0.1);
    expect(room.phase).toBe('results');
    const reply=http.directSelectionForTest(room,player.playerId,'rematch');
    expect(room.phase).toBe('lobby');
    expect(reply).toMatch(/wait|waiting/i);
  });

  it('does not let a delayed Racer host action cross into a newer results phase', async()=>{
    http=new HttpServer({port:0,publicBaseUrl:'http://localhost',validateSignatures:false});await http.start();
    const game=(http as unknown as {game:GameServer}).game;
    game.setRoomConfigProvider(()=>({carCount:1,carNames:['Roadster'],maps:['Silver Lake']}));
    const room=game.getOrCreateRoom('STALEHOST');const player=room.addPlayer('Ada') as {playerId:string};
    const context=http.hostContextForTest(room,player.playerId);
    room.advance();room.selectCar(player.playerId,0);room.advance();room.selectMap('Silver Lake');room.advance();
    for(let i=0;i<2000&&room.phase!=='results';i++)game.stepRoomForTest(room,0.1);
    expect(room.phase).toBe('results');
    expect(context.startRace()).toBeNull();
    expect(room.phase).toBe('results');
  });

  it('makes superseded same-phase Racer host tools unable to mutate state', async()=>{
    http=new HttpServer({port:0,publicBaseUrl:'http://localhost',validateSignatures:false});await http.start();
    const game=(http as unknown as {game:GameServer}).game;
    game.setRoomConfigProvider(()=>({carCount:2,carNames:['Roadster','Coupe'],maps:['Silver Lake']}));
    const room=game.getOrCreateRoom('STALETOOLS');const player=room.addPlayer('Racer 1234') as {playerId:string};
    room.advance();let current=true;const context=http.hostContextForTest(room,player.playerId,'en-US',()=>current);current=false;

    expect(context.setName('Mallory')).toBeNull();
    expect(context.selectCarByName('Coupe')).toBeNull();
    expect(room.lobbyPlayers()[0]).toMatchObject({name:'Racer 1234',carIndex:null});
  });

  it('keeps a late caller on map selection and accepts an explicit name without misreading a choice', async()=>{
    http=new HttpServer({port:0,publicBaseUrl:'http://localhost',validateSignatures:false});await http.start();
    const game=(http as unknown as {game:GameServer}).game;
    game.setRoomConfigProvider(()=>({carCount:2,carNames:['Roadster','Coupe'],maps:['Silver Lake','Drift']}));
    const room=game.getOrCreateRoom('LATEMAP');const first=room.addPlayer('Ada') as {playerId:string};
    room.advance();room.selectCar(first.playerId,0);room.advance();
    const late=room.addPlayer('Racer 2222',undefined,undefined,false) as {playerId:string};

    expect(room.phase).toBe('map_select');
    expect(http.directSelectionForTest(room,late.playerId,'something fast')).toBeNull();
    expect(room.lobbyPlayers().find(player=>player.playerId===late.playerId)?.name).toBe('Racer 2222');
    expect(http.directSelectionForTest(room,late.playerId,"I'm Bo")).toContain('Nice to meet you');
    expect(http.directSelectionForTest(room,late.playerId,'two')).toContain('Coupe');
    expect(room.lobbyPlayers().find(player=>player.playerId===late.playerId)).toMatchObject({name:'Bo',carIndex:1});
    expect(http.directSelectionForTest(room,late.playerId,'one')).toContain("vote's in");
    expect(room.mapVotes().counts).toEqual({'Silver Lake':1});
  });

  it('keeps Racer selections independent and requires explicit caller advances',async()=>{
    http=new HttpServer({port:0,publicBaseUrl:'http://localhost',validateSignatures:false});await http.start();
    const game=(http as unknown as {game:GameServer}).game;
    game.setRoomConfigProvider(()=>({carCount:2,carNames:['Roadster','Coupe'],maps:['Silver Lake','Drift']}));
    const room=game.getOrCreateRoom('TWOSETUP');room.expectHumanPlayers(2);
    const first=room.addPlayer('Ada',undefined,0) as {playerId:string};
    const second=room.addPlayer('Bo',undefined,1) as {playerId:string};

    expect(room.phase).toBe('lobby');
    expect(http.directSelectionForTest(room,second.playerId,'start')).toMatch(/Choose a car/i);
    expect(room.phase).toBe('car_select');
    expect(http.directSelectionForTest(room,second.playerId,'two')).toMatch(/Coupe/i);
    expect(room.lobbyPlayers()).toEqual(expect.arrayContaining([
      expect.objectContaining({playerId:first.playerId,carIndex:null}),
      expect.objectContaining({playerId:second.playerId,carIndex:1}),
    ]));
    expect(http.directSelectionForTest(room,first.playerId,'one')).toMatch(/Roadster/i);
    expect(http.directSelectionForTest(room,first.playerId,'actually two')).toMatch(/Coupe/i);
    expect(room.lobbyPlayers().find(player=>player.playerId===first.playerId)?.carIndex).toBe(1);
    expect(room.phase).toBe('car_select');expect(http.directSelectionForTest(room,first.playerId,'next')).toMatch(/choose a track/i);
    expect(room.phase).toBe('map_select');expect(http.directSelectionForTest(room,first.playerId,'one')).toMatch(/Silver Lake/i);
    expect(http.directSelectionForTest(room,second.playerId,'one')).toMatch(/Silver Lake/i);
    expect(room.mapVotes().counts).toEqual({'Silver Lake':2});
    expect(http.directSelectionForTest(room,second.playerId,'actually two')).toMatch(/Say "start"/i);
    expect(http.directSelectionForTest(room,first.playerId,'actually two')).toMatch(/Say "start"/i);
    expect(room.mapVotes().counts).toEqual({Drift:2});
    expect(room.phase).toBe('map_select');
    expect(http.directSelectionForTest(room,second.playerId,'start')).toMatch(/race/i);
    expect(room.phase).toBe('countdown');
  });

  it('never picks a rejected car or track before the caller finishes correcting themselves', async () => {
    http=new HttpServer({port:0,publicBaseUrl:'http://localhost',validateSignatures:false});await http.start();
    const game=(http as unknown as {game:GameServer}).game;
    game.setRoomConfigProvider(()=>({carCount:2,carNames:['Roadster','Coupe'],maps:['Silver Lake','Drift']}));
    const room=game.getOrCreateRoom('CORRECTION');
    const player=room.addPlayer('Ada') as {playerId:string};
    room.advance();

    expect(clearSelectionIndex('not Blue, the Red one',['Blue','Red'])).toBeNull();
    expect(http.directSelectionForTest(room,player.playerId,'not one, two')).toBeNull();
    expect(room.lobbyPlayers()[0]?.carIndex).toBeNull();
    expect(http.directSelectionForTest(room,player.playerId,'one, actually two')).toMatch(/Coupe/i);
    expect(room.lobbyPlayers()[0]?.carIndex).toBe(1);

    room.advance();
    expect(http.directSelectionForTest(room,player.playerId,'not Silver Lake, Drift')).toBeNull();
    expect(room.mapVotes().counts).toEqual({});
    expect(http.directSelectionForTest(room,player.playerId,'Silver Lake, actually Drift')).toMatch(/Drift/i);
    expect(room.mapVotes().counts).toEqual({Drift:1});
  });

  it('gives the voice host a leaderboard filtered to the current track', async () => {
    await mkdir('data', { recursive: true });
    LB = `data/_test-host-lb-${process.pid}.json`;
    await writeFile(LB, JSON.stringify([
      { name: 'Wrong Track Test', map: 'Neon City', carIndex: 0, finishT: 39, at: 1 },
      { name: 'Real Leader', map: 'Silver Lake', carIndex: 0, finishT: 33, at: 2 },
      { name: 'Ada prior run', map: 'Silver Lake', carIndex: 0, finishT: 34, at: 2, enginePlayerId:'CTXLB:p1' },
      { name: 'Second Place History', map: 'Silver Lake', carIndex: 1, finishT: 36, at: 3 },
    ]));
    http = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      mapsPath: 'assets/maps/maps.json', leaderboardPath: LB,
    });
    await http.start();
    const game = (http as unknown as { game: GameServer }).game;
    const room = game.getOrCreateRoom('CTXLB');
    const res = room.addPlayer('Ada') as { playerId: string };
    room.advance(); room.selectCar(res.playerId, 0);
    room.advance(); room.selectMap('Silver Lake'); room.advance();
    for (let i = 0; i < 2000 && room.phase !== 'results'; i++) game.stepRoomForTest(room, 0.1);

    const ctx = http.hostContextForTest(room, res.playerId);

    expect(ctx.selectedMap).toBe('Silver Lake');
    expect(ctx.allTimeBest).toEqual({ name: 'Real Leader', time: 33 });
    expect(ctx.allTimeTop).toEqual(['Real Leader', 'Ada prior run', 'Second Place History', 'Ada']);
    expect(ctx.leaderboardTop?.slice(0, 2)).toEqual([{ name: 'Real Leader', time: 33 }, { name: 'Ada prior run', time: 34 }]);
    expect(ctx.leaderboardTop?.some(e => e.name === 'Ada' && e.time > 0)).toBe(true);
    expect(ctx.raceStandings?.[0]).toMatchObject({ name: 'Ada', place: 1, finished: true });
    expect(ctx.raceStandings?.[0]?.time).toBeGreaterThan(0);
    expect(ctx.myPlace).toBe(1);
    expect(ctx.myFinishTime).toBeGreaterThan(0);
    expect(ctx.myCurrentTrackRank).toBe(1+[33,34,36].filter(time=>time<(ctx.myFinishTime??0)).length);
    expect(ctx.currentTrackRankedRunCount).toBe(4);

    const currentTime=ctx.myFinishTime!;
    const cache=(http as unknown as {leaderboardEntriesCache:Array<{name:string;map:string;carIndex:number;finishT:number;at:number}>});
    cache.leaderboardEntriesCache=Array.from({length:1000},(_,index)=>({
      name:`History ${index}`,map:'Silver Lake',carIndex:0,finishT:currentTime+index+1,at:index,
    }));
    expect(http.hostContextForTest(room,res.playerId).currentTrackRankedRunCount).toBe(1000);
    cache.leaderboardEntriesCache=Array.from({length:1000},(_,index)=>({
      name:`Mixed history ${index}`,map:index===999?'Silver Lake':'Neon City',carIndex:0,finishT:currentTime+index+1,at:1000-index,
    }));
    expect(http.hostContextForTest(room,res.playerId).currentTrackRankedRunCount).toBe(1);
    cache.leaderboardEntriesCache=[
      {name:'Older tied run',map:'Silver Lake',carIndex:1,finishT:currentTime,at:1},
    ];
    const tied=http.hostContextForTest(room,res.playerId);
    expect(tied.myCurrentTrackRank).toBe(1);
    expect(tied.leaderboardTop?.[0]).toEqual({name:'Ada',time:currentTime});
  });

  it('does not publish a leaderboard cache entry when its durable write fails', async () => {
    await mkdir('data', { recursive: true });
    LB = `data/_test-host-lb-write-${process.pid}.json`;
    await writeFile(LB, JSON.stringify([
      { name: 'Durable Leader', map: 'Silver Lake', carIndex: 0, finishT: 20, at: 1 },
    ]));
    http = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      mapsPath: 'assets/maps/maps.json', leaderboardPath: LB,
    });
    await http.start();
    const internals=http as unknown as {
      game:GameServer;
      leaderboardWrite:Promise<void>;
      writeFileAtomic:(file:string,contents:string)=>Promise<void>;
    };
    internals.writeFileAtomic=async()=>{throw new Error('simulated write failure');};
    const room=internals.game.getOrCreateRoom('FAILED-WRITE');
    const racer=room.addPlayer('Phantom Run') as {playerId:string};
    room.advance();room.selectCar(racer.playerId,0);room.advance();room.selectMap('Silver Lake');room.advance();
    for(let i=0;i<2000&&room.phase!=='results';i++)internals.game.stepRoomForTest(room,0.1);
    await internals.leaderboardWrite;

    const observer=internals.game.getOrCreateRoom('OBSERVER');
    const viewer=observer.addPlayer('Viewer') as {playerId:string};
    observer.advance();observer.selectCar(viewer.playerId,0);observer.advance();observer.selectMap('Silver Lake');
    const ctx=http.hostContextForTest(observer,viewer.playerId);
    expect(ctx.allTimeTop).toEqual(['Durable Leader']);
  });
});
