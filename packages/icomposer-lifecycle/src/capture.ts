import { createHash } from "node:crypto";
import type { SubprocessHandle, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";

/** In-memory cap for one collected output stream (tail kept on overflow). */
export const OUTPUT_LIMIT_BYTES = 64 * 1024;
/** Bounded JSON parse window for `--json` stdout. */
export const JSON_LIMIT_BYTES = 1024 * 1024;
/** SIGTERM → SIGKILL escalation grace for the managed process tree. */
export const GRACE_MS = 1_000;

export type CaptureFailureCode = "not-found" | "spawn-failed" | "non-zero-exit" | "timeout" | "cancelled";

export interface CaptureFailure {
  readonly code: CaptureFailureCode;
  readonly message: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
}

export interface CaptureSuccess {
  readonly stdout: string;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly exitCode: number;
}

export type CaptureResult =
  | { readonly ok: true; readonly value: CaptureSuccess }
  | { readonly ok: false; readonly error: CaptureFailure };

/** SHA-256 hex digest with a stable `sha256:` prefix. */
export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function readCollected(handle: SubprocessHandle, stream: "stdout" | "stderr"): { text: string } {
  const read = handle.collected[stream]?.readFrom(0);
  return { text: read?.text ?? "" };
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
 * (collect mode), classify the outcome, and return digests — never raw
 * output. Unlike the shared insuremo seam this capture honours `cwd`
 * (required for workspace-scoped dry-runs).
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
    const stdout = readCollected(handle, "stdout").text;
    const stderr = readCollected(handle, "stderr").text;
    if (timedOut() || cancelled()) {
      return { ok: false, error: {
        code: timedOut() ? "timeout" : "cancelled",
        message: timedOut() ? "IMO CLI operation timed out" : "IMO CLI operation was cancelled",
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdoutDigest: digest(stdout),
        stderrDigest: digest(stderr),
      } };
    }
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      return { ok: false, error: {
        code: "non-zero-exit",
        message: `IMO CLI exited with code ${outcome.exitCode ?? "signal"}`,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdoutDigest: digest(stdout),
        stderrDigest: digest(stderr),
      } };
    }
    return { ok: true, value: { stdout, stdoutDigest: digest(stdout), stderrDigest: digest(stderr), exitCode: 0 } };
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
