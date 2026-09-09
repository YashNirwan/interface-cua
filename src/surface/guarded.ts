/**
 * GuardedSurface — the enforcement choke point.
 *
 * The rest of the system is never handed a raw Surface. Discovery, replay and
 * recovery all receive one of these, so there is no code path — present or
 * future — that can act on the session without passing the session lease, the
 * policy gate, and the evidence log. That placement is the whole design: a
 * guardrail you have to remember to call is a guardrail that eventually is not
 * called.
 *
 * Note what is deliberately absent: there is no accessor for `inner`. If a
 * caller could reach the wrapped surface, every guarantee below would be
 * advisory.
 */

import type {
  ActResult,
  Action,
  CaptureOptions,
  HumanControlPort,
  Observation,
  Resolution,
  Surface,
  SurfaceCapture,
  SurfaceKind,
  TargetDescriptor,
  TargetRef,
  UiNode,
} from './types.js';
import type { PolicyContext, PolicyDecision, PolicyGate, Redactor } from '../policy/types.js';
import { PolicyViolationError } from '../policy/types.js';
import type { RunLogger } from '../evidence/types.js';
import type { SessionLease } from '../escalation/lease.js';

export interface GuardedSurfaceDeps {
  inner: Surface;
  gate: PolicyGate;
  lease: SessionLease;
  logger: RunLogger;
  redactor: Redactor;
  /** Supplied by the caller (executor/agent) each time, so step/time budgets are live. */
  context(): PolicyContext;
  /** Called when the gate denies with a code the caller may want to escalate on. */
  onDenied?: (action: Action, decision: PolicyDecision) => void;
}

export class GuardedSurface implements Surface {
  /**
   * The last observation, kept so that a `{ref}` target — which is only
   * meaningful within the observation that produced it — can be turned back
   * into an accessible name for risk classification. Without this the gate
   * would evaluate every discovery-time click with `targetName === undefined`
   * and quietly classify irreversible controls as safe.
   */
  private latest: Observation | undefined;
  private refIndex: Map<string, UiNode> = new Map();

  constructor(private readonly deps: GuardedSurfaceDeps) {}

  get kind(): SurfaceKind {
    return this.deps.inner.kind;
  }

  /**
   * Passed straight through. Human takeover must reach the same live session;
   * wrapping it would be the one place a "guard" actively harms the guarantee.
   */
  get humanControl(): HumanControlPort {
    return this.deps.inner.humanControl;
  }

  /** The most recent observation, or undefined if we have not observed yet. */
  lastObservation(): Observation | undefined {
    return this.latest;
  }

