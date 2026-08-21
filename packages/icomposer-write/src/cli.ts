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
