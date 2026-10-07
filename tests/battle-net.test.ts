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
  constructor(_url: string) { sockets.push(this); }
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
afterEach(()=>{globalThis.WebSocket=originalWebSocket;vi.useRealTimers();});

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
});
