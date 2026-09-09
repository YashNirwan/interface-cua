/**
 * Descriptor -> node resolution.
 *
 * This is the function that decides whether a capability recorded last month
 * still works today, so it is worth being explicit about the theory behind it.
 *
 * We rank identification strategies by how tightly each one couples to
 * something a vendor can change WITHOUT changing what the screen means:
 *
 *   1-2. role + accessible name (+ section)  A rename here is a real change to
 *                                            the UI's meaning. If "Search"
 *                                            becomes "Find", a human operator
 *                                            also has to relearn the screen.
 *   3-4. normalized / substring name         Survives casing, punctuation and
 *                                            label padding churn.
 *   5.   neighbouring text                   Survives a control being renamed
 *                                            while its row label is stable.
 *   6.   framework identifiers               `ctl00$MainContent$txtMemberId`
 *                                            changes when someone reorders a
 *                                            panel. Useful, but never trusted
 *                                            over semantics.
 *   7.   ordinal position                    "the third button". Always works,
 *                                            often wrongly. Last resort, and
 *                                            loudly flagged when used.
 *
 * The cascade returns the first tier that identifies EXACTLY ONE control. The
 * tier that fired is returned to the caller, which is how the replay engine
 * detects drift: a step that used to resolve on name and now resolves on
 * ordinal still passes, but it is one rename away from silently clicking the
 * wrong thing, and we would rather report that while it still works.
 */

import {
  RESOLUTION_TIER_ORDER,
  type Resolution,
  type ResolutionTier,
  type TargetDescriptor,
  type UiNode,
} from '../types.js';

/** Case/whitespace/punctuation-insensitive form used by the middle tiers. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‐-―−]/g, '-') // unicode dashes -> hyphen
    .replace(/[:.,;•*]/g, ' ')
    .replace(/[-_/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameFrame(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function describeNode(n: UiNode): string {
  const section = n.section ? ` in section '${n.section}'` : '';
  const frame = n.framePath.length ? ` [frame: ${n.framePath.join(' > ')}]` : '';
  return `${n.role} '${n.name}'${section}${frame}`;
}

/**
 * Turn a perceived node into the durable form we store in an artifact.
 *
 * Note what is deliberately NOT carried over: the ephemeral `ref`, the current
 * `value`, and anything else that describes this moment rather than this
 * control. `hint` is narrowed to the three attributes that are occasionally
 * useful and discards the rest, because a descriptor that quietly accumulates
 * page state is a descriptor that stops matching tomorrow.
 */
/**
 * Neighbouring text is only useful as an anchor if it will still be there
 * tomorrow. A row's balance (`$4,812.55`), a posting date, or a running total
 * all sit right next to the control we want and all change between runs —
 * baking one into a descriptor produces a locator that works exactly once.
 * The row's *type* ("Savings") is the durable anchor, so we keep that class of
 * text and discard the volatile class.
 */
export function isStableAnchor(t: string): boolean {
  const s = t.trim();
  if (s.length < 3 || s.length > 60) return false;
  if (/[$£€]|\d{1,3}(,\d{3})+(\.\d+)?|\b\d+\.\d{2}\b/.test(s)) return false; // money
  if (/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}:\d{2}\b/.test(s)) return false; // dates/times
  if (/^-?[\d.,%]+$/.test(s)) return false; // bare numbers
  if (/\b\d{6,}\b/.test(s)) return false; // identifiers
  return true;
}

export function descriptorFromNode(n: UiNode): TargetDescriptor {
  const hint: Record<string, string> = {};
  for (const k of ['id', 'name', 'type'] as const) {
    const v = n.hint?.[k];
    if (v) hint[k] = v;
  }
  const d: TargetDescriptor = {
    role: n.role,
    name: n.name,
    nameMatch: 'exact',
    framePath: [...n.framePath],
  };
  if (n.section) d.section = n.section;
  if (typeof n.ordinal === 'number') d.ordinal = n.ordinal;
  const near = (n.textNear ?? []).filter(isStableAnchor).slice(0, 2);
  if (near.length) d.textNear = near;
  if (Object.keys(hint).length) d.hint = hint;
  return d;
}

type TierFn = (d: TargetDescriptor, nodes: UiNode[]) => UiNode[];

