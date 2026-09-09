import { describe, expect, it } from 'vitest';
import { parseCapability, parseOverlay, type Capability, type Overlay } from '../src/artifact/schema.js';
import { OverlayError, applyOverlay, satisfiesRange } from '../src/replay/overlay.js';

// ---------------------------------------------------------------------------
// One vendor product, three steps. Riverbend renames a button, skips the
// dual-approval prompt it does not have, and lives on a different host.
// ---------------------------------------------------------------------------

function baseCapability(): Capability {
  return parseCapability({
    schemaVersion: 'cua.capability/v1',
    id: 'meridian.member.balance',
    version: '1.4.2',
    status: 'approved',
    summary: 'Read a member’s available balance.',
    description: 'Looks a member up in Meridian Core and returns the available balance.',
    app: { vendor: 'Meridian', product: 'Core', versionRange: '1.x', surface: 'legacy-web' },
    entry: { uri: 'https://core.meridian.example/meridian/signon' },
    inputs: { memberId: { type: 'string', description: 'member number', pattern: '\\d{6}', sensitivity: 'identifier' } },
    outputs: [
      {
        name: 'availableBalance',
        type: 'money',
        description: 'available balance',
        from: { labeledValue: { label: 'Available Balance' } },
        sensitivity: 'financial',
      },
    ],
    steps: [
      {
        id: 'enter-id',
        intent: 'Type the member number into the lookup box',
        action: { type: 'type', target: { role: 'textbox', name: 'Member ID', section: 'Member Lookup' }, text: '{{memberId}}' },
        checkpoint: { textPresent: 'Member Lookup' },
        timeoutMs: 10_000,
      },
      {
        id: 'search',
        intent: 'Run the lookup',
        action: { type: 'click', target: { role: 'button', name: 'Search', section: 'Member Lookup', ordinal: 0 } },
        checkpoint: { textPresent: 'Account Summary' },
        recordedTier: 'exact-name-in-section',
      },
      {
        id: 'dual-approval',
        intent: 'Acknowledge the dual-approval prompt',
        action: { type: 'click', target: { role: 'button', name: 'Acknowledge' } },
      },
    ],
    success: { textPresent: 'Available Balance' },
    recoveries: [
      {
        name: 'dismiss-system-notice',
        description: 'Dismiss the System Notice interstitial',
        detect: { textPresent: 'System Notice' },
        do: [{ type: 'click', target: { role: 'button', name: 'Continue' } }],
      },
    ],
    provenance: {
      recordedAt: '2026-09-01T12:00:00.000Z',
      recordedBy: { kind: 'llm-discovery', model: 'claude-opus-5' },
      runId: 'run-1',
      goal: 'read a balance',
    },
  });
}

function overlay(over: Partial<Overlay> = {}): Overlay {
  return parseOverlay({
    schemaVersion: 'cua.overlay/v1',
    tenantId: 'cu-riverbend',
    overlayFor: { capabilityId: 'meridian.member.balance', versionRange: '^1.2.0' },
    entryUri: 'https://riverbend.meridianhosted.example/meridian/signon',
    steps: {
      search: { target: { name: 'Find Member' } },
      'dual-approval': { skip: true },
    },
    extraRecoveries: [
      {
        name: 'dismiss-sso-notice',
        description: 'Riverbend shows an SSO banner after sign-on',
        detect: { textPresent: 'Single Sign-On' },
        do: [{ type: 'click', target: { role: 'button', name: 'Proceed' } }],
        maxPerRun: 1,
      },
    ],
    ...over,
  });
}

// ---------------------------------------------------------------------------

