import type { BuildOptions, ExplainFinalizeResult, ExplainPrepareBatchResult, ExplainPrepareResult, ExplainPrepareTaskResult, ExplainSourceResult, ExplainTaskSelector, IciErrorCode, IciNode, Result } from "./types.ts";
import type { LoadedGraph } from "./query.ts";
import { computeGraphDigest, createJobRecord, findActiveJobByApiId, finalizeExplain, loadPrepare, newBatchId, newJobId, prepareExplain, readPreparedSources, removeJobRecord, updateJobRecord, writeBatchRecord, NONE_REFERENCE_TARGET, type ExplainJobRecord } from "./explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "./engine-version.ts";
import { EXPLAIN_DEFAULT_CONCURRENCY, EXPLAIN_MAX_CONCURRENCY, EXPLAIN_MIN_CONCURRENCY } from "./explain-config.ts";

type Base = { readonly graph: LoadedGraph; readonly canonicalPath: string; readonly start: IciNode; readonly stale?: true };
/** TASK-111: complete, path-identified api listing used to resolve a task selector (never name-merged). */
export interface TargetListing { readonly entries: readonly { readonly name: string; readonly type: string; readonly tenant: string; readonly group: string; readonly sourcePath: string }[]; readonly duplicateNames: readonly string[] }
export interface NativeExplainDeps { readonly disposed: () => boolean; readonly loadBase: (workspaceId: string, query: string) => Promise<Result<Base>>; readonly catalog?: (workspaceId: string) => Promise<Result<TargetListing>>; readonly current: (workspaceId: string) => Promise<Result<{ canonicalPath: string; sourceFingerprint: string; graphDigest: string; engineVersion: string }>>; readonly refs: (root: string) => Promise<string[]>; }
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
      const job = await createJobRecord(base.value.canonicalPath, { jobId: newJobId(), workspaceId: input.workspaceId, apiName: prepared.artifact.api.name, apiId: prepared.artifact.api.id, prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: null, model: null, docs: prepared.artifact.references.filter(ref => ref.readable).map(ref => ({ path: ref.path, sha256: ref.sha256 })), referenceTarget: NONE_REFERENCE_TARGET });
      return { ok: true, value: { ...prepared.artifact, manifest: { ...prepared.artifact.manifest, engineVersion: ICI_ENGINE_VERSION }, artifactPath: prepared.artifactPath, jobId: job.jobId, jobStatus: "awaiting-input" as const } };
    });
  } catch (cause) { const stale = cause instanceof Error && cause.message === "stale-snapshot"; return o.signal?.aborted ? err("cancelled") : stale ? err("stale-snapshot", "stale-snapshot: run ici_build to refresh the ICI graph before explaining") : err("storage-error"); }
}

/**
 * TASK-111: prepare every target of one task as ONE durable, single-confirmation
 * task card. The former 2-10 window is gone: the caller passes all targets of the
 * task, duplicates are reported instead of silently shrinking the list, and the
 * task-level concurrency travels with the task record.
 */
