import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { scanSdk, scanUtils } from "./scan.ts";
import type {
  IcomposerReferenceFace,
  ReferenceErrorCode,
  Result,
  SdkClientsResult,
  SdkQueryInput,
  SdkQueryResult,
  UtilMethodsResult,
  UtilQueryInput,
  UtilsResult,
} from "./types.ts";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./types.ts";

const PASSTHROUGH_CODES = new Set<ReferenceErrorCode>([
  "workspace-not-found",
  "invalid-workspace-id",
  "service-disposed",
  "cancelled",
]);

function err(code: ReferenceErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}

function limitOf(value: number | undefined): Result<never> | { ok: true; value: number } {
  if (value === undefined) return { ok: true, value: DEFAULT_LIMIT };
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) return err("invalid-limit");
  return { ok: true, value };
}

export class IcomposerReferenceService extends Service {
  static inject = ["workspaceBinding"] as const;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(ctx: Context) {
    super(ctx, "icomposerReference");
    const self = this;
    const face: IcomposerReferenceFace = Object.freeze({
      listSdkClients: (input: { readonly workspaceId: string }, signal?: AbortSignal) => self.listSdkClients(input, signal),
      querySdkOperations: (input: SdkQueryInput, signal?: AbortSignal) => self.querySdkOperations(input, signal),
      listUtilities: (input: { readonly workspaceId: string }, signal?: AbortSignal) => self.listUtilities(input, signal),
      queryUtilityMethods: (input: UtilQueryInput, signal?: AbortSignal) => self.queryUtilityMethods(input, signal),
    });
    ctx.set("icomposerReference", face);
    ctx.effect(() => () => { self.#disposed = true; }, "icomposerReference.dispose");
  }

  async listSdkClients(input: { readonly workspaceId: string }, signal?: AbortSignal): Promise<Result<SdkClientsResult>> {
    return this.guard(input.workspaceId, signal, async (canonicalPath) => {
      const { clients, operations } = await scanSdk(canonicalPath, signal);
      const value: SdkClientsResult = Object.freeze({
        workspaceId: input.workspaceId,
        clients: Object.freeze(clients),
        counts: Object.freeze({ clients: clients.length, operations: operations.length }),
      });
      return { ok: true, value };
    });
  }

  async querySdkOperations(input: SdkQueryInput, signal?: AbortSignal): Promise<Result<SdkQueryResult>> {
    const lim = limitOf(input?.limit);
    if (!lim.ok) return lim;
    return this.guard(input.workspaceId, signal, async (canonicalPath) => {
      const kw = input.keyword;
      const clientFilter = input.client;
      const { clients, operations } = await scanSdk(canonicalPath, signal);
      const filtered = operations.filter(op => {
        if (clientFilter !== undefined && op.client !== clientFilter) return false;
        if (kw && !matchAny(kw, op.client, op.path, op.operationId, op.summary, op.tag)) return false;
        return true;
      });
      const truncated = filtered.length > lim.value;
      const slice = truncated ? filtered.slice(0, lim.value) : filtered;
      const clientCount = new Set(slice.map(o => o.client)).size;
      const value: SdkQueryResult = Object.freeze({
        workspaceId: input.workspaceId,
        operations: Object.freeze(slice),
        counts: Object.freeze({ clients: clientCount, operations: slice.length }),
        limit: lim.value,
        truncated,
      });
      return { ok: true, value };
    });
  }

  async listUtilities(input: { readonly workspaceId: string }, signal?: AbortSignal): Promise<Result<UtilsResult>> {
    return this.guard(input.workspaceId, signal, async (canonicalPath) => {
      const { utils, methods } = await scanUtils(canonicalPath, signal);
      const value: UtilsResult = Object.freeze({
        workspaceId: input.workspaceId,
        utils: Object.freeze(utils),
        counts: Object.freeze({ utils: utils.length, methods: methods.length }),
      });
      return { ok: true, value };
    });
  }

  async queryUtilityMethods(input: UtilQueryInput, signal?: AbortSignal): Promise<Result<UtilMethodsResult>> {
    const lim = limitOf(input?.limit);
    if (!lim.ok) return lim;
    return this.guard(input.workspaceId, signal, async (canonicalPath) => {
      const kw = input.keyword;
      const utilFilter = input.util;
      const { methods } = await scanUtils(canonicalPath, signal);
      const filtered = methods.filter(m => {
        if (utilFilter !== undefined && m.util !== utilFilter) return false;
        if (kw && !matchAny(kw, m.util, m.method)) return false;
        return true;
      });
      const truncated = filtered.length > lim.value;
      const slice = truncated ? filtered.slice(0, lim.value) : filtered;
      const utilCount = new Set(slice.map(o => o.util)).size;
      const value: UtilMethodsResult = Object.freeze({
        workspaceId: input.workspaceId,
        methods: Object.freeze(slice),
        counts: Object.freeze({ utils: utilCount, methods: slice.length }),
        limit: lim.value,
        truncated,
      });
      return { ok: true, value };
    });
  }

  private async guard<T>(
    workspaceId: string,
    signal: AbortSignal | undefined,
    run: (canonicalPath: string) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (typeof workspaceId !== "string" || !workspaceId) return err("invalid-workspace-id");
    return this.enqueue(async () => {
      if (this.#disposed) return err("service-disposed");
      if (signal?.aborted) return err("cancelled");
      const bindingSvc = this.ctx.get("workspaceBinding" as never) as unknown as {
        get(id: string): Promise<{ ok: boolean; value?: { binding: unknown | null; canonicalPath: string }; error?: { code?: unknown } }>;
      } | undefined;
      if (!bindingSvc) return err("storage-error");
      const res = await bindingSvc.get(workspaceId);
      if (!res.ok) {
        const raw = (res.error as { code?: unknown } | undefined)?.code;
        const code = typeof raw === "string" ? (raw as ReferenceErrorCode) : undefined;
        if (code === "workspace-not-found") return err("workspace-not-found", "workspace does not exist");
        if (code && PASSTHROUGH_CODES.has(code)) return err(code);
        return err("storage-error");
      }
      const entry = res.value!;
      if (!entry.binding) return err("workspace-not-bound");
      return run(entry.canonicalPath);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => undefined, () => undefined);
    return p;
  }
}

function matchAny(kw: string, ...parts: Array<string | undefined>): boolean {
  const needle = kw.toLowerCase();
  return parts.some(p => p !== undefined && p.toLowerCase().includes(needle));
}
