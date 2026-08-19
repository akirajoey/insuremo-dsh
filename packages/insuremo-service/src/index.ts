import { basename } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import type { OperationLogLike } from "./operation-log-face.ts";
import {
  digest,
  digestOf,
  resolveWithDeadline,
  runCapture,
  type RunFailure,
} from "./run.ts";

/** Read-only + upgrade IMO CLI configuration. */
export interface Config {
  /** Bare PATH command or absolute executable path. */
  command: string;
  /** Per one-shot read deadline, including lookup and process exit. */
  timeoutMs: number;
  /** Deadline for the longer-running `imo upgrade` command. */
  upgradeTimeoutMs: number;
  /** Read-only smoke commands (argv after the executable) run after an upgrade. */
  smokeCommands: readonly (readonly string[])[];
}

/** Default read-only post-upgrade smoke battery (02 doc 3.2; none writes remote). */
export const DEFAULT_SMOKE_COMMANDS: readonly (readonly string[])[] = [
  ["--version"],
  ["auth", "--help"],
  ["auth", "prepare", "--help"],
  ["skills", "list", "--help"],
  ["skills", "list", "--json"],
  ["icomposer", "--help"],
  ["icomposer", "push", "current", "--help"],
];

/** Schemastery schema used by the Host loader. */
export const Config: z<Config> = z.object({
  command: z.string().default("imo"),
  timeoutMs: z.natural().min(1).default(15_000),
  upgradeTimeoutMs: z.natural().min(1).default(180_000),
  smokeCommands: z.array(z.array(z.string())).default(DEFAULT_SMOKE_COMMANDS),
});

/** Apply schema-mirrored defaults for a partial (loader-supplied) config. */
export function resolveConfig(config: Partial<Config> = {}): Config {
  return {
    command: config.command ?? "imo",
    timeoutMs: config.timeoutMs ?? 15_000,
    upgradeTimeoutMs: config.upgradeTimeoutMs ?? 180_000,
    smokeCommands: config.smokeCommands ?? DEFAULT_SMOKE_COMMANDS,
  };
}

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

/** Structured failures exposed by the read-only seam. */
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

/** Public read-only face provided as `ctx.imoCli`. */
export interface ImoCli {
  probe(signal?: AbortSignal): Promise<ImoResult<ImoProbe>>;
  version(signal?: AbortSignal): Promise<ImoResult<ImoVersion>>;
  upgradeCheck(signal?: AbortSignal): Promise<ImoResult<ImoUpgradeCheck>>;
}

/** Structured rejection vocabulary of the upgrade closed loop. */
export type ImoUpgradeErrorCode =
  | "busy"
  | "missing-operation"
  | "not-approved"
  | "already-executed"
  | "pre-check-failed";

/** Structured rejection (never a raw Error to callers). */
export interface ImoUpgradeError {
  readonly code: ImoUpgradeErrorCode;
  readonly message: string;
  readonly operationId?: string;
}

/** One read-only smoke command outcome (digest-only). */
export interface ImoSmokeResult {
  /** Display label, e.g. `imo auth --help`. */
  readonly cmd: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdoutDigest: string;
}

/**
 * The durable execution receipt. All raw stdout/stderr are reduced to SHA-256
 * digests; `status: 'failed'` means the upgrade command itself was non-zero or
 * timed out, while a successful upgrade may still carry `ok: false` smoke rows.
 */
export interface ImoUpgradeReceipt {
  readonly operationId: string;
  readonly status: "completed" | "failed";
  readonly before: string;
  readonly after: string;
  readonly exitCode: number | null;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly smoke: readonly ImoSmokeResult[];
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Explicit restore instruction; the service never downgrades automatically. */
  readonly recovery: string;
}

export type ImoUpgradeResult =
  | { readonly ok: true; readonly receipt: ImoUpgradeReceipt }
  | { readonly ok: false; readonly error: ImoUpgradeError };

/** Result of {@link ImoUpgrade.requestUpgrade}. */
export interface RequestUpgradeResult {
  readonly operationId: string;
  readonly paramsDigest: string;
  readonly targetVersion: string | null;
}

