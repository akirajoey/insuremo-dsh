import type { RunFailure } from "../run.ts";
import type { ImoAuthProfileView } from "./types.ts";
import type { ImoEnvironmentList, ImoEnvironmentResolution } from "./environment.ts";

export type ImoAuthActionScope = "global" | "workspace";
export type ImoAuthActionKind =
  | "imo-auth-login"
  | "imo-auth-remote-profile"
  | "imo-auth-default-profile";

export const IMO_AUTH_LOGIN_KIND = "imo-auth-login" as const;
export const IMO_AUTH_REMOTE_KIND = "imo-auth-remote-profile" as const;
export const IMO_AUTH_DEFAULT_KIND = "imo-auth-default-profile" as const;
export const AUTH_ACTION_COMPLETED_EVENT = "auth/action-completed" as const;
export const AUTH_ACTION_FAILED_EVENT = "auth/action-failed" as const;

export type ImoAuthActionErrorCode =
  | RunFailure["code"]
  | "busy"
  | "missing-operation"
  | "not-approved"
  | "already-executed"
  | "wrong-kind"
  | "invalid-input"
  | "not-found"
  | "ambiguous"
  | "profile-not-found"
  | "environment-not-resolved"
  | "manual-not-supported"
  | "action-state-lost"
  | "missing-pending-input"
  | "operation-params-mismatch"
  | "pre-check-failed"
  | "record-failed"
  | "invalid-auth"
  | "forbidden";

export interface ImoAuthActionError {
  readonly code: ImoAuthActionErrorCode;
  readonly message: string;
  readonly operationId?: string;
  readonly candidates?: readonly string[];
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly httpStatus?: 401 | 403;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
}

export type ImoAuthActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ImoAuthActionError };

export interface ImoAuthActionRequest {
  readonly operationId: string;
  readonly kind: ImoAuthActionKind;
  readonly paramsDigest: string;
}

export interface PortalLoginRequest {
  /** Optional compatibility guard; the service always sends `portal`. */
  readonly env?: string;
  readonly tenantCode?: string;
  readonly userSourceId?: string;
  readonly force?: boolean;
  readonly scope?: ImoAuthActionScope;
  /** Manual two-step callback is reserved for a later transient-channel UI. */
  readonly manual?: boolean;
  readonly mode?: "browser" | "manual";
}

export interface RemoteProfileRequest {
  /** Canonical full environment ID; `environmentId` is accepted as an alias. */
  readonly env?: string;
  readonly environmentId?: string;
  /** Source profile passed to `--profile`; never confused with targetProfile. */
  readonly sourceProfile?: string;
  readonly profile?: string;
  readonly targetProfile?: string;
  readonly targetTenant?: string;
  readonly scope?: ImoAuthActionScope;
}

export interface DefaultProfileSwitchRequest {
  readonly profile: string;
  readonly scope?: ImoAuthActionScope;
}

export interface ImoAuthActionReceipt {
  readonly operationId: string;
  readonly kind: ImoAuthActionKind;
  readonly status: "completed" | "failed";
  readonly exitCode: number | null;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly profileName?: string;
  readonly environmentId?: string;
  readonly targetProfile?: string;
  readonly profileSnapshot?: ImoAuthProfileView | null;
}

export type ImoAuthActionHint = "login-required" | "permission-denied";

export type ImoAuthActionExecution =
  | { readonly ok: true; readonly receipt: ImoAuthActionReceipt; readonly hint?: ImoAuthActionHint }
  | { readonly ok: false; readonly error: ImoAuthActionError };

export interface ImoAuthActionStatus {
  readonly running: boolean;
  readonly current?: { readonly operationId: string; readonly kind: ImoAuthActionKind };
}

export interface ImoAuthActions {
  listEnvironmentIds(sourceProfile?: string, signal?: AbortSignal): Promise<ImoAuthActionResult<ImoEnvironmentList>>;
  resolveEnvironmentHint(hint: string, sourceProfile?: string, signal?: AbortSignal): Promise<ImoAuthActionResult<ImoEnvironmentResolution>>;
  requestPortalLogin(input?: PortalLoginRequest, signal?: AbortSignal): Promise<ImoAuthActionResult<ImoAuthActionRequest>>;
  executePortalLogin(operationId: string, signal?: AbortSignal): Promise<ImoAuthActionExecution>;
  requestRemote(input: RemoteProfileRequest, signal?: AbortSignal): Promise<ImoAuthActionResult<ImoAuthActionRequest>>;
  executeRemote(operationId: string, signal?: AbortSignal): Promise<ImoAuthActionExecution>;
  requestDefaultSwitch(input: DefaultProfileSwitchRequest, signal?: AbortSignal): Promise<ImoAuthActionResult<ImoAuthActionRequest>>;
  executeDefaultSwitch(operationId: string, signal?: AbortSignal): Promise<ImoAuthActionExecution>;
  /** One-shot direct default switch (TASK-039): no operation record, same kernel. */
  runDirectDefaultSwitch(input: DefaultProfileSwitchRequest, signal?: AbortSignal): Promise<ImoAuthActionExecution>;
  executeAction(operationId: string, signal?: AbortSignal): Promise<ImoAuthActionExecution>;
  actionStatus(): ImoAuthActionStatus;
}

export type PendingAction =
  | { readonly kind: typeof IMO_AUTH_LOGIN_KIND; readonly input: NormalizedLogin }
  | { readonly kind: typeof IMO_AUTH_REMOTE_KIND; readonly input: NormalizedRemote }
  | { readonly kind: typeof IMO_AUTH_DEFAULT_KIND; readonly input: NormalizedDefault };

export interface NormalizedLogin {
  readonly tenantCode?: string;
  readonly userSourceId?: string;
  readonly force: boolean;
  readonly scope?: ImoAuthActionScope;
}

export interface NormalizedRemote {
  readonly environmentId: string;
  readonly sourceProfile?: string;
  readonly targetProfile?: string;
  readonly targetTenant?: string;
  readonly scope?: ImoAuthActionScope;
}

export interface NormalizedDefault {
  readonly profile: string;
  readonly scope?: ImoAuthActionScope;
}

export interface ReceiptInput {
  readonly operationId: string;
  readonly kind: ImoAuthActionKind;
  readonly status: "completed" | "failed";
  readonly exitCode: number | null;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly startedAt: string;
  readonly profileName?: string;
  readonly environmentId?: string;
  readonly targetProfile?: string;
  readonly profileSnapshot?: ImoAuthProfileView | null;
  readonly httpStatus?: 401 | 403;
}
