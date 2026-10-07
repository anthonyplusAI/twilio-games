import { describe, it, expect, beforeEach } from 'vitest';
import { Room } from '../server/room';
import { STEP, MAX_PLAYERS } from '../shared/constants';
import { arcadeGameDefinition } from '../shared/arcade-games';

describe('Room', () => {
  it('requires a name in the lobby but keeps a visible selection menu when an unnamed caller joins late', () => {
    const room = new Room('NAMES', 1, { carCount: 2, maps: ['Silver Lake'] });
    const caller = room.addPlayer('Racer 1234', undefined, undefined, false); if ('error' in caller) throw new Error(caller.error);
    expect(room.start()).toBe(false);
    room.advance(); expect(room.phase).toBe('lobby');
    room.setPlayerInfo(caller.playerId, { name: 'Ada' });
    room.advance(); expect(room.phase).toBe('car_select');
    const late = room.addPlayer('Racer 5678', undefined, undefined, false); if ('error' in late) throw new Error(late.error);
    expect(room.phase).toBe('car_select');
    expect(room.selectCar(caller.playerId, 0)).toBe(true);
    expect(room.selectCar(late.playerId, 1)).toBe(true);
    expect(room.advance(caller.playerId)).toBe(true);
    expect(room.phase).toBe('map_select');
    expect(room.selectMap('Silver Lake', caller.playerId)).toBe(true);
    expect(room.selectMap('Silver Lake', late.playerId)).toBe(true);
    expect(room.advance(late.playerId)).toBe(true);
    expect(room.phase).toBe('countdown');
  });
  it('returns a rematch to lobby when a caller joined the race before confirming a name', () => {
    const room = new Room('REMATCH-NAME', 1, { carCount: 2, maps: ['Silver Lake'] });
    room.addPlayer('Ada');
    room.start();
    const late = room.addPlayer('Racer 5678', undefined, undefined, false); if ('error' in late) throw new Error(late.error);
    for (let i = 0; i < 60 * 120 && room.phase !== 'results'; i++) room.tick(STEP);
    expect(room.phase).toBe('results');
    room.advance();
    expect(room.phase).toBe('lobby');
  });
  let room: Room;
  beforeEach(() => { room = new Room('4821', 1); });

  it('assigns sequential lanes as players join', () => {
    const a = room.addPlayer('You') as any;
    const b = room.addPlayer('Ada') as any;
    expect(a.lane).toBe(0);
    expect(b.lane).toBe(1);
    expect(a.playerId).not.toEqual(b.playerId);
  });

  it('orders station racers by assignment and waits for both before starting', () => {
    room.expectHumanPlayers(2);
    const second = room.addPlayer('Rex', undefined, 1) as { playerId: string; lane: number };
    room.start();
    expect(room.snapshot()).toBeNull();

    const first = room.addPlayer('Ada', undefined, 0) as { playerId: string; lane: number };
    expect(room.lobbyPlayers().map(player => player.name)).toEqual(['Ada', 'Rex']);
    expect([first.lane, second.lane]).toEqual([0, 1]);
    room.start();
    expect(room.snapshot()?.cars.map(car => car.name)).toEqual(['Ada', 'Rex']);

    room.removePlayer(first.playerId);
    room.addPlayer('Ada Returns', undefined, 0);
    expect(room.snapshot()?.cars.map(car => car.name)).toEqual(['Ada Returns', 'Rex']);
  });

  it('keeps two station players car picks and map votes independent', () => {
    room=new Room('4821',1,{carCount:3,maps:['Silver Lake','Drift']});room.expectHumanPlayers(2);
    const a=room.addPlayer('Ada',undefined,0) as {playerId:string};
    const b=room.addPlayer('Rex',undefined,1) as {playerId:string};
    expect(room.phase).toBe('lobby');expect(room.advance()).toBe(false);expect(room.advance(b.playerId)).toBe(true);
    expect(room.phase).toBe('car_select');room.back();expect(room.phase).toBe('car_select');room.selectCar(a.playerId,1);
    expect(room.phase).toBe('car_select');
    expect(room.lobbyPlayers().map(player=>player.carIndex)).toEqual([1,null]);
    room.selectCar(b.playerId,2);expect(room.phase).toBe('car_select');expect(room.advance(a.playerId)).toBe(true);
    expect(room.phase).toBe('map_select');
    expect(room.selectMap('Drift')).toBe(false);
    expect(room.mapVotes().counts).toEqual({});
    room.selectMap('Silver Lake',a.playerId);expect(room.phase).toBe('map_select');
    room.selectMap('Drift',b.playerId);expect(room.phase).toBe('map_select');expect(room.advance(b.playerId)).toBe(true);
    expect(room.phase).toBe('countdown');
    expect(room.snapshot()?.cars.map(car=>car.carIndex)).toEqual([1,2]);
    expect(room.mapVotes().counts).toEqual({'Silver Lake':1,Drift:1});
  });

  it('identifies the next caller seat for shared-screen car and track taps', () => {
    room = new Room('TOUCH', 1, { carCount: 3, maps: ['Silver Lake', 'Drift'] });
    room.expectHumanPlayers(2);
    const first = room.addPlayer('Ada', undefined, 0) as { playerId: string };
    const second = room.addPlayer('Rex', undefined, 1) as { playerId: string };
    expect(room.touchSelectionTarget()).toBeNull();
    room.advance(first.playerId);
    expect(room.touchSelectionTarget()).toBe(first.playerId);
    room.selectCar(first.playerId, 1);
    expect(room.touchSelectionTarget()).toBe(second.playerId);
    room.selectCar(second.playerId, 2);
    expect(room.touchSelectionTarget()).toBeNull();
    room.advance(first.playerId);
    expect(room.touchSelectionTarget()).toBe(first.playerId);
    room.selectMap('Drift', first.playerId);
    expect(room.touchSelectionTarget()).toBe(second.playerId);
    room.selectMap('Silver Lake', second.playerId);
    expect(room.touchSelectionTarget()).toBeNull();
  });

  it('lets either station player advance after both personal choices are complete', () => {
    room.expectHumanPlayers(2);
    const b=room.addPlayer('Rex',undefined,1) as {playerId:string};
    const a=room.addPlayer('Ada',undefined,0) as {playerId:string};
    expect(room.canControlSetup(a.playerId)).toBe(true);
    expect(room.canControlSetup(b.playerId)).toBe(true);
  });

  it('accepts setup input from either standalone caller while preserving selection gates', () => {
    room=new Room('4821',1,{carCount:2,maps:['Silver Lake']});
    const a=room.addPlayer('Ada') as {playerId:string};const b=room.addPlayer('Rex') as {playerId:string};
    expect(room.canControlSetup(a.playerId)).toBe(true);expect(room.canControlSetup(b.playerId)).toBe(true);
    room.advance();room.selectCar(a.playerId,0);room.advance();expect(room.phase).toBe('car_select');
    room.selectCar(b.playerId,1);room.advance();room.selectMap('Silver Lake',a.playerId);room.advance();
    expect(room.phase).toBe('map_select');
  });

  it('purges a display vote when a room switches to caller-managed voice setup',()=>{
    room=new Room('4821',1,{carCount:1,maps:['Silver Lake']});
    const player=room.addPlayer('Ada') as {playerId:string};room.advance();room.selectCar(player.playerId,0);room.advance();
    expect(room.selectMap('Silver Lake')).toBe(true);expect(room.mapVotes().counts).toEqual({'Silver Lake':1});
    room.expectHumanPlayers(1);
    expect(room.mapVotes().counts).toEqual({});expect(room.phase).toBe('map_select');
  });

  it.each(['count-first','remove-first'] as const)('keeps Racer setup explicit when a no-show is dropped %s',order=>{
    room=new Room('4821',1,{carCount:2,maps:['Silver Lake']});room.expectHumanPlayers(2);
    const a=room.addPlayer('Ada',undefined,0) as {playerId:string};const b=room.addPlayer('Bo',undefined,1) as {playerId:string};
    room.advance(a.playerId);room.selectCar(a.playerId,0);room.selectCar(b.playerId,1);room.advance(b.playerId);
    room.selectMap('Silver Lake',a.playerId);
    if(order==='count-first')room.expectHumanPlayers(1);
    room.removePlayer(b.playerId);
    if(order==='remove-first')room.expectHumanPlayers(1);
    expect(room.phase).toBe('map_select');expect(room.advance(a.playerId)).toBe(true);expect(room.phase).toBe('countdown');
  });

  it('lets a standalone survivor continue after the other caller disconnects',()=>{
    room=new Room('4821',1,{carCount:2,maps:['Silver Lake']});room.expectHumanPlayers(2,false);
    const a=room.addPlayer('Ada') as {playerId:string};const b=room.addPlayer('Bo') as {playerId:string};
    room.advance();room.removePlayer(b.playerId);room.selectCar(a.playerId,0);room.advance();
    room.selectMap('Silver Lake',a.playerId);room.advance();
    expect(room.phase).toBe('countdown');
  });

  it('rejects joins beyond MAX_PLAYERS', () => {
    for (let i = 0; i < MAX_PLAYERS; i++) room.addPlayer('P' + i);
    const over = room.addPlayer('Overflow') as any;
    expect(over.error).toBeDefined();
    expect(room.playerCount).toBe(MAX_PLAYERS);
    expect(MAX_PLAYERS).toBe(arcadeGameDefinition('racer').humanCapacity);
  });

  it('starts as lobby and has no snapshot until started', () => {
    expect(room.phase).toBe('lobby');
    expect(room.snapshot()).toBeNull();
  });

  it('start() builds a race and produces snapshots', () => {
    room.addPlayer('You'); room.addPlayer('Ada');
    room.start();
    const s = room.snapshot();
    expect(s).not.toBeNull();
    expect(s!.cars).toHaveLength(2);
    expect(['countdown', 'racing']).toContain(room.phase);
  });

  it('routes intents to the right car after racing begins', () => {
    const a = room.addPlayer('You') as any;
    room.addPlayer('Ada');
    room.start();
    for (let i = 0; i < 8 * 60; i++) { room.tick(STEP); if (room.phase === 'racing') break; }
    const before = room.snapshot()!.cars.find(c => c.id === a.playerId)!.targetLane;
    room.applyIntent(a.playerId, before === 0 ? 'MOVE_RIGHT' : 'MOVE_LEFT');
    const after = room.snapshot()!.cars.find(c => c.id === a.playerId)!.targetLane;
    expect(after).not.toBe(before);
  });

  it('lobbyPlayers returns the roster with id/name/color/lane', () => {
    const room = new Room('4821', 1);
    const a = room.addPlayer('Ada', '#f22f46') as { playerId: string; lane: number };
    room.addPlayer('Rex');
    const roster = room.lobbyPlayers();
    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({ playerId: a.playerId, name: 'Ada', color: '#f22f46', lane: 0 });
    expect(roster[1]!.name).toBe('Rex');
    expect(typeof roster[1]!.color).toBe('string');
  });

  it('generates a different course layout on each start() (no two identical races)', () => {
    room.addPlayer('You'); room.addPlayer('Ada');
    room.start();
    const first = JSON.stringify(room.snapshot()!.items);
    room.start();
    const second = JSON.stringify(room.snapshot()!.items);
    expect(second).not.toEqual(first);
  });

  it('removePlayer mid-race removes the car from the live world (no wedge)', () => {
    const a = room.addPlayer('You') as any;
    const b = room.addPlayer('Ada') as any;
    room.start();
    for (let i = 0; i < 8 * 60; i++) { room.tick(STEP); if (room.phase === 'racing') break; }
    expect(room.snapshot()!.cars.map(c => c.id).sort()).toEqual([a.playerId, b.playerId].sort());
    room.removePlayer(b.playerId);
    expect(room.snapshot()!.cars.map(c => c.id)).toEqual([a.playerId]);
  });

  it('isEmpty reflects whether any players remain', () => {
    expect(room.isEmpty).toBe(true);
    const a = room.addPlayer('You') as any;
    expect(room.isEmpty).toBe(false);
    room.removePlayer(a.playerId);
    expect(room.isEmpty).toBe(true);
  });

  it('drains the countdown/go events', () => {
    room.addPlayer('You'); room.start();
    let sawGo = false;
    for (let i = 0; i < 8 * 60; i++) {
      room.tick(STEP);
      if (room.drainEvents().some(e => e.kind === 'go')) sawGo = true;
      if (room.phase === 'racing') break;
    }
    expect(sawGo).toBe(true);
  });
});

