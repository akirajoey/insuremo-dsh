const FULL_ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/;
const SENSITIVE_ENV_SEGMENTS = /(?:oauth|token|cookie|state|secret|password|authorization)/i;
const TENANT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/;

export function isFullInsuremoEnvId(value: unknown): boolean {
  if (typeof value !== "string" || !FULL_ENVIRONMENT_ID.test(value)) return false;
  if (!value.includes("_insuremo_")) return false;
  const segments = value.split("_");
  if (segments.length < 4) return false;
  if (!segments.every((s) => /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(s))) return false;
  if (SENSITIVE_ENV_SEGMENTS.test(value)) return false;
  return true;
}

export function isTenantCode(value: unknown): boolean {
  return typeof value === "string" && TENANT_CODE_RE.test(value);
}

export function isAuthProfile(value: unknown): boolean {
  return typeof value === "string" && PROFILE_RE.test(value);
}

export function isWriteMode(value: unknown): value is "read-only" | "read-write" {
  return value === "read-only" || value === "read-write";
}

export function isWorkspaceId(value: unknown): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 512;
}
