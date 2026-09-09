import { describe, expect, it } from 'vitest';
import { parseCapability, type Capability } from '../src/artifact/schema.js';
import type { EvidenceEventType, RunLogger } from '../src/evidence/types.js';
import { SessionLease } from '../src/escalation/lease.js';
import { PolicyViolationError, type PolicyDecision, type PolicyGate, type Redactor } from '../src/policy/types.js';
import type { Action, ActResult, Observation, Resolution, Surface, TargetDescriptor, UiNode } from '../src/surface/types.js';
import { BUILT_IN_CONDITIONS, replay, verifyStability, type ReplayDeps } from '../src/replay/executor.js';

function node(p: Partial<UiNode> & Pick<UiNode, 'ref' | 'role' | 'name'>): UiNode {
  return { framePath: [], ordinal: 0, ...p };
}

interface Screen {
  uri: string;
  title: string;
  canonicalPath?: string;
  text: string;
  nodes: UiNode[];
}

const LOOKUP: Screen = {
  uri: 'https://core.meridian.example/meridian/lookup',
  title: 'Member Lookup',
  canonicalPath: '/meridian/lookup',
  text: 'Meridian Core\nMember Lookup',
  nodes: [node({ ref: 'a', role: 'textbox', name: 'Member ID', section: 'Member Lookup' }), node({ ref: 'b', role: 'button', name: 'Search', section: 'Member Lookup' })],
};

const PROFILE: Screen = {
  uri: 'https://core.meridian.example/meridian/member/100482',
  title: 'Member Profile',
  canonicalPath: '/meridian/member/:id',
  text: 'Member 100482 — Profile\nAccount Summary\nAvailable Balance:  $4,812.55',
  nodes: [
    node({ ref: 'h', role: 'heading', name: 'Member 100482 — Profile' }),
    node({ ref: 'c1', role: 'cell', name: 'Available Balance:', section: 'Account Summary', ordinal: 0 }),
    node({ ref: 'c2', role: 'cell', name: '$4,812.55', section: 'Account Summary', ordinal: 1 }),
  ],
};

const NO_MEMBER: Screen = { ...LOOKUP, text: 'Meridian Core\nMember Lookup\nNo matching member was found for 100482.' };
const NOTICE: Screen = { ...LOOKUP, title: 'System Notice', text: 'System Notice\nScheduled maintenance tonight.', nodes: [...LOOKUP.nodes, node({ ref: 'ok', role: 'button', name: 'Continue' })] };
const EXPIRED: Screen = { ...LOOKUP, title: 'Sign On', text: 'Your session has expired. Please sign on again.' };
const STUCK: Screen = { ...LOOKUP, text: 'Meridian Core\nMember Lookup\nnothing useful here' };

