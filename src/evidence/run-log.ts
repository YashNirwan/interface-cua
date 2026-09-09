/**
 * File-backed run evidence.
 *
 * One directory per run: `evidence/<runId>/` containing `events.jsonl`,
 * `result.json`, and `captures/`. JSONL because a run's log should be readable
 * with `tail -f` while it is happening and greppable afterwards, and because a
 * partially-written file is still a valid log up to its last newline.
 *
 * Every event carries the lease holder at the moment it happened, which is
 * what makes "who was in control when this member record was opened?"
 * answerable from the evidence alone. For a regulated back office that is the
 * question an auditor actually asks.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { EvidenceEvent, EvidenceEventType, RunLogger } from './types.js';
import type { Redactor } from '../policy/types.js';
import type { SessionLease } from '../escalation/lease.js';

export interface RunLoggerOptions {
  runId: string;
  baseDir?: string;
  redactor: Redactor;
  lease: SessionLease;
  /** Mirror events to stderr as they happen. Handy during a live discovery run. */
  echo?: boolean;
}

export class FileRunLogger implements RunLogger {
  readonly runId: string;
  readonly dir: string;
  readonly logFile: string;

  private seq = 0;
  private readonly buffer: EvidenceEvent[] = [];

  constructor(private readonly opts: RunLoggerOptions) {
    this.runId = opts.runId;
    this.dir = join(opts.baseDir ?? 'evidence', opts.runId);
    this.logFile = join(this.dir, 'events.jsonl');
    mkdirSync(join(this.dir, 'captures'), { recursive: true });
  }

  emit(type: EvidenceEventType, data: Record<string, unknown>, message?: string): void {
    const ev: EvidenceEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      runId: this.runId,
      type,
      controller: this.opts.lease.holder,
      // Redaction happens here, at the single point every event passes
      // through, rather than at each of the ~40 call sites. A redactor you
      // have to remember to call is one that eventually is not called.
      data: this.opts.redactor.object(data),
      ...(message ? { message: this.opts.redactor.text(message) } : {}),
    };
    this.buffer.push(ev);
    // Synchronous append: we accept the I/O cost because the events we most
    // want are the ones written immediately before a crash, and a buffered
    // writer loses exactly those.
    appendFileSync(this.logFile, JSON.stringify(ev) + '\n', 'utf8');
    if (this.opts.echo) {
      process.stderr.write(`[${ev.seq.toString().padStart(3)}] ${ev.controller.padEnd(10)} ${type.padEnd(20)} ${ev.message ?? ''}\n`);
    }
  }

  async saveCapture(name: string, cap: { screenshot?: Buffer; snapshot?: string }): Promise<{ screenshot?: string; snapshot?: string }> {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const out: { screenshot?: string; snapshot?: string } = {};
    if (cap.screenshot) {
      const p = join(this.dir, 'captures', `${safe}.png`);
      writeFileSync(p, cap.screenshot);
      out.screenshot = relative(this.dir, p);
    }
    if (cap.snapshot) {
      const p = join(this.dir, 'captures', `${safe}.txt`);
      // The snapshot is a semantic node list, but it still originated from a
      // live page, so it goes through the redactor like everything else.
      writeFileSync(p, this.opts.redactor.text(cap.snapshot), 'utf8');
      out.snapshot = relative(this.dir, p);
    }
    this.emit('capture', { name: safe, ...out }, `captured ${safe}`);
    return out;
  }

  async finish(result: unknown): Promise<void> {
    writeFileSync(join(this.dir, 'result.json'), JSON.stringify(this.opts.redactor.object(result), null, 2) + '\n', 'utf8');
  }

  events(): EvidenceEvent[] {
    return [...this.buffer];
  }
}

export function createRunLogger(opts: RunLoggerOptions): FileRunLogger {
  return new FileRunLogger(opts);
}
