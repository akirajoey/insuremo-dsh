import type { Context } from "@deepseek-ai/cordis";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import {
  buildReleaseArgs,
  buildReleaseListArgs,
  buildTestArgs,
  isValidAssetName,
  isValidBranchName,
  isValidDataPayload,
  isValidMethod,
  isValidReleaseMessage,
  isValidRepoUrl,
  releaseParamsDigest,
  testParamsDigest,
} from "./cli.ts";
import { capture } from "./capture.ts";
import { writeBaseDir, writeTestArtifact } from "./artifacts.ts";
import { assetJoinState } from "./join-check.ts";
import { parseReleaseApply, parseReleaseBranches, parseReleaseRepos, parseTestOutput } from "./parse.ts";
import { bindingEntry, mapCliError, resolveLease } from "./runtime.ts";
import type { PushJournal } from "./journal.ts";
import type {
  AssetJoinState,
  PushErrorCode,
  ReleaseApplyInput,
  ReleaseApplyView,
  ReleaseBranchView,
  ReleaseExecution,
  ReleasePreviewInput,
  ReleasePreviewView,
  ReleaseReceipt,
  ReleaseRepoView,
  Result,
  TestExecution,
  TestKind,
  TestReceipt,
  TestRunInput,
  TestRunView,
} from "./types.ts";

export type OperationLogRecord = {
  id: string; kind: string; decision: "pending" | "approved" | "rejected";
  paramsDigest?: string; resultDigest?: string; reason?: string;
};
export type OperationLogLike = {
  append(input: { requestId: string; kind: string; paramsDigest: string; artifactRefs: readonly string[] }): Promise<OperationLogRecord>;
  list(): readonly OperationLogRecord[];
  decide?(id: string, approved: boolean, by: string, reason?: string): Promise<OperationLogRecord>;
  recordResult(id: string, input: { resultDigest: string; artifactRefs: readonly string[] }): Promise<OperationLogRecord>;
};

export type PendingEntry =
  | { readonly kind: "push"; readonly operationId: string; readonly workspaceId: string; readonly mode: "current" | "batch"; readonly files: readonly string[]; readonly checkUsages?: boolean; readonly skipCompile?: boolean; readonly paramsDigest: string }
  | { readonly kind: "resolve"; readonly operationId: string; readonly workspaceId: string; readonly mode: "current" | "batch"; readonly files: readonly string[]; readonly checkUsages?: boolean; readonly skipCompile?: boolean; readonly prefer: "prefer-local" | "prefer-server"; readonly originalOperationId: string; readonly paramsDigest: string }
  | { readonly kind: "test"; readonly operationId: string; readonly workspaceId: string; readonly assetKind: TestKind; readonly name: string; readonly data?: string; readonly method?: string; readonly overrideUnpushed: boolean; readonly joinState: AssetJoinState; readonly paramsDigest: string }
  | { readonly kind: "release"; readonly operationId: string; readonly workspaceId: string; readonly type: "api" | "function"; readonly name: string; readonly repo: string; readonly branch: string; readonly message: string; readonly paramsDigest: string }
  | { readonly kind: "create"; readonly operationId: string; readonly workspaceId: string; readonly shape: { readonly kind: "api" | "function"; readonly params: unknown }; readonly paramsDigest: string }
  | { readonly kind: "metadata"; readonly operationId: string; readonly workspaceId: string; readonly file: string; readonly fields: { status?: string; description?: string; sse?: boolean; integration?: string; funcScope?: string }; readonly paramsDigest: string };

export interface WriteOpsDeps {
  readonly ctx: Context;
  readonly command: string;
  readonly timeoutMs: number;
  readonly journal: PushJournal;
  readonly operationLog: OperationLogLike;
  readonly pending: Map<string, PendingEntry>;
  readonly running: () => { operationId: string; kind: string } | null;
}

function failure<T>(code: PushErrorCode, message: string, operationId?: string): T {
  return { ok: false, error: { code, message, ...(operationId === undefined ? {} : { operationId }) } } as unknown as T;
}
function codeOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : null;
}

// ---- test ----

