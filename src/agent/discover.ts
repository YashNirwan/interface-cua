/**
 * The discovery run: an LLM-driven observe -> decide -> act loop against a live
 * surface, which records the successful path as it goes.
 *
 * Two decisions worth calling out.
 *
 * 1. THE MODEL NEVER SEES A PARAMETER VALUE. It is told the capability takes a
 *    `memberId` and instructed to type the literal placeholder `{{memberId}}`.
 *    A substitution layer resolves placeholders to real values in the moment
 *    before the surface acts. Three things fall out of this for free:
 *      - the model transcript contains no member data and no credentials, so
 *        evidence is safe to keep and safe to send to a vendor;
 *      - the recorded step is already parameterized — there is no fragile
 *        after-the-fact "find the literal and guess it was a variable" pass;
 *      - a password can be typed into a login form by a flow the model
 *        discovered, without the model ever holding the password.
 *
 * 2. RECORDING IS MECHANICAL, NOT MODEL-REPORTED. The artifact's steps are
 *    built from what the surface actually did — the node that was actually
 *    resolved, the tier it resolved at, the state that actually changed. We do
 *    not ask the model to summarize what it did, because that is exactly the
 *    kind of thing models get subtly wrong, and here it would be baked into a
 *    production automation. The model contributes intent text and judgement
 *    about where the data is; it does not contribute facts about the run.
 */

import { randomUUID } from 'node:crypto';
import type { Action, Observation, ResolutionTier, Surface, TargetDescriptor, UiNode } from '../surface/types.js';
import type { StepAction } from '../artifact/schema.js';
import type { RunLogger } from '../evidence/types.js';
import type { PolicyGate, Redactor } from '../policy/types.js';
import { PolicyViolationError } from '../policy/types.js';
import type { SessionLease } from '../escalation/lease.js';
import type { LlmMessage, LlmProvider } from './llm/provider.js';
import { SYSTEM_PROMPT, renderObservation, toolSpecs } from './prompt.js';
import { descriptorFromNode, resolveDescriptor } from '../surface/web/resolve.js';
import { canonicalizePath } from '../surface/canonicalize.js';

export interface DiscoveryParam {
  name: string;
  /** The real value. Never sent to the model. */
  value: string;
  type: 'string' | 'number' | 'money' | 'date' | 'boolean';
  description: string;
  sensitivity: 'public' | 'identifier' | 'financial' | 'pii' | 'secret';
  /** Set for secrets: the env key the value came from. Stored in the artifact instead of the value. */
  secretKey?: string;
}

export interface RecordedOutput {
  name: string;
  type: 'string' | 'number' | 'money' | 'date' | 'boolean';
  description: string;
  sensitivity: 'public' | 'identifier' | 'financial' | 'pii';
  label?: string;
  /** Row anchor when the value lives in a data grid. */
  row?: string;
  descriptor?: TargetDescriptor;
}

export interface RecordedStep {
  intent: string;
  action: StepAction;
  recordedTier?: ResolutionTier;
  risk: 'safe' | 'risky';
  /** State that became true after the action; used to synthesize a checkpoint. */
  effect: { uri: string; canonicalPath: string; title: string; newText: string[] };
}

export interface DiscoveryResult {
  status: 'success' | 'escalated' | 'exhausted' | 'failed';
  runId: string;
  goal: string;
  steps: RecordedStep[];
  outputs: RecordedOutput[];
  successCheckpointText?: string;
  summary?: string;
  entryUri: string;
  params: DiscoveryParam[];
  model: string;
  provider: string;
  llmCalls: number;
  transcriptDigest: string;
  detail?: string;
  /** Interstitials the agent had to clear; candidates for declared recoveries. */
  observedInterruptions: Array<{ text: string; clearedBy: StepAction }>;
}