describe('satisfiesRange', () => {
  it('accepts the wildcard', () => {
    expect(satisfiesRange('1.4.2', '*')).toBe(true);
    expect(satisfiesRange('9.0.0', '')).toBe(true);
  });

  it('handles x-ranges', () => {
    expect(satisfiesRange('1.4.2', '1.x')).toBe(true);
    expect(satisfiesRange('2.0.0', '1.x')).toBe(false);
    expect(satisfiesRange('1.4.9', '1.4.x')).toBe(true);
    expect(satisfiesRange('1.5.0', '1.4.x')).toBe(false);
  });

  it('handles caret ranges, including the pre-1.0 rule', () => {
    expect(satisfiesRange('1.4.2', '^1.2.0')).toBe(true);
    expect(satisfiesRange('1.1.0', '^1.2.0')).toBe(false);
    expect(satisfiesRange('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false);
  });

  it('handles tildes, comparators, conjunctions and exact versions', () => {
    expect(satisfiesRange('1.4.9', '~1.4.2')).toBe(true);
    expect(satisfiesRange('1.5.0', '~1.4.2')).toBe(false);
    expect(satisfiesRange('1.4.2', '>=1.0.0')).toBe(true);
    expect(satisfiesRange('1.4.2', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesRange('2.1.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfiesRange('1.4.2', '1.4.2')).toBe(true);
    expect(satisfiesRange('1.4.3', '1.4.2')).toBe(false);
  });

  it('throws on a clause it cannot interpret rather than defaulting to true', () => {
    // Reading an unknown range as "applies to everything" is the direction that
    // silently applies a v1 overlay to a v3 capability.
    expect(() => satisfiesRange('1.4.2', '^1.2.0 || ^2.0.0')).toThrow(OverlayError);
    expect(() => satisfiesRange('1.4.2', '1.2.3-beta.1')).toThrow(OverlayError);
  });
});

describe('applyOverlay', () => {
  it('replaces the entry uri', () => {
    const result = applyOverlay(baseCapability(), overlay());
    expect(result.entry.uri).toBe('https://riverbend.meridianhosted.example/meridian/signon');
  });

  it('merges the target descriptor field by field', () => {
    const result = applyOverlay(baseCapability(), overlay());
    const search = result.steps.find((s) => s.id === 'search');
    expect(search).toBeDefined();
    if (search === undefined || search.action.type !== 'click') return expect.unreachable();

    // The overlay changed only `name`; the disambiguators survive, which is
    // what keeps overlays small instead of becoming forks.
    expect(search.action.target.name).toBe('Find Member');
    expect(search.action.target.section).toBe('Member Lookup');
    expect(search.action.target.role).toBe('button');
    expect(search.action.target.ordinal).toBe(0);
    expect(search.recordedTier).toBe('exact-name-in-section');
  });

  it('drops a step marked skip', () => {
    const result = applyOverlay(baseCapability(), overlay());
    expect(result.steps.map((s) => s.id)).toEqual(['enter-id', 'search']);
  });

  it('patches text and timeoutMs', () => {
    const result = applyOverlay(
      baseCapability(),
      overlay({ steps: { 'enter-id': { text: '{{memberId}} ', timeoutMs: 45_000 } } }),
    );
    const step = result.steps.find((s) => s.id === 'enter-id');
    if (step === undefined || step.action.type !== 'type') return expect.unreachable();
    expect(step.action.text).toBe('{{memberId}} ');
    expect(step.timeoutMs).toBe(45_000);
  });

  it('appends extra recoveries without disturbing the base ones', () => {
    const result = applyOverlay(baseCapability(), overlay());
    expect(result.recoveries.map((r) => r.name)).toEqual(['dismiss-system-notice', 'dismiss-sso-notice']);
  });

  it('sets tenantId and provenance.basedOn', () => {
    const result = applyOverlay(baseCapability(), overlay());
    expect(result.tenantId).toBe('cu-riverbend');
    expect(result.provenance.basedOn).toEqual({ capabilityId: 'meridian.member.balance', version: '1.4.2' });
  });

  it('does not mutate the base — it is shared across every tenant in memory', () => {
    const base = baseCapability();
    const before = JSON.stringify(base);

    const result = applyOverlay(base, overlay());
    result.steps[0]!.intent = 'mutated by a caller';
    result.recoveries.push({ ...result.recoveries[0]!, name: 'injected' });

    expect(JSON.stringify(base)).toBe(before);
    expect(base.steps).toHaveLength(3);
    expect(base.tenantId).toBeNull();
    const baseSearch = base.steps.find((s) => s.id === 'search');
    if (baseSearch === undefined || baseSearch.action.type !== 'click') return expect.unreachable();
    expect(baseSearch.action.target.name).toBe('Search');
  });

  it('rejects an overlay aimed at a different capability', () => {
    expect(() =>
      applyOverlay(baseCapability(), overlay({ overlayFor: { capabilityId: 'meridian.member.address', versionRange: '*' } })),
    ).toThrow(/targets capability 'meridian.member.address'/);
  });

  it('rejects a version-range mismatch', () => {
    expect(() =>
      applyOverlay(baseCapability(), overlay({ overlayFor: { capabilityId: 'meridian.member.balance', versionRange: '^2.0.0' } })),
    ).toThrow(OverlayError);
    expect(() =>
      applyOverlay(baseCapability(), overlay({ overlayFor: { capabilityId: 'meridian.member.balance', versionRange: '^2.0.0' } })),
    ).toThrow(/does not satisfy/);
  });

  it('rejects a patch aimed at a step that no longer exists', () => {
    // Otherwise the tenant believes their rename is live and replay quietly
    // uses the base name.
    expect(() => applyOverlay(baseCapability(), overlay({ steps: { 'enter-pin': { text: 'x' } } }))).toThrow(
      /patches unknown step\(s\) \[enter-pin\]/,
    );
  });

  it('rejects patching the target of an action that has none', () => {
    const base = baseCapability();
    base.steps.push({ ...base.steps[1]!, id: 'pause', action: { type: 'wait', ms: 500 } });
    expect(() => applyOverlay(base, overlay({ steps: { pause: { target: { name: 'nope' } } } }))).toThrow(/has none/);
  });

  it('refuses to skip a step an outcome is scoped to', () => {
    const base = baseCapability();
    base.outcomes.push({
      code: 'no_such_member',
      description: 'The member number does not exist.',
      detect: { textPresent: 'No matching member' },
      afterStep: 'dual-approval',
      extract: [],
    });
    // Silently un-declaring a business outcome for one tenant would turn
    // "no such member" back into a checkpoint failure for that tenant only.
    expect(() => applyOverlay(base, overlay())).toThrow(/outcome 'no_such_member' is scoped to it/);
  });

  it('re-validates the result, so a bad override fails at onboarding and not at 3am', () => {
    // Every clause here is individually legal; together they produce a
    // capability with zero steps, which the schema forbids. Without the
    // re-parse this would ship as a capability that "succeeds" without doing
    // anything, for one tenant.
    const skipEverything = overlay({
      steps: { 'enter-id': { skip: true }, search: { skip: true }, 'dual-approval': { skip: true } },
    });
    expect(() => applyOverlay(baseCapability(), skipEverything)).toThrow(OverlayError);
    expect(() => applyOverlay(baseCapability(), skipEverything)).toThrow(/produced an invalid capability/);
  });
});
