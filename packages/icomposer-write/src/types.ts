/**
 * Surface types for `@icomposer/icomposer-write` — the approval-gated
 * iComposer push write path (preview / request / execute / resolve / status).
 * All emitted evidence is digest-only; raw CLI output never crosses a face.
 */

export type PushErrorCode =
  | "workspace-not-bound"
  | "workspace-not-found"
  | "invalid-workspace-id"
  | "invalid-file-path"
  | "invalid-choice"
  | "invalid-params"
  | "service-disposed"
  | "cancelled"
  | "invalid-auth"
  | "forbidden"
  | "prepare-invalidated"
  | "lease-revoked"
  | "command-failed"
  | "timeout"
  | "parse-error"
  | "cli-error"
  | "missing-operation"
  | "not-approved"
  | "already-executed"
  | "missing-pending-input"
  | "operation-params-mismatch"
  | "busy"
  | "record-failed"
  | "execution-outcome-unknown"
  | "conflict-resolution-required"
  | "local-unpushed-changes"
  | "invalid-name"
  | "invalid-data"
  | "invalid-method"
  | "invalid-release-params";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: PushErrorCode; readonly message: string } };

export type PushMode = "current" | "batch";
export type PushChoice = "prefer-local" | "prefer-server" | "cancel";
export type PushKind = "imo-icomposer-push" | "imo-icomposer-push-resolve";

/** Workspace-relative groovy push target + write flags captured at request time. */
export interface PushRequestInput {
  readonly workspaceId: string;
  readonly files: readonly string[];
  readonly batch?: boolean;
  readonly checkUsages?: boolean;
  readonly skipCompile?: boolean;
}

export interface PushPreviewInput {
  readonly workspaceId: string;
  readonly files: readonly string[];
  readonly batch?: boolean;
}

export interface PushCompileChecks {
  readonly compile: boolean;
  readonly callersFound: number;
  readonly callersCompiled: number;
  readonly callerFailures: number;
}

/** Allowlisted per-file dry-run preview (digest-only versions). */
export interface PushFilePreview {
  readonly file: string;
  readonly target: string;
  readonly localVersion: string;
  readonly serverVersion: string;
  readonly conflict: boolean;
  readonly compileChecks?: PushCompileChecks;
  readonly warnings: readonly string[];
}

export interface PushPreviewView {
  readonly workspaceId: string;
  readonly mode: PushMode;
  readonly files: readonly PushFilePreview[];
  readonly conflictFiles: readonly string[];
  readonly count: number;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly stdoutDigest: string;
}

/** View returned after an operation record is appended (pending). */
export interface PushRequestView {
  readonly operationId: string;
  readonly kind: PushKind;
  readonly mode: PushMode;
  readonly files: readonly string[];
  readonly paramsDigest: string;
  readonly decision: "pending";
  readonly preview: PushPreviewView;
}

