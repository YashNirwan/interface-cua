/**
 * URL canonicalization.
 *
 * Two jobs, both of which exist because raw URLs are terrible identity keys:
 *
 *  1. `canonicalizePath` collapses volatile path segments (a member id, a
 *     transaction uuid) into `:id`, so that "the member profile screen" has ONE
 *     name across every invocation. Everything above this file — checkpoint
 *     conditions, policy origin/path allow-lists, evidence grouping — compares
 *     canonical paths, never raw ones. Without this, a capability recorded
 *     against /meridian/member/100482 would only ever match member 100482.
 *
 *  2. `matchesGlob` gives the policy layer a path-pattern language that is
 *     obviously bounded (no regex, no backtracking pathologies, no user-supplied
 *     regex injection) while still expressing the two things an operator
 *     actually wants: "exactly this segment" (`*`) and "this subtree" (`**`).
 *
 * Deliberately dependency-free and side-effect free: this is used from the
 * surface, from policy checks, and from tests.
 */

/** RFC 4122-shaped identifier. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bare hex/opaque token (session keys, ASP.NET-style handles). 8+ chars so we
 *  do not eat real words like "accounts" — which is why we also require a digit. */
const HEXISH_RE = /^[0-9a-f]{8,}$/i;
/** All-digits segment: the overwhelmingly common legacy record id. */
const DIGITS_RE = /^\d+$/;
/** Ticket/case style, e.g. ACH-4821, MBR-100482. */
const TICKET_RE = /^[A-Z]{2,4}-\d+$/;
/** Digit-heavy mixed token, e.g. 2024-11-30 or 100482a. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this path segment an instance identifier rather than part of the screen's
 * identity? Exported because the same question shows up when canonicalizing a
 * label ("Member 100482 — Profile") for a checkpoint.
 */
export function isVolatileSegment(segment: string): boolean {
  if (!segment) return false;
  if (DIGITS_RE.test(segment)) return true;
  if (UUID_RE.test(segment)) return true;
  if (DATE_RE.test(segment)) return true;
  if (TICKET_RE.test(segment)) return true;
  // Hex-looking tokens are only volatile if they actually contain a digit;
  // otherwise "downloads" (8 chars, all hex-legal letters) would be replaced.
  if (HEXISH_RE.test(segment) && /\d/.test(segment)) return true;
  return false;
}

/** Extract just the path portion, accepting either a full URI or a bare path. */
function pathOf(uri: string): string {
  try {
    return new URL(uri).pathname;
  } catch {
    // Not absolute. Strip any query/fragment ourselves and keep the path.
    const cut = uri.split(/[?#]/, 1)[0] ?? '';
    return cut;
  }
}

/**
 * `/meridian/member/100482` -> `/meridian/member/:id`
 *
 * Note we intentionally return the PATH only and drop query/fragment: the
 * contract field is called `canonicalPath`, and legacy apps put session tokens
 * in the query string, which we must never persist into evidence.
 */
export function canonicalizePath(uri: string): string {
  const path = pathOf(uri);
  if (!path) return '/';
  const canon = path
    .split('/')
    .map((seg) => (isVolatileSegment(seg) ? ':id' : seg))
    .join('/');
  return canon || '/';
}

/**
 * Scheme + host of a URI, or '' if it cannot be parsed.
 * Falls back to protocol//host for non-special schemes (app://, file://),
 * where WHATWG URL reports origin as the literal string "null".
 */
export function originOf(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.origin && u.origin !== 'null') return u.origin;
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** Convert a single pattern segment containing `*` into an anchored regex. */
function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === '*') return true;
  if (pattern === segment) return true;
  if (!pattern.includes('*')) return false;
  // Escape everything, then re-open the wildcards. `*` inside a segment matches
  // any run of characters but never crosses a `/` (we already split on `/`).
  const rx = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*') +
      '$',
  );
  return rx.test(segment);
}

function matchSegments(path: string[], pattern: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const head = pattern[0] as string;
  if (head === '**') {
    // `**` matches zero or more segments; try every split point. Bounded by
    // path length, so no catastrophic backtracking is possible.
    for (let i = 0; i <= path.length; i++) {
      if (matchSegments(path.slice(i), pattern.slice(1))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  if (!segmentMatches(head, path[0] as string)) return false;
  return matchSegments(path.slice(1), pattern.slice(1));
}

/**
 * Glob match over path segments.
 *   `*`  matches exactly one segment
 *   `**` matches any number of segments (including zero)
 *
 * Both sides are normalized to segment arrays first, so leading/trailing
 * slashes never change the answer — a policy rule must not silently stop
 * matching because someone wrote `/admin/` instead of `/admin`.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const p = pathOf(path)
    .split('/')
    .filter((s) => s.length > 0);
  const q = pattern
    .split('/')
    .filter((s) => s.length > 0);
  return matchSegments(p, q);
}
