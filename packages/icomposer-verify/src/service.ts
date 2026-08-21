import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { buildVerifyArgs, invalid, isValidAuthProfile, isValidEnvironmentId, isValidKeyword, isValidWorkspaceGroovyPath, type VerifyMode } from "./cli.ts";
import { capture } from "./capture.ts";
import { parseVerifyOutput, type ReportProjection, type SearchProjection } from "./parse.ts";
import type {
  IcomposerVerifyFace,
  Result,
  UtilsListView,
  UtilsSearchView,
  VerifyErrorCode,
  VerifyReportView,
  VerifyUtilsInput,
} from "./types.ts";

const PASSTHROUGH_CODES = new Set<VerifyErrorCode>([
  "workspace-not-found",
  "invalid-workspace-id",
  "service-disposed",
  "cancelled",
]);

function err(code: VerifyErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}

type BindingEntry = {
  binding: { authProfile: string; environmentId: string } | null;
  canonicalPath: string;
};

export class IcomposerVerifyService extends Service {
  static inject = ["subprocess", "workspaceBinding", "imoAuth"] as const;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #command: string;
  readonly #timeoutMs: number;

  constructor(ctx: Context, config: { command?: string; timeoutMs?: number } = {}) {
    super(ctx, "icomposerVerify");
    this.#command = config.command ?? "imo";
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    const self = this;
    const face: IcomposerVerifyFace = Object.freeze({
      verifyUtils: (input: VerifyUtilsInput, signal?: AbortSignal) => self.verifyUtils(input, signal),
      listUtils: (input: { readonly workspaceId: string }, signal?: AbortSignal) => self.listUtils(input, signal),
      searchUtils: (input: { readonly workspaceId: string; readonly keyword: string }, signal?: AbortSignal) => self.searchUtils(input, signal),
    });
    ctx.set("icomposerVerify", face);
    ctx.effect(() => () => { self.#disposed = true; }, "icomposerVerify.dispose");
  }

  async verifyUtils(input: VerifyUtilsInput, signal?: AbortSignal): Promise<Result<VerifyReportView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    // The CLI cannot verify without a FILE (it exits asking for one), so a
    // missing file is rejected client-side with the same closed-union code.
    if (!isValidWorkspaceGroovyPath(input.file)) return err("invalid-file-path");
    return this.enqueue(() => this.runVerified<VerifyReportView>("file", input.workspaceId, signal, { file: input.file! }, (projection, base) => {
      const report = projection as ReportProjection;
      const view: VerifyReportView = Object.freeze({
        ...base,
        file: input.file!,
        valid: report.valid,
        classesChecked: report.classesChecked,
        used: report.used,
        unknownClasses: report.unknownClasses,
        invalidMethods: report.invalidMethods,
      });
      return { ok: true, value: view };
    }));
  }

  async listUtils(input: { readonly workspaceId: string }, signal?: AbortSignal): Promise<Result<UtilsListView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    return this.enqueue(() => this.runVerified<UtilsListView>("list", input.workspaceId, signal, {}, (projection, base) => {
      const list = projection as { classes: UtilsListView["classes"]; count: number; truncated: boolean };
      const view: UtilsListView = Object.freeze({ ...base, classes: list.classes, count: list.count, truncated: list.truncated });
      return { ok: true, value: view };
    }));
  }