class FakeSurface implements Surface {
  readonly kind = 'legacy-web' as const;
  actions: string[] = [];
  disposed = false;
  constructor(private script: Screen[]) {}
  private cur(): Screen {
    return this.script[Math.min(this.observeCount, this.script.length - 1)] ?? LOOKUP;
  }
  private observeCount = 0;
  async observe(): Promise<Observation> {
    const s = this.cur();
    this.observeCount = Math.min(this.observeCount + 0, this.script.length - 1);
    return { surfaceKind: this.kind, location: { uri: s.uri, title: s.title, canonicalPath: s.canonicalPath }, nodes: s.nodes, text: s.text, capturedAt: new Date().toISOString() };
  }
  async act(a: Action): Promise<ActResult> {
    this.actions.push(a.type === 'click' || a.type === 'type' ? `${a.type}:${'descriptor' in a.target ? a.target.descriptor.name : '?'}` : a.type);
    if (this.observeCount < this.script.length - 1) this.observeCount += 1;
    return { ok: true, tier: 'exact-name-in-section' };
  }
  async resolve(d: TargetDescriptor): Promise<Resolution> {
    const m = this.cur().nodes.filter((n) => n.role === d.role && n.name === d.name);
    if (m.length === 1) return { ok: true, node: m[0]!, tier: 'exact-name-in-section', candidates: 1 };
    if (m.length > 1) return { ok: false, reason: 'ambiguous', tier: 'exact-name-in-section', candidates: m.length, sample: m.map((n) => n.name) };
    return { ok: false, reason: 'not-found', tried: ['exact-name-in-section'] };
  }
  async capture(): Promise<{ screenshot?: Buffer; snapshot?: string }> {
    return { snapshot: '<snapshot/>' };
  }
  humanControl = { available: true, expose: async () => ({ how: 'noop', detail: '' }), startRecording: async () => undefined, stopRecording: async () => undefined };
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

const gate: PolicyGate = {
  config: {} as PolicyGate['config'],
  evaluate: (a: Action, ctx): PolicyDecision => {
    const name = 'target' in a && 'descriptor' in a.target ? a.target.descriptor.name : '';
    if (/post|transfer/i.test(name)) {
      return ctx.approved ? { allow: true, risk: 'risky', flagged: name } : { allow: false, risk: 'risky', code: 'risky_action_needs_approval', reason: `'${name}' is risky` };
    }
    if (a.type === 'navigate' && !a.uri.startsWith('https://core.meridian.example')) {
      return { allow: false, risk: 'safe', code: 'origin_not_allowed', reason: `${a.uri} is outside the allowlist` };
    }
    return { allow: true, risk: 'safe' };
  },
  classifyRisk: () => 'safe',
};

const redactor: Redactor = { text: (s) => s, value: (v, s) => (s === 'public' ? v : `[${s}]`), shape: (v) => `${String(v).length} chars`, object: (o) => o };

function makeLogger(): RunLogger & { types: EvidenceEventType[] } {
  const types: EvidenceEventType[] = [];
  return {
    runId: 'run-test',
    dir: '/evidence/run-test',
    logFile: '/evidence/run-test/log.jsonl',
    types,
    emit: (t) => void types.push(t),
    saveCapture: async (name) => ({ snapshot: `/evidence/run-test/${name}.txt` }),
    finish: async () => undefined,
    events: () => [],
  };
}

function deps(surface: Surface, over: Partial<ReplayDeps> = {}): ReplayDeps {
  return { surface, gate, lease: new SessionLease('s1'), logger: makeLogger(), redactor, ...over };
}

function cap(over: Record<string, unknown> = {}): Capability {
  return parseCapability({
    schemaVersion: 'cua.capability/v1',
    id: 'meridian.member.balance',
    version: '1.0.0',
    status: 'approved',
    summary: 'Read a balance.',
    description: 'Read a balance.',
    app: { vendor: 'Meridian', product: 'Core', surface: 'legacy-web' },
    entry: { uri: 'https://core.meridian.example/meridian/lookup' },
    inputs: { memberId: { type: 'string', description: 'member number', pattern: '\\d{6}', sensitivity: 'identifier' } },
    outputs: [{ name: 'availableBalance', type: 'money', description: 'balance', from: { labeledValue: { label: 'Available Balance' } }, sensitivity: 'financial' }],
    steps: [
      { id: 'enter-id', intent: 'Type the member number', action: { type: 'type', target: { role: 'textbox', name: 'Member ID' }, text: '{{memberId}}' } },
      { id: 'search', intent: 'Run the lookup', action: { type: 'click', target: { role: 'button', name: 'Search' } }, checkpoint: { textPresent: 'Account Summary' }, retries: 1, recordedTier: 'exact-name-in-section' },
    ],
    success: { all: [{ textPresent: 'Account Summary' }, { uriMatches: '/meridian/member/:id' }] },
    outcomes: [{ code: 'no_such_member', description: 'The member number does not exist.', detect: { textPresent: 'No matching member was found' }, afterStep: 'search' }],
    provenance: { recordedAt: '2026-09-01T12:00:00.000Z', recordedBy: { kind: 'llm-discovery' }, runId: 'r', goal: 'g' },
    ...over,
  });
}

describe('replay', () => {
  it('happy path returns typed outputs', async () => {
    const s = new FakeSurface([LOOKUP, LOOKUP, LOOKUP, PROFILE]);
    const r = await replay(cap(), { memberId: '100482' }, deps(s));
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs['availableBalance']).toBe(4812.55);
    expect(r.meta.steps.map((x) => x.status)).toEqual(['ok', 'ok']);
    expect(r.meta.driftDetected).toBe(false);
  });

  it('rejects bad input before touching the surface', async () => {
    const s = new FakeSurface([LOOKUP]);
    const r = await replay(cap(), { memberId: 'abc' }, deps(s));
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('invalid_input');
    expect(s.actions).toEqual([]);
  });

  it('reports a declared business outcome instead of a checkpoint failure', async () => {
    const s = new FakeSurface([LOOKUP, LOOKUP, LOOKUP, NO_MEMBER]);
    const r = await replay(cap(), { memberId: '100482' }, deps(s));
    expect(r.status).toBe('business_outcome');
    if (r.status !== 'business_outcome') return;
    expect(r.outcome.code).toBe('no_such_member');
  });

  it('checkpoint failure carries expected and observed', async () => {
    const s = new FakeSurface([LOOKUP, LOOKUP, LOOKUP, STUCK]);
    const r = await replay(cap(), { memberId: '100482' }, deps(s));
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('checkpoint_failed');
    expect(r.failure.stepId).toBe('search');
    expect(r.failure.expected).toContain('Account Summary');
    expect(r.failure.observed).toContain('nothing useful here');
    expect(r.meta.evidence.snapshot).toContain('failure-checkpoint_failed');
  });

  it('built-in conditions upgrade a generic failure to session_expired', async () => {
    const s = new FakeSurface([LOOKUP, LOOKUP, LOOKUP, EXPIRED]);
    const r = await replay(cap(), { memberId: '100482' }, deps(s));
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('session_expired');
    expect(r.failure.retryable).toBe(true);
    expect(r.failure.message).toContain('session-expired');
  });

  it('runs a bounded recovery and then reports the run', async () => {
    const c = cap({ recoveries: [{ name: 'dismiss-notice', description: 'Dismiss the System Notice', detect: { textPresent: 'System Notice' }, do: [{ type: 'click', target: { role: 'button', name: 'Continue' } }], maxPerRun: 2, retryStep: false }] });
    const s = new FakeSurface([LOOKUP, NOTICE, LOOKUP, LOOKUP, PROFILE]);
    const r = await replay(c, { memberId: '100482' }, deps(s));
    expect(r.status).toBe('success');
    expect(r.meta.recoveries[0]?.name).toBe('dismiss-notice');
  });

  it('stops when a recovery budget is exhausted rather than looping', async () => {
    const c = cap({ recoveries: [{ name: 'dismiss-notice', description: 'Dismiss the System Notice', detect: { textPresent: 'System Notice' }, do: [{ type: 'click', target: { role: 'button', name: 'Continue' } }], maxPerRun: 1, retryStep: true }] });
    const s = new FakeSurface([NOTICE, NOTICE, NOTICE, NOTICE, NOTICE]);
    const r = await replay(c, { memberId: '100482' }, deps(s));
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.message).toContain('exhausted its budget');
  });

