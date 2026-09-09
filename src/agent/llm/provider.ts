/**
 * The model seam.
 *
 * The LLM is used in exactly one place in this system — the discovery run — and
 * this interface is the whole of its API surface. Keeping it this narrow is
 * deliberate: it makes it structurally obvious that the replay path cannot
 * reach a model (there is nothing to reach), and it means swapping providers is
 * a one-file change rather than a refactor of the agent loop.
 *
 * We model the interaction as tool-calling rather than free-text parsing.
 * Free-text action parsing is the usual source of "the model said something we
 * could not execute" flakiness; a tool schema turns that into a provider-side
 * validation problem.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmTurn {
  /** The model's visible reasoning/commentary for this turn. Logged as evidence. */
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool-results'; results: Array<{ id: string; content: string; isError?: boolean }> };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(input: { system: string; messages: LlmMessage[]; tools: ToolSpec[]; maxTokens?: number }): Promise<LlmTurn>;
}
