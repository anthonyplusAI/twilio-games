import { describe, it, expect } from 'vitest';
import { parseOpenAiReply, NullLlmClient, OpenAiClient } from '../server/llm';

describe('parseOpenAiReply', () => {
  it('pulls plain content', () => {
    const r = parseOpenAiReply({ choices: [{ message: { content: 'The McLaren is quickest!' } }] });
    expect(r.say).toBe('The McLaren is quickest!');
    expect(r.toolCalls).toEqual([]);
  });
  it('parses a tool call with JSON args', () => {
    const r = parseOpenAiReply({ choices: [{ message: { content: '',
      tool_calls: [{ function: { name: 'select_car', arguments: '{"name":"mclaren"}' } }] } }] });
    expect(r.toolCalls).toEqual([{ name: 'select_car', args: { name: 'mclaren' } }]);
  });
  it('tolerates malformed tool args (→ empty args, no throw)', () => {
    const r = parseOpenAiReply({ choices: [{ message: {
      tool_calls: [{ function: { name: 'start_race', arguments: 'not json' } }] } }] });
    expect(r.toolCalls).toEqual([{ name: 'start_race', args: {} }]);
  });
  it('handles an empty/odd response shape', () => {
    expect(parseOpenAiReply({})).toEqual({ say: '', toolCalls: [] });
  });
});

describe('NullLlmClient', () => {
  it('is disabled and says nothing', async () => {
    const c = new NullLlmClient();
    expect(c.enabled).toBe(false);
    expect(await c.respond()).toEqual({ say: '', toolCalls: [] });
  });
});

describe('OpenAiClient', () => {
  it('posts to the completions endpoint with auth + returns the parsed reply', async () => {
    let seenUrl = '', seenAuth = '';
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seenUrl = String(url); seenAuth = String((init.headers as Record<string, string>)['Authorization']);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hi racer!' } }] }) } as Response;
    }) as unknown as typeof fetch;
    const c = new OpenAiClient({ apiKey: 'sk-test', model: 'gpt-x', fetchImpl: fakeFetch });
    const r = await c.respond('sys', [{ role: 'user', content: 'hello' }], []);
    expect(seenUrl).toContain('/chat/completions');
    expect(seenAuth).toBe('Bearer sk-test');
    expect(r.say).toBe('Hi racer!');
  });
  it('requires the declared resolver tool for a semantic game command', async () => {
    let body: Record<string, unknown> | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, json: async () => ({ choices: [{ message: {
        tool_calls: [{ function: { name: 'resolve_voice_turn', arguments: '{"kind":"none"}' } }],
      } }] }) } as Response;
    }) as unknown as typeof fetch;
    const client = new OpenAiClient({ apiKey: 'sk-test', fetchImpl: fakeFetch });
    await client.respond('sys', [], [{ name: 'resolve_voice_turn', description: 'resolve', parameters: {} }],
      { forceTool: 'resolve_voice_turn' });
    expect(body?.tool_choice).toEqual({ type: 'function', function: { name: 'resolve_voice_turn' } });
  });
  it('never throws on a network error (returns empty reply → scripted fallback)', async () => {
    const boom = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const c = new OpenAiClient({ apiKey: 'sk', fetchImpl: boom });
    expect(await c.respond('s', [], [])).toEqual({ say: '', toolCalls: [] });
  });
  it('returns empty on a non-2xx (does not throw)', async () => {
    const err = (async () => ({ ok: false, status: 429, json: async () => ({}) } as Response)) as unknown as typeof fetch;
    const c = new OpenAiClient({ apiKey: 'sk', fetchImpl: err });
    expect(await c.respond('s', [], [])).toEqual({ say: '', toolCalls: [] });
  });
});
