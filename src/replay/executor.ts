/**
 * The replay engine.
 *
 * INVARIANT: there is no model in this file. No LLM SDK is imported here, none
 * is called transitively, and no code path consults one. Discovery is where a
 * model earns its keep — reading an unfamiliar screen and proposing a flow.
 * Replay is where it must be absent: an automation that re-derives its next
 * move each run is not reproducible, not auditable, not cheap, and not
 * defensible to a regulator asking why a transaction was posted on Tuesday.
 * Everything below is a deterministic interpreter for a reviewed data file.
 *
 * ---------------------------------------------------------------------------
 * The ordering IS the error taxonomy
 * ---------------------------------------------------------------------------
 *
 * Per step, in this exact order:
 *
 *   observe -> declared OUTCOMES -> declared RECOVERIES -> guard -> act
 *           -> checkpoint (with bounded assertion retries) -> onFailure
 *
 * Outcomes come first because "no such member" is an ANSWER, not an error. A
 * system that checks its checkpoint first reports that answer as
 * `checkpoint_failed: expected element "Account Summary" not found`, and the
 * calling agent — which now has to string-match an error message to find out
 * whether the member exists — will get it wrong. Outcome-before-checkpoint is
 * the single decision that keeps `business_outcome` a real status instead of a
 * decoration.
 *
 * Recoveries come second because an interstitial is not a result. If a "System
 * Notice" banner is covering the page, every other assertion below is being
 * evaluated against the wrong screen, and whatever it reports is noise.
 *
 * Guard comes third: before acting, confirm we are where the step believes it
 * starts. A guard failure means the flow diverged EARLIER, and saying so points
 * the investigation at the right step instead of this one.
 */

import type { Capability, Extraction, Outcome, Recovery, Step, StepAction } from '../artifact/schema.js';
import type {
  Action,
  ActResult,
  Observation,
  ResolutionTier,
  Surface,
  TargetDescriptor,
} from '../surface/types.js';
import { RESOLUTION_TIER_ORDER } from '../surface/types.js';
import { PolicyViolationError, type PolicyContext, type PolicyGate, type Redactor } from '../policy/types.js';
import type { RunLogger } from '../evidence/types.js';
import type { SessionLease } from '../escalation/lease.js';
import {
  RETRYABLE,
  type EvidenceRef,
  type FailureClass,
  type FailureDetail,
  type RecoveryTrace,
  type ReplayMeta,
  type ReplayResult,
  type StepTrace,
} from './result.js';
import { describeCondition, evaluate, type ConditionResult } from './conditions.js';
import { extractAll } from './extract.js';
import {
  UnboundPlaceholderError,
  bindCondition,
  bindDescriptor,
  bindExtractions,
  bindTemplate,
  describeBoundParams,
  validateInputs,
} from './params.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * The escalation seam, declared structurally rather than as the concrete broker.
 *
 * The executor needs exactly one verb from the escalation subsystem. Depending
 * on the class would couple the engine to a console, a queue and a persistence
 * story it has no opinion about — and would make this file untestable without
 * standing all of that up. A four-line port is the whole contract.
 */
export interface EscalationPort {
  escalate(opts: {
    reason: string;
    summary: string;
    context: Record<string, unknown>;
    allowedResolutions: string[];
  }): Promise<{ kind: string; note?: string; operator: string }>;
}

export interface ReplayDeps {
  /** Already wrapped in GuardedSurface by the caller. Policy + lease enforcement live there. */
  surface: Surface;
  gate: PolicyGate;
  lease: SessionLease;
  logger: RunLogger;
  redactor: Redactor;
  escalation?: EscalationPort;
  secrets?: (key: string) => string | undefined;
  /** Injectable clock, so durations in tests are deterministic. */
  now?: () => number;
}

export interface ReplayOptions {
  runId?: string;
  tenantId?: string | null;
  /** An out-of-band human authorisation for this invocation's risky steps. */
  approvedOverride?: boolean;
}

// ---------------------------------------------------------------------------
// Built-in surface conditions — the safety net
// ---------------------------------------------------------------------------

export interface BuiltInSurfaceCondition {
  readonly name: string;
  readonly failureClass: FailureClass;
  readonly pattern: RegExp;
  readonly why: string;
}

/**
 * Well-known legacy error surfaces, mapped to the failure class that implies
 * the right operator response.
 *
 * These are a SAFETY NET, not a substitute for declared outcomes. Declared
 * outcomes are checked first and always win, because a capability author who
 * has actually seen the app's session-timeout page can describe it far more
 * precisely than a generic regex, and can attach the extractions that make it
 * actionable. What this table buys is that an *undeclared* timeout still comes
 * back as `session_expired` (retryable: re-auth and try again) rather than
 * `checkpoint_failed` (not retryable: go read the artifact), which is the
 * difference between a self-healing pipeline and a 3am page.
 *
 * Order matters and mirrors the app's own precedence: an expired session
 * explains everything else on the screen, so it is tested first.
 */
export const BUILT_IN_CONDITIONS: readonly BuiltInSurfaceCondition[] = [
  {
    name: 'session-expired',
    failureClass: 'session_expired',
    pattern: /session (has )?(ended|expired)|sign on again|inactivity/i,
    why: 'auth lapsed; re-establish the session and retry — not a flow defect',
  },
  {
    name: 'permission-denied',
    failureClass: 'permission_denied',
    pattern: /not authoris?ed|permission denied|access denied|contact your security administrator/i,
    why: 'the operator account lacks an entitlement; fix entitlements, never retry',
  },
  {
    name: 'surface-error',
    failureClass: 'surface_error',
    pattern: /unhandled exception|internal server error|HTTP 500/i,
    why: 'the application itself failed; app incident, retryable once healthy',
  },
];

export function detectBuiltIn(obs: Observation): BuiltInSurfaceCondition | undefined {
  return BUILT_IN_CONDITIONS.find((c) => c.pattern.test(obs.text) || c.pattern.test(obs.location.title));
}

/** Classes that describe "the screen is not what we expected" and may be refined. */
const REFINABLE: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'checkpoint_failed',
  'guard_failed',
  'target_not_found',
  'target_ambiguous',
  'timeout',
  'extraction_failed',
]);

/**
 * Upgrade a generic "we are lost" class into a specific one when the page tells
 * us why. Never applied to `policy_violation` or `invalid_input`: those are
 * facts about US, and page text must not be able to reclassify them.
 */
