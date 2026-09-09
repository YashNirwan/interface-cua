/**
 * Evidence. Every run — discovery or replay — writes a directory under
 * /evidence/<runId>/ containing a JSONL event log, captures taken at
 * interesting moments, and the run's result.
 *
 * Two rules make this trustworthy rather than decorative:
 *   1. Everything written goes through the Redactor first. There is no
 *      "just this once" raw log line.
 *   2. Every event carries who held the session lease when it happened.
 */

export type EvidenceEventType =
  | 'run.start'
  | 'run.end'
  | 'observe'
  | 'action'
  | 'llm.request'
  | 'llm.response'
  | 'step.start'
  | 'step.end'
  | 'checkpoint'
  | 'outcome.detected'
  | 'recovery'
  | 'policy.decision'
  | 'escalation.raised'
  | 'escalation.resolved'
  | 'control.transfer'
  | 'human.action'
  | 'extract'
  | 'capture'
  | 'error';

export interface EvidenceEvent {
  seq: number;
  at: string;
  runId: string;
  type: EvidenceEventType;
  /** Who held the session lease at this moment. */
  controller: 'automation' | 'human';
  /** Free-form, already redacted. */
  data: Record<string, unknown>;
  /** Plain-language line for humans reading the log. */
  message?: string;
}

export interface RunLogger {
  readonly runId: string;
  readonly dir: string;
  readonly logFile: string;
  emit(type: EvidenceEventType, data: Record<string, unknown>, message?: string): void;
  /** Persist a capture (screenshot/snapshot); returns the relative path written. */
  saveCapture(name: string, cap: { screenshot?: Buffer; snapshot?: string }): Promise<{ screenshot?: string; snapshot?: string }>;
  /** Write the final structured result and flush. */
  finish(result: unknown): Promise<void>;
  events(): EvidenceEvent[];
}
