/**
 * Redaction.
 *
 * Two complementary mechanisms, because neither alone is sufficient:
 *
 *   1. PATTERN scrubbing (`text`, `object`) — a safety net over free text we did
 *      not author: page text, model transcripts, error messages from the app.
 *      Regexes over untrusted text are best-effort by nature, so they are the
 *      backstop, never the primary control.
 *   2. CLASSIFICATION (`value`) — the primary control. The capability contract
 *      declares each parameter's and each output's `Sensitivity`, and we redact
 *      by that declaration rather than by guessing at each log site.
 *
 * The deliberate non-goal: money amounts are NOT pattern-scrubbed. Balances are
 * the legitimate return value of the capability; redacting them would break the
 * product. Money is protected by classification (`financial`) instead, which
 * keeps it out of logs while still returning it to the caller.
 */

import type { PolicyConfig, Redactor } from './types.js';
import type { Sensitivity } from '../artifact/schema.js';

/** Keys whose *name* is enough to condemn the value, whatever it looks like. */
const SENSITIVE_KEY = /pass|secret|token|apikey|api_key|authorization|cookie|ssn/i;

/**
 * A currency-ish string. Used only by `shape()` to describe a value without
 * revealing it — never to redact one.
 */
const MONEY = /^-?(?:[$€£]\s?)?\d{1,3}(?:,\d{3})*(?:\.\d{2})$|^-?[$€£]\s?\d+(?:\.\d{1,2})?$/;

const ALL_DIGITS = /^\d+$/;

export class DefaultRedactor implements Redactor {
  /**
   * Compiled in the order the policy file lists them. Order is load-bearing:
   * a specific pattern (a 16-digit card) must claim its match before a broad
   * one (any long digit run) relabels it.
   */
  private readonly patterns: ReadonlyArray<{ name: string; re: RegExp }>;

  /**
   * Literal secret values registered for this run.
   *
   * Pattern matching cannot recognise that `demo.operator` is a credential —
   * it looks like an ordinary word. But we KNOW it is one, because a capability
   * declared it as a secret-store parameter and we just resolved it. Scrubbing
   * by value closes the gap that patterns structurally cannot: a credential
   * echoed back by the application into its own page text, which then lands in
   * a screenshot caption or a snapshot committed as evidence.
   */
  private readonly knownSecrets: string[] = [];

  /** Register a resolved secret so it is scrubbed everywhere, by value. */
  addSecretValue(value: string | undefined): void {
    // Very short values would match everywhere and turn the log to noise.
    if (value && value.length >= 4 && !this.knownSecrets.includes(value)) this.knownSecrets.push(value);
  }

  constructor(config: Pick<PolicyConfig, 'redaction'>) {
    this.patterns = Object.entries(config.redaction.patterns).map(([name, source]) => ({
      name,
      // `(?i)` is a portable inline flag the JS engine does not support; the
      // policy file may use it, and we compile everything case-insensitively
      // regardless — none of these patterns get safer by being case-sensitive.
      re: new RegExp(source.replace(/^\(\?i\)/, ''), 'gi'),
    }));
  }

  text(input: string): string {
    if (input === '') return input;
    let out = input;
    for (const { name, re } of this.patterns) {
      // String.replace resets lastIndex on a /g/ regex, so reusing the compiled
      // instances across calls is safe.
      out = out.replace(re, `[REDACTED:${name}]`);
    }
    // Known secret values last, so a credential that also matched a pattern is
    // not double-labelled, and one that matched nothing still gets scrubbed.
    for (const secret of this.knownSecrets) {
      if (out.includes(secret)) out = out.split(secret).join('[SECRET]');
    }
    return out;
  }

  value(v: unknown, sensitivity: Sensitivity): unknown {
    switch (sensitivity) {
      case 'public':
        return v;
      case 'identifier':
        return tokenizeIdentifier(v);
      case 'financial':
      case 'pii':
        return '[REDACTED]';
      case 'secret':
        return '[SECRET]';
      default:
        // Unknown classification ⇒ treat as the most sensitive thing it could
        // be. Fail closed.
        return '[REDACTED]';
    }
  }

  shape(v: unknown): string {
    if (v === null || v === undefined) return 'empty';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return 'empty';
      return Number.isInteger(v) ? `${String(Math.abs(v)).length} digits` : 'money';
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === '') return 'empty';
      if (MONEY.test(s)) return 'money';
      if (ALL_DIGITS.test(s)) return `${s.length} digits`;
      return `${v.length} chars`;
    }
    if (isBuffer(v)) return `${v.length} bytes`;
    if (Array.isArray(v)) return `${v.length} items`;
    if (v instanceof Date) return 'date';
    if (typeof v === 'object') return `${Object.keys(v as Record<string, unknown>).length} keys`;
    return 'unknown';
  }

  object<T>(o: T): T {
    // The cast is over a structure-preserving deep clone: every branch returns a
    // value of the same shape as its input (strings stay strings, arrays stay
    // arrays), so the runtime value still satisfies T. TypeScript cannot express
    // "same shape, scrubbed leaves", hence the assertion rather than `any`.
    return this.deepScrub(o, new WeakSet<object>()) as T;
  }

  private deepScrub(v: unknown, seen: WeakSet<object>): unknown {
    if (v === null || v === undefined) return v;

    if (typeof v === 'string') return this.text(v);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function') return '[Function]';
    if (typeof v === 'symbol') return v.toString();

    if (isBuffer(v)) {
      // Never serialize raw bytes into an evidence log: a screenshot buffer in a
      // JSONL line is both enormous and unreviewable.
      return `<buffer ${v.length} bytes>`;
    }

    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) {
      return { name: v.name, message: this.text(v.message) };
    }

    if (typeof v === 'object') {
      const obj = v as object;
      // Cycles are not hypothetical here: observations and DOM-ish structures
      // routinely hold parent back-references, and one JSON.stringify throw
      // inside the logger would take down the run it was supposed to document.
      if (seen.has(obj)) return '[Circular]';
      seen.add(obj);

      try {
        if (Array.isArray(v)) {
          return v.map((item) => this.deepScrub(item, seen));
        }
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          out[k] = SENSITIVE_KEY.test(k) ? '[SECRET]' : this.deepScrub(val, seen);
        }
        return out;
      } finally {
        // Released so a value that legitimately appears twice in a tree (a
        // shared constant) is scrubbed both times rather than reported circular.
        seen.delete(obj);
      }
    }

    return String(v);
  }
}

/**
 * Display tokenization for identifiers: `100482` -> `id:10…82`.
 *
 * This is a DISPLAY TOKENIZATION, NOT A SECURITY CONTROL. It is deterministic
 * and it leaks four characters, which is the point — an operator reading the log
 * needs to be able to tell two member ids apart while triaging. Anything that
 * must actually be unrecoverable is classified `pii`/`financial`/`secret`, not
 * `identifier`.
 */
function tokenizeIdentifier(v: unknown): string {
  if (v === null || v === undefined) return 'id:***';
  const s = typeof v === 'string' ? v : String(v);
  if (s.length < 6) return 'id:***';
  return `id:${s.slice(0, 2)}…${s.slice(-2)}`;
}

function isBuffer(v: unknown): v is Buffer {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(v);
}
