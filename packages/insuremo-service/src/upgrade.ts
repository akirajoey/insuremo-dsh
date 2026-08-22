import { basename } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { OperationLogLike } from "./operation-log-face.ts";
import { Config, resolveConfig, type Config as ImoConfig } from "./config.ts";
import { digest, runCapture } from "./run.ts";
import type { ImoCli } from "./cli.ts";

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
  /** One-shot direct execution (TASK-039): no operation record, same kernel. */
  executeDirect(targetVersion: string | undefined, signal?: AbortSignal): Promise<ImoUpgradeResult>;
  upgradeStatus(): ImoUpgradeStatus;
}

/** Emitted after an approved upgrade completes (smoke included). */
export const IMO_UPGRADE_COMPLETED_EVENT = "imo/upgrade-completed" as const;
/** Emitted after an approved upgrade command fails. */
export const IMO_UPGRADE_FAILED_EVENT = "imo/upgrade-failed" as const;

export class ImoUpgradeService extends Service implements ImoUpgrade {
  static inject = ["imoCli", "operationLog", "subprocess"];
  static Config = Config;

  private readonly config: ImoConfig;
  /** In-memory single-instance lock plus the requested target per operation. */
  private running: { operationId: string; targetVersion: string | null } | null = null;
  /** POC single-process: requested target by operation id (never durable). */
  private readonly targets = new Map<string, string | null>();

  constructor(ctx: Context, config: Partial<ImoConfig> = {}) {
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

  /**
   * Direct one-shot upgrade for the UI (TASK-039): same kernel as
   * request→approve→execute, but no operation record is created. The
   * single-flight lock and the smoke verification are shared.
   */
  async executeDirect(targetVersion: string | undefined, signal?: AbortSignal): Promise<ImoUpgradeResult> {
    signal?.throwIfAborted();
    if (this.running !== null) {
      return { ok: false, error: { code: "busy", message: `an IMO upgrade is already running for '${this.running.operationId}'`, operationId: this.running.operationId } };
    }
    const operationId = `direct-upgrade:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.targets.set(operationId, targetVersion ?? null);
    this.running = { operationId, targetVersion: targetVersion ?? null };
    try {
      return await this.executeUpgradeKernel(operationId, signal);
    } finally {
      this.running = null;
    }
  }

  private async executeUpgradeKernel(operationId: string, signal?: AbortSignal): Promise<ImoUpgradeResult> {
    const startedAt = new Date().toISOString();
    const before = await this.readVersion(signal);
    if (before === undefined) {
      return { ok: false, error: { code: "pre-check-failed", message: "could not read the current IMO version before upgrade", operationId } };
    }

    const upgradeArgs = this.running!.targetVersion === null
      ? ["upgrade", "--yes"]
      : ["upgrade", "--version", this.running!.targetVersion, "--yes"];
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
      return this.finishDirect("failed", operationId, { before, after, exitCode, stdoutDigest, stderrDigest, smoke: [], startedAt });
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
    return this.finishDirect("completed", operationId, { before, after, exitCode, stdoutDigest, stderrDigest, smoke, startedAt });
  }

  /** Direct settlement: receipt returned in-memory only (no durable record). */
  private async finishDirect(
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
      recovery: `imo upgrade --version ${input.before} restores the previous version if needed`,
    };
    const event = status === "completed" ? IMO_UPGRADE_COMPLETED_EVENT : IMO_UPGRADE_FAILED_EVENT;
    (this.ctx as unknown as { emit(name: string, payload: unknown): void }).emit(event, { operationId, status, before: input.before, after: input.after });
    return { ok: true, receipt };
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