  it('an origin denial is a hard policy_violation and is never escalated', async () => {
    let escalated = false;
    const c = cap({ entry: { uri: 'https://evil.example/steal' } });
    const s = new FakeSurface([LOOKUP]);
    const r = await replay(c, { memberId: '100482' }, deps(s, { escalation: { escalate: async () => { escalated = true; return { kind: 'approve', operator: 'op' }; } } }));
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('policy_violation');
    expect(escalated).toBe(false);
  });

  it('a risky step escalates, and approve retries the action once', async () => {
    const c = cap({
      status: 'draft',
      policy: { containsRiskyActions: true },
      outcomes: [],
      steps: [
        { id: 'enter-id', intent: 'Type the member number', action: { type: 'type', target: { role: 'textbox', name: 'Member ID' }, text: '{{memberId}}' } },
        { id: 'post', intent: 'Post the transaction', risk: 'risky', action: { type: 'click', target: { role: 'button', name: 'Post Transaction' } }, checkpoint: { textPresent: 'Account Summary' }, retries: 0 },
      ],
    });
    const POST: Screen = { ...LOOKUP, nodes: [...LOOKUP.nodes, node({ ref: 'p', role: 'button', name: 'Post Transaction' })] };
    const s = new FakeSurface([POST, POST, POST, PROFILE]);
    const calls: string[] = [];
    const r = await replay(c, { memberId: '100482' }, deps(s, {
      escalation: { escalate: async (o) => { calls.push(o.reason); return { kind: 'approve', operator: 'ops@bank' }; } },
    }));
    expect(calls).toEqual(['risky_action_blocked']);
    expect(r.status).toBe('success');
  });

