/** Self-contained, model-free integration demo using the discovered artifact. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCapability } from '../src/artifact/schema.js';
import { DEFAULT_POLICY_PATH } from '../src/policy/config.js';
import { replay } from '../src/replay/executor.js';
import { summarize, type ReplayResult } from '../src/replay/result.js';
import { createSession, envSecrets, newRunId } from '../src/runtime.js';

// This process drives only its own synthetic app, with public demo credentials.
process.env.MERIDIAN_USER = 'demo.operator';
process.env.MERIDIAN_PASSWORD = 'Passw0rd!demo';
const { startMeridian } = await import('../apps/meridian/server.js');
const app = await startMeridian(0);
try {
  const origin = new URL(app.url).origin;
  process.env.CUA_ALLOWED_ORIGINS = origin;
  const cap = parseCapability(JSON.parse(readFileSync(
    new URL('../capabilities/meridian.member.savings-balance@1.2.0.json', import.meta.url), 'utf8',
  )));
  // Bind only the entry and allowlist to our private app's ephemeral port.
  cap.entry.uri = `${app.url}/login`;
  cap.policy.allowedOrigins = [origin];
  const evidenceDir = fileURLToPath(new URL(`../evidence/_scratch/${newRunId('demo')}/`, import.meta.url));
  const cases: Array<{ label: string; memberId: string; check: (r: ReplayResult) => void; serverError?: boolean }> = [
    { label: 'original member', memberId: '100482', check: (r) => {
      assert.equal(r.status, 'success');
      if (r.status === 'success') assert.deepEqual(r.outputs, {
        savingsAccountNumber: 'SAV-0100482-01', savingsCurrentBalance: 4812.55, savingsStatus: 'Active',
      });
    } },
    { label: 'different member', memberId: '100517', check: (r) => {
      assert.equal(r.status, 'success');
      if (r.status === 'success') assert.deepEqual(r.outputs, {
        savingsAccountNumber: 'SAV-0100517-01', savingsCurrentBalance: 132.4, savingsStatus: 'Active',
      });
    } },
    { label: 'missing member', memberId: '999999', check: (r) => {
      assert.equal(r.status, 'business_outcome');
      if (r.status === 'business_outcome') assert.equal(r.outcome.code, 'MEMBER_NOT_FOUND');
    } },
    { label: 'restricted member', memberId: '100999', check: (r) => {
      assert.equal(r.status, 'business_outcome');
      if (r.status === 'business_outcome') assert.equal(r.outcome.code, 'MEMBER_RESTRICTED');
    } },
    { label: 'invalid input', memberId: '12345', check: (r) => {
      assert.equal(r.status, 'failed');
      if (r.status === 'failed') assert.equal(r.failure.class, 'invalid_input');
      assert.equal(r.meta.steps.length, 0);
    } },
    { label: 'injected server error', memberId: '100482', serverError: true, check: (r) => {
      assert.equal(r.status, 'failed');
      if (r.status === 'failed') assert.equal(r.failure.class, 'surface_error');
    } },
  ];

  for (const scenario of cases) {
    if (scenario.serverError) {
      const response = await fetch(`${app.url}/_faults`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-fault-session': '*' },
        body: JSON.stringify({ error500: true, afterRequests: 3 }),
      });
      assert.equal(response.ok, true, 'fault injection failed');
    }
    const session = await createSession({
      mode: 'replay', approved: true, headless: true, evidenceDir,
      policyPath: DEFAULT_POLICY_PATH, capabilityOrigins: [origin],
      secretKeys: ['MERIDIAN_USER', 'MERIDIAN_PASSWORD'],
    });
    try {
      const result = await replay(cap, { memberId: scenario.memberId }, {
        surface: session.surface, gate: session.gate, lease: session.lease,
        logger: session.logger, redactor: session.redactor, secrets: envSecrets,
      });
      scenario.check(result);
      console.log(`PASS ${scenario.label}: ${summarize(result)}`);
    } finally {
      await session.dispose();
    }
  }
  console.log(`\nAll ${cases.length} browser scenarios passed. Evidence: ${evidenceDir}`);
} finally {
  await app.close();
}
