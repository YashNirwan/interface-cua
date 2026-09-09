/**
 * Tenant overlays.
 *
 * One base capability per vendor product; a thin per-tenant patch for the
 * handful of things that actually differ — the host, a renamed button, a
 * confirmation dialog only some institutions enable. The overlay is small
 * enough to review in a pull request, which is the whole argument for it: drift
 * shows up as an overlay growing rather than as N re-recorded flows silently
 * diverging from each other.
 *
 * Two invariants this file exists to hold:
 *
 *   The base is never mutated. It is a shared, in-memory object serving every
 *   tenant on the same core. A patch that reached through into it would leak
 *   one credit union's button label into another's run, and the symptom would
 *   appear in an unrelated tenant, hours later, non-deterministically.
 *
 *   The result is re-validated. An overlay is a data file written by whoever
 *   onboarded a tenant; without a re-parse it can quietly produce a capability
 *   that no longer satisfies its own schema — a step whose target lost its role,
 *   an outcome scoped to a step that was skipped away. Re-parsing is what stops
 *   a bad tenant override from degrading a shared capability instead of failing
 *   at onboarding time, where somebody is watching.
 */

import {
  zCapability,
  type Capability,
  type Overlay,
  type Step,
  type TargetDescriptorSpec,
} from '../artifact/schema.js';

export class OverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlayError';
  }
}

// ---------------------------------------------------------------------------
// Minimal semver range checking
// ---------------------------------------------------------------------------

type Triple = [number, number, number];

function parseVersion(v: string): Triple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/** Widen a partial version (`1`, `1.2`) into a lower bound. */
function lowerBound(parts: string[]): Triple {
  return [Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0)];
}

/**
 * Supports `*`, `1.x` / `1.2.x`, `^1.2.0`, `~1.2.0`, `>= > <= < =` comparators,
 * exact versions, and whitespace-separated conjunctions (`>=1.0.0 <2.0.0`).
 *
 * Honest limitations: no `||` disjunction, no pre-release or build metadata, no
 * hyphen ranges. A dependency would give us all of those, but a range check is
 * ~40 lines and this is a submission-scale repo where an unnecessary dependency
 * is itself a cost. An unrecognized clause THROWS rather than defaulting to
 * true — a range we cannot interpret must not be read as "applies to
 * everything", because that is the direction that silently applies a v1 overlay
 * to a v3 capability.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (v === null) throw new OverlayError(`'${version}' is not a valid semver version`);

  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x') return true;

  return trimmed.split(/\s+/).every((clause) => satisfiesClause(v, clause));
}

function satisfiesClause(v: Triple, clause: string): boolean {
  if (clause === '*' || clause === 'x') return true;

  const cmpMatch = /^(>=|<=|>|<|=)\s*(\d+\.\d+\.\d+)$/.exec(clause);
  if (cmpMatch !== null) {
    const bound = parseVersion(cmpMatch[2] ?? '');
    if (bound === null) throw new OverlayError(`unsupported version range clause '${clause}'`);
    const c = compare(v, bound);
    switch (cmpMatch[1]) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  }

  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(clause);
  if (caret !== null) {
    const lo: Triple = [Number(caret[1]), Number(caret[2]), Number(caret[3])];
    if (compare(v, lo) < 0) return false;
    // Standard caret semantics: the range is bounded by the leftmost non-zero
    // component, because pre-1.0 minor bumps are breaking by convention.
    const hi: Triple = lo[0] !== 0 ? [lo[0] + 1, 0, 0] : lo[1] !== 0 ? [0, lo[1] + 1, 0] : [0, 0, lo[2] + 1];
    return compare(v, hi) < 0;
  }

  const tilde = /^~(\d+)\.(\d+)\.(\d+)$/.exec(clause);
  if (tilde !== null) {
    const lo: Triple = [Number(tilde[1]), Number(tilde[2]), Number(tilde[3])];
    if (compare(v, lo) < 0) return false;
    return compare(v, [lo[0], lo[1] + 1, 0]) < 0;
  }

  const wildcard = /^(\d+)(?:\.(\d+))?\.(?:x|\*)$/.exec(clause);
  if (wildcard !== null) {
    const parts = [wildcard[1] ?? '0', wildcard[2] ?? '0'];
    const lo = lowerBound(parts);
    const hi: Triple = wildcard[2] === undefined ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0];
    return compare(v, lo) >= 0 && compare(v, hi) < 0;
  }

  const exact = parseVersion(clause);
  if (exact !== null) return compare(v, exact) === 0;

  throw new OverlayError(
    `unsupported version range clause '${clause}' — supported: *, 1.x, 1.2.x, ^1.2.0, ~1.2.0, >=1.0.0, exact`,
  );
}

// ---------------------------------------------------------------------------
// Field-level merging
// ---------------------------------------------------------------------------

/**
 * Shallow-merge a descriptor field by field, so an overlay that only renames a
 * button keeps the base's section, frame path and ordinal. Replacing the whole
 * descriptor would force every tenant to restate the disambiguators, which is
 * how overlays stop being small and start being forks.
 */
