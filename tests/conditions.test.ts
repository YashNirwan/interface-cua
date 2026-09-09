import { describe, expect, it } from 'vitest';
import type { Observation, UiNode } from '../src/surface/types.js';
import { describeCondition, evaluate, normalizeText } from '../src/replay/conditions.js';

// ---------------------------------------------------------------------------
// Fixtures — a Meridian Core member profile, built by hand. No browser.
// ---------------------------------------------------------------------------

function node(partial: Partial<UiNode> & Pick<UiNode, 'ref' | 'role' | 'name'>): UiNode {
  return { framePath: [], ordinal: 0, ...partial };
}

const NODES: UiNode[] = [
  node({ ref: 'n1', role: 'heading', name: 'Member 100482 — Profile' }),
  node({ ref: 'n2', role: 'textbox', name: 'Member ID', value: '100482', section: 'Member Lookup' }),
  node({ ref: 'n3', role: 'button', name: 'Search', section: 'Member Lookup' }),
  node({ ref: 'n4', role: 'button', name: 'Clear', section: 'Member Lookup' }),
  node({ ref: 'n5', role: 'cell', name: 'Available Balance:', section: 'Account Summary' }),
  node({ ref: 'n6', role: 'cell', name: '$4,812.55', section: 'Account Summary', ordinal: 1 }),
];

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    surfaceKind: 'legacy-web',
    location: {
      uri: 'https://core.meridian.example/meridian/member/100482',
      title: 'Meridian Core — Member Profile',
      canonicalPath: '/meridian/member/:id',
    },
    nodes: NODES,
    text: 'Meridian Core\nMember 100482 —   Profile\nAccount Summary\nAvailable Balance:  $4,812.55',
    capturedAt: '2026-09-08T10:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeText', () => {
  it('collapses whitespace and case-folds', () => {
    expect(normalizeText('  Member   100482 \n — PROFILE ')).toBe('member 100482 — profile');
  });
});

describe('textPresent / textAbsent', () => {
  it('matches across incidental whitespace and case', () => {
    // The page renders "Member 100482 —   Profile" with a template-induced gap.
    const r = evaluate({ textPresent: 'member 100482 — profile' }, obs());
    expect(r.ok).toBe(true);
    expect(r.describe).toContain('(found)');
  });

  it('reports not-found with the searched string quoted', () => {
    const r = evaluate({ textPresent: 'Member 100517 — Profile' }, obs());
    expect(r.ok).toBe(false);
    expect(r.describe).toBe('text "Member 100517 — Profile" (not found)');
  });

  it('textAbsent is the inverse', () => {
    expect(evaluate({ textAbsent: 'No such member' }, obs()).ok).toBe(true);
    expect(evaluate({ textAbsent: 'Account Summary' }, obs()).ok).toBe(false);
    expect(evaluate({ textAbsent: 'Account Summary' }, obs()).describe).toContain('(present)');
  });
});

describe('textMatches', () => {
  it('matches a regex over the page text', () => {
    const r = evaluate({ textMatches: 'Member \\d{6}' }, obs());
    expect(r.ok).toBe(true);
    expect(r.describe).toContain('(matched)');
  });

  it('does not throw on a malformed pattern — an authoring bug is not a crash', () => {
    const r = evaluate({ textMatches: 'Member (\\d{6}' }, obs());
    expect(r.ok).toBe(false);
    expect(r.describe).toContain('invalid regex');
    expect(r.detail).toContain('authoring bug');
  });
});

describe('uriMatches', () => {
  it('matches the raw uri', () => {
    const r = evaluate({ uriMatches: 'core\\.meridian\\.example' }, obs());
    expect(r.ok).toBe(true);
    expect(r.describe).toContain('(matched)');
  });

  it('matches via canonicalPath so a recorded checkpoint generalizes across ids', () => {
    // Recorded on /member/100482; replayed for a different member. The raw uri
    // no longer matches the canonical form, but canonicalPath does.
    const r = evaluate({ uriMatches: '^/meridian/member/:id$' }, obs());
    expect(r.ok).toBe(true);
    expect(r.describe).toContain('matched via canonicalPath');
  });

  it('reports both forms when neither matches', () => {
    const r = evaluate({ uriMatches: '/meridian/teller/:id' }, obs());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('canonicalPath=/meridian/member/:id');
  });

  it('does not throw on a malformed pattern', () => {
    const r = evaluate({ uriMatches: '(' }, obs());
    expect(r.ok).toBe(false);
    expect(r.describe).toContain('invalid regex');
  });
});

