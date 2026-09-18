import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { enumerateSources, duplicateNames } from "./enumerate.ts";
import { scanWorkspace } from "./scan.ts";
import type { AssetCatalog, AssetType, CatalogErrorCode, ListAssetsInput, ListSourcesInput, Result, SourceEntry, SourceListing } from "./types.ts";

const VALID_TYPES: AssetType[] = ["api", "function", "batch", "model"];

const PASSTHROUGH_CODES = new Set<CatalogErrorCode>([
  "workspace-not-found",
  "invalid-workspace-id",
  "service-disposed",
  "cancelled",
]);

function err(code: CatalogErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}

export class IcomposerCatalogService extends Service {
  static inject = ["workspaceBinding"] as const;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(ctx: Context) {
    super(ctx, "icomposerCatalog");
    const self = this;
    const face = Object.freeze({
      listAssets: (input: ListAssetsInput, signal?: AbortSignal) => self.listAssets(input, signal),
      listSourcesComplete: (input: ListSourcesInput, signal?: AbortSignal) => self.listSourcesComplete(input, signal),
    });
    ctx.set("icomposerCatalog", face);
    ctx.effect(() => () => { self.#disposed = true; }, "icomposerCatalog.dispose");
  }

  async listAssets(input: ListAssetsInput, signal?: AbortSignal): Promise<Result<AssetCatalog>> {
    if (this.#disposed) return err("service-disposed", "catalog service is disposed");
    if (signal?.aborted) return err("cancelled", "operation was cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id", "workspace id is invalid");
    if (input.type !== undefined && !VALID_TYPES.includes(input.type)) return err("invalid-type", "asset type is invalid");
    return this.enqueue(async () => {
      if (this.#disposed) return err("service-disposed");
      if (signal?.aborted) return err("cancelled");
      const bindingSvc = this.ctx.get("workspaceBinding" as never) as unknown as {
        get(id: string): Promise<{ ok: boolean; value?: { workspaceId: string; canonicalPath: string; binding: unknown | null }; error?: { code: string } }>;
      } | undefined;
      if (!bindingSvc) return err("service-disposed");
      const res = await bindingSvc.get(input.workspaceId);
      if (!res.ok) {
        const raw = (res.error as unknown as { code?: unknown }).code;
        const code = typeof raw === "string" ? (raw as CatalogErrorCode) : undefined;
        if (code === "workspace-not-found") return err("workspace-not-found", "workspace does not exist");
        if (code && PASSTHROUGH_CODES.has(code)) return err(code);
        return err("storage-error");
      }
      const entry = res.value!;
      // Local catalog scans use the registered canonical workspace path; an
      // InsureMO binding is only required by remote/write operations.
      const canonicalPath = entry.canonicalPath;
      const scan = await scanWorkspace(canonicalPath, input.type, signal);
      const counts: Record<string, number> = { api: 0, function: 0, batch: 0, model: 0, total: scan.entries.length };
      for (const e of scan.entries) counts[e.type] = (counts[e.type] ?? 0) + 1;
      const catalog: AssetCatalog = {
        workspaceId: input.workspaceId,
        canonicalPath,
        entries: Object.freeze([...scan.entries]),
        counts: counts as AssetCatalog["counts"],
        truncated: scan.truncated,
        sections: scan.sections,
      };
      return { ok: true, value: Object.freeze(catalog) as AssetCatalog };
    });
  }

  /**
   * TASK-111: complete api/function enumeration (uncapped, path-identified) for
   * task target resolution and graph building. Same-name discoveries are reported,
   * never merged; the display-oriented `listAssets` keeps its own 5000-item bound.
   */
  async listSourcesComplete(input: ListSourcesInput, signal?: AbortSignal): Promise<Result<SourceListing>> {
    if (this.#disposed) return err("service-disposed", "catalog service is disposed");
    if (signal?.aborted) return err("cancelled", "operation was cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id", "workspace id is invalid");
    return this.enqueue(async () => {
      if (this.#disposed) return err("service-disposed");
      if (signal?.aborted) return err("cancelled");
      const bindingSvc = this.ctx.get("workspaceBinding" as never) as unknown as {
        get(id: string): Promise<{ ok: boolean; value?: { workspaceId: string; canonicalPath: string } ; error?: { code: string } }>;
      } | undefined;
      if (!bindingSvc) return err("service-disposed");
      const res = await bindingSvc.get(input.workspaceId);
      if (!res.ok) {
        const raw = (res.error as unknown as { code?: unknown }).code;
        const code = typeof raw === "string" ? (raw as CatalogErrorCode) : undefined;
        if (code === "workspace-not-found") return err("workspace-not-found", "workspace does not exist");
        if (code && PASSTHROUGH_CODES.has(code)) return err(code);
        return err("storage-error");
      }
      try {
        const entries: SourceEntry[] = [];
        for await (const item of enumerateSources(res.value!.canonicalPath)) {
          if (signal?.aborted) return err("cancelled", "operation was cancelled");
          entries.push({ name: item.name, type: item.type, tenant: item.tenant, group: item.group, sourcePath: item.relativePath });
        }
        return { ok: true, value: Object.freeze({ entries: Object.freeze(entries), duplicateNames: Object.freeze(duplicateNames(entries.map(entry => ({ ...entry, relativePath: entry.sourcePath, absolutePath: "" })))) }) as SourceListing };
      } catch { return err("storage-error"); }
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => undefined, () => undefined);
    return p;
  }
}