  async act(action: Action): Promise<ActResult> {
    const { lease, gate, logger, redactor, inner } = this.deps;
    const describe = describeAction(action, redactor);

    // 1. Refuse to act at all if a human currently holds the session. This is
    //    checked before anything else, including policy: "someone else is
    //    driving" outranks "would this have been allowed".
    lease.assertHolds('automation', describe);

    // 2. Fence the epoch BEFORE any await. Everything after this point can be
    //    validated against the control state as it was when we committed.
    const guard = lease.guard('automation');

    // 3. Resolve the target's accessible name so the gate can classify risk.
    const targetName = await this.resolveTargetName(action);

    // A transfer could have landed during that resolve. Cheap to re-check, and
    // it means we never even *evaluate* policy on behalf of a session we no
    // longer hold. (This is an additional check, not a replacement for the
    // post-action one in step 7.)
    lease.assertGuardValid(guard, `pre-policy ${describe}`);

    // 4. Evaluate, and log the decision ALWAYS — allow and deny alike. An
    //    allowlist you cannot audit is not a control: the interesting question
    //    after an incident is "what was permitted", not just "what was refused".
    const ctx = this.deps.context();
    const decision = gate.evaluate(action, ctx, targetName);
    logger.emit(
      'policy.decision',
      {
        action: redactActionForLog(action, redactor),
        targetName: targetName === undefined ? undefined : redactor.text(targetName),
        mode: ctx.mode,
        approved: ctx.approved,
        stepsTaken: ctx.stepsTaken,
        elapsedMs: ctx.elapsedMs,
        allow: decision.allow,
        risk: decision.risk,
        flagged: decision.allow ? decision.flagged : undefined,
        code: decision.allow ? undefined : decision.code,
        reason: decision.allow ? undefined : decision.reason,
      },
      decision.allow
        ? `policy allowed ${describe}${decision.flagged ? ` [${decision.flagged}]` : ''}`
        : `policy denied ${describe}: ${decision.reason}`,
    );

    // 5. Denial. `onDenied` runs first so the caller can turn a
    //    `risky_action_needs_approval` into an escalation; the throw still
    //    happens, because a denial must never be caught-and-continued by
    //    accident. A caller that genuinely wants to escalate handles the typed
    //    error and re-drives the step after a human hands the lease back.
    if (!decision.allow) {
      this.deps.onDenied?.(action, decision);
      throw new PolicyViolationError(decision.code, `${decision.reason} (${describe})`);
    }

    // 6. Do the thing.
    const result = await inner.act(action);

    // 7. Validate the fence AFTER the await. If control transferred while the
    //    action was in flight, the result is not ours to report — a click that
    //    landed in the middle of a human's typing must surface as a control
    //    violation, not as a successful step.
    lease.assertGuardValid(guard, `post-action ${describe}`);

    // 8. Record what happened, with the action redacted. Typed text is logged
    //    only as a shape — we record that a value was entered, never what it was.
    logger.emit(
      'action',
      {
        action: redactActionForLog(action, redactor),
        ok: result.ok,
        tier: result.tier,
        risk: decision.risk,
        flagged: decision.flagged,
        node: result.node ? summarizeNode(result.node, redactor) : undefined,
        // `read` returns the value the capability exists to fetch; it goes
        // through pattern scrubbing here, and is additionally classified by the
        // extraction's declared Sensitivity upstream.
        value: result.value === undefined ? undefined : redactor.text(result.value),
        error: result.error,
      },
      `${result.ok ? 'ok' : 'failed'}: ${describe}`,
    );

    return result;
  }

  async observe(): Promise<Observation> {
    const obs = await this.deps.inner.observe();

    // Cache for `{ref}` risk classification (see `latest`).
    this.latest = obs;
    this.refIndex = new Map(obs.nodes.map((n) => [n.ref, n]));

    // Deliberately NOT lease-checked. Perception is non-mutating, and we keep it
    // available while a human holds the session so the evidence log does not go
    // blind during exactly the part of the run a reviewer cares most about.
    this.deps.logger.emit(
      'observe',
      {
        // Node contents are not logged: an accessibility tree of a member record
        // is a PII dump. Counts and location are enough to reconstruct the run.
        nodeCount: obs.nodes.length,
        uri: this.deps.redactor.text(obs.location.uri),
        title: this.deps.redactor.text(obs.location.title),
        canonicalPath: obs.location.canonicalPath,
        surfaceKind: obs.surfaceKind,
        degraded: obs.degraded?.reason,
      },
      `observed ${obs.nodes.length} nodes`,
    );

    return obs;
  }

  async capture(opts?: CaptureOptions): Promise<SurfaceCapture> {
    // Masking is the default, and the caller has to say so explicitly to turn it
    // off. The inverse (mask when asked) means every new call site is one
    // forgotten flag away from putting an unredacted account screen into
    // evidence.
    const masked = opts?.maskSensitive ?? true;
    const cap = await this.deps.inner.capture({ maskSensitive: masked });

    if (!masked) {
      // Loud, because this is the one supported way to produce evidence that may
      // contain regulated data on screen.
      this.deps.logger.emit(
        'capture',
        { maskSensitive: false },
        'capture taken with sensitive masking EXPLICITLY DISABLED',
      );
    }

    return cap;
  }

  resolve(descriptor: TargetDescriptor): Promise<Resolution> {
    // Read-only lookup; no policy surface of its own.
    return this.deps.inner.resolve(descriptor);
  }

  dispose(): Promise<void> {
    return this.deps.inner.dispose();
  }

