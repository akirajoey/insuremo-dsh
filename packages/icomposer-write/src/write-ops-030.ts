import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { capture } from "./capture.ts";
import {
  buildCreateArgs,
  buildCreateOptionsArgs,
  buildMetadataArgs,
  createParamsDigest,
  isValidFiles,
  isValidWorkspaceGroovyPath,
  metadataFieldsApplied,
  metadataParamsDigest,
  validateCreateParams,
  validateMetadataFields,
  type CreateParamsShape,
} from "./cli.ts";
import { parseCreateOptions, parseReleaseApply } from "./parse.ts";
import { bindingEntry, mapCliError, resolveLease } from "./runtime.ts";
import type { WriteOpsDeps, OperationLogRecord } from "./write-ops.ts";
import type {
  CreateExecution,
  CreateOptionsView,
  CreatePreviewInput,
  CreatePreviewView,
  CreateReceipt,
  CreateRequestView,
  MetadataExecution,
  MetadataFields,
  MetadataPreviewInput,
  MetadataPreviewView,
  MetadataReceipt,
  MetadataRequestView,
  PushErrorCode,
  Result,
} from "./types.ts";

function failure<T>(code: PushErrorCode, message: string, operationId?: string): T {
  return { ok: false, error: { code, message, ...(operationId === undefined ? {} : { operationId }) } } as unknown as T;
}
function codeOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : null;
}

type PendingCreateEntry = { readonly kind: "create"; readonly operationId: string; readonly workspaceId: string; readonly shape: CreateParamsShape; readonly paramsDigest: string };
type PendingMetadataEntry = { readonly kind: "metadata"; readonly operationId: string; readonly workspaceId: string; readonly file: string; readonly fields: MetadataFields; readonly paramsDigest: string };
type CreatePendingEntry = PendingCreateEntry | PendingMetadataEntry;

function asCreatePending(deps: WriteOpsDeps, operationId: string): CreatePendingEntry | undefined {
  const pending = deps.pending.get(operationId);
  if (pending === undefined || (pending.kind !== "create" && pending.kind !== "metadata")) return undefined;
  return pending as unknown as CreatePendingEntry;
}

