#!/usr/bin/env node
/**
 * `cua` — the operator/developer entry point.
 *
 * Two commands carry the whole thesis:
 *   cua discover   the model figures out a flow once, and it is recorded
 *   cua replay     the recording runs in production, with no model involved
 *
 * Everything else exists to make those two reviewable: `catalog` shows what an
 * AI agent would see, `learn-outcome` teaches a capability about a business
 * answer by actually triggering it, `verify` measures whether replay is stable
 * enough to trust unattended, and `approve` is the human sign-off gate.
 */

import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { discover, toEvidence, type DiscoveryParam } from './agent/discover.js';
import { AnthropicProvider } from './agent/llm/anthropic.js';
import { GroqProvider } from './agent/llm/groq.js';
import type { LlmProvider } from './agent/llm/provider.js';
import { compile } from './artifact/compile.js';
import { FileCapabilityStore, bumpVersion } from './artifact/store.js';
import { parseCapability, type Capability, type Outcome } from './artifact/schema.js';
import { Catalog, toTool } from './catalog/catalog.js';
import { replay, verifyStability, type EscalationPort } from './replay/executor.js';
import { applyOverlay } from './replay/overlay.js';
import { summarize, exitCodeFor, type ReplayResult } from './replay/result.js';
import { startOperatorConsole } from './escalation/console.js';
import { createSession, envSecrets, newRunId, type Session } from './runtime.js';
import type { EscalationReason, InterventionResolutionKind } from './escalation/types.js';
import type { Redactor } from './policy/types.js';

const program = new Command();
program.name('cua').description('Computer-use capability discovery and deterministic replay').version('0.1.0');

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * Pick the discovery model provider.
 *
 * Selected by CUA_LLM ('anthropic' | 'groq'), defaulting to whichever key is
 * actually present so a reviewer with either one can run `cua discover` without
 * reading the source. Nothing on the replay path calls this — the model seam is
 * reachable from discovery only.
 */
function makeLlm(): LlmProvider {
  const choice = (process.env['CUA_LLM'] ?? '').toLowerCase();
  if (choice === 'groq') return new GroqProvider();
  if (choice === 'anthropic') return new AnthropicProvider();
  if (choice !== '') throw new Error(`unknown CUA_LLM '${choice}' (expected 'anthropic' or 'groq')`);
  if (process.env['ANTHROPIC_API_KEY']) return new AnthropicProvider();
  if (process.env['GROQ_API_KEY']) return new GroqProvider();
  throw new Error('no model credentials found: set ANTHROPIC_API_KEY or GROQ_API_KEY (discovery only; replay needs neither)');
}

function kvList(values: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const i = v.indexOf('=');
    if (i < 0) throw new Error(`expected name=value, got "${v}"`);
    out[v.slice(0, i)] = v.slice(i + 1);
  }
  return out;
}

/** Adapt the broker to the narrow port the executor and agent loop depend on. */
function escalationPort(session: Session, mode: 'discovery' | 'replay'): EscalationPort {
  return {
    async escalate(o) {
      const res = await session.broker.escalate({
        reason: o.reason as EscalationReason,
        summary: o.summary,
        context: { mode, ...(o.context as Record<string, unknown>) } as never,
        allowedResolutions: o.allowedResolutions as InterventionResolutionKind[],
        surface: session.surface,
        lease: session.lease,
        logger: session.logger,
        redactor: session.redactor,
      });
      return { kind: res.kind, note: res.note, operator: res.operator };
    },
  };
}

async function maybeStartConsole(session: Session, enabled: boolean): Promise<(() => Promise<void>) | undefined> {
  if (!enabled) return undefined;
  const c = await startOperatorConsole({
    broker: session.broker,
    surfaceFor: (runId) => (runId === session.runId ? session.surface : undefined),
  });
  process.stderr.write(`\n  operator console: ${c.url}\n\n`);
  return c.close;
}

