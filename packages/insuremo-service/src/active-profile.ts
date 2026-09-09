import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { defineDomain, domainTable, type Domain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import type { ImoAuth, ImoAuthProfileView } from "./auth/types.ts";
import { digest } from "./run.ts";
import { resolveWorkspace } from "./auth/workspace.ts";

/** Legacy ungrouped key; existing records are deliberately never migrated. */
const ACTIVE_KEY = "global" as const;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;

export const activeProfileRecordSchema = z.object({
  profileName: z.string().min(1).nullable(),
  revision: z.number().int().nonnegative().max(MAX_REVISION),
  updatedAt: z.string().datetime({ offset: true }),
  /** Hash only: a workspace path change must invalidate old selection state. */
  workspaceCwdDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
}).strict();
export type ActiveProfileRecord = z.infer<typeof activeProfileRecordSchema>;
export const activeProfileDomain = defineDomain({
  name: "workbench_active_profile",
  version: 1,
  tables: { states: domainTable<string, ActiveProfileRecord>(activeProfileRecordSchema) },
});

export type ActiveProfileStatus = "active" | "none" | "missing" | "unavailable";
export interface ActiveProfileView {
  readonly activeProfileName: string | null;
  readonly storedProfileName?: string;
  readonly profile?: ImoAuthProfileView;
  readonly revision: number;
  readonly status: ActiveProfileStatus;
  readonly code?: "missing" | "unavailable" | "storage-error";
}
export type ActiveProfileResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: "invalid-profile" | "invalid-workspace-id" | "workspace-not-found" | "workspace-unavailable" | "unavailable" | "storage-error" | "revision-exhausted" | "cancelled"; readonly message: string } };
export interface ImoActiveProfile {
  /** Omitted workspaceId retains the legacy ungrouped/global selection key. */
  get(signal?: AbortSignal, workspaceId?: string | null): Promise<ActiveProfileResult<ActiveProfileView>>;
  select(profileName: string, signal?: AbortSignal, workspaceId?: string | null): Promise<ActiveProfileResult<ActiveProfileView>>;
}
export const ACTIVE_PROFILE_CHANGED_EVENT = "active-profile/changed" as const;

function cancelled<T>(): ActiveProfileResult<T> {
  return { ok: false, error: { code: "cancelled", message: "active profile operation was cancelled" } };
}
function error<T>(code: "unavailable" | "storage-error" | "invalid-workspace-id" | "workspace-not-found" | "workspace-unavailable", message: string = code): ActiveProfileResult<T> {
  return { ok: false, error: { code, message } };
}

function selectionKey(workspaceId?: string | null): string {
  return workspaceId === undefined || workspaceId === null ? ACTIVE_KEY : `workspace:${workspaceId}`;
}

/** Persistent Workbench-owned profile selection. It never writes an IMO CLI pointer. */
export class ImoActiveProfileService extends Service implements ImoActiveProfile {
  static inject = ["storageDomain", "imoAuth"] as const;
  #table: ReturnType<Domain<typeof activeProfileDomain>["table"]> | undefined;
  #domain: Domain<typeof activeProfileDomain> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;
  readonly #auth: ImoAuth;

  constructor(ctx: Context) {
    super(ctx, "imoActiveProfile");
    this.#auth = ctx.get<ImoAuth>("imoAuth")!;
    const face = Object.freeze({
      get: (signal?: AbortSignal, workspaceId?: string | null) => this.get(signal, workspaceId),
      select: (name: string, signal?: AbortSignal, workspaceId?: string | null) => this.select(name, signal, workspaceId),
    } satisfies ImoActiveProfile);
    ctx.set("imoActiveProfile", face);
    this.get = this.get.bind(this);
    this.select = this.select.bind(this);
  }

