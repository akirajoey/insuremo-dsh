import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";

/**
 * TASK-102: the one Host-wide ICI Explain scheduling setting.
 *
 * Scope is deliberately the CURRENT Host instance: every workspace, session,
 * and batch scheduled by this process shares one maximum-concurrency cap. The
 * value is durable (storage-domain global) so a restart remembers it, but it
 * is NOT a cross-process limit — two Host processes keep separate caps.
 */
export const EXPLAIN_MIN_CONCURRENCY = 1 as const;
export const EXPLAIN_MAX_CONCURRENCY = 32 as const;
export const EXPLAIN_DEFAULT_CONCURRENCY = 4 as const;
/**
 * TASK-123: the prompt budget is a Host-wide input-size policy, configurable in BOTH directions.
 * The default is 1 MiB (a 1M-context model covers one API's prepared material without being cut).
 * The bounds below are a deliberate typo guard only — they are NOT a product ceiling: raise or
 * lower the value freely inside them. The per-file source/reference caps (256 KiB) stay separate.
 */
export const EXPLAIN_DEFAULT_PROMPT_BYTES = 1048576;
export const EXPLAIN_MIN_PROMPT_BYTES = 16384;
export const EXPLAIN_MAX_PROMPT_BYTES = 8388608;

/** Strict durable/effective shape: an integer in the closed 1–32 range. */
export const explainConcurrencySchema = z.number().int().min(EXPLAIN_MIN_CONCURRENCY).max(EXPLAIN_MAX_CONCURRENCY);
/** TASK-123: strict durable/effective shape for the prompt budget; a legacy record gets the default. */
export const explainPromptBytesSchema = z.number().int().min(EXPLAIN_MIN_PROMPT_BYTES).max(EXPLAIN_MAX_PROMPT_BYTES);

/** Durable Host-wide Explain configuration domain (global singleton). */
export const explainConfigDomain = defineDomain({
  name: "ici_explain_config",
  version: 1,
  global: {
    schema: z.object({ maxConcurrent: explainConcurrencySchema, maxPromptBytes: explainPromptBytesSchema.default(EXPLAIN_DEFAULT_PROMPT_BYTES) }),
    initial: { maxConcurrent: EXPLAIN_DEFAULT_CONCURRENCY, maxPromptBytes: EXPLAIN_DEFAULT_PROMPT_BYTES },
  },
  tables: {},
});

/** Resolved, effective view served to the scheduler and the status routes. */
export interface ExplainConcurrencyView {
  readonly maxConcurrent: number;
  /** TASK-123: effective prompt budget for this Host instance. */
  readonly maxPromptBytes: number;
}

/** Outcome of the single setting write entry. */
export type ExplainConcurrencyResult =
  | { readonly ok: true; readonly value: ExplainConcurrencyView }
  | { readonly ok: false; readonly code: "invalid-input" | "storage-error" };

interface OpenDomain {
  readonly global: { get(): unknown; set(value: unknown): Promise<void> };
  close(): Promise<void>;
}

/**
 * The single owner of the Explain concurrency setting (`ctx.iciExplainConfig`).
 *
 * Both the scheduler and the routes read the effective value from this one
 * service, so no caller opens the domain twice and no in-memory copy can drift
 * from the durable one: every accepted write persists FIRST and only then
 * moves the effective value and wakes the scheduler.
 */
export class ExplainConfigService extends Service {
  static inject = ["storageDomain"] as const;

  private domain: OpenDomain | undefined;
  private maxConcurrentValue: number = EXPLAIN_DEFAULT_CONCURRENCY;
  private maxPromptBytesValue: number = EXPLAIN_DEFAULT_PROMPT_BYTES;
  private readonly listeners = new Set<(maxConcurrent: number) => void>();
  private writeTail: Promise<unknown> = Promise.resolve();
  private serviceDisposed = false;

  constructor(ctx: Context) {
    super(ctx, "iciExplainConfig" as never);
    this.setMaxConcurrent = this.setMaxConcurrent.bind(this);
    this.setMaxPromptBytes = this.setMaxPromptBytes.bind(this);
    this.onChange = this.onChange.bind(this);
    this.dispose = this.dispose.bind(this);
  }

