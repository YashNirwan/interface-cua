/**
 * Loading and validating the policy.
 *
 * The policy is a JSON file, not a TypeScript module, for one reason: the people
 * who need to sign off on "what is this automation allowed to touch" are not the
 * people who read the code. A JSON allowlist diffs cleanly in a pull request and
 * can be swapped per environment without a rebuild.
 *
 * Everything here is fail-closed. A malformed policy throws at load time rather
 * than degrading to a permissive default — a guardrail that silently falls back
 * to "allow" is worse than no guardrail, because it looks like one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { PolicyConfig } from './types.js';

/**
 * Mirrors `ActionType` from surface/types.ts. It is spelled out rather than
 * derived so that adding a verb to the surface vocabulary does NOT silently
 * widen what policy accepts — a new verb has to be granted here on purpose.
 */
const zActionType = z.enum(['navigate', 'click', 'type', 'select', 'press', 'read', 'wait']);

export const zPolicyConfig = z.object({
  allowedOrigins: z.array(z.string().min(1)).min(1, 'allowedOrigins must not be empty'),
  allowedPaths: z.array(z.string().min(1)).min(1, 'allowedPaths must not be empty'),
  allowedActions: z.array(zActionType).min(1, 'allowedActions must not be empty'),
  risky: z.object({
    namePatterns: z.array(z.string().min(1)),
    duringDiscovery: z.enum(['block', 'escalate', 'allow-and-flag']),
    duringReplayUnapproved: z.enum(['block', 'escalate']),
  }),
  limits: z.object({
    maxSteps: z.number().int().positive(),
    maxDurationMs: z.number().int().positive(),
    maxLlmCalls: z.number().int().positive(),
  }),
  redaction: z.object({
    patterns: z.record(z.string().min(1)),
  }),
});

/** Where the repo-default policy lives: `<repo root>/policy.json`. */
export const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../../policy.json', import.meta.url));

/**
 * Normalize an origin string to scheme+host+port.
 *
 * We compare origins *structurally* rather than by string equality so that
 * `http://127.0.0.1:8099/` and `http://127.0.0.1:8099` are the same thing, and
 * so that a policy entry can never accidentally allow a whole prefix
 * (`http://127.0.0.1:8099` must not match `http://127.0.0.1:80990`).
 */
export function normalizeOrigin(raw: string): string {
  const url = new URL(raw); // throws on garbage; callers turn that into a clear error
  return url.origin;
}

function envOrigins(): { mode: 'replace' | 'append'; origins: string[] } | undefined {
  const raw = process.env.CUA_ALLOWED_ORIGINS;
  if (raw === undefined || raw.trim() === '') return undefined;
  // A leading '+' means "add to the baked-in list" (a developer pointing at a
  // second local host); anything else means "this is the list" (an operator
  // pinning a run to one staging host and nothing else). Replace is the default
  // because the safer reading of an explicit override is the narrower one.
  const append = raw.trimStart().startsWith('+');
  const body = append ? raw.trimStart().slice(1) : raw;
  const origins = body
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { mode: append ? 'append' : 'replace', origins };
}

export class PolicyConfigError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`invalid policy config at ${path}: ${detail}`);
    this.name = 'PolicyConfigError';
  }
}

/**
 * Load and validate the policy.
 *
 * `path` defaults to `<repo root>/policy.json`, overridable with CUA_POLICY_FILE
 * so a deployment can mount a tenant-specific allowlist without code changes.
 */
export function loadPolicy(path: string = process.env.CUA_POLICY_FILE ?? DEFAULT_POLICY_PATH): PolicyConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new PolicyConfigError(path, `cannot read file (${(err as Error).message})`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new PolicyConfigError(path, `not valid JSON (${(err as Error).message})`);
  }

  const parsed = zPolicyConfig.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new PolicyConfigError(path, detail);
  }

  // Not `any`: the zod schema above is written to mirror PolicyConfig exactly,
  // so this is a narrowing assertion between two structurally identical shapes,
  // not an escape hatch.
  const config = parsed.data as PolicyConfig;

  // Every redaction pattern must compile NOW. Discovering a bad regex at the
  // moment we try to scrub a log line means we would have already decided what
  // to write; failing at load time is the only safe point.
  for (const [name, pattern] of Object.entries(config.redaction.patterns)) {
    try {
      // Strip a leading inline `(?i)` flag: the policy file is written in a
      // portable regex dialect, but JS RegExp has no inline flags. The redactor
      // compiles every pattern case-insensitively anyway (see redact.ts).
      new RegExp(pattern.replace(/^\(\?i\)/, ''), 'gi');
    } catch (err) {
      throw new PolicyConfigError(path, `redaction pattern '${name}' is not a valid regex (${(err as Error).message})`);
    }
  }

  // Origins are normalized (and thereby validated) at load time so the gate can
  // do a cheap exact comparison on every single action.
  const fileOrigins = config.allowedOrigins.map((o) => {
    try {
      return normalizeOrigin(o);
    } catch {
      throw new PolicyConfigError(path, `allowedOrigins entry '${o}' is not a valid origin`);
    }
  });

  const override = envOrigins();
  let origins = fileOrigins;
  if (override) {
    const extra = override.origins.map((o) => {
      try {
        return normalizeOrigin(o);
      } catch {
        throw new PolicyConfigError(path, `CUA_ALLOWED_ORIGINS entry '${o}' is not a valid origin`);
      }
    });
    origins = override.mode === 'append' ? [...fileOrigins, ...extra] : extra;
  }

  config.allowedOrigins = [...new Set(origins)];
  if (config.allowedOrigins.length === 0) {
    throw new PolicyConfigError(path, 'allowedOrigins resolved to an empty list after env overrides');
  }

  return config;
}
