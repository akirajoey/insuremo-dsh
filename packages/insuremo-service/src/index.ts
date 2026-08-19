import { createHash } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type {
  CollectedOutput,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
} from "@deepseek-ai/dsh-subprocess";
import type { Context } from "@deepseek-ai/cordis";

/** Read-only IMO CLI configuration. */
export interface Config {
  /** Bare PATH command or absolute executable path. */
  command: string;
  /** Per-operation deadline, including executable lookup and process exit. */
  timeoutMs: number;
}

/** Schemastery schema used by the Host loader. */
export const Config: z<Config> = z.object({
  command: z.string().default("imo"),
  timeoutMs: z.natural().min(1).default(15_000),
});

/** Stable read-only probe result. */
export interface ImoProbe {
  readonly command: string;
  readonly executablePath: string;
}

/** Parsed `imo --version` result with a digest instead of raw output. */
export interface ImoVersion {
  readonly executablePath: string;
  readonly currentVersion: string;
  readonly stdoutDigest: string;
}

/** Parsed `imo upgrade --check` result with a digest instead of raw output. */
export interface ImoUpgradeCheck {
  readonly executablePath: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly updateAvailable: boolean;
  readonly stdoutDigest: string;
}

/** Structured failures exposed to Workbench consumers; raw subprocess errors never cross this boundary. */
export type ImoCliErrorCode =
  | "not-found"
  | "spawn-failed"
  | "non-zero-exit"
  | "timeout"
  | "cancelled"
  | "parse-error";

/** Digest-only structured failure. */
export interface ImoCliError {
  readonly code: ImoCliErrorCode;
  readonly message: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
}

/** Result envelope used by all read-only IMO operations. */
export type ImoResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ImoCliError };

/** Public service face provided as `ctx.imoCli`. */
export interface ImoCli {
  probe(signal?: AbortSignal): Promise<ImoResult<ImoProbe>>;
  version(signal?: AbortSignal): Promise<ImoResult<ImoVersion>>;
  upgradeCheck(signal?: AbortSignal): Promise<ImoResult<ImoUpgradeCheck>>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    imoCli: ImoCli;
  }
}

/** Services required by this Host-only package. */
export const inject = ["subprocess"];

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const GRACE_MS = 1_000;
const VERSION_PATTERN = /(?:^|[^\d])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\d.])/g;

interface OperationDeadline {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly cancelled: () => boolean;
  dispose(): void;
}

interface ExecutedCommand {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly outcome: SubprocessOutcome;
  readonly stdout: CollectedOutput;
  readonly stderr: CollectedOutput;
}

