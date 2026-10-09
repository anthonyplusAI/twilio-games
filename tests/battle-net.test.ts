import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BattleConnection } from '../client/battle/battle-net';

class MockWebSocket {
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: (event: {code:number}) => void;
  onmessage?: (event: {data:string}) => void;
  onerror?: () => void;
  private openListeners: (() => void)[] = [];
  constructor(readonly url: string) { sockets.push(this); }
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; }
  addEventListener(name: string, listener: () => void): void {
    if(name==='open') this.openListeners.push(listener);
  }
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
    for(const listener of this.openListeners) listener();
    this.openListeners=[];
  }
  message(value: unknown): void { this.onmessage?.({data:JSON.stringify(value)}); }
  disconnect(): void { this.readyState=3;this.onclose?.({code:1006}); }
}

let sockets:MockWebSocket[];
let originalWebSocket:typeof WebSocket;
beforeEach(()=>{
  vi.useFakeTimers();sockets=[];originalWebSocket=globalThis.WebSocket;
  globalThis.WebSocket=MockWebSocket as unknown as typeof WebSocket;
});
afterEach(()=>{vi.unstubAllGlobals();globalThis.WebSocket=originalWebSocket;vi.useRealTimers();});

describe('battle connection',()=>{
  it('reports a disconnected result socket before replaying identity on reconnect',()=>{
    const connection=new BattleConnection('ws://battle');
    const states:string[]=[];
    connection.onConnected(()=>states.push('connected'));
    connection.onDisconnected(()=>states.push('disconnected'));
    connection.spectate('ROOM');sockets[0]!.open();
    sockets[0]!.disconnect();
    expect(states).toEqual(['connected','disconnected']);
    vi.advanceTimersByTime(500);sockets[1]!.open();
    expect(states).toEqual(['connected','disconnected','connected']);
  });
  it('replays only identity when a socket opens, not an action requested while disconnected',()=>{
    const connection=new BattleConnection('ws://battle');
    connection.spectate('ROOM');connection.advance();connection.chooseMove('sparkmouse.jolt');
    sockets[0]!.open();
    expect(sockets[0]!.sent.map(value=>JSON.parse(value))).toEqual([{type:'spectate',roomCode:'ROOM'}]);
  });
  it('sends the selected local player count after display identity on connect and reconnect',()=>{
    const connection=new BattleConnection('ws://battle');
    connection.spectate('ROOM',undefined,2);
    sockets[0]!.open();
    expect(sockets[0]!.sent.map(value=>JSON.parse(value))).toEqual([
      {type:'spectate',roomCode:'ROOM',playerCount:2},
      {type:'configure_players',count:2},
    ]);
    sockets[0]!.disconnect();vi.advanceTimersByTime(500);sockets[1]!.open();
    expect(sockets[1]!.sent.map(value=>JSON.parse(value))).toEqual([
      {type:'spectate',roomCode:'ROOM',playerCount:2},
      {type:'configure_players',count:2},
    ]);
  });

  it('reapplies the selected count when an overlapping display becomes host',()=>{
    const connection=new BattleConnection('ws://battle');
    connection.spectate('ROOM',undefined,2);sockets[0]!.open();
    sockets[0]!.message({type:'host_identity',roomCode:'ROOM',isHost:false});
    expect(sockets[0]!.sent.map(value=>JSON.parse(value))).toEqual([
      {type:'spectate',roomCode:'ROOM',playerCount:2},
      {type:'configure_players',count:2},
    ]);
    sockets[0]!.message({type:'host_identity',roomCode:'ROOM',isHost:true});
    sockets[0]!.message({type:'host_identity',roomCode:'ROOM',isHost:true});
    expect(sockets[0]!.sent.map(value=>JSON.parse(value))).toEqual([
      {type:'spectate',roomCode:'ROOM',playerCount:2},
      {type:'configure_players',count:2},
      {type:'configure_players',count:2},
    ]);
  });

  it('deduplicates replayed event IDs on the same socket and accepts them after reconnect',()=>{
    const connection=new BattleConnection('ws://battle');
    const frames:number[][]=[];
    connection.onEvents((_events,ids)=>frames.push(ids));
    connection.spectate('ROOM');sockets[0]!.open();
    sockets[0]!.message({type:'battle_state',generation:1});
    const event={kind:'turn_start',turn:1};
    sockets[0]!.message({type:'battle_events',generation:1,eventIds:[1],events:[event]});
    sockets[0]!.message({type:'battle_events',generation:1,eventIds:[1,2],events:[event,event]});
    expect(frames).toEqual([[1],[2]]);
    sockets[0]!.disconnect();vi.advanceTimersByTime(500);sockets[1]!.open();
    sockets[1]!.message({type:'battle_state',generation:1});
    sockets[1]!.message({type:'battle_events',generation:1,eventIds:[1],events:[event]});
    expect(frames).toEqual([[1],[2],[1]]);
  });

  it('waits for the matching battle state before delivering a new generation of events',()=>{
    const connection=new BattleConnection('ws://battle');
    const frames:number[][]=[];connection.onEvents((_events,ids)=>frames.push(ids));
    connection.spectate('ROOM');sockets[0]!.open();
    sockets[0]!.message({type:'battle_state',generation:1});
    sockets[0]!.message({type:'battle_events',generation:2,eventIds:[1],events:[{kind:'turn_start',turn:1}]});
    expect(frames).toEqual([]);
    sockets[0]!.message({type:'battle_state',generation:2});
    expect(frames).toEqual([[1]]);
  });

  it('reattaches a local display after its tester player leaves',()=>{
    const connection=new BattleConnection('ws://battle');
    connection.spectate('ROOM');sockets[0]!.open();
    connection.join('ROOM','Tester');connection.leave('ROOM');
    expect(sockets[0]!.sent.map(value=>JSON.parse(value).type)).toEqual([
      'spectate','join','leave','spectate',
    ]);
  });

  it('keeps the display spectator and keyboard player identities on separate reconnecting sockets',()=>{
    const display=new BattleConnection('ws://battle?display=1&displaySessionId=old');
    display.spectate('ROOM',undefined,2);
    const keyboard=display.createKeyboardPlayerConnection();
    keyboard.join('ROOM','Tester');
    expect(sockets).toHaveLength(2);
    expect(new URL(sockets[0]!.url).searchParams.get('display')).toBe('1');
    expect(new URL(sockets[1]!.url).searchParams.has('display')).toBe(false);
    expect(new URL(sockets[1]!.url).searchParams.has('displaySessionId')).toBe(false);

    sockets[0]!.open();sockets[1]!.open();
    const firstJoin=JSON.parse(sockets[1]!.sent[0]!);
    expect(sockets[0]!.sent.map(value=>JSON.parse(value).type)).toEqual(['spectate','configure_players']);
    expect(firstJoin).toMatchObject({type:'join',roomCode:'ROOM',name:'Tester'});

    sockets[0]!.disconnect();sockets[1]!.disconnect();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(4);
    sockets[2]!.open();sockets[3]!.open();
    expect(sockets[2]!.sent.map(value=>JSON.parse(value).type)).toEqual(['spectate','configure_players']);
    expect(JSON.parse(sockets[3]!.sent[0]!)).toEqual(firstJoin);

    keyboard.leave('ROOM',false);
    expect(JSON.parse(sockets[3]!.sent.at(-1)!)).toMatchObject({type:'leave',sessionId:firstJoin.sessionId});
    sockets[3]!.message({type:'session_released',sessionId:firstJoin.sessionId});
    vi.advanceTimersByTime(40);
    expect(sockets[3]!.readyState).toBe(3);
    expect(sockets[2]!.sent.map(value=>JSON.parse(value).type)).toEqual(['spectate','configure_players']);
  });

  it('waits for the old keyboard release before sending a fresh P-on join and retries without a receipt',async()=>{
    const storage=new Map<string,string>();
    vi.stubGlobal('sessionStorage',{
      getItem:(key:string)=>storage.get(key)??null,
      setItem:(key:string,value:string)=>{storage.set(key,value);},
      removeItem:(key:string)=>{storage.delete(key);},
    });
    const display=new BattleConnection('ws://battle?display=1');
    display.spectate('ROOM');sockets[0]!.open();
    const first=display.createKeyboardPlayerConnection();
    first.join('ROOM','Tester');sockets[1]!.open();
    const firstId=JSON.parse(sockets[1]!.sent[0]!).sessionId;
    first.leave('ROOM',false);
    const second=display.createKeyboardPlayerConnection();
    second.join('ROOM','Tester');sockets[2]!.open();
    expect(sockets[2]!.sent).toEqual([]);
    expect(sockets[1]!.sent.filter(value=>JSON.parse(value).type==='leave')).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(sockets[1]!.sent.filter(value=>JSON.parse(value).type==='leave')).toHaveLength(2);
    sockets[1]!.message({type:'session_released',sessionId:firstId});
    await Promise.resolve();
    const secondId=JSON.parse(sockets[2]!.sent[0]!).sessionId;
    expect(secondId).not.toBe(firstId);
    vi.advanceTimersByTime(40);
    expect(sockets[1]!.readyState).toBe(3);
    expect(sockets[0]!.readyState).toBe(MockWebSocket.OPEN);
  });

  it('does not let a copied display tab take over the original tab’s keyboard seat',async()=>{
    let sequence=0;
    vi.stubGlobal('crypto',{
      randomUUID:()=>`${(++sequence).toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`,
    });
    const active=new Map<string,string>();
    vi.stubGlobal('localStorage',{
      getItem:(key:string)=>active.get(key)??null,
      setItem:(key:string,value:string)=>{active.set(key,value);},
      removeItem:(key:string)=>{active.delete(key);},
    });
    const originalStorage=new Map<string,string>();
    const useStorage=(entries:Map<string,string>)=>vi.stubGlobal('sessionStorage',{
      getItem:(key:string)=>entries.get(key)??null,
      setItem:(key:string,value:string)=>{entries.set(key,value);},
      removeItem:(key:string)=>{entries.delete(key);},
    });
    vi.stubGlobal('window',{addEventListener:vi.fn()});useStorage(originalStorage);
    vi.resetModules();
    const {BattleConnection:OriginalConnection}=await import('../client/battle/battle-net');
    const originalDisplay=new OriginalConnection('ws://battle?display=1');
    const originalKeyboard=originalDisplay.createKeyboardPlayerConnection();
    originalKeyboard.join('ROOM','Tester');sockets.at(-1)!.open();
    const originalSession=JSON.parse(sockets.at(-1)!.sent[0]!).sessionId;

    const copiedStorage=new Map(originalStorage);
    vi.stubGlobal('window',{addEventListener:vi.fn()});useStorage(copiedStorage);
    vi.resetModules();
    const {BattleConnection:CopiedConnection}=await import('../client/battle/battle-net');
    const copiedDisplay=new CopiedConnection('ws://battle?display=1');
    const copiedKeyboard=copiedDisplay.createKeyboardPlayerConnection();
    copiedKeyboard.join('ROOM','Tester');sockets.at(-1)!.open();
    const copiedSession=JSON.parse(sockets.at(-1)!.sent[0]!).sessionId;

    expect(new URL(sockets[2]!.url).searchParams.get('displaySessionId'))
      .not.toBe(new URL(sockets[0]!.url).searchParams.get('displaySessionId'));
    expect(copiedSession).not.toBe(originalSession);
  });

  it('releases a keyboard player toggled off during reconnect without replaying its join',()=>{
    const display=new BattleConnection('ws://battle?display=1');
    display.spectate('ROOM');sockets[0]!.open();
    const keyboard=display.createKeyboardPlayerConnection();
    keyboard.join('ROOM','Tester');sockets[1]!.open();
    const sessionId=JSON.parse(sockets[1]!.sent[0]!).sessionId;
    sockets[1]!.disconnect();
    keyboard.leave('ROOM',false);
    vi.advanceTimersByTime(500);sockets[2]!.open();
    expect(sockets[2]!.sent.map(value=>JSON.parse(value))).toEqual([{type:'leave',sessionId}]);
    vi.advanceTimersByTime(500);
    expect(sockets[2]!.sent.filter(value=>JSON.parse(value).type==='leave')).toHaveLength(2);
    expect(sockets[2]!.readyState).toBe(MockWebSocket.OPEN);
    sockets[2]!.message({type:'session_released',sessionId});
    vi.advanceTimersByTime(40);
    expect(sockets[2]!.readyState).toBe(3);
    expect(sockets[0]!.readyState).toBe(MockWebSocket.OPEN);
  });
});