function mergeTarget(base: TargetDescriptorSpec, patch: Partial<TargetDescriptorSpec>): TargetDescriptorSpec {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  // The cast is confined to this function: `out` was built from a valid
  // descriptor plus a Partial of the same type, and zCapability.parse below
  // re-checks it. Not typed as `any` — this is a widen-then-narrow, not a hole.
  return out as unknown as TargetDescriptorSpec;
}

function targetOf(step: Step): TargetDescriptorSpec | null {
  const a = step.action;
  return a.type === 'click' || a.type === 'type' || a.type === 'select' ? a.target : null;
}

function withTarget(step: Step, target: TargetDescriptorSpec): Step {
  const a = step.action;
  if (a.type === 'click') return { ...step, action: { ...a, target } };
  if (a.type === 'type') return { ...step, action: { ...a, target } };
  if (a.type === 'select') return { ...step, action: { ...a, target } };
  return step;
}

// ---------------------------------------------------------------------------
// applyOverlay
// ---------------------------------------------------------------------------

export function applyOverlay(base: Capability, overlay: Overlay): Capability {
  if (overlay.overlayFor.capabilityId !== base.id) {
    throw new OverlayError(
      `overlay ${overlay.tenantId} targets capability '${overlay.overlayFor.capabilityId}' but was applied to '${base.id}'`,
    );
  }
  if (!satisfiesRange(base.version, overlay.overlayFor.versionRange)) {
    throw new OverlayError(
      `overlay ${overlay.tenantId} declares versionRange '${overlay.overlayFor.versionRange}' ` +
        `which capability ${base.id}@${base.version} does not satisfy — re-verify the overlay against this version`,
    );
  }

  // Deep clone up front. Everything below edits the copy, so there is no path
  // by which a nested array or descriptor stays shared with the base.
  const next: Capability = structuredClone(base);

  if (overlay.entryUri !== undefined) next.entry = { ...next.entry, uri: overlay.entryUri };

  const unknownStepIds = Object.keys(overlay.steps).filter((id) => !base.steps.some((s) => s.id === id));
  if (unknownStepIds.length > 0) {
    // A patch for a step that no longer exists is the classic silent-no-op:
    // the tenant thinks their rename is applied, and replay uses the base name.
    throw new OverlayError(
      `overlay ${overlay.tenantId} patches unknown step(s) [${unknownStepIds.join(', ')}] on ${base.id}@${base.version}`,
    );
  }

  const skipped = new Set<string>();
  const steps: Step[] = [];
  for (const step of next.steps) {
    const patch = overlay.steps[step.id];
    if (patch === undefined) {
      steps.push(step);
      continue;
    }
    if (patch.skip === true) {
      skipped.add(step.id);
      continue;
    }

    let patched: Step = { ...step };

    if (patch.target !== undefined) {
      const baseTarget = targetOf(patched);
      if (baseTarget === null) {
        throw new OverlayError(
          `overlay ${overlay.tenantId} patches the target of step '${step.id}', which is a '${step.action.type}' action and has none`,
        );
      }
      patched = withTarget(patched, mergeTarget(baseTarget, patch.target));
    }

    if (patch.text !== undefined) {
      if (patched.action.type !== 'type') {
        throw new OverlayError(
          `overlay ${overlay.tenantId} patches the text of step '${step.id}', which is a '${step.action.type}' action`,
        );
      }
      patched = { ...patched, action: { ...patched.action, text: patch.text } };
    }

    if (patch.timeoutMs !== undefined) patched = { ...patched, timeoutMs: patch.timeoutMs };

    steps.push(patched);
  }

  // Skipping a step that an outcome is scoped to would silently un-declare that
  // business outcome, turning "insufficient funds" back into a checkpoint
  // failure for this tenant only. Refuse, and say exactly what to fix.
  for (const outcome of next.outcomes) {
    if (outcome.afterStep !== undefined && skipped.has(outcome.afterStep)) {
      throw new OverlayError(
        `overlay ${overlay.tenantId} skips step '${outcome.afterStep}', but outcome '${outcome.code}' is scoped to it — ` +
          're-scope the outcome or stop skipping the step',
      );
    }
  }

  next.steps = steps;
  next.recoveries = [...next.recoveries, ...structuredClone(overlay.extraRecoveries)];
  next.tenantId = overlay.tenantId;
  next.provenance = {
    ...next.provenance,
    basedOn: { capabilityId: base.id, version: base.version },
  };

  try {
    return zCapability.parse(next);
  } catch (err) {
    throw new OverlayError(
      `overlay ${overlay.tenantId} produced an invalid capability from ${base.id}@${base.version}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}
