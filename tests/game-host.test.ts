import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, hostTurn, fuzzyMatch, matchChoice, clearSelectionIndex, HOST_TOOLS, type HostContext } from '../server/game-host';
import type { LlmClient, LlmReply } from '../server/llm';

function ctx(over: Partial<HostContext> = {}): HostContext {
  return {
    phase: 'car_select', cars: ['Batmobile', 'McLaren Senna', 'Lotus Elise'],
    maps: ['Silver Lake', 'Desert Dash'], selectedMap: null, myName: 'Ada', myCar: null, myPlace: null, myFinishTime: null, racerCount: 2,
    setName: () => 'ok-name', selectCarByName: () => 'ok-car', selectMapByName: () => 'ok-map', startRace: () => 'ok-start',
    ...over,
  };
}
/** A fake LLM that returns a scripted reply (say + toolCalls). */
function fakeLlm(reply: LlmReply, enabled = true): LlmClient {
  return { enabled, respond: async () => reply };
}

describe('fuzzyMatch', () => {
  const cars = ['Batmobile', 'McLaren Senna', 'Lotus Elise'];
  it('matches exact + case-insensitive', () => {
    expect(fuzzyMatch('lotus elise', cars)).toBe(2);
  });
  it('matches a substring / partial name', () => {
    expect(fuzzyMatch('mclaren', cars)).toBe(1);
    expect(fuzzyMatch('bat', cars)).toBe(0);
  });
  it('matches by shared word', () => {
    expect(fuzzyMatch('the senna', cars)).toBe(1);
  });
  it('returns -1 for no match / empty', () => {
    expect(fuzzyMatch('ferrari', cars)).toBe(-1);
    expect(fuzzyMatch('', cars)).toBe(-1);
  });
});

describe('matchChoice (number OR name)', () => {
  const cars = ['Batmobile', 'McLaren Senna', 'Lotus Elise', 'Ford Bronco'];
  it('matches by digit number ("car 2" → index 1)', () => {
    expect(matchChoice('car 2', cars)).toBe(1);
    expect(matchChoice('number 4', cars)).toBe(3);
    expect(matchChoice('3', cars)).toBe(2);
  });
  it('matches by number WORD ("two")', () => {
    expect(matchChoice('two', cars)).toBe(1);
    expect(matchChoice('give me car four', cars)).toBe(3);
  });
  it('matches ORDINALS, not the trailing "one" ("the second one" → index 1, not 0)', () => {
    expect(matchChoice('the second one', cars)).toBe(1);   // was matching "one" → 0 (the bug)
    expect(matchChoice('the third one', cars)).toBe(2);
    expect(matchChoice('first', cars)).toBe(0);
    expect(matchChoice('the fourth', cars)).toBe(3);
  });
  it('handles common ASR phrasings ("car number two", "I\'ll take two")', () => {
    expect(matchChoice('car number two', cars)).toBe(1);
    expect(matchChoice("I'll take two", cars)).toBe(1);
    expect(matchChoice('lets do number 2', cars)).toBe(1);
  });
  it('still matches by name when no number is present', () => {
    expect(matchChoice('mclaren', cars)).toBe(1);
    expect(matchChoice('bronco', cars)).toBe(3);
  });
  it('out-of-range number falls through to name match / -1', () => {
    expect(matchChoice('car 99', cars)).toBe(-1);
  });
});

describe('clearSelectionIndex (deterministic pre-LLM pick)', () => {
  const cars = ['Batmobile', 'McLaren Senna', 'Lotus Elise', 'Ford Bronco'];
  it('returns the index for an explicit NUMBER pick', () => {
    expect(clearSelectionIndex('two', cars)).toBe(1);
    expect(clearSelectionIndex('car 3', cars)).toBe(2);
    expect(clearSelectionIndex('the second one', cars)).toBe(1);
    expect(clearSelectionIndex('number four please', cars)).toBe(3);
  });
  it('returns the index for a STRONG name match', () => {
    expect(clearSelectionIndex('mclaren', cars)).toBe(1);
    expect(clearSelectionIndex('the batmobile', cars)).toBe(0);
    expect(clearSelectionIndex("I'll take the bronco", cars)).toBe(3);
  });
  it('does NOT intercept a QUESTION (let the LLM answer)', () => {
    expect(clearSelectionIndex('which car is fastest?', cars)).toBeNull();
    expect(clearSelectionIndex('what do you recommend', cars)).toBeNull();
    expect(clearSelectionIndex('how does boost work', cars)).toBeNull();
    expect(clearSelectionIndex('tell me about the cars', cars)).toBeNull();
    expect(clearSelectionIndex('I want to know which car is fastest', cars)).toBeNull();
  });
  it('does not select from generic menu words', () => {
    expect(clearSelectionIndex('car', ['Batmobile', 'Cartoon Sports Car'])).toBeNull();
    expect(clearSelectionIndex('track', ['Silver Lake', 'Drift Track'])).toBeNull();
    expect(clearSelectionIndex('give me a car', ['Batmobile', 'Cartoon Sports Car'])).toBeNull();
    expect(clearSelectionIndex('choose a track', ['Silver Lake', 'Drift Track'])).toBeNull();
  });
  it('does not intercept an out-of-range number', () => {
    expect(clearSelectionIndex('car 99', cars)).toBeNull();
  });
  it('never executes a rejected or ambiguous selection before semantic interpretation', () => {
    expect(clearSelectionIndex("I don't want car two", cars)).toBeNull();
    expect(clearSelectionIndex('one or two', cars)).toBeNull();
    expect(clearSelectionIndex('the Bronco or the McLaren', cars)).toBeNull();
    expect(clearSelectionIndex('não quero o carro um', cars, 'pt-BR')).toBeNull();
    expect(clearSelectionIndex('one, actually two', cars)).toBe(1);
  });
});

