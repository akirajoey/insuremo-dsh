import type { PushErrorCode, PushMode, PushChoice, Result } from "./types.ts";

/** Auth profiles come from a workspace binding and must never inject argv. */
export function isValidAuthProfile(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function isValidEnvironmentId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/** Workspace-relative Groovy path, same contract as icomposer-verify. */
export function isValidWorkspaceGroovyPath(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value.length < 1 || value.length > 256) return false;
  if (!value.endsWith(".groovy")) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (value.split("/").some(seg => seg === "" || seg === "." || seg === "..")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

export function isValidChoice(value: unknown): value is PushChoice {
  return value === "prefer-local" || value === "prefer-server" || value === "cancel";
}

export const MAX_FILES = 200;

export function isValidFiles(files: readonly unknown[] | undefined): files is readonly string[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) return false;
  return files.every((file, index) => {
    if (typeof file !== "string") return false;
    if (!isValidWorkspaceGroovyPath(file)) return false;
    // reject duplicates — order matters for batch, duplicates are meaningless
    return files.indexOf(file) === index;
  });
}

export interface PushFlags {
  readonly checkUsages?: boolean;
  readonly skipCompile?: boolean;
  readonly prefer?: "prefer-local" | "prefer-server";
}

/**
 * Exact argv for `imo icomposer push …`. Never passes `--insecure`; profile
 * and env-affecting values are validated before becoming argv tokens. The
 * prefer flags are only present when a conflict is being explicitly resolved
 * (approved resolve operation) — never auto-injected.
 */
export function buildPushArgs(
  mode: PushMode,
  authProfile: string,
  files: readonly string[],
  flags: PushFlags & { readonly dryRun?: boolean },
): readonly string[] {
  const args = ["icomposer", "push"];
  if (mode === "batch") {
    args.push("batch", ...files);
  } else {
    args.push("current");
  }
  args.push("--json", "--profile", authProfile);
  if (flags.dryRun === true) args.push("--dry-run");
  if (flags.checkUsages === true) args.push("--check-usages");
  if (flags.skipCompile === true) args.push("--skip-compile");
  if (flags.prefer === "prefer-local") args.push("--prefer-local");
  if (flags.prefer === "prefer-server") args.push("--prefer-server");
  if (mode === "current") args.push(files[0]);
  return args;
}

import { createHash } from "node:crypto";

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Canonical request digest: hash of stable JSON of files (in order) + flags. */
export function pushParamsDigest(input: {
  readonly mode: PushMode;
  readonly files: readonly string[];
  readonly checkUsages?: boolean;
  readonly skipCompile?: boolean;
}): string {
  const canonical = JSON.stringify({
    mode: input.mode,
    files: input.files,
    checkUsages: input.checkUsages === true,
    skipCompile: input.skipCompile === true,
  });
  return sha256(canonical);
}

export function resolveParamsDigest(input: {
  readonly choice: PushChoice;
  readonly originalOperationId: string;
}): string {
  return sha256(JSON.stringify({ choice: input.choice, originalOperationId: input.originalOperationId }));
}

export function err(code: PushErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}

// ---- TASK-029: test + release ----

/** Asset names are argv tokens: bounded, no whitespace/control chars. */
export function isValidAssetName(value: string | undefined): boolean {
  if (value === undefined || value.length < 1 || value.length > 200) return false;
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value);
}

/** Function method name. */
export function isValidMethod(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
}

const DATA_LIMIT_BYTES = 64 * 1024;

/** `--data` accepts an inline JSON object/array or a workspace-relative .json path. */
export function isValidDataPayload(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value.length === 0 || Buffer.byteLength(value) > DATA_LIMIT_BYTES) return false;
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { JSON.parse(trimmed); return true; } catch { return false; }
  }
  // workspace-relative path form
  if (trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("..")) return false;
  if (!trimmed.endsWith(".json")) return false;
  return trimmed.split("/").every(seg => /^[A-Za-z0-9._-]+$/.test(seg) && seg.length > 0);
}

