// The Voice Monsters CALL session — binds a Conversation Relay caller to a battle room, routes their
// spoken turns (via the voice matcher + LLM host) into battle actions, and speaks commentary from
// battle events. Tested against a fake battle backend + fake LLM (no WS/Twilio).
import { describe, it, expect, vi } from 'vitest';
import { BattleVoiceSession, parseSpokenName, isAdvanceWord, type BattleVoiceDeps, type BattleVoiceSnapshot } from '../server/battle-voice';
import { BattleRoom } from '../server/battle-room';
import type { BattleEvent } from '../shared/battle-world';
import type { VoiceInterpretResult } from '../server/voice-interpreter';

describe('parseSpokenName', () => {
  it('extracts a name from common phrasings', () => {
    expect(parseSpokenName("I'm Ada")).toBe('Ada');
    expect(parseSpokenName('my name is rex')).toBe('Rex');
    expect(parseSpokenName('this is Bo')).toBe('Bo');
    expect(parseSpokenName('Ada')).toBe('Ada');
    expect(parseSpokenName('call me Max')).toBe('Max');
  });
  it('rejects questions + game commands (so they are not taken as a name)', () => {
    expect(parseSpokenName('start')).toBeNull();
    expect(parseSpokenName('which monster is best?')).toBeNull();
    expect(parseSpokenName('what do I do?')).toBeNull();
    expect(parseSpokenName('')).toBeNull();
  });
});

describe('isAdvanceWord', () => {
  it('recognizes the ways a caller says "move forward"', () => {
    for (const w of ['start', 'go', 'begin', 'battle', 'fight', "let's go", 'ready', 'next', 'rematch', 'again', 'run it back']) {
      expect(isAdvanceWord(w)).toBe(true);
    }
  });
  it('does not fire on unrelated speech', () => {
    expect(isAdvanceWord('Sparkmouse')).toBe(false);
    expect(isAdvanceWord('what is this?')).toBe(false);
    expect(isAdvanceWord('start or wait')).toBe(false);
    expect(isAdvanceWord('how do i fight')).toBe(false);
    expect(isAdvanceWord('can you explain battle')).toBe(false);
    expect(isAdvanceWord('who won the battle')).toBe(false);
    expect(isAdvanceWord('como lutar', 'pt-BR')).toBe(false);
  });
});

// A fake battle backend capturing the actions the session drives.
function battleSnap(over: Partial<BattleVoiceSnapshot> = {}): BattleVoiceSnapshot {
  return {
    phase: 'monster_select',
    mySide: 'a',
    monsterNames: ['Sparkmouse', 'Embertail', 'Shellback'],
    myName: null,
    myMonsterId: null,
    myMonsterName: null,
    myMonsterType: null,
    canAdvanceLobby: true,
    canStartBattle: false,
    canRematch: true,
    foeName: null,
    foeMonsterName: null,
    foeMonsterType: null,
    myHp: null,
    myMaxHp: null,
    foeHp: null,
    foeMaxHp: null,
    myPotions: 2,
    turn: null,
    activeSide: null,
    participating: true,
    activeMenu: 'root',
    whoseTurn: null,
    myMoves: [],
    winnerName: null,
    ...over,
  };
}

function activeBattle(over: Partial<BattleVoiceSnapshot> = {}): BattleVoiceSnapshot {
  return battleSnap({
    phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
    foeName: 'Bo', foeMonsterName: 'Shellback', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 82, foeMaxHp: 82,
    turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
    myMoves: [
      { id: 'sparkmouse.jolt', name: 'Thunder Jolt' },
      { id: 'sparkmouse.zap', name: 'Static Zap' },
      { id: 'sparkmouse.bite', name: 'Quick Bite' },
      { id: 'sparkmouse.tackle', name: 'Tackle' },
    ],
    ...over,
  });
}

function fakeDeps(over: Partial<BattleVoiceDeps> = {}): { deps: BattleVoiceDeps; log: string[]; said: string[] } {
  const log: string[] = [];
  const said: string[] = [];
  const deps: BattleVoiceDeps = {
    join: (code, name) => { log.push(`join ${code} ${name}`); return { playerId: 'p1', resumed: false }; },
    leave: (code, id) => log.push(`leave ${code} ${id}`),
    setName: (_c, _id, n) => log.push(`name ${n}`),
    selectMonster: (_c, _id, m) => { log.push(`monster ${m}`); },
    openFight: (_c, _id) => { log.push('openFight'); },
    backMenu: (_c, _id) => { log.push('backMenu'); },
    chooseAction: (_c, _id, a) => { log.push(`action ${JSON.stringify(a)}`); },
    advance: (_c, _id) => { log.push('advance'); return true; },
    setTimer: (fn: () => void) => { fn(); },   // synchronous in tests → paced commentary drains at once
    say: (t) => said.push(t),
    snapshot: () => battleSnap(),
    converse: async () => null,   // LLM off by default → scripted/deterministic paths
    ...over,
  };
  return { deps, log, said };
}

const setup = (code = '4821', commandLocale?: string) => JSON.stringify({
  type: 'setup', callSid: 'CA1',
  customParameters: { roomCode: code, ...(commandLocale ? { commandLocale } : {}) },
});
const prompt = (text: string, last = true) => JSON.stringify({ type: 'prompt', voicePrompt: text, last });
const dtmf = (digit: string) => JSON.stringify({ type: 'dtmf', digit });

