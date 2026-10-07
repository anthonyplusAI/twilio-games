import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import { FighterServer } from '../server/fighter-server';
import { FIGHTER_INTRO_SECONDS } from '../shared/fighter-protocol';

type Message = Record<string, unknown>;
interface Client { ws: WebSocket; messages: Message[]; }

let http: Server | undefined;
let fighter: FighterServer | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  fighter?.stopLoopOnly(); fighter = undefined;
  if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
  http = undefined;
});

async function start(displayToken?: string, heartbeatMs?: number, connected?: (ws:WebSocket)=>void): Promise<number> {
  http = createServer(); fighter = new FighterServer({ server: http, displayToken, heartbeatMs });
  http.on('upgrade', (request, socket, head) => fighter!.handleUpgrade(request, socket, head, connected));
  await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('missing port');
  return address.port;
}

async function connect(port: number): Promise<Client> {
  const client: Client = { ws: new WebSocket(`ws://127.0.0.1:${port}/fighter`), messages: [] };
  client.ws.on('message', data => client.messages.push(JSON.parse(data.toString()) as Message));
  clients.push(client);
  await new Promise<void>((resolve, reject) => { client.ws.once('open', resolve); client.ws.once('error', reject); });
  return client;
}

const send = (client: Client, message: unknown) => client.ws.send(JSON.stringify(message));
async function waitFor(client: Client, predicate: (message: Message) => boolean): Promise<Message> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    for (let index = client.messages.length - 1; index >= 0; index--) {
      const message = client.messages[index]!; if (predicate(message)) return message;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`message not received: ${JSON.stringify(client.messages)}`);
}
function latestState(client: Client): Message | undefined {
  for (let index = client.messages.length - 1; index >= 0; index--) if (client.messages[index]!.type === 'fighter_state') return client.messages[index];
  return undefined;
}

