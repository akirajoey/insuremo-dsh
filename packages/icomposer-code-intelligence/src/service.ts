import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { auditGraph, buildGraph, collectSources, fingerprintSources } from "./graph.ts";
import { runExplainContext, runExplainDeterministic } from "./explain-runtime.ts";
import { runBlockedTargets, runFinalize, runPrepare, runPrepareBatch, runSource, type NativeExplainDeps, runPrepareTask } from "./explain-native.ts";
import { computeGraphDigest } from "./explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "./engine-version.ts";
import { indexEmbeddings, searchEmbeddings } from "./search-ops.ts";
import { embeddingLease, loadSearchDocs, type SearchDocLike } from "./search-runtime.ts";
import { resolveActiveProfileAuth } from "./active-profile-auth.ts";
import { GRAPH_ARTIFACT_RELATIVE_PATH, SEARCH_ARTIFACT_RELATIVE_PATH, graphBaseDir, legacyGraphBaseDir, loadSnapshot, readManifest, searchCachePath, writeAtomic, writeFileAtomic, writeExplainContext, writeExplainDeterministic } from "./storage.ts";
import { applyCleanup, buildDiagnosticsView, collectFileFacts, planCleanup } from "./maintenance.ts";
import { buildDownstreamTrees, buildImpactPaths, candidatesOf, DEFAULT_DEPTH, DEFAULT_MAX_NODES, MAX_DEPTH, MAX_MAX_NODES, resolveFocusId, resolveQueryNodes } from "./query.ts";
import {
  buildDeterministicExplain,
  buildExplainBundle,
  collectReachable,
  countInferredEdges,
  countKind,
  countTreeNodes,
  matchBusinessReference,
  resolveSingleStart,
  treeFirstLevelSteps,
} from "./explain.ts";
import type {
  BuildOptions,
  CleanupApplyResult,
  CleanupPlan,
  DiagnosticsResult,
  EmbeddingMode,
  ExplainContextBundle,
  ExplainDeterministicResult,
  ExplainPrepareBatchResult,
  IciBuildResult,
  IciEdge,
  IciErrorCode,
  IciManifest,
  IciNode,
  ProgressCallback,
  QueryApiInput,
  QueryApiResult,
  QueryImpactInput,
  QueryImpactResult,
  Result,
  SearchIndexInput,
  SearchIndexResult,
  SearchInput,
  SearchResult,
  SearchRow,
  ExplainPrepareTaskResult,
  ExplainTaskSelector,
} from "./types.ts";
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

