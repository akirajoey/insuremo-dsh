import { digest } from "./capture.ts";
import type { PushCompileChecks, PushFilePreview } from "./types.ts";

/** JSON parse window for push stdout. */
export const JSON_LIMIT_BYTES = 1024 * 1024;
export const RESULTS_MAX = 200;
export const WARNINGS_MAX = 20;
export const FIELD_TEXT_MAX = 200;

/** Fixed conflict markers looked for on stdout/stderr (allowlist, not content). */
const CONFLICT_MARKERS = [
  "conflict-needs-strategy",
  "Conflict Files:",
  "conflict-skipped",
  '"conflict"',
];

export function stdoutHasConflict(text: string): boolean {
  const lower = text.toLowerCase();
  return CONFLICT_MARKERS.some(marker => lower.includes(marker.toLowerCase()));
}

export type ParsePushResult =
  | { readonly ok: true; readonly value: PushParseView }
  | { readonly ok: false; readonly error: "parse-error" | "not-json" };

/** Parsed raw view (before the service fills localVersion from disk). */
export interface PushParseView {
  readonly files: readonly PushFilePreview[];
  readonly conflictFiles: readonly string[];
  readonly conflict: boolean;
}

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

function boundedStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value.slice(0, max)) {
    const v = boundedString(item);
    if (v !== undefined) out.push(v);
  }
  return out;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = boundedString(record[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function entryConflict(entry: Record<string, unknown>): boolean {
  if (entry.conflict === true) return true;
  const action = pickString(entry, ["action", "status", "result_type", "conflict_strategy"]);
  if (action !== undefined && action.toLowerCase().includes("conflict")) return true;
  return false;
}

function entryCompileChecks(entry: Record<string, unknown>): PushCompileChecks | undefined {
  const compile = entry.compile === true || entry.compiled === true || entry.would_compile === true
    || (typeof entry.compile === "boolean" ? entry.compile : false)
    || (typeof entry.compiled === "boolean" ? entry.compiled : false);
  const callersFound = int(entry.callers_found) ?? int(entry.callersFound) ?? 0;
  const callersCompiled = int(entry.callers_compiled) ?? int(entry.callersCompiled) ?? 0;
  const callerFailures = int(entry.caller_failures) ?? int(entry.callerFailures) ?? 0;
  if (callersFound === 0 && callersCompiled === 0 && callerFailures === 0 && !compile) return undefined;
  return { compile, callersFound, callersCompiled, callerFailures };
}

/** Ordered file list semantics: entry.path falls back to the requested path. */
function projectEntry(entry: Record<string, unknown>, requestedPath: string, index: number): PushFilePreview {
  const path = boundedString(entry.file) ?? requestedPath;
  const target = pickString(entry, ["requestpath", "request_path", "target", "name", "remote_name"])
    ?? path;
  const version = pickString(entry, ["remote_version", "remoteVersion", "version", "server_version"])
    ?? "";
  const warnings = boundedStringList(entry.warnings, WARNINGS_MAX);
  const compileChecks = entryCompileChecks(entry);
  const conflict = entryConflict(entry);
  // batch entries may appear nested under an "ops"/"results" key
  return {
    file: clip(path, FIELD_TEXT_MAX) ?? requestedPath,
    target: clip(target, FIELD_TEXT_MAX),
    localVersion: "",
    serverVersion: version,
    conflict,
    ...(compileChecks === undefined ? {} : { compileChecks }),
    warnings,
  };
}

function topLevelConflict(parsed: Record<string, unknown>): boolean {
  if (parsed.conflict === true) return true;
  const action = pickString(parsed, ["action", "status", "result_type", "conflict_strategy"]);
  if (action !== undefined && action.toLowerCase().includes("conflict")) return true;
  if (Array.isArray(parsed.conflicts) && parsed.conflicts.length > 0) return true;
  if (Array.isArray(parsed.conflict_files) && parsed.conflict_files.length > 0) return true;
  const candidates = [parsed.files, parsed.results, parsed.items, parsed.ops].find(candidate => Array.isArray(candidate)) as unknown[] | undefined;
  if (candidates !== undefined) {
    return candidates.some((item: unknown) => isRecord(item) && entryConflict(item));
  }
  return false;
}

/**
 * Strict allowlist projection of `imo icomposer push … --json` stdout.
 * Only named fields are read with bounded lengths; requested file paths are
 * always preferred so a hostile CLI cannot rewrite the caller's own file list.
 * `localVersion` is filled by the service from the local file content —
 * the transport payload never contains file contents, only digests.
 */
export function parsePushOutput(text: string, requestedPaths: readonly string[], fallbackPath: string): ParsePushResult {
  if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return { ok: false, error: "parse-error" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "not-json" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "parse-error" };
  const result = isRecord(parsed.result) ? parsed.result : parsed;

  // Per-file entries: prefer arrays, then per-file objects, then single-file.
  const entryArray = (["files", "results", "items", "ops"] as const)
    .map(key => (Array.isArray(result[key]) ? result[key] as unknown[] : undefined))
    .find((candidate): candidate is unknown[] => candidate !== undefined);
  if (entryArray !== undefined) {
    const files: PushFilePreview[] = [];
    const conflictFiles: string[] = [];
    entryArray.slice(0, RESULTS_MAX).forEach((item, index) => {
      if (!isRecord(item)) return;
      const requested = requestedPaths[index] ?? fallbackPath;
      const projected = projectEntry(item, requested, index);
      files.push({ ...projected, localVersion: "" });
      if (projected.conflict) conflictFiles.push(projected.file);
    });
    // fall back to requested paths for entries the CLI did not echo
    for (let i = files.length; i < requestedPaths.length && i < RESULTS_MAX; i++) {
      files.push({
        file: requestedPaths[i], target: requestedPaths[i], localVersion: "",
        serverVersion: "", conflict: false, warnings: [],
      });
    }
    return {
      ok: true,
      value: {
        files,
        conflictFiles,
        conflict: conflictFiles.length > 0 || topLevelConflict(result),
      },
    };
  }

  // Per-file object map: key = file path (or name).
  const fileObjKey = (["files", "results", "by_file", "results_by_file"] as const).find(key => isRecord(result[key]));
  if (fileObjKey !== undefined) {
    const fileObj = result[fileObjKey] as Record<string, unknown>;
    const files: PushFilePreview[] = [];
    const conflictFiles: string[] = [];
    for (const key of Object.keys(fileObj)) {
      const item = fileObj[key];
      if (!isRecord(item)) {
        // values may be arrays of detail objects
        if (Array.isArray(item) && item.length > 0 && isRecord(item[0])) {
          const sub = item[0];
          const projected = projectEntry(sub, key, files.length);
          files.push({ ...projected, file: boundedString(sub.file) ?? key, localVersion: "" });
          if (projected.conflict) conflictFiles.push(projected.file);
        }
        continue;
      }
      const projected = projectEntry(item, key, files.length);
      const usePath = key.endsWith(".groovy") ? key : projected.file;
      files.push({ ...projected, file: usePath, localVersion: "" });
      if (projected.conflict) conflictFiles.push(projected.file);
    }
    const ordered = requestedPaths.map((path, index) => {
      const existing = files.find(f => f.file === path) ?? files[index];
      if (existing !== undefined) return { ...existing, localVersion: "" };
      return { file: path, target: path, localVersion: "", serverVersion: "", conflict: false, warnings: [] };
    });
    return {
      ok: true,
      value: { files: ordered, conflictFiles: [...new Set(conflictFiles)], conflict: conflictFiles.length > 0 || topLevelConflict(result) },
    };
  }

  // Single-file summary object (mode=current).
  const file = pickString(result, ["file", "path"]) ?? requestedPaths[0];
  const target = pickString(result, ["requestpath", "request_path", "target", "name", "remote_name"]) ?? file;
  const version = pickString(result, ["remote_version", "remoteVersion", "server_version"]) ?? "";
  const compileChecks = entryCompileChecks(result);
  const conflict = entryConflict(result) || topLevelConflict(result);
  const files: PushFilePreview[] = [{
    file: boundedString(file) ?? requestedPaths[0],
    target: clip(target, FIELD_TEXT_MAX),
    localVersion: "",
    serverVersion: version,
    conflict,
    ...(compileChecks === undefined ? {} : { compileChecks }),
    warnings: boundedStringList(result.warnings, WARNINGS_MAX),
  }];
  return {
    ok: true,
    value: {
      files,
      conflictFiles: conflict ? files.map(f => f.file) : [],
      conflict,
    },
  };
}

/** Receipt digest for a completed/failed/conflict push (digest-only evidence). */
export function pushResultDigest(receipt: { readonly operationId: string; readonly status: string; readonly stdoutDigest: string; readonly stderrDigest: string; readonly conflictFiles: readonly string[]; readonly finishedAt: string }): string {
  return digest(JSON.stringify({
    operationId: receipt.operationId,
    status: receipt.status,
    stdoutDigest: receipt.stdoutDigest,
    stderrDigest: receipt.stderrDigest,
    conflictFiles: receipt.conflictFiles,
    finishedAt: receipt.finishedAt,
  }));
}

// ---- TASK-029: test + release parsing ----

function sha256Text(value: string): string {
  // reuse capture.digest for the canonical sha256 form
  return digest(value);
}

export interface TestEvidenceProjection {
  readonly elapsedMs: number;
  readonly httpStatus: number | null;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly traceId: string;
  readonly testUrl: string;
  readonly savedAt: string;
}

function toMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Math.max(0, Math.trunc(Number(value)));
  return 0;
}

function nestedRecord(parsed: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = parsed[key];
    if (isRecord(value)) return value;
  }
  return null;
}