describe('Room — Smash-style pre-race flow', () => {
  let room: Room;
  beforeEach(() => { room = new Room('FLOW', 1, { carCount: 19, maps: ['Silver Lake', 'Neon City'] }); });

  it('advances lobby → car_select → map_select, then advance() starts the race', () => {
    room.addPlayer('Ada'); room.addPlayer('Rex');
    expect(room.phase).toBe('lobby');
    room.advance(); expect(room.phase).toBe('car_select');
    room.advance(); expect(room.phase).toBe('car_select');  // blocked — nobody has picked yet
    room.selectCar(room.lobbyPlayers()[0]!.playerId, 3);
    room.selectCar(room.lobbyPlayers()[1]!.playerId, 5);
    room.advance(); expect(room.phase).toBe('map_select');
    for(const player of room.lobbyPlayers())room.selectMap('Neon City',player.playerId);
    room.advance();
    expect(['countdown', 'racing']).toContain(room.phase);
    expect(room.selectedMap).toBe('Neon City');
  });

  it('starts the race using each player\'s chosen car model', () => {
    const a = room.addPlayer('Ada') as any;
    const b = room.addPlayer('Rex') as any;
    room.advance();
    room.selectCar(a.playerId, 8);
    room.selectCar(b.playerId, 2);
    room.advance();for(const player of room.lobbyPlayers())room.selectMap('Silver Lake',player.playerId);room.advance();
    const cars = room.snapshot()!.cars;
    expect(cars.find(c => c.id === a.playerId)!.carIndex).toBe(8);
    expect(cars.find(c => c.id === b.playerId)!.carIndex).toBe(2);
  });

  it('back() steps the selection phase backward', () => {
    room.addPlayer('Ada'); room.advance(); room.selectCar(room.lobbyPlayers()[0]!.playerId, 0); room.advance();
    expect(room.phase).toBe('map_select');
    room.back(); expect(room.phase).toBe('car_select');
    room.back(); expect(room.phase).toBe('lobby');
  });

  it('captures results and enters the results phase when the race finishes', () => {
    room.addPlayer('Ada'); room.advance(); room.selectCar(room.lobbyPlayers()[0]!.playerId, 1);
    room.advance(); room.selectMap('Silver Lake'); room.advance();
    // run the race to completion (single player finishes after a while)
    for (let i = 0; i < 60 * 120 && room.phase !== 'results'; i++) room.tick(STEP);
    expect(room.phase).toBe('results');
    const r = room.results();
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ name: 'Ada', place: 1, finished: true });
    expect(r[0]!.finishT).toBeGreaterThan(0);
  });

  it('keeps the finished scoreboard visible after the last caller hangs up until a new round is ready', () => {
    room = new Room('RESULT-HOLD', 1, { carCount: 1, maps: ['Silver Lake'] });
    const first = room.addPlayer('Ada') as { playerId: string };
    room.start();
    for (let i = 0; i < 60 * 120 && room.phase !== 'results'; i++) room.tick(STEP);
    expect(room.phase).toBe('results');
    const standings = room.results();

    room.removePlayer(first.playerId);
    expect(room.phase).toBe('results');
    expect(room.results()).toEqual(standings);
    expect(room.canAdvance()).toBe(false);

    const next = room.addPlayer('Bo') as { playerId: string };
    expect(room.isWaitingForNextRound(next.playerId)).toBe(true);
    expect(room.canAdvance()).toBe(true);
    expect(room.canAdvance(next.playerId)).toBe(true);
    expect(room.advance(next.playerId)).toBe(true);
    expect(room.phase).toBe('lobby');
    expect(room.lobbyPlayers().map(player => player.name)).toEqual(['Bo']);
  });

  it('advance() from results plays again — fresh car_select with the same players, cleared picks', () => {
    room.addPlayer('Ada'); room.advance(); const pid = room.lobbyPlayers()[0]!.playerId;
    room.selectCar(pid, 9); room.advance(); room.selectMap('Silver Lake'); room.advance();
    for (let i = 0; i < 60 * 120 && room.phase !== 'results'; i++) room.tick(STEP);
    expect(room.phase).toBe('results');
    room.advance();   // "play again"
    expect(room.phase).toBe('car_select');                       // straight back to picking cars
    expect(room.lobbyPlayers().map(p => p.name)).toEqual(['Ada']); // same roster
    expect(room.lobbyPlayers()[0]!.carIndex).toBe(null);          // picks cleared
  });

  it('a new joiner after results resets the room to a fresh lobby', () => {
    room.addPlayer('Ada'); room.advance(); room.selectCar(room.lobbyPlayers()[0]!.playerId, 1);
    room.advance(); room.selectMap('Silver Lake'); room.advance();
    for (let i = 0; i < 60 * 120 && room.phase !== 'results'; i++) room.tick(STEP);
    expect(room.phase).toBe('results');
    const result = room.results();
    const waiting = room.addPlayer('NewGuy');
    if ('error' in waiting) throw new Error(waiting.error);
    expect(room.phase).toBe('results');
    expect(room.results()).toEqual(result);
    expect(room.isWaitingForNextRound(waiting.playerId)).toBe(true);
    expect(room.advance(waiting.playerId)).toBe(false);
    expect(room.phase).toBe('results');
    expect(room.advance(room.lobbyPlayers()[0]!.playerId)).toBe(true);
    expect(room.phase).toBe('lobby');
    expect(room.isWaitingForNextRound(waiting.playerId)).toBe(false);
    expect(room.lobbyPlayers().map(p => p.name)).toEqual(['Ada', 'NewGuy']);
    expect(room.lobbyPlayers().every(p => p.carIndex === null)).toBe(true);
  });

  it('does not clear a full room result when another caller tries to join', () => {
    room = new Room('FULL-RESULT', 1, { carCount: 2, maps: ['Silver Lake'] });
    const first = room.addPlayer('Ada') as { playerId: string };
    const second = room.addPlayer('Bo') as { playerId: string };
    room.advance(); room.selectCar(first.playerId, 0); room.selectCar(second.playerId, 1);
    room.advance(); room.selectMap('Silver Lake', first.playerId); room.selectMap('Silver Lake', second.playerId);
    room.advance();
    for (let i = 0; i < 60 * 120 && room.phase !== 'results'; i++) room.tick(STEP);
    const result = room.results();
    expect(room.phase).toBe('results');

    expect(room.addPlayer('Late')).toEqual({ error: 'room_full' });
    expect(room.phase).toBe('results');
    expect(room.results()).toEqual(result);
  });

  it('configure() sets car/map choices while keeping the roster', () => {
    const bare = new Room('CFG', 2);
    bare.addPlayer('Ada');
    bare.configure({ carCount: 19, maps: ['Silver Lake'] });
    expect(bare.mapChoices).toEqual(['Silver Lake']);
    expect(bare.lobbyPlayers().map(p => p.name)).toEqual(['Ada']);
  });
});