export interface DiscoverDeps {
  surface: Surface;
  llm: LlmProvider;
  gate: PolicyGate;
  lease: SessionLease;
  logger: RunLogger;
  redactor: Redactor;
  /** Reports time spent waiting on the model, so budgets can exclude it. */
  onLlmWait?: (ms: number) => void;
  /** Grants/revokes a one-action authorisation after an operator approves. */
  setOneTimeApproval?: (granted: boolean) => void;
  escalation?: {
    escalate(opts: {
      reason: string;
      summary: string;
      context: Record<string, unknown>;
      allowedResolutions: string[];
    }): Promise<{ kind: string; note?: string; operator: string }>;
  };
}

export interface DiscoverOptions {
  goal: string;
  entryUri: string;
  params: DiscoveryParam[];
  maxSteps?: number;
  maxLlmCalls?: number;
  runId?: string;
}

const STUCK_THRESHOLD = 3;

export async function discover(deps: DiscoverDeps, opts: DiscoverOptions): Promise<DiscoveryResult> {
  const runId = opts.runId ?? `disc_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const maxSteps = opts.maxSteps ?? deps.gate.config.limits.maxSteps;
  const maxLlmCalls = opts.maxLlmCalls ?? deps.gate.config.limits.maxLlmCalls;
  const startedAt = Date.now();

  const steps: RecordedStep[] = [];
  const outputs: RecordedOutput[] = [];
  const interruptions: DiscoveryResult['observedInterruptions'] = [];
  const messages: LlmMessage[] = [];
  const transcriptParts: string[] = [];
  let llmCalls = 0;

  const result = (over: Partial<DiscoveryResult> & Pick<DiscoveryResult, 'status'>): DiscoveryResult => ({
    runId,
    goal: opts.goal,
    steps,
    outputs,
    entryUri: opts.entryUri,
    params: opts.params,
    model: deps.llm.model,
    provider: deps.llm.name,
    llmCalls,
    transcriptDigest: digest(transcriptParts.join('\n')),
    observedInterruptions: interruptions,
    ...over,
  });

  deps.logger.emit('run.start', { mode: 'discovery', goal: opts.goal, entryUri: opts.entryUri, params: opts.params.map(paramSummary), model: deps.llm.model }, `discovery run ${runId}`);

  // Establish the starting screen before the model is involved at all. If we
  // cannot even reach the entry point there is no point paying for a turn.
  await deps.surface.act({ type: 'navigate', uri: opts.entryUri });
  let obs = await deps.surface.observe();
  let prevObs: Observation | undefined;

  messages.push({ role: 'user', content: openingMessage(opts) + '\n\n' + renderObservation(obs) });

  const recentDigests: string[] = [];

  while (steps.length < maxSteps && llmCalls < maxLlmCalls) {
    llmCalls++;
    deps.logger.emit('llm.request', { turn: llmCalls, messages: messages.length }, `model turn ${llmCalls}`);
    const llmStartedAt = Date.now();
    const turn = await deps.llm.complete({ system: SYSTEM_PROMPT, messages, tools: toolSpecs() });
    deps.onLlmWait?.(Date.now() - llmStartedAt);
    transcriptParts.push(turn.text);
    deps.logger.emit(
      'llm.response',
      { turn: llmCalls, text: deps.redactor.text(turn.text), tools: turn.toolCalls.map((t) => t.name), usage: turn.usage },
      turn.text.slice(0, 300),
    );

    if (turn.toolCalls.length === 0) {
      // The model produced commentary but no action. One nudge, then treat it
      // as a dead end rather than paying for an unbounded chat.
      messages.push({ role: 'assistant', content: turn.text, toolCalls: [] });
      messages.push({ role: 'user', content: 'You did not take an action. Call exactly one tool, or call escalate if you cannot proceed.' });
      if (recentDigests.at(-1) === 'NO_ACTION') {
        return await escalateOut(deps, result({ status: 'escalated' }), 'stuck_no_progress', 'Model produced no actionable tool call twice in a row.', obs);
      }
      recentDigests.push('NO_ACTION');
      continue;
    }

    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });
    const toolResults: Array<{ id: string; content: string; isError?: boolean }> = [];

    for (const call of turn.toolCalls) {
      const why = String(call.args.why ?? turn.text.slice(0, 160) ?? call.name);

      // ---- terminal tools -------------------------------------------------
      if (call.name === 'declare_success') {
        const checkpointText = String(call.args.checkpointText ?? '');
        const summary = String(call.args.summary ?? opts.goal);
        // Trust but verify: the model claims success, so we check its own
        // checkpoint against the live screen before recording anything. A
        // capability whose success condition does not hold at record time
        // would never replay, and we would rather fail here than ship it.
        const fresh = await deps.surface.observe();
        const bound = substitute(checkpointText, opts.params);
        if (!normalize(fresh.text).includes(normalize(bound))) {
          toolResults.push({
            id: call.id,
            content: `That checkpoint text was not found on the current screen. Choose a distinctive phrase that is actually visible, or keep working. Current screen:\n${renderObservation(fresh)}`,
            isError: true,
          });
          continue;
        }
        deps.logger.emit('run.end', { status: 'success', steps: steps.length }, 'goal reached');
        return result({ status: 'success', successCheckpointText: checkpointText, summary, detail: `completed in ${Date.now() - startedAt}ms` });
      }

      if (call.name === 'escalate') {
        return await escalateOut(deps, result({ status: 'escalated' }), String(call.args.reason ?? 'stuck_no_progress'), String(call.args.summary ?? 'agent requested help'), obs);
      }

      if (call.name === 'record_output') {
        const out = recordOutput(call.args, obs);
        if (!out.ok) {
          toolResults.push({ id: call.id, content: out.error, isError: true });
        } else if (outputs.some((o) => o.name === out.value.name)) {
          toolResults.push({ id: call.id, content: `Output "${out.value.name}" is already recorded. Record a different one, or call declare_success.`, isError: true });
        } else {
          outputs.push(out.value);
          deps.logger.emit('extract', { name: out.value.name, type: out.value.type, via: out.value.label ? 'labeledValue' : 'element' }, `recorded output ${out.value.name}`);
          // Re-send the screen. record_output does not change the page, but
          // without it the model's most recent view is several turns stale
          // (older screens are collapsed), and it starts re-deriving where it
          // is instead of finishing the job.
          toolResults.push({
            id: call.id,
            content:
              `Recorded output "${out.value.name}".\nRecord any remaining outputs, then call declare_success.\n\n` +
              `${progressSummary(steps, outputs)}\n\n${renderObservation(obs)}`,
          });
        }
        continue;
      }

      if (call.name === 'screenshot') {
        const cap = await deps.surface.capture({ maskSensitive: true });
        const saved = await deps.logger.saveCapture(`disc-step-${steps.length}`, cap);
        toolResults.push({ id: call.id, content: `Screenshot captured (${saved.screenshot ?? 'n/a'}). The element list remains your primary view.` });
        continue;
      }

      // ---- acting tools ---------------------------------------------------
      const built = buildAction(call.name, call.args, obs);
      if (!built.ok) {
        toolResults.push({ id: call.id, content: built.error, isError: true });
        continue;
      }

      prevObs = obs;
      const targetNode = built.node;
      let tier: ResolutionTier | undefined;

      try {
        // Placeholders are resolved here and nowhere else. Everything upstream
        // (model, transcript, logs) sees only `{{memberId}}`.
        const executable = substituteAction(built.action, opts.params);
        const res = await deps.surface.act(executable);
        if (!res.ok) {
          toolResults.push({ id: call.id, content: `Action failed: ${res.error?.message ?? 'unknown error'}. Re-read the screen and try a different approach.`, isError: true });
          obs = await deps.surface.observe();
          toolResults[toolResults.length - 1]!.content += `\n\n${renderObservation(obs)}`;
          continue;
        }
        tier = res.tier;
      } catch (e) {
        if (e instanceof PolicyViolationError) {
          // A risky action during discovery is not a crash and not something
          // the model may route around; it is a question for a human.
          deps.logger.emit('policy.decision', { code: e.code, action: call.name }, `policy blocked ${call.name}: ${e.code}`);
          if (e.code === 'risky_action_needs_approval' || e.code === 'risky_action_blocked') {
            const decision = await escalateInline(deps, {
              reason: 'risky_action_blocked',
              summary: `The agent wants to perform an irreversible action: ${describeTarget(targetNode, built.action)}. Goal: ${opts.goal}`,
              obs,
              allowed: ['approve', 'skip', 'abort'],
            });
            if (decision === 'abort') return result({ status: 'escalated', detail: 'operator aborted at a risky step' });
            if (decision === 'skip') {
              toolResults.push({ id: call.id, content: 'A human operator declined that irreversible action and asked you to skip it. Continue without it, or escalate if the goal cannot be met.' });
              continue;
            }
            // approve: the operator authorised THIS action. Grant a one-shot
            // approval so the gate lets it through, then revoke immediately —
            // the authorisation must not outlive the action it was given for.
            deps.setOneTimeApproval?.(true);
            let res2;
            try {
              res2 = await deps.surface.act(substituteAction(built.action, opts.params));
            } finally {
              deps.setOneTimeApproval?.(false);
            }
            tier = res2.tier;
          } else {
            deps.logger.emit('error', { code: e.code, message: e.message }, 'policy violation during discovery');
            return result({ status: 'failed', detail: `policy violation: ${e.message}` });
          }
        } else {
          throw e;
        }
      }

      obs = await deps.surface.observe();

      // Verify the descriptor we are about to store actually identifies this
      // control uniquely, ON THE SCREEN IT WAS RECORDED FROM. If it does not,
      // we widen it now rather than shipping a capability that is ambiguous
      // from the moment it is written. This also gives us the true record-time
      // resolution tier, which is the baseline replay compares against to
      // detect drift — acting on an ephemeral ref never produces one.
      const finalized = targetNode ? finalizeDescriptor(targetNode, prevObs ?? obs) : undefined;
      if (finalized?.warning) {
        deps.logger.emit('error', { warning: finalized.warning }, `weak locator recorded: ${finalized.warning}`);
      }

      const stepAction = toStepAction(built.action, targetNode, opts.params, finalized?.descriptor);
      if (stepAction) {
        steps.push({
          intent: why,
          action: stepAction,
          recordedTier: finalized?.tier ?? tier,
          risk: deps.gate.classifyRisk(built.action.type, targetNode?.name),
          effect: effectOf(prevObs, obs),
        });
      }

      // Interstitials the agent had to clear are the best evidence we will ever
      // get about which recoveries this capability needs, so note them.
      const interrupted = detectInterruption(prevObs, obs, stepAction);
      if (interrupted) interruptions.push(interrupted);

      const d = stateDigest(obs);
      recentDigests.push(d);
      if (recentDigests.length >= STUCK_THRESHOLD && recentDigests.slice(-STUCK_THRESHOLD).every((x) => x === d)) {
        // Three actions with no observable state change: by definition the
        // agent is not making progress, and continuing burns tokens against a
        // screen that is not responding to it.
        return await escalateOut(deps, result({ status: 'escalated' }), 'stuck_no_progress', `No observable state change after ${STUCK_THRESHOLD} consecutive actions on ${obs.location.uri}.`, obs);
      }

      toolResults.push({ id: call.id, content: `${progressSummary(steps, outputs)}\n\n${renderObservation(obs)}` });
    }

    if (toolResults.length) messages.push({ role: 'tool-results', results: toolResults });
    compactHistory(messages);
  }

  const why = steps.length >= maxSteps ? `step budget of ${maxSteps} exhausted` : `model-call budget of ${maxLlmCalls} exhausted`;
  deps.logger.emit('run.end', { status: 'exhausted', reason: why }, why);
  return await escalateOut(deps, result({ status: 'exhausted', detail: why }), 'max_steps_exhausted', why, obs);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------


/**
 * An explicit record of what the agent has already accomplished.
 *
 * Collapsing stale screens keeps the context window bounded, but it also
 * removes the evidence the model was using to remember that it had already
 * signed on. Left to reconstruct that from a truncated transcript, it
 * re-derives the task from scratch, navigates back to the login page and
 * loops.
 *
 * The fix is to stop making it infer state that we already know exactly: the
 * recorder has the authoritative list of completed steps, so we hand it over
 * on every turn. Cheap, deterministic, and it turns "what have I done?" from a
 * reasoning problem into a lookup.
 */
function progressSummary(steps: RecordedStep[], outputs: RecordedOutput[]): string {
  const lines: string[] = ['PROGRESS SO FAR (already done \u2014 do not repeat these):'];
  if (steps.length === 0) lines.push('  (nothing yet)');
  else steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.intent}`));
  lines.push(
    outputs.length ? `OUTPUTS RECORDED: ${outputs.map((o) => o.name).join(', ')}` : 'OUTPUTS RECORDED: (none yet)',
  );
  return lines.join('\n');
}