async function runCli(rt: SubprocessRuntime, command: string, args: readonly string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CliOutcome> {
  const run = await capture(rt, { command, args, cwd, timeoutMs, signal });
  if (!run.ok) return { ok: false, code: mapCliError(run.error.code), message: run.error.code };
  return { ok: true, exitCode: run.value.exitCode, signal: run.value.signal, stdout: run.value.stdout, stdoutDigest: run.value.stdoutDigest, stderrDigest: run.value.stderrDigest };
}

type CliOutcome = { readonly ok: true; readonly exitCode: number | null; readonly signal: string | null; readonly stdout: string; readonly stdoutDigest: string; readonly stderrDigest: string } | { readonly ok: false; readonly code: PushErrorCode; readonly message: string };

async function leasedCli(deps: WriteOpsDeps, canonicalPath: string, bound: { authProfile: string; environmentId: string }, args: readonly string[], signal?: AbortSignal): Promise<CliOutcome> {
  const leaseRes = await resolveLease(deps.ctx, bound, signal);
  if (!leaseRes.ok) return { ok: false, code: leaseRes.error.code, message: leaseRes.error.message };
  try {
    return await leaseRes.value.use(async () => runCli(deps.ctx.subprocess, deps.command, args, canonicalPath, deps.timeoutMs, signal));
  } catch {
    return { ok: false, code: "lease-revoked", message: "lease-revoked" };
  }
}

function notJsonFailure(ran: { exitCode: number | null; stdout: string }): Result<never> {
  if (ran.stdout.trim() === "") return { ok: false, error: { code: "command-failed", message: "command-failed" } };
  return (ran.exitCode ?? 1) === 0
    ? { ok: false, error: { code: "parse-error", message: "parse-error" } }
    : { ok: false, error: { code: "command-failed", message: "command-failed" } };
}

// ---- create options (read-only) ----

export async function createOptionsOp(deps: WriteOpsDeps, workspaceId: string, kind: "api" | "function", signal?: AbortSignal): Promise<Result<CreateOptionsView>> {
  const binding = await bindingEntry(deps.ctx, workspaceId, signal);
  if (!binding.ok) return binding;
  const { canonicalPath, binding: bound } = binding.value;
  if (!bound) return { ok: false, error: { code: "workspace-not-bound", message: "workspace is not bound" } };
  const ran = await leasedCli(deps, canonicalPath, bound, buildCreateOptionsArgs(bound.authProfile, kind), signal);
  if (!ran.ok) return { ok: false, error: { code: ran.code, message: ran.message } };
  const parsed = parseCreateOptions(ran.stdout);
  if (!parsed.ok) return notJsonFailure(ran);
  return {
    ok: true,
    value: {
      workspaceId,
      kind: parsed.value.kind,
      status: parsed.value.status,
      funcScope: parsed.value.funcScope,
      requestMethod: parsed.value.requestMethod,
      requestType: parsed.value.requestType,
      responseType: parsed.value.responseType,
      stdoutDigest: ran.stdoutDigest,
    },
  };
}

// ---- create preview / request / execute ----

function toShape(input: CreatePreviewInput): CreateParamsShape | null {
  if (input.kind === "api" && input.params && typeof input.params === "object") {
    return { kind: "api", params: input.params as CreateParamsShape extends { kind: "api" } ? never : import("./types.ts").CreateApiParams } as unknown as CreateParamsShape;
  }
  if (input.kind === "function" && input.params && typeof input.params === "object") {
    return { kind: "function", params: input.params as import("./types.ts").CreateFunctionParams };
  }
  return null;
}

function validateCreateInput(input: CreatePreviewInput): Result<CreateParamsShape> {
  if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return { ok: false, error: { code: "invalid-workspace-id", message: "invalid-workspace-id" } };
  const shape = toShape(input);
  if (shape === null) return { ok: false, error: { code: "invalid-create-params", message: "params shape does not match kind" } };
  if (!validateCreateParams(shape)) return { ok: false, error: { code: "invalid-create-params", message: "invalid-create-params" } };
  return { ok: true, value: shape };
}

export async function createPreviewOp(deps: WriteOpsDeps, input: CreatePreviewInput, signal?: AbortSignal): Promise<Result<CreatePreviewView>> {
  const validated = validateCreateInput(input);
  if (!validated.ok) return validated;
  const shape = validated.value;
  const started = Date.now();
  const binding = await bindingEntry(deps.ctx, input.workspaceId, signal);
  if (!binding.ok) return binding;
  const { canonicalPath, binding: bound } = binding.value;
  if (!bound) return { ok: false, error: { code: "workspace-not-bound", message: "workspace is not bound" } };
  const ran = await leasedCli(deps, canonicalPath, bound, buildCreateArgs(bound.authProfile, shape, true), signal);
  if (!ran.ok) return { ok: false, error: { code: ran.code, message: ran.message } };
  const parsed = parseReleaseApply(ran.stdout, ran.exitCode ?? 1);
  if (!parsed.ok) return notJsonFailure(ran);
  return {
    ok: true,
    value: {
      workspaceId: input.workspaceId,
      kind: shape.kind,
      name: shape.params.name,
      valid: parsed.value.valid,
      warnings: parsed.value.warnings,
      durationMs: Date.now() - started,
      stdoutDigest: ran.stdoutDigest,
    },
  };
}

export async function createRequestOp(deps: WriteOpsDeps, input: CreatePreviewInput, signal?: AbortSignal): Promise<Result<CreateRequestView>> {
  const validated = validateCreateInput(input);
  if (!validated.ok) return validated;
  const shape = validated.value;
  const paramsDigest = createParamsDigest(shape);
  let record: OperationLogRecord;
  try {
    record = await deps.operationLog.append({
      requestId: `icomposer-create:${Date.now()}`, kind: "imo-icomposer-create", paramsDigest, artifactRefs: [],
    });
  } catch {
    return { ok: false, error: { code: "record-failed", message: "record-failed" } };
  }
  deps.pending.set(record.id, { kind: "create", operationId: record.id, workspaceId: input.workspaceId, shape, paramsDigest } as never);
  return { ok: true, value: { operationId: record.id, kind: "imo-icomposer-create", assetKind: shape.kind, name: shape.params.name, paramsDigest, decision: "pending" } };
}

export async function createExecuteOp(deps: WriteOpsDeps, operationId: string, signal?: AbortSignal): Promise<CreateExecution> {
  const record = deps.operationLog.list().find(candidate => candidate.id === operationId);
  if (record === undefined) return failure("missing-operation", "create operation does not exist", operationId);
  if (record.decision !== "approved") return failure("not-approved", "only approved create operations may run", operationId);
  if (record.resultDigest !== undefined) return failure("already-executed", "create operation already has a result", operationId);
  const journal = deps.journal.get(operationId);
  if (journal?.state === "executed") {
    const receipt = journal.receipt as unknown as CreateReceipt;
    const resultDigest = journal.resultDigest!;
    try {
      await deps.operationLog.recordResult(operationId, { resultDigest, artifactRefs: [] });
    } catch (error) {
      if (codeOf(error) === "already-has-result") return failure("already-executed", "create operation already has a result", operationId);
      return { ok: true, receipt, evidencePending: true } as unknown as CreateExecution;
    }
    return { ok: true, receipt };
  }
  if (journal?.state === "executing") return failure("busy", "another create attempt is already running", operationId);
  const pending = asCreatePending(deps, operationId);
  if (pending === undefined || pending.kind !== "create") return failure("missing-pending-input", "create parameters are unavailable; re-request the create", operationId);
  if (record.paramsDigest !== pending.paramsDigest || record.paramsDigest !== createParamsDigest(pending.shape)) {
    return failure("operation-params-mismatch", "create operation parameters do not match", operationId);
  }
  if (deps.running() !== null) return failure("busy", "another write operation is already running", operationId);
  if (!deps.journal.prepare(operationId)) return failure("busy", "another create attempt is already running", operationId);
  if (signal?.aborted) { deps.journal.markOutcomeUnknown(operationId); return failure("cancelled", "create execution was cancelled", operationId); }
  if (!deps.journal.begin(operationId)) return failure("already-executed", "create operation already has a result", operationId);
  const binding = await bindingEntry(deps.ctx, pending.workspaceId, signal);
  if (!binding.ok) { deps.journal.markOutcomeUnknown(operationId); return failure(binding.error.code, binding.error.message, operationId); }
  const { canonicalPath, binding: bound } = binding.value;
  if (!bound) { deps.journal.markOutcomeUnknown(operationId); return failure("workspace-not-bound", "workspace is not bound", operationId); }
  const startedAt = new Date().toISOString();
  try {
    return await resolveLease(deps.ctx, bound, signal).then(async leaseRes => {
      if (!leaseRes.ok) { deps.journal.markOutcomeUnknown(operationId); return failure(leaseRes.error.code, leaseRes.error.message, operationId); }
      return leaseRes.value.use(async () => {
        const ran = await runCli(deps.ctx.subprocess, deps.command, buildCreateArgs(bound.authProfile, pending.shape, false), canonicalPath, deps.timeoutMs, signal);
        if (!ran.ok) {
          deps.journal.markOutcomeUnknown(operationId);
          return failure(ran.code, "create outcome could not be determined; it will never be re-run", operationId);
        }
        const status: "completed" | "failed" = ran.exitCode === 0 && ran.signal === null ? "completed" : "failed";
        // post-create catalog rescan: verify the new asset actually exists.
        let catalogVerified = false;
        try {
          const catalog = deps.ctx.get("icomposerCatalog" as never) as unknown as {
            listAssets(input: { workspaceId: string }, signal?: AbortSignal): Promise<{ ok: boolean; value?: { entries: ReadonlyArray<{ name: string; type: string }> } }>;
          } | undefined;
          if (catalog !== undefined) {
            const rescan = await catalog.listAssets({ workspaceId: pending.workspaceId }, signal);
            if (rescan.ok) catalogVerified = rescan.value!.entries.some(e => e.name === pending.shape.params.name && (e.type === pending.shape.kind));
          }
        } catch { /* verification is best-effort evidence */ }
        const receipt: CreateReceipt = {
          operationId,
          kind: "imo-icomposer-create",
          assetKind: pending.shape.kind,
          name: pending.shape.params.name,
          status,
          exitCode: ran.exitCode,
          stdoutDigest: ran.stdoutDigest,
          stderrDigest: ran.stderrDigest,
          catalogVerified,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        const { pushResultDigest } = await import("./parse.ts");
        const resultDigest = pushResultDigest({ operationId, status, stdoutDigest: receipt.stdoutDigest, stderrDigest: receipt.stderrDigest, conflictFiles: [], finishedAt: receipt.finishedAt });
        deps.journal.commit(operationId, receipt as unknown as Parameters<typeof deps.journal.commit>[1], resultDigest);
        deps.journal.markEventEmitted(operationId);
        try {
          await deps.operationLog.recordResult(operationId, { resultDigest, artifactRefs: [] });
        } catch (error) {
          if (codeOf(error) === "already-has-result") return failure("already-executed", "create operation already has a result", operationId);
          return { ok: true, receipt, evidencePending: true } as unknown as CreateExecution;
        }
        return { ok: true, receipt };
      });
    });
  } catch {
    deps.journal.markOutcomeUnknown(operationId);
    return failure("execution-outcome-unknown", "create outcome could not be determined; it will never be re-run", operationId);
  }
}

// ---- metadata preview / request / execute ----

function validateMetadataInput(input: MetadataPreviewInput): Result<{ file: string; fields: MetadataFields }> {
  if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return { ok: false, error: { code: "invalid-workspace-id", message: "invalid-workspace-id" } };
  if (!isValidWorkspaceGroovyPath(input.file)) return { ok: false, error: { code: "invalid-file-path", message: "invalid-file-path" } };
  if (!isValidFiles([input.file])) return { ok: false, error: { code: "invalid-file-path", message: "invalid-file-path" } };
  if (!input.fields || typeof input.fields !== "object" || !validateMetadataFields(input.fields)) {
    return { ok: false, error: { code: "invalid-metadata-fields", message: "at least one metadata field is required" } };
  }
  return { ok: true, value: { file: input.file, fields: input.fields } };
}

export async function metadataPreviewOp(deps: WriteOpsDeps, input: MetadataPreviewInput, signal?: AbortSignal): Promise<Result<MetadataPreviewView>> {
  const validated = validateMetadataInput(input);
  if (!validated.ok) return validated;
  const started = Date.now();
  const binding = await bindingEntry(deps.ctx, input.workspaceId, signal);
  if (!binding.ok) return binding;
  const { canonicalPath, binding: bound } = binding.value;
  if (!bound) return { ok: false, error: { code: "workspace-not-bound", message: "workspace is not bound" } };
  const ran = await leasedCli(deps, canonicalPath, bound, buildMetadataArgs(bound.authProfile, validated.value.file, validated.value.fields, true), signal);
  if (!ran.ok) return { ok: false, error: { code: ran.code, message: ran.message } };
  const parsed = parseReleaseApply(ran.stdout, ran.exitCode ?? 1);
  if (!parsed.ok) return notJsonFailure(ran);
  return {
    ok: true,
    value: {
      workspaceId: input.workspaceId,
      file: validated.value.file,
      valid: parsed.value.valid,
      warnings: parsed.value.warnings,
      durationMs: Date.now() - started,
      stdoutDigest: ran.stdoutDigest,
    },
  };
}

export async function metadataRequestOp(deps: WriteOpsDeps, input: MetadataPreviewInput, signal?: AbortSignal): Promise<Result<MetadataRequestView>> {
  const validated = validateMetadataInput(input);
  if (!validated.ok) return validated;
  const paramsDigest = metadataParamsDigest(validated.value.file, validated.value.fields);
  let record: OperationLogRecord;
  try {
    record = await deps.operationLog.append({
      requestId: `icomposer-metadata:${Date.now()}`, kind: "imo-icomposer-metadata-update", paramsDigest, artifactRefs: [],
    });
  } catch {
    return { ok: false, error: { code: "record-failed", message: "record-failed" } };
  }
  deps.pending.set(record.id, { kind: "metadata", operationId: record.id, workspaceId: input.workspaceId, file: validated.value.file, fields: validated.value.fields, paramsDigest } as never);
  return { ok: true, value: { operationId: record.id, kind: "imo-icomposer-metadata-update", file: validated.value.file, paramsDigest, decision: "pending" } };
}

export async function metadataExecuteOp(deps: WriteOpsDeps, operationId: string, signal?: AbortSignal): Promise<MetadataExecution> {
  const record = deps.operationLog.list().find(candidate => candidate.id === operationId);
  if (record === undefined) return failure("missing-operation", "metadata operation does not exist", operationId);
  if (record.decision !== "approved") return failure("not-approved", "only approved metadata operations may run", operationId);
  if (record.resultDigest !== undefined) return failure("already-executed", "metadata operation already has a result", operationId);
  const journal = deps.journal.get(operationId);
  if (journal?.state === "executed") {
    const receipt = journal.receipt as unknown as MetadataReceipt;
    const resultDigest = journal.resultDigest!;
    try {
      await deps.operationLog.recordResult(operationId, { resultDigest, artifactRefs: [] });
    } catch (error) {
      if (codeOf(error) === "already-has-result") return failure("already-executed", "metadata operation already has a result", operationId);
      return { ok: true, receipt, evidencePending: true } as unknown as MetadataExecution;
    }
    return { ok: true, receipt };
  }
  if (journal?.state === "executing") return failure("busy", "another metadata attempt is already running", operationId);
  const pending = asCreatePending(deps, operationId);
  if (pending === undefined || pending.kind !== "metadata") return failure("missing-pending-input", "metadata parameters are unavailable; re-request the update", operationId);
  if (record.paramsDigest !== pending.paramsDigest || record.paramsDigest !== metadataParamsDigest(pending.file, pending.fields)) {
    return failure("operation-params-mismatch", "metadata operation parameters do not match", operationId);
  }
  if (deps.running() !== null) return failure("busy", "another write operation is already running", operationId);
  if (!deps.journal.prepare(operationId)) return failure("busy", "another metadata attempt is already running", operationId);
  if (signal?.aborted) { deps.journal.markOutcomeUnknown(operationId); return failure("cancelled", "metadata execution was cancelled", operationId); }
  if (!deps.journal.begin(operationId)) return failure("already-executed", "metadata operation already has a result", operationId);
  const binding = await bindingEntry(deps.ctx, pending.workspaceId, signal);
  if (!binding.ok) { deps.journal.markOutcomeUnknown(operationId); return failure(binding.error.code, binding.error.message, operationId); }
  const { canonicalPath, binding: bound } = binding.value;
  if (!bound) { deps.journal.markOutcomeUnknown(operationId); return failure("workspace-not-bound", "workspace is not bound", operationId); }
  const startedAt = new Date().toISOString();
  try {
    return await resolveLease(deps.ctx, bound, signal).then(async leaseRes => {
      if (!leaseRes.ok) { deps.journal.markOutcomeUnknown(operationId); return failure(leaseRes.error.code, leaseRes.error.message, operationId); }
      return leaseRes.value.use(async () => {
        const ran = await runCli(deps.ctx.subprocess, deps.command, buildMetadataArgs(bound.authProfile, pending.file, pending.fields, false), canonicalPath, deps.timeoutMs, signal);
        if (!ran.ok) {
          deps.journal.markOutcomeUnknown(operationId);
          return failure(ran.code, "metadata outcome could not be determined; it will never be re-run", operationId);
        }
        const status: "completed" | "failed" = ran.exitCode === 0 && ran.signal === null ? "completed" : "failed";
        const receipt: MetadataReceipt = {
          operationId,
          kind: "imo-icomposer-metadata-update",
          file: pending.file,
          fieldsApplied: metadataFieldsApplied(pending.fields),
          status,
          exitCode: ran.exitCode,
          stdoutDigest: ran.stdoutDigest,
          stderrDigest: ran.stderrDigest,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        const { pushResultDigest } = await import("./parse.ts");
        const resultDigest = pushResultDigest({ operationId, status, stdoutDigest: receipt.stdoutDigest, stderrDigest: receipt.stderrDigest, conflictFiles: [], finishedAt: receipt.finishedAt });
        deps.journal.commit(operationId, receipt as unknown as Parameters<typeof deps.journal.commit>[1], resultDigest);
        deps.journal.markEventEmitted(operationId);
        try {
          await deps.operationLog.recordResult(operationId, { resultDigest, artifactRefs: [] });
        } catch (error) {
          if (codeOf(error) === "already-has-result") return failure("already-executed", "metadata operation already has a result", operationId);
          return { ok: true, receipt, evidencePending: true } as unknown as MetadataExecution;
        }
        return { ok: true, receipt };
      });
    });
  } catch {
    deps.journal.markOutcomeUnknown(operationId);
    return failure("execution-outcome-unknown", "metadata outcome could not be determined; it will never be re-run", operationId);
  }
}
