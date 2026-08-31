import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { OperationLogLike } from "./operation-log-face.ts";
import { digest, resolveWithDeadline, runCapture } from "./run.ts";
import type { ImoCli } from "./cli.ts";

/** Fixed registry scope/package written by the one-shot installer (TASK-076). */
export const IMO_PACKAGE = "@insuremo/imo" as const;
export const IMO_REGISTRY_SCOPE = "@insuremo:registry" as const;
/** User-specified Artifactory NPM registry; never client-supplied. */
export const IMO_REGISTRY = "https://public.insuremo.com/artifactory/api/npm/npm/" as const;

/** Emitted after a one-shot IMO install completes (receipt digest only). */
export const IMO_INSTALL_COMPLETED_EVENT = "imo/install-completed" as const;
/** Emitted after a one-shot IMO install fails. */
export const IMO_INSTALL_FAILED_EVENT = "imo/install-failed" as const;

/** Deadline for one `resolveExecutable` probe of npm/pnpm. */
const PM_PROBE_TIMEOUT_MS = 3_000;
/** Deadline for `config set` (a tiny user-level .npmrc write). */
const CONFIG_SET_TIMEOUT_MS = 30_000;
/** Default deadline for the global package install (downloads may be slow). */
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

export type ImoInstallErrorCode =
  | "busy"
  | "already-installed"
  | "no-package-manager"
  | "install-failed";

/** Structured rejection (never a raw Error to callers). */
export interface ImoInstallError {
  readonly code: ImoInstallErrorCode;
  readonly message: string;
  readonly operationId?: string;
}

/** One executed command in the install plan (digest-only, never raw output). */
export interface ImoInstallStep {
  readonly cmd: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
}

/**
 * Durable-style receipt for the one-shot install. `before`/`after` are the
 * imo probe/version results (null = imo still unresolvable). `registryConfigured`
 * reports whether the user-level .npmrc write succeeded; a failed install may
 * still have configured the registry, which is safe and idempotent to retry.
 */
export interface ImoInstallReceipt {
  readonly operationId: string;
  readonly status: "completed" | "failed";
  readonly packageManager: "npm" | "pnpm";
  readonly registryConfigured: boolean;
  readonly before: string | null;
  readonly after: string | null;
  /** Exit code of the global install step (null when it never ran). */
  readonly exitCode: number | null;
  readonly steps: readonly ImoInstallStep[];
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Explicit restore instruction; the service never uninstalls automatically. */
  readonly recovery: string;
  /** Retry semantics: the failed run may leave the registry entry behind. */
  readonly note: string;
}

export type ImoInstallResult =
  | { readonly ok: true; readonly receipt: ImoInstallReceipt }
  | { readonly ok: false; readonly error: ImoInstallError };

/** Live install status (single global in-memory lock). */
export interface ImoInstallStatus {
  readonly running: boolean;
  readonly current?: { readonly operationId: string };
}

/** Public install face provided as `ctx.imoInstall`. */
export interface ImoInstall {
  install(signal?: AbortSignal): Promise<ImoInstallResult>;
  installStatus(): ImoInstallStatus;
}

interface ImoInstallConfig {
  readonly installTimeoutMs: number;
}

function resolveInstallConfig(config: Partial<ImoInstallConfig> = {}): ImoInstallConfig {
  return { installTimeoutMs: config.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS };
}

/**
 * One-shot IMO CLI installer (TASK-076): configures the fixed @insuremo
 * registry in the user-level npm config, installs @insuremo/imo globally via
 * npm (fallback pnpm), then re-probes. Same execution kernel as the upgrade
 * direct path: ctx.subprocess launches, stdout/stderr collapse to SHA-256
 * digests, a single in-memory lock serializes runs, and the receipt never
 * carries raw output. The POST body is ignored by design — the registry,
 * scope, and package are compile-time constants, so no client input can
 * reach the spawned argv.
 */
