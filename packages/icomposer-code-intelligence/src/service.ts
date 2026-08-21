import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { buildGraph, collectSources, fingerprintSources } from "./graph.ts";
import { graphBaseDir, loadSnapshot, writeAtomic } from "./storage.ts";
import { buildDownstreamTrees, buildImpactPaths, candidatesOf, DEFAULT_DEPTH, DEFAULT_MAX_NODES, MAX_DEPTH, MAX_MAX_NODES, resolveFocusId, resolveQueryNodes } from "./query.ts";
import type { BuildOptions, IciBuildResult, IciEdge, IciErrorCode, IciManifest, IciNode, ProgressCallback, QueryApiInput, QueryApiResult, QueryImpactInput, QueryImpactResult, Result } from "./types.ts";

const PASSTHROUGH_CODES = new Set<IciErrorCode>([
  "workspace-not-found",
  "invalid-workspace-id",
  "service-disposed",
  "cancelled",
]);

function err(code: IciErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
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
      queryApi: (input: QueryApiInput, options?: BuildOptions | AbortSignal) => self.queryApi(input, options),
      queryImpact: (input: QueryImpactInput, options?: BuildOptions | AbortSignal) => self.queryImpact(input, options),
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

  private normalizeOptions(options?: BuildOptions | AbortSignal): BuildOptions {
    return options instanceof AbortSignal ? { signal: options } : (options ?? {});
  }

  /** Shared gate + snapshot load + staleness detection for query faces. */
  private async loadQueryContext(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; graph: { nodes: Map<string, IciNode>; edges: IciEdge[]; manifest: IciManifest }; canonicalPath: string; stale?: true } | { ok: false; result: Result<never> }> {
    if (this.#disposed) return { ok: false, result: err("service-disposed") };
    if (signal?.aborted) return { ok: false, result: err("cancelled") };
    if (typeof workspaceId !== "string" || !workspaceId) return { ok: false, result: err("invalid-workspace-id") };
    const binding = await this.bindingEntry(workspaceId);
    if (!binding.ok) return { ok: false, result: binding as Result<never> };
    const { canonicalPath } = binding.value;
    const base = graphBaseDir(canonicalPath, workspaceId);
    const snapshot = await loadSnapshot(base);
    if (!snapshot) {
      return { ok: false, result: err("no-snapshot", "no-snapshot: run iciEngine.build first") };
    }
    const nodeMap = new Map<string, IciNode>();
    for (const n of snapshot.nodes) nodeMap.set(n.id, n as unknown as IciNode);
    const typedGraph = {
      nodes: nodeMap,
      edges: snapshot.edges as unknown as IciEdge[],
      manifest: snapshot.manifest,
    };
    // Staleness: recompute the source fingerprint from the current tree.
    let stale: true | undefined;
    try {
      const catalog = this.ctx.get("icomposerCatalog" as never) as unknown as {
        listAssets(input: { workspaceId: string }, signal?: AbortSignal): Promise<CatalogResult>;
      } | undefined;
      if (catalog) {
        const catalogRes = await catalog.listAssets({ workspaceId }, signal);
        if (catalogRes.ok) {
          const entries = catalogRes.value!.entries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as { sourcePath?: string }).sourcePath }));
          const sources = await collectSources(canonicalPath, entries, signal);
          if (fingerprintSources(sources.values()) !== snapshot.manifest.sourceFingerprint) stale = true;
        }
      }
    } catch { /* staleness check is best-effort */ }
    return { ok: true, graph: typedGraph, canonicalPath, ...(stale ? { stale } : {}) };
  }

  async queryApi(input: QueryApiInput, options?: BuildOptions | AbortSignal): Promise<Result<QueryApiResult>> {
    const opts = this.normalizeOptions(options);
    const ctxLoad = await this.loadQueryContext(input?.workspaceId, opts.signal);
    if (!ctxLoad.ok) return ctxLoad.result;
    const { graph, canonicalPath, stale } = ctxLoad;
    if (typeof input?.query !== "string" || !input.query.trim()) return err("invalid-workspace-id", "query is required");
    const depth = clampInt(input.depth, DEFAULT_DEPTH, 1, MAX_DEPTH);
    const maxNodes = clampInt(input.maxNodes, DEFAULT_MAX_NODES, 1, MAX_MAX_NODES);
    const starts = resolveQueryNodes(graph.nodes.values(), input.query, "api");
    if (starts.length === 0) {
      return err("no-match", `no api matched: ${input.query}; candidates: ${candidatesOf(graph.nodes.values()).join(", ") || "none"}`);
    }
    const focus = resolveFocusId(graph.nodes.values(), input.focus);
    if (!focus.ok) {
      return err("no-match", focus.reason === "not-found"
        ? `focus function not found: ${input.focus}`
        : `focus matched multiple functions: ${focus.candidates.join(", ")}`);
    }
    const { roots, truncated, truncatedAt } = buildDownstreamTrees(
      { nodes: graph.nodes, edges: graph.edges, manifest: graph.manifest },
      starts.map(s => s.id),
      depth,
      maxNodes,
      focus.focusId,
    );
    const result: QueryApiResult = {
      workspaceId: input.workspaceId,
      matched: starts.map(s => s.id),
      roots,
      truncated,
      truncatedAt,
      ...(stale ? { stale } : {}),
    };
    void canonicalPath;
    return { ok: true, value: result };
  }

  async queryImpact(input: QueryImpactInput, options?: BuildOptions | AbortSignal): Promise<Result<QueryImpactResult>> {
    const opts = this.normalizeOptions(options);
    const ctxLoad = await this.loadQueryContext(input?.workspaceId, opts.signal);
    if (!ctxLoad.ok) return ctxLoad.result;
    const { graph, stale } = ctxLoad;
    if (typeof input?.query !== "string" || !input.query.trim()) return err("invalid-workspace-id", "query is required");
    // Impact starts are limited to function/method nodes (Rust cmd_impact).
    const all = resolveQueryNodes(graph.nodes.values(), input.query);
    const starts = all.filter(n => n.kind === "function" || n.kind === "method");
    if (starts.length === 0) {
      return err("no-match", `no function/method matched: ${input.query}; candidates: ${candidatesOf(all).join(", ") || "none"}`);
    }
    const { paths, confidenceCounts, truncated } = buildImpactPaths(
      { nodes: graph.nodes, edges: graph.edges, manifest: graph.manifest },
      starts.map(s => s.id),
    );
    const result: QueryImpactResult = {
      workspaceId: input.workspaceId,
      matched: starts.map(s => s.id),
      paths,
      confidenceCounts,
      truncated,
      ...(stale ? { stale } : {}),
    };
    return { ok: true, value: result };
  }
}
