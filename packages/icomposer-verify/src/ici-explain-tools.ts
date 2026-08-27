import type { Context } from "@deepseek-ai/cordis";
import type { DefineToolFn } from "./tool-types.ts";
interface Exec { readonly signal: AbortSignal; readonly agent?: { readonly options?: { readonly provider?: string; readonly model?: string } }; }
type ResultLike<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
interface Engine {
  explainPrepare(i: { workspaceId: string; query: string }, o: AbortSignal): Promise<ResultLike<{
    artifactPath: string; api: { id: string; name: string }; callChain: unknown; sources: readonly unknown[]; references: readonly unknown[];
    manifest: unknown; contextHash: string;
  }>>;
}
function err(code: string, message = code): Array<{ type: "text"; text: string }> { return [{ type: "text", text: `icomposer tools error: ${code}${message === code ? "" : ` — ${message}`}` }]; }
function get(ctx: Context): Engine | undefined { return ctx.get("iciEngine") as unknown as Engine | undefined; }
const obj = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: "object", additionalProperties: false, properties });

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
  ds.push(ctx.systemPrompt.section({ name: "tool:ici_explain", order: 150, text: "ici_explain prepares a bounded source-backed explanation plan for one API: it validates the local graph is fresh, then persists schema-3 prepare metadata (complete bounded call chain, exact source ranges with hashes, reference candidates) and an awaiting-input job record under .metadata/icomposer/ici/explain/. It does not call any model, read source contents into the transcript, or mark readiness. The user confirms a workspace-relative reference file or directory target, model, and earliest not-before time in the Workbench conversation card; the Host starts a fresh restricted background Explain Agent during idle maintenance." }));
  ds.push(ctx.tools.register(defineTool({
    name: "ici_explain",
    description: "Prepare (only) a source-backed explanation plan for one API of a registered workspace. Returns artifact_path plus a compact chain summary; no model call, no readiness change.",
    parameters: { workspace_id: { type: "string", required: true }, query: { type: "string", required: true } },
    output: {
      schema: obj({
        artifact_path: { type: "string", required: true },
        job_id: { type: "string", required: true },
        status: { type: "string", required: true },
        api_id: { type: "string" }, api_name: { type: "string" },
        chain_nodes: { type: "integer" }, chain_edges: { type: "integer" }, truncated: { type: "boolean" },
        source_files: { type: "integer" }, references: { type: "integer" },
        manifest: { type: "object", additionalProperties: false, properties: { source_fingerprint: { type: "string" }, graph_digest: { type: "string" } } },
        default_provider: { type: "string" }, default_model: { type: "string" },
        error: { type: "object", additionalProperties: false, properties: { code: { type: "string", required: true }, message: { type: "string" } } },
      }),
      render: (_a: unknown, v: any) => v?.error ? err(v.error.code, v.error.message) : [{ type: "text", text: `prepare=${v.artifact_path} job=${v.job_id} status=${v.status}; chain=${v.chain_nodes} nodes/${v.chain_edges} edges${v.truncated ? " (truncated)" : ""}, sources=${v.source_files}, refs=${v.references}${v.default_provider && v.default_model ? ` default=${v.default_provider}/${v.default_model}` : ""}. Select a workspace-relative file or directory and confirm the explicit model in the Workbench card, then Start.` }],
    },
    isConcurrencySafe: () => true,
    async execute(raw: Record<string, unknown>, e: Exec) {
      const engine = get(ctx); if (!engine) return { error: { code: "cli-error" } };
      const r = await engine.explainPrepare({ workspaceId: String(raw.workspace_id), query: String(raw.query) }, e.signal);
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