  async searchUtils(input: { readonly workspaceId: string; readonly keyword: string }, signal?: AbortSignal): Promise<Result<UtilsSearchView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    if (typeof input.keyword !== "string" || !isValidKeyword(input.keyword)) return err("invalid-keyword");
    return this.enqueue(() => this.runVerified<UtilsSearchView>("search", input.workspaceId, signal, { keyword: input.keyword }, (projection, base) => {
      const search = projection as SearchProjection;
      const view: UtilsSearchView = Object.freeze({ ...base, query: input.keyword, matches: search.matches, count: search.count, truncated: search.truncated });
      return { ok: true, value: view };
    }));
  }

  private async runVerified<T>(
    mode: VerifyMode,
    workspaceId: string,
    signal: AbortSignal | undefined,
    payload: { file?: string; keyword?: string },
    build: (projection: unknown, base: { workspaceId: string; durationMs: number; stdoutDigest: string }) => Result<T>,
  ): Promise<Result<T>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    const started = Date.now();
    const entry = await this.bindingEntry(workspaceId, signal);
    if (!entry.ok) return entry;
    const { binding, canonicalPath } = entry.value;
    if (!binding) return err("workspace-not-bound");
    if (!isValidAuthProfile(binding.authProfile)) return err("cli-error");
    if (!isValidEnvironmentId(binding.environmentId)) return err("cli-error");
    const args = buildVerifyArgs(mode, binding.authProfile, payload);

    const auth = this.ctx.get("imoAuth" as never) as unknown as {
      prepare(request: { profile?: string; env?: string }, signal?: AbortSignal): Promise<{
        ok: boolean;
        value?: { use<T>(cb: (secret: { readonly accessToken: string }) => Promise<T> | T): Promise<T> };
        error?: { code?: string };
      }>;
    } | undefined;
    if (!auth) return err("cli-error");
    const leaseResult = await auth.prepare({ profile: binding.authProfile, env: binding.environmentId }, signal);
    if (!leaseResult.ok) return this.mapAuthError(leaseResult.error);
    try {
      return await leaseResult.value!.use(async (secret) => {
        void secret;
        const run = await capture(this.ctx.subprocess, {
          command: this.#command,
          args,
          cwd: canonicalPath,
          timeoutMs: this.#timeoutMs,
          signal,
        });
        if (!run.ok) return this.mapCliError(run.error.code);
        // `verify utils` reports an invalid Groovy file through exit code 1
        // while still printing the full JSON report — parse before failing.
        const parsed = parseVerifyOutput(run.value.stdout);
        if (!parsed.ok) {
          if (run.value.exitCode !== 0 || run.value.signal !== null) return err("command-failed");
          return err("parse-error");
        }
        const base = { workspaceId, durationMs: Date.now() - started, stdoutDigest: run.value.stdoutDigest };
        return build(parsed.value, base);
      });
    } catch {
      return err("lease-revoked");
    }
  }

  private async bindingEntry(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<Result<{ binding: BindingEntry["binding"]; canonicalPath: string }>> {
    const bindingSvc = this.ctx.get("workspaceBinding" as never) as unknown as {
      get(id: string, signal?: AbortSignal): Promise<{ ok: boolean; value?: BindingEntry; error?: { code?: unknown } }>;
    } | undefined;
    if (!bindingSvc) return err("cli-error");
    const res = await bindingSvc.get(workspaceId, signal);
    if (!res.ok) {
      const raw = (res.error as { code?: unknown } | undefined)?.code;
      const code = typeof raw === "string" ? (raw as VerifyErrorCode) : undefined;
      if (code === "workspace-not-found") return err("workspace-not-found", "workspace does not exist");
      if (code && PASSTHROUGH_CODES.has(code)) return err(code);
      return err("cli-error");
    }
    const value = res.value;
    if (!value) return err("workspace-not-found");
    return { ok: true, value: { binding: value.binding, canonicalPath: value.canonicalPath } };
  }

  private mapAuthError(error: { code?: string } | undefined): Result<never> {
    if (!error || typeof error.code !== "string") return err("cli-error");
    const code = error.code as VerifyErrorCode;
    if (code === "invalid-auth" || code === "forbidden" || code === "prepare-invalidated" || code === "lease-revoked") return err(code);
    if (code === "timeout" || code === "cancelled" || code === "parse-error" || code === "service-disposed") return err(code);
    return err("cli-error");
  }

  private mapCliError(code: string): Result<never> {
    if (code === "timeout") return err("timeout");
    if (code === "cancelled") return err("cancelled");
    if (code === "not-found" || code === "spawn-failed") return err("command-failed");
    return err("cli-error");
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => undefined, () => undefined);
    return p;
  }
}
