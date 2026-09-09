/**
 * The predicate evaluator.
 *
 * A Condition is a PURE function of a single Observation. Two properties fall
 * out of that, and both are load-bearing:
 *
 *   1. Evaluating a condition can never mutate the page. A checkpoint that
 *      could act on the UI would mean assertions have side effects, and a
 *      failing assertion could leave the session somewhere the flow never
 *      intended. So this file resolves descriptors against `obs.nodes` via
 *      `resolveDescriptor` rather than calling `surface.resolve()`.
 *   2. Every condition kind is unit-testable against a hand-built Observation,
 *      with no browser anywhere. The predicate language is the part of the
 *      artifact a human reviews, so it has to be the part we can test hardest.
 *
 * The other thing this file owes the rest of the system is a good `describe`
 * string. When replay fails at 3am, the difference between
 *
 *     checkpoint_failed at step 'open-member'
 *
 * and
 *
 *     checkpoint_failed at step 'open-member': expected
 *     text "Member 100482 — Profile" (not found); uri ~ /meridian/member/:id (matched)
 *
 * is the difference between re-running the flow to find out what happened and
 * knowing immediately that navigation worked but the page rendered someone
 * else's record. Describe strings are a debugging feature, so they get the same
 * care as the logic.
 */

import type { Condition, TargetDescriptorSpec } from '../artifact/schema.js';
import type { Observation, UiNode } from '../surface/types.js';
import { resolveDescriptor } from '../surface/web/resolve.js';

