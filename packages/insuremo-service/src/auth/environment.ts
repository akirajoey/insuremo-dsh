import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { runCapture, type RunFailure } from "../run.ts";

/** DevOps environment IDs use segmented names containing the InsureMO marker. */
export const FULL_ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/;
const SENSITIVE_ENV_SEGMENTS = /(?:oauth|token|cookie|state|secret|password|authorization)/i;

export interface ImoEnvironmentList {
  readonly sourceProfile: string | null;
  readonly environmentIds: readonly string[];
  readonly stdoutDigest: string;
}

export interface ImoEnvironmentResolution {
  readonly sourceProfile: string | null;
  readonly environmentId: string;
  readonly candidates: readonly string[];
  readonly environmentIds: readonly string[];
  readonly stdoutDigest: string;
}

export type EnvironmentErrorCode = RunFailure["code"] | "not-found" | "ambiguous";

export interface EnvironmentError {
  readonly code: EnvironmentErrorCode;
  readonly message: string;
  readonly candidates?: readonly string[];
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
  readonly httpStatus?: 401 | 403;
}

export type EnvironmentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EnvironmentError };

export function isFullEnvironmentId(value: unknown): value is string {
  if (typeof value !== "string" || !FULL_ENVIRONMENT_ID.test(value) || value.startsWith("-")) return false;
  if (!value.includes("_insuremo_")) return false;
  const segments = value.split("_");
  return segments.length >= 4 && segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(segment)) && !SENSITIVE_ENV_SEGMENTS.test(value);
}

export async function listEnvironmentIds(
  runtime: SubprocessRuntime,
  command: string,
  timeoutMs: number,
  sourceProfile?: string,
  signal?: AbortSignal,
): Promise<EnvironmentResult<ImoEnvironmentList>> {
  const args = ["complete", "--type", "env", ...(sourceProfile === undefined ? [] : ["--profile", sourceProfile])] as const;
  const run = await runCapture(runtime, { command, args, timeoutMs, signal });
  if (!run.ok) return { ok: false, error: runFailure(run.error) };
  const environmentIds = [...new Set(
    run.value.stdout.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(isFullEnvironmentId),
  )];
  return {
    ok: true,
    value: {
      sourceProfile: sourceProfile ?? null,
      environmentIds,
      stdoutDigest: run.value.stdoutDigest,
    },
  };
}

export async function resolveEnvironmentHint(
  runtime: SubprocessRuntime,
  command: string,
  timeoutMs: number,
  hint: string,
  sourceProfile?: string,
  signal?: AbortSignal,
): Promise<EnvironmentResult<ImoEnvironmentResolution>> {
  const listed = await listEnvironmentIds(runtime, command, timeoutMs, sourceProfile, signal);
  if (!listed.ok) return listed;
  const { environmentIds, stdoutDigest } = listed.value;
  const exact = hint.trim();
  if (isFullEnvironmentId(exact) && environmentIds.includes(exact)) {
    return resolved(listed.value, exact, [exact]);
  }
  const candidates = environmentIds.filter((candidate) => matchesHint(candidate, hint));
  if (candidates.length === 0) return notFound();
  if (candidates.length > 1) return { ok: false, error: { code: "ambiguous", message: "environment hint matched multiple candidates", candidates } };
  return resolved(listed.value, candidates[0]!, [candidates[0]!]);
}

function resolved(
  listed: ImoEnvironmentList,
  environmentId: string,
  candidates: readonly string[],
): EnvironmentResult<ImoEnvironmentResolution> {
  return {
    ok: true,
    value: {
      sourceProfile: listed.sourceProfile,
      environmentId,
      candidates,
      environmentIds: listed.environmentIds,
      stdoutDigest: listed.stdoutDigest,
    },
  };
}

function notFound(): EnvironmentResult<never> {
  return { ok: false, error: { code: "not-found", message: "environment hint did not match a candidate" } };
}

function runFailure(error: RunFailure): EnvironmentError {
  return {
    code: error.code,
    message: "IMO environment completion failed",
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    ...(error.signal === undefined ? {} : { signal: error.signal }),
    ...(error.stdoutDigest === undefined ? {} : { stdoutDigest: error.stdoutDigest }),
    ...(error.stderrDigest === undefined ? {} : { stderrDigest: error.stderrDigest }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
  };
}

function matchesHint(candidate: string, hint: string): boolean {
  const tokens = hintTokens(hint);
  const lower = candidate.toLowerCase();
  return tokens.some((token) => lower === token
    || lower.startsWith(`${token}_`)
    || lower.endsWith(`_${token}`)
    || lower.includes(`_${token}_`)
    || token.startsWith(`${lower}_`));
}

function hintTokens(value: string): readonly string[] {
  const text = value.trim().toLowerCase();
  if (text.length === 0 || text.length > 512) return [];
  try {
    const hasScheme = text.includes("://");
    const parsed = new URL(hasScheme ? text : `https://${text}`);
    if (hasScheme && parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
    const host = parsed.hostname.toLowerCase();
    const normalized = host.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const withoutCommonDomain = normalized.replace(/_(?:insuremo|imo)_(?:com|net|org)$/i, "");
    return [...new Set([normalized, withoutCommonDomain])];
  } catch {
    const normalized = text.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    return normalized.length === 0 ? [] : [normalized];
  }
}
