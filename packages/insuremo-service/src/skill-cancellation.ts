/** Fixed cancellation boundary shared by the Skills inventory and catalog. */
export class SkillAbortError extends Error {
  readonly code = "cancelled" as const;

  constructor() {
    super("IMO Skills operation was cancelled");
    this.name = "AbortError";
  }
}

export interface MergedSkillCancellation {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Merge caller and provider lifecycle signals without forwarding either reason. */
export function mergeSkillSignals(...signals: readonly (AbortSignal | undefined)[]): MergedSkillCancellation {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const signal of signals) {
    if (signal === undefined) continue;
    if (signal.aborted) abort();
    else {
      const listener = (): void => abort();
      signal.addEventListener("abort", listener, { once: true });
      listeners.push(() => signal.removeEventListener("abort", listener));
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) remove();
      listeners.length = 0;
    },
  };
}

/** Race an uncooperative provider operation against a fixed cancellation error. */
export function raceSkillAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SkillAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SkillAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function throwIfSkillAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SkillAbortError();
}

export function isSkillAbortError(error: unknown): error is SkillAbortError {
  return error instanceof SkillAbortError
    || (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "cancelled");
}