function printResult(r: ReplayResult, json: boolean): never {
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    process.stdout.write(`\n${summarize(r)}\n`);
    if (r.status === 'success') for (const [k, v] of Object.entries(r.outputs)) process.stdout.write(`  ${k}: ${JSON.stringify(v)}\n`);
    if (r.status === 'business_outcome') process.stdout.write(`  data: ${JSON.stringify(r.outcome.data)}\n`);
    if (r.status === 'failed') {
      process.stdout.write(`  expected: ${r.failure.expected ?? '-'}\n  observed: ${r.failure.observed ?? '-'}\n  retryable: ${r.failure.retryable}\n`);
    }
    process.stdout.write(`  evidence: ${r.meta.evidence.dir}\n`);
    if (r.meta.driftDetected) process.stdout.write(`  NOTE: locator drift detected — a step resolved via a weaker strategy than recorded\n`);
  }
  process.exit(exitCodeFor(r));
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

program
  .command('discover')
  .description('Run the LLM-driven discovery loop and record the successful flow as a capability')
  .requiredOption('--goal <text>', 'natural-language goal, using {{param}} placeholders')
  .requiredOption('--target <uri>', 'application entry point')
  .requiredOption('--id <id>', 'capability id, e.g. meridian.member.savings_balance')
  .option('--param <name=value...>', 'input parameter supplied per invocation', [])
  .option('--secret <name=ENV_KEY...>', 'credential resolved from the environment, never stored', [])
  .option('--describe <name=text...>', 'description for a parameter', [])
  .option('--vendor <name>', 'vendor of the target product', 'meridian')
  .option('--product <name>', 'product name', 'core-member-servicing')
  .option('--surface <kind>', 'web | legacy-web | desktop', 'legacy-web')
  .option('--headed', 'run with a visible browser (required for real human takeover)', false)
  .option('--console', 'start the operator console for escalations', false)
  .option('--max-steps <n>', 'step budget', (v) => Number(v), 25)
  .action(async (o) => {
    const params = kvList(o.param);
    const secrets = kvList(o.secret);
    const describes = kvList(o.describe);

    const discoveryParams: DiscoveryParam[] = [
      ...Object.entries(params).map(([name, value]): DiscoveryParam => ({
        name,
        value,
        type: 'string',
        description: describes[name] ?? `${name} supplied by the calling agent`,
        // A bare numeric argument in a banking flow is an account or member
        // identifier far more often than it is anything else, so we default to
        // the conservative classification and let a reviewer relax it.
        sensitivity: /^\d+$/.test(value) ? 'identifier' : 'public',
      })),
      ...Object.entries(secrets).map(([name, key]): DiscoveryParam => {
        const value = process.env[key];
        if (!value) throw new Error(`secret ${name} refers to ${key}, which is not set in the environment`);
        return { name, value, type: 'string', description: describes[name] ?? `${name} (from secret store)`, sensitivity: 'secret', secretKey: key };
      }),
    ];

    const session = await createSession({ mode: 'discovery', headless: !o.headed, echo: true, runId: newRunId('disc'), secretKeys: Object.values(secrets) });
    const closeConsole = await maybeStartConsole(session, o.console);
    try {
      const run = await discover(
        {
          surface: session.surface,
          llm: makeLlm(),
          gate: session.gate,
          lease: session.lease,
          logger: session.logger,
          redactor: session.redactor,
          onLlmWait: (ms) => (session.budget.llmWaitMs += ms),
          setOneTimeApproval: (g) => (session.budget.approveNextAction = g),
          escalation: escalationPort(session, 'discovery'),
        },
        { goal: o.goal, entryUri: o.target, params: discoveryParams, maxSteps: o.maxSteps, runId: session.runId },
      );

      await session.logger.finish(toEvidence(run));

      if (run.status !== 'success') {
        process.stdout.write(`\ndiscovery ended: ${run.status}\n  ${run.detail ?? ''}\n  evidence: ${session.logger.dir}\n`);
        process.exit(run.status === 'escalated' ? 3 : 1);
      }

      const cap = compile(run, {
        id: o.id,
        app: { vendor: o.vendor, product: o.product, surface: o.surface },
        redactor: session.redactor,
        onWarning: (m) => process.stderr.write(`  compiler: ${m}\n`),
      });
      const store = new FileCapabilityStore();
      const path = store.save(cap);
      process.stdout.write(
        `\ndiscovery succeeded in ${run.steps.length} steps (${run.llmCalls} model calls)\n` +
          `  capability: ${path}\n  status: ${cap.status} (run \`cua approve ${cap.id}\` after review)\n  evidence: ${session.logger.dir}\n`,
      );
    } finally {
      await closeConsole?.();
      await session.dispose();
    }
  });

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

