import { describe, expect, it } from 'vitest';
import { parseCapability, type Capability } from '../src/artifact/schema.js';
import type { Redactor } from '../src/policy/types.js';
import {
  UnboundPlaceholderError,
  bindCondition,
  bindDescriptor,
  bindTemplate,
  describeBoundParams,
  validateInputs,
} from '../src/replay/params.js';

// ---------------------------------------------------------------------------
// A capability that exercises every input path: a patterned identifier, an
// enum with a default, an optional field, and a credential from the store.
// Built through the real parser so zod defaults are exactly what replay sees.
// ---------------------------------------------------------------------------

const CAP: Capability = parseCapability({
  schemaVersion: 'cua.capability/v1',
  id: 'meridian.member.balance',
  version: '1.4.2',
  summary: 'Read a member’s available balance.',
  description: 'Signs on to Meridian Core, looks up a member, returns the available balance.',
  app: { vendor: 'Meridian', product: 'Core', surface: 'legacy-web' },
  entry: { uri: 'https://core.meridian.example/meridian/member/{{memberId}}' },
  inputs: {
    memberId: { type: 'string', description: 'six-digit member number', pattern: '\\d{6}', sensitivity: 'identifier', example: '100482' },
    channel: { type: 'enum', description: 'origination channel', enum: ['web', 'branch'], default: 'web', required: false },
    note: { type: 'string', description: 'free-text note', required: false },
    opsPassword: { type: 'string', description: 'operator password', sensitivity: 'secret', source: 'secret-store', secretKey: 'meridian/ops' },
  },
  steps: [
    {
      id: 'sign-on',
      intent: 'Sign on as the operations user',
      action: { type: 'type', target: { role: 'textbox', name: 'Password' }, text: '{{opsPassword}}' },
    },
  ],
  success: { textPresent: 'Available Balance' },
  provenance: {
    recordedAt: '2026-09-01T12:00:00.000Z',
    recordedBy: { kind: 'llm-discovery' },
    runId: 'run-1',
    goal: 'read a balance',
  },
});

const SECRETS = (key: string): string | undefined => (key === 'meridian/ops' ? 'hunter2-correct-horse' : undefined);
const NO_SECRETS = (): undefined => undefined;

const redactor: Redactor = {
  text: (s) => s,
  value: (v, sensitivity) => (sensitivity === 'public' ? v : `[${sensitivity}]`),
  shape: (v) => (typeof v === 'string' ? `${v.length} chars` : typeof v),
  object: (o) => o,
};

// ---------------------------------------------------------------------------

