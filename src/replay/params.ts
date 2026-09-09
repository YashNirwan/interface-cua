/**
 * Input validation and template binding.
 *
 * This file is the capability's front door. Everything here runs *before* a
 * browser is opened, because the cheapest possible failure is the one that
 * costs no session, no page load and no audit noise: a caller that passes a
 * malformed member id should get `invalid_input` in microseconds, not a
 * `target_not_found` three screens into a legacy core banking app.
 *
 * Two responsibilities:
 *
 *   1. Validate the invocation against the capability's declared `inputs`
 *      contract, producing a flat `bound` map of strings.
 *   2. Substitute `{{param}}` placeholders into the recorded flow — URIs,
 *      typed text, accessible names, checkpoint conditions and extraction
 *      patterns — so one recorded run generalizes to every argument.
 *
 * Binding produces STRINGS only. The artifact is a template document; the type
 * system's job (ParamSpec.type) is to police what a caller may supply, not to
 * survive into the DOM. Typed values reappear on the way *out*, in extract.ts.
 */

import type {
  Capability,
  Condition,
  Extraction,
  ExtractionSource,
  ParamSpec,
  TargetDescriptorSpec,
} from '../artifact/schema.js';
import type { Redactor } from '../policy/types.js';

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/**
 * Global form, used only with String.replace (which resets lastIndex itself).
 * Never call .test() on this — a stateful /g regex is a classic silent bug.
 */
const PLACEHOLDER_G = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const PLACEHOLDER_TEST = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/;

/**
 * Thrown when a template references a parameter the invocation did not bind.
 *
 * This is deliberately fatal rather than "leave the placeholder in place".
 * Typing the literal text `{{memberId}}` into a search box does not fail — it
 * *succeeds*, and returns "no results found", which the caller then reads as a
 * legitimate business answer. A confusing wrong answer is strictly worse than a
 * loud wrong-input error, so we refuse to emit a half-bound string.
 */
export class UnboundPlaceholderError extends Error {
  constructor(
    readonly missing: string[],
    readonly template: string,
  ) {
    super(
      `unbound template placeholder(s) ${missing.map((m) => `{{${m}}}`).join(', ')} in "${template}" — ` +
        'the capability references a parameter this invocation did not bind',
    );
    this.name = 'UnboundPlaceholderError';
  }
}

export function hasPlaceholder(s: string): boolean {
  return PLACEHOLDER_TEST.test(s);
}

/** Replace every `{{name}}` in `tpl`. Throws if any placeholder is unbound. */
export function bindTemplate(tpl: string, bound: Record<string, string>): string {
  const missing: string[] = [];
  const out = tpl.replace(PLACEHOLDER_G, (_match, name: string) => {
    const v = bound[name];
    if (v === undefined) {
      missing.push(name);
      return '';
    }
    return v;
  });
  if (missing.length > 0) throw new UnboundPlaceholderError([...new Set(missing)], tpl);
  return out;
}

/** Bind only if the string actually contains a placeholder. Cheap and total. */
function bindIfTemplated(s: string, bound: Record<string, string>): string {
  return hasPlaceholder(s) ? bindTemplate(s, bound) : s;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true; bound: Record<string, string> }
  | { ok: false; errors: string[] };

/**
 * Anchor a declared pattern so `^...$` semantics are guaranteed regardless of
 * how the capability author wrote it.
 *
 * An unanchored `\d{6}` would accept `../../etc/passwd?x=123456`. Anchoring is
 * the difference between "the pattern documents the shape" and "the pattern is
 * a validation control". We strip any anchors the author already supplied so we
 * never build a doubly-anchored, subtly different expression.
 */
function anchoredPattern(pattern: string): RegExp {
  const body = pattern.replace(/^\^/, '').replace(/\$$/, '');
  return new RegExp(`^(?:${body})$`);
}

/** Coerce a caller-supplied scalar into the string form the templates need. */
function coerceScalar(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return null;
}

const TRUEY = new Set(['true', 'yes', 'y', '1']);
const FALSEY = new Set(['false', 'no', 'n', '0']);

