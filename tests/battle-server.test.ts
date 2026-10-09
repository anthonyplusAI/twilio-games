// Integration: the /battle WebSocket server. Turn-based + event-driven — it pushes battle_state on
// every change (no continuous loop), sends the roster on connect, and routes join/select/move/advance.
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { BattleServer } from '../server/battle-server';
import { ROSTER } from '../shared/monster-roster';

let server: BattleServer;
afterEach(async () => { await server?.stop(); });

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
// Attach the message collector at CREATION (before 'open') so the roster the server sends the instant
// it accepts the connection isn't missed by a listener attached too late.
function connectCollect(port: number): Promise<{ ws: WebSocket; msgs: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: Record<string, unknown>[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  return new Promise((res) => ws.on('open', () => res({ ws, msgs })));
}
const send = (ws: WebSocket, m: unknown) => ws.send(JSON.stringify(m));

describe('BattleServer', () => {
  it('announces standby display promotion without granting its early count request', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const host = await connectCollect(port);
    send(host.ws, { type: 'spectate', roomCode: 'HANDOFF' });
    await wait(20);
    expect(host.msgs).toContainEqual({ type: 'host_identity', roomCode: 'HANDOFF', isHost: true });
    send(host.ws, { type: 'configure_players', count: 1 });
    await wait(20);

    const standby = await connectCollect(port);
    send(standby.ws, { type: 'spectate', roomCode: 'HANDOFF', playerCount: 2 });
    send(standby.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    expect(standby.msgs).toContainEqual({ type: 'host_identity', roomCode: 'HANDOFF', isHost: false });
    expect(standby.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'forbidden' }));
    expect(server.findRoom('HANDOFF')?.expectedPlayerCount).toBe(1);

    const closed = new Promise<void>(resolve => host.ws.once('close', resolve));
    host.ws.close(); await closed;
    await wait(20);
    expect(standby.msgs).toContainEqual({ type: 'host_identity', roomCode: 'HANDOFF', isHost: true });
    send(standby.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    expect(server.findRoom('HANDOFF')?.expectedPlayerCount).toBe(2);
    standby.ws.close();
  });

  it('applies a standby display’s selected count before announcing its promotion', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const host = await connectCollect(port);
    send(host.ws, { type: 'spectate', roomCode: 'ATOMIC-HANDOFF', playerCount: 1 });
    await wait(20);
    const standby = await connectCollect(port);
    send(standby.ws, { type: 'spectate', roomCode: 'ATOMIC-HANDOFF', playerCount: 2 });
    await wait(20);
    expect(server.findRoom('ATOMIC-HANDOFF')?.expectedPlayerCount).toBe(1);

    const closed = new Promise<void>(resolve => host.ws.once('close', resolve));
    host.ws.close(); await closed;
    await wait(20);
    expect(standby.msgs).toContainEqual({ type: 'host_identity', roomCode: 'ATOMIC-HANDOFF', isHost: true });
    expect(server.findRoom('ATOMIC-HANDOFF')?.expectedPlayerCount).toBe(2);
    standby.ws.close();
  });

  it('does not promote a standby count that conflicts with an advanced solo setup', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const host = await connectCollect(port);
    send(host.ws, { type: 'spectate', roomCode: 'LOCKED-HANDOFF', playerCount: 1 });
    await wait(20);
    const ada = server.voiceJoin('LOCKED-HANDOFF', 'Ada')!;
    expect(server.voiceAdvance('LOCKED-HANDOFF', ada)).toBe(true);
    expect(server.findRoom('LOCKED-HANDOFF')?.phase).toBe('monster_select');

    const standby = await connectCollect(port);
    send(standby.ws, { type: 'spectate', roomCode: 'LOCKED-HANDOFF', playerCount: 2 });
    await wait(20);
    const closed = new Promise<void>(resolve => host.ws.once('close', resolve));
    host.ws.close(); await closed;
    await wait(20);
    expect(standby.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'setup_in_progress' }));
    expect([...(server as unknown as { conns: Set<{ roomCode?: string; display?: boolean }> }).conns]
      .some(conn => conn.roomCode === 'LOCKED-HANDOFF' && conn.display)).toBe(false);
    expect(server.findRoom('LOCKED-HANDOFF')?.expectedPlayerCount).toBe(1);
    standby.ws.close();
  });

  it('lets only the standalone display reserve two phone seats before setup', async () => {
    server = new BattleServer({ port: 0, displayToken: 'station-token' });
    server.setBrowserPlayerAdmission(code => code !== 'STATION');
    const port = await server.start();
    const spectator = await connectCollect(port);
    send(spectator.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    expect(spectator.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'forbidden' }));

    send(spectator.ws, { type: 'spectate', roomCode: 'STATION', displayToken: 'station-token', playerCount: 2 });
    await wait(20);
    expect(server.findRoom('STATION')?.expectedPlayerCount).toBe(1);
    send(spectator.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    expect(server.findRoom('STATION')?.expectedPlayerCount).toBe(1);

    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'LOCAL-DUO' });
    send(display.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    const room = server.findRoom('LOCAL-DUO')!;
    expect(room.expectedPlayerCount).toBe(2);
    expect(display.msgs.filter(message => message.type === 'battle_state').at(-1))
      .toMatchObject({ expectedPlayerCount: 2, players: [] });

    const ada = server.voiceJoin('LOCAL-DUO', 'Ada')!;
    server.voiceSetName('LOCAL-DUO', ada, 'Ada');
    expect(room.expectedPlayerCount).toBe(2);
    expect(server.voiceAdvance('LOCAL-DUO', ada)).toBe(true);
    expect(room.isSetupReady(ada)).toBe(true);
    const bo = server.voiceJoin('LOCAL-DUO', 'Bo')!;
    expect(room.phase).toBe('lobby');
    send(display.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('lobby');
    expect(display.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'caller_ready_required' }));
    expect(server.voiceAdvance('LOCAL-DUO', bo)).toBe(true);
    expect(room.phase).toBe('monster_select');
    spectator.ws.close(); display.ws.close();
  });

  it('applies a two-caller display mode before publishing its first state', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'ATOMIC', playerCount: 2 });
    await wait(20);
    expect(display.msgs.find(message => message.type === 'battle_state'))
      .toMatchObject({ phase: 'lobby', expectedPlayerCount: 2, players: [] });
    const keyboard = await connectCollect(port);
    send(keyboard.ws, { type: 'join', roomCode: 'ATOMIC', name: 'Tester' });
    await wait(20);
    expect(server.findRoom('ATOMIC')?.expectedPlayerCount).toBe(2);
    keyboard.ws.close(); display.ws.close();
  });

  it('does not route calls to a display whose requested count is locked out', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const original = await connectCollect(port);
    send(original.ws, { type: 'spectate', roomCode: 'LOCKED-COUNT', playerCount: 1 });
    await wait(20);
    const ada = server.voiceJoin('LOCKED-COUNT', 'Ada')!;
    expect(server.voiceAdvance('LOCKED-COUNT', ada)).toBe(true);
    expect(server.findRoom('LOCKED-COUNT')?.phase).toBe('monster_select');
    const closed = new Promise<void>(resolve => original.ws.once('close', resolve));
    original.ws.close(); await closed;

    const conflicting = await connectCollect(port);
    send(conflicting.ws, { type: 'spectate', roomCode: 'LOCKED-COUNT', playerCount: 2 });
    await wait(20);
    expect(conflicting.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'setup_in_progress' }));
    expect([...(server as unknown as { conns: Set<{ roomCode?: string; display?: boolean }> }).conns]
      .some(conn => conn.roomCode === 'LOCKED-COUNT' && conn.display)).toBe(false);
    expect(server.findRoom('LOCKED-COUNT')?.expectedPlayerCount).toBe(1);
    conflicting.ws.close();
  });

  it('accepts an older display’s count follow-up after a caller joins the lobby', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'LATE-COUNT' });
    await wait(20);
    const ada = server.voiceJoin('LATE-COUNT', 'Ada')!;
    const room = server.findRoom('LATE-COUNT')!;
    send(display.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    expect(room.expectedPlayerCount).toBe(2);
    expect(display.msgs).not.toContainEqual(expect.objectContaining({ type: 'error', code: 'setup_in_progress' }));
    expect(server.voiceAdvance('LATE-COUNT', ada)).toBe(true);
    expect(room.phase).toBe('lobby');
    display.ws.close();
  });

  it('accepts keyboard-first display setup and waits for each caller and phone cue', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const keyboard = await connectCollect(port);
    send(keyboard.ws, { type: 'join', roomCode: 'KEYBOARD-FIRST', name: 'Tester' });
    await wait(20);
    const room = server.findRoom('KEYBOARD-FIRST')!;
    expect(room.expectedPlayerCount).toBe(1);

    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'KEYBOARD-FIRST', playerCount: 2 });
    await wait(20);
    expect(room.expectedPlayerCount).toBe(2);
    expect(room.requiresIndividualSetupReady).toBe(true);
    send(display.ws, { type: 'configure_players', count: 2 });
    send(keyboard.ws, { type: 'advance' });
    await wait(20);
    expect(display.msgs).not.toContainEqual(expect.objectContaining({ type: 'error', code: 'setup_in_progress' }));
    expect(room.phase).toBe('lobby');
    expect(room.lobbyPlayers()[0]?.setupReady).toBe(true);

    const bo = server.voiceJoin('KEYBOARD-FIRST', 'Bo')!;
    const finishBo = server.voiceBeginMenuSpeech('KEYBOARD-FIRST', bo, 'lobby')!;
    send(display.ws, { type: 'advance' });
    await wait(20);
    expect(display.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'caller_ready_required' }));
    expect(server.voiceAdvance('KEYBOARD-FIRST', bo)).toBe(true);
    expect(room.phase).toBe('lobby');
    finishBo(true);
    expect(room.phase).toBe('monster_select');
    keyboard.ws.close(); display.ws.close();
  });

  it('accepts phone-first display setup and holds a caller’s pending menu cue', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const ada = server.voiceJoin('PHONE-FIRST', 'Ada')!;
    const finishAda = server.voiceBeginMenuSpeech('PHONE-FIRST', ada, 'lobby')!;
    const room = server.findRoom('PHONE-FIRST')!;
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'PHONE-FIRST', playerCount: 2 });
    await wait(20);
    expect(room.expectedPlayerCount).toBe(2);
    expect(server.voiceAdvance('PHONE-FIRST', ada)).toBe(true);
    expect(room.phase).toBe('lobby');
    const keyboard = await connectCollect(port);
    send(keyboard.ws, { type: 'join', roomCode: 'PHONE-FIRST', name: 'Tester' });
    await wait(20);
    send(keyboard.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('lobby');
    expect(room.lobbyPlayers()).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: ada, setupReady: true, phonePending: true }),
      expect.objectContaining({ name: 'Tester', setupReady: true }),
    ]));
    finishAda(true);
    expect(room.phase).toBe('monster_select');
    keyboard.ws.close(); display.ws.close();
  });

  it('accepts the same two-caller display mode after reconnect in selection and results', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const roomCode = 'RECONNECT-MODE';
    const openDisplay = async () => {
      const display = await connectCollect(port);
      send(display.ws, { type: 'spectate', roomCode });
      await wait(15);
      send(display.ws, { type: 'configure_players', count: 2 });
      await wait(15);
      expect(display.msgs).not.toContainEqual(expect.objectContaining({ type: 'error', code: 'setup_in_progress' }));
      return display;
    };
    const firstDisplay = await openDisplay();
    const ada = server.voiceJoin(roomCode, 'Ada')!;
    const bo = server.voiceJoin(roomCode, 'Bo')!;
    const room = server.findRoom(roomCode)!;
    server.voiceAdvance(roomCode, ada);
    server.voiceAdvance(roomCode, bo);
    expect(room.phase).toBe('monster_select');

    firstDisplay.ws.close();
    await wait(20);
    const selectDisplay = await openDisplay();
    expect(room.phase).toBe('monster_select');
    expect(room.expectedPlayerCount).toBe(2);
    server.voiceSelectMonster(roomCode, ada, 'sparkmouse');
    server.voiceSelectMonster(roomCode, bo, 'embertail');
    server.voiceAdvance(roomCode, ada);
    server.voiceAdvance(roomCode, bo);
    expect(room.phase).toBe('battle');
    for (let turn = 0; turn < 200 && room.phase === 'battle'; turn++) {
      const snapshot = room.snapshot()!;
      const side = room.activeSide();
      const actor = side === 'a' ? ada : bo;
      const move = side === 'a' ? snapshot.a.moves[0]! : snapshot.b.moves[0]!;
      expect(room.chooseAction(actor, { kind: 'fight', moveId: move.id })).toBe(true);
    }
    expect(room.phase).toBe('results');

    selectDisplay.ws.close();
    await wait(20);
    const resultDisplay = await openDisplay();
    expect(room.phase).toBe('results');
    expect(room.expectedPlayerCount).toBe(2);
    resultDisplay.ws.close();
  });

  it('clears a disconnected caller’s ready state so the other phone cannot advance alone', async () => {
    server = new BattleServer({ port: 0 });
    await server.start();
    const ada = server.voiceJoin('RECONNECT', 'Ada', 'a', 2)!;
    const bo = server.voiceJoin('RECONNECT', 'Bo', 'b', 2)!;
    const room = server.findRoom('RECONNECT')!;
    expect(server.voiceAdvance('RECONNECT', ada)).toBe(true);
    expect(room.isSetupReady(ada)).toBe(true);
    expect(server.voiceClearSetupReady('RECONNECT', ada)).toBe(true);
    expect(server.voiceAdvance('RECONNECT', bo)).toBe(true);
    expect(room.phase).toBe('lobby');
    expect(room.isSetupReady(ada)).toBe(false);
  });

  it('publishes phone wait states and advances only after both Relay cues complete', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'PHONE-CUES' });
    send(display.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    const ada = server.voiceJoin('PHONE-CUES', 'Ada')!;
    const bo = server.voiceJoin('PHONE-CUES', 'Bo')!;
    const room = server.findRoom('PHONE-CUES')!;
    const finishAda = server.voiceBeginMenuSpeech('PHONE-CUES', ada, 'lobby')!;
    const finishBo = server.voiceBeginMenuSpeech('PHONE-CUES', bo, 'lobby')!;
    expect(server.voiceAdvance('PHONE-CUES', ada)).toBe(true);
    expect(server.voiceAdvance('PHONE-CUES', bo)).toBe(true);
    await wait(20);
    expect(room.phase).toBe('lobby');
    const lastState = () => display.msgs.filter(message => message.type === 'battle_state').at(-1);
    expect(lastState()?.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: ada, setupReady: true, phonePending: true }),
      expect.objectContaining({ playerId: bo, setupReady: true, phonePending: true }),
    ]));
    finishAda(true);
    finishBo(false);
    expect(room.phase).toBe('lobby');
    const retryBo = server.voiceBeginMenuSpeech('PHONE-CUES', bo, 'lobby')!;
    retryBo(true);
    await wait(20);
    expect(room.phase).toBe('monster_select');
    expect(lastState()?.phase).toBe('monster_select');
    display.ws.close();
  });

  it('preserves a fixed two-seat station match when the first caller gives their name', async () => {
    server = new BattleServer({ port: 0 });
    await server.start();
    const first = server.voiceJoin('STATION-NAME', 'Challenger', 'a', 2, false)!;
    server.voiceSetName('STATION-NAME', first, 'Ada');
    const room = server.findRoom('STATION-NAME')!;
    expect(room.expectedPlayerCount).toBe(2);
    expect(server.voiceAdvance('STATION-NAME', first)).toBe(true);
    expect(room.phase).toBe('lobby');
    expect(room.isSetupReady(first)).toBe(true);
  });

  it('retains a finished two-caller result on its display until a fresh pair starts', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'NEXT-PAIR' });
    send(display.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    const ada = server.voiceJoin('NEXT-PAIR', 'Ada')!;
    const bo = server.voiceJoin('NEXT-PAIR', 'Bo')!;
    const room = server.findRoom('NEXT-PAIR')!;
    server.voiceAdvance('NEXT-PAIR', ada); server.voiceAdvance('NEXT-PAIR', bo);
    server.voiceSelectMonster('NEXT-PAIR', ada, 'sparkmouse');
    server.voiceSelectMonster('NEXT-PAIR', bo, 'embertail');
    server.voiceAdvance('NEXT-PAIR', ada); server.voiceAdvance('NEXT-PAIR', bo);
    for (let index = 0; index < 200 && room.phase === 'battle'; index++) {
      const snapshot = room.snapshot()!;
      const action = room.activeSide() === 'a'
        ? { playerId: ada, moveId: snapshot.a.moves[0]!.id }
        : { playerId: bo, moveId: snapshot.b.moves[0]!.id };
      server.voiceChooseAction('NEXT-PAIR', action.playerId, { kind: 'fight', moveId: action.moveId });
    }
    expect(room.phase).toBe('results');
    const result = room.result();
    server.voiceLeave('NEXT-PAIR', ada);
    server.voiceLeave('NEXT-PAIR', bo);
    await wait(20);
    expect(server.findRoom('NEXT-PAIR')).toBe(room);
    expect(room.phase).toBe('results');
    expect(room.result()).toEqual(result);
    expect(room.expectedPlayerCount).toBe(2);
    const displayed = display.msgs.filter(message => message.type === 'battle_state').at(-1);
    expect(displayed).toMatchObject({ phase: 'results', expectedPlayerCount: 2, players: [], result });

    const nextAda = server.voiceJoin('NEXT-PAIR', 'Next Ada')!;
    expect(room.phase).toBe('lobby');
    expect(room.expectedPlayerCount).toBe(2);
    expect(server.voiceAdvance('NEXT-PAIR', nextAda)).toBe(true);
    expect(room.phase).toBe('lobby');
    const nextBo = server.voiceJoin('NEXT-PAIR', 'Next Bo')!;
    expect(server.voiceAdvance('NEXT-PAIR', nextBo)).toBe(true);
    expect(room.phase).toBe('monster_select');
    display.ws.close();
  });

  it('waits for both browser players to confirm the shared menus', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const first = await connectCollect(port);
    const second = await connectCollect(port);
    send(first.ws, { type: 'join', roomCode: 'BROWSER-DUO', name: 'Ada' });
    send(second.ws, { type: 'join', roomCode: 'BROWSER-DUO', name: 'Bo' });
    await wait(20);
    const room = server.findRoom('BROWSER-DUO')!;
    expect(room.expectedPlayerCount).toBe(2);
    send(first.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('lobby');
    send(second.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('monster_select');
    first.ws.close(); second.ws.close();
  });
  it('recognizes only a live, room-bound and authorized standalone display',async()=>{
    server=new BattleServer({port:0,displayToken:'display-token'});
    server.setBrowserPlayerAdmission(code=>code!=='PAID');
    let serverSideDisplay:WebSocket|undefined;
    server.setOnDisplayAuthenticated(ws=>{
      if(!serverSideDisplay){serverSideDisplay=ws;expect(server.hasStandaloneDisplay(ws,'PAID')).toBe(false);}
    });
    const port=await server.start();
    const display=await connectCollect(port);
    expect(server.hasStandaloneDisplay(display.ws,'PAID')).toBe(false);
    send(display.ws,{type:'spectate',roomCode:'PAID',displayToken:'wrong'});await wait(20);
    expect(server.hasStandaloneDisplay(display.ws,'PAID')).toBe(false);
    send(display.ws,{type:'spectate',roomCode:'PAID',displayToken:'display-token'});await wait(20);
    expect(serverSideDisplay).toBeDefined();
    expect(server.hasStandaloneDisplay(serverSideDisplay!,'PAID')).toBe(false);
    expect(server.hasStandaloneDisplay(serverSideDisplay!,'OTHER')).toBe(false);
    send(display.ws,{type:'spectate',roomCode:'FREE'});await wait(20);
    expect(server.hasStandaloneDisplay(serverSideDisplay!,'FREE')).toBe(true);
    send(display.ws,{type:'leave'});await wait(20);
    expect(server.hasStandaloneDisplay(serverSideDisplay!,'FREE')).toBe(false);
    send(display.ws,{type:'spectate',roomCode:'FREE'});await wait(20);
    expect(server.hasStandaloneDisplay(serverSideDisplay!,'FREE')).toBe(true);
    send(display.ws,{type:'spectate',roomCode:'OTHER'});await wait(20);
    expect(server.hasStandaloneDisplay(serverSideDisplay!,'FREE')).toBe(false);
    expect(server.hasStandaloneDisplay(serverSideDisplay!,'OTHER')).toBe(true);
    display.ws.close();await new Promise<void>(resolve=>display.ws.once('close',()=>resolve()));
    expect(server.hasStandaloneDisplay(serverSideDisplay!,'OTHER')).toBe(false);
  });

  it('lets the authenticated station display show picks while only callers advance their menus', async () => {
    server=new BattleServer({port:0,displayToken:'touch-token'});
    server.setBrowserPlayerAdmission(code=>code!=='TOUCH');
    const port=await server.start();
    const first=server.voiceJoin('TOUCH','Ada','a',2)!;
    const second=server.voiceJoin('TOUCH','Bo','b',2)!;
    const display=await connectCollect(port);
    send(display.ws,{type:'spectate',roomCode:'TOUCH',displayToken:'touch-token'});await wait(20);
    send(display.ws,{type:'advance'});await wait(20);
    expect(server.findRoom('TOUCH')?.phase).toBe('lobby');
    expect(display.msgs).toContainEqual(expect.objectContaining({type:'error',code:'caller_ready_required'}));
    server.voiceAdvance('TOUCH',first);server.voiceAdvance('TOUCH',second);
    expect(server.findRoom('TOUCH')?.phase).toBe('monster_select');
    send(display.ws,{type:'display_select_monster',playerId:first,monsterId:'embertail'});
    send(display.ws,{type:'display_select_monster',playerId:second,monsterId:'thornling'});
    await wait(20);
    expect(server.findRoom('TOUCH')?.lobbyPlayers()).toEqual(expect.arrayContaining([
      expect.objectContaining({playerId:first,monsterId:'embertail'}),
      expect.objectContaining({playerId:second,monsterId:'thornling'}),
    ]));
    server.voiceAdvance('TOUCH',first);
    send(display.ws,{type:'display_select_monster',playerId:first,monsterId:'sparkmouse'});
    await wait(20);
    expect(display.msgs).toContainEqual(expect.objectContaining({type:'error',code:'caller_ready_locked'}));
    expect(server.findRoom('TOUCH')?.lobbyPlayers().find(player=>player.playerId===first)?.monsterId).toBe('embertail');
    send(display.ws,{type:'back'});await wait(20);
    expect(server.findRoom('TOUCH')?.phase).toBe('monster_select');
    expect(display.msgs).toContainEqual(expect.objectContaining({type:'error',code:'caller_ready_required'}));
    display.ws.close();
  });

  it('publishes only authenticated current-generation battle event and result paint receipts', async () => {
    server=new BattleServer({port:0});const port=await server.start();
    const playerId=server.voiceJoin('PAINT','Ada')!;
    const display=await connectCollect(port);
    send(display.ws,{type:'spectate',roomCode:'PAINT'});await wait(20);
    const presentations:unknown[]=[];
    server.setOnPresentation((_code,presentation)=>presentations.push(presentation));
    server.voiceAdvance('PAINT',playerId);
    server.voiceSelectMonster('PAINT',playerId,'embertail');
    server.voiceAdvance('PAINT',playerId);
    const openingMove=server.findRoom('PAINT')!.snapshot()!.a.moves[0]!.id;
    expect(server.voiceChooseAction('PAINT',playerId,{kind:'fight',moveId:openingMove})).toBe(true);
    await wait(20);
    const room=server.findRoom('PAINT')!;
    const battleStateIndex=display.msgs.findIndex(message=>message.type==='battle_state'
      &&message.phase==='battle'&&message.generation===room.generation);
    const openingEventIndex=display.msgs.findIndex(message=>message.type==='battle_events'
      &&message.generation===room.generation);
    // The browser needs the new generation before it can accept its first event frame.
    expect(battleStateIndex).toBeLessThan(openingEventIndex);
    const eventFrame=display.msgs.find(message=>message.type==='battle_events')!;
    expect(eventFrame).toMatchObject({generation:room.generation});
    expect(eventFrame.eventIds).toEqual(expect.arrayContaining([expect.any(Number)]));
    send(display.ws,{type:'ack_event',generation:room.generation+1,eventId:(eventFrame.eventIds as number[])[0]});
    await wait(20);expect(presentations).toHaveLength(0);
    send(display.ws,{type:'ack_event',generation:room.generation,eventId:(eventFrame.eventIds as number[])[0]});
    await wait(20);expect(presentations).toContainEqual(expect.objectContaining({kind:'event',generation:room.generation}));

    for(let index=0;index<100&&room.phase==='battle';index++){
      const snap=room.snapshot()!;room.chooseMove(playerId,snap.a.moves[1]!.id);
      if(room.aiPending())room.resolveAiTurn();
    }
    expect(room.phase).toBe('results');
    expect(server.voiceContinueResults('PAINT','stale')).toBe(false);
    expect(server.voiceContinueResults('PAINT',playerId)).toBe(true);
    await wait(20);
    expect(display.msgs).toContainEqual(expect.objectContaining({type:'show_results',generation:room.generation}));
    send(display.ws,{type:'ack_results',generation:room.generation+1});await wait(20);
    expect(room.resultsPresented).toBe(false);
    send(display.ws,{type:'ack_results',generation:room.generation});await wait(20);
    expect(room.resultsPresented).toBe(true);
    expect(presentations).toContainEqual(expect.objectContaining({kind:'results',generation:room.generation}));
    display.ws.close();
  });

  it('keeps the finished battle on a connected display after the last caller hangs up', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const playerId = server.voiceJoin('HANGUP-RESULT', 'Ada')!;
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'HANGUP-RESULT' });
    await wait(20);
    server.voiceAdvance('HANGUP-RESULT', playerId);
    server.voiceSelectMonster('HANGUP-RESULT', playerId, 'embertail');
    server.voiceAdvance('HANGUP-RESULT', playerId);
    const room = server.findRoom('HANGUP-RESULT')!;
    for (let index = 0; index < 100 && room.phase === 'battle'; index++) {
      const snap = room.snapshot()!;
      room.chooseMove(playerId, snap.a.moves[1]!.id);
      if (room.aiPending()) room.resolveAiTurn();
    }
    expect(room.phase).toBe('results');
    expect(server.voiceContinueResults('HANGUP-RESULT', playerId)).toBe(true);
    send(display.ws, { type: 'ack_results', generation: room.generation });
    await wait(20);
    const finished = room.result();

    server.voiceLeave('HANGUP-RESULT', playerId);
    await wait(20);
    expect(server.findRoom('HANGUP-RESULT')).toBe(room);
    expect(room.phase).toBe('results');
    expect(room.result()).toEqual(finished);
    expect(display.msgs.filter(message => message.type === 'battle_state').at(-1))
      .toMatchObject({ type: 'battle_state', phase: 'results', canRematch: false });

    const lateDisplay = await connectCollect(port);
    send(lateDisplay.ws, { type: 'spectate', roomCode: 'HANGUP-RESULT' });
    await wait(20);
    expect(lateDisplay.msgs).toContainEqual(expect.objectContaining({ type: 'battle_state', phase: 'results' }));
    const next = server.voiceJoin('HANGUP-RESULT', 'Bo');
    expect(next).toBeTruthy();
    expect(room.phase).toBe('lobby');
    display.ws.close(); lateDisplay.ws.close();
  });

  it('recovers standalone results after display reconnect and releases them after the grace period', async () => {
    server = new BattleServer({ port: 0, resultReconnectGraceMs: 300 });
    const port = await server.start();
    const playerId = server.voiceJoin('RESULT-RECONNECT', 'Ada')!;
    server.voiceAdvance('RESULT-RECONNECT', playerId);
    server.voiceSelectMonster('RESULT-RECONNECT', playerId, 'embertail');
    server.voiceAdvance('RESULT-RECONNECT', playerId);
    const room = server.findRoom('RESULT-RECONNECT')!;
    for (let index = 0; index < 100 && room.phase === 'battle'; index++) {
      const snap = room.snapshot()!;
      room.chooseMove(playerId, snap.a.moves[1]!.id);
      if (room.aiPending()) room.resolveAiTurn();
    }
    expect(room.phase).toBe('results');
    // The match normally holds the victory beat before accepting result presentation. Advance
    // that deadline so this test isolates the later display-reconnect grace period.
    (room as unknown as { resultsReadyAt: number }).resultsReadyAt = Date.now() - 1;
    room.acknowledgeResultsPresented(room.generation);
    const finished = room.result();
    const first = await connectCollect(port);
    send(first.ws, { type: 'spectate', roomCode: room.code });
    await wait(20);
    server.voiceLeave(room.code, playerId);
    first.ws.close();
    await new Promise<void>(resolve => first.ws.once('close', () => resolve()));
    expect(server.findRoom(room.code)).toBe(room);

    const restored = await connectCollect(port);
    send(restored.ws, { type: 'spectate', roomCode: room.code });
    await wait(20);
    expect(restored.msgs).toContainEqual(expect.objectContaining({ type: 'battle_state', phase: 'results' }));
    expect(room.result()).toEqual(finished);
    await wait(350);
    expect(server.findRoom(room.code)).toBe(room);

    restored.ws.close();
    await new Promise<void>(resolve => restored.ws.once('close', () => resolve()));
    await wait(350);
    expect(server.findRoom(room.code)).toBeUndefined();
  });

  it('does not replay abandoned battle animations after a display reconnects to setup', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const playerId = server.voiceJoin('ABANDONED-BEATS', 'Ada')!;
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'ABANDONED-BEATS' });
    await wait(20);
    server.voiceAdvance('ABANDONED-BEATS', playerId);
    server.voiceSelectMonster('ABANDONED-BEATS', playerId, 'embertail');
    server.voiceAdvance('ABANDONED-BEATS', playerId);
    const battle = server.findRoom('ABANDONED-BEATS')!;
    expect(battle.phase).toBe('battle');
    expect(server.voiceChooseAction('ABANDONED-BEATS', playerId,
      { kind: 'fight', moveId: battle.snapshot()!.a.moves[0]!.id })).toBe(true);
    await wait(20);
    expect(display.msgs.some(message => message.type === 'battle_events')).toBe(true);

    server.voiceLeave('ABANDONED-BEATS', playerId);
    expect(server.findRoom('ABANDONED-BEATS')?.phase).toBe('lobby');
    expect(server.hasPendingPresentation('ABANDONED-BEATS')).toBe(false);
    const reconnected = await connectCollect(port);
    send(reconnected.ws, { type: 'spectate', roomCode: 'ABANDONED-BEATS' });
    await wait(20);
    expect(reconnected.msgs).toContainEqual(expect.objectContaining({ type: 'battle_state', phase: 'lobby' }));
    expect(reconnected.msgs.some(message => message.type === 'battle_events')).toBe(false);
    display.ws.close(); reconnected.ws.close();
  });
  it('reports voice setup and menu mutations from the authoritative room result', () => {
    server = new BattleServer({});
    const id = server.voiceJoin('VOICE', 'Ada')!;
    expect(server.voiceBackSetup('VOICE', id)).toBe(false);
    expect(server.voiceAdvance('VOICE', id)).toBe(true);
    expect(server.voiceSelectMonster('VOICE', id, 'missing')).toBe(false);
    expect(server.voiceSelectMonster('VOICE', id, 'sparkmouse')).toBe(true);
    expect(server.voiceBackSetup('VOICE', id)).toBe(true);
    expect(server.findRoom('VOICE')?.phase).toBe('lobby');
    expect(server.voiceAdvance('VOICE', id)).toBe(true);
    expect(server.voiceSelectMonster('VOICE', id, 'sparkmouse')).toBe(true);
    expect(server.voiceAdvance('VOICE', id)).toBe(true);
    expect(server.voiceOpenFight('VOICE', 'missing')).toBe(false);
    expect(server.voiceOpenFight('VOICE', id)).toBe(true);
    expect(server.voiceBackMenu('VOICE', id)).toBe(true);
  });

  it('does not advance a paid station battle out of results', async () => {
    server=new BattleServer({port:0,displayToken:'paid-station-display-token'});
    server.setBrowserPlayerAdmission(code=>code!=='PAID');
    const port=await server.start();
    const playerId=server.voiceJoin('PAID','Ada')!;
    const room=server.findRoom('PAID')!;
    (room as unknown as {_phase:string})._phase='results';

    const display=await connectCollect(port);
    send(display.ws,{type:'spectate',roomCode:'PAID',displayToken:'paid-station-display-token'});await wait(20);
    send(display.ws,{type:'advance'});await wait(20);

    server.voiceAdvance('PAID');

    expect(room.phase).toBe('results');
    expect(room.lobbyPlayers()).toContainEqual(expect.objectContaining({playerId}));
    expect(display.msgs).toContainEqual(expect.objectContaining({type:'error',code:'station_requeue_required'}));
    display.ws.close();
  });

  it('requires both current callers to request a result rematch while the display watches', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const participant = await connectCollect(port);
    send(participant.ws, { type: 'join', roomCode: 'RESULT-AUTH', name: 'Ada' });
    await wait(20);
    const original = participant.msgs.find(message => message.type === 'joined')?.playerId as string;
    expect(original).toBeTruthy();
    const leader = await connectCollect(port);
    send(leader.ws, { type: 'spectate', roomCode: 'RESULT-AUTH' });
    await wait(20);
    const secondary = await connectCollect(port);
    send(secondary.ws, { type: 'spectate', roomCode: 'RESULT-AUTH' });
    await wait(20);

    const room = server.findRoom('RESULT-AUTH')!;
    room.advance(original);
    room.selectMonster(original, 'embertail');
    room.advance(original);
    for (let index = 0; index < 100 && room.phase === 'battle'; index++) {
      const snap = room.snapshot()!;
      room.chooseMove(original, snap.a.moves[1]!.id);
      if (room.aiPending()) room.resolveAiTurn();
    }
    expect(room.phase).toBe('results');
    room.acknowledgeResultsPresented(room.generation);

    const late = await connectCollect(port);
    send(late.ws, { type: 'join', roomCode: 'RESULT-AUTH', name: 'Late' });
    await wait(30);
    const lastResult = (messages: Record<string, unknown>[]) => messages
      .filter(message => message.type === 'battle_state' && message.phase === 'results').at(-1);
    expect(lastResult(participant.msgs)?.canRematch).toBe(true);
    expect(lastResult(leader.msgs)?.canRematch).toBe(false);
    expect(lastResult(secondary.msgs)?.canRematch).toBe(false);
    expect(lastResult(late.msgs)?.canRematch).toBe(true);
    expect(server.voiceAdvance('RESULT-AUTH')).toBe(false);
    expect(room.phase).toBe('results');

    send(secondary.ws, { type: 'advance' });
    send(late.ws, { type: 'advance' });
    await wait(30);
    expect(secondary.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'forbidden' }));
    expect(room.phase).toBe('results');
    const observedPhases: string[] = [];
    server.setOnRoomState(code => {
      const current = server.findRoom(code);
      if (code === 'RESULT-AUTH' && current) observedPhases.push(current.phase);
    });
    send(leader.ws, { type: 'advance' });
    await wait(30);
    expect(leader.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'caller_ready_required' }));
    expect(room.phase).toBe('results');
    send(participant.ws, { type: 'advance' });
    await wait(30);
    expect(room.phase).toBe('monster_select');
    expect(observedPhases.at(-1)).toBe('monster_select');
    expect(leader.msgs).toContainEqual(expect.objectContaining({ type: 'battle_state', phase: 'monster_select' }));
    participant.ws.close(); leader.ws.close(); secondary.ws.close(); late.ws.close();
  });

  it('unlocks a waiting standalone caller after the finished player leaves', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const original = await connectCollect(port);
    send(original.ws, { type: 'join', roomCode: 'RESULT-HANDOFF', name: 'Ada' });
    await wait(20);
    const originalId = original.msgs.find(message => message.type === 'joined')?.playerId as string;
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'RESULT-HANDOFF' });
    await wait(20);
    const room = server.findRoom('RESULT-HANDOFF')!;
    room.advance(originalId);
    room.selectMonster(originalId, 'embertail');
    room.advance(originalId);
    for (let index = 0; index < 100 && room.phase === 'battle'; index++) {
      const snap = room.snapshot()!;
      room.chooseMove(originalId, snap.a.moves[1]!.id);
      if (room.aiPending()) room.resolveAiTurn();
    }
    expect(room.phase).toBe('results');
    room.acknowledgeResultsPresented(room.generation);
    const waiting = await connectCollect(port);
    send(waiting.ws, { type: 'join', roomCode: 'RESULT-HANDOFF', name: 'Bo' });
    await wait(20);
    expect(waiting.msgs.filter(message => message.type === 'battle_state').at(-1)?.canRematch).toBe(true);
    expect(display.msgs.filter(message => message.type === 'battle_state').at(-1)?.canRematch).toBe(false);
    send(waiting.ws, { type: 'advance' });
    await wait(30);
    expect(room.phase).toBe('results');

    send(original.ws, { type: 'leave' });
    await wait(30);
    expect(room.phase).toBe('results');
    const waitingId = waiting.msgs.find(message => message.type === 'joined')?.playerId as string;
    expect(room.isSetupReady(waitingId)).toBe(false);
    expect(waiting.msgs.filter(message => message.type === 'battle_state').at(-1)?.canRematch).toBe(true);
    expect(display.msgs.filter(message => message.type === 'battle_state').at(-1)?.canRematch).toBe(true);
    send(waiting.ws, { type: 'advance' });
    await wait(30);
    expect(room.phase).toBe('monster_select');
    waiting.ws.close(); display.ws.close();
  });
  it('sends the roster on connect', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const { ws, msgs } = await connectCollect(port);
    await wait(60);
    const roster = msgs.find(m => m.type === 'roster');
    expect(roster).toBeDefined();
    expect((roster!.monsters as unknown[]).length).toBe(8);
    ws.close();
  });

  it('a player joins and gets a joined ack + lobby state', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const { ws, msgs } = await connectCollect(port);
    send(ws, { type: 'join', roomCode: '4821', name: 'Ada' });
    await wait(60);
    expect(msgs.find(m => m.type === 'joined')).toBeDefined();
    const state = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect(state.phase).toBe('lobby');
    expect((state.players as unknown[]).length).toBe(1);
    ws.close();
  });

  it('single-player: join → advance → pick monster → advance → choose move resolves a turn', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const { ws, msgs } = await connectCollect(port);
    send(ws, { type: 'join', roomCode: '4821', name: 'Ada' });
    await wait(40);
    send(ws, { type: 'advance' });                                  // → monster_select
    await wait(40);
    send(ws, { type: 'select_monster', monsterId: 'sparkmouse' });
    await wait(40);
    send(ws, { type: 'advance' });                                  // → battle (vs AI)
    await wait(40);
    let state = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect(state.phase).toBe('battle');
    const snap = state.snapshot as { a: { moves: { id: string }[] }, turn: number };
    const before = snap.turn;
    send(ws, { type: 'choose_move', moveId: snap.a.moves[0]!.id });
    // The human's action resolves immediately; the AI takes a separate beat (~700ms server-side).
    await wait(60);
    let mid = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect((mid.snapshot as { turn: number, chosen: { a: boolean } }).turn).toBe(before + 1);
    expect((mid.snapshot as { chosen: { a: boolean } }).chosen.a).toBe(false);
    expect((mid as { activeSide?: string }).activeSide).toBe('b');
    expect(msgs.some(m => m.type === 'battle_events')).toBe(true);
    await wait(800);                                                     // AI beat fires
    state = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect((state.snapshot as { turn: number }).turn).toBe(before + 2);
    expect((state as { activeSide?: string }).activeSide).toBe('a');
    ws.close();
  });

  it('heartbeat: an idle joined player survives many ping cycles (stays in the room)', async () => {
    // Reproduces the "select screen reverts to play-here" bug: on an idle socket the heartbeat must
    // keep the connection alive AND the player in their slot. A responsive ws client auto-pongs, so
    // across several fast sweeps it should never be terminated or dropped. (heartbeatMs tiny for speed.)
    server = new BattleServer({ port: 0, heartbeatMs: 100 });
    const port = await server.start();
    const { ws, msgs } = await connectCollect(port);
    send(ws, { type: 'join', roomCode: '4821', name: 'Ada' });
    await wait(40);
    send(ws, { type: 'advance' });   // → monster_select, then sit idle
    await wait(550);                 // several heartbeat sweeps with no app traffic
    expect(ws.readyState).toBe(WebSocket.OPEN);                         // socket stayed up
    const state = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect(state.phase).toBe('monster_select');                        // did NOT revert to lobby
    expect((state.players as unknown[]).length).toBe(1);               // still in their slot
    ws.close();
  });

  it('two players in the same room both appear in the roster state', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const { ws: a, msgs: am } = await connectCollect(port);
    const { ws: b } = await connectCollect(port);
    send(a, { type: 'join', roomCode: '4821', name: 'Ada' });
    send(b, { type: 'join', roomCode: '4821', name: 'Bo' });
    await wait(80);
    const state = am.filter(m => m.type === 'battle_state').at(-1)!;
    expect((state.players as unknown[]).length).toBe(2);
    a.close(); b.close();
  });

  it('treats a repeated join frame on one socket as idempotent', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const { ws, msgs } = await connectCollect(port);
    send(ws, { type: 'join', roomCode: '4821', name: 'Ada' });
    await wait(40);
    send(ws, { type: 'join', roomCode: '4821', name: 'Ada' });
    await wait(40);

    const state = msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect((state.players as unknown[])).toHaveLength(1);
    ws.close();
  });

  it('resumes a browser player session without resetting an active battle', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const sessionId = 'browser-session-1';
    const first = await connectCollect(port);
    send(first.ws, { type: 'join', roomCode: '4821', name: 'Ada', sessionId });
    await wait(40);
    const originalId = String(first.msgs.find(m => m.type === 'joined')!.playerId);
    send(first.ws, { type: 'advance' });
    await wait(40);
    send(first.ws, { type: 'select_monster', monsterId: 'sparkmouse' });
    await wait(40);
    send(first.ws, { type: 'advance' });
    await wait(40);
    expect(first.msgs.filter(m => m.type === 'battle_state').at(-1)!.phase).toBe('battle');

    first.ws.close();
    await new Promise<void>(r => first.ws.once('close', () => r()));
    const resumed = await connectCollect(port);
    send(resumed.ws, { type: 'join', roomCode: '4821', name: 'Ada', sessionId });
    await wait(60);

    expect(String(resumed.msgs.find(m => m.type === 'joined')!.playerId)).toBe(originalId);
    const state = resumed.msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect(state.phase).toBe('battle');
    expect((state.players as { playerId: string; monsterId: string }[])).toEqual([
      expect.objectContaining({ playerId: originalId, monsterId: 'sparkmouse' }),
    ]);
    resumed.ws.close();
  });

  it('requires a held caller to confirm each shared setup screen again after reconnect', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'HELD-SETUP' });
    send(display.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    const first = await connectCollect(port);
    const second = await connectCollect(port);
    send(first.ws, { type: 'join', roomCode: 'HELD-SETUP', name: 'Ada', sessionId: 'ada-setup' });
    send(second.ws, { type: 'join', roomCode: 'HELD-SETUP', name: 'Bo', sessionId: 'bo-setup' });
    await wait(30);
    const adaId = String(first.msgs.find(message => message.type === 'joined')?.playerId);
    const room = server.findRoom('HELD-SETUP')!;
    send(first.ws, { type: 'advance' });
    await wait(20);
    expect(room.isSetupReady(adaId)).toBe(true);

    first.ws.close();
    await new Promise<void>(resolve => first.ws.once('close', () => resolve()));
    await wait(20);
    expect(room.isSetupReady(adaId)).toBe(false);
    send(second.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('lobby');

    const lobbyReturn = await connectCollect(port);
    send(lobbyReturn.ws, { type: 'join', roomCode: 'HELD-SETUP', name: 'Ada', sessionId: 'ada-setup' });
    await wait(20);
    expect(lobbyReturn.msgs.find(message => message.type === 'joined')?.playerId).toBe(adaId);
    expect(room.isSetupReady(adaId)).toBe(false);
    send(lobbyReturn.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('monster_select');

    send(lobbyReturn.ws, { type: 'select_monster', monsterId: 'sparkmouse' });
    send(second.ws, { type: 'select_monster', monsterId: 'embertail' });
    await wait(20);
    send(lobbyReturn.ws, { type: 'advance' });
    await wait(20);
    expect(room.isSetupReady(adaId)).toBe(true);
    lobbyReturn.ws.close();
    await new Promise<void>(resolve => lobbyReturn.ws.once('close', () => resolve()));
    await wait(20);
    expect(room.isSetupReady(adaId)).toBe(false);
    send(second.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('monster_select');

    const selectionReturn = await connectCollect(port);
    send(selectionReturn.ws, { type: 'join', roomCode: 'HELD-SETUP', name: 'Ada', sessionId: 'ada-setup' });
    await wait(20);
    expect(selectionReturn.msgs.find(message => message.type === 'joined')?.playerId).toBe(adaId);
    send(selectionReturn.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('battle');
    selectionReturn.ws.close(); second.ws.close(); display.ws.close();
  });

  it('holds a human duel result through reconnect and requires the survivor to request replay', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'HELD-RESULT' });
    send(display.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    const first = await connectCollect(port);
    const second = await connectCollect(port);
    send(first.ws, { type: 'join', roomCode: 'HELD-RESULT', name: 'Ada', sessionId: 'ada-result' });
    send(second.ws, { type: 'join', roomCode: 'HELD-RESULT', name: 'Bo', sessionId: 'bo-result' });
    await wait(30);
    const adaId = String(first.msgs.find(message => message.type === 'joined')?.playerId);
    const boId = String(second.msgs.find(message => message.type === 'joined')?.playerId);
    const room = server.findRoom('HELD-RESULT')!;
    room.advance(adaId); room.advance(boId);
    room.selectMonster(adaId, 'sparkmouse'); room.selectMonster(boId, 'embertail');
    room.advance(adaId); room.advance(boId);
    for (let index = 0; index < 200 && room.phase === 'battle'; index++) {
      const snap = room.snapshot()!;
      if (room.activeSide() === 'a') room.chooseMove(adaId, snap.a.moves[0]!.id);
      else room.chooseMove(boId, snap.b.moves[0]!.id);
    }
    expect(room.phase).toBe('results');
    room.acknowledgeResultsPresented(room.generation);
    const result = room.result();
    send(second.ws, { type: 'advance' });
    await wait(20);
    expect(room.isSetupReady(boId)).toBe(true);

    second.ws.close();
    await new Promise<void>(resolve => second.ws.once('close', () => resolve()));
    await wait(20);
    expect(room.isSetupReady(boId)).toBe(false);
    send(first.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('results');
    expect(room.result()).toEqual(result);

    const returned = await connectCollect(port);
    send(returned.ws, { type: 'join', roomCode: 'HELD-RESULT', name: 'Bo', sessionId: 'bo-result' });
    await wait(20);
    expect(returned.msgs.find(message => message.type === 'joined')?.playerId).toBe(boId);
    expect(room.phase).toBe('results');
    expect(room.isSetupReady(boId)).toBe(false);
    returned.ws.close();
    await new Promise<void>(resolve => returned.ws.once('close', () => resolve()));

    const release = await connectCollect(port);
    send(release.ws, { type: 'spectate', roomCode: 'HELD-RESULT' });
    send(release.ws, { type: 'leave', sessionId: 'bo-result' });
    await wait(20);
    expect(room.phase).toBe('results');
    expect(room.result()).toEqual(result);
    expect(room.isSetupReady(adaId)).toBe(false);
    const lastDisplay = display.msgs.filter(message => message.type === 'battle_state').at(-1);
    expect(lastDisplay).toMatchObject({ phase: 'results', canRematch: false });
    send(display.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('results');
    expect(display.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'caller_ready_required' }));
    send(first.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('monster_select');
    first.ws.close(); release.ws.close(); display.ws.close();
  });

  it('keeps replay on the surviving caller’s phone after an unreserved duel loses a player', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode: 'OPEN-DUEL-RESULT' });
    await wait(20);
    const ada = server.voiceJoin('OPEN-DUEL-RESULT', 'Ada')!;
    const bo = server.voiceJoin('OPEN-DUEL-RESULT', 'Bo')!;
    const room = server.findRoom('OPEN-DUEL-RESULT')!;
    server.voiceAdvance(room.code, ada); server.voiceAdvance(room.code, bo);
    server.voiceSelectMonster(room.code, ada, 'sparkmouse');
    server.voiceSelectMonster(room.code, bo, 'embertail');
    server.voiceAdvance(room.code, ada); server.voiceAdvance(room.code, bo);
    for (let index = 0; index < 200 && room.phase === 'battle'; index++) {
      const snap = room.snapshot()!;
      if (room.activeSide() === 'a') room.chooseMove(ada, snap.a.moves[0]!.id);
      else room.chooseMove(bo, snap.b.moves[0]!.id);
    }
    expect(room.phase).toBe('results');
    room.acknowledgeResultsPresented(room.generation);
    server.voiceLeave(room.code, bo);
    await wait(20);
    expect(room.expectedPlayerCount).toBe(1);
    expect(display.msgs.filter(message => message.type === 'battle_state').at(-1))
      .toMatchObject({ phase: 'results', canRematch: false });

    send(display.ws, { type: 'advance' });
    await wait(20);
    expect(room.phase).toBe('results');
    expect(display.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'caller_ready_required' }));
    expect(server.voiceAdvance(room.code, ada)).toBe(true);
    expect(room.phase).toBe('monster_select');
    display.ws.close();
  });

  it('closes a replaced browser tab with a non-reconnect takeover code', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const sessionId = 'shared-tab-session';
    const first = await connectCollect(port);
    send(first.ws, { type: 'join', roomCode: '4821', name: 'Ada', sessionId });
    await wait(40);
    const closed = new Promise<number>(r => first.ws.once('close', code => r(code)));
    const second = await connectCollect(port);
    send(second.ws, { type: 'join', roomCode: '4821', name: 'Ada', sessionId });

    expect(await closed).toBe(4001);
    await wait(40);
    expect((second.msgs.filter(m => m.type === 'battle_state').at(-1)!.players as unknown[])).toHaveLength(1);
    second.ws.close();
  });

  it('releases a held player session when leave arrives on the reconnecting spectator socket', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const sessionId = 'release-session';
    const first = await connectCollect(port);
    send(first.ws, { type: 'join', roomCode: '4821', name: 'Ada', sessionId });
    await wait(40);
    first.ws.close();
    await new Promise<void>(r => first.ws.once('close', () => r()));

    const spec = await connectCollect(port);
    send(spec.ws, { type: 'spectate', roomCode: '4821' });
    send(spec.ws, { type: 'leave', sessionId });
    await wait(60);

    const state = spec.msgs.filter(m => m.type === 'battle_state').at(-1)!;
    expect((state.players as unknown[])).toHaveLength(0);
    spec.ws.close();
  });

  it('keeps a replacement keyboard owner when an older reconnect repeats its late leave', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const roomCode = 'RAPID-P-TOGGLE';
    const sessionId = 'keyboard-session';
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode });
    send(display.ws, { type: 'configure_players', count: 1 });
    await wait(20);

    const first = await connectCollect(port);
    send(first.ws, { type: 'join', roomCode, name: 'Tester', sessionId });
    await wait(20);
    expect(first.msgs.find(message => message.type === 'joined')?.playerId).toEqual(expect.any(String));
    const closed = new Promise<void>(resolve => first.ws.once('close', resolve));
    first.ws.close(); await closed;

    const release = await connectCollect(port);
    send(release.ws, { type: 'leave', sessionId });
    await wait(20);
    expect(release.msgs).toContainEqual({ type: 'session_released', sessionId });

    const replacement = await connectCollect(port);
    const replacementSessionId = 'replacement-session';
    send(replacement.ws, { type: 'join', roomCode, name: 'Tester', sessionId: replacementSessionId });
    await wait(20);
    const replacementPlayerId = replacement.msgs.find(message => message.type === 'joined')?.playerId;
    expect(replacementPlayerId).toEqual(expect.any(String));

    const delayedRelease = await connectCollect(port);
    send(delayedRelease.ws, { type: 'leave', sessionId });
    await wait(20);
    expect(server.findRoom(roomCode)?.lobbyPlayers().filter(player => !player.isAi).map(player => player.playerId))
      .toEqual([replacementPlayerId]);
    expect(server.voiceJoin(roomCode, 'Phone')).toBeNull();
    expect(display.ws.readyState).toBe(WebSocket.OPEN);

    send(replacement.ws, { type: 'leave', sessionId: replacementSessionId });
    await wait(20);
    expect(server.voiceJoin(roomCode, 'Phone')).toEqual(expect.any(String));
    delayedRelease.ws.close(); replacement.ws.close(); release.ws.close(); display.ws.close();
  });

  it('records a release before its old join arrives so the stale join cannot claim a seat', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const roomCode = 'DELAYED-OLD-JOIN';
    const oldSessionId = 'old-keyboard-session';
    const release = await connectCollect(port);
    send(release.ws, { type: 'leave', sessionId: oldSessionId });
    await wait(20);
    expect(release.msgs).toContainEqual({ type: 'session_released', sessionId: oldSessionId });

    const lateJoin = await connectCollect(port);
    send(lateJoin.ws, { type: 'join', roomCode, name: 'Old keyboard', sessionId: oldSessionId });
    await wait(20);
    expect(lateJoin.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'session_released' }));
    expect(server.findRoom(roomCode)?.playerCount ?? 0).toBe(0);

    const replacement = await connectCollect(port);
    send(replacement.ws, { type: 'join', roomCode, name: 'New keyboard', sessionId: 'new-keyboard-session' });
    await wait(20);
    expect(replacement.msgs).toContainEqual(expect.objectContaining({ type: 'joined' }));
    expect(server.findRoom(roomCode)?.playerCount).toBe(1);
    replacement.ws.close(); lateJoin.ws.close(); release.ws.close();
  });

  it('releases an old keyboard seat when its reconnect leave arrives before the server sees its close', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const roomCode = 'RELEASE-BEFORE-CLOSE';
    const sessionId = 'old-keyboard-session';
    const old = await connectCollect(port);
    send(old.ws, { type: 'join', roomCode, name: 'Tester', sessionId });
    await wait(20);
    expect(server.findRoom(roomCode)?.playerCount).toBe(1);

    const release = await connectCollect(port);
    send(release.ws, { type: 'leave', sessionId });
    await wait(20);
    expect(release.msgs).toContainEqual({ type: 'session_released', sessionId });
    expect(server.findRoom(roomCode)?.playerCount ?? 0).toBe(0);

    const replacement = await connectCollect(port);
    send(replacement.ws, { type: 'join', roomCode, name: 'Tester', sessionId: 'new-keyboard-session' });
    await wait(20);
    old.ws.close();
    await wait(20);
    expect(server.findRoom(roomCode)?.playerCount).toBe(1);
    replacement.ws.close(); release.ws.close();
  });

  it('keeps a combined display socket watching when another socket releases its player session', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const roomCode = 'COMBINED-DISPLAY-RELEASE';
    const sessionId = 'combined-session';
    const display = await connectCollect(port);
    send(display.ws, { type: 'spectate', roomCode });
    send(display.ws, { type: 'configure_players', count: 1 });
    send(display.ws, { type: 'join', roomCode, name: 'Tester', sessionId });
    await wait(20);
    expect(server.findRoom(roomCode)?.expectedPlayerCount).toBe(1);

    const release = await connectCollect(port);
    send(release.ws, { type: 'leave', sessionId });
    await wait(20);
    expect(server.findRoom(roomCode)?.playerCount).toBe(0);
    send(display.ws, { type: 'configure_players', count: 2 });
    await wait(20);
    expect(server.findRoom(roomCode)?.expectedPlayerCount).toBe(2);
    expect(display.ws.readyState).toBe(WebSocket.OPEN);
    release.ws.close(); display.ws.close();
  });

  it('two-player battle broadcasts activeSide and activeMenu, and gates commands to that side', async () => {
    server = new BattleServer({ port: 0 });
    const port = await server.start();
    const { ws: a, msgs: am } = await connectCollect(port);
    const { ws: b } = await connectCollect(port);
    send(a, { type: 'join', roomCode: '4821', name: 'Ada' });
    send(b, { type: 'join', roomCode: '4821', name: 'Bo' });
    await wait(60);
    send(a, { type: 'advance' });
    await wait(40);
    send(b, { type: 'advance' });
    await wait(40);
    send(a, { type: 'select_monster', monsterId: 'sparkmouse' });
    send(b, { type: 'select_monster', monsterId: 'embertail' });
    await wait(60);
    send(a, { type: 'advance' });
    send(b, { type: 'advance' });
    await wait(60);
    let state = am.filter(m => m.type === 'battle_state').at(-1)! as { activeSide: string; activeMenu: string; snapshot: { chosen: { a: boolean; b: boolean }; turn: number; a: { moves: { id: string }[] }; b: { moves: { id: string }[] } } };
    const before = state.snapshot.turn;
    expect(['a','b']).toContain(state.activeSide);
    expect(state.activeMenu).toBe('root');

    const active = state.activeSide === 'a' ? a : b;
    const inactive = state.activeSide === 'a' ? b : a;
    const activeSide = state.activeSide as 'a' | 'b';
    const inactiveSide = activeSide === 'a' ? 'b' : 'a';

    send(inactive, { type: 'open_fight' });
    await wait(40);
    state = am.filter(m => m.type === 'battle_state').at(-1)! as typeof state;
    expect(state.activeMenu).toBe('root');

    send(active, { type: 'open_fight' });
    await wait(40);
    state = am.filter(m => m.type === 'battle_state').at(-1)! as typeof state;
    expect(state.activeMenu).toBe('fight');

    send(inactive, { type: 'choose_move', moveId: state.snapshot[inactiveSide].moves[0]!.id });
    await wait(40);
    state = am.filter(m => m.type === 'battle_state').at(-1)! as typeof state;
    expect(state.snapshot.chosen[inactiveSide]).toBe(false);

    send(active, { type: 'choose_move', moveId: state.snapshot[activeSide].moves[0]!.id });
    await wait(40);
    state = am.filter(m => m.type === 'battle_state').at(-1)! as typeof state;
    expect(state.snapshot.chosen[activeSide]).toBe(false);
    expect(state.snapshot.turn).toBe(before + 1);
    expect(state.activeSide).toBe(inactiveSide);

    a.close(); b.close();
  });

  it('hard-aborts a station room and reconnect state', async () => {
    server = new BattleServer({ port: 0 });
    await server.start();
    expect(server.voiceJoin('ABORT', 'Caller')).not.toBeNull();
    expect(server.abortRoom('ABORT')).toBe(true);
    expect(server.findRoom('ABORT')).toBeUndefined();
    expect(server.abortRoom('ABORT')).toBe(false);
  });

  it('pushes a retained caller state update when expected station players decrease', async () => {
    server=new BattleServer({port:0});await server.start();let updates=0;server.setOnRoomState(()=>updates++);
    const id=server.voiceJoin('EXPECT','Bo','b',2)!;server.voiceSelectMonster('EXPECT',id,ROSTER[0]!.id);
    const before=updates;server.voiceExpectHumanPlayers('EXPECT',1);
    expect(server.findRoom('EXPECT')?.playerSide(id)).toBe('a');expect(updates).toBeGreaterThan(before);
  });

  it('requires bound voice callers to advance both setup gates', async () => {
    server=new BattleServer({port:0});await server.start();
    const ada=server.voiceJoin('VOICE','Ada')!,bo=server.voiceJoin('VOICE','Bo')!;
    const room=server.findRoom('VOICE')!;
    expect(room.phase).toBe('lobby');expect(server.voiceAdvance('VOICE')).toBe(false);
    expect(server.voiceAdvance('VOICE',ada)).toBe(true);expect(room.phase).toBe('lobby');
    expect(server.voiceAdvance('VOICE',bo)).toBe(true);expect(room.phase).toBe('monster_select');
    server.voiceSelectMonster('VOICE',ada,ROSTER[0]!.id);server.voiceSelectMonster('VOICE',bo,ROSTER[1]!.id);
    expect(room.phase).toBe('monster_select');expect(server.voiceAdvance('VOICE')).toBe(false);
    expect(server.voiceAdvance('VOICE',bo)).toBe(true);expect(room.phase).toBe('monster_select');
    expect(server.voiceAdvance('VOICE',ada)).toBe(true);expect(room.phase).toBe('battle');
  });
});
