import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { capture } from "./capture.ts";
import { buildInitArgs, invalid, isValidAuthProfile, isValidEnvironmentId, isValidGroupId } from "./cli.ts";
import { scanReloadPreview } from "./join.ts";
import { parseInitOutput } from "./parse.ts";
import type {
  IcomposerLifecycleFace,
  InitPreviewInput,
  InitPreviewView,
  LifecycleErrorCode,
  ReloadPreviewView,
  Result,
} from "./types.ts";

const PASSTHROUGH_CODES = new Set<LifecycleErrorCode>([
  "workspace-not-found",
  "invalid-workspace-id",
  "service-disposed",
  "cancelled",
]);

function err(code: LifecycleErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}

type BindingEntry = {
  binding: { authProfile: string; environmentId: string } | null;
  canonicalPath: string;
};

export class IcomposerLifecycleService extends Service {
  static inject = ["subprocess", "workspaceBinding", "imoAuth"] as const;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #command: string;
  readonly #timeoutMs: number;

  constructor(ctx: Context, config: { command?: string; timeoutMs?: number } = {}) {
    super(ctx, "icomposerLifecycle");
    this.#command = config.command ?? "imo";
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    const self = this;
    const face: IcomposerLifecycleFace = Object.freeze({
      initPreview: (input: InitPreviewInput, signal?: AbortSignal) => self.initPreview(input, signal),
      reloadPreview: (input: { readonly workspaceId: string }, signal?: AbortSignal) => self.reloadPreview(input, signal),
    });
    ctx.set("icomposerLifecycle", face);
    ctx.effect(() => () => { self.#disposed = true; }, "icomposerLifecycle.dispose");
  }

  async initPreview(input: InitPreviewInput, signal?: AbortSignal): Promise<Result<InitPreviewView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    if (!isValidGroupId(input.groupId)) return err("invalid-group-id");
    return this.enqueue(async () => {
      if (this.#disposed) return err("service-disposed");
      if (signal?.aborted) return err("cancelled");
      const started = Date.now();
      const entry = await this.bindingEntry(input.workspaceId, signal);
      if (!entry.ok) return entry;
      const { binding, canonicalPath } = entry.value;
      if (!binding) return err("workspace-not-bound");
      if (!isValidAuthProfile(binding.authProfile)) return err("cli-error");
      if (!isValidEnvironmentId(binding.environmentId)) return err("cli-error");
      const args = buildInitArgs(input, binding.authProfile);

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
          if (!run.ok) return this.mapCliError(run.error);
          const parsed = parseInitOutput(run.value.stdout);
          if (!parsed.ok) return err("parse-error");
          const base = {
            workspaceId: input.workspaceId,
            durationMs: Date.now() - started,
            stdoutDigest: run.value.stdoutDigest,
          };
          if (parsed.value.mode === "groups") {
            const view: InitPreviewView = Object.freeze({
              ...base,
              mode: "groups",
              groups: parsed.value.groups,
              count: parsed.value.count,
              truncated: parsed.value.truncated,
            });
            return { ok: true, value: view };
          }
          const view: InitPreviewView = Object.freeze({
            ...base,
            mode: "plan",
            groupId: parsed.value.groupId,
            steps: parsed.value.steps,
            count: parsed.value.count,
            truncated: parsed.value.truncated,
          });
          return { ok: true, value: view };
        });
      } catch {
        return err("lease-revoked");
      }
    });
  }

  async reloadPreview(input: { readonly workspaceId: string }, signal?: AbortSignal): Promise<Result<ReloadPreviewView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    return this.enqueue(async () => {
      if (this.#disposed) return err("service-disposed");
      if (signal?.aborted) return err("cancelled");
      const entry = await this.bindingEntry(input.workspaceId, signal);
      if (!entry.ok) return entry;
      const { binding, canonicalPath } = entry.value;
      if (!binding) return err("workspace-not-bound");
      const scan = await scanReloadPreview(canonicalPath, signal);
      if (signal?.aborted) return err("cancelled");
      const view: ReloadPreviewView = Object.freeze({
        workspaceId: input.workspaceId,
        distribution: Object.freeze({ ...scan.distribution }),
        total: scan.total,
        top: Object.freeze(scan.top),
        scannedAt: new Date().toISOString(),
      });
      return { ok: true, value: view };
    });
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
      const code = typeof raw === "string" ? (raw as LifecycleErrorCode) : undefined;
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
    const code = error.code as LifecycleErrorCode;
    if (code === "invalid-auth" || code === "forbidden" || code === "prepare-invalidated" || code === "lease-revoked") {
      return err(code);
    }
    if (code === "timeout" || code === "cancelled" || code === "parse-error" || code === "service-disposed") {
      return err(code);
    }
    return err("cli-error");
  }

  private mapCliError(error: { code?: string } | undefined): Result<never> {
    if (!error || typeof error.code !== "string") return err("command-failed");
    const code = error.code as LifecycleErrorCode;
    if (code === "timeout" || code === "cancelled") return err(code);
    return err("command-failed");
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => undefined, () => undefined);
    return p;
  }
}