/** Type-level check against the declared ParamSpec.type. */
function checkDeclaredType(name: string, spec: ParamSpec, value: string): string | null {
  switch (spec.type) {
    case 'number':
    case 'money': {
      // Accept the human forms a caller might reasonably send; the browser only
      // ever sees what we hand it, so we normalize nothing here beyond checking.
      if (!Number.isFinite(Number(value.replace(/[,\s$]/g, '')))) {
        return `input '${name}' must be a ${spec.type}, got "${value}"`;
      }
      return null;
    }
    case 'boolean':
      if (!TRUEY.has(value.toLowerCase()) && !FALSEY.has(value.toLowerCase())) {
        return `input '${name}' must be a boolean, got "${value}"`;
      }
      return null;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) {
        return `input '${name}' must be a date (YYYY-MM-DD or MM/DD/YYYY), got "${value}"`;
      }
      return null;
    case 'string':
    case 'enum':
      return null;
  }
}

/**
 * Validate an invocation against the capability's declared input contract.
 *
 * Failure maps to FailureClass 'invalid_input' upstream. Nothing in here
 * touches a Surface — that is the point.
 */
export function validateInputs(
  cap: Capability,
  args: Record<string, unknown>,
  secrets: (key: string) => string | undefined,
): ValidateResult {
  const errors: string[] = [];
  const bound: Record<string, string> = {};
  const declared = Object.entries(cap.inputs);
  const declaredNames = new Set(declared.map(([n]) => n));

  // Fail closed on unknown parameters. A permissive reading ("extra keys are
  // harmless") is wrong for two reasons: an unknown key is usually a typo on a
  // REQUIRED param, which would otherwise surface as a confusing mid-flow
  // failure; and silently ignoring caller-supplied keys is how an unreviewed
  // field eventually becomes load-bearing. The contract is the whole surface
  // area, so anything outside it is an error.
  for (const key of Object.keys(args)) {
    if (!declaredNames.has(key)) {
      errors.push(`unknown parameter '${key}' — capability '${cap.id}' declares [${[...declaredNames].join(', ')}]`);
    }
  }

  for (const [name, spec] of declared) {
    if (spec.source === 'secret-store') {
      // A secret is NEVER accepted from the caller, even if the value would be
      // correct. The calling agent is untrusted-by-construction: it may itself
      // be driven by a model reading attacker-influenced text. If credentials
      // could ride in on `args`, a compromised caller could make the automation
      // sign in as somebody else, using this system's network position and its
      // audit identity. The only path to a credential is the operator's secret
      // store, keyed by a name that lives in the reviewed artifact.
      if (Object.prototype.hasOwnProperty.call(args, name)) {
        errors.push(
          `input '${name}' is sourced from the secret store and must not be supplied by the caller ` +
            '(rejected to prevent credential injection)',
        );
        continue;
      }
      const key = spec.secretKey;
      if (key === undefined) {
        // Schema-enforced, but we do not trust a hand-edited artifact.
        errors.push(`input '${name}' is secret-store sourced but declares no secretKey`);
        continue;
      }
      const resolved = secrets(key);
      if (resolved === undefined || resolved === '') {
        if (spec.required) errors.push(`secret '${key}' (for input '${name}') is not present in the secret store`);
        continue;
      }
      // Note: no pattern/enum check on secrets. We do not want a validation
      // failure message that leaks the shape of a credential into the log.
      bound[name] = resolved;
      continue;
    }

    // ---- caller-sourced ----
    const supplied = Object.prototype.hasOwnProperty.call(args, name) ? args[name] : undefined;
    const rawValue = supplied === undefined || supplied === null ? spec.default : supplied;

    if (rawValue === undefined || rawValue === null || rawValue === '') {
      if (spec.required) errors.push(`missing required input '${name}' (${spec.description})`);
      continue;
    }

    const value = coerceScalar(rawValue);
    if (value === null) {
      errors.push(`input '${name}' must be a string, number or boolean, got ${typeof rawValue}`);
      continue;
    }

    const typeError = checkDeclaredType(name, spec, value);
    if (typeError !== null) {
      errors.push(typeError);
      continue;
    }

    if (spec.enum !== undefined && spec.enum.length > 0 && !spec.enum.includes(value)) {
      errors.push(`input '${name}' must be one of [${spec.enum.join(', ')}], got "${value}"`);
      continue;
    }

    if (spec.pattern !== undefined) {
      let re: RegExp;
      try {
        re = anchoredPattern(spec.pattern);
      } catch {
        // An unusable pattern is an authoring bug, not a caller bug — but it
        // must fail closed, or the control silently stops existing.
        errors.push(`input '${name}' declares an invalid pattern /${spec.pattern}/`);
        continue;
      }
      if (!re.test(value)) {
        errors.push(`input '${name}' does not match required pattern /${spec.pattern}/`);
        continue;
      }
    }

    bound[name] = value;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, bound };
}