/** Host IMO CLI service. Every process operation routes through `ctx.subprocess`. */
export class ImoCliService extends Service implements ImoCli {
  static inject = inject;
  static Config = Config;

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, "imoCli");
  }

  async probe(signal?: AbortSignal): Promise<ImoResult<ImoProbe>> {
    const deadline = this.deadline(signal);
    try {
      const executablePath = await this.ctx.subprocess.resolveExecutable(
        this.config.command,
        undefined,
        deadline.signal,
      );
      return { ok: true, value: { command: this.config.command, executablePath } };
    } catch (error: unknown) {
      return { ok: false, error: this.errorFromFailure(deadline, "probe", [], error) };
    } finally {
      deadline.dispose();
    }
  }

  async version(signal?: AbortSignal): Promise<ImoResult<ImoVersion>> {
    const args = ["--version"] as const;
    const executed = await this.execute(args, signal);
    if (!executed.ok) return executed;
    const currentVersion = firstVersion(executed.value.stdout.text);
    if (currentVersion === undefined) {
      return {
        ok: false,
        error: {
          ...this.baseError("parse-error", "version output did not contain a semantic version", args),
          stdoutDigest: digest(executed.value.stdout.text),
          stderrDigest: digest(executed.value.stderr.text),
        },
      };
    }
    return {
      ok: true,
      value: {
        executablePath: executed.value.executablePath,
        currentVersion,
        stdoutDigest: digest(executed.value.stdout.text),
      },
    };
  }

  async upgradeCheck(signal?: AbortSignal): Promise<ImoResult<ImoUpgradeCheck>> {
    const args = ["upgrade", "--check"] as const;
    const executed = await this.execute(args, signal);
    if (!executed.ok) return executed;
    const parsed = parseUpgradeOutput(executed.value.stdout.text);
    if (parsed === undefined) {
      return {
        ok: false,
        error: {
          ...this.baseError("parse-error", "upgrade-check output could not be parsed", args),
          stdoutDigest: digest(executed.value.stdout.text),
          stderrDigest: digest(executed.value.stderr.text),
        },
      };
    }
    return {
      ok: true,
      value: {
        executablePath: executed.value.executablePath,
        ...parsed,
        stdoutDigest: digest(executed.value.stdout.text),
      },
    };
  }

  private async execute(args: readonly string[], signal?: AbortSignal): Promise<ImoResult<ExecutedCommand>> {
    const deadline = this.deadline(signal);
    let executablePath: string;
    try {
      executablePath = await this.ctx.subprocess.resolveExecutable(
        this.config.command,
        undefined,
        deadline.signal,
      );
    } catch (error: unknown) {
      const code = this.failureCode(deadline, "not-found");
      const failure = this.errorFromFailure(deadline, "execute", args, error, code);
      deadline.dispose();
      return { ok: false, error: failure };
    }

    let handle: SubprocessHandle;
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [executablePath, ...args],
        cwd: process.cwd(),
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: OUTPUT_LIMIT_BYTES },
          stderr: { maxBytes: OUTPUT_LIMIT_BYTES },
        },
        graceMs: GRACE_MS,
        signal: deadline.signal,
      });
    } catch (error: unknown) {
      const failure = this.errorFromFailure(deadline, "execute", args, error, "spawn-failed");
      deadline.dispose();
      return { ok: false, error: failure };
    }

    try {
      const outcome = await handle.done;
      const stdout = collected(handle, "stdout");
      const stderr = collected(handle, "stderr");
      if (deadline.timedOut() || deadline.cancelled()) {
        const code = this.failureCode(deadline, "cancelled");
        return {
          ok: false,
          error: {
            ...this.baseError(code, code === "timeout" ? "IMO CLI operation timed out" : "IMO CLI operation was cancelled", args),
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            stdoutDigest: digest(stdout.text),
            stderrDigest: digest(stderr.text),
          },
        };
      }
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        return {
          ok: false,
          error: {
            ...this.baseError("non-zero-exit", "IMO CLI exited unsuccessfully", args),
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            stdoutDigest: digest(stdout.text),
            stderrDigest: digest(stderr.text),
          },
        };
      }
      return { ok: true, value: { executablePath, args, outcome, stdout, stderr } };
    } catch (error: unknown) {
      return { ok: false, error: this.errorFromFailure(deadline, "execute", args, error, "spawn-failed") };
    } finally {
      deadline.dispose();
    }
  }

  private deadline(parent?: AbortSignal): OperationDeadline {
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("IMO CLI operation timed out"));
    }, this.config.timeoutMs);
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
      dispose: () => {
        clearTimeout(timer);
        parent?.removeEventListener("abort", onAbort);
      },
    };
  }

  private failureCode(deadline: OperationDeadline, fallback: ImoCliErrorCode): ImoCliErrorCode {
    if (deadline.timedOut()) return "timeout";
    if (deadline.cancelled()) return "cancelled";
    return fallback;
  }

  private errorFromFailure(
    deadline: OperationDeadline,
    operation: string,
    args: readonly string[],
    error: unknown,
    fallback: ImoCliErrorCode = "not-found",
  ): ImoCliError {
    const code = this.failureCode(deadline, fallback);
    return this.baseError(
      code,
      code === "timeout"
        ? `IMO CLI ${operation} timed out`
        : code === "cancelled"
          ? `IMO CLI ${operation} was cancelled`
          : code === "not-found"
            ? "IMO CLI executable was not found"
            : code === "spawn-failed"
              ? "IMO CLI process could not be started"
              : error instanceof Error ? error.message : "IMO CLI operation failed",
      args,
    );
  }

  private baseError(code: ImoCliErrorCode, message: string, args: readonly string[]): ImoCliError {
    return { code, message, command: this.config.command, args };
  }
}

function collected(handle: SubprocessHandle, stream: "stdout" | "stderr"): CollectedOutput {
  const read = handle.collected[stream]?.readFrom(0);
  return read === undefined
    ? { text: "", truncated: false }
    : { text: read.text, truncated: read.lossy, ...(read.spillPath === undefined ? {} : { spillPath: read.spillPath }) };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function firstVersion(output: string): string | undefined {
  return [...output.matchAll(VERSION_PATTERN)][0]?.[1];
}

interface ParsedUpgrade {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly updateAvailable: boolean;
}

function parseUpgradeOutput(output: string): ParsedUpgrade | undefined {
  const current = output.match(/current(?:\s+version)?\s*[:=]\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)?.[1]
    ?? firstVersion(output);
  if (current === undefined) return undefined;
  const target = output.match(/(?:new|latest|target|available)\s+version\s*[:=]\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)?.[1]
    ?? [...output.matchAll(VERSION_PATTERN)][1]?.[1]
    ?? current;
  const noUpdate = /(?:up[ -]?to[ -]?date|no\s+(?:new\s+)?version|already\s+(?:on|at)\s+latest)/i.test(output);
  const updateAvailable = !noUpdate && (
    /(?:new|latest|target|available)\s+version/i.test(output) && target !== current
      || /(?:update|upgrade)\s+available/i.test(output)
  );
  return { currentVersion: current, targetVersion: target, updateAvailable };
}

export default ImoCliService;
