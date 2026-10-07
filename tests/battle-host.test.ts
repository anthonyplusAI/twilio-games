// The Voice Monsters conversational HOST brain — like game-host.ts but for the turn-based battler.
// Turns a caller's spoken utterance into a reply + battle actions (pick monster / fight-guard-item-
// taunt / advance) via an LlmClient, and answers questions about the game, type chart, and Twilio.
import { describe, it, expect } from 'vitest';
import { buildBattleSystemPrompt, battleHostTurn, BATTLE_HOST_TOOLS, type BattleHostContext } from '../server/battle-host';
import type { LlmClient, LlmReply, ToolCall } from '../server/llm';

// A scripted fake LLM: returns a fixed reply (+ optional tool calls) so we test the host's wiring,
// not the model. `enabled` toggles the null-fallback path.
class FakeLlm implements LlmClient {
  readonly enabled: boolean;
  lastSystem = ''; lastToolNames: string[] = [];
  constructor(private reply: LlmReply, enabled = true) { this.enabled = enabled; }
  async respond(system: string, _history: unknown, tools: { name: string }[]): Promise<LlmReply> {
    this.lastSystem = system; this.lastToolNames = tools.map(t => t.name);
    return this.reply;
  }
}

const ctx = (over: Partial<BattleHostContext> = {}): BattleHostContext => ({
  phase: 'monster_select',
  monsters: ['Sparkmouse', 'Embertail', 'Shellback'],
  myName: 'Ada',
  myMonster: null,
  foeMonster: null,
  myHp: null, myMaxHp: null, foeHp: null, foeMaxHp: null,
  myPotions: 2,
  whoseTurn: null,
  moves: [],
  winnerName: null,
  setName: () => 'ok',
  selectMonster: () => 'picked',
  chooseAction: () => 'acted',
  advance: () => 'advanced',
  ...over,
});