export async function testRunOp(deps: WriteOpsDeps, input: TestRunInput, signal?: AbortSignal): Promise<Result<TestRunView>> {
  if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return { ok: false, error: { code: "invalid-workspace-id", message: "invalid-workspace-id" } };
  if (input.kind !== "api" && input.kind !== "function") return { ok: false, error: { code: "invalid-params", message: "kind must be api or function" } };
  if (!isValidAssetName(input.name)) return { ok: false, error: { code: "invalid-name", message: "invalid-name" } };
  if (!isValidDataPayload(input.data)) return { ok: false, error: { code: "invalid-data", message: "invalid-data" } };
  if (input.kind === "function" && input.method !== undefined && !isValidMethod(input.method)) return { ok: false, error: { code: "invalid-method", message: "invalid-method" } };
  const binding = await bindingEntry(deps.ctx, input.workspaceId, signal);
  if (!binding.ok) return binding;
  const joinState = await assetJoinState(binding.value.canonicalPath, input.kind, input.name, signal);
  const overrideUnpushed = input.overrideUnpushed === true;
  const paramsDigest = testParamsDigest({ kind: input.kind, name: input.name, data: input.data, method: input.method, overrideUnpushed });
  let record: OperationLogRecord;
  try {
    record = await deps.operationLog.append({
      requestId: `icomposer-test:${Date.now()}`, kind: "imo-icomposer-test", paramsDigest, artifactRefs: [],
    });
  } catch {
    return { ok: false, error: { code: "record-failed", message: "record-failed" } };
  }
  deps.pending.set(record.id, {
    kind: "test", operationId: record.id, workspaceId: input.workspaceId, assetKind: input.kind, name: input.name,
    data: input.data, method: input.method, overrideUnpushed, joinState, paramsDigest,
  });
  return {
    ok: true,
    value: { operationId: record.id, kind: "imo-icomposer-test", assetKind: input.kind, name: input.name, paramsDigest, decision: "pending", joinState, overrideUnpushed },
  };
}