function ok<T>(value: T): Result<T> { return { ok: true, value }; }
function err(code: IciErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

interface CatalogEntry { name: string; type: string; sourcePath?: string; metadata?: Record<string, unknown> }
type CatalogResult = { ok: boolean; value?: { entries: CatalogEntry[]; counts: Record<string, number>; truncated: boolean }; error?: { code?: unknown; message?: string } };

interface ApiSearchDocLike {
    apiId: string;
    apiName: string;
    sourceHash: string;
    technicalText: string;
    businessText: string;
    technicalEvidence: string;
    businessEvidence: string;
    textHash: string;
  }

  interface GraphView {
  nodes: Map<string, IciNode>;
  edges: IciEdge[];
  manifest: IciManifest;
}

export { ICI_ENGINE_VERSION } from "./engine-version.ts";

const LOCAL_STOPWORDS = new Set(["the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "with", "which", "what", "can", "is", "are", "does", "do", "api", "apis", "how", "that", "this", "by", "at", "from"]);
/** Query terms for the offline scorer: lowercase word-ish tokens, stopwords and 1-char noise removed. */
function localQueryTerms(query: string): string[] {
  const terms = String(query ?? "").toLowerCase().split(/[^a-z0-9_.]+/).filter(term => term.length >= 2 && !LOCAL_STOPWORDS.has(term));
  return [...new Set(terms)].slice(0, 16);
}
function countOccurrences(text: string, term: string): number { if (term === "" || text === "") return 0; let count = 0; let index = text.indexOf(term); while (index !== -1) { count++; index = text.indexOf(term, index + term.length); } return count; }
/** Short, honest evidence line: which mode text matched and how many query terms it contained. */
function localEvidence(doc: SearchDocLike, terms: readonly string[], mode: EmbeddingMode): string {
  const fields = mode === "technical" ? ["technical"] : mode === "business" ? ["business"] : ["technical", "business"];
  const matched = fields.filter(field => { const text = String((field === "technical" ? doc.technicalText : doc.businessText) ?? "").toLowerCase(); return terms.some(term => text.includes(term)); });
  return matched.length === 0 ? "name-match" : `${matched.join("+")}-term-match`;
}

export class IciEngineService extends Service {
  static inject = ["workspaceBinding", "icomposerCatalog", "imoAuth", "jobs"] as const;
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #engineVersion = ICI_ENGINE_VERSION;
  readonly #timeoutMs: number;

  readonly #embeddingUrl: string | undefined;
  constructor(ctx: Context, config: { timeoutMs?: number; embeddingUrl?: string } = {}) {
    super(ctx, "iciEngine");
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    this.#embeddingUrl = typeof config.embeddingUrl === "string" && /^https:\/\//.test(config.embeddingUrl) ? config.embeddingUrl : undefined;
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
      explainContext: (input: { readonly workspaceId: string; readonly query: string }, options?: BuildOptions | AbortSignal) => self.explainContext(input, options),
      explainPrepare: (input: { readonly workspaceId: string; readonly query: string }, options?: BuildOptions | AbortSignal) => self.explainPrepare(input, options),
      explainPrepareBatch: (input: { readonly workspaceId: string; readonly queries: readonly string[]; readonly maxConcurrent?: number }, options?: BuildOptions | AbortSignal) => self.explainPrepareBatch(input, options),
      explainPrepareTask: (input: { readonly workspaceId: string; readonly selector: ExplainTaskSelector; readonly maxConcurrent?: number }, options?: BuildOptions | AbortSignal) => self.explainPrepareTask(input, options),
      explainBlockedTargets: (input: { readonly workspaceId: string; readonly selector: ExplainTaskSelector }) => self.explainBlockedTargets(input),
      explainSource: (input: { readonly workspaceId: string; readonly prepareArtifactPath: string; readonly nodeIds: readonly string[]; readonly referencePaths: readonly string[] }, options?: BuildOptions | AbortSignal) => self.explainSource(input, options),
      explainFinalize: (input: Parameters<IciEngineService["explainFinalize"]>[0], options?: BuildOptions | AbortSignal) => self.explainFinalize(input, options),
      explainDeterministic: (input: { readonly workspaceId: string; readonly query: string }, options?: BuildOptions | AbortSignal) => self.explainDeterministic(input, options),
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
      const binding = await this.workspaceEntry(input.workspaceId);
      if (!binding.ok) return binding as Result<never>;
      const { canonicalPath } = binding.value;
      const catalogRes = await this.listCatalog(input.workspaceId, signal);
      if (!catalogRes.ok) return catalogRes as Result<never>;
      const entries = catalogRes.value!.entries;
      const complete = await this.listSourcesComplete(input.workspaceId);
      // Same-named assets at different paths are two assets: the build refuses instead of
      // producing a graph that silently dropped or merged one of them.
      if (complete.duplicateNames.length > 0) {
        const shown = complete.duplicateNames.slice(0, 10).join(", ");
        const suffix = complete.duplicateNames.length > 10 ? ` … (+${complete.duplicateNames.length - 10} more)` : "";
        return err("ambiguous-target", `same asset names exist at several source paths: ${shown}${suffix}; rename or remove the duplicates before building the graph`);
      }
      const known = new Set(entries.map(entry => `${entry.type}:${entry.name}`));
      const additions = complete.entries.filter(entry => !known.has(`${entry.type}:${entry.name}`));
      const normalized = [
        ...entries.map(e => ({
          name: e.name,
          type: e.type,
          sourcePath: (e as { sourcePath?: string }).sourcePath,
          metadata: (e as { metadata?: Record<string, unknown> }).metadata,
        })),
        ...additions.map(entry => ({ name: entry.name, type: entry.type, sourcePath: entry.sourcePath, metadata: undefined as Record<string, unknown> | undefined })),
      ];
      try {
        const { nodes, edges, sourceFingerprint } = await buildGraph(canonicalPath, normalized, onProgress, signal);
        if (signal?.aborted) return err("cancelled");
        const base = graphBaseDir(canonicalPath, input.workspaceId);
        const manifest: IciManifest = {
          schemaVersion: 1,
          audit: auditGraph(nodes, edges),
          graphDigest: computeGraphDigest({ nodes: new Map(nodes.map(n => [n.id, n])), edges, manifest: {} as IciManifest }),
          engineVersion: this.#engineVersion,
          sourceFingerprint,
          builtAt: new Date().toISOString(),
          nodeCount: nodes.length,
          edgeCount: edges.length,
          workspaceId: input.workspaceId,
        };
        await writeAtomic(base, manifest, nodes as unknown[], edges as unknown[], { signal });
        return { ok: true, value: { artifactPath: GRAPH_ARTIFACT_RELATIVE_PATH, manifest, nodes, edges } };
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

  /**
   * TASK-111: complete, path-identified api/function listing. `listAssets` keeps its
   * 5000-item display bound; the graph must not inherit it, and two same-named assets at
   * different paths are two assets — reported, never merged.
   */
  private async listSourcesComplete(workspaceId: string): Promise<{ entries: Array<{ name: string; type: string; sourcePath?: string }>; duplicateNames: string[] }> {
    const catalog = this.ctx.get("icomposerCatalog" as never) as unknown as {
      listSourcesComplete?: (input: { workspaceId: string }) => Promise<{ ok: boolean; value?: { entries: readonly { name: string; type: string; sourcePath: string }[]; duplicateNames: readonly string[] } }>;
    } | undefined;
    if (catalog?.listSourcesComplete === undefined) return { entries: [], duplicateNames: [] };
    try {
      const res = await catalog.listSourcesComplete({ workspaceId });
      if (!res.ok || res.value === undefined) return { entries: [], duplicateNames: [] };
      return { entries: res.value.entries.map(entry => ({ name: entry.name, type: entry.type, sourcePath: entry.sourcePath })), duplicateNames: [...res.value.duplicateNames] };
    } catch { return { entries: [], duplicateNames: [] }; }
  }
  /**
   * TASK-111: the exact entry set the graph is built from — the capped catalog listing
   * PLUS every api/function source the complete enumeration found. The staleness check
   * must fingerprint this same set, otherwise a workspace beyond the catalog display
   * bound would look stale forever.
   */
  private async graphEntries(workspaceId: string): Promise<Array<{ name: string; type: string; sourcePath?: string; metadata?: Record<string, unknown> }>> {
    const catalogRes = await this.listCatalog(workspaceId);
    const entries = catalogRes.ok ? catalogRes.value?.entries ?? [] : [];
    const complete = await this.listSourcesComplete(workspaceId);
    const known = new Set(entries.map(entry => `${entry.type}:${entry.name}`));
    return [
      ...entries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as { sourcePath?: string }).sourcePath, metadata: (e as { metadata?: Record<string, unknown> }).metadata })),
      ...complete.entries.filter(entry => !known.has(`${entry.type}:${entry.name}`)).map(entry => ({ name: entry.name, type: entry.type, sourcePath: entry.sourcePath })),
    ];
  }
  private async listCatalog(workspaceId: string, signal?: AbortSignal): Promise<Result<CatalogResult["value"]>> {
    const catalog = this.ctx.get("icomposerCatalog" as never) as unknown as {
      listAssets(input: { workspaceId: string }, signal?: AbortSignal): Promise<CatalogResult>;
    } | undefined;
    if (!catalog) return err("storage-error");
    const res = await catalog.listAssets({ workspaceId }, signal);
    if (!res.ok) {
      const raw = (res.error as { code?: unknown } | undefined)?.code;
      const code = typeof raw === "string" ? (raw as IciErrorCode) : undefined;
      if (code === "workspace-not-found") return err("workspace-not-found", "workspace does not exist");
      if (code && PASSTHROUGH_CODES.has(code)) return err(code);
      if (code === "workspace-not-bound") return err("workspace-not-bound");
      return err("storage-error");
    }
    return { ok: true, value: res.value };
  }

  /** Shared gate + snapshot load + staleness detection for query/search faces. */
  private async loadQueryContext(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; graph: GraphView; canonicalPath: string; stale?: true } | { ok: false; result: Result<never> }> {
    if (this.#disposed) return { ok: false, result: err("service-disposed") };
    if (signal?.aborted) return { ok: false, result: err("cancelled") };
    if (typeof workspaceId !== "string" || !workspaceId) return { ok: false, result: err("invalid-workspace-id") };
    const binding = await this.workspaceEntry(workspaceId);
    if (!binding.ok) return { ok: false, result: binding as Result<never> };
    const { canonicalPath } = binding.value;
    const base = graphBaseDir(canonicalPath, workspaceId);
    const snapshot = await loadSnapshot(base, legacyGraphBaseDir(canonicalPath, workspaceId));
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
    let stale: true | undefined = snapshot.manifest.engineVersion !== this.#engineVersion ? true : undefined;
    try {
      const entries = (await this.graphEntries(workspaceId)).map(e => ({ name: e.name, type: e.type, sourcePath: e.sourcePath }));
      const sources = await collectSources(canonicalPath, entries, signal);
      if (fingerprintSources(sources.values()) !== snapshot.manifest.sourceFingerprint) stale = true;
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

  // ---- semantic search ----

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
      const docs = await loadSearchDocs(canonicalPath, graph);
      const cachePath = join(graphBaseDir(canonicalPath, input.workspaceId), "search", "api_embeddings.jsonl");
      const profile = await resolveActiveProfileAuth(this.ctx, signal, input.workspaceId);
      if (!profile.ok) return profile as Result<never>;
      const outcome = await embeddingLease({ auth: this.ctx.get("imoAuth" as never), profile: profile.value, workspaceId: input.workspaceId, subprocess: this.ctx.subprocess, timeoutMs: this.#timeoutMs, signal }, async (rt, token) =>
        indexEmbeddings({ rt, token, cachePath, docs, rebuild: input.rebuild === true, timeoutMs: this.#timeoutMs, signal, embeddingUrl: this.#embeddingUrl }));
      if (!(outcome as { ok: boolean }).ok) {
        const failure = outcome as unknown as { ok: false; error: { code: IciErrorCode; message: string } };
        return { ok: false, error: failure.error };
      }
      const value = (outcome as unknown as { ok: true; value: { total: number; embedded: number; reused: number } }).value;
      const result: SearchIndexResult = {
        artifactPath: SEARCH_ARTIFACT_RELATIVE_PATH,
        workspaceId: input.workspaceId,
        total: value.total,
        embedded: value.embedded,
        reused: value.reused,
        ...(stale ? { stale } : {}),
      };
      return { ok: true, value: result };
    });
  }

  /**
   * TASK-132: an offline, dependency-free ranking used when the embedding path is unavailable (no
   * Active Profile, no network, no embedding endpoint). It scores the SAME explanation docs the
   * embedding index is built from -- term frequency over the technical/business text plus an API-name
   * match bonus -- and marks the result `degraded` so callers can present it as best-effort rather
   * than embedding-ranked. It writes nothing and needs no profile.
   */
  async #localSearch(input: SearchInput, graph: GraphView, canonicalPath: string, mode: EmbeddingMode, top: number, reason: string): Promise<SearchResult> {
    let docs: readonly SearchDocLike[] = [];
    try { docs = await loadSearchDocs(canonicalPath, graph); } catch { docs = []; }
    const terms = localQueryTerms(input.query);
    const rows: SearchRow[] = [];
    for (const doc of docs) {
      const technical = typeof doc.technicalText === "string" ? doc.technicalText.toLowerCase() : "";
      const business = typeof doc.businessText === "string" ? doc.businessText.toLowerCase() : "";
      const name = String(doc.apiName ?? "").toLowerCase();
      const text = mode === "technical" ? technical : mode === "business" ? business : `${technical}\n${business}`;
      let score = 0;
      for (const term of terms) { const hits = countOccurrences(text, term); if (hits > 0) score += 1 + Math.log(1 + hits); if (name.includes(term)) score += 2; }
      if (terms.length === 0) score = name === input.query.trim().toLowerCase() ? 1 : 0;
      if (score <= 0) continue;
      rows.push({ apiId: doc.apiId, apiName: doc.apiName, score: Number((score / (terms.length || 1)).toFixed(6)), evidence: localEvidence(doc, terms, mode), downstream: [] });
    }
    rows.sort((a, b) => b.score - a.score || a.apiName.localeCompare(b.apiName));
    const limited = rows.slice(0, top);
    const best = limited[0]?.score ?? 0;
    if (best > 0) for (const row of limited) (row as { score: number }).score = Number((row.score / best).toFixed(6));
    return { workspaceId: input.workspaceId, rows: limited, truncated: rows.length > limited.length, degraded: true, degradedReason: reason };
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
      const cachePath = await searchCachePath(canonicalPath, input.workspaceId);
      const mode: EmbeddingMode = input.mode ?? "all";
      const top = clampInt(input.top, 10, 1, 50);
      // TASK-132: every dependency failure below degrades to the local scorer instead of failing closed.
      const profile = await resolveActiveProfileAuth(this.ctx, signal, input.workspaceId);
      if (!profile.ok) return ok(await this.#localSearch(input, graph, canonicalPath, mode, top, `no-profile:${profile.error.code}`));
      const outcome = await embeddingLease({ auth: this.ctx.get("imoAuth" as never), profile: profile.value, workspaceId: input.workspaceId, subprocess: this.ctx.subprocess, timeoutMs: this.#timeoutMs, signal }, async (rt, token) =>
        searchEmbeddings({ rt, token, cachePath, query: input.query, mode, top, graph, timeoutMs: this.#timeoutMs, signal, embeddingUrl: this.#embeddingUrl }));
      if (!(outcome as { ok: boolean }).ok) {
        const failure = outcome as unknown as { ok: false; error: { code: IciErrorCode; message: string } };
        // A missing/corrupt index or an unreachable embedding endpoint is a capability gap, not an error.
        return ok(await this.#localSearch(input, graph, canonicalPath, mode, top, `embedding-unavailable:${failure.error.code}`));
      }
      const value = (outcome as unknown as { ok: true; value: SearchResult }).value;
      return { ok: true, value: { ...value, workspaceId: input.workspaceId, ...(stale ? { stale } : {}) } };
    });
  }

  async diagnostics(input: { readonly workspaceId: string }): Promise<Result<DiagnosticsResult>> {
    if (this.#disposed) return err("service-disposed");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    const binding = await this.workspaceEntry(input.workspaceId);
    if (!binding.ok) return binding as Result<never>;
    const { canonicalPath } = binding.value;
    const newBase = graphBaseDir(canonicalPath, input.workspaceId);
    const legacyBase = legacyGraphBaseDir(canonicalPath, input.workspaceId);
    const newManifest = await readManifest(newBase);
    const workspaceDir = join(newManifest === null ? legacyBase : newBase, "..");
    const fallbackWorkspaceDir = join(newManifest === null ? newBase : legacyBase, "..");
    const facts = await collectFileFacts({ workspaceDir, fallbackWorkspaceDir, searchWorkspaceDirs: [join(newBase, ".."), join(legacyBase, "..")] });
    let isStale = false;
    if (facts.manifest !== null) {
      try {
        const parsed = JSON.parse(facts.manifest) as { engineVersion?: string; sourceFingerprint?: string };
        if (parsed.engineVersion !== this.#engineVersion) isStale = true;
        const catalogRes = await this.listCatalog(input.workspaceId);
        if (catalogRes.ok && typeof parsed.sourceFingerprint === "string") {
          const entries = catalogRes.value!.entries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as { sourcePath?: string }).sourcePath }));
          const sources = await collectSources(canonicalPath, entries);
          if (fingerprintSources(sources.values()) !== parsed.sourceFingerprint) isStale = true;
        }
      } catch { /* best-effort */ }
    }
    return {
      ok: true,
      value: buildDiagnosticsView(workspaceDir, input.workspaceId, this.#engineVersion, facts.manifest, isStale, facts) as unknown as DiagnosticsResult,
    };
  }

  async cleanupPlan(input: { readonly workspaceId: string }): Promise<Result<CleanupPlan>> {
    if (this.#disposed) return err("service-disposed");
    if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
    const binding = await this.workspaceEntry(input.workspaceId);
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
    const binding = await this.workspaceEntry(input.workspaceId);
    if (!binding.ok) return binding as Result<never>;
    const { canonicalPath } = binding.value;
    const workspaceDir = join(graphBaseDir(canonicalPath, input.workspaceId), "..");
    const { removed, skipped } = await applyCleanup(workspaceDir, input.expectedPaths);
    return { ok: true, value: { workspaceId: input.workspaceId, removed, skipped } };
  }

  private async loadExplainBase(
    workspaceId: string,
    query: string,
  ): Promise<{ ok: true; graph: GraphView; canonicalPath: string; start: IciNode; stale?: true } | { ok: false; result: Result<never> }> {
    const ctxLoad = await this.loadQueryContext(workspaceId);
    if (!ctxLoad.ok) return { ok: false, result: ctxLoad.result };
    const { graph, canonicalPath, stale } = ctxLoad;
    const start = resolveSingleStart(graph.nodes.values(), query);
    if (!start.ok) {
      // TASK-119: an api target is resolved by exact name; a missing/ambiguous one is
      // reported with the candidate list (and never abbreviated into a longer name).
      const label = start.reason === "ambiguous" ? "no exact api name matched (a substring is not enough); use the full API name" : "no api matched";
      const code = start.reason === "ambiguous" ? "ambiguous-target" : "no-match";
      return { ok: false, result: err(code, `${label}: ${query}; candidates: ${start.candidates.join(", ") || "none"}`) };
    }
    return { ok: true, graph, canonicalPath, start: start.node, ...(stale ? { stale: true } : {}) };
  }

  private async listRefDocNames(canonicalPath: string): Promise<string[]> {
    try {
      const names = await readdir(join(canonicalPath, "ref_doc"));
      return names.filter(n => n.endsWith(".md")).map(n => n.slice(0, -3)).sort();
    } catch {
      return [];
    }
  }
  async explainContext(input: { readonly workspaceId: string; readonly query: string }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainContextBundle>> {
    return runExplainContext({ disposed: () => this.#disposed, loadBase: async (workspaceId, query) => { const result = await this.loadExplainBase(workspaceId, query); return result.ok ? { ok: true as const, value: result } : result.result; }, listRefDocNames: path => this.listRefDocNames(path) }, input, options);
  }
  private nativeExplainDeps(): NativeExplainDeps {
    return {
      disposed: () => this.#disposed,
      loadBase: async (workspaceId, query) => { const result = await this.loadExplainBase(workspaceId, query); return result.ok ? { ok: true as const, value: result } : result.result; },
      refs: path => this.listRefDocNames(path),
      catalog: async (workspaceId: string) => {
        const catalog = this.ctx.get("icomposerCatalog" as never) as unknown as { listSourcesComplete?: (input: { workspaceId: string }) => Promise<{ ok: boolean; value?: { entries: readonly { name: string; type: string; tenant: string; group: string; sourcePath: string }[]; duplicateNames: readonly string[] }; error?: { code?: unknown; message?: string } }> } | undefined;
        if (catalog?.listSourcesComplete === undefined) return err("storage-error", "catalog source listing is unavailable");
        const res = await catalog.listSourcesComplete({ workspaceId });
        if (!res.ok || res.value === undefined) { const raw = res.error?.code; const code = typeof raw === "string" ? (raw as IciErrorCode) : undefined; return err(code && PASSTHROUGH_CODES.has(code) ? code : "storage-error", res.error?.message ?? "catalog listing failed"); }
        return { ok: true as const, value: { entries: res.value.entries, duplicateNames: res.value.duplicateNames } };
      },
      current: async id => { const result = await this.loadQueryContext(id); if (!result.ok) return result.result; return { ok: true as const, value: { canonicalPath: result.canonicalPath, sourceFingerprint: result.graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(result.graph), engineVersion: result.graph.manifest.engineVersion } }; },
    };
  }
  async explainPrepare(input: { readonly workspaceId: string; readonly query: string }, options?: BuildOptions | AbortSignal): Promise<Result<import("./types.ts").ExplainPrepareResult>> { return runPrepare(this.nativeExplainDeps(), input, options); }
  async explainPrepareBatch(input: { readonly workspaceId: string; readonly queries: readonly string[]; readonly maxConcurrent?: number }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainPrepareBatchResult>> { return runPrepareBatch(this.nativeExplainDeps(), input, options); }
  /** TASK-116: read-only legacy blockers of a selector, re-resolved against the current catalog/graph. */
  async explainBlockedTargets(input: { readonly workspaceId: string; readonly selector: ExplainTaskSelector }): Promise<Result<{ readonly blockers: readonly import("./types.ts").BlockedExplainTarget[]; readonly memberConflicts: number; readonly targets: number; readonly unresolved: number; readonly root: string }>> { return runBlockedTargets(this.nativeExplainDeps(), input); }
  /** TASK-111: one task entry point — `query`/`queries`/`group`/`all` all resolve host-side into ONE task record. */
  async explainPrepareTask(input: { readonly workspaceId: string; readonly selector: ExplainTaskSelector; readonly maxConcurrent?: number }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainPrepareTaskResult>> { return runPrepareTask(this.nativeExplainDeps(), input, options); }
  async explainSource(input: { readonly workspaceId: string; readonly prepareArtifactPath: string; readonly nodeIds: readonly string[]; readonly referencePaths: readonly string[] }, options?: BuildOptions | AbortSignal): Promise<Result<import("./types.ts").ExplainSourceResult>> { return runSource(this.nativeExplainDeps(), input, options); }
  async explainFinalize(input: { readonly workspaceId: string; readonly prepareArtifactPath: string; readonly analysis: { readonly api: { technical: string; business: string; flow: readonly string[]; evidence: readonly string[] } } }, options?: BuildOptions | AbortSignal): Promise<Result<import("./types.ts").ExplainFinalizeResult>> { return runFinalize(this.nativeExplainDeps(), input, options); }

  async explainDeterministic(input: { readonly workspaceId: string; readonly query: string }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainDeterministicResult>> {
    return runExplainDeterministic({ disposed: () => this.#disposed, loadBase: async (workspaceId, query) => { const result = await this.loadExplainBase(workspaceId, query); return result.ok ? { ok: true as const, value: result } : result.result; }, listRefDocNames: path => this.listRefDocNames(path) }, input, options);
  }

  private async workspaceEntry(
    workspaceId: string): Promise<Result<{ canonicalPath: string; workspaceId: string }>> {
    const svc = this.ctx.get("workspaceBinding" as never) as unknown as {
      get(id: string): Promise<{ ok: boolean; value?: { canonicalPath: string; workspaceId: string }; error?: { code?: unknown } }>;
    } | undefined;
    if (!svc) return err("storage-error");
    const res = await svc.get(workspaceId);
    if (!res.ok) {
      const raw = (res.error as { code?: unknown } | undefined)?.code;
      const code = typeof raw === "string" ? (raw as IciErrorCode) : undefined;
      if (code === "workspace-not-found" || raw === "not-found" || raw === "workspace-not-bound") return err("workspace-not-found", "workspace does not exist");
      if (code && code !== "workspace-not-bound" && PASSTHROUGH_CODES.has(code)) return err(code);
      return err("storage-error");
    }
    const v = res.value!;
    return { ok: true, value: { canonicalPath: v.canonicalPath, workspaceId: v.workspaceId } };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => undefined, () => undefined);
    return p;
  }
}
