/**
 * Discovery run -> capability artifact.
 *
 * This is where a transcript becomes a contract, and the interesting work is
 * all in what we refuse to carry across:
 *
 *  - No transcript. The artifact stores a digest of the model's reasoning, and
 *    the reasoning itself stays in evidence. A capability that embedded its
 *    transcript would be unreviewable and would quietly become a place where
 *    page contents accumulate.
 *  - No values. Steps carry `{{memberId}}`, never `100482`, because that is
 *    how the model typed them (see discover.ts). Any literal that survives is
 *    scanned, and one that looks sensitive is refused rather than stored.
 *  - No selectors. Targets are descriptors produced from the node that was
 *    actually acted on.
 *
 * Checkpoints are synthesized mechanically from observed state change, not
 * asked of the model. If clicking "Search" moved us to a new URL and put the
 * phrase "Member 100482 — Profile" on screen that was not there before, then
 * those two facts ARE the checkpoint — parameterized into
 * "Member {{memberId}} — Profile". Deriving it from what happened rather than
 * from what the model says happened is what makes the assertion trustworthy.
 */

import type { DiscoveryParam, DiscoveryResult, RecordedOutput, RecordedStep } from '../agent/discover.js';
import type { Redactor } from '../policy/types.js';
import {
  SCHEMA_VERSION,
  type Capability,
  type Condition,
  type Extraction,
  type ParamSpec,
  type Recovery,
  type Step,
  parseCapability,
} from './schema.js';
import { canonicalizePath } from '../surface/canonicalize.js';

export interface CompileOptions {
  id: string;
  version?: string;
  app: { vendor: string; product: string; versionRange?: string; surface: 'web' | 'legacy-web' | 'desktop' };
  summary?: string;
  description?: string;
  redactor: Redactor;
  /** Origins the capability is permitted to touch. Defaults to the entry origin. */
  allowedOrigins?: string[];
  /** Surfaced to the operator when the compiler had to correct the model. */
  onWarning?: (message: string) => void;
}

export class CompileError extends Error {}

export function compile(run: DiscoveryResult, opts: CompileOptions): Capability {
  if (run.status !== 'success') {
    throw new CompileError(`refusing to compile a capability from a run that ended '${run.status}': ${run.detail ?? ''}`);
  }
  if (!run.successCheckpointText) {
    throw new CompileError('run produced no success checkpoint; a capability that cannot assert success is not replayable');
  }

  const inputs = buildInputs(run.params);
  const steps = buildSteps(run, opts.redactor);
  const outputs = buildOutputs(run.outputs, run.params);
  const success = buildSuccess(run, opts.redactor);
  if (success.warning) opts.onWarning?.(success.warning);
  const recoveries = buildRecoveries(run);

  const origin = safeOrigin(run.entryUri);
  const cap: Capability = {
    schemaVersion: SCHEMA_VERSION,
    id: opts.id,
    version: opts.version ?? '1.0.0',
    // Always draft. A capability becomes approved when a human reviews it,
    // never because the run that produced it happened to go well — the whole
    // point of the approval gate is that it carries human accountability.
    status: 'draft',
    summary: opts.summary ?? run.summary ?? run.goal,
    description: opts.description ?? `${run.goal}\n\nDiscovered by ${run.provider}/${run.model} against ${origin}.`,
    app: {
      vendor: opts.app.vendor,
      product: opts.app.product,
      versionRange: opts.app.versionRange ?? '*',
      surface: opts.app.surface,
    },
    tenantId: null,
    entry: {
      uri: parameterize(run.entryUri, run.params),
      requiresSession: run.params.some((p) => p.sensitivity === 'secret'),
    },
    inputs,
    outputs,
    steps,
    success: success.condition,
    outcomes: [],
    recoveries,
    policy: {
      allowedOrigins: opts.allowedOrigins ?? (origin ? [origin] : []),
      maxSteps: Math.max(20, steps.length * 3),
      maxDurationMs: 120_000,
      containsRiskyActions: steps.some((s) => s.risk === 'risky'),
    },
    provenance: {
      recordedAt: new Date().toISOString(),
      recordedBy: { kind: 'llm-discovery', model: run.model, provider: run.provider },
      runId: run.runId,
      goal: run.goal,
      transcriptDigest: run.transcriptDigest,
    },
    stability: { runs: 0, successes: 0 },
  };

  // Parse rather than cast: if the compiler can produce something the schema
  // rejects, that is a bug we want to find here and not at 3am during a replay.
  return parseCapability(cap);
}

