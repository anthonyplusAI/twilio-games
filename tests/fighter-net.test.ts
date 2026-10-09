import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FighterConnection } from '../client/fighter/fighter-net';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(value: string): void { this.sent.push(value); }
  close(): void {
    if (this.readyState === MockWebSocket.CONNECTING) throw new Error('still connecting');
    this.readyState = 3;
  }
  open(): void { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

let sockets: MockWebSocket[];
let originalWebSocket: typeof WebSocket;

beforeEach(() => {
  vi.useFakeTimers(); sockets = []; originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});
afterEach(() => { vi.unstubAllGlobals(); globalThis.WebSocket = originalWebSocket; vi.useRealTimers(); });

describe('fighter connection', () => {
  it('replays identity but drops stale commands and paint receipts across reconnects', () => {
    const connection = new FighterConnection('ws://fighter');
    connection.spectate('ROOM'); connection.command('punch'); connection.ackDisplay('fight',1); sockets[0]!.open();
    expect(sockets[0]!.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'spectate', roomCode: 'ROOM' },
    ]);

    sockets[0]!.readyState = 3; sockets[0]!.onclose?.({ code: 1006 });
    connection.command('kick'); connection.ackDisplay('results',1);
    vi.advanceTimersByTime(500); sockets[1]!.open();
    expect(sockets[1]!.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'spectate', roomCode: 'ROOM' },
    ]);
    connection.ackDisplay('fight',2);
    expect(JSON.parse(sockets[1]!.sent.at(-1)!)).toEqual({type:'ack_display',phase:'fight',loadingGeneration:2});
  });

  it('authenticates a display once before identity when advertised', () => {
    const connection = new FighterConnection('ws://fighter');
    connection.setDisplayAuth('ROOM', 'secret'); connection.spectate('ROOM'); sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.message({ type: 'fighter_capabilities', displayAuth: true });
    sockets[0]!.message({ type: 'fighter_capabilities', displayAuth: true });
    expect(sockets[0]!.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'display_auth', roomCode: 'ROOM', token: 'secret' },
      { type: 'spectate', roomCode: 'ROOM' },
    ]);
  });

  it('reapplies the selected seats when an overlapping display becomes host', () => {
    const connection = new FighterConnection('ws://fighter');
    connection.setStandaloneSeats('ROOM', 2); connection.spectate('ROOM'); sockets[0]!.open();
    sockets[0]!.message({ type: 'host_identity', roomCode: 'ROOM', isHost: false, loadingGeneration: 0 });
    expect(sockets[0]!.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'spectate', roomCode: 'ROOM', initialSeatCount: 2 },
    ]);
    sockets[0]!.message({ type: 'host_identity', roomCode: 'ROOM', isHost: true, loadingGeneration: 0 });
    sockets[0]!.message({ type: 'host_identity', roomCode: 'ROOM', isHost: true, loadingGeneration: 0 });
    expect(sockets[0]!.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'spectate', roomCode: 'ROOM', initialSeatCount: 2 },
      { type: 'configure_seats', roomCode: 'ROOM', count: 2 },
    ]);
  });

  it('includes initial seats in both display and local tester registration', () => {
    const display = new FighterConnection('ws://fighter');
    display.setStandaloneSeats('ROOM', 2); display.spectate('ROOM');
    const keyboard = display.createKeyboardPlayerConnection();
    keyboard.join('ROOM', 'Tester');
    sockets[0]!.open(); sockets[1]!.open();

    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'spectate', roomCode: 'ROOM', initialSeatCount: 2,
    });
    expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({
      type: 'join', roomCode: 'ROOM', name: 'Tester', initialSeatCount: 2,
    });
  });

  it('includes the selected locale in display and player identities', () => {
    const connection = new FighterConnection('ws://fighter', 'pt-BR');
    connection.spectate('ROOM'); sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'spectate', roomCode: 'ROOM', locale: 'pt-BR' });
    connection.join('ROOM', 'Ana');
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({ type: 'join', roomCode: 'ROOM', name: 'Ana', locale: 'pt-BR' });
  });

  it('delivers a current-display result reveal request immediately', () => {
    const connection = new FighterConnection('ws://fighter');
    const generations: number[] = [];
    connection.onShowResults(generation => generations.push(generation));
    connection.spectate('ROOM'); sockets[0]!.open();
    sockets[0]!.message({ type: 'show_results', loadingGeneration: 3 });
    expect(generations).toEqual([3]);
  });

  it('reattaches the display as a spectator after the local tester leaves',()=>{
    const connection=new FighterConnection('ws://fighter');
    connection.spectate('ROOM');sockets[0]!.open();
    connection.join('ROOM','Tester');connection.leave('ROOM');
    expect(sockets[0]!.sent.map(value=>JSON.parse(value).type)).toEqual([
      'spectate','join','leave','spectate',
    ]);
  });

  it('releases a disconnected plain leave before resubscribing as a spectator',()=>{
    const connection=new FighterConnection('ws://fighter');
    connection.join('ROOM','Tester');sockets[0]!.open();
    const sessionId=JSON.parse(sockets[0]!.sent[0]!).sessionId as string;
    sockets[0]!.readyState=3;sockets[0]!.onclose?.({code:1006});
    connection.leave('ROOM');
    vi.advanceTimersByTime(500);sockets[1]!.open();
    expect(sockets[1]!.sent.map(value=>JSON.parse(value))).toEqual([
      {type:'release_session',roomCode:'ROOM',sessionId},
      {type:'spectate',roomCode:'ROOM'},
    ]);
  });

  it('keeps the display spectator and keyboard player identities on separate reconnecting sockets',()=>{
    const display=new FighterConnection('ws://fighter?display=1&displaySessionId=old');
    display.setStandaloneSeats('ROOM',2);display.spectate('ROOM');
    const keyboard=display.createKeyboardPlayerConnection();
    keyboard.join('ROOM','Tester');
    expect(sockets).toHaveLength(2);
    expect(new URL(sockets[0]!.url).searchParams.get('display')).toBe('1');
    expect(new URL(sockets[1]!.url).searchParams.has('display')).toBe(false);
    expect(new URL(sockets[1]!.url).searchParams.has('displaySessionId')).toBe(false);

    sockets[0]!.open();sockets[1]!.open();
    const firstJoin=JSON.parse(sockets[1]!.sent[0]!);
    expect(sockets[0]!.sent.map(value=>JSON.parse(value).type)).toEqual(['spectate']);
    expect(firstJoin).toMatchObject({type:'join',roomCode:'ROOM',name:'Tester'});

    sockets[0]!.readyState=3;sockets[0]!.onclose?.({code:1006});
    sockets[1]!.readyState=3;sockets[1]!.onclose?.({code:1006});
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(4);
    sockets[2]!.open();sockets[3]!.open();
    expect(sockets[2]!.sent.map(value=>JSON.parse(value).type)).toEqual(['spectate']);
    expect(JSON.parse(sockets[3]!.sent[0]!)).toEqual(firstJoin);

    vi.stubGlobal('navigator',{sendBeacon:()=>true});
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));
    keyboard.leaveAndClose('ROOM');vi.advanceTimersByTime(40);
    expect(JSON.parse(sockets[3]!.sent.at(-1)!)).toMatchObject({
      type:'release_session',roomCode:'ROOM',sessionId:firstJoin.sessionId,
    });
    sockets[3]!.message({type:'session_released',roomCode:'ROOM',sessionId:firstJoin.sessionId});
    expect(sockets[3]!.readyState).toBe(3);
    expect(sockets[2]!.sent.map(value=>JSON.parse(value).type)).toEqual(['spectate']);
  });

  it('holds a rapid P-on while an offline P-off retries its release after HTTP fails', async () => {
    vi.stubGlobal('navigator',{sendBeacon:()=>true});
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));
    const departing=new FighterConnection('ws://fighter');
    departing.join('ROOM','Keyboard');sockets[0]!.open();
    const oldSessionId=JSON.parse(sockets[0]!.sent[0]!).sessionId as string;
    sockets[0]!.readyState=3;sockets[0]!.onclose?.({code:1006});
    departing.leaveAndClose('ROOM');

    const replacement=new FighterConnection('ws://fighter');
    replacement.join('ROOM','Keyboard');
    const replacementSocket=sockets.at(-1)!;
    replacementSocket.open();
    expect(replacementSocket.sent).toEqual([]);

    vi.advanceTimersByTime(500);
    const releaseSocket=sockets.find(socket=>socket!==sockets[0]&&socket!==replacementSocket)!;
    releaseSocket.open();
    expect(releaseSocket.sent.map(value=>JSON.parse(value))).toContainEqual({
      type:'release_session',roomCode:'ROOM',sessionId:oldSessionId,
    });
    releaseSocket.readyState=3;releaseSocket.onclose?.({code:1006});
    vi.advanceTimersByTime(500);
    const retrySocket=sockets.at(-1)!;
    retrySocket.open();
    expect(retrySocket.sent.map(value=>JSON.parse(value))).toContainEqual({
      type:'release_session',roomCode:'ROOM',sessionId:oldSessionId,
    });
    expect(replacementSocket.sent).toEqual([]);

    retrySocket.message({type:'session_released',roomCode:'ROOM',sessionId:oldSessionId});
    await Promise.resolve();
    expect(retrySocket.readyState).toBe(3);
    expect(replacementSocket.sent.map(value=>JSON.parse(value))).toEqual([
      expect.objectContaining({type:'join',roomCode:'ROOM',name:'Keyboard'}),
    ]);
    expect(JSON.parse(replacementSocket.sent[0]!).sessionId).not.toBe(oldSessionId);
  });

  it('does not trust a queued beacon until HTTP confirms release', async () => {
    let respond!: (value: { ok: boolean }) => void;
    vi.stubGlobal('navigator',{sendBeacon:()=>true});
    vi.stubGlobal('fetch',vi.fn().mockImplementation(() => new Promise(resolve => { respond = resolve; })));
    const departing=new FighterConnection('ws://fighter');
    departing.join('ROOM','Keyboard');sockets[0]!.open();
    const oldSessionId=JSON.parse(sockets[0]!.sent[0]!).sessionId as string;
    departing.leaveAndClose('ROOM');
    const replacement=new FighterConnection('ws://fighter');
    replacement.join('ROOM','Keyboard');sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([]);
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({
      type:'release_session',roomCode:'ROOM',sessionId:oldSessionId,
    });

    respond({ok:true});await Promise.resolve();await Promise.resolve();
    expect(sockets[1]!.sent.map(value=>JSON.parse(value))).toEqual([
      expect.objectContaining({type:'join',roomCode:'ROOM'}),
    ]);
    expect(JSON.parse(sockets[1]!.sent[0]!).sessionId).not.toBe(oldSessionId);
  });

  it('closes a release socket that opens after HTTP has already confirmed release', async () => {
    let respond!: (value: { ok: boolean }) => void;
    vi.stubGlobal('navigator',{sendBeacon:()=>true});
    vi.stubGlobal('fetch',vi.fn().mockImplementation(() => new Promise(resolve => { respond = resolve; })));
    const departing=new FighterConnection('ws://fighter');
    departing.join('ROOM','Keyboard');sockets[0]!.open();
    sockets[0]!.readyState=3;sockets[0]!.onclose?.({code:1006});
    departing.leaveAndClose('ROOM');
    const releaseSocket=sockets[1]!;
    expect(releaseSocket.readyState).toBe(MockWebSocket.CONNECTING);

    respond({ok:true});await Promise.resolve();await Promise.resolve();
    // Browser WebSocket.close() throws while CONNECTING; the onopen handler must close it later.
    expect(releaseSocket.readyState).toBe(MockWebSocket.CONNECTING);
    releaseSocket.open();
    expect(releaseSocket.readyState).toBe(3);
    expect(releaseSocket.sent).toEqual([]);
  });

  it('does not reuse a keyboard session copied into a duplicate display tab', async () => {
    let sequence=0;
    vi.stubGlobal('crypto',{randomUUID:()=>`${(++sequence).toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`});
    const local=new Map<string,string>();
    vi.stubGlobal('localStorage',{
      getItem:(key:string)=>local.get(key)??null,
      setItem:(key:string,value:string)=>{local.set(key,value);},
      removeItem:(key:string)=>{local.delete(key);},
    });
    const originalStorage=new Map<string,string>();
    const useSession=(entries:Map<string,string>)=>vi.stubGlobal('sessionStorage',{
      getItem:(key:string)=>entries.get(key)??null,
      setItem:(key:string,value:string)=>{entries.set(key,value);},
      removeItem:(key:string)=>{entries.delete(key);},
    });
    useSession(originalStorage);
    vi.stubGlobal('window',{addEventListener:vi.fn()});
    vi.resetModules();
    const {FighterConnection:OriginalConnection}=await import('../client/fighter/fighter-net');
    const originalDisplay=new OriginalConnection('ws://fighter?display=1');
    originalDisplay.spectate('ROOM');sockets[0]!.open();
    const originalDisplayId=new URL(sockets[0]!.url).searchParams.get('displaySessionId');
    const originalKeyboard=originalDisplay.createKeyboardPlayerConnection();
    originalKeyboard.join('ROOM','Original');sockets[1]!.open();
    const originalKeyboardId=JSON.parse(sockets[1]!.sent[0]!).sessionId as string;

    const copiedStorage=new Map(originalStorage);
    useSession(copiedStorage);
    vi.stubGlobal('window',{addEventListener:vi.fn()});
    vi.resetModules();
    const {FighterConnection:ClonedConnection}=await import('../client/fighter/fighter-net');
    const clonedDisplay=new ClonedConnection('ws://fighter?display=1');
    clonedDisplay.spectate('ROOM');sockets[2]!.open();
    const clonedDisplayId=new URL(sockets[2]!.url).searchParams.get('displaySessionId');
    expect(clonedDisplayId).not.toBe(originalDisplayId);
    const clonedKeyboard=clonedDisplay.createKeyboardPlayerConnection();
    clonedKeyboard.join('ROOM','Cloned');sockets[3]!.open();
    expect(JSON.parse(sockets[3]!.sent[0]!).sessionId).not.toBe(originalKeyboardId);
  });
});
