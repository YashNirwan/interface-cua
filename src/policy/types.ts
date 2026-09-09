/**
 * Guardrails.
 *
 * The design decision that matters here is placement: the policy gate is not a
 * helper the agent loop is supposed to remember to call. It wraps the Surface
 * itself (see GuardedSurface), so discovery, replay, and recovery all funnel
 * through the same choke point and no future code path can quietly skip it.
 * A guardrail you have to remember to invoke is a guardrail that eventually
 * is not invoked.
 */

import type { Action, ActionType } from '../surface/types.js';
import type { Sensitivity } from '../artifact/schema.js';

export interface PolicyConfig {
  /** Origins the automation may ever touch. Anything else is a hard stop. */
  allowedOrigins: string[];
  /** Glob-ish path patterns within those origins. `**` matches anything. */
  allowedPaths: string[];
  /** Action verbs permitted at all. */
  allowedActions: ActionType[];
  risky: {
    /**
     * Accessible-name substrings that mark a control as not-obviously-reversible.
     * Matching on the *accessible name* rather than a selector is deliberate:
     * the name is what a human operator reads before clicking, so it is the
     * same signal a reviewer would use, and it survives markup changes.
     */
    namePatterns: string[];
    /** What to do when the agent tries a risky action during discovery. */
    duringDiscovery: 'block' | 'escalate' | 'allow-and-flag';
    /** What to do at replay when the artifact is not approved. */
    duringReplayUnapproved: 'block' | 'escalate';
  };
  limits: {
    maxSteps: number;
    maxDurationMs: number;
    maxLlmCalls: number;
  };
  redaction: {
    /** Named regex patterns scrubbed from every log line and every artifact. */
    patterns: Record<string, string>;
  };
}

export type PolicyDecision =
  | { allow: true; risk: 'safe' | 'risky'; flagged?: string }
  | { allow: false; risk: 'safe' | 'risky'; code: PolicyDenialCode; reason: string };

export type PolicyDenialCode =
  | 'origin_not_allowed'
  | 'path_not_allowed'
  | 'action_not_allowed'
  | 'risky_action_blocked'
  | 'risky_action_needs_approval'
  | 'step_limit'
  | 'duration_limit';

export interface PolicyContext {
  /** 'discovery' is permissive-but-loud; 'replay' is strict. */
  mode: 'discovery' | 'replay';
  /** Whether a human has approved this capability for unattended risky steps. */
  approved: boolean;
  /** Origins the specific capability declares, intersected with the global list. */
  capabilityOrigins?: string[];
  stepsTaken: number;
  elapsedMs: number;
}

export interface PolicyGate {
  readonly config: PolicyConfig;
  /** Evaluate one action. Called for every action, from every code path. */
  evaluate(action: Action, ctx: PolicyContext, targetName?: string): PolicyDecision;
  /** Classify a control by accessible name, used at record time to set step.risk. */
  classifyRisk(actionType: ActionType, targetName: string | undefined): 'safe' | 'risky';
}

/** Thrown when the gate denies. Never caught-and-continued; always surfaces. */
export class PolicyViolationError extends Error {
  constructor(
    readonly code: PolicyDenialCode,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

export interface Redactor {
  /** Scrub free text (log lines, page text, model transcripts). */
  text(input: string): string;
  /** Redact a value according to its declared classification. */
  value(v: unknown, sensitivity: Sensitivity): unknown;
  /** Describe a value's shape without revealing it: "9 digits", "money". */
  shape(v: unknown): string;
  /** Deep-scrub an arbitrary object before it is written anywhere. */
  object<T>(o: T): T;
}
