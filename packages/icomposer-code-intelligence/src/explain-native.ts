import type { BuildOptions, ExplainFinalizeResult, ExplainPrepareResult, ExplainSourceResult, IciErrorCode, IciNode, Result } from "./types.ts";
import type { LoadedGraph } from "./query.ts";
import { computeGraphDigest, createJobRecord, findWorkspaceActiveJob, finalizeExplain, newJobId, prepareExplain, readPreparedSources } from "./explain-artifacts.ts";

type Base = { readonly graph: LoadedGraph; readonly canonicalPath: string; readonly start: IciNode; readonly stale?: true };
export interface NativeExplainDeps { readonly disposed: () => boolean; readonly loadBase: (workspaceId: string, query: string) => Promise<Result<Base>>; readonly current: (workspaceId: string) => Promise<Result<{ canonicalPath: string; sourceFingerprint: string; graphDigest: string }>>; readonly refs: (root: string) => Promise<string[]>; }
function err(code: IciErrorCode, message: string = code): Result<never> { return { ok: false, error: { code, message } }; }
function opts(options?: BuildOptions | AbortSignal): BuildOptions { return options instanceof AbortSignal ? { signal: options } : (options ?? {}); }
function validInput(input: { workspaceId: string; query: string } | undefined): boolean { return typeof input?.workspaceId === "string" && input.workspaceId.length > 0 && typeof input.query === "string" && input.query.trim().length > 0; }
const prepareTails = new Map<string, Promise<void>>();
async function withPrepareTransaction<T>(root: string, workspaceId: string, task: () => Promise<T>): Promise<T> { const key = `${root}\0${workspaceId}`; const previous = prepareTails.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>(resolve => { release = resolve; }); prepareTails.set(key, current); await previous; try { return await task(); } finally { release(); if (prepareTails.get(key) === current) prepareTails.delete(key); } }

/** Prepare-only agent operation. It never reads source contents into the result and never calls a model. */
export async function runPrepare(deps: NativeExplainDeps, input: { workspaceId: string; query: string }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainPrepareResult>> {
  const o = opts(options); if (deps.disposed()) return err("service-disposed"); if (o.signal?.aborted) return err("cancelled"); if (!validInput(input)) return err("invalid-workspace-id");
  const base = await deps.loadBase(input.workspaceId, input.query); if (!base.ok) return base; if (base.value.stale) return err("stale-snapshot");
  try {
    return await withPrepareTransaction(base.value.canonicalPath, input.workspaceId, async () => {
      const existing = await findWorkspaceActiveJob(base.value.canonicalPath, input.workspaceId); if (existing) return err("job-active");
      const prepared = await prepareExplain(base.value.canonicalPath, input.workspaceId, base.value.graph, base.value.start, await deps.refs(base.value.canonicalPath), o.signal);
      const job = await createJobRecord(base.value.canonicalPath, { jobId: newJobId(), workspaceId: input.workspaceId, apiName: prepared.artifact.api.name, apiId: prepared.artifact.api.id, prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: null, model: null, docs: prepared.artifact.references.filter(ref => ref.readable).map(ref => ({ path: ref.path, sha256: ref.sha256 })), folderPath: "ref_doc" });
      return { ok: true, value: { ...prepared.artifact, artifactPath: prepared.artifactPath, jobId: job.jobId, jobStatus: "awaiting-input" as const } };
    });
  } catch { return o.signal?.aborted ? err("cancelled") : err("storage-error"); }
}

/** Internal source reader used by host maintenance and tests; it is intentionally not registered as an agent tool. */
export async function runSource(deps: NativeExplainDeps, input: { workspaceId: string; prepareArtifactPath: string; nodeIds: readonly string[]; referencePaths: readonly string[] }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainSourceResult>> {
  const o = opts(options); if (deps.disposed()) return err("service-disposed"); if (o.signal?.aborted) return err("cancelled"); const current = await deps.current(input.workspaceId); if (!current.ok) return current;
  try { return { ok: true, value: { files: await readPreparedSources(current.value.canonicalPath, input.workspaceId, input.prepareArtifactPath, input.nodeIds, input.referencePaths, o.signal) } }; }
  catch (cause) { const message = cause instanceof Error ? cause.message : ""; const code = ["source-forbidden", "source-changed", "source-range", "source-oversize"].includes(message) ? message as IciErrorCode : "storage-error"; return o.signal?.aborted ? err("cancelled") : err(code, code); }
}

/** Internal final publisher used by maintenance; output is the aggregate API contract, not per-node cache data. */
export async function runFinalize(deps: NativeExplainDeps, input: { workspaceId: string; prepareArtifactPath: string; analysis: { api: { technical: string; business: string; flow: readonly string[]; evidence: readonly string[] } } }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainFinalizeResult>> {
  const o = opts(options); if (deps.disposed()) return err("service-disposed"); if (o.signal?.aborted) return err("cancelled"); const base = await deps.current(input.workspaceId); if (!base.ok) return base;
  try { const final = await finalizeExplain(base.value.canonicalPath, input.workspaceId, input.prepareArtifactPath, input.analysis, base.value, o.signal); return { ok: true, value: { artifactPath: final.artifactPath, schemaVersion: 3, kind: "final", generatedBy: "current-agent", verified: false, needsBusinessReview: true, sourceFingerprint: final.artifact.sourceFingerprint, graphDigest: final.artifact.graphDigest, contextHash: final.artifact.contextHash, flow: final.artifact.apiAnalysis.flow, evidence: final.artifact.apiAnalysis.evidence } }; }
  catch (cause) { const message = cause instanceof Error ? cause.message : ""; const known = new Set(["stale-snapshot", "source-changed", "folder-changed", "analysis-invalid", "prepare-invalidated", "immutable-conflict", "storage-error"]); const code = known.has(message) ? message as IciErrorCode : "storage-error"; return o.signal?.aborted ? err("cancelled") : err(code, code); }
}

export function currentGraphDigest(graph: LoadedGraph): string { return computeGraphDigest(graph); }