export async function runPrepareBatch(deps: NativeExplainDeps, input: { workspaceId: string; queries: readonly string[]; maxConcurrent?: number; selector?: { readonly kind: "api" | "queries" | "group" | "all"; readonly label?: string } }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainPrepareBatchResult>> {
  const o = opts(options);
  if (deps.disposed()) return err("service-disposed");
  if (o.signal?.aborted) return err("cancelled");
  if (typeof input?.workspaceId !== "string" || !input.workspaceId || !Array.isArray(input.queries) || input.queries.length < 1 || input.queries.some(query => typeof query !== "string" || query.length > 512 || !query.trim())) return err("invalid-workspace-id", "queries must contain at least one non-empty API query");
  if (input.maxConcurrent !== undefined && (!Number.isInteger(input.maxConcurrent) || input.maxConcurrent < EXPLAIN_MIN_CONCURRENCY || input.maxConcurrent > EXPLAIN_MAX_CONCURRENCY)) return err("invalid-workspace-id", `concurrency must be an integer from ${EXPLAIN_MIN_CONCURRENCY} to ${EXPLAIN_MAX_CONCURRENCY}`);
  const requestedCount = input.queries.length;
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
      const batchId = newBatchId();
      try {
        const refs = await deps.refs(root);
        for (const base of bases) {
          if (o.signal?.aborted) throw new DOMException("aborted", "AbortError");
          if (seen.has(base.start.id)) continue;
          seen.add(base.start.id);
          // TASK-111: a task never adopts a job another task owns. Two tasks would
          // otherwise share one mutable record (batch attribution, concurrency, and
          // plan all couple), so an already-active API is an explicit conflict.
          const existing = await findActiveJobByApiId(root, input.workspaceId, base.start.id);
          if (existing) throw new Error(`job-active: ${base.start.name}`);
          const prepared = await prepareExplain(root, input.workspaceId, base.graph, base.start, refs, o.signal);
          if (prepared.artifact.manifest.engineVersion !== ICI_ENGINE_VERSION) throw new Error("stale-snapshot");
          const job = await createJobRecord(root, { jobId: newJobId(), batchId, workspaceId: input.workspaceId, apiName: prepared.artifact.api.name, apiId: prepared.artifact.api.id, prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: null, model: null, docs: prepared.artifact.references.filter(ref => ref.readable).map(ref => ({ path: ref.path, sha256: ref.sha256 })), referenceTarget: NONE_REFERENCE_TARGET });
          created.push(job);
          rows.push({ apiId: job.apiId, apiName: job.apiName, jobId: job.jobId, artifactPath: prepared.artifactPath, jobStatus: "awaiting-input", chainNodes: prepared.artifact.callChain.nodes.length, chainEdges: prepared.artifact.callChain.edges.length, truncated: prepared.artifact.callChain.truncated === true, reused: false });
        }
        const duplicates = requestedCount - rows.length;
        await writeBatchRecord(root, { schemaVersion: 1, kind: "explain-batch", batchId, workspaceId: input.workspaceId, jobIds: rows.map(row => row.jobId), maxConcurrent: input.maxConcurrent ?? EXPLAIN_DEFAULT_CONCURRENCY, requestedCount, ...(input.selector === undefined ? {} : { selector: input.selector }), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, o.signal);
        return { ok: true, value: { batchId, workspaceId: input.workspaceId, jobs: rows, requestedCount, duplicates } };
      } catch (cause) {
        // TASK-111: a failed task creation must not leave undisclosed partial work.
        // Only the records this call created are removed (a reused record is never
        // touched, and a shared prepare artifact is left as an inert cache).
        for (const job of created) await removeJobRecord(root, job.jobId).catch(() => undefined);
        throw cause;
      }
    });
  } catch (cause) {
    if (o.signal?.aborted) return err("cancelled");
    if (cause instanceof Error && cause.message === "stale-snapshot") return err("stale-snapshot", "stale-snapshot: run ici_build to refresh the ICI graph before explaining");
    if (cause instanceof Error && cause.message.startsWith("job-active")) return err("job-active", `${cause.message}; finish or cancel that job before starting a new task`);
    return err("storage-error");
  }
}

/**
 * TASK-111: resolve one task selector to its COMPLETE target list host-side, so
 * the caller never enumerates targets and never splits a task into several cards.
 * A same-name collision is two different assets and is refused with bounded
 * candidates instead of being merged; an empty resolution is refused as well.
 */
