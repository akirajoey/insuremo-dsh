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