  /**
   * Best-effort accessible name for the action's target.
   *
   * For a descriptor we ask the surface, because the *live* name is what the
   * risk rule should see — an artifact recorded against a button called "Save"
   * that the vendor has renamed to "Post Transaction" must be re-classified now,
   * not at record time. If resolution fails we fall back to the descriptor's
   * declared name rather than to `undefined`: a resolution miss must not
   * silently downgrade a risky control to safe.
   */
  private async resolveTargetName(action: Action): Promise<string | undefined> {
    const target = targetOf(action);
    if (!target) return undefined;

    if ('ref' in target) {
      return this.refIndex.get(target.ref)?.name;
    }

    try {
      const res = await this.deps.inner.resolve(target.descriptor);
      if (res.ok) return res.node.name;
    } catch {
      // Resolution problems are the executor's business, not the gate's; here we
      // only need a name, and the descriptor carries one.
    }
    return target.descriptor.name;
  }
}

// ---------------------------------------------------------------------------
// Logging helpers. Every one of these is written on the assumption that its
// output lands in a file a compliance reviewer will read.
// ---------------------------------------------------------------------------

function targetOf(action: Action): TargetRef | undefined {
  switch (action.type) {
    case 'click':
    case 'type':
    case 'select':
    case 'read':
      return action.target;
    default:
      return undefined;
  }
}

/** One-line, value-free description used for lease detail and log messages. */
export function describeAction(action: Action, r: Redactor): string {
  switch (action.type) {
    case 'navigate':
      return `navigate ${r.text(action.uri)}`;
    case 'click':
      return `click ${describeTargetText(action.target, r)}`;
    case 'type':
      // The text itself never appears — only its shape.
      return `type ${r.shape(action.text)} into ${describeTargetText(action.target, r)}${action.submit ? ' (submit)' : ''}`;
    case 'select':
      return `select in ${describeTargetText(action.target, r)}`;
    case 'press':
      return `press ${action.key}`;
    case 'read':
      return `read ${describeTargetText(action.target, r)}`;
    case 'wait':
      return `wait${action.ms ? ` ${action.ms}ms` : ''}${action.forText ? ` for text` : ''}`;
  }
}

function describeTargetText(t: TargetRef, r: Redactor): string {
  return 'ref' in t ? `<${t.ref}>` : `${t.descriptor.role} "${r.text(t.descriptor.name)}"`;
}

function describeTarget(t: TargetRef, r: Redactor): Record<string, unknown> {
  if ('ref' in t) return { ref: t.ref };
  const d = t.descriptor;
  return {
    role: d.role,
    name: r.text(d.name),
    nameMatch: d.nameMatch,
    section: d.section === undefined ? undefined : r.text(d.section),
    framePath: d.framePath,
    ordinal: d.ordinal,
  };
}

function redactActionForLog(action: Action, r: Redactor): Record<string, unknown> {
  switch (action.type) {
    case 'navigate':
      return { type: action.type, uri: r.text(action.uri) };
    case 'click':
      return { type: action.type, target: describeTarget(action.target, r) };
    case 'type':
      // NEVER the typed value. Shape only — that is enough to debug "we typed
      // the empty string into the member id field" without holding the id.
      return {
        type: action.type,
        target: describeTarget(action.target, r),
        textShape: r.shape(action.text),
        submit: action.submit === true,
      };
    case 'select':
      return { type: action.type, target: describeTarget(action.target, r), value: r.text(action.value) };
    case 'press':
      return { type: action.type, key: action.key };
    case 'read':
      return { type: action.type, target: describeTarget(action.target, r) };
    case 'wait':
      return { type: action.type, ms: action.ms, forText: action.forText === undefined ? undefined : r.text(action.forText) };
  }
}

function summarizeNode(n: UiNode, r: Redactor): Record<string, unknown> {
  return {
    role: n.role,
    name: r.text(n.name),
    section: n.section === undefined ? undefined : r.text(n.section),
    framePath: n.framePath,
    ordinal: n.ordinal,
    // The node's *value* is described, never reproduced.
    valueShape: n.value === undefined ? undefined : r.shape(n.value),
    sensitive: n.sensitive,
  };
}
