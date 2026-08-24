/** Pure helpers for the ImoAuth service (split out to keep the service ≤500 lines). */
import { type RunFailure } from "../run.ts";
import { AUTH_PREPARE_INVALIDATED_CODE, AUTH_SERVICE_DISPOSED_CODE } from "./types.ts";
import type { AuthCacheEntry } from "./lease.ts";
import type {
  ImoAuthError,
  ImoAuthInvalidateRequest,
  ImoAuthResult,
} from "./types.ts";

/** 60s TTL for the sanitized fast profile/list/default caches. */
export const LIST_CACHE_TTL_MS = 60_000;

export function authCancelled(command: string): ImoAuthResult<never> {
  return { ok: false, error: { code: "cancelled", message: `imo command cancelled: ${command}`, command } };
}

export interface PendingAuthPrepare {
  readonly profile: string | null;
  readonly env: string | null;
  readonly epoch: number;
  readonly generation: number;
  invalidated: boolean;
  promise: Promise<ImoAuthResult<AuthCacheEntry>>;
}

export function authParseError(command: string, phase: string, stdoutDigest: string, stderrDigest: string): ImoAuthResult<never> {
  return {
    ok: false,
    error: {
      code: "parse-error",
      message: `IMO auth ${phase} output could not be parsed`,
      command,
      stdoutDigest,
      stderrDigest,
    },
  };
}

export function authRunError(
  error: RunFailure,
  command: string,
  phase: string,
  classifyStatus = false,
): ImoAuthError {
  const status = classifyStatus
    ? error.httpStatus === 401
      ? "invalid-auth"
      : error.httpStatus === 403
        ? "forbidden"
        : undefined
    : undefined;
  const code = status ?? error.code;
  return {
    code,
    message: `IMO auth ${phase} failed: ${code}`,
    command,
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    ...(error.signal === undefined ? {} : { signal: error.signal }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.stdoutDigest === undefined ? {} : { stdoutDigest: error.stdoutDigest }),
    ...(error.stderrDigest === undefined ? {} : { stderrDigest: error.stderrDigest }),
  };
}

export function authStatusError(
  code: "invalid-auth" | "forbidden",
  command: string,
  phase: string,
  stdoutDigest: string,
  stderrDigest: string,
): ImoAuthResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: `IMO auth ${phase} failed: ${code}`,
      command,
      httpStatus: code === "invalid-auth" ? 401 : 403,
      stdoutDigest,
      stderrDigest,
    },
  };
}

export function authLifecycleError(
  code: typeof AUTH_PREPARE_INVALIDATED_CODE | typeof AUTH_SERVICE_DISPOSED_CODE,
  command: string,
): ImoAuthResult<never> {
  return {
    ok: false,
    error: { code, message: `IMO auth prepare failed: ${code}`, command },
  };
}

export function authCacheKey(profile: string | null, env: string | null): string {
  return JSON.stringify([profile, env]);
}

export function authCacheMatches(
  entry: { readonly profile: string | null; readonly env: string | null },
  request: ImoAuthInvalidateRequest,
): boolean {
  return (request.profile === undefined || entry.profile === request.profile)
    && (request.env === undefined || entry.env === request.env);
}
