/**
 * Composition root.
 *
 * Every entry point (discovery, replay, catalog invocation, the learn
 * commands) assembles the same object graph, so there is exactly one place
 * where the policy gate, the session lease, the redactor and the evidence
 * logger get wired to the surface. If that wiring were duplicated per command,
 * one of them would eventually be assembled without the guard — which is the
 * failure mode the GuardedSurface design exists to prevent in the first place.
 */

import { randomUUID } from 'node:crypto';
import { GuardedSurface } from './surface/guarded.js';
import { createPlaywrightSurface, PlaywrightSurface } from './surface/web/playwright-surface.js';
import { DefaultPolicyGate } from './policy/gate.js';
import { DefaultRedactor } from './policy/redact.js';
import { loadPolicy } from './policy/config.js';
import { SessionLease } from './escalation/lease.js';
import { LocalEscalationBroker } from './escalation/broker.js';
import { FileRunLogger, createRunLogger } from './evidence/run-log.js';
import type { PolicyConfig, PolicyContext } from './policy/types.js';
import type { Surface } from './surface/types.js';

export interface SessionOptions {
  mode: 'discovery' | 'replay';
  runId?: string;
  headless?: boolean;
  evidenceDir?: string;
  policyPath?: string;
  /** Whether risky steps may run unattended for this session. */
  approved?: boolean;
  echo?: boolean;
  /** Origins the capability itself declares; intersected with the global list. */
  capabilityOrigins?: string[];
  /**
   * Env keys holding credentials this run will use. Their VALUES are registered
   * with the redactor so they are scrubbed from evidence even when the
   * application echoes them back into its own pages.
   */
  secretKeys?: string[];
}

export interface Session {
  runId: string;
  /** The guarded surface — the only one anything else is allowed to touch. */
  surface: Surface;
  /** The raw surface. Used only by the operator console to proxy human actions. */
  raw: PlaywrightSurface;
  gate: DefaultPolicyGate;
  lease: SessionLease;
  logger: FileRunLogger;
  redactor: DefaultRedactor;
  broker: LocalEscalationBroker;
  policy: PolicyConfig;
  /**
   * Live budget counters the policy gate reads on every action.
   *
   * `llmWaitMs` is subtracted from elapsed time. The duration limit exists to
   * stop runaway automation from hammering a production banking system; time
   * spent waiting on a model (including provider rate-limit backoff) is not
   * time spent touching the app, and counting it would make the guardrail fire
   * on slow inference rather than on the behaviour it is meant to bound.
   */
  budget: {
    steps: number;
    startedAt: number;
    llmWaitMs: number;
    /**
     * A single-action authorisation granted by a human operator in response to
     * an escalation. Scoped deliberately narrowly: it authorises the one action
     * the operator was shown and nothing else, and the caller clears it as soon
     * as that action has been attempted. A session-wide "approved" flag would
     * mean one click on one dialog silently authorises every risky action for
     * the rest of the run.
     */
    approveNextAction: boolean;
  };
  dispose(): Promise<void>;
}

export function newRunId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
}

export async function createSession(opts: SessionOptions): Promise<Session> {
  const runId = opts.runId ?? newRunId(opts.mode === 'discovery' ? 'disc' : 'rpl');
  const policy = loadPolicy(opts.policyPath);
  const redactor = new DefaultRedactor(policy);
  for (const key of opts.secretKeys ?? []) redactor.addSecretValue(process.env[key]);
  const gate = new DefaultPolicyGate(policy);
  const lease = new SessionLease(runId, 'automation');
  const logger = createRunLogger({ runId, baseDir: opts.evidenceDir, redactor, lease, echo: opts.echo });
  const broker = new LocalEscalationBroker({ evidenceRoot: opts.evidenceDir ?? 'evidence' });

  const budget = { steps: 0, startedAt: Date.now(), llmWaitMs: 0, approveNextAction: false };
  const context = (): PolicyContext => ({
    mode: opts.mode,
    approved: (opts.approved ?? false) || budget.approveNextAction,
    capabilityOrigins: opts.capabilityOrigins,
    stepsTaken: budget.steps,
    elapsedMs: Date.now() - budget.startedAt - budget.llmWaitMs,
  });

  const raw = await createPlaywrightSurface({ headless: opts.headless ?? true });
  const surface = new GuardedSurface({ inner: raw, gate, lease, logger, redactor, context });

  return {
    runId,
    surface,
    raw,
    gate,
    lease,
    logger,
    redactor,
    broker,
    policy,
    budget,
    async dispose() {
      await raw.dispose();
    },
  };
}

/**
 * Secrets come from the process environment and are never written anywhere.
 * A real deployment swaps this for a vault client; the seam is this function.
 */
export function envSecrets(key: string): string | undefined {
  return process.env[key];
}
