import type { Context } from "@deepseek-ai/cordis";
import { isValidAuthProfile, isValidEnvironmentId } from "./cli.ts";
import type { PushErrorCode, Result } from "./types.ts";

const PASSTHROUGH = new Set<PushErrorCode>([
  "workspace-not-found",
  "invalid-workspace-id",
  "service-disposed",
  "cancelled",
]);

export type BindingEntry = { binding: { authProfile: string; environmentId: string } | null; canonicalPath: string };

export type Lease = { use<T>(cb: (s: { accessToken: string }) => Promise<T> | T): Promise<T> };
export type AuthLease = {
  prepare(request: { profile?: string; env?: string }, signal?: AbortSignal): Promise<{
    ok: boolean; value?: Lease; error?: { code?: string };
  }>;
};

/** Resolve the workspace binding through the injected service. */
export async function bindingEntry(ctx: Context, workspaceId: string, signal?: AbortSignal): Promise<Result<{ binding: BindingEntry["binding"]; canonicalPath: string }>> {
  const bindingSvc = ctx.get("workspaceBinding" as never) as unknown as {
    get(id: string, signal?: AbortSignal): Promise<{ ok: boolean; value?: BindingEntry; error?: { code?: unknown } }>;
  } | undefined;
  if (!bindingSvc) return { ok: false, error: { code: "cli-error", message: "cli-error" } };
  const res = await bindingSvc.get(workspaceId, signal);
  if (!res.ok) {
    const raw = (res.error as { code?: unknown } | undefined)?.code;
    const code = typeof raw === "string" ? (raw as PushErrorCode) : undefined;
    if (code === "workspace-not-found") return { ok: false, error: { code: "workspace-not-found", message: "workspace does not exist" } };
    if (code && PASSTHROUGH.has(code)) return { ok: false, error: { code, message: code } };
    return { ok: false, error: { code: "cli-error", message: "cli-error" } };
  }
  const value = res.value;
  if (!value) return { ok: false, error: { code: "workspace-not-found", message: "workspace does not exist" } };
  return { ok: true, value: { binding: value.binding, canonicalPath: value.canonicalPath } };
}

/** Resolve an imoAuth lease for a bound workspace (or a structured error). */
export async function resolveLease(ctx: Context, binding: { authProfile: string; environmentId: string }, signal?: AbortSignal): Promise<Result<Lease>> {
  if (!isValidAuthProfile(binding.authProfile) || !isValidEnvironmentId(binding.environmentId)) {
    return { ok: false, error: { code: "cli-error", message: "invalid binding profile" } };
  }
  const auth = ctx.get("imoAuth" as never) as unknown as AuthLease | undefined;
  if (!auth) return { ok: false, error: { code: "cli-error", message: "auth service is unavailable" } };
  const leaseResult = await auth.prepare({ profile: binding.authProfile, env: binding.environmentId }, signal);
  if (!leaseResult.ok) return { ok: false, error: { code: mapAuthError(leaseResult.error), message: mapAuthError(leaseResult.error) } };
  return { ok: true, value: leaseResult.value! };
}

export function mapAuthError(error: { code?: string } | undefined): PushErrorCode {
  if (!error || typeof error.code !== "string") return "cli-error";
  const code = error.code as PushErrorCode;
  if (code === "invalid-auth" || code === "forbidden" || code === "prepare-invalidated" || code === "lease-revoked") return code;
  if (code === "timeout" || code === "cancelled" || code === "service-disposed") return code;
  return "cli-error";
}

export function mapCliError(code: string): PushErrorCode {
  if (code === "timeout") return "timeout";
  if (code === "cancelled") return "cancelled";
  if (code === "not-found" || code === "spawn-failed") return "command-failed";
  return "cli-error";
}
