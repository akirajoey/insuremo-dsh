import type { Context } from "@deepseek-ai/cordis";
import { AUTH_ACTION_COMPLETED_EVENT } from "./auth/action-types.ts";

/** In-memory mirror of the current default auth profile for the dynamic
 * system-prompt section. Never runs the CLI on the prompt-assembly path. */
const TTL_MS = 60_000;

interface ImoAuthLike {
  defaultProfile(signal?: AbortSignal): Promise<{ ok: boolean; value?: { profileName: string | null; stdoutDigest: string } }>;
  listProfiles(signal?: AbortSignal): Promise<{ ok: boolean; value?: { profiles: ReadonlyArray<{ profileName: string; env?: string }> } }>;
}

export interface CurrentProfileState {
  /** profileName + env when known; null when explicitly none / unknown. */
  profile: { name: string; env?: string } | null;
}

/**
 * Dynamic system-prompt section: `InsureMO current auth profile: <name> (env <env>).`
 * — re-evaluated at every prompt assembly from a 60s-TTL in-memory mirror;
 * the mirror is invalidated immediately whenever an auth action completes
 * (default-profile switches land through that path), so UI/CLI switches take
 * effect on the very next assembly without running the CLI inline.
 */
export function mountCurrentProfileSection(ctx: Context): () => void {
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
        const def = await auth.defaultProfile();
        const name = def.ok === true && typeof def.value?.profileName === "string" && def.value.profileName.length > 0 ? def.value.profileName : null;
        let env: string | undefined;
        if (name !== null) {
          const list = await auth.listProfiles().catch(() => undefined);
          env = list?.ok === true ? list.value?.profiles.find(p => p.profileName === name)?.env : undefined;
        }
        cached = { at: Date.now(), state: { profile: name === null ? null : { name, ...(env === undefined ? {} : { env }) } } };
      } catch {
        cached = { at: Date.now(), state: { profile: null } };
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  // auth action completed (incl. default-profile switches) → drop the mirror
  const off = ctx.on(AUTH_ACTION_COMPLETED_EVENT as never, (() => { cached = undefined; }) as never) as unknown as (() => void) | undefined;

  const render = (): string => {
    if (cached === undefined || Date.now() - cached.at > TTL_MS) void refresh();
    const profile = cached?.state.profile;
    if (profile === undefined || profile === null) {
      return "InsureMO current auth profile: not-configured. Run `imo auth login` and set a default profile before remote operations.";
    }
    return `InsureMO current auth profile: ${profile.name}${profile.env === undefined ? "" : ` (env ${profile.env})`}. Workbench remote operations use this profile.`;
  };

  // TASK-042: the static section (assembled into every prompt) plus a dynamic
  // context contribution re-evaluated per assembly — a profile switch lands
  // in the very next message's assembled context without any per-session
  // history (the model observes the changed value naturally).
  const unregisterSection = ctx.systemPrompt.section({
    name: "insuremo:current-profile",
    order: 160,
    text: render,
  });
  const unregisterContext = ctx.systemPrompt.context({
    name: "insuremo:current-profile-context",
    order: 160,
    text: render,
  });

  return () => {
    try { off?.(); } catch { /* already detached */ }
    unregisterSection();
    unregisterContext();
  };
}
