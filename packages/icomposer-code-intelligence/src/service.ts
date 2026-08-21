import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { buildGraph } from "./graph.ts";
import { graphBaseDir, writeAtomic } from "./storage.ts";
import type { BuildOptions, IciBuildResult, IciErrorCode, IciManifest, ProgressCallback, Result } from "./types.ts";

const PASSTHROUGH_CODES = new Set<IciErrorCode>([
  "workspace-not-found",
  "invalid-workspace-id",
  "service-disposed",
  "cancelled",
]);

function err(code: IciErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}

type CatalogEntry = { name: string; type: string; sourcePath?: string; metadata?: Record<string, unknown> };
type CatalogResult = { ok: boolean; value?: { entries: CatalogEntry[]; counts: Record<string, number>; truncated: boolean }; error?: { code?: unknown; message?: string } };

export class IciEngineService extends Service {
  static inject = ["workspaceBinding", "icomposerCatalog"] as const;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #engineVersion = "0.1.0";

  constructor(ctx: Context) {
    super(ctx, "iciEngine");
    const self = this;
    const face = Object.freeze({
      build: (input: { readonly workspaceId: string }, options?: BuildOptions | AbortSignal) => self.build(input, options),
    });
    ctx.set("iciEngine", face);
    ctx.effect(() => () => { self.#disposed = true; }, "iciEngine.dispose");
  }

  async build(
    input: { readonly workspaceId: string },
    options?: BuildOptions | AbortSignal,
  ): Promise<Result<IciBuildResult>> {
    const opts: BuildOptions = options instanceof AbortSignal ? { signal: options } : (options ?? {});
    const signal = opts.signal;
    const onProgress = opts.onProgress;
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    return this.enqueue(async () => {
      if (this.#disposed) return err("service-disposed");
      if (signal?.aborted) return err("cancelled");
      const binding = await this.bindingEntry(input.workspaceId);
      if (!binding.ok) return binding as Result<never>;
      const { canonicalPath } = binding.value;
      const catalog = this.ctx.get("icomposerCatalog" as never) as unknown as {
        listAssets(input: { workspaceId: string }, signal?: AbortSignal): Promise<CatalogResult>;
      } | undefined;
      if (!catalog) return err("storage-error");
      const catalogRes = await catalog.listAssets({ workspaceId: input.workspaceId }, signal);
      if (!catalogRes.ok) {
        const raw = (catalogRes.error as { code?: unknown } | undefined)?.code;
        const code = typeof raw === "string" ? (raw as IciErrorCode) : undefined;
        if (code === "workspace-not-found") return err("workspace-not-found", "workspace does not exist");
        if (code && PASSTHROUGH_CODES.has(code)) return err(code);
        if (code === "workspace-not-bound") return err("workspace-not-bound");
        return err("storage-error");
      }
      const entries = catalogRes.value!.entries;
      // Normalize to catalog entries for graph builder
      const normalized = entries.map(e => ({
        name: e.name,
        type: e.type,
        sourcePath: (e as { sourcePath?: string }).sourcePath,
        metadata: (e as { metadata?: Record<string, unknown> }).metadata,
      }));
      try {
        const { nodes, edges, sourceFingerprint } = await buildGraph(canonicalPath, normalized, onProgress, signal);
        if (signal?.aborted) return err("cancelled");
        const base = graphBaseDir(canonicalPath, input.workspaceId);
        const manifest: IciManifest = {
          schemaVersion: 1,
          engineVersion: this.#engineVersion,
          sourceFingerprint,
          builtAt: new Date().toISOString(),
          nodeCount: nodes.length,
          edgeCount: edges.length,
          workspaceId: input.workspaceId,
          canonicalPath,
        };
        await writeAtomic(base, manifest, nodes as unknown[], edges as unknown[], { signal });
        return { ok: true, value: { manifest, nodes, edges } };
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return err("cancelled");
        if (signal?.aborted) return err("cancelled");
        // Snapshot write failures (including promote failures where the
        // previous version is kept) surface as a fixed storage-error.
        return err("storage-error", "storage-error");
      }
    });
  }

  private async bindingEntry(workspaceId: string): Promise<Result<{ canonicalPath: string; workspaceId: string }>> {
    const svc = this.ctx.get("workspaceBinding" as never) as unknown as {
      get(id: string): Promise<{ ok: boolean; value?: { canonicalPath: string; workspaceId: string; binding: unknown | null }; error?: { code?: unknown } }>;
    } | undefined;
    if (!svc) return err("storage-error");
    const res = await svc.get(workspaceId);
    if (!res.ok) {
      const raw = (res.error as { code?: unknown } | undefined)?.code;
      const code = typeof raw === "string" ? (raw as IciErrorCode) : undefined;
      if (code === "workspace-not-found") return err("workspace-not-found", "workspace does not exist");
      if (code && PASSTHROUGH_CODES.has(code)) return err(code);
      if (raw === "workspace-not-bound" || raw === "not-found") return err("workspace-not-bound");
      return err("storage-error");
    }
    const v = res.value!;
    if (!v.binding) return err("workspace-not-bound");
    return { ok: true, value: { canonicalPath: v.canonicalPath, workspaceId: v.workspaceId } };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => undefined, () => undefined);
    return p;
  }
}
