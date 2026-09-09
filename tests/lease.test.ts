/**
 * Control-transfer semantics.
 *
 * The fencing test is the important one: a pause flag cannot give you that
 * property, and without it an in-flight automation action can land in a
 * session a human has already taken over.
 */
import { describe, expect, it } from 'vitest';
import { LeaseViolationError, SessionLease } from '../src/escalation/lease.js';

describe('SessionLease', () => {
  it('starts with automation holding the session', () => {
    const l = new SessionLease('run-1');
    expect(l.holder).toBe('automation');
    expect(l.epoch).toBe(1);
    expect(() => l.assertHolds('automation', 'click')).not.toThrow();
    expect(() => l.assertHolds('human', 'click')).toThrow(LeaseViolationError);
  });

  it('transfers control and locks the previous holder out', () => {
    const l = new SessionLease('run-2');
    l.cedeTo('human', 'checkpoint_failed');
    expect(l.holder).toBe('human');
    expect(l.epoch).toBe(2);
    expect(() => l.assertHolds('automation', 'click')).toThrow(/control violation/);
  });

  it('REJECTS A STALE IN-FLIGHT ACTION after control transfers (fencing)', () => {
    // The scenario: automation captures a guard, awaits a slow click, and the
    // operator takes over while that await is outstanding. When the click
    // finally resolves it must NOT be treated as ours.
    const l = new SessionLease('run-3');
    const guard = l.guard('automation');
    expect(() => l.assertGuardValid(guard, 'click settled')).not.toThrow();

    l.cedeTo('human', 'operator took over mid-action');

    // While the human still holds it, the holder check is what rejects us.
    expect(() => l.assertGuardValid(guard, 'click settled')).toThrow(LeaseViolationError);
    expect(() => l.assertGuardValid(guard, 'click settled')).toThrow(/control violation/);
  });

  it('hands control back and bumps the epoch again', () => {
    const l = new SessionLease('run-4');
    l.cedeTo('human', 'stuck');
    l.handBack('operator resolved: resume');
    expect(l.holder).toBe('automation');
    expect(l.epoch).toBe(3);
    expect(() => l.assertHolds('automation', 'resume')).not.toThrow();
  });

  it('invalidates a guard taken before a full cede/handBack round trip', () => {
    // Control came back to automation, but this guard is still from epoch 1 —
    // the human may have changed the page underneath it.
    const l = new SessionLease('run-5');
    const guard = l.guard('automation');
    l.cedeTo('human', 'stuck');
    l.handBack('resolved');
    expect(() => l.assertGuardValid(guard, 'stale')).toThrow(/stale epoch/);
  });

  it('waitForControl resolves when control arrives', async () => {
    const l = new SessionLease('run-6');
    l.cedeTo('human', 'stuck');
    const waiting = l.waitForControl('automation', 1000);
    l.handBack('operator done');
    await expect(waiting).resolves.toBeUndefined();
  });

  it('waitForControl resolves immediately if already held', async () => {
    const l = new SessionLease('run-7');
    await expect(l.waitForControl('automation', 50)).resolves.toBeUndefined();
  });

  it('waitForControl rejects on timeout so an unattended escalation cannot hang a run', async () => {
    const l = new SessionLease('run-8');
    l.cedeTo('human', 'stuck');
    await expect(l.waitForControl('automation', 60)).rejects.toThrow(/timed out/);
  });

  it('records a full audit trail of who held the session and why', () => {
    const l = new SessionLease('run-9');
    l.cedeTo('human', 'risky_action_blocked');
    l.handBack('operator approved');
    const t = l.transitions();
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ from: 'automation', to: 'human', reason: 'risky_action_blocked', epoch: 2 });
    expect(t[1]).toMatchObject({ from: 'human', to: 'automation', reason: 'operator approved', epoch: 3 });
    expect(new Date(t[0]!.at).toString()).not.toBe('Invalid Date');
  });

  it('refuses to hand out a guard to a party that does not hold the session', () => {
    const l = new SessionLease('run-10');
    expect(() => l.guard('human')).toThrow(LeaseViolationError);
  });
});