export async function testExecuteOp(deps: WriteOpsDeps, operationId: string, signal?: AbortSignal): Promise<TestExecution> {
  const record = deps.operationLog.list().find(candidate => candidate.id === operationId);
  if (record === undefined) return failure("missing-operation", "test operation does not exist", operationId);
  if (record.decision !== "approved") return failure("not-approved", "only approved test operations may run", operationId);
  if (record.resultDigest !== undefined) return failure("already-executed", "test operation already has a result", operationId);
  const journal = deps.journal.get(operationId);
  if (journal?.state === "executed") {
    const receipt = journal.receipt as unknown as TestReceipt;
    const resultDigest = journal.resultDigest!;
    try {
      await deps.operationLog.recordResult(operationId, { resultDigest, artifactRefs: [receipt.artifactPath] });
    } catch (error) {
      if (codeOf(error) === "already-has-result") return failure("already-executed", "test operation already has a result", operationId);
      return { ok: true, receipt, evidencePending: true } as unknown as TestExecution;
    }
    return { ok: true, receipt };
  }
  if (journal?.state === "executing") return failure("busy", "another test attempt is already running", operationId);
  const pending = deps.pending.get(operationId);
  if (pending === undefined || pending.kind !== "test") return failure("missing-pending-input", "test parameters are unavailable; re-request the test", operationId);
  if (record.paramsDigest !== pending.paramsDigest || record.paramsDigest !== testParamsDigest({ kind: pending.assetKind, name: pending.name, data: pending.data, method: pending.method, overrideUnpushed: pending.overrideUnpushed })) {
    return failure("operation-params-mismatch", "test operation parameters do not match", operationId);
  }
  if (deps.running() !== null) return failure("busy", "another write operation is already running", operationId);
  if (!deps.journal.prepare(operationId)) return failure("busy", "another test attempt is already running", operationId);
  if (signal?.aborted) { deps.journal.markOutcomeUnknown(operationId); return failure("cancelled", "test execution was cancelled", operationId); }
  if (!deps.journal.begin(operationId)) return failure("already-executed", "test operation already has a result", operationId);

  const binding = await bindingEntry(deps.ctx, pending.workspaceId, signal);
  if (!binding.ok) { deps.journal.markOutcomeUnknown(operationId); return failure(binding.error.code, binding.error.message, operationId); }
  const { canonicalPath, binding: bound } = binding.value;
  if (!bound) { deps.journal.markOutcomeUnknown(operationId); return failure("workspace-not-bound", "workspace is not bound", operationId); }
  // P0: local unpushed-changes guard (re-checked at execute time).
  const joinState = await assetJoinState(canonicalPath, pending.assetKind, pending.name, signal);
  if (joinState === "local-modified" && pending.overrideUnpushed !== true) {
    deps.journal.markOutcomeUnknown(operationId);
    return failure("local-unpushed-changes", "local file has unpushed changes; re-run with overrideUnpushed or push first", operationId);
  }
  const leaseRes = await resolveLease(deps.ctx, bound, signal);
  if (!leaseRes.ok) { deps.journal.markOutcomeUnknown(operationId); return failure(leaseRes.error.code, leaseRes.error.message, operationId); }
  const startedAt = new Date().toISOString();
  try {
    return await leaseRes.value.use(async () => {
      const run = await capture(deps.ctx.subprocess, {
        command: deps.command,
        args: buildTestArgs(bound.authProfile, { kind: pending.assetKind, name: pending.name, data: pending.data, method: pending.method }),
        cwd: canonicalPath,
        timeoutMs: deps.timeoutMs,
        signal,
      });
      if (!run.ok) {
        deps.journal.markOutcomeUnknown(operationId);
        return failure(mapCliError(run.error.code), "test outcome could not be determined; it will never be re-run", operationId);
      }
      const evidence = parseTestOutput(run.value.stdout);
      const projection = evidence.ok ? evidence.value : { elapsedMs: 0, httpStatus: null, requestDigest: "", responseDigest: "", traceId: "", testUrl: "", savedAt: "" };
      const status: "completed" | "failed" = run.value.exitCode === 0 && run.value.signal === null ? "completed" : "failed";
      const artifactPath = await writeTestArtifact(writeBaseDir(canonicalPath, pending.workspaceId), operationId, {
        evidence: {
          elapsedMs: projection.elapsedMs,
          httpStatus: projection.httpStatus,
          requestDigest: projection.requestDigest,
          responseDigest: projection.responseDigest,
          traceId: projection.traceId,
          testUrl: projection.testUrl,
          savedAt: projection.savedAt,
        },
        stdoutDigest: run.value.stdoutDigest,
        stderrDigest: run.value.stderrDigest,
        exitCode: run.value.exitCode,
      });
      const receipt: TestReceipt = {
        operationId,
        kind: "imo-icomposer-test",
        assetKind: pending.assetKind,
        name: pending.name,
        overrideUnpushed: pending.overrideUnpushed,
        joinState,
        status,
        exitCode: run.value.exitCode,
        stdoutDigest: run.value.stdoutDigest,
        stderrDigest: run.value.stderrDigest,
        evidence: {
          elapsedMs: projection.elapsedMs,
          httpStatus: projection.httpStatus,
          requestDigest: projection.requestDigest,
          responseDigest: projection.responseDigest,
          traceId: projection.traceId,
          testUrl: projection.testUrl,
          savedAt: projection.savedAt,
        },
        artifactPath,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      const { pushResultDigest } = await import("./parse.ts");
      const resultDigest = pushResultDigest({ operationId, status, stdoutDigest: receipt.stdoutDigest, stderrDigest: receipt.stderrDigest, conflictFiles: [], finishedAt: receipt.finishedAt });
      deps.journal.commit(operationId, receipt as unknown as Parameters<typeof deps.journal.commit>[1], resultDigest);
      deps.journal.markEventEmitted(operationId);
      try {
        await deps.operationLog.recordResult(operationId, { resultDigest, artifactRefs: [artifactPath] });
      } catch (error) {
        if (codeOf(error) === "already-has-result") return failure("already-executed", "test operation already has a result", operationId);
        return { ok: true, receipt, evidencePending: true } as unknown as TestExecution;
      }
      return { ok: true, receipt };
    });
  } catch {
    deps.journal.markOutcomeUnknown(operationId);
    return failure("execution-outcome-unknown", "test outcome could not be determined; it will never be re-run", operationId);
  }
}

// ---- release ----

function validateReleaseInput(input: ReleaseApplyInput | ReleasePreviewInput): Result<{ type: "api" | "function"; name: string; repo: string; branch: string; message: string }> {
  if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return { ok: false, error: { code: "invalid-workspace-id", message: "invalid-workspace-id" } };
  if (input.type !== "api" && input.type !== "function") return { ok: false, error: { code: "invalid-release-params", message: "type must be api or function" } };
  if (!isValidAssetName(input.name)) return { ok: false, error: { code: "invalid-name", message: "invalid-name" } };
  if (!isValidRepoUrl(input.repo)) return { ok: false, error: { code: "invalid-release-params", message: "invalid repo" } };
  if (!isValidBranchName(input.branch)) return { ok: false, error: { code: "invalid-release-params", message: "invalid branch" } };
  if (!isValidReleaseMessage(input.message)) return { ok: false, error: { code: "invalid-release-params", message: `message must be 1-${MESSAGE_MAX} chars without control characters` } };
  return { ok: true, value: { type: input.type, name: input.name, repo: input.repo, branch: input.branch, message: input.message } };
}

const MESSAGE_MAX = 500;

async function runLeasedCli(deps: WriteOpsDeps, canonicalPath: string, bound: { authProfile: string; environmentId: string }, args: readonly string[], signal?: AbortSignal): Promise<{ ok: true; exitCode: number | null; signal: string | null; stdout: string; stdoutDigest: string; stderrDigest: string } | { ok: false; code: PushErrorCode; message: string }> {
  const leaseRes = await resolveLease(deps.ctx, bound, signal);
  if (!leaseRes.ok) return { ok: false, code: leaseRes.error.code, message: leaseRes.error.message };
  try {
    return await leaseRes.value.use(async () => {
      const run = await capture(deps.ctx.subprocess, { command: deps.command, args, cwd: canonicalPath, timeoutMs: deps.timeoutMs, signal });
      if (!run.ok) return { ok: false as const, code: mapCliError(run.error.code), message: run.error.code };
      return { ok: true as const, exitCode: run.value.exitCode, signal: run.value.signal, stdout: run.value.stdout, stdoutDigest: run.value.stdoutDigest, stderrDigest: run.value.stderrDigest };
    });
  } catch {
    return { ok: false, code: "lease-revoked", message: "lease-revoked" };
  }
}

/** A non-JSON release stdout: empty output means a stderr failure even at exit 0. */
function notJsonFailure(ran: { exitCode: number | null; stdout: string }): Result<never> {
  if (ran.stdout.trim() === "") return { ok: false, error: { code: "command-failed", message: "command-failed" } };
  return (ran.exitCode ?? 1) === 0
    ? { ok: false, error: { code: "parse-error", message: "parse-error" } }
    : { ok: false, error: { code: "command-failed", message: "command-failed" } };
}

export async function releasePreviewOp(deps: WriteOpsDeps, input: ReleasePreviewInput, signal?: AbortSignal): Promise<Result<ReleasePreviewView>> {
  const validated = validateReleaseInput(input);
  if (!validated.ok) return validated;
  const started = Date.now();
  const binding = await bindingEntry(deps.ctx, input.workspaceId, signal);
  if (!binding.ok) return binding;
  const { canonicalPath, binding: bound } = binding.value;
  if (!bound) return { ok: false, error: { code: "workspace-not-bound", message: "workspace is not bound" } };
  const ran = await runLeasedCli(deps, canonicalPath, bound, buildReleaseArgs(bound.authProfile, { ...validated.value, dryRun: true }), signal);
  if (!ran.ok) return { ok: false, error: { code: ran.code, message: ran.message } };
  const parsed = parseReleaseApply(ran.stdout, ran.exitCode ?? 1);
  if (!parsed.ok) return notJsonFailure(ran);
  return {
    ok: true,
    value: {
      workspaceId: input.workspaceId,
      type: validated.value.type,
      name: validated.value.name,
      valid: parsed.value.valid,
      warnings: parsed.value.warnings,
      durationMs: Date.now() - started,
      stdoutDigest: ran.stdoutDigest,
    },
  };
}

export async function releaseReposOp(deps: WriteOpsDeps, workspaceId: string, signal?: AbortSignal): Promise<Result<ReleaseRepoView>> {
  if (!workspaceId || typeof workspaceId !== "string") return { ok: false, error: { code: "invalid-workspace-id", message: "invalid-workspace-id" } };
  const binding = await bindingEntry(deps.ctx, workspaceId, signal);
  if (!binding.ok) return binding;
  const { canonicalPath, binding: bound } = binding.value;
  if (!bound) return { ok: false, error: { code: "workspace-not-bound", message: "workspace is not bound" } };
  const ran = await runLeasedCli(deps, canonicalPath, bound, buildReleaseListArgs(bound.authProfile, "repo"), signal);
  if (!ran.ok) return { ok: false, error: { code: ran.code, message: ran.message } };
  const parsed = parseReleaseRepos(ran.stdout);
  if (!parsed.ok) return notJsonFailure(ran);
  return { ok: true, value: { workspaceId, repos: parsed.value.repos, count: parsed.value.repos.length, truncated: parsed.value.truncated, stdoutDigest: ran.stdoutDigest } };
}

export async function releaseBranchesOp(deps: WriteOpsDeps, workspaceId: string, repo: string, signal?: AbortSignal): Promise<Result<ReleaseBranchView>> {
  if (!workspaceId || typeof workspaceId !== "string") return { ok: false, error: { code: "invalid-workspace-id", message: "invalid-workspace-id" } };
  if (!isValidRepoUrl(repo)) return { ok: false, error: { code: "invalid-release-params", message: "invalid repo" } };
  const binding = await bindingEntry(deps.ctx, workspaceId, signal);
  if (!binding.ok) return binding;
  const { canonicalPath, binding: bound } = binding.value;
  if (!bound) return { ok: false, error: { code: "workspace-not-bound", message: "workspace is not bound" } };
  const ran = await runLeasedCli(deps, canonicalPath, bound, buildReleaseListArgs(bound.authProfile, "branch", repo), signal);
  if (!ran.ok) return { ok: false, error: { code: ran.code, message: ran.message } };
  const parsed = parseReleaseBranches(ran.stdout);
  if (!parsed.ok) return notJsonFailure(ran);
  return { ok: true, value: { workspaceId, repo, branches: parsed.value.branches, count: parsed.value.branches.length, truncated: parsed.value.truncated, stdoutDigest: ran.stdoutDigest } };
}

export async function releaseApplyOp(deps: WriteOpsDeps, input: ReleaseApplyInput, signal?: AbortSignal): Promise<Result<ReleaseApplyView>> {
  const validated = validateReleaseInput(input);
  if (!validated.ok) return validated;
  const paramsDigest = releaseParamsDigest(validated.value);
  let record: OperationLogRecord;
  try {
    record = await deps.operationLog.append({
      requestId: `icomposer-release:${Date.now()}`, kind: "imo-icomposer-release", paramsDigest, artifactRefs: [],
    });
  } catch {
    return { ok: false, error: { code: "record-failed", message: "record-failed" } };
  }
  deps.pending.set(record.id, {
    kind: "release", operationId: record.id, workspaceId: input.workspaceId,
    type: validated.value.type, name: validated.value.name, repo: validated.value.repo, branch: validated.value.branch, message: validated.value.message, paramsDigest,
  });
  return {
    ok: true,
    value: { operationId: record.id, kind: "imo-icomposer-release", type: validated.value.type, name: validated.value.name, repo: validated.value.repo, branch: validated.value.branch, paramsDigest, decision: "pending" },
  };
}

export async function releaseExecuteOp(deps: WriteOpsDeps, operationId: string, signal?: AbortSignal): Promise<ReleaseExecution> {
  const record = deps.operationLog.list().find(candidate => candidate.id === operationId);
  if (record === undefined) return failure("missing-operation", "release operation does not exist", operationId);
  if (record.decision !== "approved") return failure("not-approved", "only approved release operations may run", operationId);
  if (record.resultDigest !== undefined) return failure("already-executed", "release operation already has a result", operationId);
  const journal = deps.journal.get(operationId);
  if (journal?.state === "executed") {
    const receipt = journal.receipt as unknown as ReleaseReceipt;
    const resultDigest = journal.resultDigest!;
    try {
      await deps.operationLog.recordResult(operationId, { resultDigest, artifactRefs: [] });
    } catch (error) {
      if (codeOf(error) === "already-has-result") return failure("already-executed", "release operation already has a result", operationId);
      return { ok: true, receipt, evidencePending: true } as unknown as ReleaseExecution;
    }
    return { ok: true, receipt };
  }
  if (journal?.state === "executing") return failure("busy", "another release attempt is already running", operationId);
  const pending = deps.pending.get(operationId);
  if (pending === undefined || pending.kind !== "release") return failure("missing-pending-input", "release parameters are unavailable; re-request the release", operationId);
  if (record.paramsDigest !== pending.paramsDigest || record.paramsDigest !== releaseParamsDigest({ type: pending.type, name: pending.name, repo: pending.repo, branch: pending.branch, message: pending.message })) {
    return failure("operation-params-mismatch", "release operation parameters do not match", operationId);
  }
  if (deps.running() !== null) return failure("busy", "another write operation is already running", operationId);
  if (!deps.journal.prepare(operationId)) return failure("busy", "another release attempt is already running", operationId);
  if (signal?.aborted) { deps.journal.markOutcomeUnknown(operationId); return failure("cancelled", "release execution was cancelled", operationId); }
  if (!deps.journal.begin(operationId)) return failure("already-executed", "release operation already has a result", operationId);

  const binding = await bindingEntry(deps.ctx, pending.workspaceId, signal);
  if (!binding.ok) { deps.journal.markOutcomeUnknown(operationId); return failure(binding.error.code, binding.error.message, operationId); }
  const { canonicalPath, binding: bound } = binding.value;
  if (!bound) { deps.journal.markOutcomeUnknown(operationId); return failure("workspace-not-bound", "workspace is not bound", operationId); }
  const startedAt = new Date().toISOString();
  try {
    return await resolveLease(deps.ctx, bound, signal).then(async leaseRes => {
      if (!leaseRes.ok) { deps.journal.markOutcomeUnknown(operationId); return failure(leaseRes.error.code, leaseRes.error.message, operationId); }
      return leaseRes.value.use(async () => {
        const run = await capture(deps.ctx.subprocess, {
          command: deps.command,
          args: buildReleaseArgs(bound.authProfile, { type: pending.type, name: pending.name, repo: pending.repo, branch: pending.branch, message: pending.message }),
          cwd: canonicalPath,
          timeoutMs: deps.timeoutMs,
          signal,
        });
        if (!run.ok) {
          deps.journal.markOutcomeUnknown(operationId);
          return failure(mapCliError(run.error.code), "release outcome could not be determined; it will never be re-run", operationId);
        }
        const status: "completed" | "failed" = run.value.exitCode === 0 && run.value.signal === null ? "completed" : "failed";
        const receipt: ReleaseReceipt = {
          operationId,
          kind: "imo-icomposer-release",
          type: pending.type,
          name: pending.name,
          repo: pending.repo,
          branch: pending.branch,
          status,
          exitCode: run.value.exitCode,
          stdoutDigest: run.value.stdoutDigest,
          stderrDigest: run.value.stderrDigest,
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
          if (codeOf(error) === "already-has-result") return failure("already-executed", "release operation already has a result", operationId);
          return { ok: true, receipt, evidencePending: true } as unknown as ReleaseExecution;
        }
        return { ok: true, receipt };
      });
    });
  } catch {
    deps.journal.markOutcomeUnknown(operationId);
    return failure("execution-outcome-unknown", "release outcome could not be determined; it will never be re-run", operationId);
  }
}
