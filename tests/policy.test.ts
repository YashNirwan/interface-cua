/**
 * Guardrails. These tests encode the properties the safety story depends on,
 * so if one of them fails the claim in REPORT.md §6 is no longer true.
 */
import { describe, expect, it } from 'vitest';
import { DefaultPolicyGate } from '../src/policy/gate.js';
import { loadPolicy } from '../src/policy/config.js';
import type { Action, ActionType } from '../src/surface/types.js';
import type { PolicyContext } from '../src/policy/types.js';

const config = loadPolicy();
const gate = new DefaultPolicyGate(config);

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  mode: 'replay',
  approved: false,
  stepsTaken: 0,
  elapsedMs: 0,
  ...over,
});

const nav = (uri: string): Action => ({ type: 'navigate', uri });
const click = (): Action => ({ type: 'click', target: { ref: 'n1' } });

describe('allowlist', () => {
  it('permits an in-scope navigation', () => {
    expect(gate.evaluate(nav('http://127.0.0.1:8099/meridian/search'), ctx()).allow).toBe(true);
  });

  it('denies an origin that is not on the list', () => {
    const d = gate.evaluate(nav('https://example.com/meridian/search'), ctx());
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe('origin_not_allowed');
  });

  it('denies a path outside the permitted routes even on an allowed origin', () => {
    const d = gate.evaluate(nav('http://127.0.0.1:8099/admin/reset'), ctx());
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe('path_not_allowed');
  });

  it('lets a capability NARROW its permissions but never widen them', () => {
    // A capability declaring an origin outside the global list must not gain it.
    const widened = gate.evaluate(nav('https://evil.test/meridian/x'), ctx({ capabilityOrigins: ['https://evil.test'] }));
    expect(widened.allow).toBe(false);

    // Declaring a subset is honoured: an origin the global list allows but the
    // capability does not is denied for that capability.
    const narrowed = gate.evaluate(nav('http://127.0.0.1:8099/meridian/search'), ctx({ capabilityOrigins: ['http://127.0.0.1:9999'] }));
    expect(narrowed.allow).toBe(false);
  });

  it('denies an action verb that is not permitted at all', () => {
    const restricted = new DefaultPolicyGate({ ...config, allowedActions: ['navigate', 'read'] as ActionType[] });
    const d = restricted.evaluate(click(), ctx());
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe('action_not_allowed');
  });
});

describe('risk classification', () => {
  it('treats an irreversible control name as risky', () => {
    expect(gate.classifyRisk('click', 'Post New Sub-Account')).toBe('risky');
    expect(gate.classifyRisk('click', 'Confirm Transfer')).toBe('risky');
    expect(gate.classifyRisk('click', 'Delete Member')).toBe('risky');
  });

  it('treats ordinary read-only controls as safe', () => {
    expect(gate.classifyRisk('click', 'Search')).toBe('safe');
    expect(gate.classifyRisk('click', 'View')).toBe('safe');
    expect(gate.classifyRisk('click', 'Member Search')).toBe('safe');
  });

  it('never classifies navigation or reads as risky', () => {
    expect(gate.classifyRisk('navigate', 'Submit')).toBe('safe');
    expect(gate.classifyRisk('read', 'Post ')).toBe('safe');
    expect(gate.classifyRisk('wait', undefined)).toBe('safe');
  });
});

describe('risky actions by mode', () => {
  it('escalates rather than crashing during discovery', () => {
    const d = gate.evaluate(click(), ctx({ mode: 'discovery' }), 'Post New Sub-Account');
    expect(d.allow).toBe(false);
    // The caller turns this specific code into a human handoff, not an error.
    if (!d.allow) expect(d.code).toBe('risky_action_needs_approval');
  });

  it('blocks a risky step when replaying an UNAPPROVED capability', () => {
    // policy.json sets risky.duringReplayUnapproved = "block", so the denial is
    // the harder `risky_action_blocked`. The executor escalates on either code;
    // the difference is that discovery invites a human to authorise, whereas an
    // unapproved production replay refuses on principle and says why.
    const d = gate.evaluate(click(), ctx({ mode: 'replay', approved: false }), 'Post New Sub-Account');
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe('risky_action_blocked');
  });

  it('allows a risky step once a human has approved the capability, and flags it', () => {
    const d = gate.evaluate(click(), ctx({ mode: 'replay', approved: true }), 'Post New Sub-Account');
    expect(d.allow).toBe(true);
    if (d.allow) {
      expect(d.risk).toBe('risky');
      expect(d.flagged).toBeTruthy();
    }
  });

  it('approval does not launder an off-allowlist navigation', () => {
    // Approval is about irreversibility, not about the boundary. A human
    // saying "yes, post it" must never also mean "yes, leave the app".
    const d = gate.evaluate(nav('https://example.com/'), ctx({ approved: true }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe('origin_not_allowed');
  });
});

describe('budgets', () => {
  it('stops a run that has exhausted its step budget', () => {
    const d = gate.evaluate(click(), ctx({ stepsTaken: config.limits.maxSteps }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe('step_limit');
  });

  it('stops a run that has exceeded its wall-clock budget', () => {
    const d = gate.evaluate(click(), ctx({ elapsedMs: config.limits.maxDurationMs + 1 }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe('duration_limit');
  });
});