describe('FighterServer WebSocket authority and lifecycle', () => {
  it('recognizes only a live, room-bound and authorized standalone display',async()=>{
    let serverSideDisplay:WebSocket|undefined;
    const port=await start('display-token',undefined,ws=>serverSideDisplay=ws);
    fighter!.setBrowserPlayerAdmission(code=>code!=='PAID');
    const display=await connect(port);
    expect(serverSideDisplay).toBeDefined();
    expect(fighter!.hasStandaloneDisplay(serverSideDisplay!,'PAID')).toBe(false);
    send(display,{type:'display_auth',roomCode:'PAID',token:'display-token'});
    expect(fighter!.hasStandaloneDisplay(serverSideDisplay!,'PAID')).toBe(false);
    send(display,{type:'spectate',roomCode:'PAID'});
    await waitFor(display,message=>message.type==='fighter_state'&&message.roomCode==='PAID');
    expect(fighter!.hasStandaloneDisplay(serverSideDisplay!,'PAID')).toBe(false);
    expect(fighter!.hasStandaloneDisplay(serverSideDisplay!,'OTHER')).toBe(false);
    send(display,{type:'spectate',roomCode:'FREE'});
    await waitFor(display,message=>message.type==='fighter_state'&&message.roomCode==='FREE');
    expect(fighter!.hasStandaloneDisplay(serverSideDisplay!,'FREE')).toBe(true);
    send(display,{type:'leave'});await new Promise(resolve=>setTimeout(resolve,20));
    expect(fighter!.hasStandaloneDisplay(serverSideDisplay!,'FREE')).toBe(false);
    send(display,{type:'spectate',roomCode:'FREE'});
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(fighter!.hasStandaloneDisplay(serverSideDisplay!,'FREE')).toBe(true);
    send(display,{type:'spectate',roomCode:'OTHER'});
    await waitFor(display,message=>message.type==='fighter_state'&&message.roomCode==='OTHER');
    expect(fighter!.hasStandaloneDisplay(serverSideDisplay!,'FREE')).toBe(false);
    expect(fighter!.hasStandaloneDisplay(serverSideDisplay!,'OTHER')).toBe(true);
    display.ws.close();await new Promise<void>(resolve=>display.ws.once('close',()=>resolve()));
    expect(fighter!.hasStandaloneDisplay(serverSideDisplay!,'OTHER')).toBe(false);
  });

  it('accepts only the current host’s current-match fight and result paint receipts', async () => {
    const port=await start('paint-token');fighter!.setBrowserPlayerAdmission(code=>code!=='PAINT');
    const playerId=fighter!.voiceJoin('PAINT','Ada')!;
    fighter!.voiceAdvance('PAINT',playerId);fighter!.voiceSelectFighter('PAINT',playerId,'nyx');
    fighter!.voiceAdvance('PAINT',playerId);fighter!.voiceSelectMap('PAINT',playerId,'void');
    fighter!.voiceAdvance('PAINT',playerId);
    const room=fighter!.findRoom('PAINT')!;
    const generation=room.state().loadingGeneration;
    room.ready(generation);room.tick(FIGHTER_INTRO_SECONDS);room.tick(6);
    const display=await connect(port);
    send(display,{type:'display_auth',roomCode:'PAINT',token:'paint-token'});
    send(display,{type:'spectate',roomCode:'PAINT'});
    await waitFor(display,message=>message.type==='host_identity'&&message.isHost===true);
    send(display,{type:'ack_display',phase:'fight',loadingGeneration:generation+1});
    await new Promise(resolve=>setTimeout(resolve,20));expect(room.hudPresented).toBe(false);
    send(display,{type:'ack_display',phase:'fight',loadingGeneration:generation});
    await waitFor(display,message=>message.type==='fighter_state'&&message.hudPresented===true);
    expect(room.hudPresented).toBe(true);

    const world=room.state().world!;world.status='finished';world.winner='p1';
    room.tick(.1);room.tick(10.5);
    expect(room.phase).toBe('results');
    send(display,{type:'ack_display',phase:'results',loadingGeneration:generation+1});
    await new Promise(resolve=>setTimeout(resolve,20));expect(room.resultsPresented).toBe(false);
    send(display,{type:'ack_display',phase:'results',loadingGeneration:generation});
    await waitFor(display,message=>message.type==='fighter_state'&&message.resultsPresented===true);
    expect(room.resultsPresented).toBe(true);
  });

  it('does not carry one station display authentication into another station room', async () => {
    const port=await start('room-token');fighter!.setBrowserPlayerAdmission(()=>false);
    const display=await connect(port);
    send(display,{type:'display_auth',roomCode:'ROOM-A',token:'room-token'});
    send(display,{type:'spectate',roomCode:'ROOM-B'});
    await waitFor(display,message=>message.type==='error'&&message.code==='bad_display_auth');
    expect(fighter!.findRoom('ROOM-B')).toBeUndefined();
  });

  it('wakes station lifecycle at the bounded result-presentation recovery deadline', async () => {
    await start();
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    try{
      const playerId=fighter!.voiceJoin('RECOVER','Ada')!;
      fighter!.voiceAdvance('RECOVER',playerId);fighter!.voiceSelectFighter('RECOVER',playerId,'nyx');
      fighter!.voiceAdvance('RECOVER',playerId);fighter!.voiceSelectMap('RECOVER',playerId,'void');
      fighter!.voiceAdvance('RECOVER',playerId);
      const room=fighter!.findRoom('RECOVER')!;
      const generation=room.state().loadingGeneration;
      room.ready(generation);room.tick(FIGHTER_INTRO_SECONDS);room.tick(6);
      const world=room.state().world!;world.status='finished';world.winner='p1';
      room.tick(.1);room.tick(10.5);
      const observed:boolean[]=[];
      fighter!.setOnRoomState(()=>observed.push(room.resultsPresentationTimedOut));
      fighter!.voiceSelectFighter('RECOVER',playerId,'nyx');
      expect(observed.at(-1)).toBe(false);
      await vi.advanceTimersByTimeAsync(15_010);
      expect(observed.at(-1)).toBe(true);
      expect(room.resultsPresented).toBe(false);
    }finally{vi.useRealTimers();}
  });

  it('lets a caller reveal the victory result on the current display without rematching', async () => {
    const port=await start();
    const playerId=fighter!.voiceJoin('REVEAL','Ada')!;
    fighter!.voiceAdvance('REVEAL',playerId);fighter!.voiceSelectFighter('REVEAL',playerId,'nyx');
    fighter!.voiceAdvance('REVEAL',playerId);fighter!.voiceSelectMap('REVEAL',playerId,'void');
    fighter!.voiceAdvance('REVEAL',playerId);
    const room=fighter!.findRoom('REVEAL')!;
    room.ready(room.state().loadingGeneration);room.tick(FIGHTER_INTRO_SECONDS);room.tick(6);
    const world=room.state().world!;world.status='finished';world.winner='p1';room.tick(.1);
    expect(room.phase).toBe('victory');
    const display=await connect(port);send(display,{type:'spectate',roomCode:'REVEAL'});
    await waitFor(display,message=>message.type==='host_identity'&&message.isHost===true);
    expect(fighter!.voiceShowResults('REVEAL','stale')).toBe(false);
    expect(fighter!.voiceShowResults('REVEAL',playerId)).toBe(true);
    expect(room.phase).toBe('results');
    await waitFor(display,message=>message.type==='show_results'&&message.loadingGeneration===room.state().loadingGeneration);
  });

  it('does not advance a paid station fight out of results', async () => {
    const port=await start('paid-station-display-token');fighter!.setBrowserPlayerAdmission(code=>code!=='PAID');
    const playerId=fighter!.voiceJoin('PAID','Ada')!;
    const room=fighter!.findRoom('PAID')!;room.phase='results';

    const display=await connect(port);
    send(display,{type:'display_auth',roomCode:'PAID',token:'paid-station-display-token'});
    send(display,{type:'spectate',roomCode:'PAID'});
    await waitFor(display,message=>message.type==='fighter_state');
    send(display,{type:'advance'});
    await waitFor(display,message=>message.type==='error'&&message.code==='station_requeue_required');

    expect(fighter!.voiceAdvance('PAID',playerId)).toBe(false);
    expect(room.phase).toBe('results');
  });
  it('lets the authenticated shared touchscreen choose each caller’s fighter and arena without enabling live attacks', async () => {
    const port = await start('station-touch-token');
    fighter!.setBrowserPlayerAdmission(code => code !== 'TOUCH');
    const first = fighter!.voiceJoin('TOUCH', 'Ada', 'p1', 2)!;
    const second = fighter!.voiceJoin('TOUCH', 'Bo', 'p2', 2)!;
    const display = await connect(port);
    send(display, { type: 'display_auth', roomCode: 'TOUCH', token: 'station-touch-token' });
    send(display, { type: 'spectate', roomCode: 'TOUCH' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);
    send(display, { type: 'advance' });
    await waitFor(display, message => message.type === 'fighter_state' && message.phase === 'fighter_select');
    send(display, { type: 'display_select_fighter', playerId: first, fighterId: 'nyx' });
    await waitFor(display, message => message.type === 'fighter_state' && (message.players as { fighterId: string | null }[])[0]?.fighterId === 'nyx');
    send(display, { type: 'display_select_fighter', playerId: second, fighterId: 'wraith' });
    await waitFor(display, message => message.type === 'fighter_state' && (message.players as { fighterId: string | null }[])[1]?.fighterId === 'wraith');
    send(display, { type: 'advance' });
    await waitFor(display, message => message.type === 'fighter_state' && message.phase === 'map_select');
    send(display, { type: 'display_select_map', playerId: first, mapId: 'void' });
    await waitFor(display, message => message.type === 'fighter_state' && (message.mapVotesByPlayerId as Record<string,string>)[first] === 'void');
    send(display, { type: 'display_select_map', playerId: second, mapId: 'foundry' });
    await waitFor(display, message => message.type === 'fighter_state' && (message.mapVotesByPlayerId as Record<string,string>)[second] === 'foundry');
    send(display, { type: 'command', command: 'punch' });
    await waitFor(display, message => message.type === 'error' && message.code === 'forbidden');
    expect(fighter!.findRoom('TOUCH')?.state().world).toBeNull();
  });

  it('rejects display selector spoofing from a spectator and from an unknown player ID', async () => {
    const port = await start();
    const first = fighter!.voiceJoin('SELECT-SECURE', 'Ada')!;
    fighter!.voiceAdvance('SELECT-SECURE', first);
    const host = await connect(port), spectator = await connect(port);
    send(host, { type: 'spectate', roomCode: 'SELECT-SECURE' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(spectator, { type: 'spectate', roomCode: 'SELECT-SECURE' });
    await waitFor(spectator, message => message.type === 'host_identity' && message.isHost === false);
    send(spectator, { type: 'display_select_fighter', playerId: first, fighterId: 'nyx' });
    await waitFor(spectator, message => message.type === 'error' && message.code === 'forbidden');
    send(host, { type: 'display_select_fighter', playerId: 'stale', fighterId: 'nyx' });
    await waitFor(host, message => message.type === 'error' && message.code === 'select_rejected');
    expect(fighter!.findRoom('SELECT-SECURE')?.lobbyPlayers()[0]?.fighterId).toBeNull();
  });

  it('publishes final queued voice command outcomes when they execute or are superseded', async () => {
    await start();
    const first = fighter!.voiceJoin('RECEIPTS', 'Ada')!;
    const room = fighter!.findRoom('RECEIPTS')!;
    fighter!.voiceAdvance('RECEIPTS', first);
    fighter!.voiceSelectFighter('RECEIPTS', first, 'nyx');
    fighter!.voiceAdvance('RECEIPTS', first);
    fighter!.voiceSelectMap('RECEIPTS', first, 'void');
    fighter!.voiceAdvance('RECEIPTS', first);
    room.ready(room.state().loadingGeneration);
    room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    const received: unknown[] = [];
    fighter!.setOnVoiceCommandOutcomes((_code, outcomes) => received.push(...outcomes));
    expect(fighter!.voiceCommand('RECEIPTS', first, 'punch', 'one')).toMatchObject({ status: 'executed' });
    expect(fighter!.voiceCommand('RECEIPTS', first, 'kick', 'two')).toMatchObject({ status: 'queued' });
    expect(fighter!.voiceCommand('RECEIPTS', first, 'block', 'three')).toMatchObject({ status: 'queued' });
    expect(received).toContainEqual(expect.objectContaining({ requestId: 'two', status: 'rejected', reason: 'superseded' }));
    room.tick(1);
    // The production timer uses this same flush path.
    fighter!.flushVoiceCommandOutcomes('RECEIPTS');
    expect(received).toContainEqual(expect.objectContaining({ requestId: 'three', status: 'executed' }));
  });
  it('requires the configured display token before granting host authority', async () => {
    const port = await start('secret'); const display = await connect(port);
    fighter!.setBrowserPlayerAdmission(() => false);
    await waitFor(display, message => message.type === 'fighter_capabilities' && message.displayAuth === true);
    send(display, { type: 'spectate', roomCode: 'SECURE' });
    await waitFor(display, message => message.type === 'error' && message.code === 'bad_display_auth');
    send(display, { type: 'display_auth', roomCode: 'SECURE', token: 'wrong' });
    await waitFor(display, message => message.type === 'error' && message.code === 'bad_display_auth');
    send(display, { type: 'display_auth', roomCode: 'SECURE', token: 'secret' });
    send(display, { type: 'spectate', roomCode: 'SECURE' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);
  });

  it('grants a standalone display host authority without a station token', async () => {
    const port = await start('station-secret'); const display = await connect(port);
    send(display, { type: 'spectate', roomCode: 'FREEPLAY' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);
    fighter!.voiceJoin('FREEPLAY', 'Ada');
    send(display, { type: 'advance' });
    await waitFor(display, message => message.type === 'fighter_state' && message.phase === 'fighter_select');
  });
  it('keeps an idle Fighter display alive with WebSocket heartbeats', async () => {
    const port = await start(undefined, 50); const display = await connect(port);
    send(display, { type: 'spectate', roomCode: 'HEARTBEAT' });
    await waitFor(display, message => message.type === 'host_identity' && message.isHost === true);
    await new Promise(resolve => setTimeout(resolve, 275));
    expect(display.ws.readyState).toBe(WebSocket.OPEN);
    expect(fighter!.findRoom('HEARTBEAT')).toBeDefined();
  });
  it('hands standalone host authority to a display that opts into keyboard play', async () => {
    const port = await start(); const idleDisplay = await connect(port); const keyboardDisplay = await connect(port);
    send(idleDisplay, { type: 'spectate', roomCode: 'KEYBOARD' });
    await waitFor(idleDisplay, message => message.type === 'host_identity' && message.isHost === true);
    send(keyboardDisplay, { type: 'spectate', roomCode: 'KEYBOARD' });
    await waitFor(keyboardDisplay, message => message.type === 'host_identity' && message.isHost === false);

    send(keyboardDisplay, { type: 'join', roomCode: 'KEYBOARD', name: 'Keyboard Fighter' });
    await waitFor(keyboardDisplay, message => message.type === 'joined');
    await waitFor(keyboardDisplay, message => message.type === 'host_identity' && message.isHost === true);
    send(keyboardDisplay, { type: 'advance' });
    await waitFor(keyboardDisplay, message => message.type === 'fighter_state' && message.phase === 'fighter_select');
  });
  it('canonicalizes room codes and prevents a joined connection taking over another room', async () => {
    const port = await start(); const host = await connect(port); const player = await connect(port);
    send(host, { type: 'spectate', roomCode: ' abcd ' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(player, { type: 'join', roomCode: 'ABCD', name: 'Ada' });
    const joined = await waitFor(player, message => message.type === 'joined');
    expect(joined.roomCode).toBe('ABCD');
    send(player, { type: 'spectate', roomCode: 'WXYZ' });
    await waitFor(player, message => message.type === 'error' && message.code === 'already_joined');
    expect(fighter!.findRoom(' abcd ')?.hasPlayer(joined.playerId as string)).toBe(true);
    expect(fighter!.findRoom('WXYZ')).toBeUndefined();
  });

  it('makes plain spectators read-only while the designated host drives shared selection', async () => {
    const port = await start(); const host = await connect(port); const spectator = await connect(port);
    const a = await connect(port); const b = await connect(port);
    send(host, { type: 'spectate', roomCode: '4821' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(spectator, { type: 'spectate', roomCode: '4821' });
    await waitFor(spectator, message => message.type === 'host_identity' && message.isHost === false);
    send(a, { type: 'join', roomCode: '4821', name: 'A' }); send(b, { type: 'join', roomCode: '4821', name: 'B' });
    await waitFor(a, message => message.type === 'joined'); await waitFor(b, message => message.type === 'joined');
    send(spectator, { type: 'advance' });
    await waitFor(spectator, message => message.type === 'error' && message.code === 'forbidden');
    expect(fighter!.findRoom('4821')?.phase).toBe('lobby');
    send(host, { type: 'advance' }); await waitFor(host, message => message.type === 'fighter_state' && message.phase === 'fighter_select');
    send(a, { type: 'select_fighter', fighterId: 'nyx' });
    await waitFor(host, message => message.type === 'fighter_state' && (message.players as { fighterId: string | null }[]).some(player => player.fighterId === 'nyx'));
    send(host, { type: 'select_fighter', fighterId: 'wraith' });
    await waitFor(host, message => message.type === 'error' && message.code === 'forbidden');
    send(b, { type: 'select_fighter', fighterId: 'wraith' });
    await waitFor(host, message => message.type === 'fighter_state' && (message.players as { fighterId: string | null }[]).every(player => player.fighterId));
    send(host, { type: 'advance' }); await waitFor(host, message => message.type === 'fighter_state' && message.phase === 'map_select');
    send(spectator, { type: 'select_map', mapId: 'void' });
    await waitFor(spectator, message => message.type === 'error' && message.code === 'forbidden');
    expect(latestState(host)?.selectedMap).toBeNull();
    send(host, { type: 'select_map', mapId: 'void' });
    await waitFor(host, message => message.type === 'fighter_state' && message.selectedMap === 'void');
  });

  it('replaces a reconnect session, scopes the same id by room, and ignores forged leave', async () => {
    const port = await start(); const first = await connect(port); const attacker = await connect(port);
    send(first, { type: 'join', roomCode: 'ROOM-A', name: 'A', sessionId: 'shared-session' });
    const original = await waitFor(first, message => message.type === 'joined');
    send(attacker, { type: 'spectate', roomCode: 'ROOM-A' }); await waitFor(attacker, message => message.type === 'fighter_state');
    send(attacker, { type: 'leave', sessionId: 'shared-session' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fighter!.findRoom('ROOM-A')?.hasPlayer(original.playerId as string)).toBe(true);

    const replacement = await connect(port); const closed = new Promise<number>(resolve => first.ws.once('close', resolve));
    send(replacement, { type: 'join', roomCode: 'ROOM-A', name: 'ignored', sessionId: 'shared-session' });
    expect((await waitFor(replacement, message => message.type === 'joined')).playerId).toBe(original.playerId);
    expect(await closed).toBe(4001);

    const otherRoom = await connect(port);
    send(otherRoom, { type: 'join', roomCode: 'ROOM-B', name: 'B', sessionId: 'shared-session' });
    const other = await waitFor(otherRoom, message => message.type === 'joined');
    expect(other.roomCode).toBe('ROOM-B');
    expect(fighter!.findRoom('ROOM-B')?.hasPlayer(other.playerId as string)).toBe(true);
    expect(fighter!.findRoom('ROOM-A')?.hasPlayer(original.playerId as string)).toBe(true);
  });

  it('accepts readiness only from the host for the current loading generation', async () => {
    const port = await start(); const host = await connect(port); const spectator = await connect(port); const player = await connect(port);
    send(host, { type: 'spectate', roomCode: '4821' }); await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(spectator, { type: 'spectate', roomCode: '4821' }); send(player, { type: 'join', roomCode: '4821', name: 'A' });
    await waitFor(player, message => message.type === 'joined');
    send(host, { type: 'advance' }); await waitFor(host, message => message.phase === 'fighter_select');
    send(player, { type: 'select_fighter', fighterId: 'nyx' }); await waitFor(host, message => message.type === 'fighter_state' && (message.players as { fighterId: string | null }[])[0]?.fighterId === 'nyx');
    send(host, { type: 'advance' }); await waitFor(host, message => message.phase === 'map_select');
    send(host, { type: 'select_map', mapId: 'void' }); await waitFor(host, message => message.selectedMap === 'void');
    send(host, { type: 'advance' });
    const loading = await waitFor(host, message => message.type === 'fighter_state' && message.phase === 'loading');
    const generation = loading.loadingGeneration as number;
    send(host, { type: 'ready', loadingGeneration: generation + 1 });
    await waitFor(host, message => message.type === 'error' && message.code === 'stale_ready');
    expect(fighter!.findRoom('4821')?.phase).toBe('loading');
    send(spectator, { type: 'ready', loadingGeneration: generation });
    await waitFor(spectator, message => message.type === 'error' && message.code === 'forbidden');
    send(host, { type: 'ready', loadingGeneration: generation });
    await waitFor(host, message => message.type === 'fighter_state' && message.phase === 'intro');
  });

  it('returns intro to loading when the ready host display disconnects', async () => {
    const port = await start(); const host = await connect(port);
    send(host, { type: 'spectate', roomCode: 'HOST-LOSS' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    const playerId = fighter!.voiceJoin('HOST-LOSS', 'Ada', undefined, 1)!;
    expect(fighter!.voiceAdvance('HOST-LOSS', playerId)).toBe(true);
    expect(fighter!.voiceSelectFighter('HOST-LOSS', playerId, 'nyx')).toBe(true);
    expect(fighter!.voiceAdvance('HOST-LOSS', playerId)).toBe(true);
    expect(fighter!.voiceSelectMap('HOST-LOSS', playerId, 'void')).toBe(true);
    expect(fighter!.voiceAdvance('HOST-LOSS', playerId)).toBe(true);
    const generation = fighter!.findRoom('HOST-LOSS')!.state().loadingGeneration;
    send(host, { type: 'ready', loadingGeneration: generation });
    await waitFor(host, message => message.type === 'fighter_state' && message.phase === 'intro');
    const closed = new Promise<void>(resolve => host.ws.once('close', () => resolve()));
    host.ws.close(); await closed;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fighter!.findRoom('HOST-LOSS')!.state()).toMatchObject({ phase: 'loading', loadingGeneration: generation + 1 });
  });

  it('restores display identity when a host player reconnects', async () => {
    const port = await start(); const host = await connect(port);
    send(host, { type: 'spectate', roomCode: '4821' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(host, { type: 'join', roomCode: '4821', name: 'Display', sessionId: 'display-session' });
    const joined = await waitFor(host, message => message.type === 'joined');
    const closed = new Promise<void>(resolve => host.ws.once('close', () => resolve()));
    host.ws.close(); await closed;

    const resumed = await connect(port);
    send(resumed, { type: 'join', roomCode: '4821', name: 'Display', sessionId: 'display-session' });
    expect((await waitFor(resumed, message => message.type === 'joined')).playerId).toBe(joined.playerId);
    await waitFor(resumed, message => message.type === 'host_identity' && message.isHost === true);
  });

  it('lets a host-owned keyboard player change its selected fighter', async () => {
    const port = await start(); const host = await connect(port);
    send(host, { type: 'spectate', roomCode: 'CHANGE' });
    await waitFor(host, message => message.type === 'host_identity' && message.isHost === true);
    send(host, { type: 'join', roomCode: 'CHANGE', name: 'Keyboard', sessionId: 'change-session' });
    await waitFor(host, message => message.type === 'joined');
    send(host, { type: 'advance' }); await waitFor(host, message => message.phase === 'fighter_select');
    send(host, { type: 'select_fighter', fighterId: 'nyx' });
    await waitFor(host, message => message.type === 'fighter_state' && (message.players as { fighterId: string }[])[0]?.fighterId === 'nyx');
    send(host, { type: 'select_fighter', fighterId: 'iron-oni' });
    const changed = await waitFor(host, message => message.type === 'fighter_state' && (message.players as { fighterId: string }[])[0]?.fighterId === 'iron-oni');
    expect((changed.players as { fighterId: string }[])[0]?.fighterId).toBe('iron-oni');
  });

  it('reaps rooms after their last player and connection leave', async () => {
    const port = await start(); const client = await connect(port);
    send(client, { type: 'spectate', roomCode: 'EMPTY' }); await waitFor(client, message => message.type === 'fighter_state');
    expect(fighter!.findRoom('EMPTY')).toBeDefined();
    client.ws.close();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1000;
      const check = () => fighter!.findRoom('EMPTY') ? (Date.now() > deadline ? reject(new Error('room was not reaped')) : setTimeout(check, 10)) : resolve();
      check();
    });
    expect(fighter!.findRoom('EMPTY')).toBeUndefined();
  });

  it('releases an intentional browser session immediately', async () => {
    const port = await start(); const player = await connect(port);
    send(player, { type: 'join', roomCode: 'HOME', name: 'Keyboard', sessionId: 'home-session' });
    const joined = await waitFor(player, message => message.type === 'joined');
    expect(fighter!.releaseBrowserSession('HOME', 'home-session')).toBe(true);
    expect(fighter!.findRoom('HOME')?.hasPlayer(joined.playerId as string)).toBe(false);
  });

  it('keeps voice selections independent and requires explicit phase advances', async () => {
    await start();
    const p1 = fighter!.voiceJoin(' voice ', 'Ada')!;
    const p2 = fighter!.voiceJoin('VOICE', 'Bob')!;
    expect(fighter!.findRoom('VOICE')?.phase).toBe('lobby');
    expect(fighter!.voiceAdvance('VOICE', p1)).toBe(true);
    expect(fighter!.findRoom('VOICE')?.phase).toBe('fighter_select');
    expect(fighter!.voiceSelectFighter('VOICE', p1, 'nyx')).toBe(true);
    expect(fighter!.voiceSelectFighter('VOICE', p2, 'wraith')).toBe(true);
    expect(fighter!.findRoom('VOICE')?.phase).toBe('fighter_select');
    expect(fighter!.voiceAdvance('VOICE', p1)).toBe(true);
    expect(fighter!.findRoom('VOICE')?.phase).toBe('map_select');
    expect(fighter!.voiceSelectMap('VOICE', p2, 'void')).toBe(true);
    expect(fighter!.voiceSelectMap('VOICE', p1, 'void')).toBe(true);
    const room = fighter!.findRoom('VOICE')!;
    expect(room.phase).toBe('map_select');
    expect(fighter!.voiceAdvance('VOICE', p2)).toBe(true);
    expect(room.phase).toBe('loading');
    expect(room.ready(room.state().loadingGeneration)).toBe(true);
    room.tick(FIGHTER_INTRO_SECONDS); room.tick(6);
    expect(room.phase).toBe('fight');
    expect(fighter!.voiceCommand('VOICE', p1, 'forward')).toBe(true);
    expect(fighter!.voiceCommand('VOICE', p1, 'forward')).toBe(true);
    expect(fighter!.voiceCommand('VOICE', p1, 'punch')).toBe(true);
    expect(fighter!.voiceCommand('VOICE', p1, 'kick')).toBe(true);
  });

  it('hard-aborts a station room and reconnect state', async () => {
    await start();
    expect(fighter!.voiceJoin(' abort ', 'Caller')).not.toBeNull();
    expect(fighter!.abortRoom('ABORT')).toBe(true);
    expect(fighter!.findRoom('ABORT')).toBeUndefined();
    expect(fighter!.abortRoom('ABORT')).toBe(false);
  });

  it('pushes a retained caller state update when expected station players decrease', async () => {
    await start();let updates=0;fighter!.setOnRoomState(()=>updates++);
    const id=fighter!.voiceJoin('EXPECT','Bo','p2',2)!;const before=updates;fighter!.voiceExpectHumanPlayers('EXPECT',1);
    expect(fighter!.findRoom('EXPECT')?.canControlSetup(id)).toBe(true);expect(updates).toBeGreaterThan(before);
  });
});