program
  .command('replay')
  .description('Replay a capability deterministically — no LLM in the decision loop')
  .argument('<id>', 'capability id (optionally id@version)')
  .option('--input <name=value...>', 'invocation arguments', [])
  .option('--tenant <id>', 'apply a tenant overlay')
  .option('--headed', 'visible browser', false)
  .option('--console', 'start the operator console for escalations', false)
  .option('--approve', 'authorise risky steps for this invocation (human in the loop)', false)
  .option('--json', 'emit the raw result contract', false)
  .action(async (idArg: string, o) => {
    const [id, version] = idArg.split('@');
    const store = new FileCapabilityStore();
    let cap = store.get(id!, version);
    if (!cap) throw new Error(`no capability '${idArg}'. Run \`cua catalog list\`.`);

    if (o.tenant) {
      const overlay = store.getOverlay(o.tenant, cap.id);
      if (!overlay) throw new Error(`no overlay for tenant '${o.tenant}' on ${cap.id}`);
      cap = applyOverlay(cap, overlay);
    }

    const session = await createSession({
      mode: 'replay',
      headless: !o.headed,
      approved: o.approve || cap.status === 'approved',
      capabilityOrigins: cap.policy.allowedOrigins,
      echo: true,
      runId: newRunId('rpl'),
      secretKeys: Object.values(cap.inputs).flatMap((i) => (i.secretKey ? [i.secretKey] : [])),
    });
    const closeConsole = await maybeStartConsole(session, o.console);
    try {
      const result = await replay(
        cap,
        kvList(o.input),
        {
          surface: session.surface,
          gate: session.gate,
          lease: session.lease,
          logger: session.logger,
          redactor: session.redactor,
          escalation: escalationPort(session, 'replay'),
          secrets: envSecrets,
        },
        { runId: session.runId, tenantId: o.tenant ?? null, approvedOverride: o.approve },
      );
      await closeConsole?.();
      await session.dispose();
      printResult(result, o.json);
    } catch (e) {
      await closeConsole?.();
      await session.dispose();
      throw e;
    }
  });

// ---------------------------------------------------------------------------
// learn-outcome
// ---------------------------------------------------------------------------

