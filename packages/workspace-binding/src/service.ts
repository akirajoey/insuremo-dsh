import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import { isFullInsuremoEnvId, isAuthProfile, isTenantCode, isWriteMode, isWorkspaceId } from "./validation.ts";
import { workspaceBindingDomain, type BindingRecord } from "./domain.ts";
import { detectIcomposerProject } from "./detect.ts";
import { mountAutoBind } from "./auto-bind.ts";

export const WORKSPACE_BINDING_ERRORS = {
  "invalid-workspace-id": "workspace id is invalid",
  "workspace-not-found": "workspace does not exist",
  "invalid-environment": "environment id is invalid",
  "invalid-tenant": "tenant code is invalid",
  "invalid-profile": "auth profile is invalid",
  "invalid-write-mode": "write mode is invalid",
  "invalid-revision": "expected revision is invalid",
  "revision-conflict": "revision does not match expected revision",
  "revision-exhausted": "revision limit exhausted",
  "binding-conflict": "environment or tenant is immutable for an active binding",
  "path-already-bound": "canonical path is already bound to another workspace",
  "not-found": "binding does not exist",
  "cancelled": "operation was cancelled",
  "service-disposed": "workspace binding service is disposed",
  "storage-error": "storage operation failed",
} as const;

export type BindingErrorCode = keyof typeof WORKSPACE_BINDING_ERRORS;

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: BindingErrorCode; readonly message: string } };

export interface BindingView {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly environmentId: string;
  readonly tenantCode: string;
  readonly authProfile: string;
  readonly writeMode: "read-only" | "read-write";
  readonly metadataFingerprint: null;
  readonly sourceFingerprint: null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceListEntry {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly status: "ok" | "missing-dir" | "orphan" | "unavailable";
  readonly binding: BindingView | null;
  /** Strong-signature iComposer project detection (undefined = not probed). */
  readonly detectedIcomposer?: boolean;
  /** Derived auto-bind state: bound | pending (detected, unbound) | none. */
  readonly autoBindState?: "bound" | "pending" | "none";
}

export interface BindInput {
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly tenantCode: string;
  readonly authProfile: string;
  readonly writeMode: "read-only" | "read-write";
  readonly expectedRevision: number;
}

export interface UnbindInput {
  readonly workspaceId: string;
  readonly expectedRevision: number;
}

export interface WorkspaceBindingServiceFace {
  list(signal?: AbortSignal): Promise<Result<readonly WorkspaceListEntry[]>>;
  get(workspaceId: string, signal?: AbortSignal): Promise<Result<WorkspaceListEntry>>;
  bind(input: BindInput, signal?: AbortSignal): Promise<Result<BindingView>>;
  unbind(input: UnbindInput, signal?: AbortSignal): Promise<Result<boolean>>;
  autoBindState(workspaceId: string): Promise<Result<{ detected: boolean; state: "bound" | "pending" | "none" }>>;
}

function frozen<T extends object>(value: T): T {
  return Object.freeze({ ...value }) as T;
}

function err(code: BindingErrorCode, message?: string): Result<never> {
  return { ok: false, error: { code, message: message ?? WORKSPACE_BINDING_ERRORS[code] } };
}

function disposed(): Result<never> {
  return err("service-disposed");
}

function checkAborted(signal?: AbortSignal): Result<never> | null {
  if (signal?.aborted) return err("cancelled");
  return null;
}

export class WorkspaceBindingService extends Service implements WorkspaceBindingServiceFace {
  static inject = ["storageDomain", "workspaceRegistry"] as const;
  #domain?: Domain<typeof workspaceBindingDomain>;
  #table?: ReturnType<Domain<typeof workspaceBindingDomain>["table"]>;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;
  #disposePromise?: Promise<void>;

  constructor(ctx: Context) {
    super(ctx, "workspaceBinding");
    const self = this;
    const face: WorkspaceBindingServiceFace = Object.freeze({
      list: (signal?: AbortSignal) => self.list(signal),
      get: (id: string, signal?: AbortSignal) => self.get(id, signal),
      bind: (input: BindInput, signal?: AbortSignal) => self.bind(input, signal),
      unbind: (input: UnbindInput, signal?: AbortSignal) => self.unbind(input, signal),
      autoBindState: (id: string) => self.autoBindState(id),
    });
    ctx.set("workspaceBinding", face);
    ctx.effect(() => () => {
      self.#disposed = true;
      return self.disposeService();
    }, "workspaceBinding.dispose");
  }

  #autoBind?: ReturnType<typeof mountAutoBind>;

