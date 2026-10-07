// The server-side game room for Voice Monsters: lobby → monster_select → battle → results. Wraps the
// pure BattleWorld and manages joining, per-player monster picks, single-player (1 human vs AI) vs
// 2-player (human vs human), and AI move responses. Mirrors Room's public shape so the GameServer
// wiring is familiar. Kept free of ws/http so it's unit-testable.
import { describe, it, expect, vi } from 'vitest';
import { BattleRoom } from '../server/battle-room';
import { ROSTER } from '../shared/monster-roster';

function room() { return new BattleRoom('4821', 42); }
const M0 = ROSTER[0]!.id, M1 = ROSTER[1]!.id;

describe('BattleRoom', () => {
  it('keeps standalone Monsters in lobby until a named caller explicitly advances', () => {
    const room = new BattleRoom('NAMES', 1);
    room.expectHumanPlayers(1);
    const caller = room.addPlayer('Challenger', undefined, false); if ('error' in caller) throw new Error(caller.error);
    expect(room.phase).toBe('lobby');
    room.setPlayerInfo(caller.playerId, { name: 'Ada' });
    expect(room.phase).toBe('lobby');
    expect(room.advance()).toBe(false);
    expect(room.advance(caller.playerId)).toBe(true);
    expect(room.phase).toBe('monster_select');
  });
  it('starts in lobby and accepts up to 2 human players', () => {
    const r = room();
    expect(r.phase).toBe('lobby');
    const a = r.addPlayer('Ada'); const b = r.addPlayer('Bo');
    expect('playerId' in a && 'playerId' in b).toBe(true);
    const c = r.addPlayer('Cy');   // 3rd human rejected — battles are 1v1
    expect('error' in c).toBe(true);
    expect(r.playerCount).toBe(2);
  });

  it('accepts setup input from both standalone callers', () => {
    const r=room();const a=r.addPlayer('Ada') as {playerId:string};const b=r.addPlayer('Bo') as {playerId:string};
    expect(r.canControlSetup(a.playerId)).toBe(true);
    expect(r.canControlSetup(b.playerId)).toBe(true);
  });

  it('advances lobby → monster_select and records each pick', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance();
    expect(r.phase).toBe('monster_select');
    r.selectMonster(a.playerId, M0);
    expect(r.lobbyPlayers().find(p => p.playerId === a.playerId)!.monsterId).toBe(M0);
  });

  it('rejects an unknown monster id', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, 'not-a-monster');
    expect(r.lobbyPlayers()[0]!.monsterId).toBeNull();
  });

  it('exposes phase-correct readiness for a solo battle', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    expect(r.canStart()).toBe(false);
    r.advance();
    expect(r.canStart()).toBe(false);
    r.selectMonster(a.playerId, M0);
    expect(r.canStart()).toBe(true);
    r.advance();
    expect(r.canStart()).toBe(false);
  });

  it('SINGLE-PLAYER: 1 human who picked → start battles an AI opponent (with its own monster)', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance();                 // → monster_select
    r.selectMonster(a.playerId, M0);
    r.advance();                 // → battle (AI fills the 2nd slot)
    expect(r.phase).toBe('battle');
    const s = r.snapshot()!;
    expect(s.a.name).toBe('Ada');
    expect(s.b.name).toBe('Rival');
    expect(s.a.monsterId).toBe(M0);
    expect(s.b.monsterId).toBeTruthy();          // AI got a monster
    expect(s.b.id).not.toBe(a.playerId);         // opponent isn't the human
  });

  it('waits for both expected station players and preserves assigned sides and picks', () => {
    const r=room();r.expectHumanPlayers(2);
    const b=r.addPlayer('Bo','b') as {playerId:string};
    expect(r.canStart()).toBe(false);
    expect(r.phase).toBe('lobby');
    const a=r.addPlayer('Ada','a') as {playerId:string};
    expect(r.phase).toBe('lobby');expect(r.advance()).toBe(false);expect(r.advance(a.playerId)).toBe(true);
    expect(r.phase).toBe('monster_select');
    r.back();expect(r.phase).toBe('monster_select');
    r.selectMonster(b.playerId,M1);
    expect(r.canStart()).toBe(false);
    r.selectMonster(a.playerId,M0);
    expect(r.phase).toBe('monster_select');expect(r.advance()).toBe(false);expect(r.advance(b.playerId)).toBe(true);
    expect(r.phase).toBe('battle');
    expect(r.canStart()).toBe(false);
    expect(r.snapshot()).toMatchObject({
      a:{id:a.playerId,name:'Ada',monsterId:M0},
      b:{id:b.playerId,name:'Bo',monsterId:M1},
    });
    expect(r.chooseAction(b.playerId,{kind:'guard'})).toBe(false);
    expect(r.chooseAction(a.playerId,{kind:'guard'})).toBe(true);
    expect(r.activeSide()).toBe('b');
    expect(r.chooseAction(b.playerId,{kind:'guard'})).toBe(true);
  });

  it('promotes a lone retained Player Two into the solo control slot after a no-show drop', () => {
    const r=room();r.expectHumanPlayers(2);
    const b=r.addPlayer('Bo','b') as {playerId:string};
    r.expectHumanPlayers(1);
    expect(r.phase).toBe('lobby');r.advance(b.playerId);
    expect(r.phase).toBe('monster_select');
    r.selectMonster(b.playerId,M1);

    expect(r.playerSide(b.playerId)).toBe('a');
    expect(r.phase).toBe('monster_select');r.advance(b.playerId);
    expect(r.phase).toBe('battle');
    expect(r.snapshot()).toMatchObject({a:{id:b.playerId,name:'Bo',monsterId:M1},b:{id:'cpu',name:'Rival'}});
  });

  it('lets a standalone survivor continue against AI after the other caller disconnects', () => {
    const r=room();r.expectHumanPlayers(2,false);
    const a=r.addPlayer('Ada') as {playerId:string};const b=r.addPlayer('Bo') as {playerId:string};
    r.removePlayer(b.playerId);
    expect(r.phase).toBe('lobby');r.advance(a.playerId);
    expect(r.phase).toBe('monster_select');
    expect(r.lobbyPlayers()[0]?.monsterId).toBeNull();
    r.selectMonster(a.playerId,M0);
    expect(r.phase).toBe('monster_select');r.advance(a.playerId);
    expect(r.phase).toBe('battle');
    expect(r.snapshot()?.b.id).toBe('cpu');
  });

  it('shows monster selection before restarting an interrupted standalone battle against AI', () => {
    const r=room();r.expectHumanPlayers(2,false);
    const a=r.addPlayer('Ada') as {playerId:string};const b=r.addPlayer('Bo') as {playerId:string};
    r.advance(a.playerId);
    r.selectMonster(a.playerId,M0);r.selectMonster(b.playerId,M1);
    r.advance(a.playerId);
    expect(r.phase).toBe('battle');
    r.removePlayer(b.playerId);
    expect(r.phase).toBe('monster_select');
    expect(r.lobbyPlayers()[0]?.monsterId).toBeNull();
    r.selectMonster(a.playerId,M0);
    expect(r.phase).toBe('monster_select');r.advance(a.playerId);
    expect(r.phase).toBe('battle');
    expect(r.snapshot()?.b.id).toBe('cpu');
  });

  it.each(['count-first','remove-first'] as const)('keeps monster selection gated when a no-show is dropped %s',order=>{
    const r=room();r.expectHumanPlayers(2);
    const a=r.addPlayer('Ada','a') as {playerId:string};const b=r.addPlayer('Bo','b') as {playerId:string};
    r.advance(a.playerId);
    r.selectMonster(a.playerId,M0);
    if(order==='count-first')r.expectHumanPlayers(1);
    r.removePlayer(b.playerId);
    if(order==='remove-first')r.expectHumanPlayers(1);
    expect(r.phase).toBe('monster_select');expect(r.advance(a.playerId)).toBe(true);
    expect(r.phase).toBe('battle');expect(r.snapshot()?.a.id).toBe(a.playerId);
  });

  it('rejects late joins during an active battle instead of corrupting the current matchup', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, M0);
    r.selectMonster(b.playerId, M1);
    r.advance();

    const late = r.addPlayer('Late');

    expect('error' in late).toBe(true);
    expect(r.playerCount).toBe(2);
    expect(r.phase).toBe('battle');
  });

  it('queues a second player who joins an active solo battle without changing the matchup', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(a.playerId, M0); r.advance();
    const before = r.snapshot()!;

    const queued = r.addPlayer('Bo');

    expect('playerId' in queued).toBe(true);
    expect(r.phase).toBe('battle');
    expect(r.playerCount).toBe(2);
    expect(r.snapshot()!.a.id).toBe(before.a.id);
    expect(r.snapshot()!.b.id).toBe(before.b.id);
  });

  it('does not reset a full results room when a late player tries to join', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, 'embertail'); r.selectMonster(b.playerId, 'thornling');
    r.advance();
    for (let i = 0; i < 100 && r.phase === 'battle'; i++) {
      const s = r.snapshot()!;
      const active = r.activeSide();
      if (active === 'a') r.chooseMove(a.playerId, s.a.moves[1]!.id);
      else if (active === 'b') r.chooseMove(b.playerId, s.b.moves[0]!.id);
    }
    expect(r.phase).toBe('results');

    const late = r.addPlayer('Late');

    expect('error' in late).toBe(true);
    expect(r.phase).toBe('results');
    expect(r.playerCount).toBe(2);
  });

  it('lets a second player join after solo results without erasing the finished battle', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(a.playerId, 'embertail'); r.advance();
    for (let i = 0; i < 100 && r.phase === 'battle'; i++) {
      const s = r.snapshot()!;
      r.chooseMove(a.playerId, s.a.moves[1]!.id);
      if (r.aiPending()) r.resolveAiTurn();
    }
    expect(r.phase).toBe('results');

    const late = r.addPlayer('Late');

    expect('playerId' in late).toBe(true);
    expect(r.phase).toBe('results');
    expect(r.playerCount).toBe(2);
    expect(r.result()).not.toBeNull();
  });

  it('keeps the completed result after its last caller hangs up until a new standalone caller joins', () => {
    const r = room();
    const original = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(original.playerId, 'embertail'); r.advance();
    for (let i = 0; i < 100 && r.phase === 'battle'; i++) {
      const snapshot = r.snapshot()!;
      r.chooseMove(original.playerId, snapshot.a.moves[1]!.id);
      if (r.aiPending()) r.resolveAiTurn();
    }
    expect(r.phase).toBe('results');
    expect(r.acknowledgeResultsPresented(r.generation)).toBe(true);
    const result = r.result();
    const finalSnapshot = r.snapshot();

    r.removePlayer(original.playerId);

    expect(r.isEmpty).toBe(true);
    expect(r.phase).toBe('results');
    expect(r.result()).toEqual(result);
    expect(r.snapshot()).toEqual(finalSnapshot);
    expect(r.resultsPresented).toBe(true);
    expect(r.isFinishedBattleParticipant(original.playerId)).toBe(false);
    expect(r.advance(original.playerId)).toBe(false);

    const next = r.addPlayer('Bo') as { playerId: string };
    expect(next.playerId).toBeTruthy();
    expect(r.phase).toBe('lobby');
    expect(r.result()).toBeNull();
    expect(r.advance(next.playerId)).toBe(true);
  });

  it('starts a fresh solo session after both players leave a completed standalone duel', () => {
    const r = room();
    const ada = r.addPlayer('Ada') as { playerId: string };
    const bo = r.addPlayer('Bo') as { playerId: string };
    r.expectHumanPlayers(2, false);
    r.advance(ada.playerId);
    r.selectMonster(ada.playerId, 'embertail');
    r.selectMonster(bo.playerId, 'thornling');
    r.advance(bo.playerId);
    for (let i = 0; i < 100 && r.phase === 'battle'; i++) {
      const snapshot = r.snapshot()!;
      if (r.activeSide() === 'a') r.chooseMove(ada.playerId, snapshot.a.moves[1]!.id);
      else r.chooseMove(bo.playerId, snapshot.b.moves[0]!.id);
    }
    expect(r.phase).toBe('results');
    r.removePlayer(ada.playerId);
    r.removePlayer(bo.playerId);
    expect(r.phase).toBe('results');

    const next = r.addPlayer('Cy') as { playerId: string };
    expect(r.phase).toBe('lobby');
    expect(next.playerId).toBeTruthy();
    expect(r.advance()).toBe(true);
    expect(r.phase).toBe('monster_select');
    r.selectMonster(next.playerId, 'embertail');
    expect(r.advance(next.playerId)).toBe(true);
    expect(r.phase).toBe('battle');
    expect(r.snapshot()?.b.name).toBe('Rival');
  });

  it('lets only a finished-battle participant request its rematch', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const r = room();
      const original = r.addPlayer('Ada') as { playerId: string };
      r.advance(); r.selectMonster(original.playerId, 'embertail'); r.advance();
      for (let i = 0; i < 100 && r.phase === 'battle'; i++) {
        const snap = r.snapshot()!;
        r.chooseMove(original.playerId, snap.a.moves[1]!.id);
        if (r.aiPending()) r.resolveAiTurn();
      }
      expect(r.phase).toBe('results');
      const result = r.result();
      const newcomer = r.addPlayer('Late') as { playerId: string };
      expect(r.resultsPresentationTimedOut).toBe(false);
      vi.advanceTimersByTime(r.rematchReadyInMs + 1);
      expect(r.resultsPresentationTimedOut).toBe(true);

      expect(r.advance(newcomer.playerId)).toBe(false);
      expect(r.advance('stale-player')).toBe(false);
      expect(r.phase).toBe('results');
      expect(r.result()).toEqual(result);
      expect(r.advance(original.playerId)).toBe(true);
      expect(r.phase).toBe('monster_select');
    } finally { vi.useRealTimers(); }
  });

  it('lets a waiting caller start the next round after the finished players leave', () => {
    const r = room();
    const original = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(original.playerId, 'embertail'); r.advance();
    for (let index = 0; index < 100 && r.phase === 'battle'; index++) {
      const snap = r.snapshot()!;
      r.chooseMove(original.playerId, snap.a.moves[1]!.id);
      if (r.aiPending()) r.resolveAiTurn();
    }
    expect(r.phase).toBe('results');
    expect(r.acknowledgeResultsPresented(r.generation)).toBe(true);
    const result = r.result();
    const waiting = r.addPlayer('Bo') as { playerId: string };
    expect(r.canStartNextRound(waiting.playerId)).toBe(false);
    expect(r.advance(waiting.playerId)).toBe(false);
    expect(r.result()).toEqual(result);

    r.removePlayer(original.playerId);
    expect(r.phase).toBe('results');
    expect(r.result()).toEqual(result);
    expect(r.canStartNextRound(waiting.playerId)).toBe(true);
    expect(r.advance(waiting.playerId)).toBe(true);
    expect(r.phase).toBe('monster_select');
    expect(r.result()).toBeNull();
  });

  it('unlocks a finished participant’s rematch when the matching result overlay is actually presented', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const r=room(),player=r.addPlayer('Ada') as {playerId:string};
      r.advance();r.selectMonster(player.playerId,'embertail');r.advance();
      for(let index=0;index<100&&r.phase==='battle';index++){
        const snap=r.snapshot()!;r.chooseMove(player.playerId,snap.a.moves[1]!.id);
        if(r.aiPending())r.resolveAiTurn();
      }
      expect(r.phase).toBe('results');
      expect(r.resultsPresented).toBe(false);
      expect(r.acknowledgeResultsPresented(r.generation+1)).toBe(false);
      expect(r.canRematch).toBe(false);
      expect(r.acknowledgeResultsPresented(r.generation)).toBe(true);
      expect(r.resultsPresented).toBe(true);
      expect(r.canRematch).toBe(true);
      expect(r.advance(player.playerId)).toBe(true);
      expect(r.resultsPresented).toBe(false);
    }finally{vi.useRealTimers();}
  });

  it('lets a bound station caller return to the previous setup menu',()=>{
    const r=room();r.expectHumanPlayers(1);
    const player=r.addPlayer('Ada') as {playerId:string};
    r.advance(player.playerId);
    expect(r.back()).toBe(false);
    expect(r.back('stale')).toBe(false);
    expect(r.back(player.playerId)).toBe(true);
    expect(r.phase).toBe('lobby');
  });

  it('reports setup and battle-menu changes only when the caller actually changed them', () => {
    const r = room();
    const joined = r.addPlayer('Ada') as { playerId: string };
    expect(r.selectMonster(joined.playerId, M0)).toBe(false);
    expect(r.back()).toBe(false);
    r.advance();
    expect(r.selectMonster(joined.playerId, M0)).toBe(true);
    expect(r.selectMonster('missing', M1)).toBe(false);
    expect(r.back()).toBe(true);
    expect(r.phase).toBe('lobby');
    r.advance(); r.selectMonster(joined.playerId, M0); r.advance();
    expect(r.openFightMenu('missing')).toBe(false);
    expect(r.openFightMenu(joined.playerId)).toBe(true);
    expect(r.backMenu(joined.playerId)).toBe(true);
  });

  it('returns a rematch to lobby when a late caller still needs to confirm a name', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const r = room();
      const a = r.addPlayer('Ada') as { playerId: string };
      r.advance(); r.selectMonster(a.playerId, M0); r.advance();
      for (let i = 0; i < 100 && r.phase === 'battle'; i++) {
        const s = r.snapshot()!;
        r.chooseMove(a.playerId, s.a.moves[1]!.id);
        if (r.aiPending()) r.resolveAiTurn();
      }
      expect(r.phase).toBe('results');
      const late = r.addPlayer('Challenger', undefined, false); if ('error' in late) throw new Error(late.error);
      vi.advanceTimersByTime(r.rematchReadyInMs + 1);
      r.advance();
      expect(r.phase).toBe('lobby');
      expect(r.hasConfirmedName(late.playerId)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('returns an interrupted battle to lobby when the queued caller still needs a name', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(a.playerId, M0); r.advance();
    const late = r.addPlayer('Challenger', undefined, false); if ('error' in late) throw new Error(late.error);
    r.removePlayer(a.playerId);
    expect(r.phase).toBe('lobby');
    expect(r.hasConfirmedName(late.playerId)).toBe(false);
  });

  it('does not allow a rematch until the final event sequence has finished', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const r = room();
      const a = r.addPlayer('Ada') as { playerId: string };
      r.advance(); r.selectMonster(a.playerId, 'embertail'); r.advance();
      for (let i = 0; i < 100 && r.phase === 'battle'; i++) {
        const s = r.snapshot()!;
        r.chooseMove(a.playerId, s.a.moves[1]!.id);
        if (r.aiPending()) r.resolveAiTurn();
      }
      expect(r.phase).toBe('results');
      expect(r.canRematch).toBe(false);

      r.advance();
      expect(r.phase).toBe('results');
      vi.advanceTimersByTime(r.rematchReadyInMs + 1);
      r.advance();
      expect(r.phase).toBe('monster_select');
    } finally {
      vi.useRealTimers();
    }
  });

  it('SINGLE-PLAYER: human action resolves immediately → AI is pending for the next beat', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(a.playerId, M0); r.advance();
    const before = r.snapshot()!;
    r.chooseMove(a.playerId, before.a.moves[0]!.id);   // human's action resolves now…
    expect(r.snapshot()!.turn).toBe(before.turn + 1);
    expect(r.snapshot()!.chosen.a).toBe(false);
    expect(r.activeSide()).toBe('b');                   // …then the AI gets a separate beat.
    expect(r.aiPending()).toBe(true);
    r.resolveAiTurn();                                 // server calls this ~700ms later
    const after = r.snapshot()!;
    expect(after.turn).toBe(before.turn + 2);
    expect(after.b.hp).toBeLessThanOrEqual(before.b.hp);
    expect(r.activeSide()).toBe('a');
    expect(r.aiPending()).toBe(false);
  });

  it('TWO-PLAYER: each active human action resolves before the next player is prompted', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, M0); r.selectMonster(b.playerId, M1);
    r.advance();
    expect(r.phase).toBe('battle');
    const before = r.snapshot()!;
    r.chooseMove(a.playerId, before.a.moves[0]!.id);
    expect(r.snapshot()!.turn).toBe(before.turn + 1);  // Ada's attack happened
    expect(r.activeSide()).toBe('b');                  // now Bo's turn
    r.chooseMove(b.playerId, before.b.moves[0]!.id);
    expect(r.snapshot()!.turn).toBe(before.turn + 2);  // Bo's attack happened
    expect(r.activeSide()).toBe('a');                  // back to Ada
  });

  it('TWO-PLAYER: exposes one active chooser at a time and rejects out-of-turn commits', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, M0); r.selectMonster(b.playerId, M1);
    r.advance();
    const before = r.snapshot()!;

    expect(r.activeSide()).toBe('a');
    r.chooseMove(b.playerId, before.b.moves[0]!.id);   // Bo tries early — ignored
    expect(r.snapshot()!.chosen.b).toBe(false);
    expect(r.snapshot()!.turn).toBe(before.turn);

    r.chooseMove(a.playerId, before.a.moves[0]!.id);
    expect(r.activeSide()).toBe('b');
    expect(r.snapshot()!.chosen.a).toBe(false);
    expect(r.snapshot()!.turn).toBe(before.turn + 1);

    r.chooseMove(b.playerId, before.b.moves[0]!.id);
    expect(r.snapshot()!.turn).toBe(before.turn + 2);
    expect(r.activeSide()).toBe('a');
  });

  it('does not consume the active side turn for an invalid move', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(a.playerId, M0); r.advance();
    const before = r.snapshot()!.turn;

    expect(r.chooseMove(a.playerId, 'not-a-real-move')).toBe(false);

    expect(r.snapshot()!.turn).toBe(before);
    expect(r.activeSide()).toBe('a');
    expect(r.aiPending()).toBe(false);
  });

  it('server-synced fight menu only opens for the active side', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, M0); r.selectMonster(b.playerId, M1);
    r.advance();

    r.openFightMenu(b.playerId);
    expect(r.activeMenu()).toBe('root');
    r.openFightMenu(a.playerId);
    expect(r.activeMenu()).toBe('fight');
    r.backMenu(a.playerId);
    expect(r.activeMenu()).toBe('root');
  });

  it('interrupts a 2P battle if a participant leaves but preserves the survivor monster pick', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    const b = r.addPlayer('Bo') as { playerId: string };
    r.advance();
    r.selectMonster(a.playerId, M0); r.selectMonster(b.playerId, M1);
    r.advance();
    expect(r.phase).toBe('battle');

    r.removePlayer(a.playerId);

    expect(r.phase).toBe('monster_select');
    expect(r.playerCount).toBe(1);
    expect(r.snapshot()).toBeNull();
    expect(r.lobbyPlayers()[0]!.monsterId).toBe(M1);
  });

  it('reaches results with a winner when a monster faints', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(a.playerId, 'embertail'); r.advance();
    for (let i = 0; i < 100 && r.phase === 'battle'; i++) {
      const s = r.snapshot()!;
      r.chooseMove(a.playerId, s.a.moves[1]!.id);   // strong move
      if (r.aiPending()) r.resolveAiTurn();          // the AI's beat (server would defer this)
    }
    expect(r.phase).toBe('results');
    expect(r.result()!.winnerName.length).toBeGreaterThan(0);
  });

  it('drains ordered battle events for the renderer/commentator', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    r.advance(); r.selectMonster(a.playerId, M0); r.advance();
    r.chooseMove(a.playerId, r.snapshot()!.a.moves[0]!.id);
    r.resolveAiTurn();                         // the turn resolves once the AI takes its beat
    const evs = r.drainEvents();
    expect(evs.some(e => e.kind === 'move_used')).toBe(true);
    expect(r.drainEvents()).toHaveLength(0);   // drained once
  });

  it('removing the only player empties the room', () => {
    const r = room();
    const a = r.addPlayer('Ada') as { playerId: string };
    expect(r.isEmpty).toBe(false);
    r.removePlayer(a.playerId);
    expect(r.isEmpty).toBe(true);
  });
});