/** Live upgrade-loop status (single global in-memory lock). */
export interface ImoUpgradeStatus {
  readonly running: boolean;
  readonly current?: { readonly operationId: string; readonly targetVersion: string | null };
}

/** Public upgrade-loop face provided as `ctx.imoUpgrade`. */
export interface ImoUpgrade {
  requestUpgrade(targetVersion?: string, signal?: AbortSignal): Promise<RequestUpgradeResult>;
  executeUpgrade(operationId: string, signal?: AbortSignal): Promise<ImoUpgradeResult>;
  upgradeStatus(): ImoUpgradeStatus;
}

/** Emitted after an approved upgrade completes (smoke included). */
export const IMO_UPGRADE_COMPLETED_EVENT = "imo/upgrade-completed" as const;
/** Emitted after an approved upgrade command fails. */
export const IMO_UPGRADE_FAILED_EVENT = "imo/upgrade-failed" as const;

declare module "@deepseek-ai/cordis" {
  interface Context {
    imoCli: ImoCli;
    imoUpgrade: ImoUpgrade;
    operationLog: OperationLogLike;
  }
}

/** Services required by this Host-only package. */
export const inject = ["subprocess", "operationLog"];

/** Loader-facing plugin name. */
export const name = "@icomposer/insuremo-service";

function mapRunFailure(error: RunFailure, command: string, args: readonly string[]): ImoCliError {
  return {
    code: error.code,
    message: error.message,
    command,
    args,
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    ...(error.signal === undefined ? {} : { signal: error.signal }),
    ...(error.stdoutDigest === undefined ? {} : { stdoutDigest: error.stdoutDigest }),
    ...(error.stderrDigest === undefined ? {} : { stderrDigest: error.stderrDigest }),
  };
}

/**
 * Read-only IMO CLI service. Every process operation routes through
 * `ctx.subprocess` (via the shared runner); no environment is passed, and raw
 * output never leaves the package.
 */
export class ImoCliService extends Service implements ImoCli {
  static inject = ["subprocess"];
  static Config = Config;

  private readonly config: Config;

  constructor(ctx: Context, config: Partial<Config> = {}) {
    super(ctx, "imoCli");
    this.config = resolveConfig(config);
  }

  async probe(signal?: AbortSignal): Promise<ImoResult<ImoProbe>> {
    const run = await resolveWithDeadline(
      this.ctx.subprocess,
      this.config.command,
      this.config.timeoutMs,
      signal,
    );
    if (!run.ok) return { ok: false, error: mapRunFailure(run.error, this.config.command, []) };
    return { ok: true, value: { command: this.config.command, executablePath: run.value.executablePath } };
  }