export interface ConditionResult {
  ok: boolean;
  /** Human-readable rendering of the condition *and* its verdict. */
  describe: string;
  /** Extra diagnostics: which sub-condition failed, a regex error, candidates. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/**
 * Collapse whitespace and case-fold.
 *
 * Legacy server-rendered HTML is full of incidental whitespace — a label may
 * arrive as `Member\n     100482  —  Profile` on one render and
 * `Member 100482 — Profile` on the next, purely because a template changed
 * indentation. Asserting on raw text would make checkpoints fail for reasons
 * that have nothing to do with the application's behaviour, which trains
 * operators to ignore checkpoint failures. Normalizing is what keeps a failing
 * checkpoint meaningful.
 */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Safe regex compilation
// ---------------------------------------------------------------------------

type CompiledRegex = { ok: true; re: RegExp } | { ok: false; error: string };

/**
 * A malformed regex in an artifact is a capability-authoring bug. It must never
 * escape as a thrown exception: the executor would report `internal` ("our
 * bug") for what is actually a reviewable defect in a data file. Returning
 * ok:false with the compile error names the right culprit.
 */
function compile(pattern: string, flags = 'i'): CompiledRegex {
  try {
    return { ok: true, re: new RegExp(pattern, flags) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

/** Render a descriptor the way a reviewer would say it out loud. */
export function describeTarget(d: TargetDescriptorSpec): string {
  const parts = [`${d.role} "${d.name}"`];
  if (d.nameMatch !== 'exact') parts.push(`(${d.nameMatch})`);
  if (d.section !== undefined && d.section !== '') parts.push(`in section "${d.section}"`);
  if (d.framePath.length > 0) parts.push(`in frame ${d.framePath.join(' > ')}`);
  if (d.ordinal !== undefined) parts.push(`#${d.ordinal}`);
  return parts.join(' ');
}

/** The condition as a noun phrase, with no verdict attached. */
export function describeCondition(cond: Condition): string {
  if ('textPresent' in cond) return `text "${cond.textPresent}"`;
  if ('textAbsent' in cond) return `absence of text "${cond.textAbsent}"`;
  if ('textMatches' in cond) return `text ~ /${cond.textMatches}/`;
  if ('uriMatches' in cond) return `uri ~ /${cond.uriMatches}/`;
  if ('elementPresent' in cond) return `element ${describeTarget(cond.elementPresent)}`;
  if ('elementAbsent' in cond) return `absence of element ${describeTarget(cond.elementAbsent)}`;
  if ('all' in cond) {
    if (cond.all.length === 0) return 'all of []';
    return `all of [${cond.all.map(describeCondition).join('; ')}]`;
  }
  if ('any' in cond) {
    if (cond.any.length === 0) return 'any of []';
    return `any of [${cond.any.map(describeCondition).join('; ')}]`;
  }
  return `not (${describeCondition(cond.not)})`;
}

// ---------------------------------------------------------------------------
// Leaf evaluators
// ---------------------------------------------------------------------------

function evalTextPresent(needle: string, obs: Observation): ConditionResult {
  const found = normalizeText(obs.text).includes(normalizeText(needle));
  return { ok: found, describe: `text "${needle}" (${found ? 'found' : 'not found'})` };
}

function evalTextAbsent(needle: string, obs: Observation): ConditionResult {
  const found = normalizeText(obs.text).includes(normalizeText(needle));
  return { ok: !found, describe: `absence of text "${needle}" (${found ? 'present' : 'absent'})` };
}

function evalTextMatches(pattern: string, obs: Observation): ConditionResult {
  const c = compile(pattern);
  if (!c.ok) {
    return {
      ok: false,
      describe: `text ~ /${pattern}/ (invalid regex)`,
      detail: `capability authoring bug: ${c.error}`,
    };
  }
  const matched = c.re.test(obs.text);
  return { ok: matched, describe: `text ~ /${pattern}/ (${matched ? 'matched' : 'no match'})` };
}

/**
 * URI matching tries the raw URI *and* the canonical path.
 *
 * A checkpoint recorded while looking at `/meridian/member/100482` would, if we
 * only ever tested the raw URI, be a per-invocation assertion masquerading as a
 * general one: it would fail for member 100517 for no good reason. The surface
 * hands us `canonicalPath` (`/meridian/member/:id`) precisely so a recorded
 * checkpoint can be written in the general form. We test both because either
 * form is legitimate — an author may genuinely want to assert on a query
 * string, which canonicalization drops.
 */
function evalUriMatches(pattern: string, obs: Observation): ConditionResult {
  const c = compile(pattern);
  if (!c.ok) {
    return {
      ok: false,
      describe: `uri ~ /${pattern}/ (invalid regex)`,
      detail: `capability authoring bug: ${c.error}`,
    };
  }
  const uri = obs.location.uri;
  const canonical = obs.location.canonicalPath;

  if (c.re.test(uri)) return { ok: true, describe: `uri ~ /${pattern}/ (matched)` };
  if (canonical !== undefined && canonical !== '' && c.re.test(canonical)) {
    return { ok: true, describe: `uri ~ /${pattern}/ (matched via canonicalPath)` };
  }
  return {
    ok: false,
    describe: `uri ~ /${pattern}/ (no match)`,
    detail: `uri=${uri}${canonical !== undefined ? ` canonicalPath=${canonical}` : ''}`,
  };
}

/** What resolution tells us about presence, as one word plus diagnostics. */
function presence(d: TargetDescriptorSpec, nodes: UiNode[]): { present: boolean; note: string } {
  const res = resolveDescriptor(d, nodes);
  if (res.ok) return { present: true, note: `matched via ${res.tier}` };
  if (res.reason === 'ambiguous') {
    /*
     * An ambiguous resolution means SOMETHING matching the descriptor is on the
     * screen — we just cannot say which one to act on. For a presence question
     * that is a yes: "is the error banner showing?" is answered by finding two
     * error banners. Treating ambiguity as absence would let a checkpoint pass
     * because the page grew an extra copy of the thing we were asserting
     * exists, which is exactly backwards.
     *
     * The corollary is that `elementAbsent` treats ambiguity as present too
     * (it is `not present`), which is the conservative direction: we refuse to
     * claim a control is gone when several of them are on screen.
     */
    return { present: true, note: `ambiguous: ${res.candidates} candidates via ${res.tier} [${res.sample.join(' | ')}]` };
  }
  return { present: false, note: `not found; tried ${res.tried.join(' -> ')}` };
}

function evalElementPresent(d: TargetDescriptorSpec, obs: Observation): ConditionResult {
  const { present, note } = presence(d, obs.nodes);
  return {
    ok: present,
    describe: `element ${describeTarget(d)} (${present ? 'found' : 'not found'})`,
    detail: note,
  };
}

function evalElementAbsent(d: TargetDescriptorSpec, obs: Observation): ConditionResult {
  const { present, note } = presence(d, obs.nodes);
  return {
    ok: !present,
    describe: `absence of element ${describeTarget(d)} (${present ? 'present' : 'absent'})`,
    detail: note,
  };
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/**
 * Evaluate a condition against one observation.
 *
 * On combinators: the DECISION short-circuits (an `all` is false the moment one
 * child is false, and we never let a later child change that), but we still
 * evaluate the remaining children to build the description. That is safe here
 * and nowhere else: conditions are pure functions over an already-captured,
 * in-memory Observation, so "evaluating" a sibling costs a few microseconds of
 * string work and performs no I/O, no resolution against a live page, and no
 * action. The payoff is a failure line that reports the full shape of the
 * assertion — `text "..." (not found); uri ~ ... (matched)` — instead of
 * stopping at the first `false` and leaving the operator to guess whether the
 * rest would have held.
 */
export function evaluate(cond: Condition, obs: Observation): ConditionResult {
  if ('textPresent' in cond) return evalTextPresent(cond.textPresent, obs);
  if ('textAbsent' in cond) return evalTextAbsent(cond.textAbsent, obs);
  if ('textMatches' in cond) return evalTextMatches(cond.textMatches, obs);
  if ('uriMatches' in cond) return evalUriMatches(cond.uriMatches, obs);
  if ('elementPresent' in cond) return evalElementPresent(cond.elementPresent, obs);
  if ('elementAbsent' in cond) return evalElementAbsent(cond.elementAbsent, obs);

  if ('all' in cond) {
    if (cond.all.length === 0) {
      // An empty conjunction is vacuously true. Say so loudly rather than
      // silently, because "success" from an empty assertion is worth noticing.
      return { ok: true, describe: 'all of [] (vacuously true)', detail: 'empty conjunction asserts nothing' };
    }
    const parts = cond.all.map((c) => evaluate(c, obs));
    const failed = parts.filter((p) => !p.ok);
    const describe = parts.map((p) => p.describe).join('; ');
    if (failed.length === 0) return { ok: true, describe };
    const first = failed[0];
    return {
      ok: false,
      describe,
      detail: `failing sub-condition: ${first?.describe ?? '(unknown)'}${
        first?.detail !== undefined ? ` — ${first.detail}` : ''
      }${failed.length > 1 ? ` (+${failed.length - 1} more failing)` : ''}`,
    };
  }

  if ('any' in cond) {
    if (cond.any.length === 0) {
      // An empty disjunction is vacuously false — and, unlike the `all` case,
      // that is almost certainly an authoring mistake, so we flag it.
      return { ok: false, describe: 'any of [] (vacuously false)', detail: 'empty disjunction can never hold' };
    }
    const parts = cond.any.map((c) => evaluate(c, obs));
    const satisfied = parts.find((p) => p.ok);
    if (satisfied !== undefined) {
      return { ok: true, describe: `any of [${parts.map((p) => p.describe).join('; ')}]`, detail: `satisfied by: ${satisfied.describe}` };
    }
    return {
      ok: false,
      describe: `any of [${parts.map((p) => p.describe).join('; ')}]`,
      detail: 'no alternative held',
    };
  }

  const inner = evaluate(cond.not, obs);
  return {
    ok: !inner.ok,
    describe: `not (${inner.describe})`,
    ...(inner.detail !== undefined ? { detail: inner.detail } : {}),
  };
}
