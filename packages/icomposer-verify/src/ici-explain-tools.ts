import type { Context } from "@deepseek-ai/cordis";
import type { DefineToolFn } from "./tool-types.ts";
interface Exec { readonly signal: AbortSignal; readonly agent?: { readonly options?: { readonly provider?: string; readonly model?: string } }; }
type ResultLike<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
interface Engine {
  explainPrepare(i: { workspaceId: string; query: string }, o: AbortSignal): Promise<ResultLike<{
    artifactPath: string; api: { id: string; name: string }; callChain: unknown; sources: readonly unknown[]; references: readonly unknown[];
    manifest: unknown; contextHash: string;
  }>>;
  explainPrepareBatch?(i: { workspaceId: string; queries: readonly string[] }, o: AbortSignal): Promise<ResultLike<{
    batchId: string; workspaceId: string; jobs: readonly { apiId: string; apiName: string; jobId: string; artifactPath: string; jobStatus: string; chainNodes: number; chainEdges: number; truncated: boolean; reused: boolean }[];
  }>>;
}
function err(code: string, message = code): Array<{ type: "text"; text: string }> { return [{ type: "text", text: `icomposer tools error: ${code}${message === code ? "" : ` — ${message}`}` }]; }
function get(ctx: Context): Engine | undefined { return ctx.get("iciEngine") as unknown as Engine | undefined; }
const obj = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: "object", additionalProperties: false, properties });
const explainErrorOutput = obj({ error: { type: "object", additionalProperties: false, properties: { code: { type: "string", required: true }, message: { type: "string" } }, required: true } });
const explainSingleOutput = obj({
  artifact_path: { type: "string", required: true }, job_id: { type: "string", required: true }, status: { type: "string", required: true },
  api_id: { type: "string" }, api_name: { type: "string" }, chain_nodes: { type: "integer" }, chain_edges: { type: "integer" }, truncated: { type: "boolean" },
  source_files: { type: "integer" }, references: { type: "integer" }, manifest: { type: "object", additionalProperties: false, properties: { source_fingerprint: { type: "string" }, graph_digest: { type: "string" } } },
  default_provider: { type: "string" }, default_model: { type: "string" },
});
const explainBatchOutput = obj({
  batch_id: { type: "string", required: true }, jobs_count: { type: "integer", required: true },
  jobs: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
    api_id: { type: "string", required: true }, api_name: { type: "string", required: true }, job_id: { type: "string", required: true }, status: { type: "string", required: true }, artifact_path: { type: "string", required: true }, chain_nodes: { type: "integer", required: true }, chain_edges: { type: "integer", required: true }, truncated: { type: "boolean" }, reused: { type: "boolean" },
  } } },
  default_provider: { type: "string" }, default_model: { type: "string" },
});

/**
 * Register the single agent-facing explain tool. TASK-051 B redesign:
 * `ici_explain` is prepare-only — it validates graph freshness and persists a
 * bounded call-chain/source-range allowlist plus a host job record
 * (`awaiting-input`). The Host ExplainScheduler performs the model analysis in
 * the idle phase after user confirmation via Workbench routes; the Agent never
 * reads sources or finalizes.
 */