function refineFailureClass(proposed: FailureClass, obs: Observation | null): { cls: FailureClass; note?: string } {
  if (obs === null || !REFINABLE.has(proposed)) return { cls: proposed };
  if (obs.degraded !== undefined) {
    return { cls: 'surface_error', note: `perception degraded: ${obs.degraded.reason}` };
  }
  const hit = detectBuiltIn(obs);
  if (hit === undefined) return { cls: proposed };
  return { cls: hit.failureClass, note: `built-in condition '${hit.name}' matched (${hit.why})` };
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

/** Assertion backoff. Short, bounded, and never applied to an action. */
const CHECKPOINT_BACKOFF_MS = [250, 500, 1000] as const;

/**
 * Hard cap on how many times a single step may be restarted by a recovery.
 * Budgets already bound this (every restart consumes recovery budget), but a
 * loop that depends on arithmetic elsewhere for its termination is a loop
 * waiting to become unbounded when somebody edits the arithmetic.
 */
const MAX_STEP_PASSES = 4;

interface ExecCtx {
  cap: Capability;
  deps: ReplayDeps;
  bound: Record<string, string>;
  runId: string;
  tenantId: string | null;
  startedAt: string;
  startMs: number;
  now: () => number;
  approved: boolean;
  steps: StepTrace[];
  recoveries: RecoveryTrace[];
  recoveryCounts: Map<string, number>;
  evidence: EvidenceRef;
  interventions: number;
  stepsTaken: number;
  /** Anything read before we stopped; attached to an `escalated` result. */
  partialOutputs: Record<string, unknown>;
}

function elapsed(ctx: ExecCtx): number {
  return ctx.now() - ctx.startMs;
}

function buildMeta(ctx: ExecCtx): ReplayMeta {
  return {
    capabilityId: ctx.cap.id,
    capabilityVersion: ctx.cap.version,
    runId: ctx.runId,
    tenantId: ctx.tenantId,
    startedAt: ctx.startedAt,
    durationMs: elapsed(ctx),
    steps: ctx.steps,
    recoveries: ctx.recoveries,
    driftDetected: ctx.steps.some((s) => s.tierDegraded === true),
    evidence: { ...ctx.evidence },
  };
}

function failureDetail(cls: FailureClass, message: string, extra: Partial<FailureDetail> = {}): FailureDetail {
  return { class: cls, message, retryable: RETRYABLE[cls], ...extra };
}

function policyContext(ctx: ExecCtx, approvedOverride = false): PolicyContext {
  return {
    mode: 'replay',
    approved: ctx.approved || approvedOverride,
    capabilityOrigins: ctx.cap.policy.allowedOrigins,
    stepsTaken: ctx.stepsTaken,
    elapsedMs: elapsed(ctx),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Observation helpers
// ---------------------------------------------------------------------------

async function observe(ctx: ExecCtx): Promise<Observation> {
  const obs = await ctx.deps.surface.observe();
  ctx.deps.logger.emit(
    'observe',
    {
      uri: ctx.deps.redactor.text(obs.location.uri),
      canonicalPath: obs.location.canonicalPath,
      title: ctx.deps.redactor.text(obs.location.title),
      nodes: obs.nodes.length,
      degraded: obs.degraded?.reason,
    },
    `observed ${obs.nodes.length} nodes`,
  );
  return obs;
}

/**
 * A short, redacted rendering of the current screen. This is the `observed`
 * half of every failure — the thing that lets someone diagnose without
 * re-running. It goes through the redactor because a failure digest is written
 * to disk and read by people who are not entitled to the account data on it.
 */
function digest(ctx: ExecCtx, obs: Observation): string {
  const text = ctx.deps.redactor.text(obs.text).replace(/\s+/g, ' ').trim();
  const head = text.length > 280 ? `${text.slice(0, 280)}…` : text;
  const where = obs.location.canonicalPath ?? ctx.deps.redactor.text(obs.location.uri);
  return `[${ctx.deps.redactor.text(obs.location.title)}] ${where} :: ${head}`;
}

/**
 * Capture evidence. Deliberately swallows its own errors: a screenshot that
 * fails must never replace the real failure with a capture failure, because the
 * real failure is the one somebody needs to read.
 */
async function captureEvidence(ctx: ExecCtx, name: string): Promise<void> {
  try {
    const cap = await ctx.deps.surface.capture({ maskSensitive: true });
    const paths = await ctx.deps.logger.saveCapture(name, cap);
    if (paths.screenshot !== undefined) ctx.evidence.failureScreenshot = paths.screenshot;
    if (paths.snapshot !== undefined) ctx.evidence.snapshot = paths.snapshot;
    ctx.deps.logger.emit('capture', { name, ...paths }, `captured evidence '${name}'`);
  } catch (err) {
    ctx.deps.logger.emit('error', { phase: 'capture', name, message: messageOf(err) }, 'evidence capture failed');
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function toAction(sa: StepAction, bound: Record<string, string>): Action {
  switch (sa.type) {
    case 'navigate':
      return { type: 'navigate', uri: bindTemplate(sa.uri, bound) };
    case 'click':
      return { type: 'click', target: { descriptor: bindDescriptor(sa.target, bound) } };
    case 'type':
      return {
        type: 'type',
        target: { descriptor: bindDescriptor(sa.target, bound) },
        text: bindTemplate(sa.text, bound),
        submit: sa.submit,
      };
    case 'select':
      return { type: 'select', target: { descriptor: bindDescriptor(sa.target, bound) }, value: bindTemplate(sa.value, bound) };
    case 'press':
      return { type: 'press', key: sa.key };
    case 'wait':
      return { type: 'wait', ms: sa.ms, forText: sa.forText === undefined ? undefined : bindTemplate(sa.forText, bound) };
  }
}

function descriptorOf(action: Action): TargetDescriptor | null {
  if (action.type === 'click' || action.type === 'type' || action.type === 'select') {
    return 'descriptor' in action.target ? action.target.descriptor : null;
  }
  return null;
}

/**
 * Map an ActResult error class onto the failure taxonomy. Surfaces report their
 * own vocabulary; this is the one place it is translated, so a new adapter
 * cannot invent a failure class the caller has never seen.
 */
function classifySurfaceError(cls: string | undefined, message: string): FailureClass {
  const s = `${cls ?? ''} ${message}`.toLowerCase();
  if (/timeout|timed out|deadline/.test(s)) return 'timeout';
  if (/ambiguous/.test(s)) return 'target_ambiguous';
  if (/not.?found|no such element|missing/.test(s)) return 'target_not_found';
  if (/session|expired|signed out/.test(s)) return 'session_expired';
  return 'surface_error';
}

/**
 * Evaluate the gate, then act.
 *
 * The GuardedSurface is the *enforcement* point — it wraps the surface so no
 * code path can reach an action without passing the gate, which is why the gate
 * is not merely a helper we remember to call. This pre-check is not a second
 * enforcement point; it exists so the executor can (a) apply the capability's
 * own step and duration budget using a live count the wrapper cannot see, and
 * (b) build a meaningful escalation context describing the action that is about
 * to be denied. Both evaluations call the same pure `gate.evaluate`, so they
 * cannot disagree about policy.
 */
async function performAction(
  ctx: ExecCtx,
  action: Action,
  label: string,
  approvedOverride = false,
): Promise<ActResult> {
  const target = descriptorOf(action);
  const targetName = target?.name;
  const decision = ctx.deps.gate.evaluate(action, policyContext(ctx, approvedOverride), targetName);
  ctx.deps.logger.emit(
    'policy.decision',
    {
      label,
      action: action.type,
      target: targetName === undefined ? undefined : ctx.deps.redactor.text(targetName),
      allow: decision.allow,
      risk: decision.risk,
      ...(decision.allow ? { flagged: decision.flagged } : { code: decision.code, reason: decision.reason }),
    },
    decision.allow ? `allowed ${action.type}` : `denied ${action.type}: ${decision.reason}`,
  );
  if (!decision.allow) throw new PolicyViolationError(decision.code, decision.reason);

  ctx.deps.logger.emit(
    'action',
    {
      label,
      type: action.type,
      target: targetName === undefined ? undefined : ctx.deps.redactor.text(targetName),
      // Typed text is never logged verbatim; only its shape. The value may be a
      // credential or an account number, and evidence is read by people who are
      // entitled to know that a value was entered, not what it was.
      valueShape: action.type === 'type' ? ctx.deps.redactor.shape(action.text) : undefined,
    },
    label,
  );

  return ctx.deps.surface.act(action);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

interface OutcomeHit {
  outcome: Outcome;
  describe: string;
}

/**
 * Detect a declared business outcome.
 *
 * `afterStep` scoping is what stops a global text match from firing mid-flow:
 * "No matching records" is a legitimate answer *after the search step* and a
 * red herring on the login page. `afterStepId` is the step whose action most
 * recently ran, so an outcome scoped to `search` is live from the moment
 * `search` acts until the next step acts.
 */
function detectOutcome(ctx: ExecCtx, obs: Observation, afterStepId: string | undefined): OutcomeHit | undefined {
  for (const outcome of ctx.cap.outcomes) {
    if (outcome.afterStep !== undefined && outcome.afterStep !== afterStepId) continue;
    const res = evaluate(bindCondition(outcome.detect, ctx.bound), obs);
    if (res.ok) return { outcome, describe: res.describe };
  }
  return undefined;
}

function businessOutcome(ctx: ExecCtx, hit: OutcomeHit, obs: Observation): ReplayResult {
  const { values, errors } = extractAll(bindExtractions(hit.outcome.extract, ctx.bound), obs);
  if (errors.length > 0) {
    // A missing decoration does not demote a clean business answer to a
    // failure. The caller asked "does this member exist?"; we know the answer.
    ctx.deps.logger.emit('error', { phase: 'outcome-extract', code: hit.outcome.code, errors }, 'outcome extraction incomplete');
  }
  ctx.deps.logger.emit(
    'outcome.detected',
    { code: hit.outcome.code, matchedOn: hit.describe, data: ctx.deps.redactor.object(values) },
    `business outcome: ${hit.outcome.code}`,
  );
  return {
    status: 'business_outcome',
    outcome: { code: hit.outcome.code, description: hit.outcome.description, data: values },
    meta: buildMeta(ctx),
  };
}

// ---------------------------------------------------------------------------
// Recoveries
// ---------------------------------------------------------------------------

interface RecoveryPass {
  obs: Observation;
  fired: boolean;
  retryStep: boolean;
  /** Name of the recovery that fired, for the step trace. */
  name?: string;
  /** A recovery matched but its budget is spent — we are stuck, deliberately. */
  blocked: Recovery | null;
  terminal?: ReplayResult;
}

/**
 * Run at most one matching recovery.
 *
 * `maxPerRun` is the reason this is a bounded interpreter and not an agent. A
 * recovery without a budget is a loop that dismisses the same dialog forever
 * and calls it progress; with one, the worst case is a fixed, small number of
 * pre-declared actions and then a clean stop. This is the only self-directed
 * behaviour anywhere in the replay path, and it is a reviewed list of verbs
 * from a signed-off artifact.
 */
async function runRecoveries(ctx: ExecCtx, obs: Observation, atStepId: string): Promise<RecoveryPass> {
  for (const recovery of ctx.cap.recoveries) {
    const res = evaluate(bindCondition(recovery.detect, ctx.bound), obs);
    if (!res.ok) continue;

    const used = ctx.recoveryCounts.get(recovery.name) ?? 0;
    if (used >= recovery.maxPerRun) {
      return { obs, fired: false, retryStep: false, blocked: recovery };
    }

    try {
      for (const [i, sa] of recovery.do.entries()) {
        await performAction(ctx, toAction(sa, ctx.bound), `recovery:${recovery.name}[${i}] ${sa.type}`);
      }
    } catch (err) {
      if (err instanceof PolicyViolationError) {
        /*
         * A recovery that trips the policy gate is a hard stop, and we
         * deliberately do NOT route it through the human-approval path the way
         * a risky *step* is routed. A recovery is supposed to be an
         * interstitial dismissal: something so mundane that a machine may do it
         * unattended. If it needs a human to approve it, it was never an
         * interstitial dismissal — it is a step, and it belongs in the reviewed
         * step list where a reader of the artifact can see it.
         */
        return {
          obs,
          fired: false,
          retryStep: false,
          blocked: null,
          terminal: {
            status: 'failed',
            failure: failureDetail(
              'policy_violation',
              `recovery '${recovery.name}' was denied by policy (${err.code}): ${err.message}`,
              { stepId: atStepId },
            ),
            meta: buildMeta(ctx),
          },
        };
      }
      throw err;
    }

    ctx.recoveryCounts.set(recovery.name, used + 1);
    const existing = ctx.recoveries.find((r) => r.name === recovery.name && r.atStepId === atStepId);
    if (existing !== undefined) existing.count += 1;
    else ctx.recoveries.push({ name: recovery.name, atStepId, count: 1 });

    ctx.deps.logger.emit(
      'recovery',
      { name: recovery.name, atStepId, attempt: used + 1, maxPerRun: recovery.maxPerRun, matchedOn: res.describe },
      `recovered: ${recovery.description}`,
    );

    const next = await observe(ctx);
    return { obs: next, fired: true, retryStep: recovery.retryStep, blocked: null, name: recovery.name };
  }

  return { obs, fired: false, retryStep: false, blocked: null };
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

type EscalationOutcome =
  | { available: false; why: string }
  | { available: true; id: string; kind: string; note?: string; operator: string };

async function escalate(
  ctx: ExecCtx,
  opts: { reason: string; summary: string; stepId?: string; context: Record<string, unknown>; allowed: string[] },
): Promise<EscalationOutcome> {
  const port = ctx.deps.escalation;
  if (port === undefined) {
    return { available: false, why: 'no escalation port configured for this run (unattended)' };
  }

  const id = `${ctx.runId}-int-${++ctx.interventions}`;

  // Capture BEFORE ceding control. The screen the automation stopped on is the
  // evidence; a human is about to change it, and once they have, the state that
  // caused the escalation no longer exists anywhere.
  await captureEvidence(ctx, `escalation-${id}`);

  ctx.deps.logger.emit(
    'escalation.raised',
    { id, reason: opts.reason, stepId: opts.stepId, allowed: opts.allowed, context: ctx.deps.redactor.object(opts.context) },
    `escalating: ${opts.summary}`,
  );

  // NOTE: we deliberately do NOT cede the lease here.
  //
  // Control transfer is owned by the escalation port, because the port is what
  // knows how to make the session usable by a person — it has to capture the
  // pre-handoff state, expose the session, and attach the human-action recorder
  // before anyone touches the screen. Ceding here as well would mean the broker
  // does its own evidence capture *after* control has already left automation,
  // and GuardedSurface would (correctly) reject those calls with a lease
  // violation. Two owners of a single-holder lease is not a race, it is a bug.
  //
  // What we keep is the guarantee below: whatever the port did, the executor
  // takes the session back before continuing.
  let resolution: { kind: string; note?: string; operator: string };
  try {
    resolution = await port.escalate({
      reason: opts.reason,
      summary: opts.summary,
      context: {
        interventionId: id,
        runId: ctx.runId,
        capabilityId: ctx.cap.id,
        capabilityVersion: ctx.cap.version,
        tenantId: ctx.tenantId,
        stepId: opts.stepId,
        evidenceDir: ctx.evidence.dir,
        ...opts.context,
      },
      allowedResolutions: opts.allowed,
    });
  } catch (err) {
    ctx.deps.logger.emit('error', { phase: 'escalation', id, message: messageOf(err) }, 'escalation broker failed');
    return { available: false, why: `escalation broker failed: ${messageOf(err)}` };
  } finally {
    // Always take the session back, on every path including abort. The lease is
    // single-holder; leaving it with the human would make dispose(), the final
    // capture, and any subsequent action throw LeaseViolationError and bury the
    // real reason we stopped.
    if (ctx.deps.lease.holder !== 'automation') {
      ctx.deps.lease.handBack(`intervention ${id} resolved`);
      ctx.deps.logger.emit('control.transfer', { to: 'automation', epoch: ctx.deps.lease.epoch, id }, 'session returned to automation');
    }
  }

  ctx.deps.logger.emit(
    'escalation.resolved',
    { id, kind: resolution.kind, operator: resolution.operator, note: resolution.note },
    `operator ${resolution.operator} resolved ${id} as '${resolution.kind}'`,
  );
  return { available: true, id, kind: resolution.kind, note: resolution.note, operator: resolution.operator };
}

function escalatedResult(
  ctx: ExecCtx,
  intervention: { id: string; reason: string; stepId?: string; resolution?: string },
): ReplayResult {
  return {
    status: 'escalated',
    intervention,
    partialOutputs: Object.keys(ctx.partialOutputs).length > 0 ? ctx.partialOutputs : undefined,
    meta: buildMeta(ctx),
  };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

function tierIndex(t: string | undefined): number {
  if (t === undefined) return -1;
  return RESOLUTION_TIER_ORDER.findIndex((x) => x === t);
}

/**
 * Drift detection.
 *
 * `RESOLUTION_TIER_ORDER` runs from most semantic (exact name inside its
 * section) to most positional (ordinal). A step that was recorded resolving at
 * `exact-name-in-section` and now resolves at `ordinal` still WORKS — and that
 * is precisely why it is worth reporting. The capability is now leaning on
 * "third thing on the page" instead of "the button labelled Search", so the
 * next cosmetic change breaks it. Degradation is the early warning we get
 * before a green run becomes a red one, and it is reported on a passing run.
 */
function isDegraded(used: ResolutionTier | undefined, recorded: string | undefined): boolean {
  const u = tierIndex(used);
  const r = tierIndex(recorded);
  return u >= 0 && r >= 0 && u > r;
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

type StepFlow = { kind: 'continue' } | { kind: 'terminal'; result: ReplayResult };

type ActionAttempt =
  | { kind: 'acted'; tier?: ResolutionTier }
  | { kind: 'failed'; detail: FailureDetail; obs: Observation | null }
  | { kind: 'needs-approval'; code: string; message: string };

/**
 * Resolve, then act.
 *
 * Resolving first costs one extra pass over an already-captured node list and
 * buys two things a blind act cannot: a `target_ambiguous` failure that carries
 * the candidate list (so the fix — add a `section` — is obvious from the
 * failure alone), and the tier that drives drift detection. It also means we
 * never fire an action at a control we could not name.
 */
async function attemptAction(ctx: ExecCtx, step: Step, approvedOverride = false): Promise<ActionAttempt> {
  const action = toAction(step.action, ctx.bound);
  const descriptor = descriptorOf(action);

  let tier: ResolutionTier | undefined;
  if (descriptor !== null) {
    const res = await ctx.deps.surface.resolve(descriptor);
    if (!res.ok) {
      const obs = await ctx.deps.surface.observe().catch(() => null);
      if (res.reason === 'ambiguous') {
        return {
          kind: 'failed',
          obs,
          detail: failureDetail(
            'target_ambiguous',
            `descriptor for step '${step.id}' matched ${res.candidates} controls via ${res.tier}; tighten it with a section or ordinal`,
            {
              stepId: step.id,
              expected: `exactly one ${descriptor.role} "${descriptor.name}"`,
              candidates: res.sample,
            },
          ),
        };
      }
      return {
        kind: 'failed',
        obs,
        detail: failureDetail(
          'target_not_found',
          `could not find ${descriptor.role} "${descriptor.name}" for step '${step.id}' (tried ${res.tried.join(' -> ')})`,
          { stepId: step.id, expected: `element ${descriptor.role} "${descriptor.name}"` },
        ),
      };
    }
    tier = res.tier;
  }

  try {
    const result = await performAction(ctx, action, `${step.id}: ${step.intent}`, approvedOverride);
    if (!result.ok) {
      const obs = await ctx.deps.surface.observe().catch(() => null);
      const cls = classifySurfaceError(result.error?.class, result.error?.message ?? '');
      return {
        kind: 'failed',
        obs,
        detail: failureDetail(cls, `step '${step.id}' action failed: ${result.error?.message ?? 'surface reported failure'}`, {
          stepId: step.id,
        }),
      };
    }
    return { kind: 'acted', tier: result.tier ?? tier };
  } catch (err) {
    if (err instanceof PolicyViolationError) {
      if (err.code === 'risky_action_needs_approval' || err.code === 'risky_action_blocked') {
        return { kind: 'needs-approval', code: err.code, message: err.message };
      }
      /*
       * Every other denial — origin, path, action verb, step and duration
       * budgets — is terminal and is NEVER offered to a human as an "approve?"
       * prompt. The allowlist is a boundary, not a question. A gate that can be
       * talked past by asking an operator at 2am, in a hurry, with a
       * one-sentence summary written by the thing that wants permission, is a
       * gate that will be talked past; and the specific thing it is holding
       * back — automation leaving the systems it was authorised for — is the
       * one failure mode with no bounded blast radius. Loud and non-negotiable.
       */
      const obs = await ctx.deps.surface.observe().catch(() => null);
      return {
        kind: 'failed',
        obs,
        detail: failureDetail('policy_violation', `step '${step.id}' denied by policy (${err.code}): ${err.message}`, {
          stepId: step.id,
        }),
      };
    }
    if (err instanceof UnboundPlaceholderError) throw err;
    if (err instanceof Error && err.name === 'LeaseViolationError') {
      return {
        kind: 'failed',
        obs: null,
        detail: failureDetail('internal', `control-lease violation during step '${step.id}': ${err.message}`, { stepId: step.id }),
      };
    }
    const obs = await ctx.deps.surface.observe().catch(() => null);
    const cls = classifySurfaceError(undefined, messageOf(err));
    return {
      kind: 'failed',
      obs,
      detail: failureDetail(cls, `step '${step.id}' threw: ${messageOf(err)}`, { stepId: step.id }),
    };
  }
}

async function terminalFailure(ctx: ExecCtx, detail: FailureDetail, obs: Observation | null): Promise<ReplayResult> {
  const refined = refineFailureClass(detail.class, obs);
  const final: FailureDetail = {
    ...detail,
    class: refined.cls,
    retryable: RETRYABLE[refined.cls],
    message: refined.note === undefined ? detail.message : `${detail.message} [${refined.note}]`,
    ...(detail.observed === undefined && obs !== null ? { observed: digest(ctx, obs) } : {}),
  };
  await captureEvidence(ctx, `failure-${final.class}${final.stepId === undefined ? '' : `-${final.stepId}`}`);
  ctx.deps.logger.emit('error', { ...final }, `failed [${final.class}] ${final.message}`);
  return { status: 'failed', failure: final, meta: buildMeta(ctx) };
}

/** One step, start to finish. */
async function runStep(ctx: ExecCtx, step: Step, prevStepId: string | undefined): Promise<StepFlow> {
  const t0 = ctx.now();
  const trace: StepTrace = {
    stepId: step.id,
    intent: step.intent,
    actionType: step.action.type,
    status: 'ok',
    startedAt: new Date(t0).toISOString(),
    durationMs: 0,
  };
  const commit = (status: StepTrace['status'], note?: string): void => {
    trace.status = status;
    trace.durationMs = ctx.now() - t0;
    if (note !== undefined) trace.note = note;
    ctx.steps.push(trace);
    ctx.deps.logger.emit('step.end', { stepId: step.id, status, durationMs: trace.durationMs, tier: trace.tier, tierDegraded: trace.tierDegraded, note }, `step ${step.id}: ${status}`);
  };

  ctx.deps.logger.emit('step.start', { stepId: step.id, intent: step.intent, action: step.action.type, risk: step.risk }, step.intent);

  for (let pass = 0; pass < MAX_STEP_PASSES; pass++) {
    // (a) observe
    let obs = await observe(ctx);

    // (b) declared outcomes FIRST — see the file header. An answer is not an error.
    const preOutcome = detectOutcome(ctx, obs, prevStepId);
    if (preOutcome !== undefined) {
      commit('ok', `business outcome '${preOutcome.outcome.code}' detected before acting`);
      return { kind: 'terminal', result: businessOutcome(ctx, preOutcome, obs) };
    }

    // (c) recoveries — clear interstitials before asserting anything about the screen
    const rec = await runRecoveries(ctx, obs, step.id);
    if (rec.terminal !== undefined) {
      commit('failed', 'recovery denied by policy');
      return { kind: 'terminal', result: rec.terminal };
    }
    if (rec.blocked !== null) {
      commit('failed', `recovery '${rec.blocked.name}' budget exhausted`);
      return { kind: 'terminal', result: await handleExhaustedRecovery(ctx, step, rec.blocked, obs) };
    }
    if (rec.fired) {
      obs = rec.obs;
      if (rec.retryStep) {
        // Before repeating the action, check whether clearing the interstitial
        // ALREADY produced this step's expected effect.
        //
        // This is not an optimisation. An interstitial commonly interrupts a
        // submission that the server already accepted — acknowledging a
        // maintenance notice then continues to the page the submit was heading
        // for. Blindly restarting the step would re-submit it. For a search
        // that is merely wasteful; for "Post Transaction" it is a duplicate
        // posting. The rule from the checkpoint loop applies with equal force
        // here: assertions may be repeated, actions may not.
        if (step.checkpoint !== undefined) {
          const already = evaluate(bindCondition(step.checkpoint, ctx.bound), obs);
          if (already.ok) {
            commit('recovered', `recovery '${rec.name ?? 'recovery'}' completed this step's effect; action not repeated`);
            return { kind: 'continue' };
          }
        }
        continue; // authored restart; see the note in the checkpoint loop
      }
    }

    // (d) guard
    if (step.guard !== undefined) {
      const guard = bindCondition(step.guard, ctx.bound);
      const res = evaluate(guard, obs);
      if (!res.ok) {
        commit('failed', 'guard failed');
        return {
          kind: 'terminal',
          result: await terminalFailure(
            ctx,
            failureDetail('guard_failed', `step '${step.id}' precondition did not hold — the flow diverged before this step`, {
              stepId: step.id,
              expected: describeCondition(guard),
              observed: digest(ctx, obs),
            }),
            obs,
          ),
        };
      }
    }

    // (e) act
    ctx.stepsTaken += 1;

    /*
     * The artifact's own risk declaration is authoritative, and is checked
     * BEFORE the action is attempted.
     *
     * The policy gate classifies risk from the control's accessible name,
     * which is a good backstop for irreversible actions nobody flagged. But it
     * cannot catch the dangerous case: a button labelled "OK" that posts a
     * wire transfer. `step.risk` is set at record time and survives human
     * review, so a reviewer who marks a step irreversible must be able to rely
     * on that mark holding regardless of what the button happens to say.
     * Heuristic as safety net, declaration as the control.
     */
    let attempt: Awaited<ReturnType<typeof attemptAction>>;
    if (step.risk === 'risky' && !ctx.approved) {
      attempt = {
        kind: 'needs-approval',
        code: 'risky_action_blocked',
        message: `step '${step.id}' is declared risky in the artifact and this capability is not approved for unattended risky actions`,
      };
    } else {
      attempt = await attemptAction(ctx, step);
    }

    if (attempt.kind === 'needs-approval') {
      const decision = await escalate(ctx, {
        reason: 'risky_action_blocked',
        summary: `step '${step.id}' (${step.intent}) is classified risky and this capability is not approved for unattended risky actions`,
        stepId: step.id,
        context: { intent: step.intent, action: step.action.type, code: attempt.code, capabilityStatus: ctx.cap.status },
        allowed: ['approve', 'skip', 'abort'],
      });

      if (!decision.available) {
        commit('failed', 'risky action blocked, no operator available');
        return {
          kind: 'terminal',
          result: await terminalFailure(
            ctx,
            failureDetail('policy_violation', `step '${step.id}' needs human approval but none could be obtained: ${decision.why}`, {
              stepId: step.id,
            }),
            obs,
          ),
        };
      }

      if (decision.kind === 'abort') {
        commit('failed', `operator aborted at ${decision.id}`);
        return { kind: 'terminal', result: escalatedResult(ctx, { id: decision.id, reason: 'risky_action_blocked', stepId: step.id, resolution: 'abort' }) };
      }
      if (decision.kind === 'skip') {
        commit('skipped', `operator skipped this step (${decision.id})`);
        return { kind: 'continue' };
      }
      // 'approve' (or 'resume', treated as approve here): re-run the action ONCE.
      attempt = await attemptAction(ctx, step, true);
      if (attempt.kind === 'needs-approval') {
        /*
         * The wrapper refused despite the operator's approval. This is an
         * honest report of a real seam rather than something to paper over:
         * the executor's `approvedOverride` is ADVISORY, and the GuardedSurface
         * holds the authoritative PolicyContext. That ordering is correct — a
         * guardrail the guarded thing can switch off is not a guardrail — so
         * when the two disagree, the wrapper wins and we say exactly why.
         */
        commit('failed', 'approval not honoured by the guarded surface');
        return {
          kind: 'terminal',
          result: escalatedResult(ctx, {
            id: decision.id,
            reason: 'risky_action_blocked: operator approved but the guarded surface still denied the action; the run-level policy context must be updated to grant approval',
            stepId: step.id,
            resolution: 'approve',
          }),
        };
      }
    }

    if (attempt.kind === 'failed') {
      /*
       * One documented extension to `onFailure`, which the schema scopes to
       * checkpoints: a step whose author declared it tolerable to fail cannot
       * be tolerable if the absence of its control is fatal. "Dismiss the
       * welcome banner if it is there" is exactly a `continue` step, and the
       * banner not being there is exactly `target_not_found`.
       */
      if (attempt.detail.class === 'target_not_found' && step.onFailure === 'continue') {
        commit('skipped', 'target absent and step declares onFailure:continue');
        return { kind: 'continue' };
      }
      commit('failed', attempt.detail.class);
      return { kind: 'terminal', result: await terminalFailure(ctx, attempt.detail, attempt.obs) };
    }

    // Drift is recorded on the trace, not raised as an event: it is a property
    // of a step that SUCCEEDED, and `step.end` already carries both tiers.
    trace.tier = attempt.tier;
    trace.tierDegraded = isDegraded(attempt.tier, step.recordedTier);

    // (f) + (g)
    const verdict = await settleCheckpoint(ctx, step, trace);
    if (verdict.kind === 'restart') continue;
    if (verdict.kind === 'terminal') {
      commit(verdict.traceStatus, verdict.note);
      return { kind: 'terminal', result: verdict.result };
    }
    commit(verdict.traceStatus, verdict.note);
    return { kind: 'continue' };
  }

  commit('failed', 'step restart limit reached');
  return {
    kind: 'terminal',
    result: await terminalFailure(
      ctx,
      failureDetail('checkpoint_failed', `step '${step.id}' was restarted ${MAX_STEP_PASSES} times by recoveries without settling`, {
        stepId: step.id,
      }),
      null,
    ),
  };
}

type CheckpointVerdict =
  | { kind: 'settled'; traceStatus: StepTrace['status']; note?: string }
  | { kind: 'restart' }
  | { kind: 'terminal'; result: ReplayResult; traceStatus: StepTrace['status']; note?: string };

/**
 * Wait for the checkpoint, then decide what a failure means.
 *
 * The retry policy here is the load-bearing distinction in the whole engine:
 *
 *   We retry the ASSERTION. Re-observing after 250ms costs nothing, changes
 *   nothing, and is exactly right for a legacy app that took another beat to
 *   render a frame.
 *
 *   We never retry the ACTION. `click Post Transaction` is not idempotent, and
 *   an engine that re-clicks on a slow response is an engine that posts a
 *   transaction twice. There is no way to tell "the click was lost" from "the
 *   click worked and the confirmation is slow" by looking at the screen, so the
 *   safe reading of an ambiguous state is always the one that does not act
 *   again.
 *
 *   The single exception is authored, not inferred: a Recovery may set
 *   `retryStep: true`, which restarts the step. That is legitimate because a
 *   human wrote it against a specific interstitial they watched swallow the
 *   original action — the engine still never decides on its own to act twice.
 *
 * Outcomes and recoveries are re-checked between assertion retries, because the
 * most common thing a slow screen resolves into is a declared outcome.
 */
async function settleCheckpoint(ctx: ExecCtx, step: Step, trace: StepTrace): Promise<CheckpointVerdict> {
  let obs = await observe(ctx);

  const scoped = detectOutcome(ctx, obs, step.id);
  if (scoped !== undefined) {
    return { kind: 'terminal', result: businessOutcome(ctx, scoped, obs), traceStatus: 'ok', note: `business outcome '${scoped.outcome.code}'` };
  }

  if (step.checkpoint === undefined) {
    // A step with no checkpoint is a step that assumes its click worked. The
    // schema allows it; we record that we could not verify it, so a reviewer
    // reading the trace can see which steps are unverified.
    return { kind: 'settled', traceStatus: 'ok', note: 'no checkpoint declared (unverified)' };
  }

  const checkpoint = bindCondition(step.checkpoint, ctx.bound);
  let last: ConditionResult = evaluate(checkpoint, obs);
  let attempt = 0;

  while (!last.ok && attempt < step.retries) {
    const wait = CHECKPOINT_BACKOFF_MS[Math.min(attempt, CHECKPOINT_BACKOFF_MS.length - 1)] ?? 1000;
    await sleep(wait);
    attempt += 1;
    obs = await observe(ctx);

    const hit = detectOutcome(ctx, obs, step.id);
    if (hit !== undefined) {
      return { kind: 'terminal', result: businessOutcome(ctx, hit, obs), traceStatus: 'ok', note: `business outcome '${hit.outcome.code}'` };
    }

    const rec = await runRecoveries(ctx, obs, step.id);
    if (rec.terminal !== undefined) return { kind: 'terminal', result: rec.terminal, traceStatus: 'failed', note: 'recovery denied by policy' };
    if (rec.blocked !== null) {
      return {
        kind: 'terminal',
        result: await handleExhaustedRecovery(ctx, step, rec.blocked, obs),
        traceStatus: 'failed',
        note: `recovery '${rec.blocked.name}' budget exhausted`,
      };
    }
    if (rec.fired) {
      obs = rec.obs;
      trace.status = 'recovered';
      if (rec.retryStep) {
        // Same rule as the pre-step recovery path: an interstitial usually
        // interrupts the *rendering* of an action the server already accepted,
        // so clearing it often lands us exactly where the step was going. Check
        // the assertion before repeating a non-idempotent action.
        last = evaluate(checkpoint, obs);
        if (last.ok) {
          ctx.deps.logger.emit(
            'recovery',
            { stepId: step.id, recovery: rec.name, restarted: false },
            `recovery '${rec.name ?? 'recovery'}' completed this step's effect; action not repeated`,
          );
          return { kind: 'settled', traceStatus: 'recovered' };
        }
        return { kind: 'restart' };
      }
    }

    last = evaluate(checkpoint, obs);
  }

  if (last.ok) {
    ctx.deps.logger.emit('checkpoint', { stepId: step.id, ok: true, attempts: attempt + 1, describe: last.describe }, `checkpoint held: ${last.describe}`);
    return { kind: 'settled', traceStatus: trace.status === 'recovered' ? 'recovered' : 'ok' };
  }

  ctx.deps.logger.emit(
    'checkpoint',
    { stepId: step.id, ok: false, attempts: attempt + 1, describe: last.describe, detail: last.detail },
    `checkpoint failed: ${last.describe}`,
  );

  // (g) onFailure
  if (step.onFailure === 'continue') {
    return { kind: 'settled', traceStatus: 'skipped', note: `checkpoint failed but step declares onFailure:continue — ${last.describe}` };
  }

  if (step.onFailure === 'escalate') {
    const decision = await escalate(ctx, {
      reason: 'checkpoint_failed',
      summary: `step '${step.id}' (${step.intent}) did not reach its expected state after ${attempt + 1} attempts`,
      stepId: step.id,
      context: { expected: describeCondition(checkpoint), observed: digest(ctx, obs), detail: last.detail },
      allowed: ['resume', 'skip', 'abort'],
    });

    if (decision.available) {
      if (decision.kind === 'skip') {
        return { kind: 'settled', traceStatus: 'skipped', note: `operator skipped after checkpoint failure (${decision.id})` };
      }
      if (decision.kind === 'resume') {
        // The operator may have fixed the state by hand. Re-observe and give the
        // assertion exactly one more chance — no more, because an operator who
        // says "resume" on a screen that still fails has told us something
        // useful, and quietly looping would throw that information away.
        const after = await observe(ctx);
        const recheck = evaluate(checkpoint, after);
        if (recheck.ok) {
          return { kind: 'settled', traceStatus: 'recovered', note: `operator resolved by hand (${decision.id})` };
        }
        return {
          kind: 'terminal',
          traceStatus: 'failed',
          note: 'checkpoint still failing after operator resume',
          result: await terminalFailure(
            ctx,
            failureDetail('checkpoint_failed', `step '${step.id}' checkpoint still failed after operator resume (${decision.id})`, {
              stepId: step.id,
              expected: describeCondition(checkpoint),
              observed: digest(ctx, after),
            }),
            after,
          ),
        };
      }
      // abort
      return {
        kind: 'terminal',
        traceStatus: 'failed',
        note: `operator aborted (${decision.id})`,
        result: escalatedResult(ctx, { id: decision.id, reason: 'checkpoint_failed', stepId: step.id, resolution: 'abort' }),
      };
    }
    // No operator: fall through to a hard failure rather than hanging.
    ctx.deps.logger.emit('error', { phase: 'escalation', stepId: step.id, why: decision.why }, 'escalation unavailable; failing');
  }

  return {
    kind: 'terminal',
    traceStatus: 'failed',
    note: 'checkpoint_failed',
    result: await terminalFailure(
      ctx,
      failureDetail('checkpoint_failed', `step '${step.id}' did not reach its expected state after ${attempt + 1} attempt(s)`, {
        stepId: step.id,
        expected: describeCondition(checkpoint),
        observed: digest(ctx, obs),
      }),
      obs,
    ),
  };
}

/**
 * A matching recovery with a spent budget means we know exactly what is on the
 * screen and know we cannot clear it. Unlike a checkpoint failure this is NOT
 * routed through `onFailure: 'continue'` — continuing past a modal we just
 * failed to dismiss would send every subsequent step into a dialog.
 */
async function handleExhaustedRecovery(ctx: ExecCtx, step: Step, recovery: Recovery, obs: Observation): Promise<ReplayResult> {
  const decision = await escalate(ctx, {
    reason: 'recovery_exhausted',
    summary: `recovery '${recovery.name}' matched again at step '${step.id}' but has used its budget of ${recovery.maxPerRun}`,
    stepId: step.id,
    context: { recovery: recovery.name, description: recovery.description, maxPerRun: recovery.maxPerRun, observed: digest(ctx, obs) },
    // No 'skip' here, deliberately. Skipping past a modal we just failed to
    // dismiss would send every remaining step into a dialog, and offering a
    // resolution we would then have to ignore is worse than not offering it.
    allowed: ['resume', 'abort'],
  });

  if (decision.available && decision.kind === 'resume') {
    const after = await observe(ctx);
    const still = evaluate(bindCondition(recovery.detect, ctx.bound), after);
    if (!still.ok) {
      // Cleared by hand. Fail the step anyway? No — the blocking condition is
      // gone, so the honest thing is to let the caller retry the capability
      // rather than pretend a step we never completed succeeded.
      return await terminalFailure(
        ctx,
        failureDetail('checkpoint_failed', `recovery '${recovery.name}' was cleared by an operator; re-run the capability from a clean state`, {
          stepId: step.id,
        }),
        after,
      );
    }
  }
  if (decision.available && decision.kind === 'abort') {
    return escalatedResult(ctx, { id: decision.id, reason: 'recovery_exhausted', stepId: step.id, resolution: 'abort' });
  }

  return await terminalFailure(
    ctx,
    failureDetail(
      'checkpoint_failed',
      `recovery '${recovery.name}' exhausted its budget (${recovery.maxPerRun}/run) and the condition it clears is still present — ` +
        'this is an unbounded-loop stop, not a transient failure',
      { stepId: step.id, expected: `absence of: ${recovery.description}`, observed: digest(ctx, obs) },
    ),
    obs,
  );
}

// ---------------------------------------------------------------------------
// Run-level phases
// ---------------------------------------------------------------------------

/** Open the capability's entry point. Returns a terminal result, or null to proceed. */
async function openEntry(ctx: ExecCtx): Promise<ReplayResult | null> {
  const uri = bindTemplate(ctx.cap.entry.uri, ctx.bound);
  try {
    const res = await performAction(ctx, { type: 'navigate', uri }, `entry: ${ctx.cap.entry.uri}`);
    if (res.ok) return null;
    return await terminalFailure(
      ctx,
      failureDetail(
        classifySurfaceError(res.error?.class, res.error?.message ?? ''),
        `could not open entry point: ${res.error?.message ?? 'navigation failed'}`,
      ),
      await ctx.deps.surface.observe().catch(() => null),
    );
  } catch (err) {
    if (err instanceof PolicyViolationError) {
      return await terminalFailure(
        ctx,
        failureDetail('policy_violation', `entry point ${ctx.deps.redactor.text(uri)} denied by policy (${err.code}): ${err.message}`),
        null,
      );
    }
    throw err;
  }
}

/**
 * The capability's own declared envelope, enforced with a live count the
 * GuardedSurface's PolicyContext cannot see. Budget exhaustion is classified as
 * a policy stop and is deliberately loud: an automation that runs past the
 * envelope its own artifact declared is a containment failure, not a slow page.
 */
async function checkBudget(ctx: ExecCtx, step: Step): Promise<ReplayResult | null> {
  if (ctx.stepsTaken >= ctx.cap.policy.maxSteps) {
    return await terminalFailure(
      ctx,
      failureDetail('policy_violation', `step budget exhausted (${ctx.cap.policy.maxSteps}) before step '${step.id}'`, { stepId: step.id }),
      null,
    );
  }
  if (elapsed(ctx) > ctx.cap.policy.maxDurationMs) {
    return await terminalFailure(
      ctx,
      failureDetail('policy_violation', `duration budget exhausted (${ctx.cap.policy.maxDurationMs}ms) before step '${step.id}'`, { stepId: step.id }),
      null,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

export async function replay(
  cap: Capability,
  args: Record<string, unknown>,
  deps: ReplayDeps,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const now = deps.now ?? ((): number => Date.now());
  const startMs = now();
  const runId = opts.runId ?? deps.logger.runId;
  const tenantId = opts.tenantId !== undefined ? opts.tenantId : cap.tenantId;

  const ctx: ExecCtx = {
    cap,
    deps,
    bound: {},
    runId,
    tenantId,
    startedAt: new Date(startMs).toISOString(),
    startMs,
    now,
    approved: opts.approvedOverride === true || cap.status === 'approved',
    steps: [],
    recoveries: [],
    recoveryCounts: new Map(),
    evidence: { runId, dir: deps.logger.dir, logFile: deps.logger.logFile },
    interventions: 0,
    stepsTaken: 0,
    partialOutputs: {},
  };

  const conclude = async (result: ReplayResult): Promise<ReplayResult> => {
    await deps.logger.finish(result);
    return result;
  };

  // --- 0. A deprecated capability is not callable. Cheapest possible stop. ---
  if (cap.status === 'deprecated') {
    return conclude({
      status: 'failed',
      failure: failureDetail('invalid_input', `capability ${cap.id}@${cap.version} is deprecated and not callable`),
      meta: buildMeta(ctx),
    });
  }

  // --- 1. Validate inputs BEFORE opening anything. ---
  const validation = validateInputs(cap, args, deps.secrets ?? ((): undefined => undefined));
  if (!validation.ok) {
    // Redacted: a validation message may quote the caller's value, and the same
    // string is about to be written to the evidence log.
    const errors = validation.errors.map((e) => deps.redactor.text(e));
    deps.logger.emit('error', { class: 'invalid_input', errors }, `invalid input for ${cap.id}`);
    return conclude({
      status: 'failed',
      failure: failureDetail('invalid_input', `input validation failed: ${errors.join('; ')}`),
      meta: buildMeta(ctx),
    });
  }
  ctx.bound = validation.bound;

  try {
    deps.lease.assertHolds('automation', `replay ${cap.id}`);

    // --- 2. Approval posture. ---
    /*
     * A risky-but-unapproved capability is NOT refused up front. It runs its
     * safe prefix and escalates at the exact moment the risky action is
     * attempted. Two reasons: the operator being asked to approve gets to see
     * the real screen the action would land on, rather than a hypothetical
     * described before anything loaded; and the safe prefix often produces the
     * information that makes the approval decision easy. Refusing at t=0 would
     * force approval to be granted blind, which is worse governance dressed up
     * as more caution.
     */
    if (cap.policy.containsRiskyActions && !ctx.approved) {
      deps.logger.emit(
        'policy.decision',
        { capability: cap.id, status: cap.status, approved: false, containsRiskyActions: true },
        'capability contains risky steps and is not approved: the safe prefix will run and the first risky action will escalate',
      );
    }

    // --- 3. run.start ---
    deps.logger.emit(
      'run.start',
      {
        capabilityId: cap.id,
        capabilityVersion: cap.version,
        tenantId,
        status: cap.status,
        approved: ctx.approved,
        params: describeBoundParams(cap, ctx.bound, deps.redactor),
        steps: cap.steps.length,
      },
      `replaying ${cap.id}@${cap.version}${tenantId === null ? '' : ` for ${tenantId}`}`,
    );

    // --- 4. Navigate to the entry point. ---
    const entryFailure = await openEntry(ctx);
    if (entryFailure !== null) return conclude(entryFailure);

    // --- 5. Steps. ---
    let prevStepId: string | undefined;
    for (const step of cap.steps) {
      const budget = await checkBudget(ctx, step);
      if (budget !== null) return conclude(budget);

      const flow = await runStep(ctx, step, prevStepId);
      if (flow.kind === 'terminal') return conclude(flow.result);
      prevStepId = step.id;
    }

    // --- 6 + 7. Final assertion, then the typed contract. ---
    const finalObs = await observe(ctx);

    // Outcomes still win at the end: a capability whose last screen is
    // "insufficient funds" answered the caller's question.
    const finalOutcome = detectOutcome(ctx, finalObs, prevStepId);
    if (finalOutcome !== undefined) return conclude(businessOutcome(ctx, finalOutcome, finalObs));

    const success = bindCondition(cap.success, ctx.bound);
    const verdict = evaluate(success, finalObs);
    if (!verdict.ok) {
      return conclude(
        await terminalFailure(
          ctx,
          failureDetail('checkpoint_failed', `every step ran but the capability's success condition did not hold`, {
            expected: describeCondition(success),
            observed: digest(ctx, finalObs),
          }),
          finalObs,
        ),
      );
    }
    deps.logger.emit('checkpoint', { final: true, ok: true, describe: verdict.describe }, `success condition held: ${verdict.describe}`);

    const outputs = extractAll(bindExtractions(cap.outputs, ctx.bound), finalObs);
    ctx.partialOutputs = outputs.values;
    deps.logger.emit(
      'extract',
      {
        values: redactOutputs(cap.outputs, outputs.values, deps.redactor),
        missing: outputs.errors.length,
      },
      `extracted ${Object.keys(outputs.values).length} output(s)`,
    );

    if (outputs.errors.length > 0) {
      /*
       * Reaching the right screen but failing to read a declared output is a
       * FAILURE, not a success with nulls. The capability's promise is its
       * output contract; a caller that receives `{ balance: null, status:
       * 'success' }` has been told the automation worked, and will either
       * propagate a null into a decision or write the null-check that the typed
       * contract existed to make unnecessary. Half a contract is worse than a
       * clean, retryable stop that names the field.
       */
      return conclude(
        await terminalFailure(
          ctx,
          failureDetail('extraction_failed', `reached the success state but could not satisfy the output contract: ${outputs.errors.join('; ')}`, {
            expected: cap.outputs.filter((o) => o.required).map((o) => o.name).join(', '),
            observed: digest(ctx, finalObs),
          }),
          finalObs,
        ),
      );
    }

    return conclude({ status: 'success', outputs: outputs.values, meta: buildMeta(ctx) });
  } catch (err) {
    if (err instanceof UnboundPlaceholderError) {
      // A template referenced a parameter nobody bound: either the caller
      // omitted an optional-with-no-default, or the artifact is wrong. Either
      // way it is an input-contract problem, and the message names the exact
      // placeholder.
      return conclude({
        status: 'failed',
        failure: failureDetail('invalid_input', err.message),
        meta: buildMeta(ctx),
      });
    }
    if (err instanceof PolicyViolationError) {
      return conclude(await terminalFailure(ctx, failureDetail('policy_violation', `${err.code}: ${err.message}`), null));
    }
    return conclude(await terminalFailure(ctx, failureDetail('internal', `unhandled error in replay: ${messageOf(err)}`), null));
  }
}

function redactOutputs(specs: Extraction[], values: Record<string, unknown>, redactor: Redactor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    if (!(spec.name in values)) continue;
    out[spec.name] = redactor.value(values[spec.name], spec.sensitivity);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stability
// ---------------------------------------------------------------------------

export interface StabilityReport {
  runs: number;
  successes: number;
  outcomes: Record<string, number>;
  failures: Record<string, number>;
  /** Fraction of runs that disagreed with the most common terminal signature. */
  flakeRate: number;
}

/**
 * Replay N times and report a stability signal. Used by `cua verify`.
 *
 * `flakeRate` measures INCONSISTENCY, not failure. A capability that returns
 * `business_outcome: no_such_member` on all ten runs is perfectly stable — it
 * is answering a question correctly and repeatably — and scoring it as 100%
 * flaky would make the metric punish the thing the contract exists to support.
 * So we bucket every run by its terminal signature (`success`,
 * `business_outcome:CODE`, `failed:CLASS`) and report the fraction that
 * disagreed with the plurality. That is the number that actually predicts
 * whether unattended use is safe.
 */
export async function verifyStability(
  cap: Capability,
  args: Record<string, unknown>,
  makeDeps: () => Promise<ReplayDeps>,
  runs: number,
): Promise<StabilityReport> {
  const outcomes: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const signatures: Record<string, number> = {};
  let successes = 0;

  for (let i = 0; i < runs; i++) {
    const deps = await makeDeps();
    let signature: string;
    try {
      const result = await replay(cap, args, deps, { runId: `${deps.logger.runId}` });
      switch (result.status) {
        case 'success':
          successes += 1;
          signature = 'success';
          break;
        case 'business_outcome':
          outcomes[result.outcome.code] = (outcomes[result.outcome.code] ?? 0) + 1;
          signature = `business_outcome:${result.outcome.code}`;
          break;
        case 'escalated':
          signature = 'escalated';
          failures['escalated'] = (failures['escalated'] ?? 0) + 1;
          break;
        case 'failed':
          failures[result.failure.class] = (failures[result.failure.class] ?? 0) + 1;
          signature = `failed:${result.failure.class}`;
          break;
      }
    } catch (err) {
      // replay is written not to throw; if it does, that is our bug and it must
      // be counted, not swallowed, or verification would report a clean sheet.
      failures['internal'] = (failures['internal'] ?? 0) + 1;
      signature = `failed:internal:${messageOf(err)}`;
    } finally {
      await deps.surface.dispose().catch(() => undefined);
    }
    signatures[signature] = (signatures[signature] ?? 0) + 1;
  }

  const plurality = Math.max(0, ...Object.values(signatures));
  const flakeRate = runs === 0 ? 0 : (runs - plurality) / runs;
  return { runs, successes, outcomes, failures, flakeRate };
}
