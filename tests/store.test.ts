import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCapability } from '../src/artifact/schema.js';
import { FileCapabilityStore } from '../src/artifact/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cua-store-'));
  dirs.push(dir);
  const store = new FileCapabilityStore(dir);
  const cap = parseCapability({
    schemaVersion: 'cua.capability/v1', id: 'test.lookup', version: '1.0.0',
    status: 'deprecated', summary: 'Lookup', description: 'Lookup',
    app: { vendor: 'Test', product: 'Test', surface: 'legacy-web' },
    entry: { uri: 'https://example.com' },
    steps: [{ id: 'wait', intent: 'Wait', action: { type: 'wait', ms: 1 } }],
    success: { textPresent: 'Done' },
    provenance: { recordedAt: '2026-09-01T00:00:00Z', recordedBy: { kind: 'human-authored' }, runId: 'test', goal: 'Lookup' },
  });
  return { store, cap };
}

describe('FileCapabilityStore', () => {
  it('does not resurrect a withdrawn capability during an unversioned lookup', () => {
    const { store, cap } = setup();
    store.save(cap);
    expect(store.get(cap.id)).toBeUndefined();
    expect(store.get(cap.id, '1.0.0')?.status).toBe('deprecated');
  });

  it('selects the newest live version numerically', () => {
    const { store, cap } = setup();
    store.save({ ...cap, version: '1.9.0', status: 'approved' });
    store.save({ ...cap, version: '1.10.0', status: 'approved' });
    store.save({ ...cap, version: '2.0.0' });
    expect(store.get(cap.id)?.version).toBe('1.10.0');
  });
});
