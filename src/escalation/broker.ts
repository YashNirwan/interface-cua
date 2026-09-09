/**
 * LocalEscalationBroker — the in-process implementation of the human-in-the-loop
 * path, and the only place in the system where the session lease changes hands.
 *
 * The interesting method is `escalate()`. Everything else (raise/get/list/
 * resolve/waitForResolution/subscribe) is the storage-and-notification
 * plumbing that a queue-backed implementation would replace wholesale.
 *
 * Why the ordering inside `escalate()` matters more than the code:
 *
 *   - Evidence is captured BEFORE the lease is ceded. Once a human starts
 *     clicking, the state you were describing is gone; a screenshot taken after
 *     the handover documents the operator's session, not the failure. So we pay
 *     the capture cost while we still hold control, even though it delays the
 *     handover by a few hundred milliseconds.
 *
 *   - The lease is ceded BEFORE the human control port is exposed. If we
 *     exposed first, there would be a window where a person can click while the
 *     automation still believes it holds the session — exactly the interleaving
 *     the lease exists to prevent.
 *
 *   - The lease is handed back AFTER recording stops. Otherwise a trailing
 *     human event could be attributed to the automation in the evidence log,
 *     and "who was in control when this happened" stops being answerable.
 *
 * Persistence: every request is written to
 * `<evidenceRoot>/<runId>/interventions/<id>.json` and rewritten on each state
 * change. Escalations are evidence — a run that ended with a human touching a
 * production system must leave a record that outlives the process.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { Action, ActResult, HumanAction, Observation, Surface } from '../surface/types.js';
import type { RunLogger } from '../evidence/types.js';
import type { Redactor } from '../policy/types.js';
import type { SessionLease } from './lease.js';
import {
  EscalationStateError,
  EscalationTimeoutError,
  type EscalationBroker,
  type EscalationEvent,
  type EscalationListener,
  type EscalationReason,
  type InterventionContext,
  type InterventionRequest,
  type InterventionResolution,
  type InterventionResolutionKind,
  type InterventionStatus,
  type ResolutionInput,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const RESOLUTION_KINDS: InterventionResolutionKind[] = ['resume', 'skip', 'approve', 'abort'];

/** How many nodes we put in the operator-facing semantic snapshot before truncating. */
const SNAPSHOT_NODE_LIMIT = 120;
/** How much page text goes into the digest. Enough to recognise the screen, not a dump. */
const TEXT_DIGEST_CHARS = 800;

export interface EscalateOptions {
  reason: EscalationReason;
  summary: string;
  /** Everything except the bits the broker fills in itself (location/screenshot/snapshot). */
  context: Omit<InterventionContext, 'location' | 'screenshot' | 'snapshot'> &
    Partial<Pick<InterventionContext, 'location' | 'screenshot' | 'snapshot'>>;
  allowedResolutions: InterventionResolutionKind[];
  /** The LIVE session. Not a clone, not a fresh context — the same one. */
  surface: Surface;
  lease: SessionLease;
  logger: RunLogger;
  redactor: Redactor;
  timeoutMs?: number;
  operatorHint?: string;
}

/**
 * Live state for an escalation that is currently in flight. Held in memory only:
 * it references the actual browser session, which by definition cannot be
 * serialised into a ticket.
 */
interface ActiveEscalation {
  request: InterventionRequest;
  lease: SessionLease;
  surface: Surface;
  logger: RunLogger;
  redactor: Redactor;
  humanActions: HumanAction[];
  sink: (ev: HumanAction) => void;
}

interface Waiter {
  resolve: (r: InterventionResolution) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface LocalEscalationBrokerOptions {
  /** Root of the evidence tree; requests land in `<evidenceRoot>/<runId>/interventions/`. */
  evidenceRoot?: string;
}

export class LocalEscalationBroker implements EscalationBroker {
  readonly evidenceRoot: string;

  private readonly requests = new Map<string, InterventionRequest>();
  private readonly resolutions = new Map<string, InterventionResolution>();
  private readonly active = new Map<string, ActiveEscalation>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly listeners = new Set<EscalationListener>();
  private readonly counters = new Map<string, number>();

  /** Set by `startOperatorConsole`. Gates the non-interactive test affordance. */
  private consoleUrl: string | undefined;

