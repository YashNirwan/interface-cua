/**
 * Meridian Core — runtime fault injection.
 *
 * The point of this module is to let a test harness *arm* a specific legacy
 * failure mode just before it drives a flow, so that error handling and
 * recovery produce deterministic evidence instead of being waited on by luck.
 *
 * Faults are scoped to a session key so two concurrent runs cannot see each
 * other's faults. Resolution order for a request is:
 *
 *   X-Fault-Session header  ->  `sid` cookie  ->  the global bucket ("*")
 *
 * ...falling through to the next candidate only when the previous one has no
 * armed state. Arming uses the same order but always writes (creating the
 * bucket if needed).
 *
 * This file owns fault *state and policy* only. Rendering the interstitial /
 * 500 / expired-session pages is the server's job — that keeps the HTML in
 * views.ts and the wiring in server.ts.
 */

import express, { type Request, type Router } from 'express';

/** The bucket used when a caller arms faults without any session identity. */
export const GLOBAL_FAULT_KEY = '*';

/** JSON body accepted by `POST /meridian/_faults`. All fields optional. */
export interface FaultInput {
  slowMs?: number;
  notice?: boolean;
  expireSession?: boolean;
  error500?: boolean;
  /**
   * When true (the default) each armed boolean fault fires exactly once and
   * then disarms itself. When false the fault keeps firing until it is
   * explicitly cleared with `DELETE /meridian/_faults`.
   */
  oncePerRun?: boolean;
  /**
   * Delay arming by N app requests. Without this a fault can only ever fire on
   * the first request of a run, which makes it impossible to reproduce the
   * interesting cases — a session that expires halfway through a flow, a 500
   * on the confirmation step. Counting requests rather than wall-clock time
   * keeps the injection deterministic and therefore reproducible in evidence.
   */
  afterRequests?: number;
}

/** The armed state for one session key, as returned by the fault API. */
export interface FaultState {
  /** Milliseconds of artificial delay added to every app response. Persistent. */
  slowMs: number;
  /** Serve the "System Notice" interstitial before the next member-detail page. */
  notice: boolean;
  /** Destroy the session on the next app request and bounce to sign-on. */
  expireSession: boolean;
  /** Return HTTP 500 on the next app request. */
  error500: boolean;
  /** Whether boolean faults consume themselves after firing once. */
  oncePerRun: boolean;
  /** URL the notice interstitial should continue to once acknowledged. */
  pendingUrl: string | null;
  /** Requests still to elapse before the armed faults become live. */
  afterRequests: number;
}

/** What the fault layer wants the server to do *instead of* handling a request. */
export type FaultAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'expire' }
  | { readonly kind: 'error500' };

const NO_ACTION: FaultAction = { kind: 'none' };

function emptyState(): FaultState {
  return {
    slowMs: 0,
    notice: false,
    expireSession: false,
    error500: false,
    oncePerRun: true,
    pendingUrl: null,
    afterRequests: 0,
  };
}

function isArmed(state: FaultState): boolean {
  return (
    state.slowMs > 0 || state.notice || state.expireSession || state.error500 || state.pendingUrl !== null || state.afterRequests > 0
  );
}

function coerceNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Only same-app paths may be used as a notice continuation target, so a caller
 * cannot turn the interstitial into an open redirect.
 */
export function isSafeContinuation(url: string): boolean {
  return url.startsWith('/meridian/') && !url.startsWith('//') && !url.includes('\\');
}

export class FaultRegistry {
  private readonly states = new Map<string, FaultState>();

  /** Candidate keys for a request, most specific first. */
  private candidates(sid: string | null, header: string | null): string[] {
    const keys: string[] = [];
    if (header && header.trim() !== '') keys.push(header.trim());
    if (sid) keys.push(sid);
    keys.push(GLOBAL_FAULT_KEY);
    return keys;
  }

  /** The key a *read* should use: the first candidate that actually has state. */
  resolveKey(sid: string | null, header: string | null): string | null {
    for (const key of this.candidates(sid, header)) {
      if (this.states.has(key)) return key;
    }
    return null;
  }

  /** The key an *arm* should use: most specific candidate, whether or not it exists. */
  armKey(sid: string | null, header: string | null): string {
    const [first] = this.candidates(sid, header);
    return first ?? GLOBAL_FAULT_KEY;
  }

