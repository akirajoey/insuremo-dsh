import { JSON_LIMIT_BYTES } from "./capture.ts";
import type { SearchMatch, UtilClassSummary, VerifyIssue, VerifyUsage } from "./types.ts";

/** Result-list cap and per-field clip widths (emitted values stay ≤ these). */
export const RESULTS_MAX = 1000;
export const FIELD_TEXT_MAX = 200;

export interface ListProjection {
  readonly mode: "list";
  readonly classes: readonly UtilClassSummary[];
  readonly count: number;
  readonly truncated: boolean;
}

export interface SearchProjection {
  readonly mode: "search";
  readonly matches: readonly SearchMatch[];
  readonly count: number;
  readonly truncated: boolean;
}

export interface ReportProjection {
  readonly mode: "report";
  readonly valid: boolean;
  readonly classesChecked: number;
  readonly used: readonly VerifyUsage[];
  readonly unknownClasses: readonly string[];
  readonly invalidMethods: readonly VerifyIssue[];
}

export type VerifyProjection = ListProjection | SearchProjection | ReportProjection;

export type ParseVerifyResult =
  | { readonly ok: true; readonly value: VerifyProjection }
  | { readonly ok: false; readonly error: "parse-error" | "not-json" };

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "\u2026" : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v) return undefined;
  return clip(v, FIELD_TEXT_MAX);
}

function boundedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value.slice(0, RESULTS_MAX)) {
    const v = boundedString(item);
    if (v !== undefined) out.push(v);
  }
  return out;
}

function frozen<T extends object>(value: T): T {
  return Object.freeze({ ...value }) as T;
}

/**
 * Strict allowlist projection of `imo icomposer verify utils --json` stdout.
 * Only `result` is read; envelope fields (`base_url`, `profile_name`,
 * `cache_file`, `warnings`) are dropped. Lists are capped at 1000 with a
 * `truncated` flag; every emitted string is bounded to 200 chars.
 */
export function parseVerifyOutput(text: string): ParseVerifyResult {
  if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return { ok: false, error: "parse-error" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "not-json" };
  }
  if (!isRecord(parsed) || !isRecord(parsed.result)) return { ok: false, error: "parse-error" };
  const result = parsed.result as Record<string, unknown>;
  if (result.type === "list") {
    const raw = result.classes;
    if (!Array.isArray(raw)) return { ok: false, error: "parse-error" };
    const count = raw.length;
    const classes: UtilClassSummary[] = [];
    for (const item of raw.slice(0, RESULTS_MAX)) {
      if (!isRecord(item)) continue;
      const className = boundedString(item.class);
      if (className === undefined) continue;
      const methodCount = typeof item.method_count === "number" && Number.isFinite(item.method_count) ? Math.max(0, Math.trunc(item.method_count)) : 0;
      const description = boundedString(item.description);
      classes.push(frozen({ className, methodCount, ...(description === undefined ? {} : { description }) }) as UtilClassSummary);
    }
    return { ok: true, value: frozen({ mode: "list", classes: Object.freeze(classes), count, truncated: count > RESULTS_MAX }) };
  }
  if (result.type === "search") {
    const raw = result.matches;
    if (!Array.isArray(raw)) return { ok: false, error: "parse-error" };
    const count = raw.length;
    const matches: SearchMatch[] = [];
    for (const item of raw.slice(0, RESULTS_MAX)) {
      if (!isRecord(item)) continue;
      const className = boundedString(item.class);
      if (className === undefined) continue;
      const method = boundedString(item.method);
      const description = boundedString(item.description);
      matches.push(frozen({
        className,
        ...(method === undefined ? {} : { method }),
        ...(description === undefined ? {} : { description }),
      }) as SearchMatch);
    }
    return { ok: true, value: frozen({ mode: "search", matches: Object.freeze(matches), count, truncated: count > RESULTS_MAX }) };
  }
  if (result.type === "verify") {
    const report = isRecord(result.report) ? result.report : {};
    const usedRaw = Array.isArray(report.used) ? report.used : [];
    const used: VerifyUsage[] = [];
    for (const item of usedRaw.slice(0, RESULTS_MAX)) {
      if (!isRecord(item)) continue;
      const className = boundedString(item.class);
      if (className === undefined) continue;
      used.push(frozen({ className, methods: Object.freeze(boundedStringList(item.methods)) }) as VerifyUsage);
    }
    const invalidMethods: VerifyIssue[] = [];
    const invalidRaw = Array.isArray(report.invalid_methods) ? report.invalid_methods : [];
    for (const item of invalidRaw.slice(0, RESULTS_MAX)) {
      if (isRecord(item)) {
        const className = boundedString(item.class);
        const method = boundedString(item.method);
        const line = typeof item.line === "number" ? String(item.line) : boundedString(item.line);
        const suggestions = boundedStringList(item.suggestions);
        if (className === undefined && method === undefined && line === undefined) continue;
        invalidMethods.push(frozen({
          ...(className === undefined ? {} : { className }),
          ...(method === undefined ? {} : { method }),
          ...(line === undefined ? {} : { line }),
          ...(suggestions.length === 0 ? {} : { suggestions: Object.freeze(suggestions) }),
        }) as VerifyIssue);
      } else {
        const detail = boundedString(item);
        if (detail !== undefined) invalidMethods.push(frozen({ method: detail }) as VerifyIssue);
      }
    }
    return {
      ok: true,
      value: frozen({
        mode: "report",
        valid: report.valid === true,
        classesChecked: typeof report.classes_checked === "number" && Number.isFinite(report.classes_checked) ? Math.max(0, Math.trunc(report.classes_checked)) : 0,
        used: Object.freeze(used),
        unknownClasses: Object.freeze(boundedStringList(report.unknown_classes)),
        invalidMethods: Object.freeze(invalidMethods),
      }),
    };
  }
  return { ok: false, error: "parse-error" };
}
