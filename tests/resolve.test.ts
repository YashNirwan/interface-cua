/**
 * The resolution cascade is what decides whether a capability recorded last
 * month still works today, so it gets the most direct tests in the repo.
 *
 * The fixtures below mirror the real shape of the target app's member screen:
 * two identical "View" buttons in an Accounts table, a third in a Recent
 * Activity table, and a search form in a different frame.
 */
import { describe, expect, it } from 'vitest';
import { descriptorFromNode, isStableAnchor, isWeakerTier, normalizeName, resolveDescriptor } from '../src/surface/web/resolve.js';
import type { TargetDescriptor, UiNode } from '../src/surface/types.js';

function node(p: Partial<UiNode> & Pick<UiNode, 'ref' | 'role' | 'name'>): UiNode {
  return { framePath: ['mainFrame'], ordinal: 0, ...p };
}

const SCREEN: UiNode[] = [
  node({ ref: 'n1', role: 'button', name: 'View', section: 'Accounts', ordinal: 0, textNear: ['Savings'], hint: { id: 'gv_ctl02_btnView' } }),
  node({ ref: 'n2', role: 'button', name: 'View', section: 'Accounts', ordinal: 1, textNear: ['Checking'], hint: { id: 'gv_ctl03_btnView' } }),
  node({ ref: 'n3', role: 'button', name: 'View', section: 'Recent Activity', ordinal: 0, textNear: ['2026-09-04'] }),
  node({ ref: 'n4', role: 'button', name: 'Open Sub-Account' }),
  node({ ref: 'n5', role: 'textbox', name: 'Member ID', framePath: ['mainFrame'], hint: { id: 'ctl00_txtMemberId', name: 'ctl00$txtMemberId' } }),
  node({ ref: 'n6', role: 'textbox', name: 'Member ID', framePath: ['popupFrame'] }),
  node({ ref: 'n7', role: 'button', name: 'Search  ', section: 'Member Search' }),
];

const base = (over: Partial<TargetDescriptor>): TargetDescriptor => ({
  role: 'button',
  name: 'View',
  nameMatch: 'exact',
  framePath: ['mainFrame'],
  ...over,
});

describe('resolution cascade', () => {
  it('resolves uniquely on role + name when nothing else competes', () => {
    const r = resolveDescriptor(base({ name: 'Open Sub-Account' }), SCREEN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.ref).toBe('n4');
      expect(r.tier).toBe('exact-name-in-frame');
    }
  });

  it('uses the enclosing section to disambiguate identical control names', () => {
    // Three "View" buttons exist; only the section separates the tables.
    const r = resolveDescriptor(base({ section: 'Recent Activity' }), SCREEN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.ref).toBe('n3');
      expect(r.tier).toBe('exact-name-in-section');
    }
  });

  it('falls through to neighbouring text when the section is still ambiguous', () => {
    // Two "View" buttons share the Accounts section. Only the row label differs.
    const r = resolveDescriptor(base({ section: 'Accounts', textNear: ['Savings'] }), SCREEN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.ref).toBe('n1');
      expect(r.tier).toBe('near-text');
    }
  });

  it('falls back to ordinal position as a last resort', () => {
    const r = resolveDescriptor(base({ section: 'Accounts', ordinal: 1 }), SCREEN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.ref).toBe('n2');
      expect(r.tier).toBe('ordinal');
    }
  });

  it('reports ambiguity from the EARLIEST tier that matched, not the last', () => {
    // A reviewer fixing this artifact needs to see the semantic problem
    // ("two Views in Accounts"), not a positional artefact of the last tier.
    const r = resolveDescriptor(base({ section: 'Accounts' }), SCREEN);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'ambiguous') {
      expect(r.tier).toBe('exact-name-in-section');
      expect(r.candidates).toBe(2);
      expect(r.sample[0]).toContain("button 'View' in section 'Accounts'");
    } else {
      throw new Error('expected an ambiguous resolution');
    }
  });

  it('does not match across frames', () => {
    const r = resolveDescriptor({ role: 'textbox', name: 'Member ID', nameMatch: 'exact', framePath: ['popupFrame'] }, SCREEN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.ref).toBe('n6');
  });

  it('normalizes casing, padding and punctuation', () => {
    const r = resolveDescriptor({ role: 'button', name: 'search', nameMatch: 'normalized', framePath: ['mainFrame'] }, SCREEN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.ref).toBe('n7');
  });

  it('reports not-found with the tiers it tried, so a failure is debuggable', () => {
    const r = resolveDescriptor(base({ name: 'Nonexistent Button' }), SCREEN);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'not-found') {
      expect(r.tried).toContain('exact-name-in-frame');
      expect(r.tried).toContain('ordinal');
    } else {
      throw new Error('expected not-found');
    }
  });

  it('prefers an enabled control over a disabled duplicate', () => {
    // Legacy apps render greyed duplicates of a button in collapsed panels;
    // clicking one does nothing and fails a checkpoint three steps later.
    const screen = [
      node({ ref: 'd1', role: 'button', name: 'Post', disabled: true }),
      node({ ref: 'd2', role: 'button', name: 'Post' }),
    ];
    const r = resolveDescriptor(base({ name: 'Post' }), screen);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.ref).toBe('d2');
  });

  it('treats a template name as exact once parameters have been substituted', () => {
    const screen = [node({ ref: 'x', role: 'heading', name: 'Member 100482 — Profile' })];
    const r = resolveDescriptor({ role: 'heading', name: 'Member 100482 — Profile', nameMatch: 'template', framePath: ['mainFrame'] }, screen);
    expect(r.ok).toBe(true);
  });
});

