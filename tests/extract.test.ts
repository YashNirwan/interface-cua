import { describe, expect, it } from 'vitest';
import type { Extraction, TargetDescriptorSpec } from '../src/artifact/schema.js';
import type { Observation, UiNode } from '../src/surface/types.js';
import { extractAll, parseValue } from '../src/replay/extract.js';

// ---------------------------------------------------------------------------
// Fixture: the legacy shape this primitive exists for —
//   <td>Available Balance:</td><td>$4,812.55</td>
// no ids, no classes, two sections that reuse the same label.
// ---------------------------------------------------------------------------

function node(partial: Partial<UiNode> & Pick<UiNode, 'ref' | 'role' | 'name'>): UiNode {
  return { framePath: [], ordinal: 0, ...partial };
}

const NODES: UiNode[] = [
  node({ ref: 'n0', role: 'heading', name: 'Member 100482 — Profile' }),
  node({ ref: 'n1', role: 'textbox', name: 'Member ID', value: '100482', section: 'Member Lookup' }),

  node({ ref: 'n2', role: 'cell', name: 'Account Number', section: 'Account Summary', ordinal: 0 }),
  node({ ref: 'n3', role: 'cell', name: '0001-4471', section: 'Account Summary', ordinal: 1 }),
  node({ ref: 'n4', role: 'cell', name: 'Available Balance:', section: 'Account Summary', ordinal: 2 }),
  node({ ref: 'n5', role: 'cell', name: '$4,812.55', section: 'Account Summary', ordinal: 3 }),
  node({ ref: 'n6', role: 'cell', name: 'Pending Adjustment:', section: 'Account Summary', ordinal: 4 }),
  node({ ref: 'n7', role: 'cell', name: '($128.40)', section: 'Account Summary', ordinal: 5 }),
  node({ ref: 'n8', role: 'cell', name: 'Opened:', section: 'Account Summary', ordinal: 6 }),
  node({ ref: 'n9', role: 'cell', name: '03/14/2019', section: 'Account Summary', ordinal: 7 }),
  node({ ref: 'n10', role: 'cell', name: 'Overdraft Protection:', section: 'Account Summary', ordinal: 8 }),
  node({ ref: 'n11', role: 'cell', name: 'Yes', section: 'Account Summary', ordinal: 9 }),

  node({ ref: 'n12', role: 'cell', name: 'Available Balance:', section: 'Savings Sub-Account', ordinal: 0 }),
  node({ ref: 'n13', role: 'cell', name: '$120.00', section: 'Savings Sub-Account', ordinal: 1 }),
];

const TEXT = [
  'Meridian Core',
  'Member 100482 — Profile',
  'Account Summary',
  'Account Number  0001-4471',
  'Available Balance:  $4,812.55',
  'Pending Adjustment:  ($128.40)',
  'Opened:  03/14/2019',
  'Overdraft Protection:  Yes',
  'Savings Sub-Account',
  'Available Balance:  $120.00',
  'Last Statement: 2024-02-29',
].join('\n');

const OBS: Observation = {
  surfaceKind: 'legacy-web',
  location: { uri: 'https://core.meridian.example/meridian/member/100482', title: 'Member Profile', canonicalPath: '/meridian/member/:id' },
  nodes: NODES,
  text: TEXT,
  capturedAt: '2026-09-08T10:00:00.000Z',
};

function labeled(name: string, label: string, over: Partial<Extraction> = {}): Extraction {
  return {
    name,
    type: 'money',
    description: `the ${name}`,
    from: { labeledValue: { label } },
    required: true,
    sensitivity: 'public',
    expect: 'non-empty',
    ...over,
  };
}

const SAVINGS_SECTION: TargetDescriptorSpec = {
  role: 'region',
  name: '',
  nameMatch: 'exact',
  framePath: [],
  section: 'Savings Sub-Account',
};

// ---------------------------------------------------------------------------

