/**
 * Anthropic provider.
 *
 * Model choice (defended in REPORT.md §1): Claude Sonnet by default rather than
 * the largest available model. Discovery is a bounded, well-scaffolded task —
 * the surface is pre-parsed into a semantic element list, the action vocabulary
 * is a fixed tool schema, and the loop is capped. That is a setting where a
 * mid-tier model succeeds, and discovery cost matters because it is paid once
 * per capability per app version, across thousands of app instances. Override
 * with CUA_MODEL when a flow genuinely needs more reasoning.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LlmMessage, LlmProvider, LlmTurn, ToolSpec } from './provider.js';

export const DEFAULT_MODEL = 'claude-sonnet-5';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.model = opts?.model ?? process.env.CUA_MODEL ?? DEFAULT_MODEL;
    // Let the SDK resolve credentials itself. It tries ANTHROPIC_API_KEY, then
    // ANTHROPIC_AUTH_TOKEN, then a locally configured auth profile — so an
    // operator who has signed in with the CLI does not need a static key on
    // disk at all. Requiring the env var here would defeat that chain and
    // force the least secure of the three options.
    this.client = opts?.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic();
  }

  /**
   * Whether discovery can run at all. Checked up front so the CLI can fail
   * with an actionable message instead of opening a browser, driving halfway
   * through a flow, and only then discovering it has no model access.
   */
  static hasCredentials(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
  }

  async complete(input: { system: string; messages: LlmMessage[]; tools: ToolSpec[]; maxTokens?: number }): Promise<LlmTurn> {
    const messages = input.messages.map(toAnthropicMessage);
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: input.maxTokens ?? 2048,
      system: input.system,
      tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as never })),
      messages: messages as never,
    });

    let text = '';
    const toolCalls: LlmTurn['toolCalls'] = [];
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    return {
      text,
      toolCalls,
      stopReason: res.stop_reason ?? 'unknown',
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }
}

function toAnthropicMessage(m: LlmMessage): unknown {
  if (m.role === 'user') return { role: 'user', content: m.content };
  if (m.role === 'assistant') {
    const content: unknown[] = [];
    if (m.content.trim()) content.push({ type: 'text', text: m.content });
    for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
    return { role: 'assistant', content };
  }
  return {
    role: 'user',
    content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError ?? false })),
  };
}