  it('abort at a risky step returns escalated with the intervention id', async () => {
    const c = cap({
      status: 'draft',
      policy: { containsRiskyActions: true },
      steps: [{ id: 'post', intent: 'Post', risk: 'risky', action: { type: 'click', target: { role: 'button', name: 'Post Transaction' } } }],
      success: { textPresent: 'Account Summary' },
      outcomes: [],
    });
    const POST: Screen = { ...LOOKUP, nodes: [...LOOKUP.nodes, node({ ref: 'p', role: 'button', name: 'Post Transaction' })] };
    const s = new FakeSurface([POST]);
    const d = deps(s, { escalation: { escalate: async () => ({ kind: 'abort', operator: 'ops@bank' }) } });
    const r = await replay(c, { memberId: '100482' }, d);
    expect(r.status).toBe('escalated');
    if (r.status !== 'escalated') return;
    expect(r.intervention.resolution).toBe('abort');
    expect(r.intervention.id).toContain('int-1');
    expect(d.lease.holder).toBe('automation');
  });

  it('extraction failure at the right screen is a failure, not success-with-nulls', async () => {
    const c = cap({ outputs: [{ name: 'escheatDate', type: 'date', description: 'x', from: { labeledValue: { label: 'Escheatment Date' } } }] });
    const s = new FakeSurface([LOOKUP, LOOKUP, LOOKUP, PROFILE]);
    const r = await replay(c, { memberId: '100482' }, deps(s));
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('extraction_failed');
  });

  it('detects tier degradation as drift on a passing run', async () => {
    const c = cap({
      steps: [
        { id: 'enter-id', intent: 'Type', action: { type: 'type', target: { role: 'textbox', name: 'Member ID' }, text: '{{memberId}}' }, recordedTier: 'exact-name-in-section' },
        { id: 'search', intent: 'Search', action: { type: 'click', target: { role: 'button', name: 'Search' } }, checkpoint: { textPresent: 'Account Summary' }, recordedTier: 'exact-name-in-section' },
      ],
    });
    const s = new FakeSurface([LOOKUP, LOOKUP, LOOKUP, PROFILE]);
    const realAct = s.act.bind(s);
    s.act = async (a: Action): Promise<ActResult> => { await realAct(a); return { ok: true, tier: 'ordinal' }; };
    const r = await replay(c, { memberId: '100482' }, deps(s));
    expect(r.meta.driftDetected).toBe(true);
    expect(r.meta.steps.every((x) => x.tierDegraded === true)).toBe(true);
  });

  it('BUILT_IN_CONDITIONS is an inspectable table', () => {
    expect(BUILT_IN_CONDITIONS.map((c) => c.failureClass)).toEqual(['session_expired', 'permission_denied', 'surface_error']);
  });
});

describe('verifyStability', () => {
  it('scores a repeatable business outcome as stable, not flaky', async () => {
    const report = await verifyStability(cap(), { memberId: '100482' }, async () => deps(new FakeSurface([LOOKUP, LOOKUP, LOOKUP, NO_MEMBER])), 4);
    expect(report.runs).toBe(4);
    expect(report.successes).toBe(0);
    expect(report.outcomes['no_such_member']).toBe(4);
    expect(report.flakeRate).toBe(0);
  });

  it('reports disagreement between runs as flake', async () => {
    const scripts = [[LOOKUP, LOOKUP, LOOKUP, PROFILE], [LOOKUP, LOOKUP, LOOKUP, PROFILE], [LOOKUP, LOOKUP, LOOKUP, PROFILE], [LOOKUP, LOOKUP, LOOKUP, NO_MEMBER]];
    let i = 0;
    const report = await verifyStability(cap(), { memberId: '100482' }, async () => deps(new FakeSurface(scripts[i++]!)), 4);
    expect(report.successes).toBe(3);
    expect(report.flakeRate).toBe(0.25);
  });
});
