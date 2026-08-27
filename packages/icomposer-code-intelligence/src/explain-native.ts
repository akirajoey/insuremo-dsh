import type { BuildOptions, ExplainFinalizeResult, ExplainPrepareBatchResult, ExplainPrepareResult, ExplainSourceResult, IciErrorCode, IciNode, Result } from "./types.ts";
import type { LoadedGraph } from "./query.ts";
import { computeGraphDigest, createJobRecord, findActiveJobByApiId, finalizeExplain, loadPrepare, newBatchId, newJobId, prepareExplain, readPreparedSources, updateJobRecord, writeBatchRecord, type ExplainJobRecord } from "./explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "./engine-version.ts";

type Base = { readonly graph: LoadedGraph; readonly canonicalPath: string; readonly start: IciNode; readonly stale?: true };
export interface NativeExplainDeps { readonly disposed: () => boolean; readonly loadBase: (workspaceId: string, query: string) => Promise<Result<Base>>; readonly current: (workspaceId: string) => Promise<Result<{ canonicalPath: string; sourceFingerprint: string; graphDigest: string; engineVersion: string }>>; readonly refs: (root: string) => Promise<string[]>; }
function err(code: IciErrorCode, message: string = code): Result<never> { return { ok: false, error: { code, message } }; }
function opts(options?: BuildOptions | AbortSignal): BuildOptions { return options instanceof AbortSignal ? { signal: options } : (options ?? {}); }
function validInput(input: { workspaceId: string; query: string } | undefined): boolean { return typeof input?.workspaceId === "string" && input.workspaceId.length > 0 && typeof input.query === "string" && input.query.trim().length > 0; }
const prepareTails = new Map<string, Promise<void>>();
async function withPrepareTransaction<T>(root: string, workspaceId: string, task: () => Promise<T>): Promise<T> { const key = `${root}\0${workspaceId}`; const previous = prepareTails.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>(resolve => { release = resolve; }); prepareTails.set(key, current); await previous; try { return await task(); } finally { release(); if (prepareTails.get(key) === current) prepareTails.delete(key); } }

