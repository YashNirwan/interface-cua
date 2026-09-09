/**
 * Integration smoke test for the replay path.
 *
 * This hand-builds a capability rather than using a recorded one, so that the
 * replay engine, the surface adapter, the condition evaluator and the
 * extraction primitives can be validated against the live app WITHOUT needing
 * a model. It is a development harness, not part of the demo path — the
 * capability shipped in /capabilities is the one the LLM actually discovered.
 */
import { parseCapability, type Capability } from '../src/artifact/schema.js';
import { replay } from '../src/replay/executor.js';
import { summarize } from '../src/replay/result.js';
import { createSession, envSecrets, newRunId } from '../src/runtime.js';

const BASE = 'http://127.0.0.1:8099';

const cap: Capability = parseCapability({
  schemaVersion: 'cua.capability/v1',
  id: 'meridian.member.savings-balance.smoke',
  version: '1.0.0',
  status: 'draft',
  summary: 'Look up a member and read their savings account balance.',
  description: 'Hand-authored smoke fixture used to validate the replay engine.',
  app: { vendor: 'meridian', product: 'core-member-servicing', versionRange: '4.x', surface: 'legacy-web' },
  tenantId: null,
  entry: { uri: `${BASE}/meridian/login`, requiresSession: true },
  inputs: {
    memberId: { type: 'string', description: 'Six-digit member number', required: true, pattern: '\\d{6}', sensitivity: 'identifier', source: 'caller', example: '100482' },
    operatorId: { type: 'string', description: 'Operator sign-on id', required: true, sensitivity: 'secret', source: 'secret-store', secretKey: 'MERIDIAN_USER' },
    operatorPassword: { type: 'string', description: 'Operator password', required: true, sensitivity: 'secret', source: 'secret-store', secretKey: 'MERIDIAN_PASSWORD' },
  },
  outputs: [
    { name: 'accountNumber', type: 'string', description: 'Savings account number', required: true, sensitivity: 'financial', from: { labeledValue: { label: 'Account Number' } }, expect: 'non-empty' },
    { name: 'status', type: 'string', description: 'Account status', required: true, sensitivity: 'public', from: { labeledValue: { label: 'Status' } }, expect: 'non-empty' },
    { name: 'balance', type: 'money', description: 'Current savings balance', required: true, sensitivity: 'financial', from: { labeledValue: { label: 'Current Balance' } }, expect: 'any' },
  ],
  steps: [
    { id: 's1', intent: 'Enter the operator id', action: { type: 'type', target: { role: 'textbox', name: 'User ID', nameMatch: 'exact', framePath: [] }, text: '{{operatorId}}', submit: false }, risk: 'safe', timeoutMs: 10000, retries: 2, onFailure: 'fail' },
    { id: 's2', intent: 'Enter the operator password', action: { type: 'type', target: { role: 'textbox', name: 'Password', nameMatch: 'exact', framePath: [] }, text: '{{operatorPassword}}', submit: false }, risk: 'safe', timeoutMs: 10000, retries: 2, onFailure: 'fail' },
    {
      id: 's3',
      intent: 'Sign on',
      action: { type: 'click', target: { role: 'button', name: 'Sign On', nameMatch: 'exact', framePath: [] } },
      checkpoint: { textPresent: 'MAIN MENU' },
      risk: 'safe', timeoutMs: 10000, retries: 2, onFailure: 'fail',
    },
    {
      id: 's4',
      intent: 'Open Member Search',
      action: { type: 'navigate', uri: `${BASE}/meridian/search` },
      checkpoint: { textPresent: 'Member Search' },
      risk: 'safe', timeoutMs: 10000, retries: 2, onFailure: 'fail',
    },
    { id: 's5', intent: 'Type the member id', action: { type: 'type', target: { role: 'textbox', name: 'Member ID', nameMatch: 'exact', framePath: [] }, text: '{{memberId}}', submit: false }, risk: 'safe', timeoutMs: 10000, retries: 2, onFailure: 'fail' },
    {
      id: 's6',
      intent: 'Run the search',
      action: { type: 'click', target: { role: 'button', name: 'Search', nameMatch: 'exact', framePath: [] } },
      checkpoint: { textPresent: 'Member {{memberId}} — Profile' },
      risk: 'safe', timeoutMs: 10000, retries: 2, onFailure: 'fail',
    },
    {
      id: 's7',
      intent: 'Open the savings account row',
      action: { type: 'click', target: { role: 'button', name: 'View', nameMatch: 'exact', framePath: [], section: 'Accounts', textNear: ['Savings'], ordinal: 0 } },
      checkpoint: { textPresent: 'Account Detail' },
      risk: 'safe', timeoutMs: 10000, retries: 2, onFailure: 'fail',
      recordedTier: 'near-text',
    },
  ],
  success: { all: [{ textPresent: 'Account Detail' }, { textPresent: 'Savings' }] },
  outcomes: [
    { code: 'MEMBER_NOT_FOUND', description: 'No member matches the supplied id.', detect: { textPresent: 'No member records matched the supplied criteria.' }, extract: [] },
    { code: 'MEMBER_RESTRICTED', description: 'The operator is not entitled to view this member.', detect: { textPresent: 'You are not authorised to view this member record.' }, extract: [] },
    { code: 'INVALID_MEMBER_ID', description: 'The member id is not a six-digit number.', detect: { textPresent: 'Member ID must be a 6-digit number.' }, extract: [] },
  ],
  recoveries: [
    {
      name: 'system-notice',
      description: 'Dismiss the scheduled-maintenance interstitial.',
      detect: { textPresent: 'Scheduled maintenance window begins' },
      do: [{ type: 'click', target: { role: 'button', name: 'Acknowledge', nameMatch: 'exact', framePath: [] } }],
      maxPerRun: 2,
      retryStep: true,
    },
  ],
  policy: { allowedOrigins: [BASE], maxSteps: 40, maxDurationMs: 120000, containsRiskyActions: false },
  provenance: {
    recordedAt: new Date().toISOString(),
    recordedBy: { kind: 'human-authored' },
    runId: 'smoke',
    goal: 'Read a member savings balance (hand-authored smoke fixture).',
  },
  stability: { runs: 0, successes: 0 },
});

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=') as [string, string]));
const memberId = args.memberId ?? '100482';

