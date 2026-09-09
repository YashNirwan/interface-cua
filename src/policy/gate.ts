/**
 * The policy gate: one pure function from (action, context) to a decision.
 *
 * It is deliberately side-effect free and synchronous. All of the awkward parts
 * — logging the decision, turning a denial into an escalation, refusing to act
 * when a human holds the session — live in GuardedSurface. Keeping the gate
 * pure is what makes it exhaustively testable, and an allowlist you cannot test
 * exhaustively is a hope, not a control.
 */

import type { Action, ActionType } from '../surface/types.js';
import type { PolicyConfig, PolicyContext, PolicyDecision, PolicyGate } from './types.js';

/** Actions that even *can* mutate something the UI will not obviously undo. */
const RISK_ELIGIBLE: ReadonlySet<ActionType> = new Set<ActionType>(['click', 'type', 'select']);

/**
 * Translate one allowedPaths entry into a matcher.
 *
 * `**` matches across `/`, `*` matches within a single segment. The one special
 * case is a trailing `/**`: `/meridian/**` is intended to mean "the meridian
 * area", so it must also match the bare `/meridian` landing path. Without this
 * the very first navigation of every flow would be denied, and the obvious
 * workaround (adding `/meridian` as a second entry) is exactly the kind of
 * allowlist noise that makes people stop reading allowlists.
 */