/**
 * Allowlist projection of `imo icomposer test api|function … --json` stdout.
 * Raw request/response bodies are digested immediately (sha256) — payloads
 * never survive as text. Bounded identifiers only.
 */
export function parseTestOutput(text: string): { readonly ok: true; readonly value: TestEvidenceProjection } | { readonly ok: false; readonly error: "not-json" | "parse-error" } {
  if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return { ok: false, error: "parse-error" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "not-json" }; }
  if (!isRecord(parsed)) return { ok: false, error: "parse-error" };
  const result = isRecord(parsed.result) ? parsed.result : parsed;
  const inner = nestedRecord(result, ["test", "sample", "data"]) ?? result;
  const elapsedMs = toMillis(inner.elapsed_ms ?? inner.elapsedMs ?? result.elapsed_ms ?? result.elapsedMs);
  const rawStatus = inner.http_status ?? inner.httpStatus ?? inner.status_code ?? result.status_code ?? result.http_status;
  const httpStatus = typeof rawStatus === "number" && Number.isFinite(rawStatus) ? Math.trunc(rawStatus) : null;
  const requestRaw = JSON.stringify(inner.request ?? inner.payload ?? result.payload ?? result.request ?? null);
  const responseRaw = JSON.stringify(inner.response ?? inner.body ?? result.response ?? null);
  return {
    ok: true,
    value: {
      elapsedMs,
      httpStatus,
      requestDigest: requestRaw === "null" ? "" : sha256Text(requestRaw),
      responseDigest: responseRaw === "null" ? "" : sha256Text(responseRaw),
      traceId: boundedString(inner.trace_id ?? inner.traceId ?? result.trace_id ?? result.traceId) ?? "",
      testUrl: boundedString(inner.test_url ?? inner.testUrl ?? result.test_url) ?? "",
      savedAt: boundedString(inner.saved_at ?? inner.savedAt ?? result.saved_at) ?? "",
    },
  };
}

