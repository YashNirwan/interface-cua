/**
 * The replay result contract — what a calling AI agent actually receives.
 *
 * The central decision here is that there are FOUR terminal statuses, not two.
 * Most computer-use systems return success/failure, which forces the caller to
 * string-match error messages to find out whether the member simply does not
 * exist. That is the design mistake this contract exists to prevent.
 *
 *   success          the capability did what it says, here are the typed outputs
 *   business_outcome the app answered, and the answer is a declared, expected
 *                    one ("no such member", "insufficient funds"). Not an error.
 *                    The caller is expected to branch on `outcome.code`.
 *   escalated        we could not safely proceed and a human was (or must be)
 *                    brought in. Carries an intervention id so the caller can
 *                    follow up rather than retry blindly.
 *   failed           something is wrong with the automation or the app. Carries
 *                    enough structure to debug without re-running: which step,
 *                    what was expected, what was observed, where the evidence is.
 *
 * Recoverable conditions deliberately do NOT appear here. Dismissing a known
 * interstitial or riding out a slow load is not a result — it is something the
 * replayer did on the way to one. They are reported in `recoveries` for
 * observability, because a capability that suddenly needs three recoveries per
 * run is drifting even though it still passes.
 */

import type { ResolutionTier } from '../surface/types.js';

/**
 * Hard-failure taxonomy. Each class implies a different operator response,
 * which is the test for whether a taxonomy is earning its keep:
 *
 *   target_not_found      the UI changed, or we are on the wrong screen  -> re-record / investigate drift
 *   target_ambiguous      descriptor is under-specified                  -> tighten the artifact
 *   checkpoint_failed     the action did not have the expected effect    -> investigate app state
 *   guard_failed          we were not where the step expected to start   -> flow diverged earlier
 *   timeout               the app never reached a usable state           -> app health / capacity
 *   permission_denied     this operator account cannot do this           -> entitlements, not code
 *   session_expired       auth lapsed and could not be re-established    -> credential / SSO issue
 *   surface_error         the app itself errored (500, crash, disconnect)-> app incident
 *   policy_violation      the flow tried to leave its allowlist          -> security review, always loud
 *   extraction_failed     we got there but could not read a declared output
 *   invalid_input         caller's arguments failed the declared contract -> caller bug, fails fast
 *   internal              our bug
 */
export type FailureClass =
  | 'target_not_found'
  | 'target_ambiguous'
  | 'checkpoint_failed'
  | 'guard_failed'
  | 'timeout'
  | 'permission_denied'
  | 'session_expired'
  | 'surface_error'
  | 'policy_violation'
  | 'extraction_failed'
  | 'invalid_input'
  | 'internal';

/** Whether a caller should ever retry automatically. Kept out of the caller's head. */
export const RETRYABLE: Record<FailureClass, boolean> = {
  target_not_found: false,
  target_ambiguous: false,
  checkpoint_failed: false,
  guard_failed: false,
  timeout: true,
  permission_denied: false,
  session_expired: true,
  surface_error: true,
  policy_violation: false,
  extraction_failed: false,
  invalid_input: false,
  internal: false,
};

export interface StepTrace {
  stepId: string;
  intent: string;
  actionType: string;
  status: 'ok' | 'recovered' | 'failed' | 'skipped';
  startedAt: string;
  durationMs: number;
  /** How the control was found this time. */
  tier?: ResolutionTier;
  /**
   * True when the tier used was less semantic than the one recorded. The
   * capability still worked, but it is now leaning on a weaker signal — this is
   * our early warning for per-tenant/version drift, surfaced before it breaks.
   */
  tierDegraded?: boolean;
  note?: string;
}

export interface RecoveryTrace {
  name: string;
  atStepId: string;
  count: number;
}

export interface FailureDetail {
  class: FailureClass;
  message: string;
  stepId?: string;
  /** Human-readable description of the assertion that did not hold. */
  expected?: string;
  /** What we actually saw — the observation digest at the point of failure. */
  observed?: string;
  /** Candidate matches when a descriptor was ambiguous, for fast diagnosis. */
  candidates?: string[];
  retryable: boolean;
}

export interface EvidenceRef {
  runId: string;
  dir: string;
  logFile: string;
  /** Screenshot captured at the point of failure/escalation, sensitive fields masked. */
  failureScreenshot?: string;
  snapshot?: string;
}

export interface ReplayMeta {
  capabilityId: string;
  capabilityVersion: string;
  runId: string;
  tenantId: string | null;
  startedAt: string;
  durationMs: number;
  steps: StepTrace[];
  recoveries: RecoveryTrace[];
  /** True if any step resolved via a weaker tier than recorded. */
  driftDetected: boolean;
  evidence: EvidenceRef;
}

export type ReplayResult =
  | { status: 'success'; outputs: Record<string, unknown>; meta: ReplayMeta }
  | {
      status: 'business_outcome';
      outcome: { code: string; description: string; data: Record<string, unknown> };
      meta: ReplayMeta;
    }
  | {
      status: 'escalated';
      intervention: { id: string; reason: string; stepId?: string; consoleUrl?: string; resolution?: string };
      /** Outputs collected before the escalation, if any. */
      partialOutputs?: Record<string, unknown>;
      meta: ReplayMeta;
    }
  | { status: 'failed'; failure: FailureDetail; meta: ReplayMeta };

/** Compact one-line summary for logs and CLI output. */
export function summarize(r: ReplayResult): string {
  switch (r.status) {
    case 'success':
      return `success (${Object.keys(r.outputs).length} outputs, ${r.meta.steps.length} steps, ${r.meta.durationMs}ms)`;
    case 'business_outcome':
      return `business_outcome ${r.outcome.code}: ${r.outcome.description}`;
    case 'escalated':
      return `escalated ${r.intervention.id}: ${r.intervention.reason}`;
    case 'failed':
      return `failed [${r.failure.class}] at ${r.failure.stepId ?? '-'}: ${r.failure.message}`;
  }
}

/** Process exit codes, so shell/CI callers can branch without parsing JSON. */
export function exitCodeFor(r: ReplayResult): number {
  return { success: 0, business_outcome: 0, escalated: 3, failed: 1 }[r.status];
}
