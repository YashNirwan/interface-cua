/**
 * The escalation contract: what "I am stuck, get a human" looks like as data.
 *
 * Design intent, because this is the part that is easy to get superficially
 * right and substantively wrong:
 *
 *  1. An intervention request must be actionable WITHOUT reading code. An
 *     operator gets a plain-language summary, what we expected, what we saw,
 *     where we were, a masked screenshot, and a semantic snapshot. If a request
 *     needs a developer to interpret it, the escalation path is decorative.
 *
 *  2. The request declares what answers are legal (`allowedResolutions`). The
 *     set is decided by the *raiser*, which knows whether skipping is safe or
 *     whether the only sane answers are approve/abort. The console renders
 *     buttons from this list rather than always showing four, so an operator
 *     cannot pick an answer the run cannot honour.
 *
 *  3. A resolution carries `humanActions`: what the person actually did while
 *     they held the session. That is the audit answer to "the balance changed
 *     mid-run, who did it?" — and it is recorded as *shapes*, never values.
 *
 * SEAM — future queue/ticketing backend:
 * `EscalationBroker` is deliberately narrow and fully async, and every method is
 * keyed by an opaque string id. `LocalEscalationBroker` is the in-process
 * implementation, but nothing in the interface assumes the raiser and the
 * resolver share a process: `raise` is a durable write, `waitForResolution` is a
 * blocking read with a timeout, and `subscribe` is a change feed. A ServiceNow /
 * Jira / SQS implementation is a drop-in — `raise` creates a ticket, `subscribe`
 * tails a webhook, `waitForResolution` long-polls, `resolve` is the webhook
 * handler. The one thing that does NOT move across that boundary is the live
 * session itself; see `LocalEscalationBroker.escalate` and `SessionLease` for
 * how control transfer stays local to whoever holds the browser.
 */

import type { HumanAction } from '../surface/types.js';

export type EscalationReason =
  | 'stuck_no_progress' // discovery loop made no state change N times
  | 'risky_action_blocked' // policy needs a human decision on an irreversible step
  | 'unrecoverable_condition' // replay hit something no declared recovery handles
  | 'checkpoint_failed' // step did not have its expected effect
  | 'ambiguous_target' // descriptor matched several controls; needs a human eye
  | 'session_expired' // needs re-auth a human must perform
  | 'max_steps_exhausted'
  | 'operator_requested';

/** Status lifecycle: open -> (in_progress) -> resolved | abandoned. Terminal states are final. */
export type InterventionStatus = 'open' | 'in_progress' | 'resolved' | 'abandoned';

export interface InterventionContext {
  mode: 'discovery' | 'replay';
  capabilityId?: string;
  capabilityVersion?: string;
  goal?: string;
  stepId?: string;
  stepIntent?: string;
  /** What we asserted and what we saw. Redacted. */
  expected?: string;
  observed?: string;
  location: { uri: string; title: string };
  /** Relative path to a masked screenshot written by the RunLogger. */
  screenshot?: string;
  /** Compact semantic snapshot (role/name/section list), NOT raw HTML. */
  snapshot?: string;
}

export interface InterventionRequest {
  id: string; // e.g. int_<runId>_<n>
  runId: string;
  raisedAt: string;
  reason: EscalationReason;
  /** Plain-language explanation an operator can act on without reading code. */
  summary: string;
  context: InterventionContext;
  /** What the operator is allowed to answer with. */
  allowedResolutions: InterventionResolutionKind[];
  status: InterventionStatus;
}

export type InterventionResolutionKind =
  | 'resume' // I fixed the state by hand; carry on from the current step
  | 'skip' // skip the blocked step and continue
  | 'approve' // I authorise this risky action; you perform it
  | 'abort'; // stop the run

export interface InterventionResolution {
  kind: InterventionResolutionKind;
  resolvedAt: string;
  operator: string;
  note?: string;
  /** What the human did while holding the session. Redacted values only. */
  humanActions: HumanAction[];
}

/**
 * What a caller supplies when answering. `resolvedAt` and `humanActions` are
 * filled in by the broker — the broker is the only thing that knows what was
 * actually recorded on the session, and letting a caller assert its own action
 * list would make the audit trail forgeable.
 */
export interface ResolutionInput {
  kind: InterventionResolutionKind;
  operator: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Change feed
// ---------------------------------------------------------------------------

export type EscalationEvent =
  | { type: 'raised'; request: InterventionRequest }
  | { type: 'in_progress'; request: InterventionRequest }
  | { type: 'human_action'; request: InterventionRequest; action: HumanAction }
  | { type: 'resolved'; request: InterventionRequest; resolution: InterventionResolution }
  | { type: 'abandoned'; request: InterventionRequest; reason: string };

export type EscalationListener = (ev: EscalationEvent) => void;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when nobody answered in time. This is a distinct error class on
 * purpose: a run that escalated and was abandoned is operationally different
 * from a run that failed, and the caller must be able to tell them apart
 * without string-matching a message.
 */
export class EscalationTimeoutError extends Error {
  constructor(
    readonly interventionId: string,
    readonly timeoutMs: number,
  ) {
    super(`intervention ${interventionId} was not answered within ${timeoutMs}ms; abandoned and control returned to automation`);
    this.name = 'EscalationTimeoutError';
  }
}

/** Thrown for illegal transitions: unknown id, already-terminal, disallowed kind, wrong lease holder. */
export class EscalationStateError extends Error {
  constructor(
    readonly code: 'not_found' | 'already_terminal' | 'kind_not_allowed' | 'not_human_controlled' | 'no_surface',
    message: string,
  ) {
    super(message);
    this.name = 'EscalationStateError';
  }
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

export interface EscalationBroker {
  /** Persist a new request and publish it. Returns the stored form. */
  raise(req: InterventionRequest): Promise<InterventionRequest>;
  get(id: string): Promise<InterventionRequest | undefined>;
  list(filter?: { runId?: string; status?: InterventionStatus | InterventionStatus[] }): Promise<InterventionRequest[]>;
  /** Answer an open request. Idempotent-ish: answering a terminal request throws rather than silently winning. */
  resolve(id: string, input: ResolutionInput): Promise<InterventionResolution>;
  /**
   * Block until answered. Rejects with `EscalationTimeoutError` on timeout —
   * an unattended escalation must never hang a production run forever.
   */
  waitForResolution(id: string, timeoutMs: number): Promise<InterventionResolution>;
  /** Change feed. Returns an unsubscribe function. */
  subscribe(listener: EscalationListener): () => void;
}