describe('buildSystemPrompt', () => {
  it('includes the phase + car list during car_select', () => {
    const p = buildSystemPrompt(ctx({ phase: 'car_select' }));
    expect(p).toContain('car_select');
    expect(p).toContain('McLaren Senna');
    expect(p.toLowerCase()).toContain('select_car');
  });
  it('mentions the tracks during map_select', () => {
    const p = buildSystemPrompt(ctx({ phase: 'map_select', maps: ['Silver Lake'] }));
    expect(p).toContain('Silver Lake');
  });
  it('describes deterministic tie-breaking and never calls a DNF racer the winner', () => {
    const mapPrompt=buildSystemPrompt(ctx({phase:'map_select'}));
    expect(mapPrompt).toContain('deterministic station tie-breaker');
    expect(mapPrompt).not.toMatch(/ties broken randomly/i);
    const resultPrompt=buildSystemPrompt(ctx({phase:'results',myPlace:1,myFinishTime:null,
      raceStandings:[{name:'Ada',place:1,time:null,finished:false}]}));
    expect(resultPrompt).toMatch(/did not finish/i);
    expect(resultPrompt).not.toMatch(/caller won/i);
  });
  it('tells it to keep quiet during a live race', () => {
    const p = buildSystemPrompt(ctx({ phase: 'racing' }));
    expect(p.toLowerCase()).toMatch(/driving|do not chat|live/);
  });
  it('teaches the caller about the NITRO command (the control players miss)', () => {
    const p = buildSystemPrompt(ctx()).toLowerCase();
    expect(p).toContain('nitro');           // the trigger word players say
    expect(p).toMatch(/smash|barrier|orb/); // explains what it does / how to refill it
  });
  it('exposes the action tools (set_name + select_car/map + start_race)', () => {
    expect(HOST_TOOLS.map(t => t.name).sort()).toEqual(['select_car', 'select_map', 'set_name', 'start_race']);
  });

  it('FORBIDS inventing car/track names (anti-hallucination) + says the list is exact', () => {
    const p = buildSystemPrompt(ctx({ phase: 'map_select', maps: ['Silver Lake', 'Drift'] })).toLowerCase();
    expect(p).toMatch(/only|exact|do not (make up|invent)|never (make up|invent)/);
    // it must not tell the model it can offer options beyond the provided list
    expect(p).toMatch(/silver lake|drift/);
  });

  it('on results, recaps the race + overviews the current-track leaderboard (not a full readout)', () => {
    const p = buildSystemPrompt(ctx({
      phase: 'results', myPlace: 2, selectedMap: 'Silver Lake',
      raceStandings: [
        { name: 'Rex', place: 1, time: 39.12, finished: true },
        { name: 'Ada', place: 2, time: 41.34, finished: true },
        { name: 'Bo', place: 3, time: null, finished: false },
      ],
      leaderboardTop: [{ name: 'Rex', time: 33.01 }, { name: 'Ada', time: 35.2 }],
      allTimeTop: ['Rex', 'Ada'], allTimeBest: { name: 'Rex', time: 33.01 },
    })).toLowerCase();
    expect(p).toMatch(/recap/);
    expect(p).toContain('rex');            // names the podium / record holder
    expect(p).toMatch(/leaderboard|record/);
    expect(p).toContain('current track');
    expect(p).toContain('silver lake');
    expect(p).toContain('use only this track-specific leaderboard data');
    expect(p).toContain('41.34 seconds');
    expect(p).toContain('33.01 seconds');
    expect(p).toContain('do not invent or estimate times');
    expect(p).toMatch(/summariz|overview|not.*(list|readout|every)/);   // summary, not a full readout
  });

  it('after taking the name it guides the next step (no dead air)', () => {
    const p = buildSystemPrompt(ctx({ phase: 'lobby', myName: null })).toLowerCase();
    expect(p).toContain('either racer can say start');
  });

  it('after taking the name it tells callers to look at controls and gives voice commands', () => {
    const p = buildSystemPrompt(ctx({ phase: 'lobby', myName: null })).toLowerCase();
    expect(p).toContain('look at the controls on the screen');
    for (const word of ['left', 'right', 'boost', 'brake', 'nitro']) expect(p).toContain(word);
  });

  it('tells the host WHICH screen the players are looking at (screen awareness)', () => {
    expect(buildSystemPrompt(ctx({ phase: 'car_select' })).toLowerCase()).toMatch(/screen|display|showing/);
    expect(buildSystemPrompt(ctx({ phase: 'map_select' })).toLowerCase()).toMatch(/screen|display|showing/);
  });

  it('does NOT skip ahead: only advance when the CURRENT step is done + caller asks', () => {
    const car = buildSystemPrompt(ctx({ phase: 'car_select', myCar: null })).toLowerCase();
    // With no car picked yet, it must be told NOT to move on to the track/map.
    expect(car).toMatch(/do not|don't|only.*(after|once)|not.*advance|stay on/);
  });

  it('carries Q&A knowledge: the game, controls, Twilio, and Conversation Relay', () => {
    const p = buildSystemPrompt(ctx()).toLowerCase();
    expect(p).toContain('conversation relay');
    expect(p).toContain('twilio');
    expect(p).toMatch(/answer|question|ask/);   // it's allowed/encouraged to answer questions
  });

  it('keeps the host tone measured, not over-the-top', () => {
    const p = buildSystemPrompt(ctx({ phase: 'results', myPlace: 1 })).toLowerCase();
    expect(p).toContain('measured');
    expect(p).toMatch(/not over-the-top|calm/);
    expect(p).not.toContain('maximum hype');
  });
});

describe('hostTurn', () => {
  it('refuses an English LLM reply on a Portuguese call', async () => {
    expect(await hostTurn(fakeLlm({ say: 'Choose your car now.', toolCalls: [] }), ctx(), [], 'pt-BR')).toBeNull();
    expect(await hostTurn(fakeLlm({ say: 'Escolha seu carro agora.', toolCalls: [] }), ctx(), [], 'pt-BR')).toBeNull();
  });
  it('returns null when the LLM is disabled (→ scripted fallback)', async () => {
    const out = await hostTurn(fakeLlm({ say: 'hi', toolCalls: [] }, false), ctx(), []);
    expect(out).toBeNull();
  });
  it('speaks the model reply when it just talks', async () => {
    const out = await hostTurn(fakeLlm({ say: 'The McLaren is fastest!', toolCalls: [] }), ctx(), []);
    expect(out).toBe('The McLaren is fastest!');
  });
  it('executes a select_car tool call; speaks the MODEL words only (no double car name)', async () => {
    let picked = '';
    const c = ctx({ selectCarByName: (n) => { picked = n; return 'Locked in — the McLaren Senna!'; } });
    const out = await hostTurn(fakeLlm({ say: 'Great taste — the McLaren it is!', toolCalls: [{ name: 'select_car', args: { name: 'mclaren' } }] }), c, []);
    expect(picked).toBe('mclaren');                 // the action still ran
    expect(out).toBe('Great taste — the McLaren it is!');   // ...but only the model's words are spoken
    expect(out).not.toContain('Locked in');         // no appended confirmation → no repetition
  });
  it('speaks the tool confirmation when the model gives NO words (bare tool call)', async () => {
    const c = ctx({ selectCarByName: () => 'Locked in — the McLaren Senna!' });
    const out = await hostTurn(fakeLlm({ say: '', toolCalls: [{ name: 'select_car', args: { name: 'mclaren' } }] }), c, []);
    expect(out).toBe('Locked in — the McLaren Senna!');
  });
  it('does NOT run select_car outside car_select', async () => {
    let called = false;
    const c = ctx({ phase: 'map_select', selectCarByName: () => { called = true; return 'x'; } });
    await hostTurn(fakeLlm({ say: '', toolCalls: [{ name: 'select_car', args: { name: 'x' } }] }), c, []);
    expect(called).toBe(false);
  });
  it('speaks only the confirmation when the model calls a tool with no words', async () => {
    const c = ctx({ startRace: () => "Here we go — let's race!" });
    const out = await hostTurn(fakeLlm({ say: '', toolCalls: [{ name: 'start_race', args: {} }] }), c, []);
    expect(out).toBe("Here we go — let's race!");
  });
  it('returns null when there is nothing to say and no action fired', async () => {
    const out = await hostTurn(fakeLlm({ say: '', toolCalls: [] }), ctx(), []);
    expect(out).toBeNull();
  });
  it('runs set_name in any phase (onboarding — captures the caller\'s name)', async () => {
    let named = '';
    const c = ctx({ phase: 'lobby', myName: null, setName: (n) => { named = n; return `Nice, ${n}!`; } });
    const out = await hostTurn(fakeLlm({ say: '', toolCalls: [{ name: 'set_name', args: { name: 'Ada' } }] }), c, []);
    expect(named).toBe('Ada');
    expect(out).toContain('Ada');
  });
  it('prompts for the name first when it is not set yet', () => {
    const p = buildSystemPrompt(ctx({ myName: null }));
    expect(p.toLowerCase()).toMatch(/name/);
    expect(p.toLowerCase()).toContain('set_name');
  });
});