describe('validateInputs', () => {
  it('accepts a valid invocation and applies declared defaults', () => {
    const r = validateInputs(CAP, { memberId: '100482' }, SECRETS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bound['memberId']).toBe('100482');
    expect(r.bound['channel']).toBe('web');
    // An optional param with no default is simply not bound.
    expect(r.bound['note']).toBeUndefined();
  });

  it('reports a missing required param by name and description', () => {
    const r = validateInputs(CAP, {}, SECRETS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes("missing required input 'memberId'"))).toBe(true);
    expect(r.errors.some((e) => e.includes('six-digit member number'))).toBe(true);
  });

  it('rejects a value that fails the declared pattern', () => {
    const r = validateInputs(CAP, { memberId: '12345' }, SECRETS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('does not match required pattern');
  });

  it('anchors the pattern, so a partial match is not accepted', () => {
    // Unanchored, /\d{6}/ would happily match inside '1234567' or
    // '../../etc/passwd?x=100482'. Anchoring is what makes the pattern a
    // control rather than documentation.
    expect(validateInputs(CAP, { memberId: '1234567' }, SECRETS).ok).toBe(false);
    expect(validateInputs(CAP, { memberId: '../../etc/passwd?x=100482' }, SECRETS).ok).toBe(false);
    expect(validateInputs(CAP, { memberId: '100482' }, SECRETS).ok).toBe(true);
  });

  it('rejects a value outside the declared enum', () => {
    const r = validateInputs(CAP, { memberId: '100482', channel: 'carrier-pigeon' }, SECRETS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('must be one of [web, branch]');
  });

  it('coerces numbers and booleans into the string form templates need', () => {
    const r = validateInputs(CAP, { memberId: 100482 }, SECRETS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bound['memberId']).toBe('100482');
  });

  it('fails closed on an unknown parameter', () => {
    // A permissive reading would swallow `memberID` (wrong case) as a typo and
    // then fail three screens later with something unrecognisable.
    const r = validateInputs(CAP, { memberId: '100482', memberID: '100482' }, SECRETS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("unknown parameter 'memberID'");
  });

  it('never accepts a secret-store param from the caller', () => {
    const r = validateInputs(CAP, { memberId: '100482', opsPassword: 'anything-at-all' }, SECRETS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('must not be supplied by the caller');
    expect(r.errors[0]).toContain('credential injection');
  });

  it('resolves a secret-store param from the store', () => {
    const r = validateInputs(CAP, { memberId: '100482' }, SECRETS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bound['opsPassword']).toBe('hunter2-correct-horse');
  });

  it('reports a secret that is missing from the store, by key not by value', () => {
    const r = validateInputs(CAP, { memberId: '100482' }, NO_SECRETS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("secret 'meridian/ops'");
  });
});

describe('bindTemplate', () => {
  it('substitutes every placeholder', () => {
    expect(bindTemplate('/meridian/member/{{memberId}}?c={{channel}}', { memberId: '100482', channel: 'web' })).toBe(
      '/meridian/member/100482?c=web',
    );
  });

  it('tolerates whitespace inside the braces', () => {
    expect(bindTemplate('{{ memberId }}', { memberId: '100482' })).toBe('100482');
  });

  it('throws on an unbound placeholder rather than emitting a half-bound string', () => {
    // Typing the literal "{{memberId}}" into a search box does not fail — it
    // returns "no results", which the caller reads as a business answer.
    expect(() => bindTemplate('Member {{memberId}} — Profile', {})).toThrow(UnboundPlaceholderError);
    expect(() => bindTemplate('Member {{memberId}} — Profile', {})).toThrow(/\{\{memberId\}\}/);
  });

  it('names every unbound placeholder at once', () => {
    try {
      bindTemplate('{{a}}/{{b}}', {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnboundPlaceholderError);
      expect((err as UnboundPlaceholderError).missing).toEqual(['a', 'b']);
    }
  });
});

describe('bindDescriptor', () => {
  it("binds a 'template' name and collapses the match mode to exact", () => {
    const d = bindDescriptor(
      { role: 'heading', name: 'Member {{memberId}} — Profile', nameMatch: 'template', framePath: [] },
      { memberId: '100482' },
    );
    expect(d.name).toBe('Member 100482 — Profile');
    expect(d.nameMatch).toBe('exact');
  });

  it('binds placeholders in other fields without changing the match mode', () => {
    const d = bindDescriptor(
      { role: 'cell', name: 'Balance', nameMatch: 'contains', framePath: ['{{channel}}Frame'], section: 'Member {{memberId}}' },
      { memberId: '100482', channel: 'web' },
    );
    expect(d.nameMatch).toBe('contains');
    expect(d.section).toBe('Member 100482');
    expect(d.framePath).toEqual(['webFrame']);
  });

  it('leaves a literal name untouched', () => {
    const d = bindDescriptor({ role: 'button', name: 'Search', nameMatch: 'exact', framePath: [] }, {});
    expect(d.name).toBe('Search');
  });
});

describe('bindCondition', () => {
  it('binds recursively through combinators and descriptors', () => {
    const bound = bindCondition(
      {
        all: [
          { textPresent: 'Member {{memberId}} — Profile' },
          { not: { textMatches: 'No member {{memberId}}' } },
          { elementPresent: { role: 'heading', name: 'Member {{memberId}}', nameMatch: 'template', framePath: [] } },
          { uriMatches: '/meridian/member/{{memberId}}' },
        ],
      },
      { memberId: '100482' },
    );

    expect(bound).toEqual({
      all: [
        { textPresent: 'Member 100482 — Profile' },
        { not: { textMatches: 'No member 100482' } },
        { elementPresent: { role: 'heading', name: 'Member 100482', nameMatch: 'exact', framePath: [] } },
        { uriMatches: '/meridian/member/100482' },
      ],
    });
  });
});

describe('describeBoundParams', () => {
  it('classifies from the contract, and never hands a secret to the redactor', () => {
    const r = validateInputs(CAP, { memberId: '100482' }, SECRETS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const described = describeBoundParams(CAP, r.bound, redactor);
    expect(described['channel']).toBe('web'); // public
    expect(described['memberId']).toBe('[identifier]'); // tokenized
    expect(described['opsPassword']).toBe('[secret]'); // never redacted, just absent
    expect(JSON.stringify(described)).not.toContain('hunter2');
  });
});