function openingMessage(opts: DiscoverOptions): string {
  const lines = [`GOAL: ${opts.goal}`, '', `Application entry point: ${opts.entryUri}`, ''];
  if (opts.params.length) {
    lines.push('PARAMETERS AVAILABLE TO YOU:');
    for (const p of opts.params) {
      lines.push(`  {{${p.name}}}  (${p.type}) — ${p.description}`);
    }
    lines.push('');
    lines.push(
      'IMPORTANT: you do not have the actual values, and you do not need them. When a field needs one of these, type the placeholder EXACTLY as written, e.g. {{' +
        opts.params[0]!.name +
        '}}. The system substitutes the real value when it performs the action. Never invent a value.',
    );
    lines.push('');
  }
  lines.push('Begin. Read the screen below and take one action.');
  return lines.join('\n');
}

function paramSummary(p: DiscoveryParam) {
  return { name: p.name, type: p.type, sensitivity: p.sensitivity, fromSecretStore: Boolean(p.secretKey) };
}

type BuiltAction = { ok: true; action: Action; node?: UiNode } | { ok: false; error: string };

function buildAction(name: string, args: Record<string, unknown>, obs: Observation): BuiltAction {
  const findRef = (r: unknown): UiNode | undefined => obs.nodes.find((n) => n.ref === String(r));
  switch (name) {
    case 'navigate':
      return { ok: true, action: { type: 'navigate', uri: String(args.uri) } };
    case 'press':
      return { ok: true, action: { type: 'press', key: String(args.key) } };
    case 'wait':
      return { ok: true, action: { type: 'wait', ms: args.ms ? Number(args.ms) : undefined, forText: args.forText ? String(args.forText) : undefined } };
    case 'click': {
      const node = findRef(args.ref);
      if (!node) return { ok: false, error: `No element with ref "${String(args.ref)}" on this screen. Re-read the element list and use a ref from it.` };
      return { ok: true, action: { type: 'click', target: { ref: node.ref } }, node };
    }
    case 'type': {
      const node = findRef(args.ref);
      if (!node) return { ok: false, error: `No element with ref "${String(args.ref)}" on this screen.` };
      return { ok: true, action: { type: 'type', target: { ref: node.ref }, text: String(args.text), submit: Boolean(args.submit) }, node };
    }
    case 'select': {
      const node = findRef(args.ref);
      if (!node) return { ok: false, error: `No element with ref "${String(args.ref)}" on this screen.` };
      return { ok: true, action: { type: 'select', target: { ref: node.ref }, value: String(args.value) }, node };
    }
    default:
      return { ok: false, error: `Unknown tool "${name}".` };
  }
}

