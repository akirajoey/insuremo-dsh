/** Same-origin write-bridge POST helper (sidebar copy — bundles are per-package). */
export interface ActionError { readonly code: string; readonly message: string; readonly detail?: string }
export type ActionOutcome<T> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: ActionError };
export const ACTIONS_PREFIX = "/api/icomposer-workbench/insuremo/overview/actions" as const;
export const OVERVIEW_URL = "/api/icomposer-workbench/insuremo/overview" as const;

export async function postAction<T>(action: string, body: unknown, signal?: AbortSignal): Promise<ActionOutcome<T>> {
  try {
    const response = await fetch(`${ACTIONS_PREFIX}/${action}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Workbench-Action": "1", Accept: "application/json" },
      body: JSON.stringify(body ?? {}),
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: ActionError } | null;
      if (payload?.error !== undefined && typeof payload.error.code === "string") return { ok: false, error: payload.error };
      return { ok: false, error: { code: "http-error", message: `HTTP ${response.status}` } };
    }
    const payload = await response.json() as { ok?: boolean; result?: T; error?: ActionError } | null;
    if (payload?.ok === true && payload.result !== undefined) return { ok: true, result: payload.result };
    if (payload?.ok === false && payload.error !== undefined) return { ok: false, error: payload.error };
    return { ok: false, error: { code: "parse-error", message: "unexpected response" } };
  } catch {
    return { ok: false, error: { code: "network", message: "network-unavailable" } };
  }
}