/** Prepare-only agent operation. It never reads source contents into the result and never calls a model. */
export async function runPrepare(deps: NativeExplainDeps, input: { workspaceId: string; query: string }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainPrepareResult>> {
  const o = opts(options); if (deps.disposed()) return err("service-disposed"); if (o.signal?.aborted) return err("cancelled"); if (!validInput(input)) return err("invalid-workspace-id");
  const base = await deps.loadBase(input.workspaceId, input.query); if (!base.ok) return base; if (base.value.stale) return err("stale-snapshot", "stale-snapshot: run ici_build to refresh the ICI graph before explaining");
  try {
    return await withPrepareTransaction(base.value.canonicalPath, input.workspaceId, async () => {
      const existing = await findActiveJobByApiId(base.value.canonicalPath, input.workspaceId, base.value.start.id); if (existing) return err("job-active");
      const prepared = await prepareExplain(base.value.canonicalPath, input.workspaceId, base.value.graph, base.value.start, await deps.refs(base.value.canonicalPath), o.signal); if (prepared.artifact.manifest.engineVersion !== ICI_ENGINE_VERSION) throw new Error("stale-snapshot");
      const job = await createJobRecord(base.value.canonicalPath, { jobId: newJobId(), workspaceId: input.workspaceId, apiName: prepared.artifact.api.name, apiId: prepared.artifact.api.id, prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: null, model: null, docs: prepared.artifact.references.filter(ref => ref.readable).map(ref => ({ path: ref.path, sha256: ref.sha256 })), folderPath: "ref_doc", referenceTarget: { path: "ref_doc", kind: "directory" } });
      return { ok: true, value: { ...prepared.artifact, manifest: { ...prepared.artifact.manifest, engineVersion: ICI_ENGINE_VERSION }, artifactPath: prepared.artifactPath, jobId: job.jobId, jobStatus: "awaiting-input" as const } };
    });
  } catch (cause) { const stale = cause instanceof Error && cause.message === "stale-snapshot"; return o.signal?.aborted ? err("cancelled") : stale ? err("stale-snapshot", "stale-snapshot: run ici_build to refresh the ICI graph before explaining") : err("storage-error"); }
}

/** Prepare several API explanations as one durable, single-confirmation batch. */
export async function runPrepareBatch(deps: NativeExplainDeps, input: { workspaceId: string; queries: readonly string[] }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainPrepareBatchResult>> {
  const o = opts(options);
  if (deps.disposed()) return err("service-disposed");
  if (o.signal?.aborted) return err("cancelled");
  if (typeof input?.workspaceId !== "string" || !input.workspaceId || !Array.isArray(input.queries) || input.queries.length < 2 || input.queries.length > 10 || input.queries.some(query => typeof query !== "string" || query.length > 512 || !query.trim())) return err("invalid-workspace-id", "queries must contain 2-10 non-empty API queries");
  const bases: Base[] = [];
  for (const query of input.queries) {
    const base = await deps.loadBase(input.workspaceId, query);
    if (!base.ok) return base;
    if (base.value.stale) return err("stale-snapshot", "stale-snapshot: run ici_build to refresh the ICI graph before explaining");
    bases.push(base.value);
  }
  const root = bases[0]?.canonicalPath;
  if (!root) return err("storage-error");
  try {
    return await withPrepareTransaction(root, input.workspaceId, async () => {
      const rows: Array<ExplainPrepareBatchResult["jobs"][number]> = [];
      const created: ExplainJobRecord[] = [];
      const seen = new Set<string>();
      try {
        const refs = await deps.refs(root);
        for (const base of bases) {
          if (o.signal?.aborted) throw new DOMException("aborted", "AbortError");
          if (seen.has(base.start.id)) continue;
          seen.add(base.start.id);
          const existing = await findActiveJobByApiId(root, input.workspaceId, base.start.id);
          if (existing) {
            const prepared = await loadPrepare(root, existing.prepareArtifactPath);
            rows.push({ apiId: existing.apiId, apiName: existing.apiName, jobId: existing.jobId, artifactPath: existing.prepareArtifactPath, jobStatus: existing.status, chainNodes: prepared.callChain.nodes.length, chainEdges: prepared.callChain.edges.length, truncated: prepared.callChain.truncated === true, reused: true });
            continue;
          }
          const prepared = await prepareExplain(root, input.workspaceId, base.graph, base.start, refs, o.signal);
          if (prepared.artifact.manifest.engineVersion !== ICI_ENGINE_VERSION) throw new Error("stale-snapshot");
          const job = await createJobRecord(root, { jobId: newJobId(), workspaceId: input.workspaceId, apiName: prepared.artifact.api.name, apiId: prepared.artifact.api.id, prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: null, model: null, docs: prepared.artifact.references.filter(ref => ref.readable).map(ref => ({ path: ref.path, sha256: ref.sha256 })), folderPath: "ref_doc", referenceTarget: { path: "ref_doc", kind: "directory" } });
          created.push(job);
          rows.push({ apiId: job.apiId, apiName: job.apiName, jobId: job.jobId, artifactPath: prepared.artifactPath, jobStatus: "awaiting-input", chainNodes: prepared.artifact.callChain.nodes.length, chainEdges: prepared.artifact.callChain.edges.length, truncated: prepared.artifact.callChain.truncated === true, reused: false });
        }
        const batchId = newBatchId();
        await writeBatchRecord(root, { schemaVersion: 1, kind: "explain-batch", batchId, workspaceId: input.workspaceId, jobIds: rows.map(row => row.jobId), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, o.signal);
        return { ok: true, value: { batchId, workspaceId: input.workspaceId, jobs: rows } };
      } catch (cause) {
        for (const job of created) await updateJobRecord(root, job.jobId, job.revision, { status: "cancelled", error: "storage-error" }).catch(() => undefined);
        throw cause;
      }
    });
  } catch (cause) {
    if (o.signal?.aborted) return err("cancelled");
    if (cause instanceof Error && cause.message === "stale-snapshot") return err("stale-snapshot", "stale-snapshot: run ici_build to refresh the ICI graph before explaining");
    return err("storage-error");
  }
}


/** Internal source reader used by host maintenance and tests; it is intentionally not registered as an agent tool. */
export async function runSource(deps: NativeExplainDeps, input: { workspaceId: string; prepareArtifactPath: string; nodeIds: readonly string[]; referencePaths: readonly string[] }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainSourceResult>> {
  const o = opts(options); if (deps.disposed()) return err("service-disposed"); if (o.signal?.aborted) return err("cancelled"); const current = await deps.current(input.workspaceId); if (!current.ok) return current;
  try { return { ok: true, value: { files: await readPreparedSources(current.value.canonicalPath, input.workspaceId, input.prepareArtifactPath, input.nodeIds, input.referencePaths, o.signal) } }; }
  catch (cause) { const message = cause instanceof Error ? cause.message : ""; const code = ["source-forbidden", "source-changed", "source-range", "source-oversize"].includes(message) ? message as IciErrorCode : "storage-error"; return o.signal?.aborted ? err("cancelled") : err(code, code); }
}

/** Internal final publisher used by maintenance; output is the aggregate API contract, not per-node cache data. */
export async function runFinalize(deps: NativeExplainDeps, input: { workspaceId: string; prepareArtifactPath: string; analysis: { api: { technical: string; business: string; flow: readonly string[]; evidence: readonly string[] } } }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainFinalizeResult>> {
  const o = opts(options); if (deps.disposed()) return err("service-disposed"); if (o.signal?.aborted) return err("cancelled"); const base = await deps.current(input.workspaceId); if (!base.ok) return base; if (base.value.engineVersion !== ICI_ENGINE_VERSION) return err("stale-snapshot", "stale-snapshot: run ici_build to refresh the ICI graph before finalizing");
  try { const final = await finalizeExplain(base.value.canonicalPath, input.workspaceId, input.prepareArtifactPath, input.analysis, base.value, o.signal); return { ok: true, value: { artifactPath: final.artifactPath, schemaVersion: 3, kind: "final", generatedBy: "current-agent", verified: false, needsBusinessReview: true, sourceFingerprint: final.artifact.sourceFingerprint, graphDigest: final.artifact.graphDigest, contextHash: final.artifact.contextHash, flow: final.artifact.apiAnalysis.flow, evidence: final.artifact.apiAnalysis.evidence } }; }
  catch (cause) { const message = cause instanceof Error ? cause.message : ""; const known = new Set(["stale-snapshot", "source-changed", "folder-changed", "analysis-invalid", "prepare-invalidated", "immutable-conflict", "storage-error"]); const code = known.has(message) ? message as IciErrorCode : "storage-error"; return o.signal?.aborted ? err("cancelled") : err(code, code); }
}

export function currentGraphDigest(graph: LoadedGraph): string { return computeGraphDigest(graph); }
