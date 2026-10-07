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

  it('lets the authenticated station display select each caller’s monster and use setup menus', async () => {
    server=new BattleServer({port:0,displayToken:'touch-token'});
    server.setBrowserPlayerAdmission(code=>code!=='TOUCH');
    const port=await server.start();
    const first=server.voiceJoin('TOUCH','Ada','a',2)!;
    const second=server.voiceJoin('TOUCH','Bo','b',2)!;
    const display=await connectCollect(port);
    send(display.ws,{type:'spectate',roomCode:'TOUCH',displayToken:'touch-token'});await wait(20);
    send(display.ws,{type:'advance'});await wait(20);
    expect(server.findRoom('TOUCH')?.phase).toBe('monster_select');
    send(display.ws,{type:'display_select_monster',playerId:first,monsterId:'embertail'});
    send(display.ws,{type:'display_select_monster',playerId:second,monsterId:'thornling'});
    await wait(20);
    expect(server.findRoom('TOUCH')?.lobbyPlayers()).toEqual(expect.arrayContaining([
      expect.objectContaining({playerId:first,monsterId:'embertail'}),
      expect.objectContaining({playerId:second,monsterId:'thornling'}),
    ]));
    send(display.ws,{type:'back'});await wait(20);
    expect(server.findRoom('TOUCH')?.phase).toBe('lobby');
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

  it('offers result rematch only to a finished participant or the elected standalone display', async () => {
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
    expect(lastResult(leader.msgs)?.canRematch).toBe(true);
    expect(lastResult(secondary.msgs)?.canRematch).toBe(false);
    expect(lastResult(late.msgs)?.canRematch).toBe(false);
    expect(server.voiceAdvance('RESULT-AUTH')).toBe(false);
    expect(room.phase).toBe('results');

    send(secondary.ws, { type: 'advance' });
    send(late.ws, { type: 'advance' });
    await wait(30);
    expect(secondary.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'forbidden' }));
    expect(late.msgs).toContainEqual(expect.objectContaining({ type: 'error', code: 'not_ready' }));
    expect(room.phase).toBe('results');
    const observedPhases: string[] = [];
    server.setOnRoomState(code => {
      const current = server.findRoom(code);
      if (code === 'RESULT-AUTH' && current) observedPhases.push(current.phase);
    });
    send(leader.ws, { type: 'advance' });
    await wait(30);
    expect(room.phase).toBe('monster_select');
    expect(observedPhases.at(-1)).toBe('monster_select');
    expect(leader.msgs).toContainEqual(expect.objectContaining({ type: 'battle_state', phase: 'monster_select' }));
    participant.ws.close(); leader.ws.close(); secondary.ws.close(); late.ws.close();
  });

  it('unlocks a waiting standalone caller after the finished player disconnects', async () => {
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
    expect(waiting.msgs.filter(message => message.type === 'battle_state').at(-1)?.canRematch).toBe(false);

    original.ws.close();
    await wait(30);
    expect(room.phase).toBe('results');
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
    send(a, { type: 'select_monster', monsterId: 'sparkmouse' });
    send(b, { type: 'select_monster', monsterId: 'embertail' });
    await wait(60);
    send(a, { type: 'advance' });
    await wait(60);
    let state = am.filter(m => m.type === 'battle_state').at(-1)! as { activeSide: string; activeMenu: string; snapshot: { chosen: { a: boolean; b: boolean }; turn: number; a: { moves: { id: string }[] }; b: { moves: { id: string }[] } } };
    const before = state.snapshot.turn;
    expect(state.activeSide).toBe('a');
    expect(state.activeMenu).toBe('root');

    send(b, { type: 'open_fight' });
    await wait(40);
    state = am.filter(m => m.type === 'battle_state').at(-1)! as typeof state;
    expect(state.activeMenu).toBe('root');

    send(a, { type: 'open_fight' });
    await wait(40);
    state = am.filter(m => m.type === 'battle_state').at(-1)! as typeof state;
    expect(state.activeMenu).toBe('fight');

    send(b, { type: 'choose_move', moveId: state.snapshot.b.moves[0]!.id });
    await wait(40);
    state = am.filter(m => m.type === 'battle_state').at(-1)! as typeof state;
    expect(state.snapshot.chosen.b).toBe(false);

    send(a, { type: 'choose_move', moveId: state.snapshot.a.moves[0]!.id });
    await wait(40);
    state = am.filter(m => m.type === 'battle_state').at(-1)! as typeof state;
    expect(state.snapshot.chosen.a).toBe(false);
    expect(state.snapshot.turn).toBe(before + 1);
    expect(state.activeSide).toBe('b');

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
    expect(server.voiceAdvance('VOICE',ada)).toBe(true);expect(room.phase).toBe('monster_select');
    server.voiceSelectMonster('VOICE',ada,ROSTER[0]!.id);server.voiceSelectMonster('VOICE',bo,ROSTER[1]!.id);
    expect(room.phase).toBe('monster_select');expect(server.voiceAdvance('VOICE')).toBe(false);
    expect(server.voiceAdvance('VOICE',bo)).toBe(true);expect(room.phase).toBe('battle');
  });
});
