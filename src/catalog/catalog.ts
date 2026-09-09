/**
 * The agent-facing capability catalog.
 *
 * This is the payoff of the whole design: once a flow has been discovered and
 * recorded, it stops being "an automation script" and becomes a typed function
 * an AI agent can find by name and call with arguments — with no model in the
 * execution path and no knowledge of the UI on the caller's side.
 *
 * The catalog is generated FROM the artifacts rather than maintained alongside
 * them, so a capability's tool schema cannot drift from what it actually does.
 * `inputs` become the JSON Schema; `outputs` and `outcomes` become the
 * documented return contract, which matters more than it looks: an agent that
 * knows `MEMBER_NOT_FOUND` is a possible answer will handle it, whereas one
 * that only knows "this can fail" will retry a lookup that will never succeed.
 */

import type { Capability } from '../artifact/schema.js';
import type { CapabilityStore } from '../artifact/store.js';

export interface CapabilityTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  /** Not part of the tool-call protocol, but what a planning agent needs to reason. */
  returns: {
    outputs: Record<string, { type: string; description: string }>;
    businessOutcomes: Array<{ code: string; description: string }>;
  };
  meta: {
    version: string;
    status: Capability['status'];
    app: string;
    containsRiskyActions: boolean;
    unattendedSafe: boolean;
    stability?: { runs: number; successes: number };
  };
}

/** Artifact -> tool definition. */
export function toTool(cap: Capability): CapabilityTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, spec] of Object.entries(cap.inputs)) {
    // Secret-store parameters are deliberately absent from the tool schema.
    // The caller must not be able to supply a credential, and should not even
    // be told one exists — it is the runtime's job to fetch it.
    if (spec.source === 'secret-store') continue;
    const prop: Record<string, unknown> = {
      type: spec.type === 'money' || spec.type === 'number' ? 'number' : spec.type === 'boolean' ? 'boolean' : 'string',
      description: spec.description,
    };
    if (spec.pattern) prop.pattern = spec.pattern;
    if (spec.enum) prop.enum = spec.enum;
    if (spec.example) prop.examples = [spec.example];
    properties[name] = prop;
    if (spec.required && spec.default === undefined) required.push(name);
  }

  const outputs: CapabilityTool['returns']['outputs'] = {};
  for (const o of cap.outputs) outputs[o.name] = { type: o.type, description: o.description };

  return {
    name: cap.id,
    description: describeForAgent(cap),
    input_schema: { type: 'object', properties, required },
    returns: {
      outputs,
      businessOutcomes: cap.outcomes.map((o) => ({ code: o.code, description: o.description })),
    },
    meta: {
      version: cap.version,
      status: cap.status,
      app: `${cap.app.vendor}/${cap.app.product}`,
      containsRiskyActions: cap.policy.containsRiskyActions,
      unattendedSafe: isUnattendedSafe(cap),
      stability: cap.stability,
    },
  };
}

/**
 * A capability is safe to run unattended when it has no irreversible steps, or
 * when a human has approved it. This is the single field an orchestrating
 * agent should gate on, so the judgement lives in one place rather than being
 * re-derived by every caller.
 */
export function isUnattendedSafe(cap: Capability): boolean {
  if (cap.status === 'deprecated') return false;
  if (!cap.policy.containsRiskyActions) return cap.status === 'approved' || cap.stability.successes > 0;
  return cap.status === 'approved';
}

function describeForAgent(cap: Capability): string {
  const lines = [cap.summary];
  if (cap.outputs.length) {
    lines.push(`Returns: ${cap.outputs.map((o) => `${o.name} (${o.type})`).join(', ')}.`);
  }
  if (cap.outcomes.length) {
    lines.push(`May instead return one of these expected business outcomes: ${cap.outcomes.map((o) => o.code).join(', ')}.`);
  }
  if (cap.policy.containsRiskyActions) {
    lines.push('Performs an irreversible action; requires an approved artifact to run unattended.');
  }
  return lines.join(' ');
}

export class Catalog {
  constructor(private readonly store: CapabilityStore) {}

  /** Every callable capability as a tool definition. */
  tools(opts?: { unattendedOnly?: boolean }): CapabilityTool[] {
    return this.store
      .list()
      .filter((c) => c.status !== 'deprecated')
      .filter((c) => !opts?.unattendedOnly || isUnattendedSafe(c))
      .map(toTool);
  }

  find(name: string, version?: string): Capability | undefined {
    return this.store.get(name, version);
  }
}
