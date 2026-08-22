import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { buildPushArgs, err, isValidChoice, isValidFiles, pushParamsDigest, resolveParamsDigest } from "./cli.ts";
import { capture } from "./capture.ts";
import { pushResultDigest, parsePushOutput, stdoutHasConflict } from "./parse.ts";
import { runPushPreview } from "./preview.ts";
import { PushJournal } from "./journal.ts";
import { bindingEntry, mapAuthError, mapCliError, resolveLease, type BindingEntry, type Lease } from "./runtime.ts";
import { releaseApplyOp, releaseBranchesOp, releaseExecuteOp, releasePreviewOp, releaseReposOp, testExecuteOp, testRunOp, type OperationLogLike, type PendingEntry, type WriteOpsDeps } from "./write-ops.ts";
import type {
  IcomposerWriteFace,
  PushErrorCode,
  PushExecution,
  PushKind,
  PushMode,
  PushPreviewInput,
  PushPreviewView,
  PushReceipt,
  PushRequestInput,
  PushRequestView,
  PushResolveInput,
  PushResolveResult,
  PushResolveView,
  PushStatusView,
  Result,
} from "./types.ts";

type OperationLogRecord = ReturnType<OperationLogLike["list"]>[number];

type PushOrResolvePending = Extract<PendingEntry, { kind: "push" | "resolve" }>;
function isPushOrResolvePending(pending: PendingEntry): pending is PushOrResolvePending {
  return pending.kind === "push" || pending.kind === "resolve";
}

function execFailure(code: PushErrorCode, message: string, operationId: string): PushExecution {
  return { ok: false, error: { code, message, operationId } };
}
function codeOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : null;
}
export class IcomposerWriteService extends Service {
  static inject = ["subprocess", "workspaceBinding", "imoAuth", "operationLog"] as const;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();
  #running: { operationId: string; kind: PushKind } | null = null;
  readonly #command: string;
  readonly #timeoutMs: number;
  #operationLog: OperationLogLike;
  #pending = new Map<string, PendingEntry>();
  #journal = new PushJournal();

  constructor(ctx: Context, config: { command?: string; timeoutMs?: number } = {}) {
    super(ctx, "icomposerWrite");
    this.#command = config.command ?? "imo";
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    const operationLog = ctx.get("operationLog" as never) as unknown as OperationLogLike | undefined;
    if (!operationLog) throw new Error("operationLog service is required");
    this.#operationLog = operationLog;
    const self = this;
    const face: IcomposerWriteFace = Object.freeze({
      pushPreview: (input: PushPreviewInput, signal?: AbortSignal) => self.pushPreview(input, signal),
      pushRequest: (input: PushRequestInput, signal?: AbortSignal) => self.pushRequest(input, signal),
      pushExecute: (operationId: string, signal?: AbortSignal) => self.pushExecute(operationId, signal),
      pushResolve: (input: PushResolveInput, signal?: AbortSignal) => self.pushResolve(input, signal),
      pushStatus: (operationId: string) => self.pushStatus(operationId),
      testRun: (input: import("./types.ts").TestRunInput, signal?: AbortSignal) => self.testRun(input, signal),
      testExecute: (operationId: string, signal?: AbortSignal) => self.testExecute(operationId, signal),
      releasePreview: (input: import("./types.ts").ReleasePreviewInput, signal?: AbortSignal) => self.releasePreview(input, signal),
      releaseRepos: (input: { readonly workspaceId: string }, signal?: AbortSignal) => self.releaseRepos(input, signal),
      releaseBranches: (input: { readonly workspaceId: string; readonly repo: string }, signal?: AbortSignal) => self.releaseBranches(input, signal),
      releaseApply: (input: import("./types.ts").ReleaseApplyInput, signal?: AbortSignal) => self.releaseApply(input, signal),
      releaseExecute: (operationId: string, signal?: AbortSignal) => self.releaseExecute(operationId, signal),
    });
    ctx.set("icomposerWrite", face);
    ctx.effect(() => () => {
      self.#disposed = true;
      self.#pending.clear();
      self.#journal.clear();
      self.#running = null;
    }, "icomposerWrite.dispose");
  }