// ---------------------------------------------------------------------------
// Binding into the recorded flow
// ---------------------------------------------------------------------------

/**
 * Bind a target descriptor.
 *
 * `nameMatch: 'template'` means "this name is a format string recorded against
 * one specific invocation" (e.g. `Member {{memberId}} — Profile`). After
 * binding, the name is a literal, so the match mode collapses to 'exact':
 * keeping it as 'template' downstream would leave the resolver with a mode it
 * has no way to interpret.
 */
export function bindDescriptor(d: TargetDescriptorSpec, bound: Record<string, string>): TargetDescriptorSpec {
  const isTemplate = d.nameMatch === 'template';
  const next: TargetDescriptorSpec = {
    ...d,
    name: isTemplate ? bindTemplate(d.name, bound) : bindIfTemplated(d.name, bound),
    nameMatch: isTemplate ? 'exact' : d.nameMatch,
    framePath: d.framePath.map((f) => bindIfTemplated(f, bound)),
  };
  if (d.section !== undefined) next.section = bindIfTemplated(d.section, bound);
  if (d.textNear !== undefined) next.textNear = d.textNear.map((t) => bindIfTemplated(t, bound));
  return next;
}

/** Bind every string inside a condition tree, recursively. */
export function bindCondition(c: Condition, bound: Record<string, string>): Condition {
  if ('textPresent' in c) return { textPresent: bindIfTemplated(c.textPresent, bound) };
  if ('textAbsent' in c) return { textAbsent: bindIfTemplated(c.textAbsent, bound) };
  if ('textMatches' in c) return { textMatches: bindIfTemplated(c.textMatches, bound) };
  if ('uriMatches' in c) return { uriMatches: bindIfTemplated(c.uriMatches, bound) };
  if ('elementPresent' in c) return { elementPresent: bindDescriptor(c.elementPresent, bound) };
  if ('elementAbsent' in c) return { elementAbsent: bindDescriptor(c.elementAbsent, bound) };
  if ('all' in c) return { all: c.all.map((s) => bindCondition(s, bound)) };
  if ('any' in c) return { any: c.any.map((s) => bindCondition(s, bound)) };
  return { not: bindCondition(c.not, bound) };
}

/** Bind an extraction source (label text, regex pattern, target descriptor). */
export function bindExtractionSource(src: ExtractionSource, bound: Record<string, string>): ExtractionSource {
  if ('element' in src) return { element: bindDescriptor(src.element, bound) };
  if ('textPattern' in src) return { textPattern: bindIfTemplated(src.textPattern, bound) };
  const within = src.labeledValue.within;
  const row = src.labeledValue.row;
  return {
    labeledValue: {
      label: bindIfTemplated(src.labeledValue.label, bound),
      ...(within !== undefined ? { within: bindDescriptor(within, bound) } : {}),
      // The row anchor is bindable too: "the {{accountType}} row" is a
      // legitimate parameterization. Rebuilding this object field-by-field is
      // what dropped it when `row` was added, so keep the spread explicit and
      // remember that any new field must be handled here as well.
      ...(row !== undefined ? { row: bindIfTemplated(row, bound) } : {}),
    },
  };
}

export function bindExtraction(e: Extraction, bound: Record<string, string>): Extraction {
  return { ...e, from: bindExtractionSource(e.from, bound) };
}

export function bindExtractions(es: Extraction[], bound: Record<string, string>): Extraction[] {
  return es.map((e) => bindExtraction(e, bound));
}

// ---------------------------------------------------------------------------
// Redaction hook
// ---------------------------------------------------------------------------

/**
 * A log-safe view of the bound parameters.
 *
 * The classification comes off the *contract* (ParamSpec.sensitivity), not from
 * guessing at the log site. That is the whole reason sensitivity lives on the
 * schema: there is exactly one place that decides whether a member id may be
 * written to disk, and it is reviewable in a pull request.
 */
export function describeBoundParams(
  cap: Capability,
  bound: Record<string, string>,
  redactor: Redactor,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(bound)) {
    const spec = cap.inputs[name];
    const sensitivity = spec?.sensitivity ?? 'public';
    if (sensitivity === 'secret') {
      // Defence in depth: a secret's raw value is never handed to the redactor
      // at all. The redactor is trusted, but the cheapest way to guarantee a
      // credential is not in a log line is to never pass it to anything that
      // writes one.
      out[name] = '[secret]';
      continue;
    }
    out[name] = redactor.value(value, sensitivity);
  }
  return out;
}
