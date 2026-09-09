/**
 * The control-transfer model.
 *
 * Requirement 3.6 asks for a human to take over "the same live session" and
 * hand it back. The temptation is to implement that as a pause flag. That is
 * not sufficient: a paused executor that is mid-`await` can still fire an
 * action into a session a human is now driving, and you get a click landing in
 * the middle of someone's typing.
 *
 * So control is modelled as an explicit, single-holder lease over the session,
 * with a fencing token:
 *
 *   - Exactly one party holds the lease at a time: 'automation' or 'human'.
 *   - Every action against the surface passes through `assertHolds()`. There is
 *     no path to the surface that skips it (see GuardedSurface).
 *   - Each transfer bumps an epoch. An in-flight action captured epoch N and
 *     completing after a transfer to epoch N+1 is rejected rather than applied.
 *     This is the part a pause flag cannot give you.
 *   - Every transition is recorded, so the run's evidence answers "who was in
 *     control when this happened?" for every event. For a regulated back office
 *     that audit line is the actual deliverable, not a nicety.
 *
 * The lease is intentionally in-process here. The seam is `LeaseStore`: swapping
 * the in-memory implementation for a row in Postgres with a TTL and a
 * compare-and-set on `epoch` is what makes this work across a service boundary,
 * with the same semantics. That is the only change needed to run the executor
 * and the operator console as separate services.
 */

export type Controller = 'automation' | 'human';

export interface LeaseState {
  holder: Controller;
  epoch: number;
  since: string;
  reason: string;
}

export interface LeaseTransition {
  at: string;
  from: Controller;
  to: Controller;
  epoch: number;
  reason: string;
}

/** Thrown when an actor tries to touch the session without holding the lease. */
export class LeaseViolationError extends Error {
  constructor(
    readonly actor: Controller,
    readonly holder: Controller,
    readonly detail: string,
  ) {
    super(`control violation: ${actor} attempted to act while ${holder} holds the session (${detail})`);
    this.name = 'LeaseViolationError';
  }
}

/** A capability token proving the bearer held the lease at a specific epoch. */
export interface LeaseGuard {
  readonly actor: Controller;
  readonly epoch: number;
}

export class SessionLease {
  private state: LeaseState;
  private readonly log: LeaseTransition[] = [];
  private waiters: Array<{ who: Controller; resolve: () => void }> = [];

  constructor(
    readonly sessionId: string,
    initialHolder: Controller = 'automation',
  ) {
    this.state = { holder: initialHolder, epoch: 1, since: new Date().toISOString(), reason: 'session start' };
  }

  get holder(): Controller {
    return this.state.holder;
  }
  get epoch(): number {
    return this.state.epoch;
  }
  snapshot(): LeaseState {
    return { ...this.state };
  }
  transitions(): LeaseTransition[] {
    return [...this.log];
  }

  /** Take a fenced guard for the current epoch. Capture this before an await. */
  guard(actor: Controller): LeaseGuard {
    this.assertHolds(actor, 'guard');
    return { actor, epoch: this.state.epoch };
  }

  /** Throws unless `actor` currently holds the session. */
  assertHolds(actor: Controller, detail: string): void {
    if (this.state.holder !== actor) {
      throw new LeaseViolationError(actor, this.state.holder, detail);
    }
  }

  /**
   * Validate a guard taken before an await. Rejects if control moved in the
   * meantime, which is how we stop a late-completing automation action from
   * landing in a session a human has taken over.
   */
  assertGuardValid(g: LeaseGuard, detail: string): void {
    this.assertHolds(g.actor, detail);
    if (g.epoch !== this.state.epoch) {
      throw new LeaseViolationError(g.actor, this.state.holder, `stale epoch ${g.epoch} != ${this.state.epoch} (${detail})`);
    }
  }

  /** Hand the live session over. Called by the executor when it escalates. */
  cedeTo(to: Controller, reason: string): LeaseState {
    return this.transfer(to, reason);
  }

  /** The operator says "I'm done" — control returns to the automation. */
  handBack(reason: string): LeaseState {
    return this.transfer('automation', reason);
  }

  private transfer(to: Controller, reason: string): LeaseState {
    const from = this.state.holder;
    this.state = { holder: to, epoch: this.state.epoch + 1, since: new Date().toISOString(), reason };
    this.log.push({ at: this.state.since, from, to, epoch: this.state.epoch, reason });
    const ready = this.waiters.filter((w) => w.who === to);
    this.waiters = this.waiters.filter((w) => w.who !== to);
    for (const w of ready) w.resolve();
    return this.snapshot();
  }

  /**
   * Block until `who` holds the lease. The executor awaits this after ceding
   * control; it is how "resume" actually resumes rather than polling.
   * Rejects on timeout so an unattended escalation cannot hang a run forever.
   */
  async waitForControl(who: Controller, timeoutMs: number): Promise<void> {
    if (this.state.holder === who) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== onReady);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${who} to take control of ${this.sessionId}`));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push({ who, resolve: onReady });
    });
  }
}