// ---------------------------------------------------------------------------

function buildInputs(params: DiscoveryParam[]): Record<string, ParamSpec> {
  const out: Record<string, ParamSpec> = {};
  for (const p of params) {
    const spec: ParamSpec = {
      type: p.type,
      description: p.description,
      required: true,
      sensitivity: p.sensitivity,
      source: p.secretKey ? 'secret-store' : 'caller',
    };
    if (p.secretKey) spec.secretKey = p.secretKey;
    // A pattern derived from the observed value is a cheap, honest contract:
    // the flow was proven to work for a 6-digit id, so that is what it
    // promises. A reviewer can widen it deliberately.
    if (!p.secretKey && /^\d+$/.test(p.value)) spec.pattern = `\\d{${p.value.length}}`;
    if ((p.sensitivity === 'public' || p.sensitivity === 'identifier') && !p.secretKey) spec.example = p.value;
    out[p.name] = spec;
  }
  return out;
}

function buildSteps(run: DiscoveryResult, redactor: Redactor): Step[] {
  const steps: Step[] = [];
  let prevUri = run.entryUri;

  run.steps.forEach((rec, i) => {
    const id = `s${i + 1}`;
    const action = { ...rec.action };

    if (action.type === 'type') {
      assertNoLiteralSecret(action.text, redactor, id);
    }

    const step: Step = {
      id,
      intent: rec.intent.trim() || describeAction(rec),
      action,
      risk: rec.risk,
      timeoutMs: 10_000,
      retries: 2,
      // A risky step defaults to escalating rather than failing: an
      // irreversible action that did not visibly take effect is precisely the
      // situation where a person should look before anything retries.
      onFailure: rec.risk === 'risky' ? 'escalate' : 'fail',
    };
    if (rec.recordedTier) step.recordedTier = rec.recordedTier;

    const checkpoint = synthesizeCheckpoint(rec, prevUri, run.params, redactor);
    if (checkpoint) step.checkpoint = checkpoint;

    steps.push(step);
    prevUri = rec.effect.uri;
  });

  return steps;
}

/**
 * Build an assertion from what actually changed.
 *
 * We deliberately emit NO checkpoint when nothing observable changed — typing
 * into a field usually changes no page state, and inventing an assertion there
 * would either be vacuous or flaky. The following click carries the real
 * assertion. An honest absence beats a decorative check.
 */
function synthesizeCheckpoint(rec: RecordedStep, prevUri: string, params: DiscoveryParam[], redactor: Redactor): Condition | undefined {
  // NOTE: usability of a phrase is judged AFTER parameterization and with the
  // secret check applied — see usablePhrase().
  const parts: Condition[] = [];

  const movedTo = canonicalizePath(rec.effect.uri);
  if (canonicalizePath(prevUri) !== movedTo) {
    parts.push({ uriMatches: escapeRegex(movedTo).replace(/:id/g, '[^/]+') });
  }

  const phrase = rec.effect.newText.map((t) => parameterize(t, params)).find((t) => usablePhrase(t, params, redactor));
  if (phrase) parts.push({ textPresent: phrase });

  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0]!;
  return { all: parts };
}

/**
 * A phrase is only usable as an assertion if it is stable and safe. We exclude
 * anything the redactor would scrub (an account number makes a terrible
 * checkpoint AND a compliance problem), anything containing a bare timestamp
 * or currency amount (those change between runs), and anything too short to be
 * distinctive.
 */