/**
 * Build the descriptor we will actually persist, and prove it resolves to
 * exactly this node against the screen it was recorded on.
 *
 * The cascade is tried as-is first. If the control is genuinely ambiguous
 * (two identical "View" buttons in the same Accounts table), we fall back to
 * pinning the ordinal — and return a warning, because an ordinal locator is a
 * liability we want visible in the evidence and in review, not silently
 * embedded in a production capability.
 */
function finalizeDescriptor(
  node: UiNode,
  obs: Observation,
): { descriptor: TargetDescriptor; tier?: ResolutionTier; warning?: string } {
  const base = descriptorFromNode(node);
  const res = resolveDescriptor(base, obs.nodes);
  if (res.ok && res.node.ref === node.ref) {
    return { descriptor: base, tier: res.tier };
  }
  const pinned: TargetDescriptor = { ...base, ordinal: node.ordinal };
  const res2 = resolveDescriptor(pinned, obs.nodes);
  const why =
    res.ok && res.node.ref !== node.ref
      ? `descriptor for ${describeNodeShort(node)} resolved to a different control; pinned by position`
      : `descriptor for ${describeNodeShort(node)} was ambiguous; pinned by position (ordinal ${node.ordinal})`;
  return { descriptor: pinned, tier: res2.ok ? res2.tier : 'ordinal', warning: why };
}

