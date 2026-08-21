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
  | "conflict-resolution-required";

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
}
