/**
 * Typed output extraction.
 *
 * The point of a typed capability contract is that a calling agent receives
 * `{ availableBalance: 4812.55 }`, not `{ availableBalance: "$4,812.55" }`.
 * If the caller has to parse the string, then the string format is the real
 * interface, every caller reimplements the same currency parser, and the day
 * the app starts rendering `4,812.55 USD` the failure appears in N callers as a
 * wrong number rather than here as a clean `extraction_failed`. Parsing belongs
 * on this side of the boundary, exactly once, with declared types.
 *
 * Three source kinds, in descending order of how much semantic structure the
 * app gives us:
 *
 *   element      - a real control with an accessible name/value.
 *   labeledValue - the value sitting beside a label. THE primitive for legacy
 *                  enterprise UIs, where data is `<td>Balance:</td>
 *                  <td>$4,812.55</td>` with no ids, no classes and no semantics.
 *   textPattern  - a regex over flattened page text. Last resort, and the most
 *                  brittle, so we validate the author's regex aggressively.
 *
 * Raw strings are preserved alongside parsed values. When a number comes back
 * wrong, the first question is always "what did the page actually say?", and
 * evidence that only records the parsed value cannot answer it.
 */

import type { Extraction, ValueType } from '../artifact/schema.js';
import type { Observation, TargetDescriptor, UiNode } from '../surface/types.js';
import { resolveDescriptor } from '../surface/web/resolve.js';

