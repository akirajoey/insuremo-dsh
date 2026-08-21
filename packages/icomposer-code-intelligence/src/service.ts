import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildGraph, collectSources, fingerprintSources } from "./graph.ts";
import { indexEmbeddings, searchEmbeddings } from "./search-ops.ts";
import { applyCleanup, collectFileFacts, planCleanup } from "./maintenance.ts";
import { apiEmbeddingText, downstreamNodeNames, searchEvidence, type ApiSearchDoc } from "./search-core.ts";
import { graphBaseDir, loadSnapshot, writeAtomic } from "./storage.ts";
import { buildDownstreamTrees, buildImpactPaths, candidatesOf, DEFAULT_DEPTH, DEFAULT_MAX_NODES, MAX_DEPTH, MAX_MAX_NODES, resolveFocusId, resolveQueryNodes } from "./query.ts";
import type { BuildOptions, CleanupApplyResult, CleanupPlan, DiagnosticsResult, EmbeddingMode, IciBuildResult, IciEdge, IciErrorCode, IciManifest, IciNode, ProgressCallback, QueryApiInput, QueryApiResult, QueryImpactInput, QueryImpactResult, Result, SearchIndexInput, SearchIndexResult, SearchInput, SearchResult } from "./types.ts";
import { getDshHome, workspaceHash } from "./storage.ts";


declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    "ici-build": "ici-build";
    "ici-index": "ici-index";
  }
}

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

interface GraphView {
  nodes: Map<string, IciNode>;
  edges: IciEdge[];
  manifest: IciManifest;
}


export class IciEngineService extends Service {
  static inject = ["workspaceBinding", "icomposerCatalog", "imoAuth", "jobs"] as const;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #engineVersion = "0.1.0";
  readonly #timeoutMs: number;