  protected async [Service.init](): Promise<void> {
    if (this.#disposed) throw new Error("service disposed");
    try {
      const domain = await this.ctx.storageDomain.open(workspaceBindingDomain);
      this.#domain = domain as unknown as Domain<typeof workspaceBindingDomain>;
      this.#table = domain.table("bindings") as unknown as ReturnType<Domain<typeof workspaceBindingDomain>["table"]>;
    } catch {
      throw new Error("storage operation failed");
    }
    // Auto-bind listens for newly added workspaces (domain/changed puts) and
    // is strictly best-effort: detection misses and bind failures never
    // affect the service lifecycle.
    try {
      const self = this;
      this.#autoBind = mountAutoBind(this.ctx as never, {
        binding: () => ({
          list: (signal?: AbortSignal) => self.list(signal) as never,
          get: (id: string, signal?: AbortSignal) => self.get(id, signal) as never,
          bind: (input: BindInput, signal?: AbortSignal) => self.bind(input, signal) as never,
        }),
      });
    } catch { /* auto-bind unavailable */ }
    this.ctx.effect(() => async () => {
      this.#autoBind?.dispose();
      await this.disposeDomain();
    }, "workspaceBinding.domainClose");
  }

  /** Derived auto-bind state for one workspace (detection is read-only). */
  async autoBindState(workspaceId: string): Promise<Result<{ detected: boolean; state: "bound" | "pending" | "none" }>> {
    if (this.#disposed) return disposed();
    if (!isWorkspaceId(workspaceId)) return err("invalid-workspace-id");
    if (this.#autoBind === undefined) return err("storage-error");
    const value = await this.#autoBind.stateOf(workspaceId);
    return { ok: true, value: frozen(value) };
  }

  async list(signal?: AbortSignal): Promise<Result<readonly WorkspaceListEntry[]>> {
    if (this.#disposed) return disposed();
    const aborted = checkAborted(signal);
    if (aborted) return aborted;
    return this.enqueue(async () => {
      if (this.#disposed) return disposed();
      if (checkAborted(signal)) return checkAborted(signal)!;
      const registry = this.ctx.get("workspaceRegistry" as never) as unknown as {
        list(): Array<{ id: string; path: string; title: string; status(): Promise<string> }>;
      } | undefined;
      if (!registry) return err("service-disposed");
      const entries: WorkspaceListEntry[] = [];
      const seen = new Set<string>();
      for (const ws of registry.list()) {
        seen.add(String(ws.id));
        const record = this.#table?.get(String(ws.id) as never) as unknown as BindingRecord | undefined;
        let status: WorkspaceListEntry["status"] = "ok";
        try {
          const s = await ws.status();
          status = s === "missing-dir" ? "missing-dir" : "ok";
        } catch {
          status = "unavailable";
        }
        const binding = record ? toView(record) : null;
        const detected = await detectIcomposerProject(ws.path, signal).catch(() => false);
        entries.push(frozen({
          workspaceId: String(ws.id), canonicalPath: ws.path, displayName: ws.title, status, binding,
          detectedIcomposer: detected,
          autoBindState: binding !== null ? "bound" : detected ? "pending" : "none",
        }));
      }
      if (this.#table) {
        for (const [key, record] of (this.#table as unknown as { entries(): Iterable<[string, BindingRecord]> }).entries()) {
          if (seen.has(key)) continue;
          entries.push(
            frozen({
              workspaceId: key,
              canonicalPath: (record as BindingRecord).canonicalPath,
              displayName: (record as BindingRecord).canonicalPath,
              status: "orphan" as const,
              binding: toView(record as BindingRecord),
            }),
          );
        }
      }
      return { ok: true, value: Object.freeze([...entries]) };
    });
  }

  async get(workspaceId: string, signal?: AbortSignal): Promise<Result<WorkspaceListEntry>> {
    if (this.#disposed) return disposed();
    if (!isWorkspaceId(workspaceId)) return err("invalid-workspace-id");
    const aborted = checkAborted(signal);
    if (aborted) return aborted;
    return this.enqueue(async () => {
      if (this.#disposed) return disposed();
      if (checkAborted(signal)) return checkAborted(signal)!;
      const registry = this.ctx.get("workspaceRegistry" as never) as unknown as {
        get(id: string): { id: string; path: string; title: string; status(): Promise<string> } | undefined;
      } | undefined;
      const ws = registry?.get(workspaceId);
      const record = this.#table?.get(workspaceId as never) as unknown as BindingRecord | undefined;
      if (!ws && !record) return err("workspace-not-found");
      if (ws) {
        let status: WorkspaceListEntry["status"] = "ok";
        try {
          const s = await ws.status();
          status = s === "missing-dir" ? "missing-dir" : "ok";
        } catch {
          status = "unavailable";
        }
        const binding = record ? toView(record) : null;
        const detected = await detectIcomposerProject(ws.path, signal).catch(() => false);
        return {
          ok: true,
          value: frozen({
            workspaceId, canonicalPath: ws.path, displayName: ws.title, status, binding,
            detectedIcomposer: detected,
            autoBindState: binding !== null ? "bound" : detected ? "pending" : "none",
          }),
        };
      }
      return {
        ok: true,
        value: frozen({
          workspaceId,
          canonicalPath: record!.canonicalPath,
          displayName: record!.canonicalPath,
          status: "orphan" as const,
          binding: toView(record!),
          autoBindState: "bound",
        }),
      };
    });
  }

  async bind(input: BindInput, signal?: AbortSignal): Promise<Result<BindingView>> {
    const v = validateBindInput(input);
    if (!v.ok) return v;
    if (this.#disposed) return disposed();
    const aborted = checkAborted(signal);
    if (aborted) return aborted;
    return this.enqueue(async () => {
      if (this.#disposed) return disposed();
      if (checkAborted(signal)) return checkAborted(signal)!;
      const registry = this.ctx.get("workspaceRegistry" as never) as unknown as {
        get(id: string): { id: string; path: string; title: string } | undefined;
      } | undefined;
      const ws = registry?.get(input.workspaceId);
      if (!ws) return err("workspace-not-found");
      const table = this.#table as unknown as { get(k: string): BindingRecord | undefined; put(k: string, v: BindingRecord): Promise<void>; entries(): Iterable<[string, BindingRecord]> };
      let existing: BindingRecord | undefined;
      try { existing = table.get(input.workspaceId); } catch { return err("storage-error"); }
      const canonicalPath = ws.path;
      if (existing === undefined) {
        if (input.expectedRevision !== 0) return err("revision-conflict");
        try {
          for (const [otherId, rec] of table.entries()) {
            if (otherId !== input.workspaceId && rec.canonicalPath === canonicalPath) {
              return err("path-already-bound");
            }
          }
        } catch { return err("storage-error"); }
        const now = new Date().toISOString();
        const record: BindingRecord = {
          workspaceId: input.workspaceId,
          canonicalPath,
          environmentId: input.environmentId,
          tenantCode: input.tenantCode,
          authProfile: input.authProfile,
          writeMode: input.writeMode,
          metadataFingerprint: null,
          sourceFingerprint: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        try { await table.put(input.workspaceId, record); } catch { return err("storage-error"); }
        return { ok: true, value: toView(record) };
      }
      if (existing.revision !== input.expectedRevision) return err("revision-conflict");
      if (existing.canonicalPath !== canonicalPath) return err("binding-conflict");
      if (existing.environmentId !== input.environmentId || existing.tenantCode !== input.tenantCode) {
        return err("binding-conflict");
      }
      if (existing.authProfile === input.authProfile && existing.writeMode === input.writeMode) {
        return { ok: true, value: toView(existing) };
      }
      if (existing.revision >= Number.MAX_SAFE_INTEGER) return err("revision-exhausted");
      const now = new Date().toISOString();
      const record: BindingRecord = {
        ...existing,
        authProfile: input.authProfile,
        writeMode: input.writeMode,
        revision: existing.revision + 1,
        updatedAt: now,
      };
      try { await table.put(input.workspaceId, record); } catch { return err("storage-error"); }
      return { ok: true, value: toView(record) };
    });
  }

  async unbind(input: UnbindInput, signal?: AbortSignal): Promise<Result<boolean>> {
    if (!isWorkspaceId(input.workspaceId)) return err("invalid-workspace-id");
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 || input.expectedRevision > Number.MAX_SAFE_INTEGER) return err("invalid-revision");
    if (this.#disposed) return disposed();
    const aborted = checkAborted(signal);
    if (aborted) return aborted;
    return this.enqueue(async () => {
      if (this.#disposed) return disposed();
      if (checkAborted(signal)) return checkAborted(signal)!;
      let existing: BindingRecord | undefined;
      try { existing = (this.#table as unknown as { get(k: string): BindingRecord | undefined }).get(input.workspaceId); } catch { return err("storage-error"); }
      if (!existing) return err("not-found");
      if (existing.revision !== input.expectedRevision) return err("revision-conflict");
      try { await (this.#table as unknown as { delete(k: string): Promise<boolean> }).delete(input.workspaceId as never); } catch { return err("storage-error"); }
      return { ok: true, value: true };
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => undefined, () => undefined);
    return p;
  }

  private async disposeDomain(): Promise<void> {
    if (this.#domain) {
      try { await (this.#domain as unknown as { close(): Promise<void> }).close(); } catch {}
      this.#domain = undefined;
      this.#table = undefined;
    }
  }

  private async disposeService(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = (async () => {
      await this.#queue;
      await this.disposeDomain();
    })();
    return this.#disposePromise;
  }
}

function validateBindInput(input: BindInput): Result<never> | { ok: true; value: BindInput } {
  if (!isWorkspaceId(input.workspaceId)) return err("invalid-workspace-id");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > Number.MAX_SAFE_INTEGER) return err("invalid-revision");
  if (!isFullInsuremoEnvId(input.environmentId)) return err("invalid-environment");
  if (!isTenantCode(input.tenantCode)) return err("invalid-tenant");
  if (!isAuthProfile(input.authProfile)) return err("invalid-profile");
  if (!isWriteMode(input.writeMode)) return err("invalid-write-mode");
  return { ok: true, value: input };
}

function toView(record: BindingRecord): BindingView {
  return Object.freeze({
    workspaceId: record.workspaceId,
    canonicalPath: record.canonicalPath,
    environmentId: record.environmentId,
    tenantCode: record.tenantCode,
    authProfile: record.authProfile,
    writeMode: record.writeMode,
    metadataFingerprint: null,
    sourceFingerprint: null,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }) as BindingView;
}