function isUsableCheckpointPhrase(t: string, redactor: Redactor): boolean {
  if (t.length < 10 || t.length > 90) return false;
  // Anything the redactor would scrub is both a poor assertion and a
  // compliance problem: an account number in a checkpoint is regulated data
  // persisted into a file we commit to git.
  if (redactor.text(t) !== t) return false;
  if (/\$\s?[\d,]+\.\d{2}/.test(t)) return false;
  if (/\b\d{1,2}:\d{2}\b|\b\d{4}-\d{2}-\d{2}\b/.test(t)) return false;
  // Markup leaking out of a frameset document's text extraction. Asserting on
  // `</td></tr></table>` would pass on literally any page of this app.
  if (/[<>]/.test(t)) return false;
  // Record-specific identifiers that are not one of our parameters. These
  // cannot generalize: the flow was recorded for one member, and an account
  // number derived from that member would never match another one.
  if (/\b[A-Z]{2,4}-\d{4,}-\d{2}\b/.test(t)) return false;
  if (/\b\d{6,}\b/.test(t)) return false;
  return true;
}

/**
 * Classify an output conservatively.
 *
 * The model picks a sensitivity when it records an output, and it reliably
 * picks 'public' because that is the least alarming option. In a bank that is
 * the wrong default: a balance or an account number is regulated data, and the
 * classification is what decides whether it can appear in a log line. We
 * upgrade based on the type and the name, and never downgrade what the model
 * chose — a caller can relax it in review, which is the safe direction for a
 * human to be making the decision in.
 */
function inferSensitivity(o: RecordedOutput): RecordedOutput['sensitivity'] {
  if (o.sensitivity !== 'public') return o.sensitivity;
  if (o.type === 'money') return 'financial';
  const hay = `${o.name} ${o.label ?? ''}`.toLowerCase();
  if (/account|balance|amount|routing|card|iban|ssn|tax/.test(hay)) return 'financial';
  if (/name|address|phone|email|dob|birth/.test(hay)) return 'pii';
  return 'public';
}

function buildOutputs(outs: RecordedOutput[], params: DiscoveryParam[]): Extraction[] {
  return outs.map((o) => {
    const base = {
      name: o.name,
      type: o.type,
      description: o.description,
      required: true,
      sensitivity: inferSensitivity(o),
      expect: o.type === 'money' ? ('any' as const) : ('non-empty' as const),
    };
    if (o.label) {
      // labeledValue is preferred over an element descriptor because the label
      // is the part of a legacy screen that does not move: the value cell has
      // no id, no class, and shifts position as rows are added above it.
      const labeledValue: { label: string; row?: string } = { label: parameterize(o.label, params) };
      if (o.row) labeledValue.row = parameterize(o.row, params);
      return { ...base, from: { labeledValue } } as Extraction;
    }
    return { ...base, from: { element: o.descriptor! } } as Extraction;
  });
}

/**
 * The final assertion.
 *
 * The model proposes the checkpoint phrase, and it is the one place where a
 * model's suggestion could otherwise end up verbatim in a production artifact.
 * So we validate it rather than trusting it: parameterize what we can, and if
 * what remains is record-specific ("Account SAV-0100482-01 — Detail") or would
 * be redacted, discard it and fall back to a phrase we OBSERVED becoming true
 * on the final screen. A success condition that only holds for the member it
 * was recorded against is worse than useless — it turns every other
 * invocation into a confusing failure.
 */
