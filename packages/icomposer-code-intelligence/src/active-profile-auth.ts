import type { Context } from "@deepseek-ai/cordis";
import type { IciErrorCode, Result } from "./types.ts";

export interface ActiveProfileAuth {
  readonly profileName: string;
}

function error(code: IciErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/** Resolve only the Workbench-owned active profile for auth-dependent ICI work. */
export async function resolveActiveProfileAuth(ctx: Context, signal?: AbortSignal): Promise<Result<ActiveProfileAuth>> {
  if (signal?.aborted) return error("cancelled", "operation was cancelled");
  const active = ctx.get("imoActiveProfile" as never) as unknown as {
    get(signal?: AbortSignal): Promise<{
      ok: boolean;
      value?: {
        status: string;
        activeProfileName: string | null;
        profile?: { profileName: string };
      };
    }>;
  } | undefined;
  if (active === undefined || active === null) return error("invalid-auth", "active profile is unavailable");
  let result: Awaited<ReturnType<NonNullable<typeof active>["get"]>>;
  try {
    result = await active.get(signal);
  } catch {
    return error("invalid-auth", "active profile is unavailable");
  }
  if (!result.ok || result.value?.status !== "active" || result.value.profile === undefined) {
    return error("invalid-auth", "active profile is unavailable");
  }
  const profileName = result.value.activeProfileName ?? result.value.profile.profileName;
  if (typeof profileName !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(profileName)) {
    return error("invalid-auth", "active profile is unavailable");
  }
  return { ok: true, value: { profileName } };
}