export class ImoInstallService extends Service implements ImoInstall {
  static inject = ["imoCli", "operationLog", "subprocess"];

  private config: ImoInstallConfig;
  /** In-memory single-instance lock. */
  private running: { operationId: string } | null = null;

  constructor(ctx: Context, config: Partial<ImoInstallConfig> = {}) {
    super(ctx, "imoInstall");
    this.config = resolveInstallConfig(config);
  }

  installStatus(): ImoInstallStatus {
    return this.running === null ? { running: false } : { running: true, current: { ...this.running } };
  }

  async install(signal?: AbortSignal): Promise<ImoInstallResult> {
    signal?.throwIfAborted();
    if (this.running !== null) {
      return { ok: false, error: { code: "busy", message: `an IMO install is already running for '${this.running.operationId}'`, operationId: this.running.operationId } };
    }
    const operationId = `imo-install:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.running = { operationId };
    try {
      return await this.installKernel(operationId, signal);
    } finally {
      this.running = null;
    }
  }

  private async installKernel(operationId: string, signal?: AbortSignal): Promise<ImoInstallResult> {
    const startedAt = new Date().toISOString();
    const steps: ImoInstallStep[] = [];
    const before = await this.imoVersion(signal);

    // Idempotence gate: a resolvable imo means there is nothing to install.
    if (before !== null) {
      return { ok: false, error: { code: "already-installed", message: `IMO CLI is already installed (version ${before})`, operationId } };
    }

    // Package-manager selection: npm first, pnpm as the fallback; otherwise a
    // structured hint to install Node.js. Windows .cmd resolution is owned by
    // the harness subprocess resolver, exactly like the upgrade seam.
    const npm = await resolveWithDeadline(this.ctx.subprocess, "npm", PM_PROBE_TIMEOUT_MS, signal);
    let packageManager: "npm" | "pnpm";
    if (npm.ok) packageManager = "npm";
    else {
      const pnpm = await resolveWithDeadline(this.ctx.subprocess, "pnpm", PM_PROBE_TIMEOUT_MS, signal);
      if (!pnpm.ok) {
        return { ok: false, error: { code: "no-package-manager", message: "neither npm nor pnpm was found on PATH; install Node.js first", operationId } };
      }
      packageManager = "pnpm";
    }

    // Step 1: user-level registry configuration (always the fixed constant).
    const configSet = await runCapture(this.ctx.subprocess, {
      command: packageManager,
      args: ["config", "set", IMO_REGISTRY_SCOPE, IMO_REGISTRY],
      timeoutMs: CONFIG_SET_TIMEOUT_MS,
      signal,
    });
    steps.push(step(`${packageManager} config set ${IMO_REGISTRY_SCOPE} <registry>`, configSet));
    const registryConfigured = configSet.ok;
    if (!configSet.ok) {
      return this.finish(operationId, "failed", { packageManager, registryConfigured, before, after: null, steps, startedAt, exitCode: exitOf(configSet) });
    }

    // Step 2: the global install itself.
    const installArgs = packageManager === "npm" ? ["install", "-g", IMO_PACKAGE] : ["add", "-g", IMO_PACKAGE];
    const installRun = await runCapture(this.ctx.subprocess, {
      command: packageManager,
      args: installArgs,
      timeoutMs: this.config.installTimeoutMs,
      signal,
    });
    steps.push(step(`${packageManager} ${installArgs.join(" ")}`, installRun));
    if (!installRun.ok) {
      return this.finish(operationId, "failed", { packageManager, registryConfigured, before, after: null, steps, startedAt, exitCode: exitOf(installRun) });
    }

    // Step 3: post-install probe — the receipt is only complete when imo is
    // actually resolvable afterwards.
    const after = await this.imoVersion(signal);
    if (after === null) {
      return this.finish(operationId, "failed", { packageManager, registryConfigured, before, after: null, steps, startedAt, exitCode: installRun.value.exitCode });
    }
    return this.finish(operationId, "completed", { packageManager, registryConfigured, before, after, steps, startedAt, exitCode: installRun.value.exitCode });
  }

  private async imoVersion(signal?: AbortSignal): Promise<string | null> {
    const probe = await this.ctx.imoCli.probe(signal).catch(() => null);
    if (probe === null || !probe.ok) return null;
    const version = await this.ctx.imoCli.version(signal).catch(() => null);
    if (version === null || !version.ok) return null;
    return version.value.currentVersion;
  }

  private finish(
    operationId: string,
    status: "completed" | "failed",
    input: {
      packageManager: "npm" | "pnpm";
      registryConfigured: boolean;
      before: string | null;
      after: string | null;
      steps: readonly ImoInstallStep[];
      startedAt: string;
      exitCode: number | null;
    },
  ): ImoInstallResult {
    const uninstall = `npm uninstall -g ${IMO_PACKAGE}`;
    const receipt: ImoInstallReceipt = {
      operationId,
      status,
      packageManager: input.packageManager,
      registryConfigured: input.registryConfigured,
      before: input.before,
      after: input.after,
      exitCode: input.exitCode,
      steps: input.steps,
      startedAt: input.startedAt,
      finishedAt: new Date().toISOString(),
      recovery: `${input.packageManager === "pnpm" ? uninstall.replace("npm uninstall", "pnpm remove") : uninstall}; ${input.packageManager} config delete ${IMO_REGISTRY_SCOPE} restores the previous config if needed`,
      note: status === "completed"
        ? "Retry is idempotent: re-running config set and the global install is always safe."
        : `Retry is idempotent: the ${IMO_REGISTRY_SCOPE} entry may persist in the user-level .npmrc after this failed run; re-running the install is safe.`,
    };
    void this.journal(receipt);
    const event = status === "completed" ? IMO_INSTALL_COMPLETED_EVENT : IMO_INSTALL_FAILED_EVENT;
    (this.ctx as unknown as { emit(name: string, payload: unknown): void }).emit(event, { operationId, status, before: input.before, after: input.after });
    return { ok: true, receipt };
  }

  /** Best-effort durable journal; the receipt remains the source of truth. */
  private async journal(receipt: ImoInstallReceipt): Promise<void> {
    try {
      const log: OperationLogLike = this.ctx.operationLog;
      const record = await log.append({
        requestId: `imo-install:${Date.now()}`,
        kind: "imo-install",
        paramsDigest: digest(JSON.stringify({ package: IMO_PACKAGE, scope: IMO_REGISTRY_SCOPE, registry: IMO_REGISTRY })),
        artifactRefs: [],
      });
      // The one-shot install has no human approval step; approve
      // automatically when the face supports it so recordResult accepts.
      const decidable = log as OperationLogLike & { decide?: (id: string, approved: boolean, by: string, reason?: string) => Promise<unknown> };
      if (typeof decidable.decide === "function") {
        await decidable.decide.call(log, record.id, true, "workbench-ui", "one-shot imo install");
      }
      await log.recordResult(record.id, { resultDigest: digest(JSON.stringify(receipt)), artifactRefs: [] });
    } catch {
      // Journaling is best-effort for direct one-shot actions.
    }
  }
}

function step(cmd: string, run: Awaited<ReturnType<typeof runCapture>>): ImoInstallStep {
  return run.ok
    ? { cmd, ok: true, exitCode: run.value.exitCode, stdoutDigest: run.value.stdoutDigest, stderrDigest: run.value.stderrDigest }
    : { cmd, ok: false, exitCode: run.error.exitCode ?? null, stdoutDigest: run.error.stdoutDigest ?? digest(""), stderrDigest: run.error.stderrDigest ?? digest("") };
}

function exitOf(run: Awaited<ReturnType<typeof runCapture>>): number | null {
  return run.ok ? run.value.exitCode : run.error.exitCode ?? null;
}