program
  .command('learn-outcome')
  .description('Teach a capability a business outcome by actually triggering it, then recording what the app showed')
  .argument('<id>', 'capability id')
  .requiredOption('--input <name=value...>', 'arguments that should produce the outcome', [])
  .requiredOption('--code <CODE>', 'outcome code, e.g. MEMBER_NOT_FOUND')
  .requiredOption('--description <text>', 'what this outcome means to a caller')
  .action(async (id: string, o) => {
    const store = new FileCapabilityStore();
    const cap = store.get(id);
    if (!cap) throw new Error(`no capability '${id}'`);

    // Establish a BASELINE first: run the capability with its known-good
    // example input and keep the text of the screen it ends on. Without this
    // we cannot tell a phrase that identifies the failure from a phrase that
    // is simply on every page of the app — and the nav chrome, being the
    // longest run of text on screen, is exactly what a naive "most
    // distinctive" heuristic would choose. A detector that matches every
    // screen would classify every successful run as a business outcome.
    const exampleId = Object.entries(cap.inputs).find(([, v]) => v.source === 'caller')?.[1]?.example;
    let baseline = '';
    if (exampleId) {
      const b = await createSession({ mode: 'replay', headless: true, capabilityOrigins: cap.policy.allowedOrigins, runId: newRunId('base') });
      try {
        const args = Object.fromEntries(
          Object.entries(cap.inputs).filter(([, v]) => v.source === 'caller' && v.example).map(([k, v]) => [k, v.example!]),
        );
        await replay(cap, args, { surface: b.surface, gate: b.gate, lease: b.lease, logger: b.logger, redactor: b.redactor, secrets: envSecrets }, { runId: b.runId });
        baseline = (await b.surface.observe()).text;
      } finally {
        await b.dispose();
      }
    }

    const session = await createSession({ mode: 'replay', headless: true, capabilityOrigins: cap.policy.allowedOrigins, runId: newRunId('learn') });
    try {
      const result = await replay(
        cap,
        kvList(o.input),
        { surface: session.surface, gate: session.gate, lease: session.lease, logger: session.logger, redactor: session.redactor, secrets: envSecrets },
        { runId: session.runId },
      );

      if (result.status === 'success') {
        throw new Error('those inputs completed successfully, so there is no outcome to learn. Use inputs that produce the condition you want to declare.');
      }
      // The screen the flow stopped on IS the outcome's signature. We derive
      // the detector from what the application actually rendered rather than
      // from a guess: we never ship a detector we have not watched fire, and
      // never one we have also watched fire on the happy path.
      const obs = await session.surface.observe();
      const phrase = pickDistinctivePhrase(obs.text, baseline, session.redactor);
      if (!phrase) throw new Error('could not find a phrase unique to this screen; declare this outcome by hand');

      const outcome: Outcome = { code: o.code, description: o.description, detect: { textPresent: phrase }, extract: [] };
      const next: Capability = parseCapability({
        ...cap,
        version: bumpVersion(cap.version, 'minor'),
        // Learning a new outcome changes the contract, so the artifact returns
        // to draft and needs re-approval. Silently amending an approved
        // capability would defeat the approval gate.
        status: 'draft',
        outcomes: [...cap.outcomes.filter((x) => x.code !== o.code), outcome],
      });
      const path = store.save(next);
      process.stdout.write(
        `learned outcome ${o.code}\n  detector: textPresent ${JSON.stringify(phrase)}\n  written: ${path} (v${next.version}, status draft)\n  evidence: ${session.logger.dir}\n`,
      );
    } finally {
      await session.dispose();
    }
  });

/**
 * Pick a phrase that identifies THIS screen and no other.
 *
 * Candidates must be absent from the baseline (so app chrome cannot become a
 * detector), free of volatile values, free of markup, and unchanged by the
 * redactor — a detector containing an account number or an operator id would
 * be persisted into a committed artifact.
 */
function pickDistinctivePhrase(text: string, baseline: string, redactor: Redactor): string | undefined {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const base = norm(baseline).toLowerCase();
  return text
    .split(/[\n.;|]+/)
    .map(norm)
    .filter((s) => s.length >= 15 && s.length <= 100)
    .filter((s) => !base.includes(s.toLowerCase()))
    .filter((s) => !/[<>]/.test(s))
    .filter((s) => !/\$\s?[\d,]+\.\d{2}/.test(s) && !/\b\d{4}-\d{2}-\d{2}\b/.test(s) && !/\b\d{5,}\b/.test(s))
    .filter((s) => redactor.text(s) === s)
    .sort((a, b) => b.length - a.length)[0];
}

// ---------------------------------------------------------------------------
// verify / approve / catalog / console
// ---------------------------------------------------------------------------