  constructor(ctx: Context, config: { timeoutMs?: number } = {}) {
    super(ctx, "iciEngine");
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    const self = this;
    const face = Object.freeze({
      build: (input: { readonly workspaceId: string }, options?: BuildOptions | AbortSignal) => self.build(input, options),
      queryApi: (input: QueryApiInput, options?: BuildOptions | AbortSignal) => self.queryApi(input, options),
      queryImpact: (input: QueryImpactInput, options?: BuildOptions | AbortSignal) => self.queryImpact(input, options),
      index: (input: SearchIndexInput, options?: BuildOptions | AbortSignal) => self.index(input, options),
      search: (input: SearchInput, options?: BuildOptions | AbortSignal) => self.search(input, options),
      diagnostics: (input: { readonly workspaceId: string }) => self.diagnostics(input),
      cleanupPlan: (input: { readonly workspaceId: string }) => self.cleanupPlan(input),
      cleanupApply: (input: { readonly workspaceId: string; readonly expectedPaths: readonly string[] }) => self.cleanupApply(input),
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
    const onProgress = opts.onProgress as ProgressCallback | undefined;
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
        return err("storage-error", "storage-error");
      }
    });
  }

  private normalizeOptions(options?: BuildOptions | AbortSignal): BuildOptions {
    return options instanceof AbortSignal ? { signal: options } : (options ?? {});
  }

  /** Shared gate + snapshot load + staleness detection for query/search faces. */
  private async loadQueryContext(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; graph: GraphView; canonicalPath: string; stale?: true } | { ok: false; result: Result<never> }> {
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
    const graph: GraphView = {
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
    return { ok: true, graph, canonicalPath, ...(stale ? { stale } : {}) };
  }

  async queryApi(input: QueryApiInput, options?: BuildOptions | AbortSignal): Promise<Result<QueryApiResult>> {
    const opts = this.normalizeOptions(options);
    const ctxLoad = await this.loadQueryContext(input?.workspaceId, opts.signal);
    if (!ctxLoad.ok) return ctxLoad.result;
    const { graph, stale } = ctxLoad;
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
    const { roots, truncated, truncatedAt } = buildDownstreamTrees(graph, starts.map(s => s.id), depth, maxNodes, focus.focusId);
    const result: QueryApiResult = {
      workspaceId: input.workspaceId,
      matched: starts.map(s => s.id),
      roots,
      truncated,
      truncatedAt,
      ...(stale ? { stale } : {}),
    };
    return { ok: true, value: result };
  }

  async queryImpact(input: QueryImpactInput, options?: BuildOptions | AbortSignal): Promise<Result<QueryImpactResult>> {
    const opts = this.normalizeOptions(options);
    const ctxLoad = await this.loadQueryContext(input?.workspaceId, opts.signal);
    if (!ctxLoad.ok) return ctxLoad.result;
    const { graph, stale } = ctxLoad;
    if (typeof input?.query !== "string" || !input.query.trim()) return err("invalid-workspace-id", "query is required");
    const all = resolveQueryNodes(graph.nodes.values(), input.query);
    const starts = all.filter(n => n.kind === "function" || n.kind === "method");
    if (starts.length === 0) {
      return err("no-match", `no function/method matched: ${input.query}; candidates: ${candidatesOf(all).join(", ") || "none"}`);
    }
    const { paths, confidenceCounts, truncated } = buildImpactPaths(graph, starts.map(s => s.id));
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


  // ---- semantic search (TASK-025; Rust search/mod.rs semantics) ----

  private async loadSearchDocs(canonicalPath: string, graph: GraphView): Promise<ApiSearchDoc[]> {
    const { readFile: rf } = await import("node:fs/promises");
    const apiNodes = [...graph.nodes.values()].filter(n => n.kind === "api").sort((a, b) => a.id.localeCompare(b.id));
    const docs: ApiSearchDoc[] = [];
    for (const node of apiNodes) {
      const downstream = downstreamNodeNames(graph.nodes, graph.edges, node.id);
      const technicalText = apiEmbeddingText(node.name, "technical", "", downstream);
      const businessText = apiEmbeddingText(node.name, "business", "", downstream);
      const evidence = searchEvidence("", downstream);
      // node.sourceFile is workspace-relative; resolve against canonicalPath.
      let sourceHash = "";
      if (node.sourceFile) {
        try {
          const content = await rf(join(canonicalPath, node.sourceFile), "utf8");
          sourceHash = fingerprintSources([{ source: content }]);
        } catch { /* unreadable source: hash stays empty */ }
      }
      docs.push({
        apiId: node.id,
        apiName: node.name,
        sourceHash,
        technicalText,
        businessText,
        technicalEvidence: evidence,
        businessEvidence: evidence,
        textHash: fingerprintSources([{ source: technicalText }, { source: businessText }]),
      });
    }
    return docs;
  }

  async index(input: SearchIndexInput, options?: BuildOptions | AbortSignal): Promise<Result<SearchIndexResult>> {
    const opts = this.normalizeOptions(options);
    const signal = opts.signal;
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    return this.enqueue(async () => {
      if (this.#disposed) return err("service-disposed");
      if (signal?.aborted) return err("cancelled");
      const ctxLoad = await this.loadQueryContext(input.workspaceId, signal);
      if (!ctxLoad.ok) return ctxLoad.result;
      const { graph, canonicalPath, stale } = ctxLoad;
      const docs = await this.loadSearchDocs(canonicalPath, graph);
      const cachePath = join(graphBaseDir(canonicalPath, input.workspaceId), "search", "api_embeddings.jsonl");
      const outcome = await this.embeddingLease(input.workspaceId, signal, (rt, token) =>
        indexEmbeddings({ rt, token, cachePath, docs, rebuild: input.rebuild === true, timeoutMs: this.#timeoutMs, signal }));
      if (!(outcome as { ok: boolean }).ok) {
        const failure = outcome as unknown as { ok: false; error: { code: IciErrorCode; message: string } };
        return { ok: false, error: failure.error };
      }
      const value = (outcome as unknown as { ok: true; value: { total: number; embedded: number; reused: number } }).value;
      const result: SearchIndexResult = {
        workspaceId: input.workspaceId,
        total: value.total,
        embedded: value.embedded,
        reused: value.reused,
        ...(stale ? { stale } : {}),
      };
      return { ok: true, value: result };
    });
  }

  async search(input: SearchInput, options?: BuildOptions | AbortSignal): Promise<Result<SearchResult>> {
    const opts = this.normalizeOptions(options);
    const signal = opts.signal;
    if (this.#disposed) return err("service-disposed");
    if (signal?.aborted) return err("cancelled");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    if (typeof input.query !== "string" || !input.query.trim()) return err("invalid-workspace-id", "query is required");
    return this.enqueue(async () => {
      if (this.#disposed) return err("service-disposed");
      if (signal?.aborted) return err("cancelled");
      const ctxLoad = await this.loadQueryContext(input.workspaceId, signal);
      if (!ctxLoad.ok) return ctxLoad.result;
      const { graph, canonicalPath, stale } = ctxLoad;
      const cachePath = join(graphBaseDir(canonicalPath, input.workspaceId), "search", "api_embeddings.jsonl");
      const mode: EmbeddingMode = input.mode ?? "all";
      const top = clampInt(input.top, 10, 1, 50);
      const outcome = await this.embeddingLease(input.workspaceId, signal, (rt, token) =>
        searchEmbeddings({ rt, token, cachePath, query: input.query, mode, top, graph, timeoutMs: this.#timeoutMs, signal }));
      if (!(outcome as { ok: boolean }).ok) {
        const failure = outcome as unknown as { ok: false; error: { code: IciErrorCode; message: string } };
        return { ok: false, error: failure.error };
      }
      const value = (outcome as unknown as { ok: true; value: SearchResult }).value;
      return { ok: true, value: { ...value, workspaceId: input.workspaceId, ...(stale ? { stale } : {}) } };
    });
  }

  private async embeddingLease<T>(
    workspaceId: string,
    signal: AbortSignal | undefined,
    run: (rt: unknown, token: string) => Promise<T | { __failure: IciErrorCode }>,
  ): Promise<Result<T>> {
    const binding = await this.bindingEntry(workspaceId);
    if (!binding.ok) return binding as Result<never>;
    const auth = this.ctx.get("imoAuth" as never) as unknown as {
      prepare(request: { profile?: string; env?: string }, signal?: AbortSignal): Promise<{
        ok: boolean;
        value?: { use<T2>(cb: (secret: { readonly accessToken: string }) => Promise<T2> | T2): Promise<T2> };
        error?: { code?: string };
      }>;
    } | undefined;
    if (!auth) return err("embedding-error");
    const leaseResult = await auth.prepare({
      profile: (binding.value as { authProfile?: string }).authProfile,
      env: (binding.value as { environmentId?: string }).environmentId,
    }, signal);
    if (!leaseResult.ok) {
      const code = (leaseResult.error as { code?: string } | undefined)?.code;
      if (code === "invalid-auth" || code === "forbidden" || code === "prepare-invalidated" || code === "lease-revoked") {
        return err(code as IciErrorCode);
      }
      if (code === "timeout") return err("embedding-error");
      if (code === "cancelled") return err("cancelled");
      if (code === "service-disposed") return err("service-disposed");
      return err("embedding-error");
    }
    try {
      const outcome = await leaseResult.value!.use(async (secret) => await run(this.ctx.subprocess, secret.accessToken));
      if (outcome !== null && typeof outcome === "object" && "__failure" in outcome) {
        return err((outcome as unknown as { __failure: IciErrorCode }).__failure);
      }
      return { ok: true, value: outcome as T };
    } catch {
      return err("lease-revoked");
    }
  }


  async diagnostics(input: { readonly workspaceId: string }): Promise<Result<DiagnosticsResult>> {
    if (this.#disposed) return err("service-disposed");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    const binding = await this.bindingEntry(input.workspaceId);
    if (!binding.ok) return binding as Result<never>;
    const { canonicalPath } = binding.value;
    const base = graphBaseDir(canonicalPath, input.workspaceId);
    const workspaceDir = join(base, "..");
    const facts = await collectFileFacts({ workspaceDir });
    let manifest: Record<string, unknown> | null = null;
    try { manifest = JSON.parse(facts.manifest ?? "null") as Record<string, unknown> | null; } catch { manifest = null; }
    // stale: recompute source fingerprint when a snapshot exists.
    let isStale = false;
    if (manifest !== null && typeof manifest.sourceFingerprint === "string") {
      try {
        const catalog = this.ctx.get("icomposerCatalog" as never) as unknown as {
          listAssets(input: { workspaceId: string }, signal?: AbortSignal): Promise<CatalogResult>;
        } | undefined;
        if (catalog) {
          const catalogRes = await catalog.listAssets({ workspaceId: input.workspaceId });
          if (catalogRes.ok) {
            const entries = catalogRes.value!.entries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as { sourcePath?: string }).sourcePath }));
            const sources = await collectSources(canonicalPath, entries);
            if (fingerprintSources(sources.values()) !== manifest.sourceFingerprint) isStale = true;
          }
        }
      } catch { /* best-effort */ }
    }
    const home = getDshHome();
    const result: DiagnosticsResult = {
      workspaceId: input.workspaceId,
      indexPaths: {
        graphCurrent: join(home, "ici", workspaceHash(canonicalPath, input.workspaceId), "graph", "current"),
        searchJsonl: join(home, "ici", workspaceHash(canonicalPath, input.workspaceId), "graph", "search", "api_embeddings.jsonl"),
      },
      schemaVersion: 1,
      engineVersion: this.#engineVersion,
      builtAt: manifest !== null && typeof manifest.builtAt === "string" ? manifest.builtAt : null,
      nodeCount: manifest !== null && typeof manifest.nodeCount === "number" ? manifest.nodeCount : 0,
      edgeCount: manifest !== null && typeof manifest.edgeCount === "number" ? manifest.edgeCount : 0,
      searchVectors: facts.searchVectors,
      stale: isStale,
      requiredFiles: { nodes: facts.nodesExists, edges: facts.edgesExists, manifest: manifest !== null },
    };
    return { ok: true, value: result };
  }

  async cleanupPlan(input: { readonly workspaceId: string }): Promise<Result<CleanupPlan>> {
    if (this.#disposed) return err("service-disposed");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    const binding = await this.bindingEntry(input.workspaceId);
    if (!binding.ok) return binding as Result<never>;
    const { canonicalPath } = binding.value;
    const workspaceDir = join(graphBaseDir(canonicalPath, input.workspaceId), "..");
    const paths = await planCleanup(workspaceDir);
    return { ok: true, value: { workspaceId: input.workspaceId, paths } };
  }

  async cleanupApply(input: { readonly workspaceId: string; readonly expectedPaths: readonly string[] }): Promise<Result<CleanupApplyResult>> {
    if (this.#disposed) return err("service-disposed");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    if (!Array.isArray(input.expectedPaths)) return err("invalid-workspace-id", "expectedPaths must be an array");
    const binding = await this.bindingEntry(input.workspaceId);
    if (!binding.ok) return binding as Result<never>;
    const { canonicalPath } = binding.value;
    const workspaceDir = join(graphBaseDir(canonicalPath, input.workspaceId), "..");
    const { removed, skipped } = await applyCleanup(workspaceDir, input.expectedPaths);
    return { ok: true, value: { workspaceId: input.workspaceId, removed, skipped } };
  }

  private async bindingEntry(workspaceId: string): Promise<Result<{ canonicalPath: string; workspaceId: string; authProfile?: string; environmentId?: string }>> {
    const svc = this.ctx.get("workspaceBinding" as never) as unknown as {
      get(id: string): Promise<{ ok: boolean; value?: { canonicalPath: string; workspaceId: string; binding: { authProfile: string; environmentId: string } | null }; error?: { code?: unknown } }>;
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
    return {
      ok: true,
      value: {
        canonicalPath: v.canonicalPath,
        workspaceId: v.workspaceId,
        authProfile: v.binding.authProfile,
        environmentId: v.binding.environmentId,
      },
    };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => undefined, () => undefined);
    return p;
  }
}