  async version(signal?: AbortSignal): Promise<ImoResult<ImoVersion>> {
    const args = ["--version"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return { ok: false, error: mapRunFailure(run.error, this.config.command, args) };
    const currentVersion = firstVersion(run.value.stdout.text);
    if (currentVersion === undefined) {
      return {
        ok: false,
        error: {
          code: "parse-error",
          message: "version output did not contain a semantic version",
          command: this.config.command,
          args,
          stdoutDigest: run.value.stdoutDigest,
          stderrDigest: run.value.stderrDigest,
        },
      };
    }
    return {
      ok: true,
      value: {
        executablePath: run.value.executablePath,
        currentVersion,
        stdoutDigest: run.value.stdoutDigest,
      },
    };
  }

  async upgradeCheck(signal?: AbortSignal): Promise<ImoResult<ImoUpgradeCheck>> {
    const args = ["upgrade", "--check"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return { ok: false, error: mapRunFailure(run.error, this.config.command, args) };
    const parsed = parseUpgradeOutput(run.value.stdout.text);
    if (parsed === undefined) {
      return {
        ok: false,
        error: {
          code: "parse-error",
          message: "upgrade-check output could not be parsed",
          command: this.config.command,
          args,
          stdoutDigest: run.value.stdoutDigest,
          stderrDigest: run.value.stderrDigest,
        },
      };
    }
    return {
      ok: true,
      value: {
        executablePath: run.value.executablePath,
        ...parsed,
        stdoutDigest: run.value.stdoutDigest,
      },
    };
  }
}

/**
 * Approved, single-instance IMO upgrade loop. The durable record lives in the
 * operation log; this service owns the side-effect execution, the smoke
 * battery, the digest-only receipt, and the release-once lock.
 */
export class ImoUpgradeService extends Service implements ImoUpgrade {
  static inject = ["imoCli", "operationLog", "subprocess"];
  static Config = Config;

  private readonly config: Config;
  /** In-memory single-instance lock plus the requested target per operation. */
  private running: { operationId: string; targetVersion: string | null } | null = null;
  /** POC single-process: requested target by operation id (never durable). */
  private readonly targets = new Map<string, string | null>();

  constructor(ctx: Context, config: Partial<Config> = {}) {
    super(ctx, "imoUpgrade");
    this.config = resolveConfig(config);
  }

  async requestUpgrade(targetVersion?: string, signal?: AbortSignal): Promise<RequestUpgradeResult> {
    signal?.throwIfAborted();
    const paramsDigest = digest(JSON.stringify({ targetVersion: targetVersion ?? null }));
    const record = await this.ctx.operationLog.append({
      requestId: `imo-upgrade:${Date.now()}`,
      kind: "imo-upgrade",
      paramsDigest,
      artifactRefs: [],
    });
    this.targets.set(record.id, targetVersion ?? null);
    return {
      operationId: record.id,
      paramsDigest,
      targetVersion: targetVersion ?? null,
    };
  }

  upgradeStatus(): ImoUpgradeStatus {
    return this.running === null
      ? { running: false }
      : { running: true, current: { ...this.running } };
  }

  async executeUpgrade(operationId: string, signal?: AbortSignal): Promise<ImoUpgradeResult> {
    const record = this.ctx.operationLog.list().find((candidate) => candidate.id === operationId);
    if (record === undefined) {
      return { ok: false, error: { code: "missing-operation", message: `operation '${operationId}' does not exist`, operationId } };
    }
    // Approval gate is decided BEFORE any process is started.
    if (record.decision !== "approved") {
      return { ok: false, error: { code: "not-approved", message: `operation '${operationId}' is ${record.decision}, only approved operations may run`, operationId } };
    }
    if (record.resultDigest !== undefined) {
      return { ok: false, error: { code: "already-executed", message: `operation '${operationId}' already executed`, operationId } };
    }
    if (this.running !== null) {
      return { ok: false, error: { code: "busy", message: `an IMO upgrade is already running for '${this.running.operationId}'`, operationId } };
    }
    this.running = { operationId, targetVersion: this.requestedTarget(operationId) };
    const startedAt = new Date().toISOString();
    try {
      const before = await this.readVersion(signal);
      if (before === undefined) {
        return { ok: false, error: { code: "pre-check-failed", message: "could not read the current IMO version before upgrade", operationId } };
      }

      const upgradeArgs = this.running.targetVersion === null
        ? ["upgrade", "--yes"]
        : ["upgrade", "--version", this.running.targetVersion, "--yes"];
      const run = await runCapture(this.ctx.subprocess, {
        command: this.config.command,
        args: upgradeArgs,
        timeoutMs: this.config.upgradeTimeoutMs,
        signal,
      });
      const stdoutDigest = run.ok ? run.value.stdoutDigest : (run.error.stdoutDigest ?? digest(""));
      const stderrDigest = run.ok ? run.value.stderrDigest : (run.error.stderrDigest ?? digest(""));
      const exitCode = run.ok ? run.value.exitCode : (run.error.exitCode ?? null);
      const after = (await this.readVersion(signal)) ?? before;

      if (!run.ok) {
        return await this.finish("failed", operationId, {
          before, after, exitCode, stdoutDigest, stderrDigest,
          smoke: [], startedAt,
        }, signal);
      }

      const smoke: ImoSmokeResult[] = [];
      for (const args of this.config.smokeCommands) {
        const smokeRun = await runCapture(this.ctx.subprocess, {
          command: this.config.command,
          args,
          timeoutMs: this.config.timeoutMs,
          signal,
        });
        smoke.push({
          cmd: `${basename(run.value.executablePath)} ${args.join(" ")}`,
          ok: smokeRun.ok,
          exitCode: smokeRun.ok ? smokeRun.value.exitCode : (smokeRun.error.exitCode ?? null),
          stdoutDigest: smokeRun.ok ? smokeRun.value.stdoutDigest : (smokeRun.error.stdoutDigest ?? digest("")),
        });
      }
      return await this.finish("completed", operationId, {
        before, after, exitCode, stdoutDigest, stderrDigest, smoke, startedAt,
      }, signal);
    } finally {
      this.running = null;
    }
  }

  private async finish(
    status: "completed" | "failed",
    operationId: string,
    input: {
      before: string;
      after: string;
      exitCode: number | null;
      stdoutDigest: string;
      stderrDigest: string;
      smoke: readonly ImoSmokeResult[];
      startedAt: string;
    },
    signal: AbortSignal | undefined,
  ): Promise<ImoUpgradeResult> {
    const receipt: ImoUpgradeReceipt = {
      operationId,
      status,
      before: input.before,
      after: input.after,
      exitCode: input.exitCode,
      stdoutDigest: input.stdoutDigest,
      stderrDigest: input.stderrDigest,
      smoke: input.smoke,
      startedAt: input.startedAt,
      finishedAt: new Date().toISOString(),
      recovery: `恢复命令：imo upgrade --version ${input.before} --yes`,
    };
    const resultDigest = digest(JSON.stringify(receipt));
    try {
      await this.ctx.operationLog.recordResult(operationId, { resultDigest, artifactRefs: [] });
    } catch (error) {
      if (codeOf(error) === "already-has-result") {
        return { ok: false, error: { code: "already-executed", message: `operation '${operationId}' already has a recorded result`, operationId } };
      }
      throw error;
    }
    this.ctx.emit(
      status === "completed" ? IMO_UPGRADE_COMPLETED_EVENT : IMO_UPGRADE_FAILED_EVENT,
      { operationId, receipt },
    );
    return { ok: true, receipt };
  }

  private async readVersion(signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.ctx.imoCli.version(signal);
    return result.ok ? result.value.currentVersion : undefined;
  }

  private requestedTarget(operationId: string): string | null {
    return this.targets.get(operationId) ?? null;
  }
}

function codeOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}

function firstVersion(output: string): string | undefined {
  const VERSION_PATTERN = /(?:^|[^\d])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\d.])/g;
  return [...output.matchAll(VERSION_PATTERN)][0]?.[1];
}