function buildSuccess(run: DiscoveryResult, redactor: Redactor): { condition: Condition; warning?: string } {
  const last = run.steps.at(-1);
  const proposed = parameterize(run.successCheckpointText!, run.params);
  const parts: Condition[] = [];
  let warning: string | undefined;

  if (usablePhrase(proposed, run.params, redactor)) {
    parts.push({ textPresent: proposed });
  } else {
    const fallback = (last?.effect.newText ?? [])
      .map((t) => parameterize(t, run.params))
      .find((t) => usablePhrase(t, run.params, redactor));
    warning =
      `model proposed an unusable success phrase (${JSON.stringify(proposed.slice(0, 40))}…); ` +
      (fallback ? `substituted the observed phrase ${JSON.stringify(fallback)}` : 'fell back to a location-only assertion');
    if (fallback) parts.push({ textPresent: fallback });
  }

  if (last) {
    const path = canonicalizePath(last.effect.uri);
    parts.push({ uriMatches: escapeRegex(path).replace(/:id/g, '[^/]+') });
  }
  if (parts.length === 0) throw new CompileError('no usable success condition could be derived from this run');
  return { condition: parts.length === 1 ? parts[0]! : { all: parts }, warning };
}

function hasParam(s: string): boolean {
  return /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(s);
}

/**
 * A phrase may be stored as an assertion only if it is both durable and safe.
 *
 * The secret check is the important half. `parameterize` deliberately refuses
 * to turn a secret's value into a `{{placeholder}}` — doing so would tell a
 * reader of the artifact exactly where the credential appears. But that means
 * a secret's value can still be sitting in observed page text (this app prints
 * `Operator: demo.operator` in its nav frame), and without this check that
 * text would be written into a committed capability as a checkpoint. So: if a
 * secret's value survives into a candidate phrase, the phrase is discarded
 * outright rather than parameterized.
 */
function usablePhrase(phrase: string, params: DiscoveryParam[], redactor: Redactor): boolean {
  if (containsSecretValue(phrase, params)) return false;
  return isUsableCheckpointPhrase(phrase, redactor) || hasParam(phrase);
}

function containsSecretValue(text: string, params: DiscoveryParam[]): boolean {
  return params.some((p) => p.sensitivity === 'secret' && p.value.length >= 4 && text.includes(p.value));
}

/**
 * Interstitials the agent actually had to clear during discovery become
 * declared recoveries. We only emit ones we OBSERVED — a speculative recovery
 * for a dialog nobody has seen is an untested branch in a production path.
 */
function buildRecoveries(run: DiscoveryResult): Recovery[] {
  const seen = new Set<string>();
  const out: Recovery[] = [];
  for (const it of run.observedInterruptions) {
    if (seen.has(it.text)) continue;
    seen.add(it.text);
    out.push({
      name: slug(it.text).slice(0, 40) || 'interstitial',
      description: `Clear the interstitial observed during discovery: "${it.text}"`,
      detect: { textPresent: it.text },
      do: [it.clearedBy],
      maxPerRun: 2,
      retryStep: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

function assertNoLiteralSecret(text: string, redactor: Redactor, stepId: string): void {
  if (/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(text)) return; // fully parameterized
  if (redactor.text(text) !== text) {
    throw new CompileError(
      `step ${stepId} would persist a literal that matches a sensitive pattern. ` +
        `Declare it as an input parameter (or a secret-store parameter) instead of typing it directly.`,
    );
  }
}

function parameterize(s: string, params: DiscoveryParam[]): string {
  let out = s;
  for (const p of params) {
    if (p.sensitivity === 'secret' || !p.value) continue;
    if (out.includes(p.value)) out = out.split(p.value).join(`{{${p.name}}}`);
  }
  return out;
}

function describeAction(rec: RecordedStep): string {
  const a = rec.action;
  switch (a.type) {
    case 'click':
      return `Click ${a.target.role} "${a.target.name}"`;
    case 'type':
      return `Enter a value into "${a.target.name}"`;
    case 'select':
      return `Choose "${a.value}" in "${a.target.name}"`;
    case 'navigate':
      return `Go to ${a.uri}`;
    case 'press':
      return `Press ${a.key}`;
    default:
      return a.type;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function safeOrigin(uri: string): string {
  try {
    return new URL(uri).origin;
  } catch {
    return '';
  }
}