  protected async [Service.init](): Promise<void> {
    try {
      const domain = await this.ctx.storageDomain.open(activeProfileDomain);
      this.#domain = domain;
      this.#table = domain.table("states") as ReturnType<Domain<typeof activeProfileDomain>["table"]>;
    } catch {
      throw new Error("active profile storage operation failed");
    }
    this.ctx.effect(() => async () => {
      this.#disposed = true;
      try { await this.#domain?.close(); } catch { /* close is best effort */ }
      this.#domain = undefined;
      this.#table = undefined;
    }, "imoActiveProfile.dispose");
  }

  async get(signal?: AbortSignal, workspaceId?: string | null): Promise<ActiveProfileResult<ActiveProfileView>> {
    if (signal?.aborted) return cancelled();
    if (this.#disposed || this.#table === undefined) return error("storage-error");
    const scope = this.resolveWorkspace(workspaceId);
    if (!scope.ok) return scope;
    return this.enqueue(async () => {
      if (signal?.aborted) return cancelled();
      // Re-resolve at execution time: a deleted/changed workspace must not
      // turn an old UI snapshot into a global identity.
      const currentScope = this.resolveWorkspace(workspaceId);
      if (!currentScope.ok) return currentScope;
      const key = selectionKey(workspaceId);
      let record: ActiveProfileRecord | undefined;
      try { record = this.#table!.get(key) as ActiveProfileRecord | undefined; } catch { return error("storage-error"); }
      if (record === undefined) return workspaceId === undefined || workspaceId === null
        ? this.bootstrap(signal, workspaceId)
        : this.bootstrapWorkspace(key, currentScope.value.cwd!, signal, workspaceId);
      if (workspaceId !== undefined && workspaceId !== null
        && record.workspaceCwdDigest !== digest(currentScope.value.cwd!)) {
        return error("workspace-unavailable", "workspace identity changed; select a profile again");
      }
      return this.resolveRecord(record, signal, workspaceId);
    });
  }

  async select(profileName: string, signal?: AbortSignal, workspaceId?: string | null): Promise<ActiveProfileResult<ActiveProfileView>> {
    if (signal?.aborted) return cancelled();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(profileName)) {
      return { ok: false, error: { code: "invalid-profile", message: "profile is invalid" } };
    }
    if (this.#disposed || this.#table === undefined) return error("storage-error");
    const scope = this.resolveWorkspace(workspaceId);
    if (!scope.ok) return scope;
    return this.enqueue(async () => {
      if (signal?.aborted) return cancelled();
      // Validate both identity and catalog against the same current target.
      const currentScope = this.resolveWorkspace(workspaceId);
      if (!currentScope.ok) return currentScope;
      const listed = await this.#auth.listProfiles(signal, workspaceId);
      if (this.#disposed || this.#table === undefined) return error("storage-error");
      if (!listed.ok) {
        if (listed.error.code === "workspace-not-found") return error("workspace-not-found", "workspace does not exist");
        if (listed.error.code === "workspace-unavailable" || listed.error.code === "invalid-workspace-id") return error("workspace-unavailable", "workspace is unavailable");
        if (listed.error.code === "cancelled") return cancelled();
        return error("unavailable");
      }
      const profile = listed.value.profiles.find(item => item.profileName === profileName);
      if (profile === undefined) return { ok: false, error: { code: "invalid-profile", message: "profile is not available" } };
      const key = selectionKey(workspaceId);
      let previous: ActiveProfileRecord | undefined;
      try { previous = this.#table!.get(key) as ActiveProfileRecord | undefined; } catch { return error("storage-error"); }
      if (previous !== undefined && previous.revision >= MAX_REVISION) {
        return { ok: false, error: { code: "revision-exhausted", message: "active profile revision exhausted" } };
      }
      const record: ActiveProfileRecord = {
        profileName,
        revision: previous === undefined ? 1 : previous.revision + 1,
        updatedAt: new Date().toISOString(),
        ...(workspaceId === undefined || workspaceId === null ? {} : { workspaceCwdDigest: digest(currentScope.value.cwd!) }),
      };
      try { await this.#table!.put(key, record); } catch { return error("storage-error"); }
      this.ctx.emit(ACTIVE_PROFILE_CHANGED_EVENT, {
        profileName,
        revision: record.revision,
        ...(workspaceId === undefined || workspaceId === null ? {} : { workspaceId }),
      });
      return { ok: true, value: this.view(record, profile) };
    });
  }

  private resolveWorkspace(workspaceId?: string | null): ActiveProfileResult<{ readonly cwd?: string }> {
    if (workspaceId === undefined || workspaceId === null) return { ok: true, value: {} };
    const resolved = resolveWorkspace(this.ctx, workspaceId);
    if (resolved.ok) return { ok: true, value: { cwd: resolved.cwd } };
    if (resolved.code === "invalid-workspace-id") return error("invalid-workspace-id", "workspace id is invalid");
    if (resolved.code === "workspace-not-found") return error("workspace-not-found", "workspace does not exist");
    return error("workspace-unavailable", "workspace is unavailable");
  }

  private async bootstrap(signal?: AbortSignal, workspaceId?: string | null): Promise<ActiveProfileResult<ActiveProfileView>> {
    const fast = await this.#auth.profilesFast(signal, workspaceId);
    if (this.#disposed || this.#table === undefined) return error("storage-error");
    if (!fast.ok) {
      if (fast.error.code === "cancelled") return cancelled();
      return error("unavailable");
    }
    const selected = fast.value.defaultProfile;
    const profile = selected === null ? undefined : fast.value.profiles.find(item => item.profileName === selected);
    const key = selectionKey(workspaceId);
    const record: ActiveProfileRecord = { profileName: profile?.profileName ?? null, revision: 1, updatedAt: new Date().toISOString() };
    try { await this.#table!.put(key, record); } catch { return error("storage-error"); }
    this.ctx.emit(ACTIVE_PROFILE_CHANGED_EVENT, {
      profileName: record.profileName,
      revision: record.revision,
      ...(workspaceId === undefined || workspaceId === null ? {} : { workspaceId }),
    });
    return { ok: true, value: this.view(record, profile) };
  }

  /** A new workspace follows the CLI context's default policy, never the
   * legacy global Workbench record. This keeps first-open behavior compatible
   * while still persisting a workspace-isolated selection key. */
  private async bootstrapWorkspace(key: string, cwd: string, signal?: AbortSignal, workspaceId?: string | null): Promise<ActiveProfileResult<ActiveProfileView>> {
    const fast = await this.#auth.profilesFast(signal, workspaceId);
    if (this.#disposed || this.#table === undefined) return error("storage-error");
    if (!fast.ok) {
      if (fast.error.code === "cancelled") return cancelled();
      return error("unavailable");
    }
    const selected = fast.value.defaultProfile;
    const profile = selected === null ? undefined : fast.value.profiles.find(item => item.profileName === selected);
    const record: ActiveProfileRecord = {
      profileName: profile?.profileName ?? null,
      revision: 1,
      updatedAt: new Date().toISOString(),
      workspaceCwdDigest: digest(cwd),
    };
    try { await this.#table!.put(key, record); } catch { return error("storage-error"); }
    this.ctx.emit(ACTIVE_PROFILE_CHANGED_EVENT, {
      profileName: record.profileName,
      revision: record.revision,
      ...(workspaceId === undefined || workspaceId === null ? {} : { workspaceId }),
    });
    return { ok: true, value: this.view(record, profile) };
  }

  private async resolveRecord(record: ActiveProfileRecord, signal?: AbortSignal, workspaceId?: string | null): Promise<ActiveProfileResult<ActiveProfileView>> {
    if (record.profileName === null) return { ok: true, value: this.view(record) };
    // Once state exists, refresh only through the sanitized inventory for the
    // same workspace cwd; a missing selected name remains explicit.
    const listed = await this.#auth.listProfilesCached(signal, workspaceId);
    if (this.#disposed || this.#table === undefined) return error("storage-error");
    if (!listed.ok) {
      if (listed.error.code === "cancelled") return cancelled();
      if (listed.error.code === "workspace-not-found") return error("workspace-not-found", "workspace does not exist");
      if (listed.error.code === "workspace-unavailable" || listed.error.code === "invalid-workspace-id") return error("workspace-unavailable", "workspace is unavailable");
      return { ok: true, value: { ...this.view(record), activeProfileName: null, storedProfileName: record.profileName, status: "unavailable", code: "unavailable" } };
    }
    const profile = listed.value.profiles.find(item => item.profileName === record.profileName);
    if (profile === undefined) return { ok: true, value: { ...this.view(record), activeProfileName: null, storedProfileName: record.profileName, status: "missing", code: "missing" } };
    return { ok: true, value: this.view(record, profile) };
  }

  private view(record: ActiveProfileRecord, profile?: ImoAuthProfileView): ActiveProfileView {
    if (record.profileName === null) return { activeProfileName: null, revision: record.revision, status: "none" };
    if (profile === undefined) return { activeProfileName: null, storedProfileName: record.profileName, revision: record.revision, status: "missing", code: "missing" };
    return { activeProfileName: profile.profileName, profile, revision: record.revision, status: "active" };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }
}