describe('buildBattleSystemPrompt', () => {
  it('states the current screen (human-readable, NOT the raw phase id) + name + monster list', () => {
    const p = buildBattleSystemPrompt(ctx());
    expect(p).toMatch(/monster-picking screen/);   // readable label
    expect(p).not.toContain('monster_select');      // NEVER the underscore id (it gets read aloud)
    expect(p).toContain('Ada');
    expect(p).toMatch(/Sparkmouse.*Embertail.*Shellback/);
  });

  it('the prose NEVER contains an underscore token the model could read aloud', () => {
    for (const phase of ['lobby', 'monster_select', 'battle', 'results'] as const) {
      const p = buildBattleSystemPrompt(ctx({ phase, myMonster: 'Sparkmouse', foeMonster: 'Galecoil',
        moves: ['Thunder Jolt'], whoseTurn: 'me' }));
      // No snake_case tokens like select_monster / choose_action / monster_select in the spoken prose.
      expect(p).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });

  it('forbids speaking code tokens / underscores (the "reads a variable" bug)', () => {
    const p = buildBattleSystemPrompt(ctx()).toLowerCase();
    expect(p).toMatch(/underscore|code|slug|id/);   // explicitly told not to say code-like tokens
    expect(p).toMatch(/read aloud|spoken/);
  });

  it('after taking the name it guides the next step (no dead air)', () => {
    const p = buildBattleSystemPrompt(ctx({ phase: 'lobby', myName: null })).toLowerCase();
    expect(p).toMatch(/next|do not just say|nice to meet/);
  });
  it('keeps name onboarding in the lobby and accepts conversational menu requests', () => {
    const lobby = buildBattleSystemPrompt(ctx({ phase: 'lobby', myName: null }));
    expect(lobby).toContain('not required passwords');
    expect(lobby).toContain('clear request to continue');
    for (const phase of ['monster_select', 'battle', 'results'] as const) {
      expect(buildBattleSystemPrompt(ctx({ phase, myName: null })))
        .not.toContain('FIRST job: ask their name');
    }
  });

  it('on monster-select it tells the caller to PICK a monster', () => {
    const p = buildBattleSystemPrompt(ctx()).toLowerCase();
    expect(p).toMatch(/pick|choose/);
  });

  it('during battle it exposes HP + whose turn + the 4 moves so it can commentate intelligently', () => {
    const p = buildBattleSystemPrompt(ctx({
      phase: 'battle', myMonster: 'Sparkmouse', foeMonster: 'Galecoil',
      myHp: 40, myMaxHp: 70, foeHp: 55, foeMaxHp: 98, whoseTurn: 'me',
      moves: ['Thunder Jolt', 'Static Zap', 'Quick Bite', 'Tackle'],
    }));
    expect(p).toContain('Galecoil');
    expect(p).toMatch(/40/); expect(p).toMatch(/70/);
    expect(p).toMatch(/Thunder Jolt/);
    expect(p.toLowerCase()).toMatch(/turn/);
  });

  it('uses attack as the presented command while retaining internal action compatibility', () => {
    const english=buildBattleSystemPrompt(ctx({phase:'battle',myMonster:'Sparkmouse',moves:['Thunder Jolt'],whoseTurn:'me'}));
    const portuguese=buildBattleSystemPrompt(ctx({phase:'battle',myMonster:'Sparkmouse',moves:['Choque Trovejante'],whoseTurn:'me'}),'pt-BR');
    expect(english).toMatch(/say "ATTACK"/i);expect(english).not.toMatch(/say "FIGHT"/i);
    expect(portuguese).toMatch(/diga "atacar"/i);expect(portuguese).not.toMatch(/diga "lutar"/i);
  });

  it('mentions Twilio Conversation Relay so it can answer "how does this work"', () => {
    expect(buildBattleSystemPrompt(ctx()).toLowerCase()).toContain('conversation relay');
  });

  it('teaches the type chart so it can answer matchup questions', () => {
    const p = buildBattleSystemPrompt(ctx()).toLowerCase();
    expect(p).toMatch(/super effective|type|weak|strong/);
  });
});

describe('BATTLE_HOST_TOOLS', () => {
  it('exposes the battle actions the caller can drive by voice', () => {
    const names = BATTLE_HOST_TOOLS.map(t => t.name);
    expect(names).toContain('set_name');
    expect(names).toContain('select_monster');
    expect(names).toContain('choose_action');
    expect(names).toContain('advance');
    expect(BATTLE_HOST_TOOLS.find(tool=>tool.name==='choose_action')?.description).toContain('attack:<move name>');
  });
});

describe('battleHostTurn', () => {
  it('refuses an English LLM reply on a Portuguese call', async () => {
    const english = new FakeLlm({ say: 'Choose your monster.', toolCalls: [] });
    const portuguese = new FakeLlm({ say: 'Escolha seu monstro.', toolCalls: [] });
    expect(await battleHostTurn(english, ctx(), [], 'pt-BR')).toBeNull();
    expect(await battleHostTurn(portuguese, ctx(), [], 'pt-BR')).toBeNull();
  });
  it('returns null when the LLM is disabled (scripted fallback)', async () => {
    const llm = new FakeLlm({ say: '', toolCalls: [] }, false);
    expect(await battleHostTurn(llm, ctx(), [])).toBeNull();
  });

  it('speaks the model reply', async () => {
    const llm = new FakeLlm({ say: 'Pick a fighter!', toolCalls: [] });
    expect(await battleHostTurn(llm, ctx(), [])).toBe('Pick a fighter!');
  });

  it('runs a select_monster tool call against the context', async () => {
    let picked = '';
    const tc: ToolCall = { name: 'select_monster', args: { name: 'Embertail' } };
    const llm = new FakeLlm({ say: '', toolCalls: [tc] });
    const c = ctx({ selectMonster: (n) => { picked = n; return `Locked in the ${n}!`; } });
    const reply = await battleHostTurn(llm, c, []);
    expect(picked).toBe('Embertail');
    expect(reply).toContain('Embertail');   // falls back to the tool confirmation when say is empty
  });

  it('routes a choose_action fight/guard/item/taunt tool call', async () => {
    const seen: string[] = [];
    const c = ctx({ phase: 'battle', chooseAction: (a) => { seen.push(a); return `did ${a}`; } });
    const llm = new FakeLlm({ say: '', toolCalls: [{ name: 'choose_action', args: { action: 'guard' } }] });
    await battleHostTurn(llm, c, []);
    expect(seen).toContain('guard');
  });

  it('relies on battle event commentary after an action instead of double-speaking the model reply', async () => {
    const llm = new FakeLlm({ say: 'Thunder Jolt!', toolCalls: [{ name: 'choose_action', args: { action: 'attack:Thunder Jolt' } }] });
    const reply = await battleHostTurn(llm, ctx({ phase: 'battle', chooseAction: () => null }), []);
    expect(reply).toBeNull();
  });

  it('trusts the model words over the tool confirmation (no double-speak)', async () => {
    const llm = new FakeLlm({ say: 'Great pick — the Embertail!', toolCalls: [{ name: 'select_monster', args: { name: 'Embertail' } }] });
    const reply = await battleHostTurn(llm, ctx({ selectMonster: () => 'Locked in the Embertail!' }), []);
    expect(reply).toBe('Great pick — the Embertail!');   // model's words only, not concatenated
  });
});
