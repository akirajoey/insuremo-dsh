import type { Context } from "@deepseek-ai/cordis";
import { AUTH_ACTION_COMPLETED_EVENT } from "./auth/action-types.ts";
import { AUTH_CACHE_INVALIDATED_EVENT } from "./auth/types.ts";

/** In-memory mirror of the current default auth profile for the dynamic
 * runtime-context. Never runs the CLI on the prompt-assembly path. */
const TTL_MS = 60_000;

interface ImoAuthLike {
  /** Sanitized fast snapshot: fills the process's list+default caches in one
   * round, so a subsequent UI profilesFast() is a zero-spawn cache hit. */
  profilesFast(signal?: AbortSignal): Promise<{ ok: boolean; value?: { profiles: ReadonlyArray<{ profileName: string; env?: string; accountName?: string }>; defaultProfile: string | null; stale: boolean } }>;
}

export interface CurrentProfileState {
  /** profileName + env when known; null when explicitly none / unknown. */
  profile: { name: string; env?: string } | null;
}

interface AuthActionCompletedPayloadLike {
  kind?: string;
}

/**
 * Dynamic runtime context: `InsureMO active profile: <name> (env <env>).`
 * — re-evaluated at every prompt assembly from a 60s-TTL in-memory mirror.
 *
 * TASK-043 FIX-2:
 * - REAL async mount: the sanitized CLI prewarm is `await`ed BEFORE the
 *   context registers, so the very first assembly already carries the profile.
 * - A missing `systemPrompt` service THROWS (never a warned no-op) — the
 *   static inject guarantees an active fiber, and a false "active" state is
 *   forbidden.
 * - Direct switch (`runDirectDefaultSwitch`) emits AUTH_CACHE_INVALIDATED with
 *   `payload.profile` → name applied synchronously. The approval-path event is
 *   handled too: a default-switch payload syncs the name, anything else drops
 *   the mirror AND kicks a background refresh so the next render is populated.
 */
export async function mountCurrentProfileSection(ctx: Context): Promise<() => void> {
  let cached: { at: number; state: CurrentProfileState } | undefined;
  let inflight: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (inflight !== undefined) return inflight;
    inflight = (async () => {
      const auth = ctx.get("imoAuth" as never) as unknown as ImoAuthLike | undefined;
      if (auth === undefined) {
        cached = { at: Date.now(), state: { profile: null } };
        return;
      }
      try {
        // TASK-043 FIX-3: use profilesFast so the prewarm fills the same
        // sanitized cache the UI reads from — no duplicated spawn.
        const fast = await auth.profilesFast();
        const name = fast.ok === true && typeof fast.value?.defaultProfile === "string" && fast.value.defaultProfile.length > 0 ? fast.value.defaultProfile : null;
        const found = name !== null ? fast.value?.profiles.find(p => p.profileName === name) : undefined;
        const env = found?.env;
        cached = { at: Date.now(), state: { profile: name === null ? null : { name, ...(env === undefined ? {} : { env }) } } };
      } catch {
        cached = { at: Date.now(), state: { profile: null } };
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  // Direct default-profile switch: AUTH_CACHE_INVALIDATED carries the new
  // `profile` — apply it synchronously (background-refresh env afterwards) so
  // the next assembly sees the switched name without an await.
  const offInvalidated = ctx.on(AUTH_CACHE_INVALIDATED_EVENT as never, ((payload: unknown) => {
    const profile = (payload as { profile?: unknown } | null)?.profile;
    if (typeof profile === "string" && profile.length > 0) {
      cached = { at: Date.now(), state: { profile: { name: profile } } };
      void refresh();
    }
  }) as never) as unknown as (() => void) | undefined;

  // Approval-path: a default-switch completion syncs the name synchronously;
  // any other completion drops the mirror and kicks a background refresh so
  // the next render is populated rather than "none".
  const offCompleted = ctx.on(AUTH_ACTION_COMPLETED_EVENT as never, ((payload: unknown) => {
    const kind = (payload as AuthActionCompletedPayloadLike | null)?.kind;
    if (kind !== undefined && kind.includes("default")) {
      const data = payload as { profile?: unknown };
      if (typeof data.profile === "string" && data.profile.length > 0) {
        cached = { at: Date.now(), state: { profile: { name: data.profile } } };
        void refresh();
        return;
      }
    }
    cached = undefined;
    void refresh();
  }) as never) as unknown as (() => void) | undefined;

  const MARKER = "InsureMO active profile";
  const render = (): string => {
    if (cached === undefined || Date.now() - cached.at > TTL_MS) void refresh();
    const profile = cached?.state.profile;
    if (profile === undefined || profile === null) {
      return `${MARKER}: none. Run \`imo auth login\` and set a default profile before remote operations.`;
    }
    return `${MARKER}: ${profile.name}${profile.env === undefined ? "" : ` (env ${profile.env})`}. Workbench remote operations use this profile.`;
  };

  /**
   * TASK-043: explicit `ctx.get("systemPrompt")`. Missing service THROWS — the
   * static inject guarantees an active fiber, so a miss here is a composition
   * fault that must fail the service, never a silent false "active".
   */
  const systemPrompt = (ctx as unknown as { get(name: string): unknown }).get("systemPrompt") as {
    context(contribution: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void;
  } | undefined;
  if (systemPrompt === undefined || typeof systemPrompt.context !== "function") {
    detachListeners();
    throw new Error("insuremo current-profile runtime-context: systemPrompt service is unavailable");
  }

  // TASK-043 FIX-2: real await — the prewarm must complete before register so
  // the first assembly is warm.
  await refresh().catch(() => undefined);

  const unregisterContext = systemPrompt.context({
    name: "insuremo:current-profile-context",
    order: 160,
    text: render,
  });

  function detachListeners(): void {
    try { offInvalidated?.(); } catch { /* already detached */ }
    try { offCompleted?.(); } catch { /* already detached */ }
  }

  function detach(): void {
    detachListeners();
    try { unregisterContext(); } catch { /* already detached */ }
  }

  return detach;
}
