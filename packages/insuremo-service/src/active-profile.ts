import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { defineDomain, domainTable, type Domain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import type { ImoAuth, ImoAuthProfileView } from "./auth/types.ts";

const ACTIVE_KEY = "global" as const;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;

export const activeProfileRecordSchema = z.object({
  profileName: z.string().min(1).nullable(),
  revision: z.number().int().nonnegative().max(MAX_REVISION),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type ActiveProfileRecord = z.infer<typeof activeProfileRecordSchema>;
export const activeProfileDomain = defineDomain({
  name: "workbench_active_profile",
  version: 1,
  tables: { states: domainTable<"global", ActiveProfileRecord>(activeProfileRecordSchema) },
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
  | { readonly ok: false; readonly error: { readonly code: "invalid-profile" | "unavailable" | "storage-error" | "revision-exhausted" | "cancelled"; readonly message: string } };
export interface ImoActiveProfile {
  get(signal?: AbortSignal): Promise<ActiveProfileResult<ActiveProfileView>>;
  select(profileName: string, signal?: AbortSignal): Promise<ActiveProfileResult<ActiveProfileView>>;
}
export const ACTIVE_PROFILE_CHANGED_EVENT = "active-profile/changed" as const;

function cancelled<T>(): ActiveProfileResult<T> {
  return { ok: false, error: { code: "cancelled", message: "active profile operation was cancelled" } };
}
function error<T>(code: "unavailable" | "storage-error", message = code): ActiveProfileResult<T> {
  return { ok: false, error: { code, message } };
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
      get: (signal?: AbortSignal) => this.get(signal),
      select: (name: string, signal?: AbortSignal) => this.select(name, signal),
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

  async get(signal?: AbortSignal): Promise<ActiveProfileResult<ActiveProfileView>> {
    if (signal?.aborted) return cancelled();
    if (this.#disposed || this.#table === undefined) return error("storage-error");
    return this.enqueue(async () => {
      if (signal?.aborted) return cancelled();
      let record: ActiveProfileRecord | undefined;
      try { record = this.#table!.get(ACTIVE_KEY) as ActiveProfileRecord | undefined; } catch { return error("storage-error"); }
      if (record === undefined) return this.bootstrap(signal);
      return this.resolveRecord(record, signal);
    });
  }

  async select(profileName: string, signal?: AbortSignal): Promise<ActiveProfileResult<ActiveProfileView>> {
    if (signal?.aborted) return cancelled();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profileName)) {
      return { ok: false, error: { code: "invalid-profile", message: "profile is invalid" } };
    }
    if (this.#disposed || this.#table === undefined) return error("storage-error");
    return this.enqueue(async () => {
      if (signal?.aborted) return cancelled();
      // This is deliberately uncached: selection validates the current
      // sanitized CLI inventory and never changes the CLI default pointer.
      const listed = await this.#auth.listProfiles(signal);
      if (this.#disposed || this.#table === undefined) return error("storage-error");
      if (!listed.ok) return error("unavailable");
      const profile = listed.value.profiles.find(item => item.profileName === profileName);
      if (profile === undefined) return { ok: false, error: { code: "invalid-profile", message: "profile is not available" } };
      let previous: ActiveProfileRecord | undefined;
      try { previous = this.#table!.get(ACTIVE_KEY) as ActiveProfileRecord | undefined; } catch { return error("storage-error"); }
      if (previous !== undefined && previous.revision >= MAX_REVISION) {
        return { ok: false, error: { code: "revision-exhausted", message: "active profile revision exhausted" } };
      }
      const record: ActiveProfileRecord = {
        profileName,
        revision: previous === undefined ? 1 : previous.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      try { await this.#table!.put(ACTIVE_KEY, record); } catch { return error("storage-error"); }
      this.ctx.emit(ACTIVE_PROFILE_CHANGED_EVENT, { profileName, revision: record.revision });
      return { ok: true, value: this.view(record, profile) };
    });
  }

  private async bootstrap(signal?: AbortSignal): Promise<ActiveProfileResult<ActiveProfileView>> {
    const fast = await this.#auth.profilesFast(signal);
    if (this.#disposed || this.#table === undefined) return error("storage-error");
    if (!fast.ok) return error("unavailable");
    const selected = fast.value.defaultProfile;
    const profile = selected === null ? undefined : fast.value.profiles.find(item => item.profileName === selected);
    const record: ActiveProfileRecord = { profileName: profile?.profileName ?? null, revision: 1, updatedAt: new Date().toISOString() };
    try { await this.#table!.put(ACTIVE_KEY, record); } catch { return error("storage-error"); }
    this.ctx.emit(ACTIVE_PROFILE_CHANGED_EVENT, { profileName: record.profileName, revision: record.revision });
    return { ok: true, value: this.view(record, profile) };
  }

  private async resolveRecord(record: ActiveProfileRecord, signal?: AbortSignal): Promise<ActiveProfileResult<ActiveProfileView>> {
    if (record.profileName === null) return { ok: true, value: this.view(record) };
    // Once state exists, refresh only through the sanitized cached inventory.
    // profilesFast also resolves the CLI default pointer, which is deliberately
    // permitted only during first bootstrap.
    const listed = await this.#auth.listProfilesCached(signal);
    if (this.#disposed || this.#table === undefined) return error("storage-error");
    if (!listed.ok) {
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
