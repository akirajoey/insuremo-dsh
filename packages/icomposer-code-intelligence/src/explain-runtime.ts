import type { IciNode, Result, BuildOptions, IciErrorCode } from "./types.ts";
import { buildImpactPaths, buildDownstreamTrees, type LoadedGraph } from "./query.ts";
import { buildDeterministicExplain, buildExplainBundle, type GraphViewLike } from "./explain.ts";
import { writeExplainContext, writeExplainDeterministic } from "./storage.ts";
import type { ExplainContextBundle, ExplainDeterministicResult } from "./types.ts";

const DEFAULT_DEPTH = 5;
const DEFAULT_MAX_NODES = 500;

type GraphView = LoadedGraph & GraphViewLike;
export interface ExplainBase {
  readonly graph: GraphView;
  readonly canonicalPath: string;
  readonly start: IciNode;
  readonly stale?: true;
}
export interface ExplainRuntimeDeps {
  readonly disposed: () => boolean;
  readonly loadBase: (workspaceId: string, query: string) => Promise<Result<ExplainBase>>;
  readonly listRefDocNames: (canonicalPath: string) => Promise<string[]>;
}
function err(code: IciErrorCode, message: string = code): Result<never> { return { ok: false, error: { code, message } }; }
function optsOf(options?: BuildOptions | AbortSignal): BuildOptions { return options instanceof AbortSignal ? { signal: options } : (options ?? {}); }

export async function runExplainContext(deps: ExplainRuntimeDeps, input: { workspaceId: string; query: string }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainContextBundle>> {
  const opts = optsOf(options);
  if (deps.disposed()) return err("service-disposed");
  if (opts.signal?.aborted) return err("cancelled");
  if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
  if (typeof input.query !== "string" || !input.query.trim()) return err("invalid-workspace-id", "query is required");
  const base = await deps.loadBase(input.workspaceId, input.query);
  if (!base.ok) return base;
  const { graph, canonicalPath, start, stale } = base.value;
  const { roots } = buildDownstreamTrees(graph, [start.id], DEFAULT_DEPTH, DEFAULT_MAX_NODES);
  const impactStarts = [...graph.nodes.values()].filter(n => n.kind === "function" || n.kind === "method");
  const impactAll = buildImpactPaths(graph, impactStarts.map(s => s.id));
  const refDocNames = await deps.listRefDocNames(canonicalPath);
  const bundle = buildExplainBundle({ graph, canonicalPath, start, downstreamRoot: roots[0], impactPaths: impactAll.paths.filter(p => p.hops.some(h => h.nodeId === start.id)).slice(0, 50).map(p => ({ apiId: p.apiId, hops: p.hops.map(h => ({ nodeId: h.nodeId })) })), refDocNames, ...(stale ? { stale: true as const } : {}) });
  try {
    const artifactPath = await writeExplainContext(canonicalPath, start.name, bundle, opts.signal);
    return { ok: true, value: { ...bundle, artifactPath } };
  } catch { return opts.signal?.aborted ? err("cancelled") : err("storage-error"); }
}

export async function runExplainDeterministic(deps: ExplainRuntimeDeps, input: { workspaceId: string; query: string }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainDeterministicResult>> {
  const opts = optsOf(options);
  if (deps.disposed()) return err("service-disposed");
  if (opts.signal?.aborted) return err("cancelled");
  if (!input || typeof input.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id");
  if (typeof input.query !== "string" || !input.query.trim()) return err("invalid-workspace-id", "query is required");
  const base = await deps.loadBase(input.workspaceId, input.query);
  if (!base.ok) return base;
  const { graph, canonicalPath, start, stale } = base.value;
  const { roots } = buildDownstreamTrees(graph, [start.id], DEFAULT_DEPTH, DEFAULT_MAX_NODES);
  const refDocNames = await deps.listRefDocNames(canonicalPath);
  const parts = buildDeterministicExplain({ graph, canonicalPath, start, downstreamRoot: roots[0], refDocNames, sourceFingerprint: graph.manifest.sourceFingerprint });
  const result = { generatedBy: "deterministic-v1" as const, promptVersion: "none" as const, sourceFingerprint: graph.manifest.sourceFingerprint, generatedAt: new Date().toISOString(), technical: parts.technical, business: parts.business, method: parts.method };
  try {
    const artifactPath = await writeExplainDeterministic(canonicalPath, start.name, result, opts.signal);
    return { ok: true, value: { ...result, artifactPath } };
  } catch { return opts.signal?.aborted ? err("cancelled") : err("storage-error"); }
}
