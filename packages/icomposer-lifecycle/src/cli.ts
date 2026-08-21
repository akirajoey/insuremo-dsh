import type { InitPreviewInput, LifecycleErrorCode, Result } from "./types.ts";

/** Auth profiles come from a workspace binding and must never inject argv. */
export function isValidAuthProfile(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/** Group ids are numeric in the real catalog; keep argv free of shell metachars. */
export function isValidGroupId(value: string | undefined): boolean {
  return value === undefined || /^[0-9]{1,12}$/.test(value);
}

export function isValidEnvironmentId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function buildInitArgs(input: InitPreviewInput, authProfile: string): readonly string[] {
  const args = ["icomposer", "init", "--dry-run", "--json", "--profile", authProfile];
  if (input.listGroups === true) args.push("--list-groups");
  if (input.groupId !== undefined) args.push("--group-id", input.groupId);
  return args;
}

export function invalid(code: LifecycleErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}