  constructor(opts: LocalEscalationBrokerOptions = {}) {
    this.evidenceRoot = opts.evidenceRoot ?? 'evidence';
  }

  // -------------------------------------------------------------------------
  // Console attachment
  // -------------------------------------------------------------------------

  /** Called by the operator console so escalations can advertise where to answer them. */
  attachConsole(url: string): void {
    this.consoleUrl = url;
  }
  detachConsole(): void {
    this.consoleUrl = undefined;
  }
  get attachedConsoleUrl(): string | undefined {
    return this.consoleUrl;
  }

  // -------------------------------------------------------------------------
  // EscalationBroker
  // -------------------------------------------------------------------------

  async raise(req: InterventionRequest): Promise<InterventionRequest> {
    this.requests.set(req.id, req);
    await this.persist(req);
    this.publish({ type: 'raised', request: req });
    return req;
  }

  async get(id: string): Promise<InterventionRequest | undefined> {
    return this.requests.get(id);
  }

  async list(filter?: { runId?: string; status?: InterventionStatus | InterventionStatus[] }): Promise<InterventionRequest[]> {
    const wanted = filter?.status === undefined ? undefined : Array.isArray(filter.status) ? filter.status : [filter.status];
    return [...this.requests.values()]
      .filter((r) => (filter?.runId ? r.runId === filter.runId : true))
      .filter((r) => (wanted ? wanted.includes(r.status) : true))
      .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  }

  /** The resolution recorded for an already-answered request, if any. */
  resolutionOf(id: string): InterventionResolution | undefined {
    return this.resolutions.get(id);
  }

  /** Human actions recorded so far on an in-flight escalation. Used by the console. */
  humanActionsOf(id: string): HumanAction[] {
    return [...(this.active.get(id)?.humanActions ?? this.resolutions.get(id)?.humanActions ?? [])];
  }

  /** Who currently holds the session for this escalation. `undefined` if it is not live. */
  leaseHolderOf(id: string): 'automation' | 'human' | undefined {
    return this.active.get(id)?.lease.holder;
  }

  async resolve(id: string, input: ResolutionInput): Promise<InterventionResolution> {
    const req = this.requests.get(id);
    if (!req) throw new EscalationStateError('not_found', `no intervention ${id}`);
    if (req.status === 'resolved' || req.status === 'abandoned') {
      throw new EscalationStateError('already_terminal', `intervention ${id} is already ${req.status}`);
    }
    if (!req.allowedResolutions.includes(input.kind)) {
      throw new EscalationStateError(
        'kind_not_allowed',
        `resolution '${input.kind}' is not permitted for ${id}; allowed: ${req.allowedResolutions.join(', ')}`,
      );
    }

    const resolution: InterventionResolution = {
      kind: input.kind,
      resolvedAt: new Date().toISOString(),
      operator: input.operator,
      // The action list comes from what the broker actually observed on the
      // session, never from the caller — an audit trail a caller can assert is
      // not an audit trail.
      humanActions: [...(this.active.get(id)?.humanActions ?? [])],
    };
    if (input.note !== undefined) resolution.note = input.note;

    req.status = 'resolved';
    this.resolutions.set(id, resolution);
    await this.persist(req, resolution);
    this.publish({ type: 'resolved', request: req, resolution });
    this.settle(id, resolution);
    return resolution;
  }

