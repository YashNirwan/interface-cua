/**
 * Regression guard for a real leak: the discovery run's result was written to
 * evidence with raw parameter values still attached, putting the operator's
 * password on disk. The redactor could not catch it — a credential sitting
 * under a field called `value` looks like any other string — so the fix is
 * structural, at the boundary that knows the type.
 */
import { describe, expect, it } from 'vitest';
import { toEvidence, type DiscoveryResult } from '../src/agent/discover.js';

const run = {
  status: 'success',
  runId: 'r1',
  goal: 'g',
  steps: [],
  outputs: [],
  entryUri: 'http://127.0.0.1:8099/meridian/login',
  params: [
    { name: 'memberId', value: '100482', type: 'string', description: '', sensitivity: 'identifier' },
    { name: 'operatorPassword', value: 'Passw0rd!demo', type: 'string', description: '', sensitivity: 'secret', secretKey: 'MERIDIAN_PASSWORD' },
  ],
  model: 'm',
  provider: 'p',
  llmCalls: 1,
  transcriptDigest: 'd',
  observedInterruptions: [],
} as unknown as DiscoveryResult;

describe('evidence safety', () => {
  it('never writes a parameter value to evidence', () => {
    const serialized = JSON.stringify(toEvidence(run));
    expect(serialized).not.toContain('Passw0rd!demo');
    expect(serialized).not.toContain('100482');
  });

  it('still records that the parameters existed, and their classification', () => {
    const e = toEvidence(run);
    expect(e.params).toHaveLength(2);
    expect(e.params[1]).toMatchObject({ name: 'operatorPassword', sensitivity: 'secret', fromSecretStore: true });
  });
});