const TIERS: Record<ResolutionTier, TierFn> = {
  'exact-name-in-section': (d, nodes) =>
    nodes.filter(
      (n) =>
        n.role === d.role &&
        n.name === d.name &&
        sameFrame(n.framePath, d.framePath) &&
        // Only meaningful when the descriptor actually carries a section;
        // otherwise this tier would be identical to the next one.
        d.section !== undefined &&
        n.section === d.section,
    ),

  'exact-name-in-frame': (d, nodes) =>
    nodes.filter((n) => n.role === d.role && n.name === d.name && sameFrame(n.framePath, d.framePath)),

  'normalized-name': (d, nodes) => {
    const want = normalizeName(d.name);
    return nodes.filter((n) => n.role === d.role && sameFrame(n.framePath, d.framePath) && normalizeName(n.name) === want);
  },

  'contains-name': (d, nodes) => {
    const want = normalizeName(d.name);
    if (want.length < 3) return []; // a 2-char substring matches everything
    return nodes.filter((n) => {
      if (n.role !== d.role || !sameFrame(n.framePath, d.framePath)) return false;
      const have = normalizeName(n.name);
      return have.includes(want) || want.includes(have);
    });
  },

  'near-text': (d, nodes) => {
    if (!d.textNear?.length) return [];
    const wanted = d.textNear.map(normalizeName).filter((t) => t.length > 2);
    if (!wanted.length) return [];
    return nodes.filter((n) => {
      if (n.role !== d.role || !sameFrame(n.framePath, d.framePath)) return false;
      const have = (n.textNear ?? []).map(normalizeName);
      return wanted.some((w) => have.some((h) => h.includes(w) || w.includes(h)));
    });
  },

  'surface-hint': (d, nodes) => {
    if (!d.hint) return [];
    const keys = ['id', 'name', 'type'] as const;
    const present = keys.filter((k) => d.hint?.[k]);
    if (!present.length) return [];
    return nodes.filter((n) => {
      if (n.role !== d.role) return false;
      // Require every hint the descriptor carries to match; a `type` match
      // alone would select every text input on the page.
      return present.every((k) => n.hint?.[k] === d.hint?.[k]) && present.some((k) => k === 'id' || k === 'name');
    });
  },

  ordinal: (d, nodes) => {
    if (typeof d.ordinal !== 'number') return [];
    const family = nodes.filter(
      (n) => n.role === d.role && sameFrame(n.framePath, d.framePath) && (d.section === undefined || n.section === d.section),
    );
    const hit = family[d.ordinal];
    return hit ? [hit] : [];
  },
};

/** Where in the cascade a given nameMatch mode should begin. */
function startTierIndex(nameMatch: TargetDescriptor['nameMatch']): number {
  switch (nameMatch) {
    case 'normalized':
      return RESOLUTION_TIER_ORDER.indexOf('normalized-name');
    case 'contains':
      return RESOLUTION_TIER_ORDER.indexOf('contains-name');
    // 'template' means the caller has already substituted parameters, so by
    // the time we see it, it is an exact name.
    case 'exact':
    case 'template':
    default:
      return 0;
  }
}

/**
 * Prefer an enabled control when a tier returns several and they differ only
 * by disabled state. Legacy apps commonly render a disabled duplicate of a
 * button (a greyed "Search" in a collapsed panel); clicking that one does
 * nothing and produces a baffling checkpoint failure three steps later.
 */
function preferEnabled(candidates: UiNode[]): UiNode[] {
  const enabled = candidates.filter((n) => !n.disabled);
  return enabled.length > 0 ? enabled : candidates;
}

export function resolveDescriptor(descriptor: TargetDescriptor, nodes: UiNode[]): Resolution {
  const start = startTierIndex(descriptor.nameMatch);
  const tried: ResolutionTier[] = [];
  let firstAmbiguity: { tier: ResolutionTier; candidates: UiNode[] } | undefined;

  for (let i = start; i < RESOLUTION_TIER_ORDER.length; i++) {
    const tier = RESOLUTION_TIER_ORDER[i]!;
    tried.push(tier);
    const raw = TIERS[tier](descriptor, nodes);
    if (raw.length === 0) continue;

    const candidates = preferEnabled(raw);
    if (candidates.length === 1) {
      return { ok: true, node: candidates[0]!, tier, candidates: 1 };
    }
    // More than one match: do NOT stop. A later, more specific tier (an
    // ordinal, a framework id) may still pick one out. We remember the
    // earliest ambiguity so that if nothing ever resolves we can report the
    // most semantically meaningful version of the problem, which is the one a
    // human fixing the artifact actually needs to see.
    if (!firstAmbiguity) firstAmbiguity = { tier, candidates };
  }

  if (firstAmbiguity) {
    return {
      ok: false,
      reason: 'ambiguous',
      tier: firstAmbiguity.tier,
      candidates: firstAmbiguity.candidates.length,
      sample: firstAmbiguity.candidates.slice(0, 4).map(describeNode),
    };
  }
  return { ok: false, reason: 'not-found', tried };
}

/** True when `used` is a weaker tier than `recorded`. Drives drift reporting. */
export function isWeakerTier(used: ResolutionTier, recorded: string | undefined): boolean {
  if (!recorded) return false;
  const a = RESOLUTION_TIER_ORDER.indexOf(used);
  const b = RESOLUTION_TIER_ORDER.indexOf(recorded as ResolutionTier);
  return a > -1 && b > -1 && a > b;
}
