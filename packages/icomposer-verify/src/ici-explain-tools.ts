import type { Context } from "@deepseek-ai/cordis";
import type { DefineToolFn } from "./tool-types.ts";
interface Exec { readonly signal: AbortSignal; readonly agent?: { readonly options?: { readonly provider?: string; readonly model?: string } }; }
type ResultLike<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly blockers?: readonly { readonly apiId: string; readonly apiName: string; readonly jobId: string; readonly status: string; readonly createdAt: string }[]; readonly blockersMore?: number; readonly memberConflicts?: number } };
interface Engine {
  explainPrepare(i: { workspaceId: string; query: string }, o: AbortSignal): Promise<ResultLike<{
    artifactPath: string; api: { id: string; name: string }; callChain: unknown; sources: readonly unknown[]; references: readonly unknown[];
    manifest: unknown; contextHash: string;
  }>>;
  explainPrepareTask?(i: { workspaceId: string; selector: { kind: "api"; query: string } | { kind: "queries"; queries: readonly string[] } | { kind: "group"; group: string } | { kind: "all" }; maxConcurrent?: number }, o: AbortSignal): Promise<ResultLike<{
    batchId: string; workspaceId: string; requestedCount: number; duplicates: number; selector: { kind: string; label?: string }; jobs: readonly { apiId: string; apiName: string; jobId: string; artifactPath: string; jobStatus: string; chainNodes: number; chainEdges: number; truncated: boolean; reused: boolean }[];
  }>>;
  explainPrepareBatch?(i: { workspaceId: string; queries: readonly string[]; maxConcurrent?: number }, o: AbortSignal): Promise<ResultLike<{
    batchId: string; workspaceId: string; requestedCount: number; duplicates: number; jobs: readonly { apiId: string; apiName: string; jobId: string; artifactPath: string; jobStatus: string; chainNodes: number; chainEdges: number; truncated: boolean; reused: boolean }[];
  }>>;
}
function err(code: string, message = code): Array<{ type: "text"; text: string }> { return [{ type: "text", text: `icomposer tools error: ${code}${message === code ? "" : ` — ${message}`}` }]; }
/** TASK-114: at most this many blockers travel into the tool result (and the model context). */
const MAX_BLOCKED_LINES = 5;
interface BlockedTarget { readonly apiId?: string; readonly api_id?: string; readonly apiName?: string; readonly api_name?: string; readonly jobId?: string; readonly job_id?: string; readonly status?: string; readonly createdAt?: string; readonly created_at?: string }
const blockedApi = (row: BlockedTarget): string => row.api_name ?? row.apiName ?? "";
const blockedJob = (row: BlockedTarget): string => row.job_id ?? row.jobId ?? "";
const blockedCreated = (row: BlockedTarget): string => row.created_at ?? row.createdAt ?? "";
const SAFE_TOKEN = /^[^\s]{1,128}$/;
/**
 * TASK-114: render the blocking jobs as one parsable metadata line each
 * (`blocked=job-active api=… job=… status=… created=…`), so the card can name the
 * blocker and offer a single cancel. No artifact path or prepare detail is included.
 */
