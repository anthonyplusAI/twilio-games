import { describe, expect, it } from 'vitest';
import type { LlmClient, LlmReply, LlmTurn, ToolSpec } from '../server/llm';
import { interpretVoiceTurn, type VoiceInterpretRequest } from '../server/voice-interpreter';

const request: VoiceInterpretRequest = {
  game: 'racer',
  phase: 'car_select',
  locale: 'en-US',
  transcript: 'I think the blue car, actually make it the red one',
  actions: [{ id: 'select_car', description: 'Select a car shown on screen', targetIds: ['blue', 'red'] }],
  choices: [{ id: 'blue', label: 'Blue car' }, { id: 'red', label: 'Red car' }],
  facts: [{ id: 'turn', text: 'It is your turn to choose a car.' }],
};

function fake(reply: LlmReply) {
  let seen: { system: string; history: LlmTurn[]; tools: ToolSpec[] } | null = null;
  const client: LlmClient = {
    enabled: true,
    async respond(system, history, tools) {
      seen = { system, history, tools };
      return reply;
    },
  };
  return { client, seen: () => seen };
}

describe('voice interpreter', () => {
  it('provides the live screen choices and accepts a valid resolved action', async () => {
    const { client, seen } = fake({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'action', actionId: 'select_car', targetId: 'red' } },
    ] });
    expect(await interpretVoiceTurn(client, request)).toEqual({ kind: 'action', actionId: 'select_car', targetId: 'red' });
    expect(seen()?.history[0]?.content).toContain('actually make it the red one');
    expect(seen()?.history[0]?.content).toContain('Blue car');
    expect(seen()?.history[0]?.content).toContain('car_select');
    expect(seen()?.system).toMatch(/correction|latest/i);
  });

  it('rejects an action or target that is not legal on the current screen', async () => {
    const badAction = fake({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'action', actionId: 'start_race' } },
    ] });
    expect(await interpretVoiceTurn(badAction.client, request)).toEqual({ kind: 'none' });
    const badTarget = fake({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'action', actionId: 'select_car', targetId: 'green' } },
    ] });
    expect(await interpretVoiceTurn(badTarget.client, request)).toEqual({ kind: 'none' });
    const strayTarget = fake({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'action', actionId: 'advance', targetId: 'red' } },
    ] });
    expect(await interpretVoiceTurn(strayTarget.client, {
      ...request, actions: [...request.actions, { id: 'advance', description: 'Continue to the next menu' }],
    })).toEqual({ kind: 'none' });
  });

  it('only returns factual replies supplied by the current screen', async () => {
    const valid = fake({ say: 'You must tell me your name first.', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'answer', factId: 'turn' } },
    ] });
    expect(await interpretVoiceTurn(valid.client, request)).toEqual({ kind: 'answer', factId: 'turn' });
    const invented = fake({ say: '', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'answer', factId: 'secret_answer' } },
    ] });
    expect(await interpretVoiceTurn(invented.client, request)).toEqual({ kind: 'none' });
  });

  it('honors an aborted or disabled turn without asking the model', async () => {
    const { client, seen } = fake({ say: '', toolCalls: [] });
    const controller = new AbortController();
    controller.abort();
    expect(await interpretVoiceTurn(client, { ...request, signal: controller.signal })).toEqual({ kind: 'none' });
    expect(seen()).toBeNull();
    expect(await interpretVoiceTurn({ enabled: false, respond: client.respond }, request)).toEqual({ kind: 'none' });
  });

  it('keeps clarification short and discards model narration', async () => {
    const { client } = fake({ say: 'The match has ended.', toolCalls: [
      { name: 'resolve_voice_turn', args: { kind: 'clarify', reason: 'Which car did you mean? Please repeat.' } },
    ] });
    expect(await interpretVoiceTurn(client, request)).toEqual({ kind: 'clarify', reason: 'ambiguous' });
  });
});