  async waitForResolution(id: string, timeoutMs: number): Promise<InterventionResolution> {
    const existing = this.resolutions.get(id);
    if (existing) return existing;
    const req = this.requests.get(id);
    if (!req) throw new EscalationStateError('not_found', `no intervention ${id}`);
    if (req.status === 'abandoned') throw new EscalationTimeoutError(id, timeoutMs);

    return await new Promise<InterventionResolution>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dropWaiter(id, waiter);
        void this.abandon(id, `no operator response within ${timeoutMs}ms`).finally(() => {
          reject(new EscalationTimeoutError(id, timeoutMs));
        });
      }, timeoutMs);
      // Do not keep the process alive purely to wait for an operator.
      timer.unref?.();
      const waiter: Waiter = { resolve, reject, timer };
      const list = this.waiters.get(id) ?? [];
      list.push(waiter);
      this.waiters.set(id, list);
    });
  }

  subscribe(listener: EscalationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // The escalation itself
  // -------------------------------------------------------------------------

  /**
   * Raise an intervention, hand the live session to a human, wait for an
   * answer, take the session back, and return what happened.
   *
   * Every `await` between the cede and the hand-back is a window in which the
   * automation must not act. That is not enforced by discipline here — it is
   * enforced by the lease: the caller's guard, taken before this call, fails
   * `assertGuardValid` for the rest of the run's lifetime because the epoch has
   * moved twice. The caller re-guards after we return.
   */
  async escalate(opts: EscalateOptions): Promise<InterventionResolution> {
    const { surface, lease, logger, redactor } = opts;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const id = this.nextId(logger.runId);

    // --- 1. Evidence first, while the automation still holds the lease. ------
    // Capture before ceding: the moment a human touches the session, the state
    // we are asking them about no longer exists.
    lease.assertHolds('automation', `escalate ${id}`);

    let observation: Observation | undefined;
    let screenshotPath: string | undefined;
    let snapshotText: string | undefined;
    try {
      const [cap, obs] = await Promise.all([surface.capture({ maskSensitive: true }), surface.observe()]);
      observation = obs;
      const saved = await logger.saveCapture(`${id}`, cap);
      screenshotPath = saved.screenshot;
      snapshotText = redactor.text(digestObservation(obs));
    } catch (err) {
      // A failed capture must not block the escalation — the whole reason we
      // are here may be that the surface is unhealthy. Record and continue.
      logger.emit('error', { id, phase: 'escalation.capture', message: errMessage(err) }, 'could not capture evidence before escalating');
    }

    // --- 2. Build and persist the request. -----------------------------------
    const location = opts.context.location ??
      observation?.location ?? { uri: 'unknown', title: 'unknown' };
    const context: InterventionContext = {
      mode: opts.context.mode,
      location: { uri: redactor.text(location.uri), title: redactor.text(location.title) },
    };
    if (opts.context.capabilityId !== undefined) context.capabilityId = opts.context.capabilityId;
    if (opts.context.capabilityVersion !== undefined) context.capabilityVersion = opts.context.capabilityVersion;
    if (opts.context.goal !== undefined) context.goal = redactor.text(opts.context.goal);
    if (opts.context.stepId !== undefined) context.stepId = opts.context.stepId;
    if (opts.context.stepIntent !== undefined) context.stepIntent = redactor.text(opts.context.stepIntent);
    if (opts.context.expected !== undefined) context.expected = redactor.text(opts.context.expected);
    if (opts.context.observed !== undefined) context.observed = redactor.text(opts.context.observed);
    const screenshot = opts.context.screenshot ?? screenshotPath;
    if (screenshot !== undefined) context.screenshot = screenshot;
    const snapshot = opts.context.snapshot ?? snapshotText;
    if (snapshot !== undefined) context.snapshot = snapshot;

    const request: InterventionRequest = {
      id,
      runId: logger.runId,
      raisedAt: new Date().toISOString(),
      reason: opts.reason,
      summary: redactor.text(opts.summary),
      context,
      allowedResolutions: [...opts.allowedResolutions],
      status: 'open',
    };

    const humanActions: HumanAction[] = [];
    const sink = (ev: HumanAction): void => {
      const redacted = redactHumanAction(ev, redactor);
      humanActions.push(redacted);
      if (request.status === 'open') {
        request.status = 'in_progress';
        void this.persist(request);
        this.publish({ type: 'in_progress', request });
      }
      // Each human action becomes a first-class evidence event, not just a
      // field on the resolution — so the run's timeline interleaves automation
      // and human activity in the order it really happened.
      logger.emit('human.action', { interventionId: id, ...redacted }, `human ${redacted.kind}${redacted.name ? ` on "${redacted.name}"` : ''}`);
      this.publish({ type: 'human_action', request, action: redacted });
    };

    this.active.set(id, { request, lease, surface, logger, redactor, humanActions, sink });
    await this.raise(request);
    logger.emit(
      'escalation.raised',
      {
        interventionId: id,
        reason: request.reason,
        summary: request.summary,
        stepId: context.stepId,
        allowedResolutions: request.allowedResolutions,
        consoleUrl: this.consoleUrl ? `${this.consoleUrl}/intervention/${id}` : undefined,
        operatorHint: opts.operatorHint,
      },
      `escalation raised: ${request.summary}`,
    );

    // --- The non-interactive test affordance, decided before we cede. --------
    const autoKind = this.autoResolveKind(surface, request.allowedResolutions);

    let resolution: InterventionResolution;
    try {
      // --- 3. The actual control transfer. ----------------------------------
      const beforeEpoch = lease.epoch;
      const state = lease.cedeTo('human', `escalation ${id}: ${request.reason}`);
      logger.emit(
        'control.transfer',
        { interventionId: id, from: 'automation', to: 'human', fromEpoch: beforeEpoch, toEpoch: state.epoch, reason: state.reason },
        `control transferred to human (epoch ${beforeEpoch} -> ${state.epoch})`,
      );

      // --- 4. Expose the session and start recording. -----------------------
      // `available === false` is the headless/CI case. We do not pretend: we
      // skip expose/record and let the operator console drive the same session
      // through the /act proxy instead (see console.ts), which produces the
      // same HumanAction stream through the same sink.
      if (surface.humanControl.available) {
        try {
          const where = await surface.humanControl.expose();
          logger.emit('human.action', { interventionId: id, kind: 'note', how: where.how, detail: redactor.text(where.detail) }, `session exposed to operator via ${where.how}`);
          await surface.humanControl.startRecording(sink);
        } catch (err) {
          logger.emit('error', { interventionId: id, phase: 'humanControl.expose', message: errMessage(err) }, 'could not expose session for direct human control');
        }
      } else {
        logger.emit(
          'human.action',
          { interventionId: id, kind: 'note', detail: 'surface has no direct human control; operator must drive via the console /act proxy' },
          'headless surface: human control is console-proxied',
        );
      }

      // --- 5. Wait for the answer. ------------------------------------------
      if (autoKind) {
        // Resolve on the next tick rather than inline, so the request genuinely
        // passes through open -> resolved and every listener/waiter sees it.
        setTimeout(() => {
          void this.resolve(id, { kind: autoKind, operator: 'auto (CUA_AUTO_RESOLVE_ESCALATIONS)', note: 'auto-resolved: non-interactive run' }).catch(() => {
            /* a real operator beat us to it; nothing to do */
          });
        }, 0);
      }
      resolution = await this.waitForResolution(id, timeoutMs);
    } catch (err) {
      // --- Timeout / abandonment path. --------------------------------------
      // The lease MUST come back regardless, or the run is wedged holding a
      // session nobody owns.
      await this.stopRecordingQuietly(surface, logger, id);
      if (lease.holder === 'human') {
        const back = lease.handBack(`escalation ${id} abandoned`);
        logger.emit(
          'control.transfer',
          { interventionId: id, from: 'human', to: 'automation', toEpoch: back.epoch, reason: back.reason },
          `control returned to automation after abandoned escalation (epoch ${back.epoch})`,
        );
      }
      this.active.delete(id);
      throw err;
    }

    // --- 6. Stop recording BEFORE handing back. -----------------------------
    await this.stopRecordingQuietly(surface, logger, id);

    // --- 7. Hand the session back. ------------------------------------------
    const back = lease.handBack(`operator resolved: ${resolution.kind}`);
    logger.emit(
      'control.transfer',
      { interventionId: id, from: 'human', to: 'automation', toEpoch: back.epoch, reason: back.reason },
      `control returned to automation (epoch ${back.epoch})`,
    );
    logger.emit(
      'escalation.resolved',
      {
        interventionId: id,
        kind: resolution.kind,
        operator: resolution.operator,
        note: resolution.note,
        humanActionCount: resolution.humanActions.length,
      },
      `escalation resolved by ${resolution.operator}: ${resolution.kind}`,
    );

    this.active.delete(id);
    // --- 8. Hand the caller the answer plus what the human did. -------------
    return { ...resolution, humanActions: [...humanActions] };
  }

  /**
   * Execute one action against the live session on the operator's behalf.
   *
   * This is what makes the transfer real for a headless surface: the human is
   * not looking at a browser window, they are driving the SAME session through
   * the console. Guarded three ways — the intervention must be live, the lease
   * must be held by 'human', and the resulting action is recorded through the
   * same sink as a directly-observed human action, so console-driven and
   * browser-driven takeovers produce identical evidence.
   */
  async actAsHuman(id: string, action: Action, surfaceOverride?: Surface): Promise<ActResult> {
    const live = this.active.get(id);
    const req = this.requests.get(id) ?? live?.request;
    if (!req) throw new EscalationStateError('not_found', `no intervention ${id}`);
    if (req.status !== 'open' && req.status !== 'in_progress') {
      throw new EscalationStateError('already_terminal', `intervention ${id} is ${req.status}; the session is no longer yours to drive`);
    }
    if (!live) throw new EscalationStateError('no_surface', `intervention ${id} has no live session in this process`);
    if (live.lease.holder !== 'human') {
      throw new EscalationStateError('not_human_controlled', `the ${live.lease.holder} holds session ${live.lease.sessionId}; refusing to inject an operator action`);
    }
    const surface = surfaceOverride ?? live.surface;
    const result = await surface.act(action);
    live.sink(describeAction(action, result, live.redactor));
    return result;
  }

  /** Read the live session for the console. Same guards, minus the mutation. */
  async observeFor(id: string, surfaceOverride?: Surface): Promise<Observation> {
    const live = this.active.get(id);
    const surface = surfaceOverride ?? live?.surface;
    if (!surface) throw new EscalationStateError('no_surface', `intervention ${id} has no live session in this process`);
    return await surface.observe();
  }

  /** Record a free-form operator note against a live escalation. */
  noteFor(id: string, text: string): void {
    const live = this.active.get(id);
    if (!live) throw new EscalationStateError('not_found', `intervention ${id} is not live`);
    live.sink({ at: new Date().toISOString(), kind: 'note', name: text });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * TEST AFFORDANCE — MUST NEVER BE ENABLED IN PRODUCTION.
   *
   * When there is genuinely nobody who could answer (the surface cannot be
   * handed to a person AND no operator console is attached) and
   * `CUA_AUTO_RESOLVE_ESCALATIONS` names a resolution kind, we answer our own
   * escalation with that kind. This exists so CI and the demo script exercise
   * the *entire* path — capture, raise, cede, record, hand back — rather than
   * stubbing it out and proving nothing.
   *
   * The record says `operator: 'auto (CUA_AUTO_RESOLVE_ESCALATIONS)'`, which is
   * deliberately ugly: an auto-resolved intervention in a real evidence trail
   * should be impossible to mistake for a human decision during an audit. If
   * this string ever shows up in a production run, that run's approvals are
   * void.
   */
  private autoResolveKind(surface: Surface, allowed: InterventionResolutionKind[]): InterventionResolutionKind | undefined {
    const raw = process.env['CUA_AUTO_RESOLVE_ESCALATIONS'];
    if (!raw) return undefined;
    if (surface.humanControl.available) return undefined; // a person could answer; do not shortcut
    if (this.consoleUrl) return undefined; // a console is attached; a person could answer
    const kind = raw.trim() as InterventionResolutionKind;
    if (!RESOLUTION_KINDS.includes(kind)) return undefined;
    // Never manufacture an answer the raiser said was illegal — fall back to
    // the safest thing it did allow.
    if (!allowed.includes(kind)) return allowed.includes('abort') ? 'abort' : allowed[0];
    return kind;
  }

  private nextId(runId: string): string {
    const n = (this.counters.get(runId) ?? 0) + 1;
    this.counters.set(runId, n);
    return `int_${runId}_${n}`;
  }

  private publish(ev: EscalationEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        // A broken subscriber must not take down the escalation path.
      }
    }
  }

  private settle(id: string, resolution: InterventionResolution): void {
    const list = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const w of list) {
      clearTimeout(w.timer);
      w.resolve(resolution);
    }
  }

  private dropWaiter(id: string, waiter: Waiter): void {
    const list = (this.waiters.get(id) ?? []).filter((w) => w !== waiter);
    if (list.length) this.waiters.set(id, list);
    else this.waiters.delete(id);
  }

  /** Mark a request abandoned and publish it. Called on timeout. */
  private async abandon(id: string, reason: string): Promise<void> {
    const req = this.requests.get(id);
    if (!req || req.status === 'resolved' || req.status === 'abandoned') return;
    req.status = 'abandoned';
    const live = this.active.get(id);
    live?.logger.emit('escalation.resolved', { interventionId: id, status: 'abandoned', reason }, `escalation abandoned: ${reason}`);
    await this.persist(req);
    this.publish({ type: 'abandoned', request: req, reason });
  }

  private async stopRecordingQuietly(surface: Surface, logger: RunLogger, id: string): Promise<void> {
    if (!surface.humanControl.available) return;
    try {
      await surface.humanControl.stopRecording();
    } catch (err) {
      logger.emit('error', { interventionId: id, phase: 'humanControl.stopRecording', message: errMessage(err) }, 'failed to stop human-action recording');
    }
  }

  /** `<evidenceRoot>/<runId>/interventions/<id>.json` — escalations survive as evidence. */
  private async persist(req: InterventionRequest, resolution?: InterventionResolution): Promise<void> {
    const dir = path.join(this.evidenceRoot, req.runId, 'interventions');
    const record = {
      ...req,
      resolution: resolution ?? this.resolutions.get(req.id),
      humanActions: this.humanActionsOf(req.id),
    };
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${req.id}.json`), JSON.stringify(record, null, 2), 'utf8');
    } catch {
      // Evidence persistence must not be able to fail a run that is already in
      // trouble; the in-memory record and the JSONL event log still hold it.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The operator-facing snapshot. Deliberately role/name/section lines rather
 * than HTML: an operator reads it in two seconds, it survives markup churn, and
 * it cannot smuggle unredacted values through in an attribute.
 */
export function digestObservation(obs: Observation): string {
  const head = `${obs.location.title} — ${obs.location.uri}`;
  const nodes = obs.nodes
    .slice(0, SNAPSHOT_NODE_LIMIT)
    .map((n) => {
      const bits = [`${n.role}`, `"${n.name}"`];
      if (n.section) bits.push(`section=${n.section}`);
      if (n.framePath.length) bits.push(`frame=${n.framePath.join('>')}`);
      if (n.disabled) bits.push('disabled');
      if (n.checked !== undefined) bits.push(`checked=${n.checked}`);
      if (n.sensitive) bits.push('sensitive');
      return `  ${bits.join(' ')}`;
    })
    .join('\n');
  const more = obs.nodes.length > SNAPSHOT_NODE_LIMIT ? `\n  ... ${obs.nodes.length - SNAPSHOT_NODE_LIMIT} more nodes` : '';
  const text = obs.text.slice(0, TEXT_DIGEST_CHARS).replace(/\s+/g, ' ').trim();
  const degraded = obs.degraded ? `\nDEGRADED: ${obs.degraded.reason}` : '';
  return `${head}${degraded}\n\nCONTROLS (${obs.nodes.length}):\n${nodes}${more}\n\nTEXT:\n  ${text}`;
}

/** Values never leave the session as values — only as shapes. */
function redactHumanAction(ev: HumanAction, redactor: Redactor): HumanAction {
  const out: HumanAction = { at: ev.at, kind: ev.kind };
  if (ev.role !== undefined) out.role = ev.role;
  if (ev.name !== undefined) out.name = redactor.text(ev.name);
  if (ev.valueShape !== undefined) out.valueShape = ev.valueShape;
  if (ev.uri !== undefined) out.uri = redactor.text(ev.uri);
  return out;
}

/** Turn a console-proxied Action + its result into the HumanAction we record. */
function describeAction(action: Action, result: ActResult, redactor: Redactor): HumanAction {
  const at = new Date().toISOString();
  const named = result.node?.name ?? targetLabel(action);
  switch (action.type) {
    case 'navigate':
      return { at, kind: 'navigate', uri: redactor.text(action.uri) };
    case 'press':
      return { at, kind: 'key', name: action.key };
    case 'type':
      // The typed text is never recorded — only that a value of this shape went in.
      return { at, kind: 'input', role: result.node?.role, name: named, valueShape: redactor.shape(action.text) };
    case 'select':
      return { at, kind: 'input', role: result.node?.role, name: named, valueShape: redactor.shape(action.value) };
    case 'click':
      return { at, kind: 'click', role: result.node?.role, name: named };
    default:
      return { at, kind: 'note', name: `${action.type} ${named}`.trim() };
  }
}

function targetLabel(action: Action): string {
  if ('target' in action) {
    const t = action.target;
    if ('descriptor' in t) return t.descriptor.name;
    return t.ref;
  }
  return '';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
