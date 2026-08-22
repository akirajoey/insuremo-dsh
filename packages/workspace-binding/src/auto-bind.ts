import type { Context } from "@deepseek-ai/cordis";
import { detectIcomposerProject, deriveBindIdentity } from "./detect.ts";

/** Durable event emitted after a successful auto-bind (UI/conversation cue). */
export const WORKSPACE_ICOMPOSER_AUTO_BOUND_EVENT = "workspace/icomposer-auto-bound" as const;

export type AutoBindState = "bound" | "pending" | "none";

interface BindingRecordLike {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly environmentId: string;
  readonly tenantCode: string;
  readonly authProfile: string;
  readonly writeMode: "read-only" | "read-write";
  readonly revision: number;
}

interface BindingFaceLike {
  list(signal?: AbortSignal): Promise<{ ok: boolean; value?: readonly { workspaceId: string; binding: unknown | null; canonicalPath: string }[] }>;
  get(id: string, signal?: AbortSignal): Promise<{ ok: boolean; value?: { canonicalPath: string; binding: unknown | null } }>;
  bind(input: { workspaceId: string; environmentId: string; tenantCode: string; authProfile: string; writeMode: "read-only" | "read-write"; expectedRevision: number }, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }>;
}

/** Minimal imoAuth shape the auto-bind consumes (both optional at runtime). */
interface ImoAuthLike {
  listProfiles(signal?: AbortSignal): Promise<{ ok: boolean; value?: { profiles: ReadonlyArray<{ profileName: string; envId?: string; tenantCode?: string; isDefault?: boolean }> } }>;
  defaultProfile(signal?: AbortSignal): Promise<{ ok: boolean; value?: { profileName: string | null } }>;
}

interface WorkspaceRegistryLike {
  list(): ReadonlyArray<{ id: string; path: string; title: string }>;
  get(id: string): { id: string; path: string; title: string } | undefined;
}

export interface AutoBindModule {
  /** Current state for one workspace (derived, never cached across writes). */
  stateOf(workspaceId: string): Promise<{ detected: boolean; state: AutoBindState }>;
  dispose(): void;
}

/**
 * Conservative two-stage auto-bind for newly added workspaces:
 *
 *  - listens to `domain/changed` puts on the workspace registry table;
 *  - detects iComposer projects by strong signatures only (`.metadata/{kind}/*.metadata.json`
 *    or `src/dev/**.groovy`); plain directories are never touched;
 *  - with a default profile carrying a complete identity triple
 *    (envId + tenantCode + profileName) it binds as read-only and emits
 *    `workspace/icomposer-auto-bound`;
 *  - any missing piece leaves the workspace `pending` (detected, unbound) so
 *    the ici tools guide the user through the explicit bind;
 *  - failures never throw or retry; already-bound/pending workspaces are
 *    skipped (idempotent).
 */
export function mountAutoBind(ctx: Context, deps: { binding: () => BindingFaceLike | undefined }): AutoBindModule {
  const handled = new Set<string>();
  const inflight = new Map<string, Promise<void>>();

  const listener = (change: { domain: string; table: string; operation: string; value?: unknown }): void => {
    if (change.domain !== "workspace" || change.table !== "workspaces" || change.operation !== "put") return;
    const record = change.value as { path?: unknown } | undefined;
    if (typeof record?.path !== "string" || record.path.length === 0) return;
    const registry = ctx.get("workspaceRegistry" as never) as unknown as WorkspaceRegistryLike | undefined;
    const entry = registry?.list().find(candidate => candidate.path === record.path);
    if (entry === undefined) return;
    const workspaceId = entry.id;
    if (handled.has(workspaceId)) return;
    handled.add(workspaceId);
    const canonicalPath = record.path;
    const run = (async () => {
      await maybeAutoBind(ctx, deps, workspaceId, canonicalPath);
    })().catch(() => undefined);
    inflight.set(workspaceId, run.finally(() => inflight.delete(workspaceId)));
  };

  const off = ctx.on("domain/changed" as never, listener as never) as unknown as (() => void) | undefined;
  return {
    async stateOf(workspaceId) {
      const binding = deps.binding();
      const got = await binding?.get(workspaceId);
      const detected = got?.ok === true && got.value !== undefined
        ? await detectIcomposerProject(got.value.canonicalPath).catch(() => false)
        : false;
      if (got?.ok !== true) return { detected: false, state: "none" as const };
      const bound = got.value?.binding != null;
      return { detected, state: bound ? "bound" as const : detected ? "pending" as const : "none" as const };
    },
    dispose() {
      try { off?.(); } catch { /* already detached */ }
    },
  };
}

async function maybeAutoBind(ctx: Context, deps: { binding: () => BindingFaceLike | undefined }, workspaceId: string, canonicalPath: string): Promise<void> {
  const binding = deps.binding();
  if (binding === undefined) return;
  const existing = await binding.get(workspaceId).catch(() => undefined);
  if (existing?.ok === true && existing.value?.binding != null) return; // already bound
  const detected = await detectIcomposerProject(canonicalPath).catch(() => false);
  if (!detected) return; // plain directory: zero interference
  // identity triple from the default profile
  const auth = ctx.get("imoAuth" as never) as unknown as ImoAuthLike | undefined;
  let profile: { profileName: string; envId?: string; tenantCode?: string } | null = null;
  if (auth !== undefined) {
    try {
      const def = await auth.defaultProfile();
      if (def.ok === true && typeof def.value?.profileName === "string" && def.value.profileName.length > 0) {
        const list = await auth.listProfiles();
        profile = list.ok === true
          ? list.value!.profiles.find(candidate => candidate.profileName === def.value!.profileName) ?? null
          : null;
      }
    } catch { /* auth unavailable → pending */ }
  }
  const identity = deriveBindIdentity(profile);
  if (identity === null) return; // pending: detection recorded via stateOf, ici tools guide
  const attempt = await binding.bind({
    workspaceId,
    environmentId: identity.environmentId,
    tenantCode: identity.tenantCode,
    authProfile: identity.authProfile,
    writeMode: "read-only",
    expectedRevision: 0,
  }).catch(() => undefined);
  if (attempt !== undefined && attempt.ok) {
    (ctx as unknown as { emit(name: string, payload: unknown): void }).emit(WORKSPACE_ICOMPOSER_AUTO_BOUND_EVENT, { workspaceId });
  }
  // bind failure (e.g. binding-conflict): stay pending, no retry, no throw
}

export type { BindingRecordLike };
