import type { PushReceipt } from "./types.ts";

/**
 * In-memory one-shot execution journal.
 *
 * Per operation the lifecycle is prepared -> executing -> executed. The
 * journal exists only while the service process lives; it is never exported,
 * never reflected, and cleared on disposal. It guarantees "at most one
 * external push attempt" per approved operation in this process so a retried
 * `pushExecute` is a pure evidence read — never a re-push.
 */
export interface PushJournalEntry {
  readonly state: "prepared" | "executing" | "executed";
  /** Set when the attempt could not produce a definite receipt. */
  readonly outcomeUnknown: boolean;
  readonly receipt?: PushReceipt;
  readonly resultDigest?: string;
  readonly eventEmitted: boolean;
}

export class PushJournal {
  #entries = new Map<string, PushJournalEntry>();

  /** Reserve an attempt before any external spawn. Refused if already taken. */
  prepare(operationId: string): boolean {
    if (this.#entries.has(operationId)) return false;
    this.#entries.set(operationId, {
      state: "prepared",
      outcomeUnknown: false,
      eventEmitted: false,
    });
    return true;
  }

  /** Transition prepared -> executing right before the spawn. */
  begin(operationId: string): boolean {
    const existing = this.#entries.get(operationId);
    if (existing === undefined) return false;
    if (existing.state === "executing" || existing.state === "executed") return false;
    this.#entries.set(operationId, { ...existing, state: "executing" });
    return true;
  }

  get(operationId: string): PushJournalEntry | undefined {
    const entry = this.#entries.get(operationId);
    return entry === undefined ? undefined : { ...entry };
  }

  markOutcomeUnknown(operationId: string): void {
    const entry = this.#entries.get(operationId);
    if (entry === undefined || entry.state !== "executing") return;
    this.#entries.set(operationId, { ...entry, outcomeUnknown: true });
  }

  commit(operationId: string, receipt: PushReceipt, resultDigest: string): void {
    const entry = this.#entries.get(operationId);
    if (entry === undefined) return;
    this.#entries.set(operationId, {
      state: "executed",
      outcomeUnknown: entry.outcomeUnknown,
      receipt,
      resultDigest,
      eventEmitted: entry.eventEmitted,
    });
  }

  markEventEmitted(operationId: string): void {
    const entry = this.#entries.get(operationId);
    if (entry === undefined) return;
    this.#entries.set(operationId, { ...entry, eventEmitted: true });
  }

  clear(): void {
    this.#entries.clear();
  }
}
