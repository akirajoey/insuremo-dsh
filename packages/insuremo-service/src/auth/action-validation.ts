import { digest } from "../run.ts";
import type {
  DefaultProfileSwitchRequest,
  ImoAuthActionKind,
  ImoAuthActionResult,
  ImoAuthActionScope,
  NormalizedDefault,
  NormalizedLogin,
  NormalizedRemote,
  PortalLoginRequest,
  RemoteProfileRequest,
} from "./action-types.ts";
import { isFullEnvironmentId } from "./environment.ts";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/;
const TENANT_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const USER_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/;

export function validateSourceProfile(value: unknown): ImoAuthActionResult<string | undefined> {
  return validateOptional(value, PROFILE_NAME, "source profile is invalid");
}

export function validateTargetProfile(value: unknown): ImoAuthActionResult<string | undefined> {
  return validateOptional(value, PROFILE_NAME, "target profile is invalid");
}

export function validateDefaultProfile(value: unknown): ImoAuthActionResult<string> {
  const result = validateOptional(value, PROFILE_NAME, "default profile is invalid");
  return result.ok && result.value !== undefined
    ? { ok: true, value: result.value }
    : failure("invalid-input", "default profile is required");
}

export function validateTenantCode(value: unknown): ImoAuthActionResult<string | undefined> {
  return validateOptional(value, TENANT_CODE, "tenant code is invalid");
}

export function validateTargetTenant(value: unknown): ImoAuthActionResult<string | undefined> {
  return validateOptional(value, TENANT_CODE, "target tenant is invalid");
}

export function validateUserSourceId(value: unknown): ImoAuthActionResult<string | undefined> {
  return validateOptional(value, USER_SOURCE_ID, "user source ID is invalid");
}

export function validateScope(value: unknown): ImoAuthActionResult<ImoAuthActionScope | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return value === "global" || value === "workspace"
    ? { ok: true, value }
    : failure("invalid-input", "auth action scope is invalid");
}

export function validateEnvironmentId(value: unknown): ImoAuthActionResult<string> {
  return typeof value === "string" && isFullEnvironmentId(value)
    ? { ok: true, value }
    : failure("invalid-input", "remote environment ID is invalid");
}

export function canonicalActionParamsDigest(
  kind: ImoAuthActionKind,
  input: NormalizedLogin | NormalizedRemote | NormalizedDefault,
): string {
  const canonicalInput = kind === "imo-auth-login"
    ? canonicalLogin(input as NormalizedLogin)
    : kind === "imo-auth-remote-profile"
      ? canonicalRemote(input as NormalizedRemote)
      : canonicalDefault(input as NormalizedDefault);
  return digest(JSON.stringify({ kind, input: canonicalInput }));
}

export function normalizePortalLogin(input: PortalLoginRequest): ImoAuthActionResult<NormalizedLogin> {
  if (input.env !== undefined && input.env !== "portal") return failure("invalid-input", "portal login only accepts the portal environment");
  if (input.manual === true || input.mode === "manual") return failure("manual-not-supported", "manual auth login is not supported");
  if (input.mode !== undefined && input.mode !== "browser") return failure("invalid-input", "portal login mode is invalid");
  if (input.force !== undefined && typeof input.force !== "boolean") return failure("invalid-input", "portal login force flag is invalid");
  const tenantCode = validateTenantCode(input.tenantCode);
  if (!tenantCode.ok) return tenantCode;
  const userSourceId = validateUserSourceId(input.userSourceId);
  if (!userSourceId.ok) return userSourceId;
  const scope = validateScope(input.scope);
  if (!scope.ok) return scope;
  return {
    ok: true,
    value: {
      ...(tenantCode.value === undefined ? {} : { tenantCode: tenantCode.value }),
      ...(userSourceId.value === undefined ? {} : { userSourceId: userSourceId.value }),
      force: input.force === true,
      ...(scope.value === undefined ? {} : { scope: scope.value }),
    },
  };
}

export function normalizeRemote(input: RemoteProfileRequest, resolved: boolean): ImoAuthActionResult<NormalizedRemote> {
  if (input.environmentId !== undefined && input.env !== undefined && input.environmentId !== input.env) {
    return failure("invalid-input", "remote environment aliases disagree");
  }
  if (input.sourceProfile !== undefined && input.profile !== undefined && input.sourceProfile !== input.profile) {
    return failure("invalid-input", "remote source profile aliases disagree");
  }
  const environmentId = validateEnvironmentId(input.environmentId ?? input.env);
  if (!environmentId.ok) return environmentId;
  const sourceProfile = validateSourceProfile(input.sourceProfile ?? input.profile);
  if (!sourceProfile.ok) return sourceProfile;
  const targetProfile = validateTargetProfile(input.targetProfile);
  if (!targetProfile.ok) return targetProfile;
  const targetTenant = validateTargetTenant(input.targetTenant);
  if (!targetTenant.ok) return targetTenant;
  const scope = validateScope(input.scope);
  if (!scope.ok) return scope;
  if (!resolved) return failure("environment-not-resolved", "remote environment ID was not confirmed by completion");
  return {
    ok: true,
    value: {
      environmentId: environmentId.value,
      ...(sourceProfile.value === undefined ? {} : { sourceProfile: sourceProfile.value }),
      ...(targetProfile.value === undefined ? {} : { targetProfile: targetProfile.value }),
      ...(targetTenant.value === undefined ? {} : { targetTenant: targetTenant.value }),
      ...(scope.value === undefined ? {} : { scope: scope.value }),
    },
  };
}

export function normalizeDefault(input: DefaultProfileSwitchRequest): ImoAuthActionResult<NormalizedDefault> {
  const profile = validateDefaultProfile(input.profile);
  if (!profile.ok) return profile;
  const scope = validateScope(input.scope);
  if (!scope.ok) return scope;
  return {
    ok: true,
    value: {
      profile: profile.value,
      ...(scope.value === undefined ? {} : { scope: scope.value }),
    },
  };
}

function canonicalLogin(input: NormalizedLogin): Record<string, unknown> {
  return { tenantCode: input.tenantCode ?? null, userSourceId: input.userSourceId ?? null, force: input.force === true, scope: input.scope ?? null };
}

function canonicalRemote(input: NormalizedRemote): Record<string, unknown> {
  return { environmentId: input.environmentId, sourceProfile: input.sourceProfile ?? null, targetProfile: input.targetProfile ?? null, targetTenant: input.targetTenant ?? null, scope: input.scope ?? null };
}

function canonicalDefault(input: NormalizedDefault): Record<string, unknown> {
  return { profile: input.profile, scope: input.scope ?? null };
}

function validateOptional(value: unknown, pattern: RegExp, message: string): ImoAuthActionResult<string | undefined> {
  return value === undefined
    ? { ok: true, value: undefined }
    : typeof value === "string" && pattern.test(value)
      ? { ok: true, value }
      : failure("invalid-input", message);
}

function failure<T = never>(code: "invalid-input" | "manual-not-supported" | "environment-not-resolved", message: string): { readonly ok: false; readonly error: { readonly code: typeof code; readonly message: string } } {
  return { ok: false, error: { code, message } };
}
