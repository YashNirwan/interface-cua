/**
 * Groq provider.
 *
 * Groq serves open-weight models behind an OpenAI-compatible Chat Completions
 * API. Two reasons it earns a place next to the Anthropic provider:
 *
 * 1. It makes the model seam real rather than aspirational. `LlmProvider` claims
 *    swapping providers is a one-file change; a second implementation is the
 *    only thing that actually proves it. It also means a reviewer without an
 *    Anthropic key can still run `cua discover` end to end.
 *
 * 2. Discovery is a bounded, well-scaffolded task — the surface is pre-parsed
 *    into a semantic node list and the action vocabulary is a fixed tool schema
 *    — so it does not need a frontier model. That is the same argument the
 *    Anthropic provider makes for defaulting to a mid-tier model, taken one
 *    step further.
 *
 * No new dependency: the OpenAI-compatible wire format is plain JSON over
 * `fetch`, which Node 20 has natively. Adding an SDK to speak a format we can
 * write in forty lines would be a cost with no matching benefit.
 *
 * IMPORTANT: like every provider, this is reachable ONLY from the discovery
 * path. Replay never constructs an LlmProvider — see src/replay/executor.ts.
 */

import type { LlmMessage, LlmProvider, LlmTurn, ToolCall, ToolSpec } from './provider.js';

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Default model. Of the models this API exposes, `openai/gpt-oss-120b` is the
 * largest general-purpose one with reliable function-calling support — the
 * Whisper, Orpheus, and Prompt-Guard entries are speech and classifier models,
 * and the `groq/compound` entries are prebuilt agent systems with their own
 * built-in tools, which would fight the discovery loop for control.
 * Override with CUA_MODEL.
 */
export const DEFAULT_MODEL = 'openai/gpt-oss-120b';

/** Discovery is exploratory, but a run we cannot reproduce is a run we cannot audit. */
const DEFAULT_TEMPERATURE = 0;

const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Wire types — the subset of the OpenAI-compatible schema we actually read.
// Declared explicitly so the response is narrowed at the boundary rather than
// being trusted as `any` three call sites deep.
// ---------------------------------------------------------------------------

interface WireToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface WireChoice {
  message?: {
    content?: unknown;
    /** gpt-oss surfaces its chain of thought here; other models omit it. */
    reasoning?: unknown;
    tool_calls?: unknown;
  };
  finish_reason?: unknown;
}

interface WireResponse {
  choices?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  error?: { message?: unknown; type?: unknown };
}

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

/**
 * Translate our message log into OpenAI's.
 *
 * The one non-obvious part: our `tool-results` message carries an ARRAY of
 * results (one per tool call in the preceding turn), while OpenAI wants a
 * SEPARATE `role: "tool"` message per result. One of ours fans out into N of
 * theirs. Getting this wrong produces a 400 that reads like a schema problem
 * but is really a "you owe a reply to every tool_call_id" problem.
 */
function toOpenAiMessages(system: string, messages: LlmMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const assistant: OpenAiMessage = {
        role: 'assistant',
        // OpenAI wants null, not '', when the turn was purely a tool call.
        content: m.content === '' ? null : m.content,
      };
      if (m.toolCalls.length > 0) {
        assistant.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
      }
      out.push(assistant);
      continue;
    }
    for (const r of m.results) {
      out.push({
        role: 'tool',
        tool_call_id: r.id,
        // There is no `is_error` field on an OpenAI tool message, so the error
        // has to travel inside the content or it is silently lost — and a model
        // that cannot tell success from failure will happily retry the failing
        // action forever.
        content: r.isError === true ? `ERROR: ${r.content}` : r.content,
      });
    }
  }
  return out;
}

function toOpenAiTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GroqError';
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Parse one tool call. `arguments` arrives as a JSON *string*, not an object —
 * so a model that emits malformed JSON fails here rather than downstream. We
 * raise instead of silently substituting `{}`: an action with dropped arguments
 * ("type nothing into the member id box") succeeds and produces a wrong result,
 * which is the failure mode this whole codebase is built to avoid.
 */