program
  .command('verify')
  .description('Replay N times and report a stability signal')
  .argument('<id>')
  .option('--input <name=value...>', '', [])
  .option('--runs <n>', '', (v) => Number(v), 3)
  .action(async (id: string, o) => {
    const store = new FileCapabilityStore();
    const cap = store.get(id);
    if (!cap) throw new Error(`no capability '${id}'`);
    const sessions: Session[] = [];
    const report = await verifyStability(cap, kvList(o.input), async () => {
      const s = await createSession({ mode: 'replay', headless: true, capabilityOrigins: cap.policy.allowedOrigins, runId: newRunId('vfy') });
      sessions.push(s);
      return { surface: s.surface, gate: s.gate, lease: s.lease, logger: s.logger, redactor: s.redactor, secrets: envSecrets };
    }, o.runs);
    for (const s of sessions) await s.dispose();

    store.save(
      parseCapability({
        ...cap,
        stability: { runs: cap.stability.runs + report.runs, successes: cap.stability.successes + report.successes, lastVerifiedAt: new Date().toISOString() },
      }),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  });

program
  .command('approve')
  .description('Human sign-off: allow this capability to run unattended, including any risky steps')
  .argument('<id>')
  .option('--by <operator>', 'who approved it', process.env.CUA_OPERATOR ?? 'operator@local')
  .action((id: string, o) => {
    const store = new FileCapabilityStore();
    const cap = store.get(id);
    if (!cap) throw new Error(`no capability '${id}'`);
    const next = parseCapability({
      ...cap,
      status: 'approved',
      description: `${cap.description}\n\nApproved for unattended execution by ${o.by} on ${new Date().toISOString()}.`,
    });
    process.stdout.write(`approved ${cap.id}@${cap.version} -> ${store.save(next)}\n`);
  });

const catalog = program.command('catalog').description('What an AI agent sees');

catalog
  .command('list')
  .option('--unattended-only', 'only capabilities safe to run without a human', false)
  .option('--json', '', false)
  .action((o) => {
    const c = new Catalog(new FileCapabilityStore());
    const tools = c.tools({ unattendedOnly: o.unattendedOnly });
    if (o.json) return void process.stdout.write(JSON.stringify(tools, null, 2) + '\n');
    if (!tools.length) return void process.stdout.write('no capabilities recorded yet — run `cua discover`\n');
    for (const t of tools) {
      process.stdout.write(
        `${t.name}@${t.meta.version}  [${t.meta.status}${t.meta.unattendedSafe ? ', unattended-safe' : ', needs a human'}]\n` +
          `  ${t.description}\n` +
          `  args: ${Object.keys(t.input_schema.properties).join(', ') || '(none)'}\n` +
          `  returns: ${Object.keys(t.returns.outputs).join(', ') || '(none)'}\n` +
          `  outcomes: ${t.returns.businessOutcomes.map((b) => b.code).join(', ') || '(none declared)'}\n\n`,
      );
    }
  });

catalog
  .command('show')
  .argument('<id>')
  .action((id: string) => {
    const store = new FileCapabilityStore();
    const cap = store.get(id);
    if (!cap) throw new Error(`no capability '${id}'`);
    process.stdout.write(JSON.stringify(toTool(cap), null, 2) + '\n');
  });

catalog
  .command('export')
  .description('Write the tool definitions an agent framework would load')
  .option('--out <file>', '', 'capabilities/tools.json')
  .action((o) => {
    const tools = new Catalog(new FileCapabilityStore()).tools();
    writeFileSync(o.out, JSON.stringify(tools, null, 2) + '\n', 'utf8');
    process.stdout.write(`wrote ${tools.length} tool definitions to ${o.out}\n`);
  });

program
  .command('console')
  .description('Start the operator console on its own (serves any run whose evidence is on disk)')
  .option('--port <n>', '', (v) => Number(v), 7788)
  .action(async (o) => {
    const { LocalEscalationBroker } = await import('./escalation/broker.js');
    const c = await startOperatorConsole({ broker: new LocalEscalationBroker(), port: o.port });
    process.stdout.write(`operator console: ${c.url}\n(ctrl-c to stop)\n`);
  });

program.parseAsync(process.argv).catch((e: Error) => {
  process.stderr.write(`\nerror: ${e.message}\n`);
  process.exit(1);
});