/** Git repo URL (https/ssh forms) — bounded, no control chars. */
export function isValidRepoUrl(value: string | undefined): boolean {
  if (value === undefined || value.length < 1 || value.length > 512) return false;
  return /^[A-Za-z0-9:@/._~#?=&+-]+$/.test(value);
}

export function isValidBranchName(value: string | undefined): boolean {
  if (value === undefined || value.length < 1 || value.length > 128) return false;
  if (value.split("/").some(seg => seg === "" || seg === "." || seg === "..")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

export const MESSAGE_MAX_CHARS = 500;

export function isValidReleaseMessage(value: string | undefined): boolean {
  if (value === undefined || value.length < 1 || value.length > MESSAGE_MAX_CHARS) return false;
  // strip control characters except tab/newline
  return !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value);
}

/** argv for `imo icomposer test api|function <NAME>` (never `--insecure`). */
export function buildTestArgs(authProfile: string, input: { kind: "api" | "function"; name: string; data?: string; method?: string }): readonly string[] {
  const args = ["icomposer", "test", input.kind, "--json", "--profile", authProfile];
  if (input.method !== undefined) args.push("--method", input.method);
  if (input.data !== undefined) args.push("--data", input.data);
  args.push(input.name);
  return args;
}

/** argv for `imo icomposer release apply` (full repo/branch/message). */
export function buildReleaseArgs(authProfile: string, input: { type: "api" | "function"; name: string; repo: string; branch: string; message: string; dryRun?: boolean }): readonly string[] {
  const args = ["icomposer", "release", "apply", "--json", "--profile", authProfile, "--type", input.type, "--name", input.name, "--repo", input.repo, "--branch", input.branch, "-m", input.message];
  if (input.dryRun === true) args.push("--dry-run");
  return args;
}

export function buildReleaseListArgs(authProfile: string, kind: "repo" | "branch", repo?: string): readonly string[] {
  const args = ["icomposer", "release", kind, "list", "--json", "--profile", authProfile];
  if (kind === "branch" && repo !== undefined) args.push("--repo", repo);
  return args;
}

export function testParamsDigest(input: { kind: "api" | "function"; name: string; data?: string; method?: string; overrideUnpushed?: boolean }): string {
  return sha256(JSON.stringify({
    kind: input.kind,
    name: input.name,
    data: input.data ?? null,
    method: input.method ?? null,
    overrideUnpushed: input.overrideUnpushed === true,
  }));
}

export function releaseParamsDigest(input: { type: "api" | "function"; name: string; repo: string; branch: string; message: string }): string {
  return sha256(JSON.stringify({
    type: input.type,
    name: input.name,
    repo: input.repo,
    branch: input.branch,
    message: input.message,
  }));
}

// ---- TASK-030: create + metadata ----

/** Live-enum aliases (status/method/type/scope) — bounded token vocabulary. */
export function isValidAliasToken(value: string | undefined): boolean {
  if (value === undefined || value.length < 1 || value.length > 64) return false;
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value);
}

/** Module/group/model ids are numeric identifiers. */
export function isValidNumericId(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^[0-9]{1,19}$/.test(value);
}

export function isValidApiPath(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value.length < 1 || value.length > 256) return false;
  return value.startsWith("/") && !value.includes("..") && /^[A-Za-z0-9/_{}.-]+$/.test(value);
}

const DESCRIPTION_MAX_CHARS = 500;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function isValidDescription(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value.length === 0 || value.length > DESCRIPTION_MAX_CHARS) return false;
  return !CONTROL_CHARS.test(value);
}

export type CreateParamsShape =
  | { readonly kind: "api"; readonly params: import("./types.ts").CreateApiParams }
  | { readonly kind: "function"; readonly params: import("./types.ts").CreateFunctionParams };

export function validateCreateParams(shape: CreateParamsShape): boolean {
  const { params } = shape;
  if (!isValidAssetName(params.name)) return false;
  if (!isValidNumericId(params.moduleId) || !isValidNumericId(params.groupId)) return false;
  if (!isValidAliasToken(params.status)) return false;
  if (!isValidDescription(params.description)) return false;
  if (shape.kind === "api") {
    const api = shape.params;
    if (!isValidAliasToken(api.requestMethod) || !isValidAliasToken(api.requestType) || !isValidAliasToken(api.responseType)) return false;
    if (!isValidApiPath(api.path)) return false;
    if (api.requestModelId !== undefined && !isValidNumericId(api.requestModelId)) return false;
    if (api.responseModelId !== undefined && !isValidNumericId(api.responseModelId)) return false;
    if (api.integration !== undefined && (api.integration.length < 1 || api.integration.length > 200)) return false;
    return true;
  }
  return isValidAliasToken(shape.params.funcScope);
}