describe('descriptorFromNode', () => {
  it('drops the ephemeral ref and the current value', () => {
    const d = descriptorFromNode(SCREEN[4]!);
    expect(d).not.toHaveProperty('ref');
    expect(d).not.toHaveProperty('value');
    expect(d.role).toBe('textbox');
    expect(d.name).toBe('Member ID');
  });

  it('keeps only id/name/type from the surface hints', () => {
    const n = node({ ref: 'h', role: 'button', name: 'Go', hint: { id: 'a', name: 'b', type: 'submit', nameFrom: 'value', className: 'btn' } });
    expect(descriptorFromNode(n).hint).toEqual({ id: 'a', name: 'b', type: 'submit' });
  });

  it('excludes volatile neighbouring text so a balance cannot become a locator', () => {
    const n = node({ ref: 'v', role: 'button', name: 'View', textNear: ['$4,812.55', 'Savings'] });
    expect(descriptorFromNode(n).textNear).toEqual(['Savings']);
  });
});

describe('isStableAnchor', () => {
  it.each([
    ['Savings', true],
    ['Checking', true],
    ['$4,812.55', false],
    ['1,204.09', false],
    ['2026-09-04', false],
    ['09/04/2026', false],
    ['23:00', false],
    ['100482', false],
    ['-218.70', false],
    ['ok', false],
  ])('%s -> %s', (input, expected) => {
    expect(isStableAnchor(input)).toBe(expected);
  });
});

describe('drift detection', () => {
  it('flags a resolution that fell back to a weaker tier than recorded', () => {
    expect(isWeakerTier('ordinal', 'exact-name-in-section')).toBe(true);
    expect(isWeakerTier('exact-name-in-frame', 'ordinal')).toBe(false);
    expect(isWeakerTier('near-text', 'near-text')).toBe(false);
    expect(isWeakerTier('ordinal', undefined)).toBe(false);
  });
});

describe('normalizeName', () => {
  it('collapses the punctuation legacy screens vary on', () => {
    expect(normalizeName('  Member ID:  ')).toBe('member id');
    expect(normalizeName('Sign-On')).toBe('sign on');
    // Dashes of every flavour collapse to whitespace, so an em dash on one
    // tenant's screen and a hyphen on another's compare equal.
    expect(normalizeName('Member 100482 — Profile')).toBe('member 100482 profile');
    expect(normalizeName('Member 100482 - Profile')).toBe('member 100482 profile');
  });
});