function describeNodeShort(n: UiNode): string {
  return `${n.role} "${n.name}"${n.section ? ` in "${n.section}"` : ''}`;
}

/** Turn an executed action into its storable, parameterized form. */
function toStepAction(
  action: Action,
  node: UiNode | undefined,
  params: DiscoveryParam[],
  descriptor?: TargetDescriptor,
): StepAction | undefined {
  switch (action.type) {
    case 'navigate':
      return { type: 'navigate', uri: parameterize(action.uri, params) };
    case 'press':
      return { type: 'press', key: action.key };
    case 'wait':
      return { type: 'wait', ms: action.ms, forText: action.forText };
    case 'click':
      if (!node) return undefined;
      return { type: 'click', target: descriptor ?? descriptorFromNode(node) };
    case 'type':
      if (!node) return undefined;
      // `action.text` still holds the placeholder form the model typed, which
      // is exactly what we want to persist.
      return { type: 'type', target: descriptor ?? descriptorFromNode(node), text: action.text, submit: action.submit ?? false };
    case 'select':
      if (!node) return undefined;
      return { type: 'select', target: descriptor ?? descriptorFromNode(node), value: action.value };
    default:
      return undefined;
  }
}

/** Replace `{{name}}` with the real value, immediately before acting. */
function substitute(s: string, params: DiscoveryParam[]): string {
  return s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key: string) => params.find((p) => p.name === key)?.value ?? m);
}

