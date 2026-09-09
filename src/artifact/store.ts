/**
 * Capability storage.
 *
 * Artifacts are plain JSON files on disk under `capabilities/`, named
 * `<id>@<version>.json`, with tenant overlays under `capabilities/overlays/`.
 *
 * Why a directory of JSON files rather than a database: the artifact is meant
 * to be *reviewed*. Putting it in git means a change to a capability is a pull
 * request with a readable diff, an approver, and a history — which is exactly
 * the control a bank's change-management process is going to demand anyway. A
 * row in a table gives you none of that for free. The `CapabilityStore`
 * interface is the seam if that ever needs to become a service.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { type Capability, type Overlay, parseCapability, parseOverlay } from './schema.js';

export interface CapabilityStore {
  list(): Capability[];
  get(id: string, version?: string): Capability | undefined;
  save(cap: Capability): string;
  overlaysFor(id: string): Overlay[];
  getOverlay(tenantId: string, capabilityId: string): Overlay | undefined;
}

/** Sort semver-ish strings descending so `get(id)` returns the newest. */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export class FileCapabilityStore implements CapabilityStore {
  constructor(private readonly dir: string = 'capabilities') {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const od = join(dir, 'overlays');
    if (!existsSync(od)) mkdirSync(od, { recursive: true });
  }

  private files(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(this.dir, f));
  }

  list(): Capability[] {
    const out: Capability[] = [];
    for (const f of this.files()) {
      try {
        out.push(parseCapability(JSON.parse(readFileSync(f, 'utf8'))));
      } catch (e) {
        // A malformed artifact must not take down the whole catalog — a calling
        // agent should still be able to use the capabilities that ARE valid.
        // We surface it loudly rather than silently skipping.
        console.warn(`[store] skipping invalid capability ${basename(f)}: ${(e as Error).message}`);
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id) || compareVersionsDesc(a.version, b.version));
  }

  get(id: string, version?: string): Capability | undefined {
    const matches = this.list().filter((c) => c.id === id && (!version || c.version === version));
    if (version) return matches[0];
    // Deliberately excludes deprecated artifacts from an unversioned lookup:
    // a caller asking for "the current one" should never silently get a
    // withdrawn capability. Asking for it by exact version still works, so the
    // audit trail stays intact.
    const live = matches.filter((c) => c.status !== 'deprecated');
    return live.sort((a, b) => compareVersionsDesc(a.version, b.version))[0] ?? matches[0];
  }

  save(cap: Capability): string {
    parseCapability(cap); // never write something we cannot read back
    const path = join(this.dir, `${cap.id}@${cap.version}.json`);
    writeFileSync(path, JSON.stringify(cap, null, 2) + '\n', 'utf8');
    return path;
  }

  overlaysFor(id: string): Overlay[] {
    const od = join(this.dir, 'overlays');
    if (!existsSync(od)) return [];
    const out: Overlay[] = [];
    for (const f of readdirSync(od).filter((f) => f.endsWith('.json'))) {
      try {
        const o = parseOverlay(JSON.parse(readFileSync(join(od, f), 'utf8')));
        if (o.overlayFor.capabilityId === id) out.push(o);
      } catch (e) {
        console.warn(`[store] skipping invalid overlay ${f}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  getOverlay(tenantId: string, capabilityId: string): Overlay | undefined {
    return this.overlaysFor(capabilityId).find((o) => o.tenantId === tenantId);
  }
}

/** Bump the patch/minor of a semver string. */
export function bumpVersion(v: string, kind: 'major' | 'minor' | 'patch' = 'minor'): string {
  const [maj = 0, min = 0, pat = 0] = v.split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}