describe('labeledValue', () => {
  it('pulls the value from the next cell in the row', () => {
    const r = extractAll([labeled('availableBalance', 'Available Balance')], OBS);
    expect(r.errors).toEqual([]);
    expect(r.values['availableBalance']).toBe(4812.55);
    // The raw string is kept so "what did the page actually say?" is answerable.
    expect(r.raw['availableBalance']).toBe('$4,812.55');
  });

  it('tolerates a trailing colon on either side of the match', () => {
    expect(extractAll([labeled('b', 'Available Balance:')], OBS).values['b']).toBe(4812.55);
  });

  it('takes the first matching section when unscoped, and honours `within` when scoped', () => {
    expect(extractAll([labeled('b', 'Available Balance')], OBS).values['b']).toBe(4812.55);

    const scoped = labeled('b', 'Available Balance', {
      from: { labeledValue: { label: 'Available Balance', within: SAVINGS_SECTION } },
    });
    expect(extractAll([scoped], OBS).values['b']).toBe(120);
  });

  it('parses a parenthesised negative as accounting notation', () => {
    const r = extractAll([labeled('pendingAdjustment', 'Pending Adjustment')], OBS);
    expect(r.values['pendingAdjustment']).toBe(-128.4);
    expect(r.raw['pendingAdjustment']).toBe('($128.40)');
  });

  it('normalizes MM/DD/YYYY to an ISO calendar date', () => {
    const r = extractAll([labeled('openedOn', 'Opened', { type: 'date' })], OBS);
    expect(r.values['openedOn']).toBe('2019-03-14');
  });

  it('parses yes/no into a boolean', () => {
    const r = extractAll([labeled('overdraft', 'Overdraft Protection', { type: 'boolean' })], OBS);
    expect(r.values['overdraft']).toBe(true);
  });

  it('falls back to the flattened text when there is no cell structure', () => {
    const textOnly: Observation = { ...OBS, nodes: [] };
    const r = extractAll([labeled('lastStatement', 'Last Statement', { type: 'date' })], textOnly);
    expect(r.errors).toEqual([]);
    expect(r.values['lastStatement']).toBe('2024-02-29');
  });

  it('a required label that is not on the page is an error', () => {
    const r = extractAll([labeled('mystery', 'Escheatment Date')], OBS);
    expect(r.values['mystery']).toBeUndefined();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("output 'mystery'");
    expect(r.errors[0]).toContain('Escheatment Date');
  });

  it('an optional label that is not on the page yields undefined, not an error', () => {
    const r = extractAll([labeled('mystery', 'Escheatment Date', { required: false })], OBS);
    expect(r.errors).toEqual([]);
    expect(r.values['mystery']).toBeUndefined();
  });
});

describe('element', () => {
  it('reads the value of a form control rather than its accessible name', () => {
    const spec: Extraction = {
      name: 'echoedMemberId',
      type: 'number',
      description: 'the id left in the search box',
      from: { element: { role: 'textbox', name: 'Member ID', nameMatch: 'exact', framePath: [], section: 'Member Lookup' } },
      required: true,
      sensitivity: 'identifier',
      expect: 'non-empty',
    };
    const r = extractAll([spec], OBS);
    expect(r.errors).toEqual([]);
    expect(r.values['echoedMemberId']).toBe(100482);
  });
});