export interface ExtractionOutcome {
  /** Parsed, typed values keyed by extraction name. Missing optionals are absent. */
  values: Record<string, unknown>;
  /** The raw page string each value was parsed from. Evidence, not contract. */
  raw: Record<string, string>;
  /** One line per failed REQUIRED extraction. Optional misses never appear here. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Normalize a label: collapse whitespace, drop a trailing colon, case-fold. */
function normLabel(s: string): string {
  return norm(s).replace(/[:：]+$/, '').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Roles whose *value* carries the data, versus roles whose *name* does. */
const FORM_CONTROL_ROLES = new Set(['textbox', 'checkbox', 'radio', 'combobox']);

/** Roles that can plausibly hold a displayed value in a label/value layout. */
const VALUE_BEARING_ROLES = new Set(['cell', 'text', 'generic', 'textbox', 'combobox', 'checkbox', 'link', 'heading']);

/** Roles that can plausibly *be* a label in a label/value layout. */
const LABEL_BEARING_ROLES = ['cell', 'text', 'generic'];

function readNode(n: UiNode): string {
  if (FORM_CONTROL_ROLES.has(n.role)) {
    if (n.value !== undefined && n.value !== '') return n.value;
    if (n.checked !== undefined) return n.checked ? 'true' : 'false';
    return '';
  }
  return n.name;
}

function sameFrame(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// Locating the raw string
// ---------------------------------------------------------------------------

type Located = { ok: true; raw: string; how: string } | { ok: false; reason: string };

/** Restrict the label search to a region, when the author scoped it. */
function withinMatches(n: UiNode, within: TargetDescriptor | undefined): boolean {
  if (within === undefined) return true;
  const wants = [within.section, within.name].filter((s): s is string => s !== undefined && s !== '').map(norm);
  if (wants.length === 0) return true;
  const section = norm(n.section ?? '');
  if (section === '') return false;
  return wants.some((w) => section === w || section.includes(w));
}

/**
 * The legacy label/value primitive.
 *
 * Strategy, in order:
 *   1. Find the label cell by normalized name (exact first, then prefix — a
 *      prefix match would otherwise let "Balance" claim "Balance Due", so exact
 *      wins outright when it exists).
 *   2. Walk FORWARD in `obs.nodes`, which the surface guarantees is in document
 *      order, and take the first value-bearing node in the same frame and the
 *      same section. That is the "next cell in the same row" — we stop at a
 *      frame or section boundary because crossing one means we have left the
 *      row and are about to report an unrelated panel's number as the answer,
 *      which is the single worst failure mode an extractor can have.
 *   3. Fall back to scanning the flattened text for `Label: value` on one line.
 *      Some legacy pages render label/value pairs as plain text runs with no
 *      cell structure at all, and the text fallback is the difference between
 *      a working capability and a re-record.
 */
/**
 * Read a value out of a data grid by (column header, row anchor).
 *
 * Perception records each cell's table id, row index and column index, so this
 * is an exact lookup rather than an inference: find the header cell carrying
 * the column name, find the row containing the anchor text, and read the cell
 * where they intersect.
 *
 * Returns null when there is no such grid, so the caller can fall back to
 * label/value adjacency. Returns a failed Located (not null) when the grid
 * exists but the row does not — "no Savings row on this screen" is a real
 * answer and must not be papered over by the adjacency path.
 */
function locateByColumn(
  target: string,
  row: string,
  within: TargetDescriptor | undefined,
  obs: Observation,
): Located | null {
  const cells = obs.nodes.filter((n) => n.role === 'cell' && n.hint?.table !== undefined && withinMatches(n, within));
  if (cells.length === 0) return null;

  // A label like "Status" legitimately appears in several places on one screen
  // — as a row label in a Member Information panel AND as a column header in
  // an Accounts grid. So we try EVERY cell bearing that text and keep the
  // first whose table also contains the requested row. Committing to the first
  // textual match would resolve "the Status of the Savings row" against a
  // completely unrelated panel, which is the class of silent wrong answer this
  // primitive exists to eliminate.
  const headers = cells.filter((n) => normLabel(n.name) === target && n.hint?.table !== undefined && n.hint?.col !== undefined);
  if (headers.length === 0) return null;

  const wantedRow = normLabel(row);
  let sawGrid = false;

  for (const header of headers) {
    const table = header.hint?.table;
    const col = header.hint?.col;
    if (table === undefined || col === undefined) continue;

    const inTable = cells.filter((n) => n.hint?.table === table);
    const anchor =
      inTable.find((n) => normLabel(n.name) === wantedRow) ?? inTable.find((n) => normLabel(n.name).startsWith(wantedRow));
    if (anchor === undefined) continue; // wrong table; try the next candidate
    sawGrid = true;

    const hit = inTable.find((n) => n.hint?.row === anchor.hint?.row && n.hint?.col === col);
    if (hit === undefined) continue;
    const v = readNode(hit);
    if (v.trim() === '') continue;
    return {
      ok: true,
      raw: v,
      how: `labeledValue column "${target}" x row "${row}" (table ${table} r${anchor.hint?.row} c${col})`,
    };
  }

  // A grid carrying both the column and the row existed but the intersection
  // was empty — a real miss worth reporting. If no such grid existed at all,
  // return null so the caller can fall back to label/value adjacency.
  return sawGrid ? { ok: false, reason: `row "${row}" has no value under column "${target}"` } : null;
}

function locateLabeledValue(
  label: string,
  within: TargetDescriptor | undefined,
  obs: Observation,
  row?: string,
): Located {
  const target = normLabel(label);
  if (target === '') return { ok: false, reason: 'labeledValue.label is empty' };

  // Column mode. `label` is a column header and `row` names the row.
  if (row !== undefined && row.trim() !== '') {
    const byColumn = locateByColumn(target, row, within, obs);
    // Fall through to adjacency only if the grid lookup found no such grid at
    // all; a grid that exists but lacks the row is a real miss and must be
    // reported as one rather than silently answered by a neighbouring cell.
    if (byColumn !== null) return byColumn;
  }

  const candidates: Array<{ index: number; node: UiNode; exact: boolean }> = [];
  for (let i = 0; i < obs.nodes.length; i++) {
    const n = obs.nodes[i];
    if (n === undefined) continue;
    if (!LABEL_BEARING_ROLES.includes(n.role)) continue;
    if (!withinMatches(n, within)) continue;
    const nl = normLabel(n.name);
    if (nl === '') continue;
    if (nl === target) candidates.push({ index: i, node: n, exact: true });
    else if (nl.startsWith(target)) candidates.push({ index: i, node: n, exact: false });
  }
  // Exact label matches always outrank prefix matches, and 'cell' outranks
  // looser roles, so a real table beats an incidental paragraph.
  candidates.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    const ar = a.node.role === 'cell' ? 0 : 1;
    const br = b.node.role === 'cell' ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.index - b.index;
  });

  for (const cand of candidates) {
    const labelNode = cand.node;
    for (let j = cand.index + 1; j < obs.nodes.length; j++) {
      const n = obs.nodes[j];
      if (n === undefined) continue;
      if (!sameFrame(n.framePath, labelNode.framePath)) break;
      if ((n.section ?? '') !== (labelNode.section ?? '')) break;
      if (!VALUE_BEARING_ROLES.has(n.role)) continue;
      const v = readNode(n);
      if (v.trim() === '') continue; // spacer cell
      if (normLabel(v) === target) continue; // a repeated label (header row)
      return {
        ok: true,
        raw: v,
        how: `labeledValue "${label}" -> next ${n.role} after ${labelNode.role} #${labelNode.ordinal}`,
      };
    }
  }

  // Text fallback: `Label: value` / `Label   value` on one logical line.
  const lineRe = new RegExp(`^\\s*${escapeRegExp(label.replace(/[:：]\s*$/, ''))}\\s*[:：\\-–—]?\\s+(.+?)\\s*$`, 'i');
  for (const line of obs.text.split(/\r?\n/)) {
    const m = lineRe.exec(line);
    const captured = m?.[1];
    if (captured !== undefined && captured.trim() !== '') {
      return { ok: true, raw: captured, how: `labeledValue "${label}" -> text line fallback` };
    }
  }

  return {
    ok: false,
    reason: `no value found next to label "${label}"${within !== undefined ? ` within "${within.section ?? within.name}"` : ''}`,
  };
}

/**
 * Count capture groups without executing the pattern against real input, using
 * the standard `re|` trick: an always-matching alternation returns a match
 * array whose length is 1 + the group count.
 */
function countCaptureGroups(pattern: string): number {
  const probe = new RegExp(`${pattern}|`);
  const m = probe.exec('');
  return m === null ? 0 : m.length - 1;
}

function locateTextPattern(pattern: string, obs: Observation): Located {
  let groups: number;
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
    groups = countCaptureGroups(pattern);
  } catch (err) {
    return { ok: false, reason: `invalid textPattern /${pattern}/: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Be explicit about group count. Zero groups means the author wrote a
  // *detector* where an *extractor* was needed, and would silently yield the
  // whole match; more than one means the intended value is ambiguous. Both are
  // authoring bugs that are trivially fixable once named, and impossible to
  // diagnose from a wrong output value.
  if (groups !== 1) {
    return {
      ok: false,
      reason: `textPattern /${pattern}/ must have exactly one capture group, found ${groups}`,
    };
  }
  const m = re.exec(obs.text);
  const captured = m?.[1];
  if (captured === undefined) return { ok: false, reason: `textPattern /${pattern}/ did not match the page text` };
  return { ok: true, raw: captured, how: `textPattern /${pattern}/` };
}

function locateElement(descriptor: TargetDescriptor, obs: Observation): Located {
  const res = resolveDescriptor(descriptor, obs.nodes);
  if (!res.ok) {
    if (res.reason === 'ambiguous') {
      // We refuse to guess. Reading the wrong one of six identical cells is a
      // silent data-integrity bug; failing here is a loud, fixable one.
      return {
        ok: false,
        reason: `element ${descriptor.role} "${descriptor.name}" is ambiguous (${res.candidates} candidates via ${res.tier}: ${res.sample.join(' | ')})`,
      };
    }
    return { ok: false, reason: `element ${descriptor.role} "${descriptor.name}" not found (tried ${res.tried.join(' -> ')})` };
  }
  return { ok: true, raw: readNode(res.node), how: `element via ${res.tier}` };
}

function locate(spec: Extraction, obs: Observation): Located {
  if ('element' in spec.from) return locateElement(spec.from.element, obs);
  if ('textPattern' in spec.from) return locateTextPattern(spec.from.textPattern, obs);
  return locateLabeledValue(
    spec.from.labeledValue.label,
    spec.from.labeledValue.within,
    obs,
    spec.from.labeledValue.row,
  );
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Parsed = { ok: true; value: unknown } | { ok: false; reason: string };

const TRUEY = new Set(['true', 'yes', 'y', '1', 'on', 'checked', 'enabled']);
const FALSEY = new Set(['false', 'no', 'n', '0', 'off', 'unchecked', 'disabled']);

/**
 * Money parsing.
 *
 * Handles the forms a back-office UI actually emits:
 *   `$4,812.55`    -> 4812.55
 *   `4 812,55 EUR` -> not attempted; see the limitation note below
 *   `($12.34)`     -> -12.34   (accounting-style negative; ubiquitous in cores)
 *   `-$12.34`      -> -12.34
 *   `USD 1,200`    -> 1200
 *
 * Limitation, stated honestly: this assumes `.` is the decimal separator and
 * `,` is a thousands separator, i.e. en-US/en-GB conventions. A European
 * `1.234,56` would parse as 1.23456. Locale-aware money parsing needs a locale
 * on the capability, which the schema does not currently carry; guessing from
 * the string shape would be worse than being explicit about the assumption.
 */
function parseMoney(rawInput: string): Parsed {
  const s = rawInput.trim();
  if (s === '') return { ok: false, reason: 'empty money value' };
  const parenNegative = /^\(.*\)$/.test(s);
  const signNegative = /^[-−]/.test(s.replace(/^[^\d(\-−]*/, '')) || /^[-−]/.test(s);
  const digits = s.replace(/[^0-9.]/g, '');
  if (digits === '' || !/\d/.test(digits)) return { ok: false, reason: `cannot parse money from "${rawInput}"` };
  const n = Number(digits);
  if (!Number.isFinite(n)) return { ok: false, reason: `cannot parse money from "${rawInput}"` };
  return { ok: true, value: parenNegative || signNegative ? -n : n };
}

function parseNumber(rawInput: string): Parsed {
  const s = rawInput.trim();
  const parenNegative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[,\s%]/g, '').replace(/[()]/g, '').replace(/[−]/g, '-');
  if (cleaned === '' || !/\d/.test(cleaned)) return { ok: false, reason: `cannot parse number from "${rawInput}"` };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { ok: false, reason: `cannot parse number from "${rawInput}"` };
  return { ok: true, value: parenNegative ? -Math.abs(n) : n };
}

function parseBoolean(rawInput: string): Parsed {
  const s = norm(rawInput);
  if (TRUEY.has(s)) return { ok: true, value: true };
  if (FALSEY.has(s)) return { ok: true, value: false };
  return { ok: false, reason: `cannot parse boolean from "${rawInput}" (expected yes/no/true/false/y/n)` };
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Dates are normalized to ISO `YYYY-MM-DD` strings, not Date objects.
 *
 * A Date carries a time and a timezone this page never stated. Materializing
 * midnight-in-the-runner's-timezone for "posted 03/14/2024" invents precision
 * and can shift the date by a day when the result crosses a boundary. A
 * calendar date is a calendar date.
 */
function parseDate(rawInput: string): Parsed {
  const s = rawInput.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso !== null) {
    return { ok: true, value: `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}` };
  }
  const us = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
  if (us !== null) {
    return { ok: true, value: `${us[3]}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}` };
  }
  const named = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  const monthKey = named?.[1]?.slice(0, 3).toLowerCase();
  if (named !== undefined && named !== null && monthKey !== undefined && MONTHS[monthKey] !== undefined) {
    return { ok: true, value: `${named[3]}-${MONTHS[monthKey]}-${String(named[2]).padStart(2, '0')}` };
  }
  return { ok: false, reason: `cannot parse date from "${rawInput}" (expected YYYY-MM-DD or MM/DD/YYYY)` };
}

export function parseValue(raw: string, type: ValueType): Parsed {
  switch (type) {
    case 'money':
      return parseMoney(raw);
    case 'number':
      return parseNumber(raw);
    case 'boolean':
      return parseBoolean(raw);
    case 'date':
      return parseDate(raw);
    case 'enum':
    case 'string':
      return { ok: true, value: raw.replace(/\s+/g, ' ').trim() };
  }
}

/** Post-parse assertions declared on the extraction. */
function checkExpectation(name: string, value: unknown, expect: Extraction['expect']): string | null {
  if (expect === 'any') return null;
  if (expect === 'non-empty') {
    if (value === undefined || value === null) return `output '${name}' is empty`;
    if (typeof value === 'string' && value.trim() === '') return `output '${name}' is empty`;
    return null;
  }
  // non-negative
  if (typeof value !== 'number') {
    return `output '${name}' declares expect:non-negative but parsed to a ${typeof value}`;
  }
  if (value < 0) {
    // Worth failing loudly: a negative where the contract promised non-negative
    // usually means we read the wrong cell (a debit column, a delta) rather
    // than that the account is overdrawn.
    return `output '${name}' is negative (${value}) but the contract declares non-negative`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// extractAll
// ---------------------------------------------------------------------------

/**
 * Run every extraction against one observation.
 *
 * Extractions do NOT short-circuit: we attempt all of them and report all
 * failures. If three outputs are missing because the page rendered a different
 * layout, an operator should learn that in one run, not in three.
 */
export function extractAll(specs: Extraction[], obs: Observation): ExtractionOutcome {
  const values: Record<string, unknown> = {};
  const raw: Record<string, string> = {};
  const errors: string[] = [];

  for (const spec of specs) {
    const found = locate(spec, obs);
    if (!found.ok) {
      // An optional output that is simply not on the page is not an error —
      // it is the declared "may be absent" case, and it yields undefined.
      if (spec.required) errors.push(`output '${spec.name}': ${found.reason}`);
      continue;
    }
    raw[spec.name] = found.raw;

    const parsed = parseValue(found.raw, spec.type);
    if (!parsed.ok) {
      if (spec.required) errors.push(`output '${spec.name}': ${parsed.reason}`);
      continue;
    }

    const expectationError = checkExpectation(spec.name, parsed.value, spec.expect);
    if (expectationError !== null) {
      if (spec.required) errors.push(`output '${spec.name}': ${expectationError}`);
      continue;
    }

    values[spec.name] = parsed.value;
  }

  return { values, raw, errors };
}