export interface ReleaseRepoProjection {
  readonly repos: readonly string[];
  readonly truncated: boolean;
}

export interface ReleaseBranchProjection {
  readonly branches: readonly string[];
  readonly truncated: boolean;
}

function stringListFrom(value: unknown, max: number): { items: string[]; truncated: boolean } {
  // object map form (observed: `{"repos": {"name": "url", ...}}`) — project the url values
  if (isRecord(value) && !Array.isArray(value)) {
    const items: string[] = [];
    for (const entryValue of Object.values(value)) {
      if (items.length >= max) break;
      if (typeof entryValue === "string") {
        const v = boundedString(entryValue);
        if (v !== undefined) items.push(v);
      } else if (isRecord(entryValue)) {
        const v = pickString(entryValue, ["repository_url", "repo_url", "url"]);
        if (v !== undefined) items.push(v);
      }
    }
    return { items, truncated: Object.keys(value).length > max };
  }
  const raw = Array.isArray(value) ? value : [];
  const items: string[] = [];
  for (const entry of raw.slice(0, max)) {
    if (typeof entry === "string") { const v = boundedString(entry); if (v !== undefined) items.push(v); continue; }
    if (isRecord(entry)) {
      const v = pickString(entry, ["repository_url", "repo_url", "url", "name", "repo"]);
      if (v !== undefined) items.push(v);
      else {
        const b = pickString(entry, ["branch", "branch_name", "name"]);
        if (b !== undefined) items.push(b);
      }
    }
  }
  return { items, truncated: raw.length > max };
}

export function parseReleaseRepos(text: string): { readonly ok: true; readonly value: ReleaseRepoProjection } | { readonly ok: false; readonly error: "not-json" | "parse-error" } {
  if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return { ok: false, error: "parse-error" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "not-json" }; }
  if (!isRecord(parsed)) return { ok: false, error: "parse-error" };
  const result = isRecord(parsed.result) ? parsed.result : parsed;
  const raw = result.repos ?? result.repositories ?? result.items ?? result.data ?? result;
  const { items, truncated } = stringListFrom(raw, RESULTS_MAX);
  return { ok: true, value: { repos: items, truncated } };
}

export function parseReleaseBranches(text: string): { readonly ok: true; readonly value: ReleaseBranchProjection } | { readonly ok: false; readonly error: "not-json" | "parse-error" } {
  if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return { ok: false, error: "parse-error" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "not-json" }; }
  if (!isRecord(parsed)) return { ok: false, error: "parse-error" };
  const result = isRecord(parsed.result) ? parsed.result : parsed;
  const raw = result.branches ?? result.items ?? result.data ?? result;
  const { items, truncated } = stringListFrom(raw, RESULTS_MAX);
  return { ok: true, value: { branches: items, truncated } };
}

export interface ReleaseApplyProjection {
  readonly valid: boolean;
  readonly warnings: readonly string[];
}

export function parseReleaseApply(text: string, exitCode: number): { readonly ok: true; readonly value: ReleaseApplyProjection } | { readonly ok: false; readonly error: "not-json" | "parse-error" } {
  if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return { ok: false, error: "parse-error" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "not-json" }; }
  if (!isRecord(parsed)) return { ok: false, error: "parse-error" };
  const result = isRecord(parsed.result) ? parsed.result : parsed;
  const warnings = [
    ...boundedStringList(result.warnings, WARNINGS_MAX),
    ...boundedStringList(result.metadata_warnings, WARNINGS_MAX),
  ].slice(0, WARNINGS_MAX);
  const invalid = result.valid === false || result.error !== undefined;
  return { ok: true, value: { valid: exitCode === 0 && !invalid, warnings } };
}
