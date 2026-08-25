import type { VerifyErrorCode, Result } from "./types.ts";

/** Auth profiles come from the Workbench Active Profile and must never inject argv. */
export function isValidAuthProfile(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function isValidEnvironmentId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/**
 * Workspace-relative Groovy path: no leading slash, no `..` segments, groovy
 * suffix only, safe charset — the value becomes an argv token.
 */
export function isValidWorkspaceGroovyPath(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value.length < 1 || value.length > 256) return false;
  if (!value.endsWith(".groovy")) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (value.split("/").some(seg => seg === "" || seg === "." || seg === "..")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

/** Search keywords are narrow: letters/digits/space plus a few separators. */
export function isValidKeyword(value: string): boolean {
  return /^[A-Za-z0-9._ -]{1,128}$/.test(value);
}

export type VerifyMode = "file" | "list" | "search";

export function buildVerifyArgs(mode: VerifyMode, authProfile: string, payload: { file?: string; keyword?: string }): readonly string[] {
  const args = ["icomposer", "verify", "utils", "--json", "--profile", authProfile];
  if (mode === "list") args.push("--list");
  if (mode === "search") args.push("--search", payload.keyword ?? "");
  if (mode === "file") args.push(payload.file ?? "");
  return args;
}

export function invalid(code: VerifyErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}