describe('BattleVoiceSession', () => {
  it('retires the Twilio introduction when the visible menu changes', () => {
    let snap = battleSnap({ phase: 'lobby', myName: null, nameConfirmed: false });
    const lines: { text: string; isCurrent?: () => boolean }[] = [];
    const { deps } = fakeDeps({ snapshot: () => snap, say: (text, isCurrent) => lines.push({ text, isCurrent }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    const relayIntro = lines.find(line => /Conversation Relay/i.test(line.text));
    expect(relayIntro?.isCurrent?.()).toBe(true);

    session.handleMessage(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 100 }));
    expect(relayIntro?.isCurrent?.()).toBe(false);

    const nextSession = new BattleVoiceSession(deps);
    lines.length = 0;
    nextSession.handleMessage(setup());
    const menuIntro = lines.find(line => /Conversation Relay/i.test(line.text));
    expect(menuIntro?.isCurrent?.()).toBe(true);
    snap = { ...snap, phase: 'monster_select', myName: 'Ada', nameConfirmed: true };
    nextSession.onBattleStateChanged();
    expect(menuIntro?.isCurrent?.()).toBe(false);
    expect(lines.some(line => /choose your own monster/i.test(line.text))).toBe(true);
    snap = activeBattle();
    nextSession.onBattleStateChanged();
    expect(menuIntro?.isCurrent?.()).toBe(false);
    snap = battleSnap({ phase: 'monster_select', myName: 'Ada', nameConfirmed: true });
    nextSession.onBattleStateChanged();
    expect(menuIntro?.isCurrent?.()).toBe(false);
  });

  it('speaks a replacement cue when a touchscreen chooses the caller’s monster', () => {
    let snap = battleSnap({ myName: 'Ada', nameConfirmed: true, canStartBattle: false });
    const { deps, said } = fakeDeps({ snapshot: () => snap });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    said.length = 0;
    snap = { ...snap, myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse' };
    session.onBattleStateChanged();
    expect(said.join(' ')).toMatch(/Sparkmouse.*locked|locked.*Sparkmouse/i);
    expect(said.join(' ')).toMatch(/say battle to confirm.*wait for the other player/i);
  });

  it('keeps a caller’s queued monster guidance when only the other choice changes', () => {
    let snap = battleSnap({ myName: 'Ada', nameConfirmed: true, setupPlayerCount: 2, foeName: 'Bo' });
    const lines: { text: string; isCurrent?: () => boolean }[] = [];
    const { deps } = fakeDeps({ snapshot: () => snap, say: (text, isCurrent) => lines.push({ text, isCurrent }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    const choicePrompt = lines.find(line => /choose your own monster/i.test(line.text));
    expect(choicePrompt?.isCurrent?.()).toBe(true);

    snap = { ...snap, foeMonsterName: 'Embertail' };
    session.onBattleStateChanged();
    expect(choicePrompt?.isCurrent?.()).toBe(true);
  });

  it('replaces a canceled pick cue with the caller’s monster and the next action', () => {
    let snap = battleSnap({ myName: 'Ada', nameConfirmed: true, setupPlayerCount: 2, foeName: 'Bo' });
    let session: BattleVoiceSession;
    const lines: { text: string; isCurrent?: () => boolean }[] = [];
    const { deps } = fakeDeps({
      snapshot: () => snap,
      selectMonster: () => {
        snap = { ...snap, myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse' };
        session.onBattleStateChanged();
      },
      say: (text, isCurrent) => lines.push({ text, isCurrent }),
    });
    session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleMessage(prompt('Sparkmouse'));
    const firstPickCue = lines.find(line => /Locked in.*Sparkmouse/i.test(line.text));
    expect(firstPickCue?.isCurrent?.()).toBe(true);

    snap = { ...snap, canStartBattle: true, foeMonsterName: 'Embertail' };
    session.onBattleStateChanged();
    expect(firstPickCue?.isCurrent?.()).toBe(false);
    const current = lines.filter(line => line.isCurrent?.()).map(line => line.text).join(' ');
    expect(current).toMatch(/Sparkmouse.*say battle/i);
  });

  it('renews selection guidance when another caller joins an open seat', () => {
    let snap = battleSnap({ myName: 'Ada', nameConfirmed: true, setupPlayerCount: 1 });
    const lines: { text: string; isCurrent?: () => boolean }[] = [];
    const { deps } = fakeDeps({ snapshot: () => snap, say: (text, isCurrent) => lines.push({ text, isCurrent }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    const firstChoicePrompt = lines.find(line => /choose your own monster/i.test(line.text));
    expect(firstChoicePrompt?.isCurrent?.()).toBe(true);

    snap = { ...snap, setupPlayerCount: 2, foeName: 'Bo' };
    session.onBattleStateChanged();
    expect(firstChoicePrompt?.isCurrent?.()).toBe(false);
    expect(lines.some(line => line.isCurrent?.() && /choose your own monster/i.test(line.text))).toBe(true);
  });

  it('revokes queued name guidance after the caller or display advances', () => {
    let snap = battleSnap({ phase: 'lobby', myName: null, nameConfirmed: false });
    const lines: { text: string; isCurrent?: () => boolean }[] = [];
    const { deps } = fakeDeps({
      snapshot: () => snap,
      setName: (_code, _id, name) => { snap = { ...snap, myName: name, nameConfirmed: true }; },
      say: (text, isCurrent) => lines.push({ text, isCurrent }),
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleMessage(prompt('Ada'));
    const lobbyGuidance = lines.find(line => /say next.*choose monsters/i.test(line.text));
    expect(lobbyGuidance?.isCurrent?.()).toBe(true);
    snap = { ...snap, phase: 'monster_select' };
    session.onBattleStateChanged();
    expect(lobbyGuidance?.isCurrent?.()).toBe(false);
  });

  it('revokes queued battle narration after an interrupted or newer battle generation', () => {
    let snap = activeBattle({ generation: 7, turn: 1 });
    const lines: { text: string; isCurrent?: () => boolean }[] = [];
    const { deps } = fakeDeps({ snapshot: () => snap, say: (text, isCurrent) => lines.push({ text, isCurrent }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    lines.length = 0;
    session.onBattlePresentation({ kind: 'event', generation: 7, eventId: 1,
      event: { kind: 'move_used', by: 'a', moveId: 'sparkmouse.jolt', moveName: 'Thunder Jolt' } });
    const moveLine = lines.find(line => /Thunder Jolt/.test(line.text));
    expect(moveLine?.isCurrent?.()).toBe(true);
    snap = activeBattle({ generation: 8, turn: 0 });
    expect(moveLine?.isCurrent?.()).toBe(false);
  });

  it('lets an audible battle line finish across the next painted beat, then expires stale queued speech', () => {
    vi.useFakeTimers();
    let snap = activeBattle({ generation: 7, turn: 1 });
    const lines: { text: string; isCurrent?: () => boolean }[] = [];
    const { deps } = fakeDeps({ snapshot: () => snap, say: (text, isCurrent) => lines.push({ text, isCurrent }) });
    try {
      const session = new BattleVoiceSession(deps);
      session.handleMessage(setup());
      lines.length = 0;
      session.onBattlePresentation({ kind: 'event', generation: 7, eventId: 1,
        event: { kind: 'move_used', by: 'a', moveId: 'sparkmouse.jolt', moveName: 'Thunder Jolt' } });
      const earlier = lines.find(line => /Thunder Jolt/.test(line.text));
      expect(earlier?.isCurrent?.()).toBe(true);
      vi.advanceTimersByTime(1_800);
      snap = { ...snap, foeHp: 42 };
      session.onBattleStateChanged();
      session.onBattlePresentation({ kind: 'event', generation: 7, eventId: 2,
        event: { kind: 'effectiveness', on: 'b', multiplier: 2, label: "It's super effective!" } });
      expect(earlier?.isCurrent?.()).toBe(true);
      expect(lines.at(-1)?.isCurrent?.()).toBe(true);
      vi.advanceTimersByTime(3_201);
      expect(earlier?.isCurrent?.()).toBe(false);
      session.handleMessage(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 100 }));
      expect(lines.at(-1)?.isCurrent?.()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('revokes a free-play result if a touchscreen begins the next game', () => {
    let snap = activeBattle({ phase: 'results', generation: 4, winnerName: 'Ada', resultsPresented: true });
    const lines: { text: string; isCurrent?: () => boolean }[] = [];
    const { deps } = fakeDeps({ snapshot: () => snap, say: (text, isCurrent) => lines.push({ text, isCurrent }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    lines.length = 0;
    session.onBattlePresentation({ kind: 'results', generation: 4, result: { winner: 'a', winnerName: 'Ada' } });
    const result = lines.find(line => /wins/i.test(line.text));
    expect(result?.isCurrent?.()).toBe(true);
    snap = battleSnap({ phase: 'monster_select', generation: 5, myName: 'Ada' });
    session.onBattleStateChanged();
    expect(result?.isCurrent?.()).toBe(false);
    expect(lines.some(line => /choose your own monster/i.test(line.text))).toBe(true);
  });

  it('keeps a painted station result deliverable during room retirement', () => {
    const snap = activeBattle({ phase: 'results', generation: 4, winnerName: 'Ada', resultsPresented: true });
    const lines: { text: string; isCurrent?: () => boolean }[] = [];
    const { deps } = fakeDeps({ snapshot: () => snap, say: (text, isCurrent) => lines.push({ text, isCurrent }) });
    const session = new BattleVoiceSession(deps);
    session.setStationManaged(true);
    session.handleMessage(setup());
    lines.length = 0;
    session.onBattlePresentation({ kind: 'results', generation: 4, result: { winner: 'a', winnerName: 'Ada' } });
    const resultLine = lines.find(line => /results.*display.*thanks for playing/i.test(line.text));
    expect(resultLine).toBeDefined();
    session.handleReplaced();
    expect(resultLine?.isCurrent?.() ?? true).toBe(true);
  });

  it('waits for the spoken station result before retiring the call', async () => {
    const snap = activeBattle({ phase: 'results', generation: 4, winnerName: 'Ada', resultsPresented: true });
    let finishPlayback!: (played: boolean) => void;
    const playback = new Promise<boolean>(resolve => { finishPlayback = resolve; });
    const { deps } = fakeDeps({
      snapshot: () => snap,
      say: text => /Twilio Conversation Relay.*spoken moves/i.test(text) ? playback : undefined,
    });
    const session = new BattleVoiceSession(deps);
    session.setStationManaged(true);
    session.handleMessage(setup());
    session.onBattlePresentation({ kind: 'results', generation: 4, result: { winner: 'a', winnerName: 'Ada' } });

    let settled = false;
    const wait = session.whenSpeechSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishPlayback(true);
    await wait;
    expect(settled).toBe(true);
  });

  it('binds the caller to the room on setup + greets', () => {
    const { deps, log, said } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    expect(log.some(l => l.startsWith('join 4821'))).toBe(true);
    expect(said.length).toBeGreaterThan(0);   // greeting spoken
  });

  it('uses an authoritative station name without asking for it again', () => {
    const {deps,log,said}=fakeDeps({snapshot:()=>battleSnap({phase:'lobby',myName:'Ada'})});
    const session=new BattleVoiceSession(deps);session.setAuthoritativeName('Ada');session.handleMessage(setup());
    expect(log).toContain('join 4821 Ada');
    const arrival=said.join(' ').toLowerCase();
    expect(arrival).toContain('ada');
    expect(arrival).toContain('voice monsters');
    expect(arrival).toContain('attack');
    expect(arrival).toMatch(/say next.*choose monsters/i);
    expect(arrival).not.toContain('your name');
    session.handleMessage(prompt('call me Mallory'));
    expect(log).not.toContain('name Mallory');
  });

  it('keeps a station caller without a profile name in name capture', () => {
    let confirmedArg: boolean | undefined;
    let myName: string | null = null;
    let phase: BattleVoiceSnapshot['phase'] = 'lobby';
    const { deps, log, said } = fakeDeps({
      join: (_code, _name, _callSid, _side, _expected, confirmed) => {
        confirmedArg = confirmed;
        return { playerId: 'p1', resumed: false };
      },
      setName: (_code, _id, name) => { log.push(`name ${name}`); myName = name; },
      snapshot: () => battleSnap({ phase, myName }),
    });
    const session = new BattleVoiceSession(deps);
    session.setStationManaged(true);
    session.setStationAssignment(0, 1);
    session.handleMessage(setup());
    expect(confirmedArg).toBe(false);
    const beforeName = said.length;
    session.handleMessage(prompt('Ada'));
    expect(log).toContain('name Ada');
    expect(said.slice(beforeName).join(' ')).not.toMatch(/what'?s your name/i);
  });

  it('honors an externally confirmed name before interpreting the next monster choice', () => {
    let phase: BattleVoiceSnapshot['phase'] = 'lobby';
    let myName: string | null = null;
    const { deps, log } = fakeDeps({
      setName: (_code, _id, name) => { log.push(`name ${name}`); myName = name; },
      snapshot: () => battleSnap({ phase, myName }),
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    myName = 'Ada'; phase = 'monster_select';
    session.onBattleStateChanged();

    session.handleMessage(prompt('Sparkmouse'));

    expect(log).toContain('monster sparkmouse');
    expect(log).not.toContain('name Sparkmouse');
  });

  it('keeps a ready selection screen in place when the caller negates starting', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ myName: 'Ada', myMonsterId: 'sparkmouse', canStartBattle: true }),
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleMessage(prompt("don't fight yet"));
    expect(log).not.toContain('advance');
  });

  it('uses a legal semantic monster choice when the caller describes it naturally', async () => {
    const seen: unknown[] = [];
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ myName: 'Ada' }),
      interpret: async (request: unknown) => {
        seen.push(request);
        return { kind: 'action', actionId: 'select_monster', targetId: 'sparkmouse' };
      },
    } as unknown as Partial<BattleVoiceDeps>);
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleMessage(prompt('the tiny electric creature'));
    await Promise.resolve(); await Promise.resolve();

    expect(seen).toHaveLength(1);
    expect(log).toContain('monster sparkmouse');
  });

  it('does not reinterpret a delayed duplicate name as a monster selection', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      let myName: string | null = null;
      let phase: BattleVoiceSnapshot['phase'] = 'lobby';
      const { deps, log } = fakeDeps({
        setName: (_code, _id, name) => { log.push(`name ${name}`); myName = name; },
        snapshot: () => battleSnap({ phase, myName }),
      });
      const session = new BattleVoiceSession(deps);
      session.handleMessage(setup());
      session.handleMessage(prompt('Sparkmouse'));
      vi.advanceTimersByTime(3_000);
      session.handleMessage(prompt('Sparkmouse'));
      expect(log).toContain('name Sparkmouse');
      expect(log.some(entry => entry.startsWith('monster '))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('does not cancel an in-flight host response when Relay repeats the final frame', async () => {
    let resolveReply!: (value: string | null) => void;
    const { deps, said } = fakeDeps({
      snapshot: () => activeBattle(),
      converse: () => new Promise(resolve => { resolveReply = resolve; }),
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());said.length=0;
    session.handleMessage(prompt('tell me a joke'));
    session.handleMessage(prompt('tell me a joke'));
    resolveReply('Arena joke delivered.');
    await Promise.resolve();await Promise.resolve();
    expect(said).toContain('Arena joke delivered.');
  });

  it('gives lobby guidance when rematch is waiting on another caller name', () => {
    let phase:BattleVoiceSnapshot['phase']='results';
    const {deps,said}=fakeDeps({
      snapshot:()=>battleSnap({phase,myName:'Ada',winnerName:'Ada',canRematch:true}),
      advance:()=>{phase='lobby';return true;},
    });
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());said.length=0;
    session.handleMessage(prompt('rematch'));
    expect(said.join(' ')).toMatch(/say next or ready.*choose monsters/i);
    expect(said.join(' ')).not.toMatch(/pick your monster/i);
  });

  it('accepts a repeated choice when another caller caused the phase transition', () => {
    let phase: BattleVoiceSnapshot['phase'] = 'lobby';
    const { deps, log } = fakeDeps({ snapshot: () => battleSnap({ phase, myName: 'Ada' }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleMessage(prompt('Sparkmouse'));
    phase = 'monster_select';
    session.handleMessage(prompt('Sparkmouse'));
    expect(log).toContain('monster sparkmouse');
  });

  it('ignores a repeated setup frame on the same live session', () => {
    const { deps, log, said } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    said.length = 0;

    s.handleMessage(setup('4821'));

    expect(log.filter(l => l.startsWith('join 4821'))).toHaveLength(1);
    expect(said).toHaveLength(0);
  });

  it('resumes an existing battle without repeating name or monster onboarding', () => {
    const { deps, said } = fakeDeps({
      join: () => ({ playerId: 'p1', resumed: true }),
      snapshot: () => battleSnap({
        phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Shellback', foeMonsterType: 'water', myHp: 51, myMaxHp: 70, foeHp: 62, foeMaxHp: 82,
        turn: 3, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
      }),
    });
    const s = new BattleVoiceSession(deps);

    s.handleMessage(setup('4821'));

    const speech = said.join(' ');
    expect(speech).toMatch(/back in the battle/i);
    expect(speech).toMatch(/your turn/i);
    expect(speech).not.toMatch(/what'?s your name|pick a monster/i);
  });

  it('welcomes a late result-screen caller without restarting name onboarding', () => {
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'results', myName: null, myMonsterId: null, myMonsterName: null, winnerName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    expect(said.join(' ')).toMatch(/battle just ended|next round/i);
    expect(said.join(' ')).not.toMatch(/what'?s your name/i);
    expect(said.join(' ')).not.toMatch(/pick a monster/i);
  });

  it('allows a waiting caller to request the next round once the finished player leaves', async () => {
    let phase: BattleVoiceSnapshot['phase'] = 'results';
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ phase, participating: false, myName: null, myMonsterId: null,
        myMonsterName: null, winnerName: 'Ada', resultsPresented: true, canRematch: phase === 'results' }),
      advance: () => { log.push('advance'); phase = 'lobby'; return true; },
      interpret: async request => {
        expect(request.actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'rematch' })]));
        return { kind: 'action', actionId: 'rematch' };
      },
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    expect(said.join(' ')).not.toMatch(/what'?s your name/i);
    session.handleMessage(prompt('Could we have another go now?'));
    await vi.waitFor(() => expect(log).toContain('advance'));
  });

  it('queues a late caller behind an active battle instead of pretending they are fighting', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'battle', participating: false, myName: null, myMonsterId: null, myMonsterName: null, whoseTurn: null }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    expect(said.join(' ')).toMatch(/battle is already in progress|next round/i);

    said.length = 0;
    s.handleMessage(prompt('Bo'));
    expect(log).not.toContain('name Bo');
    s.handleMessage(prompt('fight'));
    expect(log.some(l => l.startsWith('action '))).toBe(false);
    expect(said.join(' ')).toMatch(/current battle.*in progress|next round/i);
    said.length=0;
    s.onBattleEvent({kind:'move_used',by:'a',moveId:'sparkmouse.jolt',moveName:'Thunder Jolt'});
    s.onBattleStateChanged();
    expect(said).toHaveLength(0);
  });

  it('tells a caller when the battle room is full or already in progress', () => {
    const { deps, said } = fakeDeps({ join: () => null });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    expect(s.boundPlayer).toBeNull();
    expect(said.some(t => /full|in progress|next round/i.test(t))).toBe(true);
  });

  it('greets new callers with Conversation Relay and simple voice-control instructions', () => {
    const { deps, said } = fakeDeps({ snapshot: () => battleSnap({ phase: 'lobby' }) });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    expect(said).toHaveLength(3);
    expect(said[0]).toMatch(/welcome to voice monsters/i);
    expect(said[1]).toMatch(/conversation relay/i);
    expect(said[2]).toMatch(/what.*name/i);
    s.handleMessage(prompt("I'm Ada"));
    expect(said.slice(3).join(' ')).toMatch(/nice to meet.*before you start.*say attack.*say next.*choose monsters/i);
  });

  it('captures the caller name in the lobby BEFORE anything else (deterministic, no LLM)', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'lobby' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    said.length = 0;
    s.handleMessage(prompt("I'm Ada"));
    expect(log.some(l => l === 'name Ada')).toBe(true);          // name was set
    expect(said.some(t => /nice to meet you, ada/i.test(t))).toBe(true);   // confirmed + guided
  });

  it('does not capture a lobby advance phrase as the caller name', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'lobby', myName: null }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt("I'm ready"));

    expect(log).not.toContain('advance');
    expect(log.some(l => l === 'name Ready')).toBe(false);
  });

  it('a spoken monster name during select picks it (deterministic, no LLM)', () => {
    // A name is already set, so "Embertail" is treated as a monster pick, not a name.
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ myName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('Embertail'));
    expect(log.some(l => l === 'monster embertail')).toBe(true);
    expect(said.some(line=>/Locked in.*Embertail/i.test(line))).toBe(true);
  });

  it('understands ordinal monster picks before cardinal words', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ myName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('the second one'));

    expect(log).toContain('monster embertail');
  });

  it('keeps a polite monster choice on the fast voice path', () => {
    const { deps, log } = fakeDeps({ snapshot: () => battleSnap({ myName: 'Ada' }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleMessage(prompt("I'd like Embertail"));
    expect(log).toContain('monster embertail');
  });

  it('treats a spoken monster name as a selection after the screen leaves the lobby', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ myName: 'Ada', nameConfirmed: true }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('Sparkmouse'));

    expect(log).toContain('monster sparkmouse');
    expect(log.some(l => l === 'name Sparkmouse')).toBe(false);
  });

  it('does not treat a descriptive monster phrase as option one or as the caller name', async () => {
    const { deps, log, said } = fakeDeps({ snapshot: () => battleSnap({ myName: 'Ada', nameConfirmed: true }) });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    said.length = 0;

    s.handleMessage(prompt('the fire one'));
    await Promise.resolve();

    expect(log.some(l => l.startsWith('monster '))).toBe(false);
    expect(log.some(l => l.startsWith('name '))).toBe(false);
    expect(said.join(' ')).toMatch(/choose your own monster/i);
    expect(said.join(' ')).not.toMatch(/what.*name|name.*challenger/i);
  });

  it.each(['not Sparkmouse', 'Sparkmouse or Embertail', 'no, not that monster'])
    ('routes an unsafe monster choice to semantic clarification: %s',async spoken=>{
      const requests:string[]=[];
      const {deps,log}=fakeDeps({snapshot:()=>battleSnap({myName:'Ada'}),
        interpret:async request=>{requests.push(request.transcript);return {kind:'clarify',reason:'ambiguous'};}});
      const session=new BattleVoiceSession(deps);session.handleMessage(setup());
      session.handleMessage(prompt(spoken));await Promise.resolve();
      expect(log.some(entry=>entry.startsWith('monster '))).toBe(false);
      expect(requests).toEqual([spoken]);
    });

  it.each(['Tell me about monster 2', 'I have 2 questions', 'Sparkmouse looks strong',
    'Compare Sparkmouse with Embertail', 'Me fale do monstro 2'])
    ('does not lock a monster while the caller is discussing a choice: %s', async spoken => {
      const requests: string[] = [];
      const { deps, log } = fakeDeps({ snapshot: () => battleSnap({ myName: 'Ada' }),
        interpret: async request => { requests.push(request.transcript); return { kind: 'none' }; } });
      const session = new BattleVoiceSession(deps);
      session.handleMessage(setup('4821', spoken.startsWith('Me ') ? 'pt-BR' : undefined));
      session.handleMessage(prompt(spoken));
      await Promise.resolve();
      expect(log.some(entry => entry.startsWith('monster '))).toBe(false);
      expect(requests).toEqual([spoken]);
    });

  it('offers current health and potions as facts for conversational questions', async () => {
    const requests: Parameters<NonNullable<BattleVoiceDeps['interpret']>>[0][] = [];
    const { deps } = fakeDeps({ snapshot: () => activeBattle({ myHp: 38, foeHp: 52, myPotions: 1 }),
      interpret: async request => { requests.push(request); return { kind: 'none' }; } });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleMessage(prompt('How much health do I have'));
    await Promise.resolve();
    expect(requests[0]?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'health', text: expect.stringContaining('38 of 70') }),
      expect.objectContaining({ id: 'potions', text: expect.stringContaining('1 potion') }),
    ]));
  });

  it.each([
    {locale:undefined,spoken:'Sparkmouse or Embertail',expected:/which monster/i},
    {locale:'pt-BR',spoken:'Sparkmouse ou Embertail',expected:/qual monstro/i},
  ])('asks a short localized question about an ambiguous monster choice: $locale',async ({locale,spoken,expected})=>{
    const {deps,said}=fakeDeps({snapshot:()=>battleSnap({myName:'Ada'}),
      interpret:async()=>({kind:'clarify',reason:'ambiguous'})});
    const session=new BattleVoiceSession(deps);session.handleMessage(setup('4821',locale));said.length=0;
    session.handleMessage(prompt(spoken));await Promise.resolve();
    expect(said.join(' ')).toMatch(expected);
    expect(said.join(' ')).not.toMatch(/on your turn|na sua vez/i);
  });

  it('gives one short reply to unrelated speech without replaying the whole menu',async()=>{
    const {deps,said}=fakeDeps({snapshot:()=>battleSnap({myName:'Ada'}),
      interpret:async()=>({kind:'none'})});
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());said.length=0;
    session.handleMessage(prompt('I had lunch'));await Promise.resolve();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/tell me what you want|what would you like/i);
    session.handleMessage(prompt('I had dinner'));await Promise.resolve();
    expect(said).toHaveLength(2);
    expect(said.join(' ')).not.toMatch(/after everyone chooses|on your turn/i);
  });

  it.each([
    { label: 'English named lobby', locale: undefined, snap: battleSnap({ phase: 'lobby', myName: 'Ada' }), utterance: 'what now?', expected: /say next.*choose monsters/i },
    { label: 'Portuguese unnamed lobby', locale: 'pt-BR', snap: battleSnap({ phase: 'lobby', myName: null }), utterance: 'o que devo fazer agora?', expected: /primeiro nome.*Ana/i },
    { label: 'English monster select', locale: undefined, snap: battleSnap({ myName: 'Ada' }), utterance: 'the fiery-looking one', expected: /own monster.*name or number/i },
    { label: 'Portuguese monster select', locale: 'pt-BR', snap: battleSnap({ myName: 'Ada' }), utterance: 'quero o monstro de fogo', expected: /próprio monstro.*nome ou número/i },
    { label: 'English battle root', locale: undefined, snap: activeBattle(), utterance: 'something else', expected: /attack.*guard.*item.*taunt/i },
    { label: 'Portuguese fight menu', locale: 'pt-BR', snap: activeBattle({ activeMenu: 'fight' }), utterance: 'não sei qual', expected: /seus golpes.*Thunder Jolt.*Static Zap/i },
  ])('uses a phase-correct scripted reprompt without an LLM: $label', async ({ locale, snap, utterance, expected }) => {
    const { deps, said } = fakeDeps({ snapshot: () => snap });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup('4821', locale));
    said.length = 0;

    session.handleMessage(prompt(utterance));
    await Promise.resolve();

    expect(said.join(' ')).toMatch(expected);
  });

  it('uses the same scripted reprompt when the LLM fails', async () => {
    const { deps, said } = fakeDeps({
      snapshot: () => activeBattle(),
      converse: async () => { throw new Error('offline'); },
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    said.length = 0;

    session.handleMessage(prompt('not a command'));
    await Promise.resolve();
    await Promise.resolve();

    expect(said.join(' ')).toMatch(/attack.*guard.*item.*taunt/i);
  });

  it('never sends unknown setup speech to the conversational host',async()=>{
    let calls=0;const{deps,said}=fakeDeps({
      snapshot:()=>battleSnap({phase:'monster_select',myName:'Ada'}),
      converse:async()=>{calls++;return 'off-topic reply';},
    });
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());said.length=0;
    session.handleMessage(prompt('I have two dogs'));
    await Promise.resolve();
    expect(calls).toBe(0);
    expect(said.join(' ')).toMatch(/own monster.*name or number/i);
  });

  it('does not reprompt after an LLM tool changed the battle state', async () => {
    let snap = activeBattle();
    const { deps, said } = fakeDeps({
      snapshot: () => snap,
      converse: async () => {
        snap = { ...snap, turn: 1, activeSide: 'b', whoseTurn: 'foe' };
        return null;
      },
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    said.length = 0;

    session.handleMessage(prompt('make a tactical choice'));
    await Promise.resolve();

    expect(said).toHaveLength(0);
  });

  it('uses selection DTMF digits to choose monsters in either locale', () => {
    for (const locale of [undefined, 'pt-BR']) {
      const { deps, log } = fakeDeps({ snapshot: () => battleSnap({ myName: 'Ada' }) });
      const session = new BattleVoiceSession(deps);
      session.handleMessage(setup('4821', locale));

      session.handleMessage(dtmf('2'));

      expect(log).toContain('monster embertail');
    }
  });

  it.each([
    ['1', 'openFight'],
    ['2', '"kind":"guard"'],
    ['3', '"kind":"item"'],
    ['4', '"kind":"taunt"'],
  ])('maps root DTMF %s to its battle action', (digit, expectedLog) => {
    const { deps, log } = fakeDeps({ snapshot: () => activeBattle() });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());

    session.handleMessage(dtmf(digit));

    expect(log.some(entry => entry.includes(expectedLog))).toBe(true);
  });

  it.each([
    ['1', 'sparkmouse.jolt'],
    ['2', 'sparkmouse.zap'],
    ['3', 'sparkmouse.bite'],
    ['4', 'sparkmouse.tackle'],
  ])('maps fight-menu DTMF %s to move %s', (digit, moveId) => {
    const { deps, log } = fakeDeps({ snapshot: () => activeBattle({ activeMenu: 'fight' }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());

    session.handleMessage(dtmf(digit));

    expect(log.some(entry => entry.includes(`"moveId":"${moveId}"`))).toBe(true);
  });

  it('uses DTMF 0 to back out of the fight menu', () => {
    const { deps, log } = fakeDeps({ snapshot: () => activeBattle({ activeMenu: 'fight' }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup('4821', 'pt-BR'));

    session.handleMessage(dtmf('0'));

    expect(log).toContain('backMenu');
  });

  it.each([
    { locale: undefined, item: 'potion', expected: /no potions remain/i },
    { locale: 'pt-BR', item: 'poção', expected: /não restam poções/i },
  ])('explicitly reports no remaining potions in $locale', ({ locale, item, expected }) => {
    const { deps, log, said } = fakeDeps({ snapshot: () => activeBattle({ myPotions: 0 }) });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup('4821', locale));
    said.length = 0;

    session.handleMessage(prompt(item));
    session.handleMessage(dtmf('3'));

    expect(log.some(entry => entry.includes('"kind":"item"'))).toBe(false);
    expect(said).toHaveLength(2);
    expect(said.join(' ')).toMatch(expected);
  });

  it('"start" explicitly advances a ready lobby', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'lobby', monsterNames: ['Sparkmouse'], myName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('start'));
    expect(log.filter(l => l === 'advance')).toHaveLength(1);
  });

  it('tells a ready caller which player the shared lobby is waiting for', () => {
    let snap = battleSnap({ phase: 'lobby', myName: 'Ada', foeName: 'Bo', setupPlayerCount: 2, mySetupReady: false });
    const { deps, log, said } = fakeDeps({ snapshot: () => snap });
    deps.advance = () => { log.push('advance'); snap = { ...snap, mySetupReady: true }; return true; };
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;
    session.handleMessage(prompt('ready'));

    expect(log).toContain('advance');
    expect(snap.phase).toBe('lobby');
    expect(said.join(' ')).toMatch(/waiting for Bo.*ready/i);
    expect(said.join(' ')).not.toMatch(/off to monster select/i);
  });

  it('accepts a named caller’s ready while the second shared seat is still open', () => {
    let snap = battleSnap({ phase: 'lobby', myName: 'Ada', nameConfirmed: true,
      foeName: null, canAdvanceLobby: false, setupPlayerCount: 2, mySetupReady: false });
    const { deps, log, said } = fakeDeps({ snapshot: () => snap });
    deps.advance = () => { log.push('advance'); snap = { ...snap, mySetupReady: true }; return true; };
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;
    session.handleMessage(prompt('ready'));
    expect(log).toContain('advance');
    expect(snap.phase).toBe('lobby');
    expect(said.join(' ')).toMatch(/waiting for the other player.*ready/i);
  });

  it('holds a caller on monster selection after their battle confirmation until the other caller is ready', () => {
    let snap = battleSnap({ phase: 'monster_select', myName: 'Ada', foeName: 'Bo',
      myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', canStartBattle: true,
      setupPlayerCount: 2, mySetupReady: false });
    const { deps, log, said } = fakeDeps({ snapshot: () => snap });
    deps.advance = () => { log.push('advance'); snap = { ...snap, mySetupReady: true }; return true; };
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;
    session.handleMessage(prompt('battle'));

    expect(log).toContain('advance');
    expect(snap.phase).toBe('monster_select');
    expect(said.join(' ')).toMatch(/waiting for Bo.*battle/i);
  });

  it('accepts battle confirmation before the second caller picks their monster', () => {
    let snap = battleSnap({ phase: 'monster_select', myName: 'Ada', nameConfirmed: true,
      foeName: 'Bo', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse',
      canStartBattle: false, setupPlayerCount: 2, mySetupReady: false });
    const { deps, log, said } = fakeDeps({ snapshot: () => snap });
    deps.advance = () => { log.push('advance'); snap = { ...snap, mySetupReady: true }; return true; };
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;
    session.handleMessage(prompt('battle'));
    expect(log).toContain('advance');
    expect(snap.phase).toBe('monster_select');
    expect(said.join(' ')).toMatch(/waiting for Bo.*battle/i);
  });

  it('keeps the result visible until the other caller requests a rematch', () => {
    let snap = battleSnap({ phase: 'results', myName: 'Ada', nameConfirmed: true,
      foeName: 'Bo', resultsPresented: true, canRematch: true, setupPlayerCount: 2,
      mySetupReady: false, winnerName: 'Ada' });
    const { deps, log, said } = fakeDeps({ snapshot: () => snap });
    deps.advance = () => { log.push('advance'); snap = { ...snap, mySetupReady: true }; return true; };
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;
    session.handleMessage(prompt('rematch'));
    expect(log).toContain('advance');
    expect(snap.phase).toBe('results');
    expect(said.join(' ')).toMatch(/waiting for Bo.*rematch/i);
    said.length = 0;
    session.handleMessage(prompt('what now'));
    expect(said.join(' ')).toMatch(/waiting for Bo.*rematch/i);
  });

  it('names the current replacement caller in replay guidance', () => {
    let snap = battleSnap({ phase: 'results', myName: 'Ada', nameConfirmed: true,
      foeName: 'Bo', currentOtherCallerName: 'Cy', currentCallerCount: 2,
      resultsPresented: true, canRematch: true, setupPlayerCount: 2, winnerName: 'Ada' });
    const { deps, said } = fakeDeps({ snapshot: () => snap });
    deps.advance = () => { snap = { ...snap, mySetupReady: true }; return true; };
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;
    session.handleMessage(prompt('rematch'));
    expect(said.join(' ')).toMatch(/waiting for Cy.*rematch/i);
  });

  it('tells a lone duel survivor the rematch menu opens after the phone cue', () => {
    let snap = battleSnap({ phase: 'results', myName: 'Ada', nameConfirmed: true,
      foeName: 'Bo', currentCallerCount: 1, currentOtherCallerName: null,
      resultsPresented: true, canRematch: true, setupPlayerCount: 2, winnerName: 'Ada' });
    const { deps, said } = fakeDeps({ snapshot: () => snap });
    deps.advance = () => { snap = { ...snap, mySetupReady: true }; return true; };
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;
    session.handleMessage(prompt('rematch'));
    expect(said.join(' ')).toMatch(/monster menu will open after this message/i);
    expect(said.join(' ')).not.toMatch(/waiting for Bo/i);
  });

  it('waits for the last caller’s Relay response before opening the shared monster menu', async () => {
    const room = new BattleRoom('4821', 42);
    room.expectHumanPlayers(2);
    const ada = room.addPlayer('Ada', 'a') as { playerId: string };
    const bo = room.addPlayer('Bo', 'b') as { playerId: string };
    let settleBoReady!: (outcome: 'played' | 'interrupted') => void;
    let holdBoReady = true;
    const boReady = new Promise<'played' | 'interrupted'>(resolve => { settleBoReady = resolve; });
    const caller = (playerId: string, name: string) => {
      const { deps } = fakeDeps({
        join: () => ({ playerId, resumed: false }),
        advance: (_code, id) => room.advance(id),
        beginMenuSpeech: (_code, id, phase) => room.beginVoiceMenuSpeech(id, phase),
        snapshot: () => battleSnap({
          phase: room.phase, myName: name, nameConfirmed: true,
          foeName: name === 'Ada' ? 'Bo' : 'Ada', setupPlayerCount: room.expectedPlayerCount,
          mySetupReady: room.isSetupReady(playerId), canAdvanceLobby: room.canAdvanceLobby,
          canStartBattle: room.canStart(), canRematch: room.canStartNextRound(playerId),
        }),
        say: text => {
          if (name === 'Bo' && holdBoReady && /^You are ready\./.test(text)) {
            holdBoReady = false;
            return boReady;
          }
          return Promise.resolve('played' as const);
        },
      });
      const session = new BattleVoiceSession(deps);
      session.handleMessage(setup());
      return session;
    };
    const adaCall = caller(ada.playerId, 'Ada');
    const boCall = caller(bo.playerId, 'Bo');
    await vi.waitFor(() => expect(room.lobbyPlayers().every(player => !player.phonePending)).toBe(true));
    adaCall.handleMessage(prompt('ready'));
    await vi.waitFor(() => expect(room.lobbyPlayers().find(player => player.playerId === ada.playerId)?.phonePending).toBe(false));
    boCall.handleMessage(prompt('ready'));
    expect(room.phase).toBe('lobby');
    expect(room.isSetupReady(ada.playerId)).toBe(true);
    expect(room.isSetupReady(bo.playerId)).toBe(true);
    expect(room.lobbyPlayers().find(player => player.playerId === bo.playerId)?.phonePending).toBe(true);

    settleBoReady('interrupted');
    await vi.waitFor(() => expect(room.lobbyPlayers().find(player => player.playerId === bo.playerId)?.phonePending).toBe(true));
    expect(room.phase).toBe('lobby');
    boCall.handleMessage(prompt('what now'));
    await vi.waitFor(() => expect(room.phase).toBe('monster_select'));
  });

  it('keeps the lobby visible while an already-ready caller awaits AI interpretation', async () => {
    const room = new BattleRoom('4821', 43);
    room.expectHumanPlayers(2);
    const ada = room.addPlayer('Ada', 'a') as { playerId: string };
    const bo = room.addPlayer('Bo', 'b') as { playerId: string };
    let settleInterpret!: (value: VoiceInterpretResult) => void;
    const interpreting = new Promise<VoiceInterpretResult>(resolve => { settleInterpret = resolve; });
    const caller = (playerId: string, name: string, interpret?: BattleVoiceDeps['interpret']) => {
      const { deps } = fakeDeps({
        join: () => ({ playerId, resumed: false }),
        advance: (_code, id) => room.advance(id),
        beginMenuSpeech: (_code, id, phase) => room.beginVoiceMenuSpeech(id, phase),
        snapshot: () => battleSnap({
          phase: room.phase, myName: name, nameConfirmed: true,
          foeName: name === 'Ada' ? 'Bo' : 'Ada', setupPlayerCount: room.expectedPlayerCount,
          mySetupReady: room.isSetupReady(playerId), canAdvanceLobby: room.canAdvanceLobby,
          canStartBattle: room.canStart(), canRematch: room.canStartNextRound(playerId),
        }),
        say: () => Promise.resolve('played' as const),
        ...(interpret ? { interpret } : {}),
      });
      const session = new BattleVoiceSession(deps);
      session.handleMessage(setup());
      return session;
    };
    const adaCall = caller(ada.playerId, 'Ada');
    const boCall = caller(bo.playerId, 'Bo', () => interpreting);
    await vi.waitFor(() => expect(room.lobbyPlayers().every(player => !player.phonePending)).toBe(true));
    boCall.handleMessage(prompt('ready'));
    await vi.waitFor(() => expect(room.lobbyPlayers().find(player => player.playerId === bo.playerId)?.phonePending).toBe(false));
    boCall.handleMessage(prompt('tell me a story'));
    expect(room.lobbyPlayers().find(player => player.playerId === bo.playerId)?.phonePending).toBe(true);
    adaCall.handleMessage(prompt('ready'));
    await vi.waitFor(() => expect(room.lobbyPlayers().find(player => player.playerId === ada.playerId)?.phonePending).toBe(false));
    expect(room.phase).toBe('lobby');
    settleInterpret({ kind: 'clarify', reason: 'unsupported' });
    await vi.waitFor(() => expect(room.phase).toBe('monster_select'));
  });

  it('keeps the shared menu visible while a ready caller is still speaking', async () => {
    const room = new BattleRoom('4821', 44);
    room.expectHumanPlayers(2);
    const ada = room.addPlayer('Ada', 'a') as { playerId: string };
    const bo = room.addPlayer('Bo', 'b') as { playerId: string };
    const { deps } = fakeDeps({
      join: () => ({ playerId: ada.playerId, resumed: false }),
      advance: (_code, id) => room.advance(id),
      beginMenuSpeech: (_code, id, phase) => room.beginVoiceMenuSpeech(id, phase),
      snapshot: () => battleSnap({ phase: room.phase, myName: 'Ada', nameConfirmed: true,
        foeName: 'Bo', currentCallerCount: 2, currentOtherCallerName: 'Bo', setupPlayerCount: 2,
        mySetupReady: room.isSetupReady(ada.playerId), canAdvanceLobby: room.canAdvanceLobby,
        canStartBattle: room.canStart() }),
      say: () => Promise.resolve('played' as const),
    });
    const adaCall = new BattleVoiceSession(deps);
    adaCall.handleMessage(setup());
    await vi.waitFor(() => expect(room.lobbyPlayers().find(player => player.playerId === ada.playerId)?.phonePending).toBe(false));
    const finishBo = room.beginVoiceMenuSpeech(bo.playerId, 'lobby')!;
    expect(room.advance(bo.playerId)).toBe(true);
    adaCall.handleMessage(prompt('ready'));
    await vi.waitFor(() => expect(room.lobbyPlayers().find(player => player.playerId === ada.playerId)?.phonePending).toBe(false));
    adaCall.handleMessage(prompt('I have a question', false));
    expect(room.lobbyPlayers().find(player => player.playerId === ada.playerId)?.phonePending).toBe(true);
    finishBo(true);
    expect(room.phase).toBe('lobby');
    adaCall.handleMessage(prompt('what now'));
    await vi.waitFor(() => expect(room.phase).toBe('monster_select'));
  });

  it('clears a disconnected caller’s setup confirmation before the other phone can advance', () => {
    let snap = battleSnap({ phase: 'lobby', myName: 'Ada', mySetupReady: true, setupPlayerCount: 2 });
    const { deps, log } = fakeDeps({ snapshot: () => snap,
      clearSetupReady: () => { log.push('clearReady'); snap = { ...snap, mySetupReady: false }; return true; } });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleClose();
    expect(log).toContain('clearReady');
    expect(snap.mySetupReady).toBe(false);
  });

  it('tells the remaining caller to reconfirm when the shared selection changes', () => {
    let snap = battleSnap({ phase: 'monster_select', myName: 'Ada', nameConfirmed: true,
      myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', foeName: 'Bo',
      canStartBattle: true, setupPlayerCount: 2, mySetupReady: true });
    const { deps, said } = fakeDeps({ snapshot: () => snap });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;
    snap = { ...snap, foeName: null, canStartBattle: false, mySetupReady: false };
    session.onBattleStateChanged();
    expect(said.join(' ')).toMatch(/Sparkmouse.*say battle again/i);
  });

  it('requires a resumed caller to confirm the current shared menu again', () => {
    let snap = battleSnap({ phase: 'monster_select', myName: 'Ada', myMonsterId: 'sparkmouse',
      myMonsterName: 'Sparkmouse', mySetupReady: true, setupPlayerCount: 2 });
    const { deps, log } = fakeDeps({ snapshot: () => snap,
      join: () => ({ playerId: 'p1', resumed: true }),
      clearSetupReady: () => { log.push('clearReady'); snap = { ...snap, mySetupReady: false }; return true; } });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    expect(log).toContain('clearReady');
    expect(snap.mySetupReady).toBe(false);
  });

  it('asks a late caller for their name before accepting a monster choice', () => {
    let snap = battleSnap({ phase: 'monster_select', myName: null, nameConfirmed: false,
      monsterNames: ['Sparkmouse', 'Embertail'], canStartBattle: false, setupPlayerCount: 2 });
    const { deps, log, said } = fakeDeps({ snapshot: () => snap,
      setName: (_code, _id, name) => { log.push(`name ${name}`); snap = { ...snap, myName: name, nameConfirmed: true }; } });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    expect(said.join(' ')).toMatch(/what.s your name/i);
    said.length = 0;
    session.handleMessage(prompt('Sparkmouse'));
    expect(log.some(entry => entry.startsWith('monster '))).toBe(false);
    expect(log.some(entry => entry.startsWith('name '))).toBe(false);
    session.handleMessage(prompt('Bo'));
    expect(log).toContain('name Bo');
  });

  it('keeps a lobby gated while expected players are missing', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'lobby', monsterNames: ['Sparkmouse'], myName: 'Ada', canAdvanceLobby: false }),
    });
    const s = new BattleVoiceSession(deps);s.handleMessage(setup());said.length=0;
    s.handleMessage(prompt('next'));
    expect(log).not.toContain('advance');
    expect(said.join(' ')).toMatch(/say next or ready.*choose monsters/i);
  });

  it('"battle" in monster-select is REFUSED until a monster is picked (no LLM)', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({ monsterNames: ['Sparkmouse'], myName: 'Ada' }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.handleMessage(prompt('battle'));
    expect(log.some(l => l === 'advance')).toBe(false);      // did NOT advance
    expect(said.some(t => /pick a monster first/i.test(t))).toBe(true);
  });

  it('"battle" in monster-select waits when this caller picked but the other player has not', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        canStartBattle: false,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.handleMessage(prompt('battle'));

    expect(log.some(l => l === 'advance')).toBe(false);
    expect(said.some(t => /say battle to confirm.*wait for the other player/i.test(t))).toBe(true);
  });

  it('"battle" in monster-select advances when picks are complete', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        canStartBattle: true,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('battle'));

    expect(log.filter(l => l === 'advance')).toHaveLength(1);
  });

  it('"fight" in monster-select advances when picks are complete', () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        canStartBattle: true,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());

    s.handleMessage(prompt('fight'));

    expect(log.filter(l => l === 'advance')).toHaveLength(1);
  });

  it('a spoken battle action during battle commits it', async () => {
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', monsterNames: ['Sparkmouse'],
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Galecoil', foeMonsterType: 'water', myHp: 40, myMaxHp: 70, foeHp: 55, foeMaxHp: 98,
        myPotions: 2, turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
        myMoves: [{ id: 'sparkmouse.jolt', name: 'Thunder Jolt' }, { id: 'sparkmouse.zap', name: 'Static Zap' }],
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('guard'));
    expect(log.some(l => l.includes('"kind":"guard"'))).toBe(true);
  });

  it('on the first turn, speaks a dramatic X-vs-Y intro + how-to-act recap', () => {
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', monsterNames: ['Sparkmouse'],
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Galecoil', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 98, foeMaxHp: 98,
        myPotions: 2, turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.onBattleEvent({ kind: 'turn_start', turn: 1 });
    expect(said.some(t => t.includes('Sparkmouse') && t.includes('Galecoil'))).toBe(true);   // X vs Y
    expect(said.some(t => /attack/i.test(t) && /guard|item|taunt/i.test(t))).toBe(true);        // how-to recap
  });

  it('on battle state start, tells the active caller they go first and includes the type matchup', () => {
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Shellback', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 82, foeMaxHp: 82,
        turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.onBattleStateChanged();

    expect(said.some(t => /sparkmouse.*shellback/i.test(t) && /electric.*water/i.test(t))).toBe(true);
    expect(said.some(t => /you go first|your turn/i.test(t))).toBe(true);
    expect(said.filter(t => /attack/i.test(t) && /guard|item|taunt/i.test(t))).toHaveLength(1);
  });

  it('on battle state start, tells the waiting caller the other monster goes first', () => {
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', mySide: 'b', myName: 'Bo', myMonsterId: 'shellback', myMonsterName: 'Shellback', myMonsterType: 'water',
        foeMonsterName: 'Sparkmouse', foeMonsterType: 'electric', myHp: 82, myMaxHp: 82, foeHp: 70, foeMaxHp: 70,
        turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'foe',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.onBattleStateChanged();

    expect(said.some(t => /sparkmouse goes first|wait for sparkmouse/i.test(t))).toBe(true);
    expect(said.filter(t => /attack/i.test(t) && /guard|item|taunt/i.test(t))).toHaveLength(0);
  });

  it('saying FIGHT on your turn opens the server-synced fight menu and reads the four moves', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Shellback', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 82, foeMaxHp: 82,
        turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
        myMoves: [
          { id: 'sparkmouse.jolt', name: 'Thunder Jolt' },
          { id: 'sparkmouse.zap', name: 'Static Zap' },
          { id: 'sparkmouse.bite', name: 'Quick Bite' },
          { id: 'sparkmouse.tackle', name: 'Tackle' },
        ],
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.handleMessage(prompt('fight'));

    expect(log).toContain('openFight');
    expect(said.some(t => /thunder jolt/i.test(t) && /static zap/i.test(t))).toBe(true);
  });

  it('deduplicates a repeated final fight frame after the menu opens', () => {
    let menu: 'root' | 'fight' = 'root';
    const moves = [
      { id: 'sparkmouse.jolt', name: 'Thunder Jolt' },
      { id: 'sparkmouse.zap', name: 'Static Zap' },
    ];
    const { deps, log, said } = fakeDeps({ snapshot: () => battleSnap({
      phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', turn: 0,
      activeSide: 'a', activeMenu: menu, whoseTurn: 'me', myMoves: moves,
    }) });
    deps.openFight = () => { log.push('openFight'); menu = 'fight'; };
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;
    session.handleMessage(prompt('fight'));
    session.handleMessage(prompt('fight'));
    expect(log.filter(entry => entry === 'openFight')).toHaveLength(1);
    // The repeated final may have preempted the first options token, so re-send the choices.
    expect(said.filter(text => /thunder jolt/i.test(text))).toHaveLength(2);
  });

  it('lets fight start the battle and immediately open moves in the new phase', () => {
    let snap=battleSnap({myName:'Ada',myMonsterId:'sparkmouse',myMonsterName:'Sparkmouse',canStartBattle:true});
    const {deps,log,said}=fakeDeps({snapshot:()=>snap});
    deps.advance=()=>{log.push('advance');snap=activeBattle();return true;};
    deps.openFight=()=>{log.push('openFight');snap={...snap,activeMenu:'fight'};};
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());said.length=0;
    session.handleMessage(prompt('fight'));
    session.handleMessage(prompt('fight'));
    expect(log).toEqual(expect.arrayContaining(['advance','openFight']));
    expect(said.join(' ')).toMatch(/Thunder Jolt.*Static Zap/i);
  });

  it('accepts the same number as a new utterance after it opens the fight menu', () => {
    let snap=activeBattle();
    const {deps,log}=fakeDeps({snapshot:()=>snap});
    deps.openFight=()=>{log.push('openFight');snap={...snap,activeMenu:'fight'};};
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());
    session.handleMessage(prompt('one'));
    session.handleMessage(prompt('one',false));
    session.handleMessage(prompt('one'));
    expect(log.filter(entry=>entry==='openFight')).toHaveLength(1);
    expect(log.some(entry=>entry.includes('sparkmouse.jolt'))).toBe(true);
  });

  it('accepts a deliberately repeated number after the short duplicate-frame window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      let menu: 'root' | 'fight' = 'root';
      const moves = [{ id: 'sparkmouse.jolt', name: 'Thunder Jolt' }];
      const { deps, log } = fakeDeps({ snapshot: () => activeBattle({ activeMenu: menu, myMoves: moves }) });
      deps.openFight = () => { log.push('openFight'); menu = 'fight'; };
      const session = new BattleVoiceSession(deps);
      session.handleMessage(setup());
      session.handleMessage(prompt('one'));
      vi.advanceTimersByTime(3_000);
      session.handleMessage(prompt('one'));
      expect(log.filter(entry => entry === 'openFight')).toHaveLength(1);
      expect(log.some(entry => entry.includes('sparkmouse.jolt'))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('ignores interim fight guesses and applies the corrected final root action', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse',
        turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
        myMoves: [
          { id: 'sparkmouse.jolt', name: 'Thunder Jolt' },
          { id: 'sparkmouse.zap', name: 'Static Zap' },
        ],
      }),
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup()); said.length = 0;

    session.handleMessage(prompt('fight', false));
    session.handleMessage(prompt('fight', false));
    session.handleMessage(prompt('two', true));

    expect(log).not.toContain('openFight');
    expect(log.some(entry => entry.includes('"kind":"guard"'))).toBe(true);
    expect(said.filter(text => /thunder jolt/i.test(text) && /static zap/i.test(text))).toHaveLength(0);
  });

  it('refuses an out-of-turn battle command with a wait cue instead of committing it', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', mySide: 'b', myName: 'Bo', myMonsterId: 'shellback', myMonsterName: 'Shellback', myMonsterType: 'water',
        foeMonsterName: 'Sparkmouse', foeMonsterType: 'electric', myHp: 82, myMaxHp: 82, foeHp: 70, foeMaxHp: 70,
        turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'foe',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.handleMessage(prompt('guard'));

    expect(log.some(l => l.startsWith('action '))).toBe(false);
    expect(said.some(t => /wait for sparkmouse/i.test(t))).toBe(true);
  });

  it('uses the existing wait cue for out-of-turn DTMF', () => {
    const { deps, log, said } = fakeDeps({
      snapshot: () => activeBattle({ mySide: 'b', myName: 'Bo', activeSide: 'a', whoseTurn: 'foe' }),
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    said.length = 0;

    session.handleMessage(dtmf('2'));

    expect(log.some(entry => entry.startsWith('action '))).toBe(false);
    expect(said.join(' ')).toMatch(/wait for shellback/i);
  });

  it('speaks commentary for a battle event (super-effective)', () => {
    const { deps, said } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    said.length = 0;   // clear greeting
    const ev: BattleEvent = { kind: 'effectiveness', on: 'b', multiplier: 2, label: "It's super effective!" };
    s.onBattleEvent(ev);
    expect(said.length).toBe(1);
    expect(said[0]!.toLowerCase()).toMatch(/super|effective|weak/);
  });

  it('narrates a full turn\'s events IN ORDER on the paced clock (screen-sync)', () => {
    // The server hands the whole turn at once; the session must narrate move → super-effective in the
    // order they occurred (paced via setTimer), not scrambled or all-at-once with the wrong sequence.
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', monsterNames: ['Sparkmouse'],
        myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeMonsterName: 'Galecoil', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 40, foeMaxHp: 98,
        myPotions: 2, turn: 0, activeSide: 'b', activeMenu: 'root', whoseTurn: 'foe',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.onBattleEvent({ kind: 'move_used', by: 'a', moveId: 'x', moveName: 'Vine Lash' });
    s.onBattleEvent({ kind: 'effectiveness', on: 'b', multiplier: 2, label: "It's super effective!" });
    const moveIdx = said.findIndex(t => /vine lash/i.test(t));
    const effIdx = said.findIndex(t => /super|effective/i.test(t));
    expect(moveIdx).toBeGreaterThanOrEqual(0);
    expect(effIdx).toBeGreaterThan(moveIdx);   // effectiveness narrated AFTER the move that caused it
  });

  it('queues the next-turn cue until current attack commentary has finished', () => {
    let snap = battleSnap({
      phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
      foeMonsterName: 'Shellback', foeMonsterType: 'water', myHp: 70, myMaxHp: 70, foeHp: 82, foeMaxHp: 82,
      turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'me',
    });
    const timers: (() => void)[] = [];
    const { deps, said } = fakeDeps({
      snapshot: () => snap,
      setTimer: (fn: () => void) => { timers.push(fn); },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.onBattleEvent({ kind: 'move_used', by: 'a', moveId: 'sparkmouse.jolt', moveName: 'Thunder Jolt' });
    snap = { ...snap, turn: 1, activeSide: 'b', activeMenu: 'root', whoseTurn: 'foe' };
    s.onBattleStateChanged();

    expect(said.some(t => /thunder jolt/i.test(t))).toBe(true);
    expect(said.some(t => /wait for shellback/i.test(t))).toBe(false);

    timers.shift()?.();

    expect(said.some(t => /shellback.*please wait|please wait.*shellback/i.test(t))).toBe(true);
  });

  it('lets a new command interrupt stale attack commentary', () => {
    let snap = battleSnap({
      phase: 'battle', myName: 'Bo', mySide: 'b', myMonsterId: 'shellback', myMonsterName: 'Shellback', myMonsterType: 'water',
      foeName: 'Ada', foeMonsterName: 'Sparkmouse', foeMonsterType: 'electric', myHp: 82, myMaxHp: 82, foeHp: 70, foeMaxHp: 70,
      turn: 1, activeSide: 'b', activeMenu: 'root', whoseTurn: 'me',
    });
    const timers: (() => void)[] = [];
    const { deps, log, said } = fakeDeps({
      snapshot: () => snap,
      setTimer: (fn: () => void) => { timers.push(fn); },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.onBattleEvent({ kind: 'move_used', by: 'a', moveId: 'sparkmouse.jolt', moveName: 'Thunder Jolt' });
    s.handleMessage(prompt('guard'));

    expect(log.some(l => l.includes('"kind":"guard"'))).toBe(true);
    const count=said.length;
    timers.shift()?.();
    expect(said).toHaveLength(count);
  });

  it('lets DTMF interrupt commentary and open the move menu', () => {
    const timers: (() => void)[] = [];
    const { deps, log, said } = fakeDeps({
      snapshot: () => activeBattle(),
      setTimer: (fn: () => void) => { timers.push(fn); },
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    said.length = 0;
    session.onBattleEvent({ kind: 'move_used', by: 'b', moveId: 'shellback.splash', moveName: 'Splash' });

    session.handleMessage(dtmf('1'));

    expect(log).toContain('openFight');
    expect(said.join(' ')).toMatch(/Thunder Jolt.*Static Zap/i);
  });

  it('cancels all queued commentary and stale timers on interrupt', async () => {
    const timers:(()=>void)[]=[];
    const {deps,said}=fakeDeps({snapshot:()=>activeBattle(),setTimer:fn=>timers.push(fn)});
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());said.length=0;
    session.onBattleEvent({kind:'move_used',by:'a',moveId:'sparkmouse.jolt',moveName:'Thunder Jolt'});
    session.onBattleEvent({kind:'effectiveness',on:'b',multiplier:2,label:"It's super effective!"});
    const settled=session.whenSpeechSettled();
    session.handleMessage(JSON.stringify({type:'interrupt',utteranceUntilInterrupt:'Thunder',durationUntilInterruptMs:120}));
    await settled;
    const count=said.length;
    for(const timer of timers.splice(0))timer();
    expect(said).toHaveLength(count);
    expect(said.join(' ')).not.toMatch(/super effective/i);
  });

  it('drops a superseded LLM turn when a newer interim arrives', async () => {
    let release!: () => void;
    let staleActionRan = false;
    const pending = new Promise<void>(r => { release = r; });
    const snap = battleSnap({
      phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse',
      whoseTurn: 'me', activeSide: 'a', myMoves: [{ id: 'sparkmouse.jolt', name: 'Thunder Jolt' }],
    });
    const { deps } = fakeDeps({
      snapshot: () => snap,
      converse: async (_code, _id, _text, isCurrent) => {
        await pending;
        if (isCurrent()) staleActionRan = true;
        return 'stale reply';
      },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('what should I do'));
    s.handleMessage(prompt('fight', false));
    release();
    await pending;
    await Promise.resolve();

    expect(staleActionRan).toBe(false);
  });

  it('makes a replaced voice socket inert, including any in-flight LLM turn', async () => {
    let release!: () => void;
    let staleActionRan = false;
    const pending = new Promise<void>(r => { release = r; });
    const { deps, log } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'battle', myName: 'Ada', whoseTurn: 'me', activeSide: 'a' }),
      converse: async (_code, _id, _text, isCurrent) => {
        await pending;
        if (isCurrent()) staleActionRan = true;
        return null;
      },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.handleMessage(prompt('what should I do'));
    s.handleReplaced();
    s.handleMessage(prompt('guard'));
    release();
    await pending; await Promise.resolve();

    expect(staleActionRan).toBe(false);
    expect(log.some(l => l.startsWith('action '))).toBe(false);
  });

  it('drops an in-flight Voice Monsters turn when the caller interrupts', async () => {
    let release!: () => void;
    let staleReplyRan = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const { deps } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'battle', myName: 'Ada', whoseTurn: 'me', activeSide: 'a' }),
      converse: async (_code, _id, _text, isCurrent) => {
        await pending;
        if (isCurrent()) staleReplyRan = true;
        return null;
      },
    });
    const session = new BattleVoiceSession(deps);
    session.handleMessage(setup());
    session.handleMessage(prompt('what should I do'));
    session.handleMessage(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 100 }));
    release(); await pending; await Promise.resolve();

    expect(staleReplyRan).toBe(false);
  });

  it('holds commentary for the shared handoff pause when the acting side changes', () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', myName: 'Ada', myMonsterName: 'Sparkmouse', foeMonsterName: 'Embertail',
      }),
      setTimer: (fn, ms) => { timers.push({ fn, ms }); },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.onBattleEvent({ kind: 'move_used', by: 'a', moveId: 'a', moveName: 'Thunder Jolt' });
    s.onBattleEvent({ kind: 'guard', by: 'b', monsterName: 'Embertail' });
    timers.shift()!.fn();

    expect(said.join(' ')).not.toMatch(/braces|guard/i);
    const handoff = timers.shift()!;
    expect(handoff.ms).toBeGreaterThan(1000);
    handoff.fn();
    expect(said.join(' ')).toMatch(/braces|guard/i);
  });

  it('does not start a rematch while final battle commentary is still draining', () => {
    const timers: (() => void)[] = [];
    const { deps, log, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'results', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse',
        foeName: 'Bo', foeMonsterName: 'Embertail', winnerName: 'Ada',canRematch:false,
      }),
      setTimer: (fn: () => void) => { timers.push(fn); },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.onBattleEvent({ kind: 'battle_over', winner: 'a', winnerName: 'Ada' });

    s.handleMessage(prompt('rematch'));

    expect(log).not.toContain('advance');
    expect(said.some(t => /final result|rematch is ready/i.test(t))).toBe(true);
  });

  it('does not let an LLM tool advance results while final commentary is draining', async () => {
    const timers: (() => void)[] = [];
    let advanced = false;
    const { deps } = fakeDeps({
      snapshot: () => battleSnap({ phase: 'results', myName: 'Ada', winnerName: 'Ada',canRematch:false }),
      setTimer: (fn: () => void) => { timers.push(fn); },
      converse: async (_code, _id, _text, isCurrent) => {
        if (isCurrent()) advanced = true;
        return null;
      },
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    s.onBattleEvent({ kind: 'battle_over', winner: 'a', winnerName: 'Ada' });
    s.handleMessage(prompt('yes'));
    await Promise.resolve();

    expect(advanced).toBe(false);
  });

  it('explains a mid-battle departure and asks the survivor to choose again', () => {
    let snap = battleSnap({
      phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse',
      foeName: 'Bo', foeMonsterName: 'Embertail', whoseTurn: 'me', activeSide: 'a', turn: 2,
    });
    const { deps, said } = fakeDeps({ snapshot: () => snap });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;
    s.onBattleStateChanged(); said.length = 0;
    snap = battleSnap({
      phase: 'monster_select', myName: 'Ada', myMonsterId: null, myMonsterName: null, canStartBattle: false,
    });

    s.onBattleStateChanged();

    expect(said.join(' ')).toMatch(/other player left/i);
    expect(said.join(' ')).toMatch(/choose your own monster/i);
  });

  it('announces the winner immediately and gives result, technology, and replay guidance after the results appear', () => {
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'results', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
        foeName: 'Bo', foeMonsterName: 'Embertail', foeMonsterType: 'fire', winnerName: 'Ada',
        resultsPresented: true,
        turn: 3, activeSide: null, activeMenu: 'root', whoseTurn: null,
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup()); said.length = 0;

    s.onBattleEvent({ kind: 'battle_over', winner: 'a', winnerName: 'Ada' });

    expect(said.join(' ')).toMatch(/Ada wins/i);
    expect(said.join(' ')).not.toMatch(/rematch|Conversation Relay/i);
    s.onBattlePresentation({ kind: 'results', generation: 1, result: { winner: 'a', winnerName: 'Ada' } });

    const line = said.join(' ');
    expect(line).toMatch(/Ada wins/i);
    expect(line).toMatch(/Bo loses/i);
    expect(line).toMatch(/Sparkmouse/i);
    expect(line).toMatch(/Embertail/i);
    expect(line).toMatch(/Twilio Conversation Relay.*spoken moves/i);
    expect(line).toMatch(/rematch/i);
  });

  it('waits for screen paint before announcing battle beats and the next turn', () => {
    let snap=activeBattle({generation:1,turn:1,whoseTurn:'me'});
    const {deps,said}=fakeDeps({snapshot:()=>snap});
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());said.length=0;
    session.onBattleStateChanged();said.length=0;
    snap=activeBattle({generation:1,turn:2,whoseTurn:'foe',activeSide:'b',presentationPending:true});
    session.onBattleStateChanged();
    expect(said.join(' ')).not.toMatch(/turn with|Thunder Jolt/i);
    snap={...snap,presentationPending:false};
    session.onBattlePresentation({kind:'event',generation:1,eventId:1,
      event:{kind:'move_used',by:'a',moveId:'sparkmouse.jolt',moveName:'Thunder Jolt'}});
    expect(said.join(' ')).toMatch(/Thunder Jolt/i);
    expect(said.join(' ')).toMatch(/turn with|turn/i);
  });

  it('keeps the result-screen claim until the current result overlay is painted', () => {
    let snap=activeBattle({phase:'results',generation:2,myName:'Ada',winnerName:'Ada',
      resultsPresented:false,presentationPending:true,canRematch:true});
    const {deps,said}=fakeDeps({snapshot:()=>snap});
    const session=new BattleVoiceSession(deps);session.setStationManaged(true);
    session.handleMessage(setup());said.length=0;
    session.onBattlePresentation({kind:'event',generation:1,eventId:1,
      event:{kind:'battle_over',winner:'a',winnerName:'Old'}});
    expect(said).toHaveLength(0);
    session.onBattlePresentation({kind:'event',generation:2,eventId:2,
      event:{kind:'battle_over',winner:'a',winnerName:'Ada'}});
    expect(said.join(' ')).toMatch(/Ada wins/i);
    expect(said.join(' ')).not.toMatch(/results.*display/i);
    snap={...snap,resultsPresented:true,presentationPending:false};
    session.onBattlePresentation({kind:'results',generation:2,result:{winner:'a',winnerName:'Ada'}});
    expect(said.join(' ')).toMatch(/results.*display.*thanks for playing/i);
  });

  it('uses conversational intent to reveal results for an impatient station caller', async () => {
    const snap=activeBattle({phase:'results',generation:3,myName:'Ada',winnerName:'Ada',
      resultsPresented:false,canRematch:false,presentationPending:true});
    const {deps,log}=fakeDeps({snapshot:()=>snap,
      continueResults:()=>{log.push('show results');return true;},
      interpret:async request=>{
        expect(request.actions).toEqual(expect.arrayContaining([expect.objectContaining({id:'continue_results'})]));
        return {kind:'action',actionId:'continue_results'};
      },
    });
    const session=new BattleVoiceSession(deps);session.setStationManaged(true);
    session.handleMessage(setup());
    session.handleMessage(prompt('Could you put the outcome up now?'));
    await Promise.resolve();
    expect(log).toContain('show results');
  });

  it('treats continue as a free-play rematch after the result is already visible',()=>{
    let phase:BattleVoiceSnapshot['phase']='results';
    const {deps,log}=fakeDeps({
      snapshot:()=>battleSnap({phase,myName:'Ada',winnerName:'Ada',resultsPresented:true,canRematch:true}),
      continueResults:()=>{log.push('show results');return true;},
      advance:()=>{log.push('advance');phase='lobby';return true;},
    });
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());
    session.handleMessage(prompt('continue'));
    expect(log).toContain('advance');
    expect(log).not.toContain('show results');
  });

  it('announces the authoritative winner and invites replay when result paint is delayed',()=>{
    let timedOut=false;
    let phase:BattleVoiceSnapshot['phase']='results';
    const {deps,log,said}=fakeDeps({
      snapshot:()=>battleSnap({phase,myName:'Ada',winnerName:'Ada',resultsPresented:false,
        resultsPresentationTimedOut:timedOut,canRematch:timedOut,presentationPending:false}),
      advance:()=>{log.push('advance');phase='monster_select';return true;},
    });
    const session=new BattleVoiceSession(deps);session.handleMessage(setup());said.length=0;
    timedOut=true;session.onBattleStateChanged();
    expect(said.at(-1)).toMatch(/Ada won.*(want|like).*again.*rematch/i);
    expect(said.at(-1)).not.toMatch(/cannot confirm|can't confirm|results? (?:on|in) (?:the )?display/i);
    session.handleMessage(prompt('rematch'));
    expect(log).toContain('advance');
  });

  it('sends station players back to messaging and the queue without offering a rematch', () => {
    const {deps,said}=fakeDeps({snapshot:()=>battleSnap({
      phase:'results',generation:2,resultsPresented:true,myName:'Ada',myMonsterName:'Sparkmouse',
      foeName:'Bo',foeMonsterName:'Embertail',winnerName:'Ada',
    })});
    const session=new BattleVoiceSession(deps);session.setStationManaged(true);session.handleMessage(setup());said.length=0;
    session.onBattleEvent({kind:'battle_over',winner:'a',winnerName:'Ada'});
    expect(said.join(' ')).toMatch(/results.*display.*thanks for playing.*check your messages/i);
    expect(said.join(' ')).not.toMatch(/rematch|automatically/i);
  });

  it('waits for a station result paint receipt and narrates the terminal line only once', () => {
    let snap=battleSnap({phase:'results',generation:2,resultsPresented:false,presentationPending:true,
      myName:'Ada',myMonsterName:'Sparkmouse',foeName:'Bo',foeMonsterName:'Embertail',winnerName:'Ada'});
    const {deps,said}=fakeDeps({snapshot:()=>snap});
    const session=new BattleVoiceSession(deps);session.setStationManaged(true);
    session.handleMessage(setup());said.length=0;

    session.onBattleEvent({kind:'battle_over',winner:'a',winnerName:'Ada'});
    expect(said.join(' ')).toMatch(/Ada wins/i);
    expect(said.join(' ')).not.toMatch(/results.*display/i);

    snap={...snap,resultsPresented:true,presentationPending:false};
    const result={kind:'results' as const,generation:2,result:{winner:'a' as const,winnerName:'Ada'}};
    session.onBattlePresentation(result);
    session.onBattlePresentation(result);
    session.onBattleEvent({kind:'battle_over',winner:'a',winnerName:'Ada'});
    expect(said.filter(line=>/results.*display/i.test(line))).toHaveLength(1);
  });

  it('uses one authoritative station recovery line if result paint times out', () => {
    let snap=battleSnap({phase:'results',generation:3,resultsPresented:false,
      resultsPresentationTimedOut:false,myName:'Ada',winnerName:'Ada'});
    const {deps,said}=fakeDeps({snapshot:()=>snap});
    const session=new BattleVoiceSession(deps);session.setStationManaged(true);
    session.handleMessage(setup());said.length=0;
    session.onBattleEvent({kind:'battle_over',winner:'a',winnerName:'Ada'});

    snap={...snap,resultsPresentationTimedOut:true};
    session.onBattleStateChanged();
    session.onBattleEvent({kind:'battle_over',winner:'a',winnerName:'Ada'});
    snap={...snap,resultsPresented:true};
    session.onBattlePresentation({kind:'results',generation:3,result:{winner:'a',winnerName:'Ada'}});
    expect(said.filter(line=>/check your messages/i.test(line))).toHaveLength(1);
    expect(said.join(' ')).not.toMatch(/results.*display/i);
  });

  it('names monsters correctly for a side-b caller (event sides are absolute)', () => {
    // A 2nd caller is side 'b': their snapshot's my/foe is relative, but events carry absolute sides.
    // A super-effective hit on side 'a' (the side-b caller's FOE) must name the FOE, not themselves.
    const { deps, said } = fakeDeps({
      snapshot: () => battleSnap({
        phase: 'battle', mySide: 'b', monsterNames: ['Sparkmouse'],
        myName: 'Bo', myMonsterId: 'galecoil', myMonsterName: 'Galecoil', myMonsterType: 'water',
        foeMonsterName: 'Sparkmouse', foeMonsterType: 'electric', myHp: 50, myMaxHp: 98, foeHp: 30, foeMaxHp: 70,
        myPotions: 2, turn: 0, activeSide: 'a', activeMenu: 'root', whoseTurn: 'foe',
      }),
    });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup());
    said.length = 0;
    // move_used by side 'a' (the foe, Sparkmouse) → the line must name Sparkmouse, not Galecoil.
    s.onBattleEvent({ kind: 'move_used', by: 'a', moveId: 'sparkmouse.jolt', moveName: 'Thunder Jolt' });
    expect(said[0]).toContain('Sparkmouse');
    expect(said[0]).not.toContain('Galecoil');
  });

  it('stays silent (no crash) on an unbound event before setup', () => {
    const { deps, said } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.onBattleEvent({ kind: 'faint', side: 'b', monsterName: 'Galecoil' });
    expect(said.length).toBe(0);
  });

  it('removes the caller from the room on close', () => {
    const { deps, log } = fakeDeps();
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821'));
    s.handleClose();
    expect(log.some(l => l.startsWith('leave 4821'))).toBe(true);
  });

  it('resolves pt-BR commandLocale for deterministic commands and spoken output', () => {
    let activeMenu: BattleVoiceSnapshot['activeMenu'] = 'root';
    const snapshot = () => battleSnap({
      phase: 'battle', myName: 'Ada', myMonsterId: 'sparkmouse', myMonsterName: 'Sparkmouse', myMonsterType: 'electric',
      foeMonsterName: 'Shellback', foeMonsterType: 'water', whoseTurn: 'me', activeSide: 'a', activeMenu,
      myMoves: [{ id: 'sparkmouse.jolt', name: 'Thunder Jolt' }, { id: 'sparkmouse.zap', name: 'Static Zap' }],
    });
    const { deps, log, said } = fakeDeps({ snapshot });
    const s = new BattleVoiceSession(deps);

    s.handleMessage(setup('4821', 'pt-BR'));
    expect(said.join(' ')).toMatch(/boas-vindas|sua voz|regras rápidas/i);
    said.length = 0;

    s.handleMessage(prompt('lutar'));
    expect(log).toContain('openFight');
    expect(said.join(' ')).toMatch(/seus golpes|diga o nome/i);
    expect(said.join(' ')).toContain('Thunder Jolt');

    activeMenu = 'fight';
    s.handleMessage(prompt('Thunder Jolt'));
    expect(log.some(line => line.includes('"moveId":"sparkmouse.jolt"'))).toBe(true);
    activeMenu = 'root';
    s.handleMessage(prompt('defender'));
    expect(log.some(line => line.includes('"kind":"guard"'))).toBe(true);
    said.length = 0;
    s.handleMessage(prompt('ajuda'));
    expect(said.join(' ')).toMatch(/atacar.*defender.*item.*provocar/i);
  });

  it('understands Portuguese monster ordinals, advance words, and caller names', () => {
    const { deps, log } = fakeDeps({ snapshot: () => battleSnap({ myName: 'João' }) });
    const s = new BattleVoiceSession(deps);
    s.handleMessage(setup('4821', 'pt-BR'));
    s.handleMessage(prompt('a segunda'));
    expect(log).toContain('monster embertail');

    expect(isAdvanceWord('começar', 'pt-BR')).toBe(true);
    expect(isAdvanceWord('revanche', 'pt-BR')).toBe(true);
    expect(parseSpokenName('meu nome é joão', 'pt-BR')).toBe('João');
    expect(parseSpokenName('poção', 'pt-BR')).toBeNull();
  });
});
