import { describe, expect, it } from 'vitest';
import { FighterRoom } from '../server/fighter-room';
import { FIGHTER_MAPS, FIGHTER_ROSTER } from '../shared/fighter-roster';
import type { FighterCommand } from '../shared/fighter-world';

type Policy = 'kick' | 'mixed' | 'guarded';

function playSolo(seed:number,pace:number,policy:Policy,mapId:string,fighterId:string):boolean{
  const room=new FighterRoom(`BALANCE-${seed}`,seed);
  const joined=room.addPlayer('Caller');if('error'in joined)throw new Error(joined.error);
  room.advance();room.selectFighter(joined.playerId,fighterId);room.advance();
  room.selectMap(joined.playerId,mapId);room.advance();room.ready(room.state().loadingGeneration);
  room.startNow(joined.playerId);
  let nextCallerAction=0,actionIndex=0;
  for(let time=0;time<120&&room.phase==='fight';time+=0.05){
    const world=room.state().world!;
    if(world.now>=nextCallerAction){
      const distance=Math.abs(world.p1.x-world.p2.x);
      let command:FighterCommand=distance>1.75?'forward':'kick';
      if(distance<=1.75&&policy==='mixed')command=actionIndex%3===0?'punch':'kick';
      if(distance<=1.75&&policy==='guarded')command=actionIndex%4===0?'block':'kick';
      room.voiceCommand(joined.playerId,command);
      nextCallerAction=world.now+pace;actionIndex++;
    }
    room.tick(0.05);
  }
  return room.state().result?.winner==='p1';
}

describe('solo Fighter voice balance',()=>{
  it('gives speech-paced callers a fair advantage across seeds, policies, fighters, and arenas',()=>{
    const maps=FIGHTER_MAPS.slice(0,3).map(map=>map.id);
    const fighters=FIGHTER_ROSTER.slice(0,3).map(fighter=>fighter.id);
    const winsByPace=new Map<number,number>();
    for(const policy of ['kick','mixed','guarded'] as const){
      for(const pace of [1.2,1.6,2.0]){
        let segmentWins=0;
        for(let index=0;index<24;index++){
          const seed=(index*0x1f123bb5+(policy==='kick'?11:policy==='mixed'?29:47))>>>0;
          segmentWins+=Number(playSolo(seed,pace,policy,maps[index%maps.length]!,fighters[index%fighters.length]!));
        }
        winsByPace.set(pace,(winsByPace.get(pace)??0)+segmentWins);
      }
    }
    const typicalVoiceRate=((winsByPace.get(1.6)??0)+(winsByPace.get(2.0)??0))/144;
    expect(typicalVoiceRate).toBeGreaterThanOrEqual(0.60);
    expect(typicalVoiceRate).toBeLessThanOrEqual(0.75);
    expect((winsByPace.get(2.0)??0)/72).toBeGreaterThanOrEqual(0.50);
    expect((winsByPace.get(1.2)??0)/72).toBeGreaterThanOrEqual(0.75);
  });
});
