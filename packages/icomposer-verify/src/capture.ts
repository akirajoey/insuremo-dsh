import { createHash } from "node:crypto";
import type { SubprocessHandle, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";

/** In-memory cap for one collected output stream (tail kept on overflow). */
export const OUTPUT_LIMIT_BYTES = 64 * 1024;
/** Bounded JSON parse window for `--json` stdout. */
export const JSON_LIMIT_BYTES = 1024 * 1024;
/** SIGTERM → SIGKILL escalation grace for the managed process tree. */
export const GRACE_MS = 1_000;

export type CaptureFailureCode = "not-found" | "spawn-failed" | "timeout" | "cancelled";

export interface CaptureFailure {
  readonly code: CaptureFailureCode;
  readonly message: string;
}

export interface CaptureOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
}

export type CaptureResult =
  | { readonly ok: true; readonly value: CaptureOutcome }
  | { readonly ok: false; readonly error: CaptureFailure };

/** SHA-256 hex digest with a stable `sha256:` prefix. */
export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function readCollected(handle: SubprocessHandle, stream: "stdout" | "stderr"): string {
  return handle.collected[stream]?.readFrom(0)?.text ?? "";
}

export interface CaptureOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Run one fully-specified command to completion through `ctx.subprocess`
 * (collect mode). Unlike a strict success-only capture this returns the
 * outcome even for non-zero exits: `imo icomposer verify utils` reports an
 * invalid Groovy file through exit code 1 while still printing the full JSON
 * report on stdout. Raw output never crosses this seam — callers receive the
 * stdout text plus digests only.
 */
export async function capture(rt: SubprocessRuntime, options: CaptureOptions): Promise<CaptureResult> {
  const { signal: deadlineSignal, cleanup, timedOut, cancelled } = deadline(options.timeoutMs, options.signal);

  let executablePath: string;
  try {
    executablePath = await rt.resolveExecutable(options.command, undefined, deadlineSignal);
  } catch {
    cleanup();
    return { ok: false, error: {
      code: timedOut() ? "timeout" : cancelled() ? "cancelled" : "not-found",
      message: timedOut() ? "IMO CLI operation timed out" : cancelled() ? "IMO CLI operation was cancelled" : `IMO CLI executable "${options.command}" was not found`,
    } };
  }

  let handle: SubprocessHandle;
  try {
    handle = rt.spawn({
      argv: [executablePath, ...options.args],
      cwd: options.cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: OUTPUT_LIMIT_BYTES },
        stderr: { maxBytes: OUTPUT_LIMIT_BYTES },
      },
      graceMs: GRACE_MS,
      signal: deadlineSignal,
    });
  } catch {
    cleanup();
    return { ok: false, error: { code: "spawn-failed", message: "IMO CLI process could not be started" } };
  }

  try {
    const outcome = await handle.done;
    const stdout = readCollected(handle, "stdout");
    const stderr = readCollected(handle, "stderr");
    if (timedOut() || cancelled()) {
      return { ok: false, error: {
        code: timedOut() ? "timeout" : "cancelled",
        message: timedOut() ? "IMO CLI operation timed out" : "IMO CLI operation was cancelled",
      } };
    }
    return {
      ok: true,
      value: {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout,
        stdoutDigest: digest(stdout),
        stderrDigest: digest(stderr),
      },
    };
  } catch {
    if (timedOut() || cancelled()) {
      return { ok: false, error: {
        code: timedOut() ? "timeout" : "cancelled",
        message: timedOut() ? "IMO CLI operation timed out" : "IMO CLI operation was cancelled",
      } };
    }
    return { ok: false, error: { code: "spawn-failed", message: "IMO CLI process failed" } };
  } finally {
    cleanup();
  }
}

function deadline(timeoutMs: number, parent?: AbortSignal): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cancelled: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let settled = false;
  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => {
    if (settled) return;
    cancelled = true;
    controller.abort();
  };
  parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelled: () => cancelled,
    cleanup: () => {
      settled = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}