// Risky variant: mark the final step irreversible, so replaying an UNAPPROVED
// capability must refuse to perform it unattended and hand the decision to a
// human. This is the production shape of the guardrail: the same block that
// stops the agent during discovery also stops an unapproved artifact in prod.
if (args.risky) {
  const s7 = cap.steps.find((s) => s.id === 's7');
  if (s7) {
    s7.risk = 'risky';
    s7.onFailure = 'escalate';
    // Rename the control the step targets so the gate's name-based classifier
    // sees an irreversible verb, exactly as it would on a real Post button.
    s7.intent = 'Post the account view (simulated irreversible action)';
  }
  cap.policy.containsRiskyActions = true;
}

// Escalation variant: make the last step hand off to a human instead of
// failing, so the control-transfer path can be exercised end to end.
if (args.escalate) {
  const s7 = cap.steps.find((s) => s.id === 's7');
  if (s7) s7.onFailure = 'escalate';
}

const session = await createSession({ mode: 'replay', headless: true, capabilityOrigins: cap.policy.allowedOrigins, runId: newRunId('smoke') });
try {
  if (args.fault) {
    // Arm a runtime fault so the error paths are exercised against the real app
    // rather than a mock. The session cookie is not established yet, so we arm
    // globally via the header the app supports.
    await fetch(`${BASE}/meridian/_faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fault-session': '*' },
      body: JSON.stringify({
        [args.fault]: args.fault === 'slowMs' ? Number(args.value ?? 2000) : true,
        // Let the flow get past sign-on before the fault bites, so the evidence
        // shows a failure mid-capability rather than on the very first request.
        afterRequests: Number(args.after ?? 0),
      }),
    });
    console.log(`armed fault: ${args.fault}${args.after ? ` after ${args.after} requests` : ''}`);
  }

  const result = await replay(
    cap,
    { memberId },
    {
      surface: session.surface,
      gate: session.gate,
      lease: session.lease,
      logger: session.logger,
      redactor: session.redactor,
      secrets: envSecrets,
      escalation: {
        escalate: async (o) => {
          const r = await session.broker.escalate({
            reason: o.reason as never,
            summary: o.summary,
            context: { mode: 'replay', ...(o.context as Record<string, unknown>) } as never,
            allowedResolutions: o.allowedResolutions as never,
            surface: session.surface,
            lease: session.lease,
            logger: session.logger,
            redactor: session.redactor,
          });
          return { kind: r.kind, note: r.note, operator: r.operator };
        },
      },
    },
    { runId: session.runId },
  );
  console.log('\n' + summarize(result));
  if (result.status === 'success') console.log(JSON.stringify(result.outputs, null, 2));
  if (result.status === 'business_outcome') console.log(JSON.stringify(result.outcome, null, 2));
  if (result.status === 'failed') console.log(JSON.stringify(result.failure, null, 2));
  console.log('steps:', result.meta.steps.map((s) => `${s.stepId}:${s.status}${s.tier ? `(${s.tier})` : ''}`).join(' '));
  if (result.meta.recoveries.length) console.log('recoveries:', JSON.stringify(result.meta.recoveries));
  console.log('lease transitions:', JSON.stringify(session.lease.transitions().map((t) => `${t.from}->${t.to} (${t.reason})`)));
} finally {
  await session.dispose();
}
