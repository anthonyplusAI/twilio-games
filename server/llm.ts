// Thin OpenAI Chat Completions transport for game-host replies and phase-scoped voice intent.
// Kept SDK-free (raw fetch) so OPENAI_MODEL can change without a dependency bump.
//
// Behind the LlmClient interface so tests can use a fake and local development without a key
// can use NullLlmClient. Production voice commands require a configured key.

export interface LlmTurn { role: 'user' | 'assistant'; content: string }

/** A function the model may call to ACT on the game (pick a car, choose a map, start the race). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema for the args
}

/** One tool invocation the model requested. */
export interface ToolCall { name: string; args: Record<string, unknown> }

/** What the model returned: something to SAY + any actions to take. */
export interface LlmReply { say: string; toolCalls: ToolCall[] }

export interface LlmRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Require a declared tool for a turn whose entire reply must be structured. */
  forceTool?: string;
}

export interface LlmClient {
  /** One turn: system prompt + conversation history + available tools → reply. Never throws (returns
   *  a safe empty reply on failure) so a flaky API call can't break the call flow. */
  respond(system: string, history: LlmTurn[], tools: ToolSpec[], options?: LlmRequestOptions): Promise<LlmReply>;
  readonly enabled: boolean;   // false when no key → callers fall back to scripted lines
}

/** No-LLM stand-in: used when OPENAI_API_KEY is unset. respond() returns nothing to say + no actions,
 *  so callers know to fall back to the curated phrase banks. */
export class NullLlmClient implements LlmClient {
  readonly enabled = false;
  async respond(): Promise<LlmReply> { return { say: '', toolCalls: [] }; }
}

export interface OpenAiOpts {
  apiKey: string;
  model?: string;                  // default env OPENAI_MODEL or a sensible fallback
  baseUrl?: string;                // override for proxies / Azure OpenAI
  maxTokens?: number;
  timeoutMs?: number;              // hard cap so a slow API can't hang the call
  fetchImpl?: typeof fetch;        // injectable for tests
}

export class OpenAiClient implements LlmClient {
  readonly enabled = true;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: OpenAiOpts) {
    this.model = opts.model || 'gpt-4o-mini';
    this.baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.maxTokens = opts.maxTokens ?? 120;   // short spoken replies
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  async respond(system: string, history: LlmTurn[], tools: ToolSpec[], options?: LlmRequestOptions): Promise<LlmReply> {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'system', content: system }, ...history],
      ...(tools.length ? {
        tools: tools.map(t => ({ type: 'function', function: {
          name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: options?.forceTool && tools.some(t => t.name === options.forceTool)
          ? { type: 'function', function: { name: options.forceTool } }
          : 'auto',
      } : {}),
    };
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener('abort', abort, { once: true });
    const timeoutMs = Math.min(this.timeoutMs, options?.timeoutMs ?? this.timeoutMs);
    const timer = setTimeout(abort, timeoutMs);
    try {
      const res = await this.doFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) { console.log(`[LLM] HTTP ${res.status}`); return { say: '', toolCalls: [] }; }
      const data = await res.json() as OpenAiResponse;
      return parseOpenAiReply(data);
    } catch {
      console.log('[LLM] request failed');
      return { say: '', toolCalls: [] };   // never throw into the call flow
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abort);
    }
  }
}

interface OpenAiResponse {
  choices?: { message?: { content?: string | null;
    tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
}

/** Pull the spoken text + tool calls out of a Chat Completions response, tolerant of shape drift. */
export function parseOpenAiReply(data: OpenAiResponse): LlmReply {
  const msg = data.choices?.[0]?.message ?? {};
  const say = (msg.content ?? '').trim();
  const toolCalls: ToolCall[] = [];
  for (const tc of msg.tool_calls ?? []) {
    const name = tc.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
    toolCalls.push({ name, args });
  }
  return { say, toolCalls };
}