function globToRegExp(pattern: string): RegExp {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return new RegExp(`^${escapeLiteral(prefix)}(?:/.*)?$`);
  }
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else {
      out += escapeLiteral(c);
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class DefaultPolicyGate implements PolicyGate {
  private readonly riskyPatterns: string[];
  private readonly pathMatchers: RegExp[];
  private readonly origins: ReadonlySet<string>;

  constructor(readonly config: PolicyConfig) {
    // Lower-cased once. Risk classification runs on every action; it should not
    // be allocating.
    this.riskyPatterns = config.risky.namePatterns.map((p) => p.toLowerCase());
    this.pathMatchers = config.allowedPaths.map(globToRegExp);
    this.origins = new Set(config.allowedOrigins);
  }

  evaluate(action: Action, ctx: PolicyContext, targetName?: string): PolicyDecision {
    // Risk is computed up-front so that *every* decision — including the boring
    // "you ran out of steps" denials — carries an accurate risk label into the
    // evidence log. A reviewer reading the log should be able to see that the
    // run stopped one step short of a `Post` click.
    const risk = this.classifyActionRisk(action, targetName);

    // --- 1. Budgets. Checked first: a runaway loop must be stopped even if the
    // action it is looping on happens to be perfectly legal. --------------
    if (ctx.stepsTaken >= this.config.limits.maxSteps) {
      return {
        allow: false,
        risk,
        code: 'step_limit',
        reason: `step limit reached (${ctx.stepsTaken}/${this.config.limits.maxSteps})`,
      };
    }
    if (ctx.elapsedMs >= this.config.limits.maxDurationMs) {
      return {
        allow: false,
        risk,
        code: 'duration_limit',
        reason: `duration limit reached (${ctx.elapsedMs}ms/${this.config.limits.maxDurationMs}ms)`,
      };
    }

    // --- 2. Verb allowlist. ------------------------------------------------
    if (!this.config.allowedActions.includes(action.type)) {
      return {
        allow: false,
        risk,
        code: 'action_not_allowed',
        reason: `action '${action.type}' is not in the allowed action list`,
      };
    }

    // --- 3. Navigation: origin then path. ----------------------------------
    if (action.type === 'navigate') {
      const nav = this.checkNavigation(action.uri, ctx, risk);
      if (nav) return nav;
    }

    // --- 4. Risk, interpreted through the current mode. ---------------------
    if (risk === 'risky') {
      if (ctx.mode === 'discovery') {
        // A human has already been shown this exact action and authorised it.
        // Without this branch the escalation is theatre: we would stop, ask a
        // person, be told yes, and refuse anyway. The authorisation is granted
        // for one action and revoked immediately afterwards by the caller, so
        // it cannot leak into the rest of the run.
        if (ctx.approved) {
          return { allow: true, risk, flagged: 'risky-approved-by-operator' };
        }
        const stance = this.config.risky.duringDiscovery;
        if (stance === 'block') {
          return {
            allow: false,
            risk,
            code: 'risky_action_blocked',
            reason: `risky control '${targetName ?? '<unnamed>'}' is blocked during discovery`,
          };
        }
        if (stance === 'escalate') {
          // NOT a crash. The caller (executor/agent) is expected to translate a
          // denial carrying `risky_action_needs_approval` into a human
          // escalation — cede the lease, let a person do it, record what they
          // did. The gate's job is to refuse to do it unattended; deciding
          // *who* gets asked is a level up.
          return {
            allow: false,
            risk,
            code: 'risky_action_needs_approval',
            reason: `risky control '${targetName ?? '<unnamed>'}' requires human approval during discovery`,
          };
        }
        // 'allow-and-flag': proceed, but the event is marked so the run's
        // evidence names every irreversible thing the model did unsupervised.
        return { allow: true, risk, flagged: 'risky-allowed-and-flagged' };
      }

      if (ctx.mode === 'replay' && !ctx.approved) {
        if (this.config.risky.duringReplayUnapproved === 'block') {
          return {
            allow: false,
            risk,
            code: 'risky_action_blocked',
            reason: `risky control '${targetName ?? '<unnamed>'}' cannot run from an unapproved capability`,
          };
        }
        return {
          allow: false,
          risk,
          code: 'risky_action_needs_approval',
          reason: `risky control '${targetName ?? '<unnamed>'}' needs approval before unattended replay`,
        };
      }

      // Approved replay: allowed, but still flagged, because "a human approved
      // this artifact" is the accountability record we want attached to the
      // event — the approval is the thing that carries responsibility, not the
      // model that chose the click.
      return { allow: true, risk, flagged: 'risky-approved' };
    }

    return { allow: true, risk: 'safe' };
  }

  private checkNavigation(uri: string, ctx: PolicyContext, risk: 'safe' | 'risky'): PolicyDecision | undefined {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      // An un-parseable URI cannot be proven to be on the allowlist, and
      // "cannot prove" means "deny".
      return { allow: false, risk, code: 'origin_not_allowed', reason: `navigation target '${uri}' is not a valid absolute URI` };
    }

    // A capability may NARROW its own permissions, never widen them. The
    // effective set is the intersection with the global list, so a hand-edited
    // or model-authored artifact declaring `https://production.example.com`
    // gains nothing: the intersection is empty and every navigation is denied.
    const effective =
      ctx.capabilityOrigins && ctx.capabilityOrigins.length > 0
        ? ctx.capabilityOrigins.map(safeOrigin).filter((o): o is string => o !== undefined && this.origins.has(o))
        : [...this.origins];

    if (!effective.includes(url.origin)) {
      return {
        allow: false,
        risk,
        code: 'origin_not_allowed',
        reason: `origin '${url.origin}' is not allowed (permitted: ${effective.join(', ') || '<none>'})`,
      };
    }

    if (!this.pathMatchers.some((re) => re.test(url.pathname))) {
      return {
        allow: false,
        risk,
        code: 'path_not_allowed',
        reason: `path '${url.pathname}' does not match any allowed path pattern`,
      };
    }

    return undefined;
  }

  /**
   * Classify a control by accessible name. Used at record time to stamp
   * `step.risk` on the artifact, and re-checked at replay against the live
   * policy — so tightening the policy retroactively tightens existing
   * capabilities rather than grandfathering them.
   *
   * THE HONEST GAP: when `targetName` is undefined we return 'safe'.
   *
   * The conservative alternative — treat every unnamed control as risky — was
   * considered and rejected. Legacy apps are full of unnamed controls (icon
   * buttons, image submits, table-cell links), so "unnamed ⇒ risky" would
   * escalate on a large fraction of ordinary navigation and operators would
   * learn to rubber-stamp the prompts, which is strictly worse than not
   * prompting. The residual exposure is real and named here rather than hidden:
   * an unlabelled destructive control classifies as safe. It is covered by a
   * different mechanism — the resolver refuses to act on ambiguous or unnamed
   * targets (Resolution 'ambiguous'/'not-found' never produces an action), so
   * an unnamed control cannot be reached by a descriptor in the first place.
   * The gap that remains is a discovery-time click on an unnamed ref, and that
   * path runs attended.
   */
  classifyRisk(actionType: ActionType, targetName: string | undefined): 'safe' | 'risky' {
    // navigate / read / wait are non-mutating by construction.
    //
    // `press` is treated as safe INCLUDING Enter. Justification: in the target
    // class of app, Enter is overwhelmingly "run this lookup" — a keystroke in a
    // member-id field — and destructive operations are always explicit, named
    // buttons. Classifying every Enter as risky would escalate on essentially
    // every search and train operators to click through approvals. The residual
    // case (Enter while focus happens to sit on a `Post` button) is a real gap;
    // it is bounded by the fact that discovery runs attended and replay only
    // presses keys that were recorded and reviewed.
    if (!RISK_ELIGIBLE.has(actionType)) return 'safe';
    if (targetName === undefined) return 'safe'; // see THE HONEST GAP above
    const name = targetName.toLowerCase();
    return this.riskyPatterns.some((p) => name.includes(p)) ? 'risky' : 'safe';
  }

  /**
   * Action-aware wrapper used at enforcement time. Identical to `classifyRisk`
   * except that a `type` action is only eligible when it submits: putting
   * characters into a textbox changes nothing until something is submitted, so
   * treating a keystroke as irreversible would be noise.
   */
  private classifyActionRisk(action: Action, targetName?: string): 'safe' | 'risky' {
    if (action.type === 'type' && action.submit !== true) return 'safe';
    return this.classifyRisk(action.type, targetName);
  }
}

function safeOrigin(raw: string): string | undefined {
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}