describe('elementPresent / elementAbsent', () => {
  const search = { role: 'button' as const, name: 'Search', nameMatch: 'exact' as const, framePath: [], section: 'Member Lookup' };
  const missing = { role: 'button' as const, name: 'Post Transaction', nameMatch: 'exact' as const, framePath: [] };

  it('finds a uniquely-named control', () => {
    const r = evaluate({ elementPresent: search }, obs());
    expect(r.ok).toBe(true);
    expect(r.describe).toContain('button "Search"');
    expect(r.describe).toContain('(found)');
  });

  it('reports a control that is not on the page', () => {
    const r = evaluate({ elementPresent: missing }, obs());
    expect(r.ok).toBe(false);
    expect(r.describe).toContain('(not found)');
  });

  it('elementAbsent is the inverse', () => {
    expect(evaluate({ elementAbsent: missing }, obs()).ok).toBe(true);
    expect(evaluate({ elementAbsent: search }, obs()).ok).toBe(false);
  });
});

describe('combinators', () => {
  it('all: the describe string names every clause and its verdict', () => {
    const r = evaluate(
      {
        all: [{ textPresent: 'Member 100482 — Profile' }, { uriMatches: '/meridian/member/:id' }],
      },
      obs(),
    );
    expect(r.ok).toBe(true);
    expect(r.describe).toBe('text "Member 100482 — Profile" (found); uri ~ //meridian/member/:id/ (matched via canonicalPath)');
  });

  it('all: a failure names the specific sub-condition that failed', () => {
    const r = evaluate(
      {
        all: [{ textPresent: 'Member 100517 — Profile' }, { uriMatches: '/meridian/member/:id' }],
      },
      obs(),
    );
    expect(r.ok).toBe(false);
    // Both clauses appear, so the reader learns navigation worked and the
    // rendered record was wrong — without re-running anything.
    expect(r.describe).toContain('text "Member 100517 — Profile" (not found)');
    expect(r.describe).toContain('(matched via canonicalPath)');
    expect(r.detail).toContain('failing sub-condition: text "Member 100517 — Profile" (not found)');
  });

  it('all: counts additional failures in the detail', () => {
    const r = evaluate({ all: [{ textPresent: 'nope' }, { textPresent: 'also nope' }] }, obs());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('+1 more failing');
  });

  it('any: succeeds on the first alternative that holds and says which', () => {
    const r = evaluate({ any: [{ textPresent: 'No such member' }, { textPresent: 'Account Summary' }] }, obs());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('satisfied by: text "Account Summary" (found)');
  });

  it('any: lists every alternative when none hold', () => {
    const r = evaluate({ any: [{ textPresent: 'No such member' }, { textPresent: 'Insufficient funds' }] }, obs());
    expect(r.ok).toBe(false);
    expect(r.describe).toContain('No such member');
    expect(r.describe).toContain('Insufficient funds');
    expect(r.detail).toBe('no alternative held');
  });

  it('not: inverts and preserves the inner description', () => {
    const r = evaluate({ not: { textPresent: 'Account Summary' } }, obs());
    expect(r.ok).toBe(false);
    expect(r.describe).toBe('not (text "Account Summary" (found))');
  });

  it('empty all is vacuously true, empty any is vacuously false and flagged', () => {
    expect(evaluate({ all: [] }, obs()).ok).toBe(true);
    const anyEmpty = evaluate({ any: [] }, obs());
    expect(anyEmpty.ok).toBe(false);
    expect(anyEmpty.detail).toContain('can never hold');
  });
});

describe('describeCondition', () => {
  it('renders a nested condition without evaluating it', () => {
    expect(
      describeCondition({
        all: [{ textPresent: 'Account Summary' }, { not: { textPresent: 'No such member' } }],
      }),
    ).toBe('all of [text "Account Summary"; not (text "No such member")]');
  });

  it('renders a descriptor with its disambiguators', () => {
    expect(
      describeCondition({
        elementPresent: { role: 'button', name: 'Search', nameMatch: 'contains', framePath: ['main'], section: 'Member Lookup', ordinal: 2 },
      }),
    ).toBe('element button "Search" (contains) in section "Member Lookup" in frame main #2');
  });
});