/** argv for `imo icomposer create api|function` (never `--insecure`). */
export function buildCreateArgs(authProfile: string, shape: CreateParamsShape, dryRun: boolean): readonly string[] {
  const args = ["icomposer", "create", shape.kind, "--json", "--profile", authProfile, "--name", shape.params.name, "--module-id", shape.params.moduleId, "--group-id", shape.params.groupId, "--status", shape.params.status];
  if (shape.kind === "api") {
    args.push("--request-method", shape.params.requestMethod, "--request-type", shape.params.requestType, "--response-type", shape.params.responseType);
    if (shape.params.path !== undefined) args.push("--path", shape.params.path);
    if (shape.params.description !== undefined) args.push("--description", shape.params.description);
    if (shape.params.requestModelId !== undefined) args.push("--request-model-id", shape.params.requestModelId);
    if (shape.params.responseModelId !== undefined) args.push("--response-model-id", shape.params.responseModelId);
    if (shape.params.sse === true) args.push("--sse");
    if (shape.params.integration !== undefined) args.push("--integration", shape.params.integration);
  } else {
    args.push("--func-scope", shape.params.funcScope);
    if (shape.params.description !== undefined) args.push("--description", shape.params.description);
  }
  if (dryRun) args.push("--dry-run");
  return args;
}

export function buildCreateOptionsArgs(authProfile: string, kind: "api" | "function"): readonly string[] {
  return ["icomposer", "create", "options", kind, "--json", "--profile", authProfile];
}

export function validateMetadataFields(fields: import("./types.ts").MetadataFields): boolean {
  const selected = metadataFieldsApplied(fields);
  if (selected.length < 1) return false;
  if (fields.status !== undefined && !isValidAliasToken(fields.status)) return false;
  if (fields.funcScope !== undefined && !isValidAliasToken(fields.funcScope)) return false;
  if (fields.description !== undefined && (fields.description.length > DESCRIPTION_MAX_CHARS || CONTROL_CHARS.test(fields.description))) return false;
  if (fields.integration !== undefined && (fields.integration.length < 1 || fields.integration.length > 200)) return false;
  return true;
}

export function metadataFieldsApplied(fields: import("./types.ts").MetadataFields): readonly string[] {
  return [
    ...(fields.status !== undefined ? ["status"] : []),
    ...(fields.description !== undefined ? ["description"] : []),
    ...(fields.sse !== undefined ? ["sse"] : []),
    ...(fields.integration !== undefined ? ["integration"] : []),
    ...(fields.funcScope !== undefined ? ["funcScope"] : []),
  ];
}

export function buildMetadataArgs(authProfile: string, file: string, fields: import("./types.ts").MetadataFields, dryRun: boolean): readonly string[] {
  const args = ["icomposer", "metadata", "--json", "--profile", authProfile];
  if (fields.status !== undefined) args.push("--status", fields.status);
  if (fields.description !== undefined) args.push("--description", fields.description);
  if (fields.sse !== undefined) args.push("--sse", fields.sse === true ? "true" : "false");
  if (fields.integration !== undefined) args.push("--integration", fields.integration);
  if (fields.funcScope !== undefined) args.push("--func-scope", fields.funcScope);
  if (dryRun) args.push("--dry-run");
  args.push(file);
  return args;
}

export function createParamsDigest(shape: CreateParamsShape): string {
  return sha256(JSON.stringify(shape.kind === "api"
    ? { kind: shape.kind, ...shape.params, sse: shape.params.sse === true }
    : { kind: shape.kind, ...shape.params }));
}

export function metadataParamsDigest(file: string, fields: import("./types.ts").MetadataFields): string {
  return sha256(JSON.stringify({ file, fields }));
}
