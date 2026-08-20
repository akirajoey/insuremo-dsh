import type { SkillActionReceipt } from "./types.ts";

/**
 * In-memory one-shot execution journal.
 *
 * Per operation the lifecycle is prepared -> executing -> executed. The
 * journal exists only while the actions service process lives; it is never
 * surfaced on any face, never reflected, and revoked on disposal. It exists
 * to guarantee "at most one external attempt" per approved operation in this
 * process and to make `recordResult` retries pure evidence writes.
 */
export interface ExecutionJournalEntry {
  readonly state: "prepared" | "executing" | "executed";
  /** Set when the attempt could not produce a definite receipt. */
  readonly outcomeUnknown: boolean;
  readonly receipt?: SkillActionReceipt;
  readonly resultDigest?: string;
  readonly eventEmitted: boolean;
  readonly evidenceRecorded: boolean;
}

export class ExecutionJournal {
  #entries = new Map<string, ExecutionJournalEntry>();

  /**
   * Mark an attempt as executing before the first external spawn. Returns
   * `false` when the operation already reached `executed` (no rerun).
   */
  begin(operationId: string): boolean {
    const existing = this.#entries.get(operationId);
    if (existing?.state === "executed") return false;
    if (existing?.state === "executing") return false;
    this.#entries.set(operationId, {
      state: "executing",
      outcomeUnknown: false,
      eventEmitted: false,
      evidenceRecorded: false,
    });
    return true;
  }

  get(operationId: string): ExecutionJournalEntry | undefined {
    const entry = this.#entries.get(operationId);
    return entry === undefined ? undefined : { ...entry };
  }

  markOutcomeUnknown(operationId: string): void {
    const entry = this.#entries.get(operationId);
    if (entry === undefined || entry.state !== "executing") return;
    this.#entries.set(operationId, { ...entry, outcomeUnknown: true });
  }

  commit(operationId: string, receipt: SkillActionReceipt, resultDigest: string): void {
    const entry = this.#entries.get(operationId);
    if (entry === undefined) return;
    this.#entries.set(operationId, {
      state: "executed",
      outcomeUnknown: entry.outcomeUnknown,
      receipt,
      resultDigest,
      eventEmitted: entry.eventEmitted,
      evidenceRecorded: entry.evidenceRecorded,
    });
  }

  isEventEmitted(operationId: string): boolean {
    return this.#entries.get(operationId)?.eventEmitted ?? false;
  }

  markEventEmitted(operationId: string): void {
    const entry = this.#entries.get(operationId);
    if (entry === undefined) return;
    this.#entries.set(operationId, { ...entry, eventEmitted: true });
  }

  markEvidenceRecorded(operationId: string): void {
    const entry = this.#entries.get(operationId);
    if (entry === undefined) return;
    this.#entries.set(operationId, { ...entry, evidenceRecorded: true });
  }

  clear(): void {
    this.#entries.clear();
  }
}