  async pushPreview(input: PushPreviewInput, signal?: AbortSignal): Promise<Result<PushPreviewView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    if (!isValidFiles(input.files)) return err("invalid-file-path");
    return this.enqueue(() => this.previewFlow(input.batch === true ? "batch" : "current", input.workspaceId, input.files, signal));
  }

  async pushRequest(input: PushRequestInput, signal?: AbortSignal): Promise<Result<PushRequestView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    if (!isValidFiles(input.files)) return err("invalid-file-path");
    const mode: PushMode = input.batch === true ? "batch" : "current";
    return this.enqueue(async () => {
      if (this.#disposed) return err("service-disposed");
      if (signal?.aborted) return err("cancelled");
      const preview = await this.previewFlow(mode, input.workspaceId, input.files, signal);
      if (!preview.ok) return preview;
      const paramsDigest = pushParamsDigest({ mode, files: input.files, checkUsages: input.checkUsages === true, skipCompile: input.skipCompile === true });
      let record: OperationLogRecord;
      try {
        record = await this.#operationLog.append({
          requestId: `icomposer-push:${Date.now()}`, kind: "imo-icomposer-push", paramsDigest, artifactRefs: [],
        });
      } catch {
        return err("record-failed");
      }
      this.#pending.set(record.id, {
        kind: "push", operationId: record.id, workspaceId: input.workspaceId, mode, files: [...input.files],
        checkUsages: input.checkUsages === true, skipCompile: input.skipCompile === true, paramsDigest,
      });
      return { ok: true, value: { operationId: record.id, kind: "imo-icomposer-push", mode, files: [...input.files], paramsDigest, decision: "pending", preview: preview.value } };
    });
  }

  async pushExecute(operationId: string, signal?: AbortSignal): Promise<PushExecution> {
    if (this.#disposed) return execFailure("service-disposed", "iComposer write service is disposed", operationId);
    if (signal?.aborted) return execFailure("cancelled", "push execution was cancelled", operationId);
    if (!operationId || typeof operationId !== "string") return execFailure("invalid-params", "operation id is required", "");
    const record = this.#operationLog.list().find(candidate => candidate.id === operationId);
    if (record === undefined) return execFailure("missing-operation", "push operation does not exist", operationId);
    if (record.decision !== "approved") return execFailure("not-approved", "only approved push operations may run", operationId);
    if (record.resultDigest !== undefined) return execFailure("already-executed", "push operation already has a result", operationId);
    const journal = this.#journal.get(operationId);
    if (journal?.state === "executed") {
      const receipt = journal.receipt!;
      const resultDigest = journal.resultDigest!;
      try {
        await this.#operationLog.recordResult(operationId, { resultDigest, artifactRefs: [] });
      } catch (error) {
        if (codeOf(error) === "already-has-result") return execFailure("already-executed", "push operation already has a result", operationId);
        return { ok: true, receipt, evidencePending: true } as unknown as PushExecution;
      }
      return { ok: true, receipt };
    }
    if (journal?.state === "executing") return execFailure("busy", "another push attempt is already running", operationId);
    const pending = this.#pending.get(operationId);
    if (pending === undefined) return execFailure("missing-pending-input", "push parameters are unavailable; re-request the push", operationId);
    const expected = pending.kind === "push"
      ? pushParamsDigest({ mode: pending.mode, files: pending.files, checkUsages: pending.checkUsages, skipCompile: pending.skipCompile })
      : pending.kind === "resolve"
        ? resolveParamsDigest({ choice: pending.prefer, originalOperationId: pending.originalOperationId })
        : ""; // test/release entries never match a push record's digest
    if (record.paramsDigest !== expected || record.paramsDigest !== pending.paramsDigest) {
      return execFailure("operation-params-mismatch", "push operation parameters do not match", operationId);
    }
    if (this.#running !== null) return execFailure("busy", "another push is already running", operationId);
    this.#running = { operationId, kind: record.kind as PushKind };
    try {
      return await this.executePending(operationId, pending, signal);
    } finally {
      this.#running = null;
    }
  }

  async pushResolve(input: PushResolveInput, signal?: AbortSignal): Promise<PushResolveResult> {
    if (this.#disposed) return { ok: false, error: { code: "service-disposed", message: "iComposer write service is disposed" } };
    if (signal?.aborted) return { ok: false, error: { code: "cancelled", message: "push resolution was cancelled" } };
    if (!input || typeof input.operationId !== "string" || !input.operationId) return { ok: false, error: { code: "invalid-params", message: "operation id is required" } };
    if (!isValidChoice(input.choice)) return { ok: false, error: { code: "invalid-choice", message: "choice must be prefer-local, prefer-server, or cancel" } };
    if (typeof input.by !== "string" || input.by.length < 1 || input.by.length > 128) return { ok: false, error: { code: "invalid-params", message: "by is required" } };
    const record = this.#operationLog.list().find(candidate => candidate.id === input.operationId);
    if (record === undefined) return { ok: false, error: { code: "missing-operation", message: "push operation does not exist", operationId: input.operationId } };
    if (record.kind !== "imo-icomposer-push") return { ok: false, error: { code: "conflict-resolution-required", message: "only a level-one push operation can be resolved", operationId: input.operationId } };
    const journal = this.#journal.get(input.operationId);
    if (journal?.receipt?.status !== "conflict") {
      return { ok: false, error: { code: "conflict-resolution-required", message: "push operation is not in a conflicted state", operationId: input.operationId } };
    }
    const original = this.#pending.get(input.operationId);
    if (original === undefined) return { ok: false, error: { code: "missing-pending-input", message: "push parameters are unavailable; re-request the push", operationId: input.operationId } };
    return this.enqueue(() => this.resolvePending(input, original, signal));
  }

  async pushStatus(operationId: string): Promise<Result<PushStatusView>> {
    if (this.#disposed) return err("service-disposed");
    if (!operationId || typeof operationId !== "string") return err("invalid-params");
    const record = this.#operationLog.list().find(candidate => candidate.id === operationId);
    if (record === undefined) return err("missing-operation");
    const j = this.#journal.get(operationId);
    const p = this.#pending.get(operationId);
    const executed = j?.state === "executed" || record.resultDigest !== undefined;
    const status = executed && j?.receipt?.status !== undefined ? j.receipt.status : undefined;
    const view: PushStatusView = {
      operationId: record.id,
      kind: record.kind as PushKind,
      decision: record.decision,
      paramsDigest: record.paramsDigest ?? "",
      ...(record.resultDigest === undefined ? {} : { resultDigest: record.resultDigest }),
      executed,
      ...(status === undefined ? {} : { status }),
      conflictFiles: status === "conflict" && j?.receipt?.conflictFiles !== undefined ? [...j.receipt.conflictFiles] : [],
      ...(p?.kind === "resolve" ? { prefer: p.prefer, originalOperationId: p.originalOperationId } : {}),
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    };
    return { ok: true, value: view };
  }

  // ---- TASK-029: test + release ----

  get #ops(): WriteOpsDeps {
    return {
      ctx: this.ctx,
      command: this.#command,
      timeoutMs: this.#timeoutMs,
      journal: this.#journal,
      operationLog: this.#operationLog,
      pending: this.#pending,
      running: () => this.#running,
    };
  }

  async testRun(input: import("./types.ts").TestRunInput, signal?: AbortSignal): Promise<import("./types.ts").Result<import("./types.ts").TestRunView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    return this.enqueue(() => testRunOp(this.#ops, input, signal));
  }

  async testExecute(operationId: string, signal?: AbortSignal): Promise<import("./types.ts").TestExecution> {
    if (this.#disposed) return { ok: false, error: { code: "service-disposed", message: "iComposer write service is disposed", operationId } };
    if (signal?.aborted) return { ok: false, error: { code: "cancelled", message: "test execution was cancelled", operationId } };
    return this.enqueue(() => testExecuteOp(this.#ops, operationId, signal));
  }

  async releasePreview(input: import("./types.ts").ReleasePreviewInput, signal?: AbortSignal): Promise<import("./types.ts").Result<import("./types.ts").ReleasePreviewView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    return this.enqueue(() => releasePreviewOp(this.#ops, input, signal));
  }

  async releaseRepos(input: { readonly workspaceId: string }, signal?: AbortSignal): Promise<import("./types.ts").Result<import("./types.ts").ReleaseRepoView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    return this.enqueue(() => releaseReposOp(this.#ops, input.workspaceId, signal));
  }

  async releaseBranches(input: { readonly workspaceId: string; readonly repo: string }, signal?: AbortSignal): Promise<import("./types.ts").Result<import("./types.ts").ReleaseBranchView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    return this.enqueue(() => releaseBranchesOp(this.#ops, input.workspaceId, input.repo, signal));
  }

  async releaseApply(input: import("./types.ts").ReleaseApplyInput, signal?: AbortSignal): Promise<import("./types.ts").Result<import("./types.ts").ReleaseApplyView>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    return this.enqueue(() => releaseApplyOp(this.#ops, input, signal));
  }

  async releaseExecute(operationId: string, signal?: AbortSignal): Promise<import("./types.ts").ReleaseExecution> {
    if (this.#disposed) return { ok: false, error: { code: "service-disposed", message: "iComposer write service is disposed", operationId } };
    if (signal?.aborted) return { ok: false, error: { code: "cancelled", message: "release execution was cancelled", operationId } };
    return this.enqueue(() => releaseExecuteOp(this.#ops, operationId, signal));
  }

  // ---- internals ----

  private async previewFlow(mode: PushMode, workspaceId: string, files: readonly string[], signal?: AbortSignal): Promise<Result<PushPreviewView>> {
    const binding = await bindingEntry(this.ctx, workspaceId, signal);
    if (!binding.ok) return binding;
    const { binding: bound, canonicalPath } = binding.value;
    if (!bound) return err("workspace-not-bound");
    const leaseRes = await resolveLease(this.ctx, bound, signal);
    if (!leaseRes.ok) return err(leaseRes.error.code);
    try {
      return await leaseRes.value.use(async () => {
        const ran = await runPushPreview(
          { subprocess: this.ctx.subprocess, command: this.#command, timeoutMs: this.#timeoutMs, canonicalPath, authProfile: bound.authProfile, workspaceId },
          mode, files, signal,
        );
        if (!ran.ok) {
          if (ran.error.code === "parse-error") return err("parse-error");
          if (ran.error.code === "timeout" || ran.error.code === "cancelled") return err(ran.error.code as PushErrorCode);
          return err("command-failed");
        }
        return { ok: true, value: ran.value };
      });
    } catch {
      return err("lease-revoked");
    }
  }

  private async resolvePending(input: PushResolveInput, originalRaw: PendingEntry, signal?: AbortSignal): Promise<PushResolveResult> {
    if (!isPushOrResolvePending(originalRaw)) return { ok: false, error: { code: "invalid-params", message: "only push operations can be resolved" } };
    const original = originalRaw;
    if (signal?.aborted) return { ok: false, error: { code: "cancelled", message: "push resolution was cancelled" } };
    const paramsDigest = resolveParamsDigest({ choice: input.choice, originalOperationId: input.operationId });
    let record: OperationLogRecord;
    try {
      record = await this.#operationLog.append({
        requestId: `icomposer-push-resolve:${Date.now()}`, kind: "imo-icomposer-push-resolve", paramsDigest, artifactRefs: [],
      });
    } catch {
      return { ok: false, error: { code: "record-failed", message: "could not record push resolution" } };
    }
    if (input.choice === "cancel") {
      try {
        await (this.#operationLog as { decide(id: string, approved: boolean, by: string, reason?: string): Promise<OperationLogRecord> }).decide(record.id, false, input.by, "cancel");
      } catch {
        return { ok: false, error: { code: "record-failed", message: "could not finalize cancellation", operationId: record.id } };
      }
      return { ok: true, value: { operationId: record.id, kind: "imo-icomposer-push-resolve", choice: "cancel", decision: "rejected", reason: "cancel", originalOperationId: input.operationId } };
    }
    const prefer = input.choice === "prefer-local" ? "prefer-local" as const : "prefer-server" as const;
    this.#pending.set(record.id, {
      kind: "resolve", operationId: record.id, workspaceId: original.workspaceId, mode: original.mode, files: [...original.files],
      checkUsages: original.checkUsages, skipCompile: original.skipCompile, prefer, originalOperationId: input.operationId, paramsDigest,
    });
    return { ok: true, value: { operationId: record.id, kind: "imo-icomposer-push-resolve", choice: prefer, decision: "pending", originalOperationId: input.operationId, paramsDigest, mode: original.mode, files: [...original.files] } };
  }

  private async executePending(operationId: string, pendingRaw: PendingEntry, signal?: AbortSignal): Promise<PushExecution> {
    if (!isPushOrResolvePending(pendingRaw)) return execFailure("missing-pending-input", "push parameters are unavailable; re-request the push", operationId);
    const pending = pendingRaw;
    if (!this.#journal.prepare(operationId)) return execFailure("busy", "another push attempt is already running", operationId);
    if (signal?.aborted) {
      this.#journal.markOutcomeUnknown(operationId);
      return execFailure("cancelled", "push execution was cancelled", operationId);
    }
    if (!this.#journal.begin(operationId)) return execFailure("already-executed", "push operation already has a result", operationId);
    if (typeof pending.workspaceId !== "string" || !pending.workspaceId) {
      this.#journal.markOutcomeUnknown(operationId);
      return execFailure("invalid-workspace-id", "workspace id is invalid", operationId);
    }
    const binding = await bindingEntry(this.ctx, pending.workspaceId, signal);
    if (!binding.ok) {
      this.#journal.markOutcomeUnknown(operationId);
      return execFailure(binding.error.code as PushErrorCode, binding.error.message, operationId);
    }
    const { canonicalPath, binding: bound } = binding.value;
    if (!bound) {
      this.#journal.markOutcomeUnknown(operationId);
      return execFailure("workspace-not-bound", "workspace is not bound", operationId);
    }
    const leaseRes = await resolveLease(this.ctx, bound, signal);
    if (!leaseRes.ok) {
      this.#journal.markOutcomeUnknown(operationId);
      return execFailure(leaseRes.error.code, leaseRes.error.message, operationId);
    }
    try {
      return await this.runLeased(operationId, pending, canonicalPath, bound.authProfile, leaseRes.value, signal);
    } catch {
      this.#journal.markOutcomeUnknown(operationId);
      return execFailure("execution-outcome-unknown", "push outcome could not be determined; it will never be re-run", operationId);
    }
  }

  private async runLeased(operationId: string, pending: PushOrResolvePending, canonicalPath: string, authProfile: string, lease: Lease | undefined, signal?: AbortSignal): Promise<PushExecution> {
    return lease!.use(async () => {
      const run = await capture(this.ctx.subprocess, {
        command: this.#command,
        args: buildPushArgs(pending.mode, authProfile, pending.files, { dryRun: false, checkUsages: pending.checkUsages, skipCompile: pending.skipCompile, prefer: pending.kind === "resolve" ? pending.prefer : undefined }),
        cwd: canonicalPath,
        timeoutMs: this.#timeoutMs,
        signal,
      });
      if (!run.ok) {
        this.#journal.markOutcomeUnknown(operationId);
        return execFailure(mapCliError(run.error.code), "push outcome could not be determined; it will never be re-run", operationId);
      }
      const { exitCode, signal: runSignal, stdout, stdoutDigest, stderr, stderrDigest } = run.value;
      const conflict = stdoutHasConflict(stdout) || stdoutHasConflict(stderr) || (() => { const parsed = parsePushOutput(stdout, pending.files, pending.files[0]); return parsed.ok && parsed.value.conflict; })();
      const parsed = parsePushOutput(stdout, pending.files, pending.files[0]);
      const conflictFiles = parsed.ok && parsed.value.conflict ? parsed.value.conflictFiles : [];
      const status: PushReceipt["status"] = conflict ? "conflict" : runSignal !== null || exitCode !== 0 ? "failed" : "completed";
      const receipt: PushReceipt = {
        operationId,
        kind: pending.kind === "resolve" ? "imo-icomposer-push-resolve" : "imo-icomposer-push",
        mode: pending.mode,
        files: [...pending.files],
        requestedFlags: {
          ...(pending.checkUsages === true ? { checkUsages: true } : {}),
          ...(pending.skipCompile === true ? { skipCompile: true } : {}),
          ...(pending.kind === "resolve" ? { prefer: pending.prefer } : {}),
        },
        status,
        exitCode,
        signal: runSignal,
        stdoutDigest,
        stderrDigest,
        conflictFiles,
        conflictSummary: conflict ? `conflict on ${conflictFiles.length} file(s)` : "",
        pushDigest: status === "completed" ? stdoutDigest : "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      return this.recordOutcome(operationId, receipt);
    });
  }

  private async recordOutcome(operationId: string, receipt: PushReceipt): Promise<PushExecution> {
    const resultDigest = pushResultDigest(receipt);
    this.#journal.commit(operationId, receipt, resultDigest);
    this.#journal.markEventEmitted(operationId);
    try {
      await this.#operationLog.recordResult(operationId, { resultDigest, artifactRefs: [] });
    } catch (error) {
      if (codeOf(error) === "already-has-result") return execFailure("already-executed", "push operation already has a result", operationId);
      return { ok: true, receipt, evidencePending: true } as unknown as PushExecution;
    }
    return { ok: true, receipt };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => undefined, () => undefined);
    return p;
  }
}