export function registerIciExplainTools(ctx: Context, defineTool: DefineToolFn): Array<() => void> {
  const ds: Array<() => void> = [];
  ds.push(ctx.systemPrompt.section({ name: "tool:ici_explain", order: 150, text: "ici_explain prepares bounded source-backed explanation plans: it validates the local graph is fresh, then persists schema-3 prepare metadata (complete bounded call chains, exact source ranges with hashes, reference candidates) and awaiting-input job records under .metadata/icomposer/ici/explain/. It does not call any model, read source contents into the transcript, or mark readiness. For a group or multiple APIs, make ONE ici_explain call with the queries array (2-10 entries); never call ici_explain repeatedly once per API. The user confirms one workspace-relative reference file or directory target, model, and earliest not-before time in the Workbench batch card; the Host queues fresh restricted background Explain Agents during idle maintenance." }));
  ds.push(ctx.tools.register(defineTool({
    name: "ici_explain",
    description: "Prepare (only) a source-backed explanation plan for one API, or one batch of 2-10 APIs, in a registered workspace. Pass exactly one of query and queries. No model call and no readiness change.",
    parameters: { workspace_id: { type: "string", required: true }, query: { type: "string" }, queries: { type: "array", items: { type: "string" } } },
    output: {
      schema: { oneOf: [explainSingleOutput, explainBatchOutput, explainErrorOutput] },
      render: (_a: unknown, v: any) => v?.error ? err(v.error.code, v.error.message) : v?.batch_id ? [{ type: "text", text: `batch=${v.batch_id} jobs=${v.jobs_count}` }] : [{ type: "text", text: `prepare=${v.artifact_path} job=${v.job_id} status=${v.status}; chain=${v.chain_nodes} nodes/${v.chain_edges} edges${v.truncated ? " (truncated)" : ""}, sources=${v.source_files}, refs=${v.references}${v.default_provider && v.default_model ? ` default=${v.default_provider}/${v.default_model}` : ""}. Select a workspace-relative file or directory and confirm the explicit model in the Workbench card, then Start.` }],
    },
    isConcurrencySafe: () => true,
    async execute(raw: Record<string, unknown>, e: Exec) {
      const engine = get(ctx); if (!engine) return { error: { code: "cli-error" } };
      const workspaceId = typeof raw.workspace_id === "string" ? raw.workspace_id : "";
      const queryProvided = Object.prototype.hasOwnProperty.call(raw, "query"); const queriesProvided = Object.prototype.hasOwnProperty.call(raw, "queries"); const hasQuery = typeof raw.query === "string" && raw.query.trim().length > 0;
      if (queryProvided === queriesProvided) return { error: { code: "invalid-workspace-id", message: "pass exactly one of query or queries (2-10 non-empty strings)" } };
      if (queriesProvided) {
        const queries = Array.isArray(raw.queries) && raw.queries.length >= 2 && raw.queries.length <= 10 && raw.queries.every(query => typeof query === "string" && query.length <= 512 && query.trim().length > 0) ? raw.queries as string[] : null;
        if (!queries || !engine.explainPrepareBatch) return { error: { code: "invalid-workspace-id", message: "queries must contain 2-10 non-empty API queries" } };
        const r = await engine.explainPrepareBatch({ workspaceId, queries }, e.signal);
        if (!r.ok) return { error: { code: r.error.code, message: r.error.message } };
        const v = r.value;
        return { batch_id: v.batchId, jobs_count: v.jobs.length, jobs: v.jobs.map(job => ({ api_id: job.apiId, api_name: job.apiName, job_id: job.jobId, status: job.jobStatus, artifact_path: job.artifactPath, chain_nodes: job.chainNodes, chain_edges: job.chainEdges, truncated: job.truncated, reused: job.reused })), ...(e.agent?.options?.provider && e.agent.options.model ? { default_provider: e.agent.options.provider, default_model: e.agent.options.model } : {}) };
      }
      if (!workspaceId || !hasQuery) return { error: { code: "invalid-workspace-id", message: "query is required" } };
      const r = await engine.explainPrepare({ workspaceId, query: raw.query as string }, e.signal);
      if (!r.ok) return { error: { code: r.error.code, message: r.error.message } };
      const v = r.value as any;
      return {
        artifact_path: v.artifactPath, job_id: v.jobId, status: v.jobStatus,
        api_id: v.api.id, api_name: v.api.name,
        chain_nodes: v.callChain.nodes.length, chain_edges: v.callChain.edges.length, truncated: v.callChain.truncated === true,
        source_files: v.sources.length, references: v.references.length,
        manifest: { source_fingerprint: v.manifest.sourceFingerprint, graph_digest: v.manifest.graphDigest },
        ...(e.agent?.options?.provider && e.agent.options.model ? { default_provider: e.agent.options.provider, default_model: e.agent.options.model } : {}),
      };
    },
  })));
  return ds;
}
