import { createHash } from "node:crypto";
import type {
  CollectedOutput,
  SubprocessHandle,
  SubprocessRuntime,
} from "@deepseek-ai/dsh-subprocess";

/** In-memory cap for one collected output stream (tail kept on overflow). */
export const OUTPUT_LIMIT_BYTES = 64 * 1024;
/** SIGTERM → SIGKILL escalation grace for the managed process tree. */
export const GRACE_MS = 1_000;

/** Structured failure vocabulary shared by read-only and side-effect launches. */
export type RunFailureCode =
  | "not-found"
  | "spawn-failed"
  | "non-zero-exit"
  | "timeout"
  | "cancelled";

export interface RunFailure {
  readonly code: RunFailureCode;
  readonly message: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
}

export interface RunSuccess {
  readonly executablePath: string;
  readonly stdout: CollectedOutput;
  readonly stderr: CollectedOutput;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly exitCode: number;
}

export type RunResult =
  | { readonly ok: true; readonly value: RunSuccess }
  | { readonly ok: false; readonly error: RunFailure };

export interface ResolveSuccess {
  readonly executablePath: string;
}

export type ResolveResult =
  | { readonly ok: true; readonly value: ResolveSuccess }
  | { readonly ok: false; readonly error: RunFailure };

export interface RunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** SHA-256 hex digest with a stable `sha256:` prefix. */
export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function digestOf(collected: CollectedOutput): string {
  return digest(collected.text);
}

function readCollected(handle: SubprocessHandle, stream: "stdout" | "stderr"): CollectedOutput {
  const read = handle.collected[stream]?.readFrom(0);
  if (read === undefined) return { text: "", truncated: false };
  return {
    text: read.text,
    truncated: read.lossy,
    ...(read.spillPath === undefined ? {} : { spillPath: read.spillPath }),
  };
}

/**
 * Resolve one configured executable inside a deadline. This is the read-only
 * probe: it never starts a process, only resolves + verifies the executable.
 */
export async function resolveWithDeadline(
  rt: SubprocessRuntime,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ResolveResult> {
  const { signal: deadlineSignal, cleanup, timedOut, cancelled } = deadline(timeoutMs, signal);
  try {
    const executablePath = await rt.resolveExecutable(command, undefined, deadlineSignal);
    return { ok: true, value: { executablePath } };
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: timedOut() ? "timeout" : cancelled() ? "cancelled" : "not-found",
        message: timedOut()
          ? "IMO CLI probe timed out"
          : cancelled()
            ? "IMO CLI probe was cancelled"
            : `IMO CLI executable "${command}" was not found`,
        ...(cause instanceof Error ? {} : {}),
      },
    };
  } finally {
    cleanup();
  }
}

/**
 * Run one fully-specified command to completion through `ctx.subprocess`
 * (collect mode), classify the outcome, and return digests — never raw
 * output. Executable resolution, an explicit collection spec, a grace period,
 * and an internal timeout AbortSignal are all supplied by this seam.
 */
export async function runCapture(rt: SubprocessRuntime, options: RunOptions): Promise<RunResult> {
  const { signal: deadlineSignal, cleanup, timedOut, cancelled } = deadline(options.timeoutMs, options.signal);

  let executablePath: string;
  try {
    executablePath = await rt.resolveExecutable(options.command, undefined, deadlineSignal);
  } catch (cause: unknown) {
    cleanup();
    return {
      ok: false,
      error: {
        code: timedOut() ? "timeout" : cancelled() ? "cancelled" : "not-found",
        message: timedOut()
          ? "IMO CLI operation timed out"
          : cancelled()
            ? "IMO CLI operation was cancelled"
            : `IMO CLI executable "${options.command}" was not found`,
      },
    };
  }

  let handle: SubprocessHandle;
  try {
    handle = rt.spawn({
      argv: [executablePath, ...options.args],
      cwd: process.cwd(),
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: OUTPUT_LIMIT_BYTES },
        stderr: { maxBytes: OUTPUT_LIMIT_BYTES },
      },
      graceMs: GRACE_MS,
      signal: deadlineSignal,
    });
  } catch (cause: unknown) {
    cleanup();
    return {
      ok: false,
      error: { code: "spawn-failed", message: `IMO CLI process could not be started: ${describe(cause)}` },
    };
  }

  try {
    const outcome = await handle.done;
    const stdout = readCollected(handle, "stdout");
    const stderr = readCollected(handle, "stderr");
    if (timedOut() || cancelled()) {
      return {
        ok: false,
        error: {
          code: timedOut() ? "timeout" : "cancelled",
          message: timedOut() ? "IMO CLI operation timed out" : "IMO CLI operation was cancelled",
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          stdoutDigest: digestOf(stdout),
          stderrDigest: digestOf(stderr),
        },
      };
    }
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      return {
        ok: false,
        error: {
          code: "non-zero-exit",
          message: `IMO CLI exited with code ${outcome.exitCode ?? "signal"}`,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          stdoutDigest: digestOf(stdout),
          stderrDigest: digestOf(stderr),
        },
      };
    }
    return {
      ok: true,
      value: {
        executablePath,
        stdout,
        stderr,
        stdoutDigest: digestOf(stdout),
        stderrDigest: digestOf(stderr),
        exitCode: 0,
      },
    };
  } catch (cause: unknown) {
    return {
      ok: false,
      error: { code: "spawn-failed", message: `IMO CLI process failed: ${describe(cause)}` },
    };
  } finally {
    cleanup();
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function deadline(timeoutMs: number, parent?: AbortSignal): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cancelled: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("operation timed out"));
  }, timeoutMs);
  const onAbort = (): void => {
    cancelled = true;
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelled: () => cancelled,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}