function parseToolCall(raw: unknown, index: number): ToolCall {
  const tc = raw as WireToolCall;
  const name = asString(tc.function?.name);
  const id = asString(tc.id) || `call_${index}`;
  if (name === '') throw new GroqError(`tool call ${index} has no function name`);

  const rawArgs = tc.function?.arguments;
  if (rawArgs === undefined || rawArgs === null || rawArgs === '') return { id, name, args: {} };
  if (typeof rawArgs === 'object') return { id, name, args: rawArgs as Record<string, unknown> };

  try {
    const parsed: unknown = JSON.parse(String(rawArgs));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }
    return { id, name, args: parsed as Record<string, unknown> };
  } catch (err) {
    throw new GroqError(
      `tool call '${name}' returned unparseable arguments: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------


const MAX_RATE_LIMIT_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * How long to wait before retrying, or null if the error is not retryable.
 * Prefers the provider's own "try again in 8.58s" over a guess, because the
 * guess is what turns one 429 into five.
 */
export function retryDelayMs(err: unknown, attempt: number): number | null {
  if (attempt >= MAX_RATE_LIMIT_RETRIES) return null;
  if (!(err instanceof GroqError)) return null;
  const status = err.status;
  const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
  if (!retryable) return null;
  const hinted = /try again in ([\d.]+)\s*s/i.exec(err.message);
  if (hinted?.[1] !== undefined) return Math.ceil(Number(hinted[1]) * 1000) + 250;
  return Math.min(2000 * 2 ** attempt, 15_000);
}

export class GroqProvider implements LlmProvider {
  readonly name = 'groq';
  readonly model: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(opts?: { apiKey?: string; model?: string; temperature?: number; timeoutMs?: number }) {
    const apiKey = opts?.apiKey ?? process.env['GROQ_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'GROQ_API_KEY is not set. Discovery requires model access; replay does not. ' +
          'Put the key in .env (which is gitignored) or run `cua replay` against an existing artifact instead.',
      );
    }
    this.apiKey = apiKey;
    this.model = opts?.model ?? process.env['CUA_MODEL'] ?? DEFAULT_MODEL;
    this.temperature = opts?.temperature ?? DEFAULT_TEMPERATURE;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Free and shared tiers rate-limit on tokens-per-minute, and a discovery loop
   * resends a screen every turn, so 429 is an ordinary condition here rather
   * than an exceptional one. The provider tells us how long to wait; honour it
   * instead of failing a run that is one short pause from succeeding.
   *
   * Bounded retries only: an unbounded wait would turn a quota problem into a
   * hung browser session holding a lease.
   */
  async complete(input: {
    system: string;
    messages: LlmMessage[];
    tools: ToolSpec[];
    maxTokens?: number;
  }): Promise<LlmTurn> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        return await this.attempt(input);
      } catch (err) {
        lastErr = err;
        const wait = retryDelayMs(err, attempt);
        if (wait === null) throw err;
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  private async attempt(input: {
    system: string;
    messages: LlmMessage[];
    tools: ToolSpec[];
    maxTokens?: number;
  }): Promise<LlmTurn> {
    const body = {
      model: this.model,
      messages: toOpenAiMessages(input.system, input.messages),
      tools: toOpenAiTools(input.tools),
      tool_choice: 'auto',
      temperature: this.temperature,
      // `max_tokens` is deprecated on this API in favour of the explicit
      // completion-scoped name; the old one still works but warns.
      max_completion_tokens: input.maxTokens ?? 2048,
    };

    // A discovery loop that hangs on a wedged connection burns a browser
    // session and a lease with nothing to show for it. Bound every call.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new GroqError(`request timed out after ${this.timeoutMs}ms`);
      }
      throw new GroqError(`network error calling Groq: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: WireResponse;
    try {
      json = JSON.parse(text) as WireResponse;
    } catch {
      throw new GroqError(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
    }

    if (!res.ok || json.error !== undefined) {
      // Surface the provider's own message: rate limits and model-decommissioned
      // errors are the two we actually hit, and both are self-explanatory only
      // if we do not flatten them into a generic failure.
      throw new GroqError(`Groq API error (HTTP ${res.status}): ${asString(json.error?.message) || text.slice(0, 300)}`, res.status);
    }

    const choices = Array.isArray(json.choices) ? json.choices : [];
    const choice = choices[0] as WireChoice | undefined;
    if (choice === undefined) throw new GroqError('response contained no choices');

    const rawToolCalls = Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : [];
    const toolCalls = rawToolCalls.map((c, i) => parseToolCall(c, i));

    /*
     * `content` is null on a pure tool-calling turn. gpt-oss also returns a
     * `reasoning` field; we fall back to it so the evidence log records WHY the
     * model chose an action, not just that it did. For a system whose whole
     * claim is that a recorded flow is auditable, the reasoning behind each
     * recorded step is worth capturing.
     */
    const content = asString(choice.message?.content);
    const reasoning = asString(choice.message?.reasoning);

    return {
      text: content !== '' ? content : reasoning,
      toolCalls,
      stopReason: asString(choice.finish_reason) || 'unknown',
      usage: {
        inputTokens: typeof json.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : 0,
        outputTokens: typeof json.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : 0,
      },
    };
  }
}