interface ParsedUpgrade {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly updateAvailable: boolean;
}

function parseUpgradeOutput(output: string): ParsedUpgrade | undefined {
  const VERSION_PATTERN = /(?:^|[^\d])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\d.])/g;
  const current = output.match(/current(?:\s+version)?\s*[:=]\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)?.[1]
    ?? [...output.matchAll(VERSION_PATTERN)][0]?.[1];
  if (current === undefined) return undefined;
  const target = output.match(/(?:new|latest|target|available)\s+version\s*[:=]\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)?.[1]
    ?? [...output.matchAll(VERSION_PATTERN)][1]?.[1]
    ?? current;
  const noUpdate = /(?:up[ -]?to[ -]?date|no\s+(?:new\s+)?version|already\s+(?:on|at)\s+latest)/i.test(output);
  const updateAvailable = !noUpdate && (
    (/(?:new|latest|target|available)\s+version/i.test(output) && target !== current)
      || /(?:update|upgrade)\s+available/i.test(output)
  );
  return { currentVersion: current, targetVersion: target, updateAvailable };
}

/** Mount both Host service fibers; the package-level config is loader-optional. */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const merged = resolveConfig(config);
  ctx.plugin(ImoCliService, merged);
  ctx.plugin(ImoUpgradeService, merged as never);
}

export default ImoCliService;