describe('textPattern', () => {
  function pattern(p: string, over: Partial<Extraction> = {}): Extraction {
    return {
      name: 'memberId',
      type: 'number',
      description: 'the member id in the heading',
      from: { textPattern: p },
      required: true,
      sensitivity: 'identifier',
      expect: 'non-empty',
      ...over,
    };
  }

  it('captures the single group', () => {
    const r = extractAll([pattern('Member (\\d{6})')], OBS);
    expect(r.errors).toEqual([]);
    expect(r.values['memberId']).toBe(100482);
  });

  it('rejects a pattern with no capture group — a detector, not an extractor', () => {
    const r = extractAll([pattern('Member \\d{6}')], OBS);
    expect(r.values['memberId']).toBeUndefined();
    expect(r.errors[0]).toContain('exactly one capture group, found 0');
  });

  it('rejects a pattern with more than one capture group — the value is ambiguous', () => {
    const r = extractAll([pattern('Member (\\d{6}) — (\\w+)')], OBS);
    expect(r.errors[0]).toContain('exactly one capture group, found 2');
  });

  it('reports a malformed pattern instead of throwing', () => {
    const r = extractAll([pattern('Member (\\d{6}')], OBS);
    expect(r.errors[0]).toContain('invalid textPattern');
  });

  it('reports a pattern that simply did not match', () => {
    const r = extractAll([pattern('Teller (\\d{6})')], OBS);
    expect(r.errors[0]).toContain('did not match the page text');
  });
});

describe('parseValue', () => {
  it('strips currency symbols and thousands separators', () => {
    expect(parseValue('$4,812.55', 'money')).toEqual({ ok: true, value: 4812.55 });
    expect(parseValue('USD 1,200', 'money')).toEqual({ ok: true, value: 1200 });
    expect(parseValue('  $0.00 ', 'money')).toEqual({ ok: true, value: 0 });
  });

  it('handles both negative notations', () => {
    expect(parseValue('($12.34)', 'money')).toEqual({ ok: true, value: -12.34 });
    expect(parseValue('-$12.34', 'money')).toEqual({ ok: true, value: -12.34 });
  });

  it('fails loudly on a non-numeric money string', () => {
    const r = parseValue('n/a', 'money');
    expect(r.ok).toBe(false);
  });

  it('parses booleans from the vocabulary legacy apps actually use', () => {
    for (const yes of ['Yes', 'true', 'Y', '1', 'checked']) expect(parseValue(yes, 'boolean')).toEqual({ ok: true, value: true });
    for (const no of ['No', 'false', 'N', '0', 'unchecked']) expect(parseValue(no, 'boolean')).toEqual({ ok: true, value: false });
    expect(parseValue('maybe', 'boolean').ok).toBe(false);
  });

  it('normalizes dates without inventing a time or a timezone', () => {
    expect(parseValue('2019-3-4', 'date')).toEqual({ ok: true, value: '2019-03-04' });
    expect(parseValue('03/14/2019', 'date')).toEqual({ ok: true, value: '2019-03-14' });
    expect(parseValue('Mar 14, 2019', 'date')).toEqual({ ok: true, value: '2019-03-14' });
    expect(parseValue('sometime in march', 'date').ok).toBe(false);
  });

  it('collapses whitespace in strings', () => {
    expect(parseValue('  Active   Member ', 'string')).toEqual({ ok: true, value: 'Active Member' });
  });
});

describe('expect assertions', () => {
  it('non-negative rejects a negative parse — usually the wrong column, not an overdraft', () => {
    const r = extractAll([labeled('pendingAdjustment', 'Pending Adjustment', { expect: 'non-negative' })], OBS);
    expect(r.values['pendingAdjustment']).toBeUndefined();
    expect(r.errors[0]).toContain('negative');
  });

  it('expect:any lets a negative through', () => {
    const r = extractAll([labeled('pendingAdjustment', 'Pending Adjustment', { expect: 'any' })], OBS);
    expect(r.errors).toEqual([]);
    expect(r.values['pendingAdjustment']).toBe(-128.4);
  });
});

describe('extractAll', () => {
  it('does not short-circuit — every failure is reported from one run', () => {
    const r = extractAll([labeled('a', 'Nope One'), labeled('b', 'Nope Two'), labeled('availableBalance', 'Available Balance')], OBS);
    expect(r.errors).toHaveLength(2);
    expect(r.values['availableBalance']).toBe(4812.55);
  });
});