function substituteAction(a: Action, params: DiscoveryParam[]): Action {
  if (a.type === 'type') return { ...a, text: substitute(a.text, params) };
  if (a.type === 'navigate') return { ...a, uri: substitute(a.uri, params) };
  if (a.type === 'select') return { ...a, value: substitute(a.value, params) };
  return a;
}

/**
 * The inverse: if a concrete value slipped through (a URL the model typed by
 * hand, say), turn it back into a placeholder. This is a safety net, not the
 * primary mechanism — the placeholder discipline above is.
 */
function parameterize(s: string, params: DiscoveryParam[]): string {
  let out = s;
  for (const p of params) {
    if (p.sensitivity === 'secret') continue; // a secret must never appear at all
    if (p.value && out.includes(p.value)) out = out.split(p.value).join(`{{${p.name}}}`);
  }
  return out;
}

function recordOutput(args: Record<string, unknown>, obs: Observation): { ok: true; value: RecordedOutput } | { ok: false; error: string } {
  const name = String(args.name ?? '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) return { ok: false, error: `"${name}" is not a valid camelCase output name.` };
  const label = args.label ? String(args.label) : undefined;
  const ref = args.ref ? String(args.ref) : undefined;
  if (!label && !ref) return { ok: false, error: 'Provide either `label` (preferred) or `ref` so the value can be found again on replay.' };

  let descriptor: TargetDescriptor | undefined;
  if (ref) {
    const node = obs.nodes.find((n) => n.ref === ref);
    if (!node) return { ok: false, error: `No element with ref "${ref}" on this screen.` };
    descriptor = descriptorFromNode(node);
  }
  if (label && !normalize(obs.text).includes(normalize(label))) {
    return { ok: false, error: `The label "${label}" is not visible on this screen. Use a label that actually appears next to the value.` };
  }
  return {
    ok: true,
    value: {
      name,
      type: (args.type as RecordedOutput['type']) ?? 'string',
      description: String(args.description ?? name),
      sensitivity: (args.sensitivity as RecordedOutput['sensitivity']) ?? 'public',
      label,
      row: args.row ? String(args.row) : undefined,
      descriptor,
    },
  };
}

function effectOf(before: Observation | undefined, after: Observation): RecordedStep['effect'] {
  const beforeText = before ? new Set(splitPhrases(before.text)) : new Set<string>();
  const newText = splitPhrases(after.text)
    .filter((p) => !beforeText.has(p))
    .filter((p) => p.length > 8 && p.length < 90)
    .slice(0, 5);
  return {
    uri: after.location.uri,
    canonicalPath: after.location.canonicalPath ?? canonicalizePath(after.location.uri),
    title: after.location.title,
    newText,
  };
}

/**
 * Something appeared between the action and its effect that we had to clear —
 * a maintenance notice, an EULA banner. These become candidate recoveries.
 */
function detectInterruption(before: Observation | undefined, after: Observation, action: StepAction | undefined): { text: string; clearedBy: StepAction } | undefined {
  if (!before || !action) return undefined;
  const dismissalNames = ['acknowledge', 'ok', 'continue', 'dismiss', 'close', 'i agree', 'accept'];
  if (action.type !== 'click') return undefined;
  const name = action.target.name.toLowerCase().trim();
  if (!dismissalNames.some((d) => name === d || name.startsWith(d))) return undefined;
  const distinctive = splitPhrases(before.text).find((p) => p.length > 12 && p.length < 90 && !after.text.includes(p));
  if (!distinctive) return undefined;
  return { text: distinctive, clearedBy: action };
}

function splitPhrases(text: string): string[] {
  return text
    .split(/[\n.;|]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * A fingerprint of "what is on screen", used only to detect that the agent has
 * stopped making progress.
 *
 * It hashes the FULL text, not a prefix. In a frameset app the navigation
 * frame's text comes first and never changes, so a prefix-based digest reports
 * "identical screen" for every step of a flow that is in fact advancing
 * normally through the content frame — and the agent gets escalated to a human
 * for being stuck while it is working perfectly. The control names are included
 * for the same reason: some screens differ only by which buttons are present.
 */
function stateDigest(obs: Observation): string {
  const controls = obs.nodes
    .map((n) => {
      // Include whether a field is filled, and how much — otherwise typing the
      // three fields of a login form looks like three actions with no effect,
      // and the agent gets escalated for being stuck while it is filling in a
      // form correctly. The LENGTH, never the value: this digest is written to
      // the evidence log on every step.
      const filled = n.value === undefined ? '' : `=${n.sensitive ? 'set' : n.value.length}`;
      return `${n.framePath.join('>')}/${n.role}:${n.name}${filled}`;
    })
    .join('|');
  return digest(`${obs.location.uri}|${obs.nodes.length}|${obs.text}|${controls}`);
}

function digest(s: string): string {
  // Small non-cryptographic digest; this is a change-detector and a provenance
  // marker, not a security primitive.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function describeTarget(node: UiNode | undefined, action: Action): string {
  if (node) return `${node.role} "${node.name}"${node.section ? ` in section "${node.section}"` : ''}`;
  return action.type;
}

/**
 * Keep the context window bounded on long runs.
 *
 * Two mechanisms, and the first matters more than the second:
 *
 * 1. COLLAPSE STALE SCREENS. Every action returns a full rendering of the
 *    resulting screen, and by the next turn that rendering is superseded — the
 *    model needs the CURRENT screen, not a replay of every screen it has ever
 *    seen. Resending them all makes token use grow quadratically in the number
 *    of steps, which on a rate-limited tier is what actually ends a run. We
 *    keep the newest observation verbatim and reduce older ones to a one-line
 *    record that the action happened, which is all the history the model needs
 *    to avoid repeating itself.
 *
 * 2. Drop the oldest exchanges once the transcript is long, always preserving
 *    the opening message, which carries the goal and the parameter contract.
 */
function compactHistory(messages: LlmMessage[], keep = 20): void {
  const lastResultsIdx = messages.map((m) => m.role).lastIndexOf('tool-results');
  for (let i = 0; i < messages.length; i++) {
    if (i === lastResultsIdx) continue;
    const m = messages[i];
    if (m?.role !== 'tool-results') continue;
    messages[i] = {
      role: 'tool-results',
      results: m.results.map((r) => ({
        id: r.id,
        content: summarizeStaleResult(r.content),
        ...(r.isError ? { isError: true } : {}),
      })),
    };
  }

  // Trim whole exchanges, never half of one. An assistant turn that made tool
  // calls and the message carrying those calls' results are a matched pair:
  // dropping the assistant turn while keeping the results leaves tool outputs
  // with nothing to attach to, which strict providers reject outright. So we
  // always remove an assistant turn together with the results that follow it.
  while (messages.length > keep + 1) {
    messages.splice(1, 1);
    while (messages.length > 1 && messages[1]?.role === 'tool-results') messages.splice(1, 1);
  }
}

/** One line standing in for a screen the model has already moved past. */
function summarizeStaleResult(content: string): string {
  if (content.startsWith('SCREEN:')) {
    const screen = /^SCREEN: (.*)$/m.exec(content)?.[1] ?? '';
    const uri = /^URI: (.*)$/m.exec(content)?.[1] ?? '';
    return `[earlier screen, superseded] ${screen} — ${uri}`;
  }
  return content.length > 200 ? `${content.slice(0, 200)}…` : content;
}

async function escalateInline(
  deps: DiscoverDeps,
  o: { reason: string; summary: string; obs: Observation; allowed: string[] },
): Promise<string> {
  if (!deps.escalation) return 'abort';
  const res = await deps.escalation.escalate({
    reason: o.reason,
    summary: o.summary,
    context: { mode: 'discovery', location: { uri: o.obs.location.uri, title: o.obs.location.title } },
    allowedResolutions: o.allowed,
  });
  return res.kind;
}

async function escalateOut(deps: DiscoverDeps, base: DiscoveryResult, reason: string, summary: string, obs: Observation): Promise<DiscoveryResult> {
  deps.logger.emit('escalation.raised', { reason, summary }, summary);
  if (deps.escalation) {
    try {
      const res = await deps.escalation.escalate({
        reason,
        summary,
        context: { mode: 'discovery', goal: base.goal, location: { uri: obs.location.uri, title: obs.location.title } },
        allowedResolutions: ['resume', 'abort'],
      });
      return { ...base, detail: `${summary} — operator: ${res.kind}${res.note ? ` (${res.note})` : ''}` };
    } catch (e) {
      return { ...base, detail: `${summary} — escalation unresolved: ${(e as Error).message}` };
    }
  }
  return { ...base, detail: summary };
}

/**
 * The evidence-safe form of a discovery run.
 *
 * `DiscoveryResult.params` carries real parameter VALUES because the compiler
 * needs them to parameterize the recorded flow. Those values must never reach
 * disk. The redactor is a text-level defence and cannot know that the string
 * under `value` is a credential, so the boundary that writes evidence strips
 * them structurally instead — defence at the point where the type is known,
 * rather than hoping a regex recognises it.
 */
export function toEvidence(run: DiscoveryResult): Omit<DiscoveryResult, 'params'> & { params: ReturnType<typeof paramSummary>[] } {
  return { ...run, params: run.params.map(paramSummary) };
}
