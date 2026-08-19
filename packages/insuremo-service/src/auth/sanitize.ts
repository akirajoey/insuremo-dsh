import type { ImoAuthProfileView } from "./types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeAuthString(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.length > 0 && cleaned.length <= max ? cleaned : undefined;
}

export function safeEndpoint(value: unknown): string | undefined {
  const text = safeAuthString(value, 2_048);
  if (text === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  // URL serialization after clearing userinfo/search/hash preserves only the
  // known scheme/host/path; malformed input never falls back to its raw text.
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return `${parsed.origin}${parsed.pathname}`;
}

export function safeTenantDomain(value: unknown): string | undefined {
  const text = safeAuthString(value, 512);
  if (text === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return undefined;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return undefined;
  return parsed.host || undefined;
}

export function rawString(record: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = safeAuthString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function rawBoolean(record: Record<string, unknown>, ...keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === "boolean") return record[key] as boolean;
  }
  return undefined;
}

export function profileView(row: unknown): ImoAuthProfileView | null {
  if (!isRecord(row)) return null;
  const profileName = rawString(row, "name", "profile_name");
  if (profileName === undefined) return null;
  const result: ImoAuthProfileView = {
    profileName,
    ...(rawString(row, "env") === undefined ? {} : { env: rawString(row, "env") }),
    ...(rawString(row, "env_id") === undefined ? {} : { envId: rawString(row, "env_id") }),
    ...(rawString(row, "tenant_code") === undefined ? {} : { tenantCode: rawString(row, "tenant_code") }),
    ...(rawString(row, "account_name") === undefined ? {} : { accountName: rawString(row, "account_name") }),
    ...(safeEndpoint(row.domain) === undefined ? {} : { domain: safeEndpoint(row.domain) }),
    ...(safeEndpoint(row.gateway) === undefined ? {} : { gateway: safeEndpoint(row.gateway) }),
    ...(safeTenantDomain(row.tenant_domain) === undefined ? {} : { tenantDomain: safeTenantDomain(row.tenant_domain) }),
    ...(rawString(row, "source") === undefined ? {} : { source: rawString(row, "source") }),
    ...(rawString(row, "scope") === undefined ? {} : { scope: rawString(row, "scope") }),
    ...(rawString(row, "user_source_id") === undefined ? {} : { userSourceId: rawString(row, "user_source_id") }),
    ...(rawBoolean(row, "valid") === undefined ? {} : { valid: rawBoolean(row, "valid") }),
    ...(rawBoolean(row, "is_default") === undefined ? {} : { isDefault: rawBoolean(row, "is_default") }),
  };
  return result;
}

export function authStatusFromText(...values: readonly (string | undefined)[]): "invalid-auth" | "forbidden" | undefined {
  const text = values.filter((value): value is string => value !== undefined).join(" ");
  if (/\b401\b|unauthori[sz]ed|invalid(?:\s+|-)auth|token(?:\s+|-)expired/i.test(text)) return "invalid-auth";
  if (/\b403\b|forbidden|permission\s+denied/i.test(text)) return "forbidden";
  return undefined;
}

export function safeStatus(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return String(value);
  const text = safeAuthString(value, 64)?.toLowerCase();
  if (text === undefined) return undefined;
  if (/^(?:valid|invalid|ok|error|pending|active|inactive|expired|unauthorized|forbidden|[1-5]\d\d)$/.test(text)) return text;
  return undefined;
}

export function safeReason(value: unknown): string | undefined {
  const text = safeAuthString(value, 128)?.toLowerCase();
  if (text === undefined) return undefined;
  if (/expired/.test(text)) return "expired";
  if (/unauthor|invalid.*auth|invalid.*token/.test(text)) return "invalid-auth";
  if (/forbidden|permission/.test(text)) return "forbidden";
  if (/not[ -]?found|missing/.test(text)) return "not-found";
  if (/valid|success|ok/.test(text)) return "valid";
  if (/invalid|fail|error/.test(text)) return "invalid";
  return undefined;
}

export function parseDefaultProfile(output: string): string | null | undefined {
  const text = output.trim();
  if (text.length === 0 || /^(?:none|no default profile(?: configured| set)?|not set)$/i.test(text)) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null) return null;
    if (typeof parsed === "string") return safeAuthString(parsed, 200) ?? undefined;
    if (isRecord(parsed)) return rawString(parsed, "profile_name", "name") ?? undefined;
    return undefined;
  } catch {
    const firstLine = text.split(/\r?\n/)[0]?.trim() ?? "";
    return /^[A-Za-z0-9_.:@/-]{1,200}$/.test(firstLine) ? firstLine : undefined;
  }
}