function blockedLines(value: { readonly blockers?: readonly BlockedTarget[]; readonly blockersMore?: number }): string[] {
  const rows = Array.isArray(value.blockers) ? value.blockers.slice(0, MAX_BLOCKED_LINES) : [];
  const lines: string[] = [];
  for (const row of rows) {
    const api = SAFE_TOKEN.test(blockedApi(row)) ? blockedApi(row) : "";
    const job = /^[a-f0-9]{16}$/.test(blockedJob(row)) ? blockedJob(row) : "";
    const status = typeof row?.status === "string" && SAFE_TOKEN.test(row.status) ? row.status : "";
    const created = !Number.isNaN(Date.parse(blockedCreated(row))) && blockedCreated(row) !== "" ? blockedCreated(row) : "";
    if (api === "" || job === "") continue;
    // `old_job=` deliberately avoids the `job=` identity token the card parses for itself.
    lines.push(`blocked=job-active api=${api} old_job=${job} status=${status || "unknown"} created=${created || "unknown"}`);
  }
  const more = typeof value.blockersMore === "number" && value.blockersMore > 0 ? value.blockersMore : 0;
  if (more > 0) lines.push(`blocked_more=${more}`);
  return lines;
}
/** TASK-114: the failure text keeps the stable `icomposer tools error:` prefix and adds the blocker lines. */
function errBlocked(code: string, message: string, value: { readonly blockers?: readonly BlockedTarget[]; readonly blockersMore?: number; readonly memberConflicts?: number }): Array<{ type: "text"; text: string }> {
  const lines = blockedLines(value);
  const memberConflicts = typeof value.memberConflicts === "number" && value.memberConflicts > 0 ? value.memberConflicts : 0;
  if (memberConflicts > 0) lines.push(`member_conflict=${memberConflicts}`);
  const head = `icomposer tools error: ${code}${message === code ? "" : ` — ${message}`}`;
  const members = typeof value.memberConflicts === "number" && value.memberConflicts > 0 ? value.memberConflicts : 0;
  const parts: string[] = [];
  if (lines.length > 0) parts.push("The blocking card is an earlier explanation task that is still waiting: cancel it from this card, then run the task again. Do not just repeat the call.");
  if (members > 0) parts.push("Some of these APIs already belong to another task card: open that card and confirm or cancel it there — this card cannot cancel its members.");
  const advice = parts.length === 0 ? "" : `\n${parts.join(" ")}`;
  return [{ type: "text", text: `${head}${advice}${lines.length > 0 ? `\n${lines.join("\n")}` : ""}` }];
}
/** TASK-114: keep the blocking-job identity in the structured error (metadata only, bounded). */
function toolError(error: { code: string; message?: string; blockers?: readonly BlockedTarget[]; blockersMore?: number; memberConflicts?: number }): Record<string, unknown> {
  const source = Array.isArray(error.blockers) ? error.blockers : [];
  const blockers = source.slice(0, MAX_BLOCKED_LINES).map(row => ({
    ...(typeof row.apiId === "string" ? { api_id: row.apiId } : {}),
    ...(typeof row.apiName === "string" ? { api_name: row.apiName } : {}),
    ...(typeof row.jobId === "string" ? { job_id: row.jobId } : {}),
    ...(typeof row.status === "string" ? { status: row.status } : {}),
    ...(typeof row.createdAt === "string" ? { created_at: row.createdAt } : {}),
  }));
  const more = typeof error.blockersMore === "number" && error.blockersMore > 0 ? error.blockersMore : source.length - blockers.length;
  const members = typeof error.memberConflicts === "number" && error.memberConflicts > 0 ? error.memberConflicts : 0;
  return { error: { code: error.code, ...(error.message === undefined ? {} : { message: error.message }) }, ...(blockers.length === 0 ? {} : { blockers }), ...(more > 0 ? { blockers_more: more } : {}), ...(members > 0 ? { member_conflicts: members } : {}) };
}
function get(ctx: Context): Engine | undefined { return ctx.get("iciEngine") as unknown as Engine | undefined; }
const obj = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: "object", additionalProperties: false, properties });
const explainErrorOutput = obj({
  error: { type: "object", additionalProperties: false, properties: { code: { type: "string", required: true }, message: { type: "string" } }, required: true },
  // TASK-114: metadata-only identity of the active jobs that block this task.
  blockers: { type: "array", items: { type: "object", additionalProperties: false, properties: { api_id: { type: "string" }, api_name: { type: "string" }, job_id: { type: "string" }, status: { type: "string" }, created_at: { type: "string" } } } },
  blockers_more: { type: "integer" },
  member_conflicts: { type: "integer" },
});
const explainSingleOutput = obj({
  artifact_path: { type: "string", required: true }, job_id: { type: "string", required: true }, status: { type: "string", required: true },
  api_id: { type: "string" }, api_name: { type: "string" }, chain_nodes: { type: "integer" }, chain_edges: { type: "integer" }, truncated: { type: "boolean" },
  source_files: { type: "integer" }, references: { type: "integer" }, manifest: { type: "object", additionalProperties: false, properties: { source_fingerprint: { type: "string" }, graph_digest: { type: "string" } } },
  default_provider: { type: "string" }, default_model: { type: "string" },
});
const explainTaskOutput = obj({
  batch_id: { type: "string", required: true }, jobs_count: { type: "integer", required: true },
  targets: { type: "integer", required: true }, duplicates: { type: "integer" }, concurrency: { type: "integer" },
  selector_kind: { type: "string" }, selector_label: { type: "string" },
  api_id: { type: "string" }, api_name: { type: "string" }, job_id: { type: "string" },
  default_provider: { type: "string" }, default_model: { type: "string" },
});
const explainBatchOutput = obj({
  batch_id: { type: "string", required: true }, jobs_count: { type: "integer", required: true },
  targets: { type: "integer" }, duplicates: { type: "integer" }, concurrency: { type: "integer" },
  jobs: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
    api_id: { type: "string", required: true }, api_name: { type: "string", required: true }, job_id: { type: "string", required: true }, status: { type: "string", required: true }, artifact_path: { type: "string", required: true }, chain_nodes: { type: "integer", required: true }, chain_edges: { type: "integer", required: true }, truncated: { type: "boolean" }, reused: { type: "boolean" },
  } } },
  default_provider: { type: "string" }, default_model: { type: "string" },
});
const INLINE_CARD_GUIDANCE = "confirmation card is inline in this current DSH Web conversation at this ici_explain call; ask the user to configure it here.";
const TASK_CARD_RULE = "One conversation task is ONE ici_explain call and therefore ONE card: pass every target of the task in that single call (query for one API, queries for all of them). Never split a task into several calls or several cards, never drop or narrow targets to fit a limit, and never call ici_explain once per API. The tool either prepares the whole task or returns an explicit error; it never truncates silently. The card carries the task-wide model, reference target, earliest start time, and the task `concurrency` (how many targets of THIS task may be analyzed at the same time); the Host-wide ceiling still caps it.";

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
  ds.push(ctx.systemPrompt.section({ name: "tool:ici_explain", order: 150, text: `${TASK_CARD_RULE} ici_explain prepares bounded source-backed explanation plans: it validates the local graph is fresh, then persists schema-3 prepare metadata (complete bounded call chains, exact source ranges with hashes, reference candidates) and awaiting-input job records under .metadata/icomposer/ici/explain/. It does not call any model, read source contents into the transcript, or mark readiness. For one API pass 'query'; for a named set pass 'queries'; for a code group pass 'group'; for the whole workspace pass 'all' — the Host resolves the complete target set for group/all, so never enumerate, shorten, or filter the targets yourself. Make exactly ONE call per task: never call ici_explain repeatedly once per API and never split a task across calls. A refusal (empty result, ambiguous group, same-named APIs at several paths, or an API that already has an active job) is reported explicitly; pass it on to the user instead of working around it. When the refusal is job-active, the result lists the blocking cards (blocked= lines with apiName/jobId/status/createdAt): tell the user those earlier cards are still waiting and that the card offers one cancel per blocker, then the task can be run again. Never repeat the same call hoping it succeeds, and never cancel or adopt anything yourself. After success, the confirmation card is inline at this ici_explain tool call in the current DSH Web conversation on the active 3080 server; ask the user to configure it there, not in a separate Workbench app, CLI, or desktop. Do not use bash or cat to inspect job files to find or advance the card. The user confirms one workspace-relative reference file or directory target, model, and earliest not-before time in the Workbench batch card; the Host queues fresh restricted background Explain Agents during idle maintenance.` }));
  ds.push(ctx.tools.register(defineTool({
    name: "ici_explain",
    description: "Prepare (only) ONE source-backed explanation task in a registered workspace. Target the task with exactly one of: `query` (one API), `queries` (an explicit list), `group` (one code group — the host resolves every API of that group), or `all` (every API of the workspace). The host resolves the complete target set; never enumerate targets yourself, never split a task into several calls, and never narrow the user's selection. Optional `concurrency` sets how many targets of this task may run at once (default 4, Host ceiling still applies). No model call and no readiness change.",
    parameters: { workspace_id: { type: "string", required: true }, query: { type: "string" }, queries: { type: "array", items: { type: "string" } }, group: { type: "string" }, all: { type: "boolean" }, concurrency: { type: "integer" } },
    output: {
      schema: { oneOf: [explainTaskOutput, explainSingleOutput, explainBatchOutput, explainErrorOutput] },
      render: (_a: unknown, v: any) => v?.error ? ((Array.isArray(v.blockers) && v.blockers.length > 0) || v.member_conflicts > 0 ? errBlocked(v.error.code, v.error.message, { blockers: v.blockers, blockersMore: v.blockers_more, memberConflicts: v.member_conflicts }) : err(v.error.code, v.error.message)) : v?.batch_id && v?.selector_kind ? [{ type: "text", text: `batch=${v.batch_id} selector=${v.selector_kind}${v.selector_label ? ` label=${v.selector_label}` : ""} targets=${v.targets} unique=${v.jobs_count} concurrency=${v.concurrency}${v.duplicates ? ` duplicates=${v.duplicates}` : ""}${v.default_provider && v.default_model ? ` default=${v.default_provider}/${v.default_model}` : ""}; ${INLINE_CARD_GUIDANCE}` }] : v?.batch_id ? [{ type: "text", text: `batch=${v.batch_id} targets=${v.targets} unique=${v.jobs_count} concurrency=${v.concurrency}${v.duplicates ? ` duplicates=${v.duplicates}` : ""}${v.default_provider && v.default_model ? ` default=${v.default_provider}/${v.default_model}` : ""}; ${INLINE_CARD_GUIDANCE}` }] : [{ type: "text", text: `prepare=${v.artifact_path} job=${v.job_id} status=${v.status}; chain=${v.chain_nodes} nodes/${v.chain_edges} edges${v.truncated ? " (truncated)" : ""}, sources=${v.source_files}, refs=${v.references}${v.default_provider && v.default_model ? ` default=${v.default_provider}/${v.default_model}` : ""}. Select a workspace-relative file or directory and confirm the explicit model in the Workbench card, then Start. ${INLINE_CARD_GUIDANCE}` }],
    },
    isConcurrencySafe: () => true,
    async execute(raw: Record<string, unknown>, e: Exec) {
      const engine = get(ctx); if (!engine) return { error: { code: "cli-error" } };
      const workspaceId = typeof raw.workspace_id === "string" ? raw.workspace_id : "";
      const query = typeof raw.query === "string" && raw.query.trim().length > 0 ? raw.query.trim() : undefined;
      const queries = Array.isArray(raw.queries) && raw.queries.length >= 1 && raw.queries.every(item => typeof item === "string" && item.length <= 512 && item.trim().length > 0) ? raw.queries as string[] : undefined;
      const group = typeof raw.group === "string" && raw.group.trim().length > 0 && raw.group.trim().length <= 512 ? raw.group.trim() : undefined;
      const all = raw.all === true;
      if (raw.queries !== undefined && queries === undefined) return { error: { code: "invalid-workspace-id", message: "queries must be a non-empty array of non-empty API names" } };
      if (raw.query !== undefined && query === undefined) return { error: { code: "invalid-workspace-id", message: "query must be a non-empty API name" } };
      if (raw.group !== undefined && group === undefined) return { error: { code: "invalid-workspace-id", message: "group must be a non-empty group name" } };
      const selected = [query !== undefined, queries !== undefined, group !== undefined, all].filter(Boolean).length;
      if (selected !== 1) return { error: { code: "invalid-workspace-id", message: "pass exactly one of query, queries, group, or all" } };
      const concurrencyProvided = Object.prototype.hasOwnProperty.call(raw, "concurrency");
      const concurrency = typeof raw.concurrency === "number" && Number.isInteger(raw.concurrency) && raw.concurrency >= 1 && raw.concurrency <= 32 ? raw.concurrency : null;
      if (concurrencyProvided && concurrency === null) return { error: { code: "invalid-workspace-id", message: "concurrency must be an integer from 1 to 32" } };
      if (!engine.explainPrepareTask) return { error: { code: "cli-error", message: "task preparation is unavailable" } };
      // TASK-111: every request shape is ONE task. The host resolves the complete
      // target set for `group`/`all`, so the model never enumerates or splits it,
      // and the caller-visible answer stays bounded (counts, not one row per API).
      const selector = query !== undefined ? { kind: "api" as const, query } : queries !== undefined ? { kind: "queries" as const, queries } : group !== undefined ? { kind: "group" as const, group } : { kind: "all" as const };
      const r = await engine.explainPrepareTask({ workspaceId, selector, ...(concurrency === null ? {} : { maxConcurrent: concurrency }) }, e.signal);
      if (!r.ok) return toolError(r.error);
      const v = r.value;
      const only = v.jobs.length === 1 ? v.jobs[0] : undefined;
      return {
        batch_id: v.batchId, jobs_count: v.jobs.length,
        targets: typeof v.requestedCount === "number" ? v.requestedCount : v.jobs.length,
        duplicates: typeof v.duplicates === "number" ? v.duplicates : 0,
        concurrency: concurrency ?? 4,
        selector_kind: v.selector?.kind, ...(v.selector?.label === undefined ? {} : { selector_label: v.selector.label }),
        ...(only === undefined ? {} : { api_id: only.apiId, api_name: only.apiName, job_id: only.jobId }),
        ...(e.agent?.options?.provider && e.agent.options.model ? { default_provider: e.agent.options.provider, default_model: e.agent.options.model } : {}),
      };

    },
  })));
  return ds;
}