  peek(key: string | null): FaultState | null {
    if (key === null) return null;
    return this.states.get(key) ?? null;
  }

  arm(key: string, input: FaultInput): FaultState {
    const current = this.states.get(key) ?? emptyState();
    const next: FaultState = {
      slowMs: coerceNonNegativeInt(input.slowMs, current.slowMs),
      notice: coerceBoolean(input.notice, current.notice),
      expireSession: coerceBoolean(input.expireSession, current.expireSession),
      error500: coerceBoolean(input.error500, current.error500),
      afterRequests: coerceNonNegativeInt(input.afterRequests, current.afterRequests),
      oncePerRun: coerceBoolean(input.oncePerRun, current.oncePerRun),
      // Re-arming the notice throws away any half-finished continuation.
      pendingUrl: input.notice === true ? null : current.pendingUrl,
    };
    this.states.set(key, next);
    return { ...next };
  }

  clear(key: string | null): void {
    if (key === null) {
      this.states.clear();
      return;
    }
    this.states.delete(key);
  }

  clearAll(): void {
    this.states.clear();
  }

  /** Artificial latency for this request, in milliseconds. Never self-consumes. */
  delayMs(key: string | null): number {
    return this.peek(key)?.slowMs ?? 0;
  }

  /**
   * Consume whichever blocking fault is armed. `expireSession` wins over
   * `error500` when both are set, because an expired session is the more
   * disruptive of the two and the harness should see it first.
   */
  takeBlockingFault(key: string | null): FaultAction {
    const state = this.peek(key);
    if (state === null || key === null) return NO_ACTION;

    // Count down first: the arming delay applies to every blocking fault, and
    // the countdown itself is what makes "fail on the 6th request" repeatable.
    if (state.afterRequests > 0) {
      state.afterRequests -= 1;
      return NO_ACTION;
    }

    if (state.expireSession) {
      if (state.oncePerRun) state.expireSession = false;
      this.prune(key, state);
      return { kind: 'expire' };
    }
    if (state.error500) {
      if (state.oncePerRun) state.error500 = false;
      this.prune(key, state);
      return { kind: 'error500' };
    }
    return NO_ACTION;
  }

  /**
   * If the notice interstitial is armed, consume it, remember where the caller
   * was heading, and report that the interstitial should be shown instead.
   */
  takeNotice(key: string | null, continueTo: string): boolean {
    const state = this.peek(key);
    if (state === null || key === null || !state.notice) return false;
    if (state.oncePerRun) state.notice = false;
    state.pendingUrl = isSafeContinuation(continueTo) ? continueTo : null;
    this.states.set(key, state);
    return true;
  }

  /** Read and clear the URL stashed by `takeNotice`. */
  takePendingUrl(key: string | null): string | null {
    const state = this.peek(key);
    if (state === null || key === null) return null;
    const url = state.pendingUrl;
    state.pendingUrl = null;
    this.prune(key, state);
    return url;
  }

  /** Drop fully-disarmed buckets so `resolveKey` falls back to the global one again. */
  private prune(key: string, state: FaultState): void {
    if (isArmed(state)) {
      this.states.set(key, state);
    } else {
      this.states.delete(key);
    }
  }
}

/** `await` this to add the armed latency. */
export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The `/meridian/_faults` control surface. Mounted before the fault middleware
 * so arming a fault is never itself slowed down, expired or 500'd.
 */
export function createFaultsRouter(registry: FaultRegistry, sidOf: (req: Request) => string | null): Router {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  const headerOf = (req: Request): string | null => req.get('x-fault-session') ?? null;

  router.get('/', (req, res) => {
    const key = registry.resolveKey(sidOf(req), headerOf(req));
    res.json({ key: key ?? registry.armKey(sidOf(req), headerOf(req)), faults: registry.peek(key) ?? emptyState() });
  });

  router.post('/', (req, res) => {
    const body: FaultInput = (req.body ?? {}) as FaultInput;
    const key = registry.armKey(sidOf(req), headerOf(req));
    const faults = registry.arm(key, body);
    res.json({ key, faults });
  });

  router.delete('/', (req, res) => {
    const key = registry.resolveKey(sidOf(req), headerOf(req)) ?? registry.armKey(sidOf(req), headerOf(req));
    registry.clear(key);
    res.json({ key, faults: emptyState() });
  });

  return router;
}