  protected async [Service.init](): Promise<void> {
    const storage = this.ctx.get("storageDomain") as
      | { open(spec: unknown): Promise<OpenDomain> }
      | undefined;
    if (storage === undefined) throw new Error("iciExplainConfig: storageDomain is unavailable");
    // Open failure (backend missing, corrupt/foreign version) must fail loud:
    // a silent fallback would either bypass the cap or overwrite the stored value.
    const domain = await storage.open(explainConfigDomain);
    try {
      // The durable read already validated through the domain schema; parse
      // again here so a bad value can never silently reset the cap.
      const stored = explainConfigDomain.global.schema.parse(domain.global.get());
      this.domain = domain;
      this.maxConcurrentValue = stored.maxConcurrent;
      this.maxPromptBytesValue = stored.maxPromptBytes;
    } catch (error) {
      await domain.close().catch(() => undefined);
      throw error;
    }
    this.ctx.effect(() => () => this.dispose(), "iciExplainConfig.dispose");
  }

  /** Effective cap for the current Host instance. */
  get maxConcurrent(): number {
    return this.maxConcurrentValue;
  }

  /** TASK-123: effective prompt budget (fallback for a Host without this config). */
  get maxPromptBytes(): number {
    return this.maxPromptBytesValue;
  }

  /** Detached view for status payloads. */
  get view(): ExplainConcurrencyView {
    return { maxConcurrent: this.maxConcurrentValue, maxPromptBytes: this.maxPromptBytesValue };
  }

  /**
   * The one write entry: validate strictly, persist through the domain, then
   * commit the effective value. Invalid input never touches storage or the
   * effective value; a persistence failure returns `storage-error` with the
   * previous value still in force.
   */
  setMaxConcurrent(input: unknown): Promise<ExplainConcurrencyResult> {
    // Acceptance happens at CALL time, not when the queued task runs: a write
    // accepted before dispose must still drain, while a post-dispose call is
    // rejected immediately.
    if (this.serviceDisposed || this.domain === undefined) return Promise.resolve({ ok: false, code: "storage-error" });
    if (typeof input !== "number" || !Number.isInteger(input)
      || input < EXPLAIN_MIN_CONCURRENCY || input > EXPLAIN_MAX_CONCURRENCY) {
      return Promise.resolve({ ok: false, code: "invalid-input" });
    }
    const domain = this.domain;
    const write = async (): Promise<ExplainConcurrencyResult> => {
      try {
        await domain.global.set({ maxConcurrent: input });
      } catch {
        return { ok: false, code: "storage-error" };
      }
      this.maxConcurrentValue = input;
      for (const listener of [...this.listeners]) {
        try {
          listener(input);
        } catch {
          // One consumer must not block the others or the committed write.
        }
      }
      return { ok: true, value: { maxConcurrent: input, maxPromptBytes: this.maxPromptBytesValue } };
    };
    const task = this.writeTail.then(write, write);
    this.writeTail = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * TASK-123: the one write entry for the prompt budget. Same discipline as the concurrency
   * value: validate strictly, persist first, then commit; an invalid input never touches storage.
   */
  setMaxPromptBytes(input: unknown): Promise<ExplainConcurrencyResult> {
    if (this.serviceDisposed || this.domain === undefined) return Promise.resolve({ ok: false, code: "storage-error" });
    if (typeof input !== "number" || !Number.isInteger(input) || input < EXPLAIN_MIN_PROMPT_BYTES || input > EXPLAIN_MAX_PROMPT_BYTES) {
      return Promise.resolve({ ok: false, code: "invalid-input" });
    }
    const domain = this.domain;
    const write = async (): Promise<ExplainConcurrencyResult> => {
      try {
        await domain.global.set({ maxConcurrent: this.maxConcurrentValue, maxPromptBytes: input });
      } catch {
        return { ok: false, code: "storage-error" };
      }
      this.maxPromptBytesValue = input;
      for (const listener of [...this.listeners]) {
        try { listener(this.maxConcurrentValue); } catch { /* one consumer must not block the others */ }
      }
      return { ok: true, value: { maxConcurrent: this.maxConcurrentValue, maxPromptBytes: input } };
    };
    const task = this.writeTail.then(write, write);
    this.writeTail = task.then(() => undefined, () => undefined);
    return task;
  }

  /** Observe committed cap changes (the scheduler uses this to fill capacity). */
  onChange(listener: (maxConcurrent: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Drain pending writes, then close the domain exactly once. */
  async dispose(): Promise<void> {
    if (this.serviceDisposed) return;
    this.serviceDisposed = true;
    this.listeners.clear();
    await this.writeTail.catch(() => undefined);
    const domain = this.domain;
    this.domain = undefined;
    await domain?.close();
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    iciExplainConfig: ExplainConfigService;
  }
}

export default ExplainConfigService;