export async function resolveTaskTargets(deps: NativeExplainDeps, workspaceId: string, selector: ExplainTaskSelector): Promise<{ ok: true; names: string[]; label?: string } | { ok: false; code: IciErrorCode; message: string }> {
  if (selector.kind === "api") {
    const name = selector.query;
    if (deps.catalog === undefined) return { ok: true, names: [name], label: name };
    const listing = await deps.catalog(workspaceId); if (!listing.ok) return { ok: false, code: listing.error.code, message: listing.error.message };
    const paths = listing.value.entries.filter(entry => entry.type === "api" && entry.name === name).map(entry => entry.sourcePath);
    if (paths.length > 1) return { ok: false, code: "ambiguous-target", message: `api name ${name} exists at ${paths.length} source paths: ${boundedCandidates(paths)}` };
    return { ok: true, names: [name], label: name };
  }
  if (selector.kind === "queries") {
    const names = [...selector.queries];
    if (names.length === 0) return { ok: false, code: "no-targets", message: "no API targets were given" };
    if (deps.catalog === undefined) return { ok: true, names };
    const listing = await deps.catalog(workspaceId); if (!listing.ok) return { ok: false, code: listing.error.code, message: listing.error.message };
    const collisions = names.filter(name => listing.value.entries.filter(entry => entry.type === "api" && entry.name === name).length > 1);
    if (collisions.length > 0) return { ok: false, code: "ambiguous-target", message: `api names exist at several source paths: ${boundedCandidates([...new Set(collisions)])}` };
    return { ok: true, names };
  }
  if (deps.catalog === undefined) return { ok: false, code: "storage-error", message: "catalog listing is unavailable" };
  const listing = await deps.catalog(workspaceId); if (!listing.ok) return { ok: false, code: listing.error.code, message: listing.error.message };
  const apis = listing.value.entries.filter(entry => entry.type === "api");
  if (selector.kind === "all") {
    if (apis.length === 0) return { ok: false, code: "no-targets", message: "this workspace has no API target" };
    const collisions = [...new Set(apis.map(entry => entry.name))].filter(name => apis.filter(entry => entry.name === name).length > 1);
    if (collisions.length > 0) return { ok: false, code: "ambiguous-target", message: `all cannot be resolved: same-named APIs exist at several source paths: ${boundedCandidates(collisions)}` };
    return { ok: true, names: apis.map(entry => entry.name).sort(), label: "all" };
  }
  const wanted = selector.group;
  const matched = apis.filter(entry => entry.group.toLowerCase() === wanted.toLowerCase());
  const tenants = [...new Set(matched.map(entry => entry.tenant))].sort();
  if (tenants.length > 1) return { ok: false, code: "ambiguous-target", message: `group ${wanted} exists in several tenants: ${boundedCandidates(tenants)}` };
  if (matched.length === 0) {
    const groups = [...new Set(apis.map(entry => entry.group))].sort();
    const similar = groups.filter(group => group.toLowerCase().includes(wanted.toLowerCase()));
    return { ok: false, code: "group-not-found", message: `no group named ${wanted}; candidates: ${boundedCandidates(similar) || "none"}` };
  }
  const collisions = [...new Set(matched.map(entry => entry.name))].filter(name => matched.filter(entry => entry.name === name).length > 1);
  if (collisions.length > 0) return { ok: false, code: "ambiguous-target", message: `group ${wanted} contains same-named APIs at several source paths: ${boundedCandidates(collisions)}` };
  return { ok: true, names: matched.map(entry => entry.name).sort(), label: wanted };
}

/** Bounded candidate list for diagnostics: counts stay exact, the response never grows with the workspace. */
export function boundedCandidates(values: readonly string[], limit = 10): string { return values.length <= limit ? values.join(", ") : `${values.slice(0, limit).join(", ")} … (+${values.length - limit} more)` }

/**
 * TASK-111: the single task entry point. `query`, `queries`, `group`, and `all`
 * all produce ONE task record with the complete target set, and the task-level
 * concurrency travels with it. Legacy `explainPrepareBatch`/`explainPrepare`
 * stay available for existing records and callers.
 */
export async function runPrepareTask(deps: NativeExplainDeps, input: { workspaceId: string; selector: ExplainTaskSelector; maxConcurrent?: number }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainPrepareTaskResult>> {
  const o = opts(options);
  if (deps.disposed()) return err("service-disposed");
  if (o.signal?.aborted) return err("cancelled");
  if (typeof input?.workspaceId !== "string" || !input.workspaceId) return err("invalid-workspace-id", "workspace id is invalid");
  const resolved = await resolveTaskTargets(deps, input.workspaceId, input.selector);
  if (!resolved.ok) return err(resolved.code, resolved.message);
  if (resolved.names.length === 0) return err("no-targets", "no API targets were resolved");
  const batch = await runPrepareBatch(deps, { workspaceId: input.workspaceId, queries: resolved.names, maxConcurrent: input.maxConcurrent, selector: { kind: input.selector.kind, ...(resolved.label === undefined ? {} : { label: resolved.label }) } }, o);
  if (!batch.ok) return batch;
  return { ok: true, value: { ...batch.value, selector: { kind: input.selector.kind, ...(resolved.label === undefined ? {} : { label: resolved.label }) } } };
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
