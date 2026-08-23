import type { RunFailure } from "../run.ts";

/** Sanitized profile fields exposed to callers; unknown CLI fields are dropped. */
export interface ImoAuthProfileView {
  readonly profileName: string;
  readonly env?: string;
  readonly envId?: string;
  readonly tenantCode?: string;
  readonly accountName?: string;
  readonly domain?: string;
  readonly gateway?: string;
  readonly tenantDomain?: string;
  readonly source?: string;
  readonly scope?: string;
  readonly userSourceId?: string;
  readonly valid?: boolean;
  readonly isDefault?: boolean;
}

export interface ImoAuthProfileList {
  readonly profiles: readonly ImoAuthProfileView[];
  readonly stdoutDigest: string;
}

export interface ImoAuthDefaultProfile {
  readonly profileName: string | null;
  readonly stdoutDigest: string;
}

export interface ImoAuthValidation {
  readonly profileName: string | null;
  readonly valid: boolean;
  readonly status?: string;
  readonly reason?: string;
  readonly checkedAt: string;
  readonly stdoutDigest: string;
}

export type ImoAuthErrorCode =
  | RunFailure["code"]
  | "parse-error"
  | "invalid-auth"
  | "forbidden"
  | typeof AUTH_PREPARE_INVALIDATED_CODE
  | typeof AUTH_SERVICE_DISPOSED_CODE;

/** Digest-only auth failure; raw CLI streams and messages never cross this face. */
export interface ImoAuthError {
  readonly code: ImoAuthErrorCode;
  readonly message: string;
  readonly command: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly httpStatus?: 401 | 403;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
}

export type ImoAuthResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ImoAuthError };

export interface ImoAuthPrepareRequest {
  readonly profile?: string;
  readonly env?: string;
}

/** Secret shape visible only as the callback argument of {@link ImoAuthLease.use}. */
export interface ImoAuthSecret {
  readonly accessToken: string;
  readonly profileName?: string;
  readonly env?: string;
  readonly envId?: string;
  readonly tenantCode?: string;
  readonly accountName?: string;
  readonly domain?: string;
  readonly gateway?: string;
  readonly tenantDomain?: string;
  readonly source?: string;
  readonly scope?: string;
  readonly userSourceId?: string;
}

/** Public lease metadata; deliberately contains no token-bearing property. */
export interface ImoAuthLeaseView {
  readonly profileName: string | null;
  readonly env: string | null;
  readonly envId: string | null;
  readonly tenantCode: string | null;
  readonly accountName: string | null;
  readonly domain: string | null;
  readonly gateway: string | null;
  readonly tenantDomain: string | null;
  readonly source: string | null;
  readonly scope: string | null;
  readonly userSourceId: string | null;
}

export interface ImoAuthLeaseCacheMetadata {
  readonly storage: "memory";
  readonly createdAt: string;
  readonly reused: boolean;
}

/** Opaque capability: the only token handoff is the explicit `use` callback. */
export interface ImoAuthLease {
  readonly view: ImoAuthLeaseView;
  readonly cache: ImoAuthLeaseCacheMetadata;
  use<T>(callback: (secret: ImoAuthSecret) => Promise<T> | T): Promise<T>;
}

export type ImoAuthInvalidateReason = "unauthorized" | "profile-changed" | "manual";

export interface ImoAuthInvalidateRequest {
  readonly profile?: string | null;
  readonly env?: string | null;
  readonly reason: ImoAuthInvalidateReason;
}

export interface ImoAuthInvalidation {
  readonly invalidated: number;
  readonly reason: ImoAuthInvalidateReason;
}

export interface ImoAuthCacheStatus {
  readonly size: number;
}

export const AUTH_CACHE_INVALIDATED_EVENT = "auth/cache-invalidated" as const;
export const AUTH_LEASE_REVOKED_CODE = "lease-revoked" as const;
export const AUTH_PREPARE_INVALIDATED_CODE = "prepare-invalidated" as const;
export const AUTH_SERVICE_DISPOSED_CODE = "service-disposed" as const;

/** Stable non-secret rejection raised when a lease is used after revocation. */
export class ImoAuthLeaseRevokedError extends Error {
  readonly code = AUTH_LEASE_REVOKED_CODE;

  constructor() {
    super("auth lease revoked");
    this.name = "ImoAuthLeaseRevokedError";
  }
}

/** Fast snapshot derived from the imo CLI's plaintext profile store
 * (TASK-041): millisecond file read, no subprocess, no token material —
 * only the allowlisted descriptive fields. */
export interface ImoAuthProfilesFast {
  readonly profiles: readonly ImoAuthProfileView[];
  readonly defaultProfile: string | null;
  readonly stale: boolean;
}

/** The sole authentication surface for later remote tools. */
export interface ImoAuth {
  listProfiles(signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthProfileList>>;
  /** 60s-TTL cached listProfiles; on CLI failure serves the last good list
   * with stale=true instead of an empty error. */
  listProfilesCached(signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthProfileList>>;
  /** Direct read of the imo profile store (no subprocess). Degrades to the
   * cached CLI list (stale=true) when the file is missing/unreadable. */
  profilesFast(signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthProfilesFast>>;
  defaultProfile(signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthDefaultProfile>>;
  validate(profile?: string, signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthValidation>>;
  prepare(request?: ImoAuthPrepareRequest, signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthLease>>;
  invalidate(request: ImoAuthInvalidateRequest): ImoAuthInvalidation;
  cacheStatus(): ImoAuthCacheStatus;
}