/** Immutable evidence of one executed (or conflicted, or cancelled) push attempt. */
export interface PushReceipt {
  readonly operationId: string;
  readonly kind: PushKind;
  readonly mode: PushMode;
  readonly files: readonly string[];
  readonly requestedFlags: { readonly checkUsages?: boolean; readonly skipCompile?: boolean; readonly prefer?: "prefer-local" | "prefer-server" };
  readonly status: "completed" | "failed" | "conflict";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly conflictFiles: readonly string[];
  readonly conflictSummary: string;
  readonly pushDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type PushExecution =
  | { readonly ok: true; readonly receipt: PushReceipt }
  | { readonly ok: false; readonly error: { readonly code: PushErrorCode; readonly message: string; readonly operationId: string } };

export interface PushResolveInput {
  readonly operationId: string;
  readonly choice: PushChoice;
  readonly by: string;
}

/** Resolution view: a rejected resolve op (cancel) or a pending resolve op (prefer-*). */
export type PushResolveView =
  | {
      readonly operationId: string;
      readonly kind: "imo-icomposer-push-resolve";
      readonly choice: "cancel";
      readonly decision: "rejected";
      readonly reason: string;
      readonly originalOperationId: string;
    }
  | {
      readonly operationId: string;
      readonly kind: "imo-icomposer-push-resolve";
      readonly choice: "prefer-local" | "prefer-server";
      readonly decision: "pending";
      readonly originalOperationId: string;
      readonly paramsDigest: string;
      readonly mode: PushMode;
      readonly files: readonly string[];
    };

export type PushResolveResult =
  | { readonly ok: true; readonly value: PushResolveView }
  | { readonly ok: false; readonly error: { readonly code: PushErrorCode; readonly message: string; readonly operationId?: string } };

export interface PushStatusView {
  readonly operationId: string;
  readonly kind: PushKind;
  readonly decision: "pending" | "approved" | "rejected";
  readonly paramsDigest: string;
  readonly resultDigest?: string;
  readonly executed: boolean;
  readonly status?: "completed" | "failed" | "conflict";
  readonly conflictFiles: readonly string[];
  readonly prefer?: "prefer-local" | "prefer-server";
  readonly originalOperationId?: string;
  readonly reason?: string;
}

export interface IcomposerWriteFace {
  pushPreview(input: PushPreviewInput, signal?: AbortSignal): Promise<Result<PushPreviewView>>;
  pushRequest(input: PushRequestInput, signal?: AbortSignal): Promise<Result<PushRequestView>>;
  pushExecute(operationId: string, signal?: AbortSignal): Promise<PushExecution>;
  pushResolve(input: PushResolveInput, signal?: AbortSignal): Promise<PushResolveResult>;
  pushStatus(operationId: string): Promise<Result<PushStatusView>>;
  testRun(input: TestRunInput, signal?: AbortSignal): Promise<Result<TestRunView>>;
  testExecute(operationId: string, signal?: AbortSignal): Promise<TestExecution>;
  releasePreview(input: ReleasePreviewInput, signal?: AbortSignal): Promise<Result<ReleasePreviewView>>;
  releaseRepos(input: { readonly workspaceId: string }, signal?: AbortSignal): Promise<Result<ReleaseRepoView>>;
  releaseBranches(input: { readonly workspaceId: string; readonly repo: string }, signal?: AbortSignal): Promise<Result<ReleaseBranchView>>;
  releaseApply(input: ReleaseApplyInput, signal?: AbortSignal): Promise<Result<ReleaseApplyView>>;
  releaseExecute(operationId: string, signal?: AbortSignal): Promise<ReleaseExecution>;
}

// ---- TASK-029: test + release ----

export type TestKind = "api" | "function";

export interface TestRunInput {
  readonly workspaceId: string;
  readonly kind: TestKind;
  readonly name: string;
  readonly data?: string;
  readonly method?: string;
  /** Explicitly acknowledge testing server state despite local unpushed changes. */
  readonly overrideUnpushed?: boolean;
}

export type AssetJoinState = "clean" | "local-modified" | "no-server-md5" | "source-missing" | "metadata-missing";

export interface TestRunView {
  readonly operationId: string;
  readonly kind: "imo-icomposer-test";
  readonly assetKind: TestKind;
  readonly name: string;
  readonly paramsDigest: string;
  readonly decision: "pending";
  readonly joinState: AssetJoinState;
  readonly overrideUnpushed: boolean;
}

export interface TestEvidence {
  readonly elapsedMs: number;
  readonly httpStatus: number | null;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly traceId: string;
  readonly testUrl: string;
  readonly savedAt: string;
}

export interface TestReceipt {
  readonly operationId: string;
  readonly kind: "imo-icomposer-test";
  readonly assetKind: TestKind;
  readonly name: string;
  readonly overrideUnpushed: boolean;
  readonly joinState: AssetJoinState;
  readonly status: "completed" | "failed";
  readonly exitCode: number | null;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly evidence: TestEvidence;
  readonly artifactPath: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type TestExecution =
  | { readonly ok: true; readonly receipt: TestReceipt }
  | { readonly ok: false; readonly error: { readonly code: PushErrorCode; readonly message: string; readonly operationId: string } };

export interface ReleasePreviewInput {
  readonly workspaceId: string;
  readonly type: "api" | "function";
  readonly name: string;
  readonly repo: string;
  readonly branch: string;
  readonly message: string;
}

export interface ReleasePreviewView {
  readonly workspaceId: string;
  readonly type: "api" | "function";
  readonly name: string;
  readonly valid: boolean;
  readonly warnings: readonly string[];
  readonly durationMs: number;
  readonly stdoutDigest: string;
}

export interface ReleaseRepoView {
  readonly workspaceId: string;
  readonly repos: readonly string[];
  readonly count: number;
  readonly truncated: boolean;
  readonly stdoutDigest: string;
}

export interface ReleaseBranchView {
  readonly workspaceId: string;
  readonly repo: string;
  readonly branches: readonly string[];
  readonly count: number;
  readonly truncated: boolean;
  readonly stdoutDigest: string;
}

export interface ReleaseApplyInput {
  readonly workspaceId: string;
  readonly type: "api" | "function";
  readonly name: string;
  readonly repo: string;
  readonly branch: string;
  readonly message: string;
}

export interface ReleaseApplyView {
  readonly operationId: string;
  readonly kind: "imo-icomposer-release";
  readonly type: "api" | "function";
  readonly name: string;
  readonly repo: string;
  readonly branch: string;
  readonly paramsDigest: string;
  readonly decision: "pending";
}

export interface ReleaseReceipt {
  readonly operationId: string;
  readonly kind: "imo-icomposer-release";
  readonly type: "api" | "function";
  readonly name: string;
  readonly repo: string;
  readonly branch: string;
  readonly status: "completed" | "failed";
  readonly exitCode: number | null;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type ReleaseExecution =
  | { readonly ok: true; readonly receipt: ReleaseReceipt }
  | { readonly ok: false; readonly error: { readonly code: PushErrorCode; readonly message: string; readonly operationId: string } };
