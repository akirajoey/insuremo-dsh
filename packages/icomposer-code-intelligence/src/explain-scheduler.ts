import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import {
  EXPLAIN_ABSOLUTE_PATH_PATTERN, EXPLAIN_SECRET_PATTERN, assertReferenceTarget, finalizeExplain, listActiveJobs, listBatchJobIds, listReferenceEntries, loadPrepare, markRunningJobsInterrupted,
  preparedReadPaths, readExplainPublicationState, readPreparedText, readReferenceText, readJobRecord, recoverOrphanJobs, recoverPendingConfirms, referenceTargetOf, restoreExplainPublicationState, updateJobRecord, jobRecordRelativePath, type ExplainJobRecord, type ExplainPrepareArtifact, type ExplainReferenceTarget,
} from "./explain-artifacts.ts";
import { readBatchRecord } from "./explain-artifacts.ts";
import { withExplainFileLock, writeExplainFile } from "@icomposer/workbench-contracts/ici-explain";
import { graphBaseDir, legacyGraphBaseDir, readManifest } from "./storage.ts";
import { ICI_ENGINE_VERSION } from "./engine-version.ts";
import { EXPLAIN_DEFAULT_CONCURRENCY, EXPLAIN_DEFAULT_MAX_OUTPUT_TOKENS, EXPLAIN_DEFAULT_PROMPT_BYTES } from "./explain-config.ts";

interface AgentLike { readonly id?: string; readonly ctx?: unknown; readonly options?: { provider?: string; model?: string }; whenIdle(): Promise<void>; runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>; }
interface ChildAgent { readonly id: string; readonly options?: { provider?: string; model?: string }; followup(message: unknown): void; whenIdle(): Promise<void>; cancel(cause: unknown): void; }
interface AgentHandle { readonly agent: ChildAgent; dispose(): Promise<void>; }
interface AgentsFace { roots?(): readonly AgentLike[]; create?(options: Record<string, unknown>): Promise<AgentHandle>; withInitiator?<T>(agent: AgentLike, operation: () => T): T; }
interface LlmExplainFace { listProviders(): readonly { id: string }[]; resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<unknown>; }
interface BindingFace { list(): Promise<{ ok: boolean; value?: readonly { workspaceId: string; canonicalPath: string }[] }>; get(id: string): Promise<{ ok: boolean; value?: { canonicalPath: string } }>; }
interface ExplainConfigFace { readonly maxConcurrent: number; readonly maxPromptBytes?: number; readonly maxOutputTokens?: number; onChange(listener: (maxConcurrent: number) => void): () => void; }
/** TASK-125: the effective child output budget (Host setting, default 16384). */
function effectiveMaxOutputTokens(ctx: Context | undefined): number { const config = ctx?.get("iciExplainConfig") as ExplainConfigFace | undefined; const value = config?.maxOutputTokens; return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : EXPLAIN_DEFAULT_MAX_OUTPUT_TOKENS; }
/** TASK-123: one place computes the effective prompt budget for every enforcement point. */
function effectivePromptBudget(ctx: Context): number { const config = ctx.get("iciExplainConfig") as ExplainConfigFace | undefined; const value = config?.maxPromptBytes; return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : EXPLAIN_DEFAULT_PROMPT_BYTES; }

/** TASK-123: fallback prompt budget when this Host has no config service (same value as the default). */
export const MAX_EXPLAIN_PROMPT_BYTES = EXPLAIN_DEFAULT_PROMPT_BYTES;
const MAX_FLOW_ITEMS = 64;
const MAX_TIMER_MS = 2_147_000_000;
const MAX_READ_FILES = 20;
const MAX_REFERENCE_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SUBMIT_ATTEMPTS = 3;
const EVIDENCE_PATTERN = "^(?:[A-Za-z0-9._-]+\\/)*[A-Za-z0-9._-]+#\\d+(?:-\\d+)?$";
const SUBMIT_REPAIR = "schema-invalid: submit exactly technical/business strings, flow string[], and evidence string[]; evidence must use only relative prepared/read paths as path#N or path#N-M (#, never : or objects).";
const SECRET_PATTERN = EXPLAIN_SECRET_PATTERN;
const ABSOLUTE_PATH_PATTERN = EXPLAIN_ABSOLUTE_PATH_PATTERN;
const explainJobTails = new Map<string, Promise<void>>();
/** Child Explain agents are created one at a time per composition; concurrent create is not proven safe. */
const explainChildCreationTails = new WeakMap<object, Promise<unknown>>();
function serializeChildCreation<T>(key: object, operation: () => Promise<T>): Promise<T> {
  const prior = explainChildCreationTails.get(key) ?? Promise.resolve();
  const task = prior.then(operation, operation);
  explainChildCreationTails.set(key, task.then(() => undefined, () => undefined));
  return task;
}
/**
 * TASK-102: per-composition registry of live Explain child sessions. The
 * WeakMap keys it to the composition context (no module-global lifetime), and
 * a child is registered BEFORE `agents.create` so it can never be observed as
 * a driver root, with every exit path (create failure, abort, throw, dispose)
 * unregistering it.
 */
const explainChildSessions = new WeakMap<object, Set<string>>();
function explainChildRegistry(ctx: Context): Set<string> {
  let registry = explainChildSessions.get(ctx);
  if (registry === undefined) { registry = new Set<string>(); explainChildSessions.set(ctx, registry); }
  return registry;
}
function registerExplainChild(ctx: Context, sessionId: string): void { explainChildRegistry(ctx).add(sessionId); }
function unregisterExplainChild(ctx: Context, sessionId: string): void { explainChildRegistry(ctx).delete(sessionId); }
function isExplainChildRoot(ctx: Context, agent: unknown): boolean { const id = (agent as { readonly id?: unknown } | null)?.id; return typeof id === "string" && explainChildRegistry(ctx).has(id); }
async function withExplainJobTransaction<T>(root: string, jobId: string, task: () => Promise<T>): Promise<T> { const key = `${root}\0${jobId}`; const previous = explainJobTails.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>(resolve => { release = resolve; }); explainJobTails.set(key, current); await previous; try { return await task(); } finally { release(); if (explainJobTails.get(key) === current) explainJobTails.delete(key); } }
async function currentGraphManifest(root: string, workspaceId: string): Promise<{ engineVersion?: string; sourceFingerprint?: string; graphDigest?: string } | null> { return readManifest(graphBaseDir(root, workspaceId), legacyGraphBaseDir(root, workspaceId)); }
async function assertFreshJob(root: string, job: ExplainJobRecord): Promise<Awaited<ReturnType<typeof loadPrepare>>> { const prepare = await loadPrepare(root, job.prepareArtifactPath); const graph = await currentGraphManifest(root, job.workspaceId); if (!graph || job.engineVersion !== ICI_ENGINE_VERSION || prepare.manifest.engineVersion !== ICI_ENGINE_VERSION || graph.engineVersion !== ICI_ENGINE_VERSION || graph.sourceFingerprint !== job.sourceFingerprint || graph.graphDigest !== job.graphDigest || prepare.manifest.sourceFingerprint !== job.sourceFingerprint || prepare.manifest.graphDigest !== job.graphDigest) throw new Error("stale-snapshot"); return prepare; }
async function publishFinal(root: string, running: ExplainJobRecord, analysis: { technical: string; business: string; flow: string[]; evidence: string[] }, signal: AbortSignal, folderReads: readonly { path: string; sha256: string }[], target: ExplainReferenceTarget, childSessionId?: string): Promise<boolean> { if (signal.aborted) return false; return withExplainJobTransaction(root, running.jobId, async () => withExplainFileLock(root, jobRecordRelativePath(running.jobId), async () => { const current = await readJobRecord(root, running.jobId); if (!current || current.status !== "running" || signal.aborted) return false; await assertFreshJob(root, current); const previousState = await readExplainPublicationState(root); try { await finalizeExplain(root, current.workspaceId, current.prepareArtifactPath, { api: analysis }, { sourceFingerprint: current.sourceFingerprint, graphDigest: current.graphDigest, engineVersion: current.engineVersion! }, undefined, current.jobId, folderReads, target.path, target); const committed = { ...current, ...(childSessionId === undefined ? {} : { childSessionId }), status: "final" as const, finishedAt: new Date().toISOString(), revision: current.revision + 1, updatedAt: new Date().toISOString() }; await writeExplainFile(root, jobRecordRelativePath(current.jobId), `${JSON.stringify(committed, null, 2)}\n`, { skipLock: true }); return true; } catch (cause) { await restoreExplainPublicationState(root, previousState).catch(() => undefined); throw cause; } })); }
function fixedText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !SECRET_PATTERN.test(value) && !value.startsWith("/") && !ABSOLUTE_PATH_PATTERN.test(value); }
function evidence(value: unknown): value is readonly string[] { return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(item => typeof item === "string" && item.length <= 400 && !SECRET_PATTERN.test(item) && /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+#\d+(?:-\d+)?$/.test(item) && !item.split("#", 1)[0].split("/").some(part => part === "." || part === ".." || part === ".metadata")); }
/** Legacy helper retained for old callers; aggregate synthesis does not use per-node output. */
export function validNodeAnalysis(value: unknown): boolean { if (typeof value !== "object" || value === null) return false; const row = value as Record<string, unknown>; if (Object.keys(row).length === 2 && fixedText(row.node_id, 512) && fixedText(row.unavailable_reason, 1000)) return true; return Object.keys(row).length === 4 && fixedText(row.node_id, 512) && fixedText(row.technical, 12_000) && fixedText(row.business, 12_000) && evidence(row.evidence); }
function containsUnsafeText(value: unknown): boolean { if (typeof value === "string") return value.startsWith("/") || SECRET_PATTERN.test(value) || ABSOLUTE_PATH_PATTERN.test(value); if (Array.isArray(value)) return value.some(containsUnsafeText); if (typeof value === "object" && value !== null) return Object.values(value).some(containsUnsafeText); return false; }
function unsafeAnalysis(value: unknown): boolean { return containsUnsafeText(value); }
function strictAnalysis(value: unknown, target: ExplainReferenceTarget, verifiedPaths: ReadonlySet<string>): value is { technical: string; business: string; flow: string[]; evidence: string[] } { if (typeof value !== "object" || value === null) return false; const row = value as Record<string, unknown>; return Object.keys(row).length === 4 && ["technical", "business", "flow", "evidence"].every(key => Object.prototype.hasOwnProperty.call(row, key)) && fixedText(row.technical, 12_000) && fixedText(row.business, 12_000) && Array.isArray(row.flow) && row.flow.length <= MAX_FLOW_ITEMS && row.flow.every(item => fixedText(item, 500)) && evidence(row.evidence) && row.evidence.every(item => { const path = String(item).split("#", 1)[0]; const targetPath = target.kind === "file" ? path === target.path : target.kind === "directory" && (target.path === "" || path.startsWith(`${target.path}/`)); return verifiedPaths.has(path) && (targetPath || path.startsWith("src/") || path.startsWith("docs/")); }); }
/**
 * TASK-125 (size): the call chain is rendered as a compact map. Long shared prefixes are printed
 * once as a numbered file table (`[1] <path>`), and each distinct `path#start-end` becomes one line
 * whose node ids are grouped. The read tool accepts the `[n]` handle (with an optional `#a-b` range)
 * so the child can copy a line verbatim. No source text, no hashes, no edge dump.
 */
export interface ExplainPromptTable { readonly files: readonly string[]; readonly lines: readonly string[]; }
export function chainTable(prepare: ExplainPrepareArtifact): ExplainPromptTable {
  const files: string[] = []; const fileIndex = new Map<string, number>();
  const fileOf = (path: string): number => { const existing = fileIndex.get(path); if (existing !== undefined) return existing; files.push(path); fileIndex.set(path, files.length); return files.length; };
  const groups = new Map<string, { handle: string; from?: number; to?: number; depth: number; ids: string[] }>();
  for (const node of prepare.callChain.nodes) {
    const path = typeof node.sourceFile === "string" && node.sourceFile !== "" ? node.sourceFile : "(unknown)";
    const handle = `[${fileOf(path)}]`;
    const key = `${handle}#${node.startLine ?? ""}-${node.endLine ?? ""}`;
    const depth = Math.max(0, (node.pathFromApi?.length ?? 1) - 1);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { handle, ...(node.startLine === undefined ? {} : { from: node.startLine }), ...(node.endLine === undefined ? {} : { to: node.endLine }), depth, ids: [node.nodeId] });
    else { group.depth = Math.min(group.depth, depth); group.ids.push(node.nodeId); }
  }
  const repeated = new Set(prepare.callChain.repeatedVisits ?? []);
  const lines: string[] = [];
  for (const group of groups.values()) {
    const indent = "  ".repeat(Math.min(3, group.depth));
    const range = group.from === undefined ? "" : `#${group.from}${group.to === undefined ? "" : `-${group.to}`}`;
    lines.push(`${indent}- ${group.ids.join(", ")} → ${group.handle}${range}${group.ids.some(id => repeated.has(id)) ? " (repeated)" : ""}`);
  }
  if (prepare.callChain.truncated) lines.push("(truncated: the traversal hit the node/edge/depth budget, so this map is a partial view of the call chain)");
  return { files, lines };
}
export function sourcePrompt(prepare: Awaited<ReturnType<typeof loadPrepare>>, target: ExplainReferenceTarget, table: ExplainPromptTable = chainTable(prepare)): string {
  const targetLine = target.kind === "none" ? "Reference target: none (prepared sources only; do not call ici_explain_list)." : `Reference target: ${target.path === "" ? "." : target.path} (${target.kind}); use ici_explain_list/read only if needed, do not require both.`;
  const references = prepare.references.filter(reference => reference.readable).map(reference => `- ${reference.path}`);
  return [
    "You are a dedicated read-only explanation agent for ONE API. You are given PATHS, not code: read on demand with the tools, then submit.",
    "How to work:",
    "1. The call chain below is the map of what matters (paths and line ranges; leading indentation = call depth). Read only the files or ranges you actually need.",
    "2. Cite evidence only as path#N or path#N-M, and only for paths you actually read (# is mandatory, never : and never objects).",
    "3. ici_explain_submit is the ONLY completion boundary: exactly technical (string), business (string), flow (string[]), evidence (string[]). Never answer in chat instead of submitting; a schema-invalid submit can be corrected up to three attempts.",
    "4. Only ici_explain_list, ici_explain_read and ici_explain_submit exist. No absolute paths, no shell, no network, no writes.",
    "5. Limits: at most 20 reads, one read returns at most 256 KiB; for a file longer than that, pass startLine/endLine to read it in segments (each response reports the range it covered and nextStartLine).",
    `API: ${prepare.api.name} (${prepare.api.id}) in workspace ${prepare.workspaceId}.`,
    targetLine,
    "Files referenced by the call chain (pass the exact string, e.g. [1]#12-20 or the full path, to ici_explain_read):",
    ...table.files.map((path, index) => `  [${index + 1}] ${path}`),
    `Call chain (${prepare.callChain.nodes.length} nodes${prepare.callChain.truncated ? ", truncated" : ""}; indentation = call depth):`,
    ...table.lines,
    "Prepared reference documents (workspace-relative paths):",
    ...(references.length > 0 ? references : ["- (none)"]),
  ].join("\n");
}
function correctiveFollowup(target: ExplainReferenceTarget, aborted = false): string { const prefix = aborted ? "Your previous turn was aborted. " : ""; const submit = "Call ici_explain_submit now with exactly technical/business strings, flow string[], and evidence string[] using relative path#N or path#N-M (#, never :)."; return target.kind === "none" ? `${prefix}No optional reference selected; do not call ici_explain_list or ici_explain_read. ${submit}` : `${prefix}Use ici_explain_list/read only if needed for the selected reference; do not require both. ${submit}`; };
function toolOutput(value: unknown): Array<{ type: "text"; text: string }> { return [{ type: "text", text: JSON.stringify(value) }]; }
function utf8Bytes(value: unknown): number { try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.MAX_SAFE_INTEGER; } }
function explainRequestBytes(value: unknown): number { const row = value as Record<string, unknown> | null; return utf8Bytes({ provider: row?.provider, model: row?.model, system: row?.system, messages: row?.messages, tools: row?.tools }); }
function childMessage(text: string): unknown { return { id: `ici-explain-${randomUUID()}`, role: "user", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "icomposer-code-intelligence", form: "explain" } }; }
function toolSchema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> { return { type: "object", additionalProperties: false, properties, required: [...required] }; }
async function* strictChildStream(source: AsyncIterable<any>): AsyncGenerator<any> { let finished = false; for await (const chunk of source) { if (finished) throw new Error("stream-after-finish"); if (chunk?.type === "finish") { if (chunk.reason?.kind === "aborted") throw new Error("stream-aborted"); if (typeof chunk.reason?.kind !== "string" || !["stop", "tool-calls"].includes(chunk.reason.kind)) throw new Error("stream-invalid"); finished = true; } yield chunk; } if (!finished) throw new Error("stream-no-finish"); }
async function* monitoredChildStream(source: AsyncIterable<any>, fail: (error: unknown) => void): AsyncGenerator<any> { try { yield* strictChildStream(source); } catch (error) { fail(error); throw error; } }

/** Create one fresh restricted background Agent and await its controlled submit boundary. */
async function runDedicatedAgent(ctx: Context, root: string, job: Awaited<ReturnType<typeof readJobRecord>> & {}, prepare: Awaited<ReturnType<typeof loadPrepare>>, preparedPaths: readonly string[], signal: AbortSignal, parent?: AgentLike, promptBudget = effectivePromptBudget(ctx)): Promise<{ analysis: { technical: string; business: string; flow: string[]; evidence: string[] }; folderReads: readonly { path: string; sha256: string }[]; childSessionId: string }> {
  const agents = ctx.get("agents") as AgentsFace | undefined; if (!agents?.create) throw new Error("model-failed");
  const target = referenceTargetOf(job); await assertReferenceTarget(root, target); const initialPrompt = sourcePrompt(prepare, target);
  const whitelist = new Set(preparedPaths);
  const promptTable = chainTable(prepare);
  /** Resolve `[n]` / `[n]#a-b` from the call-chain map, or pass a plain path through unchanged. */
  const resolveHandle = (value: string): { path: string; from?: number; to?: number } => { const match = /^\[(\d+)\](?:#(\d+)(?:-(\d+))?)?$/.exec(value.trim()); if (match === null) return { path: value }; const entry = promptTable.files[Number(match[1]) - 1]; if (entry === undefined) throw new Error("source-forbidden"); return { path: entry, ...(match[2] === undefined ? {} : { from: Number(match[2]) }), ...(match[3] === undefined ? {} : { to: Number(match[3]) }) }; };
  const basePromptBytes = Buffer.byteLength(initialPrompt, "utf8"); if (basePromptBytes > promptBudget) throw new Error("input-too-large");
  let childRef: ChildAgent | undefined; let toolFailureReason: string | undefined; let streamAborted = false; let resolveSubmitted: (value: { technical: string; business: string; flow: string[]; evidence: string[] }) => void = () => undefined; const submitted = new Promise<{ technical: string; business: string; flow: string[]; evidence: string[] }>(resolve => { resolveSubmitted = resolve; }); let submittedOnce = false; let submitAttempts = 0; let toolFailure = false; let listCalls = 0; let readCalls = 0; let readBytes = 0; let toolOutputBytes = 0; const verifiedPaths = new Set<string>(preparedPaths); const folderReads: Array<{ path: string; sha256: string }> = []; const reserveToolOutput = (value: unknown): void => { toolOutputBytes += utf8Bytes(value); if (basePromptBytes + toolOutputBytes > promptBudget) { toolFailure = true; toolFailureReason = "input-too-large"; childRef?.cancel("tool-failed"); throw new Error("input-too-large"); } };
  const setup = (childCtx: any): void => {
    const tools = childCtx.tools as { restrict(filter: { allow: readonly string[] }): unknown; register(definition: Record<string, unknown>): unknown };
    tools.restrict({ allow: [] });
    tools.register({ name: "ici_explain_list", description: target.kind === "none" ? "No optional reference selected; do not call this tool. It returns an empty list without filesystem access." : "List text files and child directories under the selected workspace-relative reference target. Use only when needed; a selected file cannot be expanded.", parameters: toolSchema({ path: { type: "string", description: "Workspace-relative subpath; omitted for the target root." } }), output: { schema: toolSchema({ result: { type: "array" } }, ["result"]), render: (_a: unknown, value: unknown) => toolOutput(value) }, execute: async (raw: Record<string, unknown>) => { if (++listCalls > 20) { toolFailure = true; toolFailureReason = "tool-limit"; childRef?.cancel("tool-failed"); throw new Error("tool-limit"); } try { const subpath = typeof raw.path === "string" ? raw.path : ""; const output = { entries: (await listReferenceEntries(root, target, subpath)).filter(entry => entry.kind === "directory" || entry.supported === true).slice(0, MAX_LIST_ENTRIES) }; reserveToolOutput(output); return output; } catch (error) { toolFailure = true; const message = error instanceof Error && ["tool-limit", "input-too-large", "folder-forbidden", "folder-oversize"].includes(error.message) ? error.message : "folder-forbidden"; toolFailureReason = message; childRef?.cancel("tool-failed"); throw new Error(message); } } });
    tools.register({ name: "ici_explain_read", description: "Read one workspace-relative file that the call chain or the prepared reference list names (nothing else). Accepts the exact path or the map handle [n] (with an optional #a-b range). Optional startLine/endLine read a large file in segments; each response reports the range it covered and nextStartLine when the file continues.", parameters: toolSchema({ path: { type: "string", description: "Workspace-relative path from the call-chain map, either the full path or its [n] handle (optionally [n]#120-240)." }, startLine: { type: "integer", description: "First line to read (1-based); optional." }, endLine: { type: "integer", description: "Last line to read (inclusive); optional." } }, ["path"]), output: { schema: toolSchema({ path: { type: "string" }, content: { type: "string" }, bytes: { type: "integer" }, sha256: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" }, totalLines: { type: "integer" }, truncated: { type: "boolean" }, nextStartLine: { type: "integer" } }, ["path", "content", "bytes", "sha256"]), render: (_a: unknown, value: unknown) => toolOutput(value) }, execute: async (raw: Record<string, unknown>) => { if (++readCalls > MAX_READ_FILES) { toolFailure = true; toolFailureReason = "tool-limit"; childRef?.cancel("tool-failed"); throw new Error("tool-limit"); } try { if (typeof raw.path !== "string") throw new Error("folder-forbidden"); const resolved = resolveHandle(raw.path); const declaredFrom = Number.isInteger(raw.startLine) && (raw.startLine as number) > 0 ? raw.startLine as number : resolved.from; const declaredTo = Number.isInteger(raw.endLine) && (raw.endLine as number) > 0 ? raw.endLine as number : resolved.to; const from = declaredFrom; const to = declaredTo; const fromPrepared = whitelist.has(raw.path); const file = fromPrepared ? await readPreparedText(root, prepare, raw.path, from, to) : await readReferenceText(root, target, raw.path); readBytes += file.bytes; if (readBytes > Math.max(0, promptBudget - basePromptBytes)) { toolFailureReason = "input-too-large"; throw new Error("input-too-large"); } verifiedPaths.add(file.path); if (!fromPrepared) folderReads.push({ path: file.path, sha256: file.sha256 }); reserveToolOutput(file); return file; } catch (error) { const message = error instanceof Error && ["tool-limit", "folder-oversize", "input-too-large", "folder-forbidden", "source-forbidden", "source-oversize", "source-range"].includes(error.message) ? error.message : "folder-forbidden"; if (!(target.kind === "none" && message === "folder-forbidden")) { toolFailure = true; toolFailureReason = message; childRef?.cancel("tool-failed"); } throw new Error(message); } } });
    tools.register({ name: "ici_explain_submit", description: "Submit exactly one strict aggregate API explanation; this is the only completion boundary. Cite only path#N or path#N-M entries for paths you actually read. technical/business are strings, flow is string[], and evidence is string[] using relative path#N or path#N-M (use #, never : or objects).", parameters: toolSchema({ technical: { type: "string", minLength: 1, maxLength: 12000, description: "Factual technical explanation." }, business: { type: "string", minLength: 1, maxLength: 12000, description: "Factual business explanation." }, flow: { type: "array", minItems: 0, maxItems: MAX_FLOW_ITEMS, items: { type: "string", minLength: 1, maxLength: 500 }, description: "Ordered factual flow steps as strings." }, evidence: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1, maxLength: 400, pattern: EVIDENCE_PATTERN }, description: "Relative prepared/read source references; each must be path#N or path#N-M, never path:N or an object." } }, ["technical", "business", "flow", "evidence"]), output: { schema: toolSchema({ accepted: { type: "boolean" } }, ["accepted"]), render: (_a: unknown, value: unknown) => toolOutput(value) }, execute: async (raw: Record<string, unknown>) => { if (toolFailure) throw new Error(toolFailureReason ?? "model-failed"); if (submittedOnce) { toolFailure = true; toolFailureReason = "schema-invalid"; childRef?.cancel("tool-failed"); throw new Error("schema-invalid"); } if (!strictAnalysis(raw, target, verifiedPaths)) { toolFailureReason = "schema-invalid"; if (unsafeAnalysis(raw) || ++submitAttempts >= MAX_SUBMIT_ATTEMPTS) { toolFailure = true; childRef?.cancel("tool-failed"); throw new Error("schema-invalid"); } throw new Error(SUBMIT_REPAIR); } submittedOnce = true; resolveSubmitted(raw as { technical: string; business: string; flow: string[]; evidence: string[] }); return { accepted: true }; } });
    if (typeof childCtx.on === "function") childCtx.on("llm/stream", (options: unknown, next: () => AsyncIterable<any>) => { if (explainRequestBytes(options) > promptBudget) { toolFailure = true; toolFailureReason = "input-too-large"; childRef?.cancel("tool-failed"); throw new Error("input-too-large"); } return monitoredChildStream(next(), error => { const message = error instanceof Error ? error.message : "stream-error"; if (message === "stream-aborted") { streamAborted = true; return; } toolFailure = true; toolFailureReason = message; childRef?.cancel("tool-failed"); }); }, { prepend: true });
    childCtx.systemPrompt.section({ name: `ici-explain-child:${job.jobId}`, order: 120, text: `This is a dedicated read-only ICI explanation child. Only ici_explain_list, ici_explain_read, ici_explain_submit are available. You receive paths, not code: read what you need (large files by startLine/endLine segments). Workspace-relative reference target is ${JSON.stringify(target)}${target.kind === "none" ? "; no optional reference selected; read the prepared call-chain paths; do not call ici_explain_list; submit when ready" : "; use ici_explain_list/read only if needed; do not require both; then submit"}. Evidence must be string[] with relative path#N or path#N-M (#, never :) for paths you actually read. Never use absolute paths or shell/network/write tools.` });
  };
  const childSessionId = randomUUID();
  registerExplainChild(ctx, childSessionId);
  let handle: AgentHandle;
  try {
    const create = (): Promise<AgentHandle> => agents.create!({ sessionId: childSessionId, meta: { cwd: root, ...(parent?.id ? { parentSession: parent.id } : {}), origin: "subagent", delegationDepth: 1 }, agentOptions: { provider: job.provider!, model: job.model!, maxTokens: effectiveMaxOutputTokens(ctx) }, setup, signal });
    handle = await serializeChildCreation(ctx, () => parent && agents.withInitiator ? agents.withInitiator(parent, create) : create());
  } catch (error) {
    // Create failure / abort / throw: the child never became live.
    unregisterExplainChild(ctx, childSessionId);
    throw error;
  }
  const child = handle.agent; childRef = child; const abortChild = (): void => { try { child.cancel("cancelled"); } catch { /* disposal below */ } }; signal.addEventListener("abort", abortChild, { once: true });
  try {
    const waitForTurn = async (): Promise<{ kind: "submitted"; value: { technical: string; business: string; flow: string[]; evidence: string[] } } | { kind: "idle" } | { kind: "aborted" }> => {
      const idle = child.whenIdle().then(() => ({ kind: "idle" as const }));
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<{ kind: "aborted" }>(resolve => { onAbort = () => resolve({ kind: "aborted" }); if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); });
      try { return await Promise.race([submitted.then((value: { technical: string; business: string; flow: string[]; evidence: string[] }) => ({ kind: "submitted" as const, value })), idle, aborted]); }
      finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
    };
    try {
      const current = await readJobRecord(root, job.jobId); if (current && current.status === "running" && current.revision === job.revision) await updateJobRecord(root, job.jobId, job.revision, { childSessionId }).catch(() => undefined);
    } catch { /* best-effort attribution */ }
    child.followup(childMessage(initialPrompt));
    let outcome = await waitForTurn();
    if (outcome.kind === "idle") {
      if (toolFailure && toolFailureReason !== "stream-aborted") throw new Error(toolFailureReason ?? "model-failed");
      if (streamAborted) {
        streamAborted = false;
        child.followup(childMessage(correctiveFollowup(target, true)));
        outcome = await waitForTurn();
      } else {
        child.followup(childMessage(correctiveFollowup(target)));
        outcome = await waitForTurn();
      }
    }
    if (outcome.kind !== "submitted") throw new Error(outcome.kind === "aborted" ? "stream-aborted" : streamAborted ? "stream-aborted" : toolFailureReason ?? "model-failed");
    try { child.cancel("cancelled"); } catch { /* stop after submit */ }
    return { analysis: outcome.value, folderReads, childSessionId };
  } finally { signal.removeEventListener("abort", abortChild); try { child.cancel("cancelled"); } catch { /* already idle */ } try { await handle.dispose(); } finally { unregisterExplainChild(ctx, childSessionId); } }
}

export async function processConfirmedJob(llm: LlmExplainFace, root: string, jobId: string, signal: AbortSignal, ctx?: Context, parent?: AgentLike): Promise<void> {

  const started = await readJobRecord(root, jobId); if (!started || !["scheduled", "confirmed"].includes(started.status)) return;
  // TASK-123: the effective prompt budget for this run (Host setting, default 256 KiB).
  const promptBudget = ctx === undefined ? EXPLAIN_DEFAULT_PROMPT_BYTES : effectivePromptBudget(ctx);
  if (!started.provider || !started.model) { await updateJobRecord(root, jobId, started.revision, { status: "failed", error: "confirmation-invalid" }).catch(() => undefined); return; }
  let registered = false; try { registered = llm.listProviders().some(provider => provider.id === started.provider); if (registered && llm.resolveModelInfo) await llm.resolveModelInfo(started.provider, started.model, signal); } catch { registered = false; }
  if (!registered || !ctx) { await updateJobRecord(root, jobId, started.revision, { status: "failed", error: "confirmation-invalid" }).catch(() => undefined); return; }
  if (started.notBefore && Date.parse(started.notBefore) > Date.now()) return;
  let preflightPrepare: Awaited<ReturnType<typeof loadPrepare>>;
  try { preflightPrepare = await assertFreshJob(root, started); } catch { await updateJobRecord(root, jobId, started.revision, { status: "failed", error: "stale-snapshot" }).catch(() => undefined); return; }
  const running = await updateJobRecord(root, jobId, started.revision, { status: "running", startedAt: new Date().toISOString() }).catch(() => null); if (!running) return;
  try {
    const target = referenceTargetOf(running); await assertReferenceTarget(root, target);
    const prepare = preflightPrepare; if (prepare.workspaceId !== running.workspaceId || prepare.api.id !== running.apiId || prepare.api.name !== running.apiName || prepare.prepareId !== running.prepareId || prepare.contextHash !== running.contextHash || prepare.manifest.sourceFingerprint !== running.sourceFingerprint || prepare.manifest.graphDigest !== running.graphDigest) throw new Error("confirmation-invalid");
    if (running.docs.some(doc => !prepare.references.some(ref => ref.readable && ref.path === doc.path && ref.sha256 === doc.sha256))) throw new Error("confirmation-invalid");
    // TASK-125: the child starts from PATHS only -- no source material is read and no content is
    // scanned before the child runs (the scan moved to read time, fail-closed).
    const preparedPaths = preparedReadPaths(prepare);
    // The base-prompt budget check lives in runDedicatedAgent, right after the prompt is built.
    signal.throwIfAborted(); const latestBeforeChild = await readJobRecord(root, jobId); if (!latestBeforeChild || latestBeforeChild.status !== "running") return;
    const completed = await runDedicatedAgent(ctx, root, running, prepare, preparedPaths, signal, parent, promptBudget); const published = await publishFinal(root, running, completed.analysis, signal, completed.folderReads, target, completed.childSessionId); if (!published) return;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "model-failed"; const externalAbort = signal.aborted || cause instanceof DOMException; const aborted = externalAbort || message === "aborted"; const known = new Set(["confirmation-invalid", "source-changed", "folder-changed", "stale-snapshot", "prepare-invalidated", "input-too-large", "output-oversize", "stream-error", "stream-incomplete", "stream-tool-call", "stream-invalid", "stream-aborted", "stream-no-finish", "stream-after-finish", "schema-invalid", "tool-limit", "source-forbidden", "folder-forbidden", "folder-oversize", "analysis-invalid"]); const error = aborted ? "cancelled" : known.has(message) ? message : "model-failed";
    await withExplainJobTransaction(root, jobId, async () => { const latest = await readJobRecord(root, jobId); if (latest && !["final", "cancelled"].includes(latest.status)) await updateJobRecord(root, jobId, latest.revision, { status: aborted ? "cancelled" : "failed", finishedAt: new Date().toISOString(), error }).catch(() => undefined); });
  }
}

export class ExplainScheduler extends Service {
  static inject = ["agents", "llm", "workspaceBinding", "iciExplainConfig"] as const;
  /** One global fill loop: every drive source funnels here, so concurrent roots can never over-fill. */
  private filling: Promise<void> | undefined; private fillRequested = false;
  /** TASK-102: reserved capacity, keyed `${canonicalRoot}\0${jobId}`, reserved BEFORE any async preflight. */
  private readonly inFlight = new Map<string, AbortController>();
  /** TASK-111: live reservations per task, keyed `${canonicalRoot}\0${batchId}` (or `job:<jobId>` for single-API/legacy jobs). */
  private readonly taskInFlight = new Map<string, number>();
  /** One-shot idle wakes, deduplicated per user root and never awaited by the fill loop. */
  private readonly idleWakes = new WeakSet<object>();
  /** All live job tasks, awaited before disposal completes. */
  private readonly tasks = new Set<Promise<void>>();
  private configDispose: (() => void) | undefined; private disposePromise?: Promise<void>; private readonly timers = new Map<string, ReturnType<typeof setTimeout>>(); private readonly timerTargets = new Map<string, number>(); private readonly recovered = new Set<string>(); private disposed = false;
  constructor(ctx: Context) { super(ctx, "iciExplainScheduler" as never); this.cancelJob = this.cancelJob.bind(this); this.poke = this.poke.bind(this); this.status = this.status.bind(this); this.dispose = this.dispose.bind(this); }
  protected [Service.init](): void { this.ctx.effect(() => () => this.dispose(), "iciExplainScheduler.dispose"); void this.attachRoots(); const on = (this.ctx as unknown as { on(event: string, listener: () => void): () => boolean }).on.bind(this.ctx); for (const event of ["agent/idle", "agent/status", "agent/created"]) try { on(event, () => void this.attachRoots()); } catch { /* optional */ } const config = this.ctx.get("iciExplainConfig") as ExplainConfigFace | undefined; if (config !== undefined) this.configDispose = config.onChange(() => { if (!this.disposed) this.poke(); }); }

  /** Current effective cap and reserved in-flight count for status payloads. */
  status(): { readonly maxConcurrent: number; readonly inFlight: number } { return { maxConcurrent: this.maxConcurrent(), inFlight: this.inFlight.size }; }
  /** TASK-111: how many jobs of one task are running right now (Host-wide reservation table, read-only view). */
  taskInFlightCount(root: string, batchId: string): number { return this.taskInFlight.get(`${root}\0${batchId}`) ?? 0; }
  /** TASK-111: the ceiling that actually gates one task = min(task setting, Host cap). */
  effectiveTaskMax(maxConcurrent: number | undefined): number { return Math.max(1, Math.min(typeof maxConcurrent === "number" ? maxConcurrent : this.maxConcurrent(), this.maxConcurrent())); }
  private reserveTask(key: string): void { this.taskInFlight.set(key, (this.taskInFlight.get(key) ?? 0) + 1); }
  private releaseTask(key: string): void { const next = (this.taskInFlight.get(key) ?? 0) - 1; if (next > 0) this.taskInFlight.set(key, next); else this.taskInFlight.delete(key); }
  /**
   * TASK-111: resolve a job to its task identity and effective ceiling. Jobs of
   * one task share the task's own batch record setting; single-API jobs and
   * legacy pre-TASK-111 jobs fall back to their batch record (when one exists)
   * and otherwise to the Host cap.
   */
  private async resolveTask(root: string, job: ExplainJobRecord, cache?: Map<string, { key: string; max: number }>): Promise<{ key: string; max: number }> {
    const host = this.maxConcurrent();
    const cacheKey = `${root}\0${job.batchId ?? job.jobId}`;
    const cached = cache?.get(cacheKey);
    if (cached !== undefined) return cached;
    let batchId = typeof job.batchId === "string" ? job.batchId : undefined;
    if (batchId === undefined) batchId = await listBatchJobIds(root).catch(() => new Map<string, string>()).then(map => map.get(job.jobId));
    let resolved: { key: string; max: number };
    if (batchId === undefined) resolved = { key: `${root}\0job:${job.jobId}`, max: host };
    else {
      const record = await readBatchRecord(root, batchId);
      // TASK-111 P0: a task whose confirmation is still committing is not claimable at
      // all (max 0), so no member of a half-finished confirmation can start.
      resolved = record?.confirmPending === true
        ? { key: `${root}\0${batchId}`, max: 0 }
        : { key: `${root}\0${batchId}`, max: this.effectiveTaskMax(record?.maxConcurrent) };
    }
    cache?.set(cacheKey, resolved);
    return resolved;
  }
  private maxConcurrent(): number { const config = this.ctx.get("iciExplainConfig") as ExplainConfigFace | undefined; return config?.maxConcurrent ?? EXPLAIN_DEFAULT_CONCURRENCY; }
  /** TASK-123: the effective prompt budget (Host setting, default 256 KiB). */
  private promptBudget(): number { return effectivePromptBudget(this.ctx); }
  /** Real user roots only: Explain children are registered by session id before creation. */
  private userRoots(): AgentLike[] { const roots = (this.ctx.get("agents") as AgentsFace | undefined)?.roots?.() ?? []; return roots.filter(agent => !isExplainChildRoot(this.ctx, agent)); }
  private async attachRoots(): Promise<void> { if (this.disposed) return; const binding = this.ctx.get("workspaceBinding") as BindingFace | undefined; if (binding) { const listed = await binding.list().catch(() => ({ ok: false, value: undefined } as Awaited<ReturnType<BindingFace["list"]>>)); if (listed.ok) for (const row of listed.value ?? []) { if (!this.recovered.has(row.canonicalPath)) { this.recovered.add(row.canonicalPath); await markRunningJobsInterrupted(row.canonicalPath); await recoverOrphanJobs(row.canonicalPath).catch(() => undefined); await recoverPendingConfirms(row.canonicalPath).catch(() => undefined); } await this.armScheduled(row.canonicalPath); } } this.requestDrive(); }
  private async armScheduled(root: string): Promise<void> { for (const job of await listActiveJobs(root)) if (job.status === "scheduled" && job.notBefore) this.armTimer(job); }
  private armTimer(job: ExplainJobRecord): void { const target = Date.parse(job.notBefore ?? ""); if (!Number.isFinite(target)) return; const delay = Math.min(MAX_TIMER_MS, Math.max(0, target - Date.now())); const existing = this.timers.get(job.jobId); if (existing && this.timerTargets.get(job.jobId) === target) return; if (existing) clearTimeout(existing); const timer = setTimeout(() => { this.timers.delete(job.jobId); this.timerTargets.delete(job.jobId); this.poke(); }, delay); this.timers.set(job.jobId, timer); this.timerTargets.set(job.jobId, target); }
  requestDrive(): void { if (this.disposed) return; this.scheduleFill(); }
  private scheduleFill(): void { if (this.filling !== undefined) { this.fillRequested = true; return; } this.filling = this.fillLoop().finally(() => { this.filling = undefined; if (this.fillRequested) { this.fillRequested = false; this.scheduleFill(); } }); }
  /** Pick the next claimable job globally; futures arm their timer and never block due work. */
  private async pickClaimable(binding: BindingFace): Promise<ExplainJobRecord | undefined> {
    const listed = await binding.list().catch(() => ({ ok: false, value: undefined } as Awaited<ReturnType<BindingFace["list"]>>));
    if (!listed.ok) return undefined;
    const tasks = new Map<string, { key: string; max: number }>();
    for (const row of listed.value ?? []) {
      const actives = await listActiveJobs(row.canonicalPath);
      for (const item of actives) {
        if (!["scheduled", "confirmed"].includes(item.status)) continue;
        if (item.notBefore && Date.parse(item.notBefore) > Date.now()) { this.armTimer(item); continue; }
        if (this.inFlight.has(`${row.canonicalPath}\0${item.jobId}`)) continue;
        // TASK-111: a task at its own ceiling is skipped (never returned), so the
        // scan reaches other tasks instead of spinning on the throttled one.
        const task = await this.resolveTask(row.canonicalPath, item, tasks);
        if ((this.taskInFlight.get(task.key) ?? 0) >= task.max) continue;
        return item;
      }
    }
    return undefined;
  }
  /**
   * One global serial fill loop. Each pass picks a job, re-resolves its root,
   * reverifies capacity/disposal/record state after EVERY await, then reserves
   * synchronously and tries the user roots in order. A root that refuses
   * `runMaintenance` is busy; when every root is busy the pass releases its
   * reservation and arms one-shot idle wakes instead of polling.
   */
  private async fillLoop(): Promise<void> {
    while (!this.disposed) {
      this.fillRequested = false;
      if (this.inFlight.size >= this.maxConcurrent()) return;
      const binding = this.ctx.get("workspaceBinding") as BindingFace | undefined;
      const llm = this.ctx.get("llm") as LlmExplainFace | undefined;
      if (!binding || !llm) return;
      const roots = this.userRoots();
      if (roots.length === 0) return;
      const claim = await this.pickClaimable(binding);
      if (this.disposed) return;
      if (claim === undefined) return;
      if (this.inFlight.size >= this.maxConcurrent()) return;
      const resolved = await binding.get(claim.workspaceId);
      if (this.disposed) return;
      if (this.inFlight.size >= this.maxConcurrent()) return;
      if (!resolved.ok || !resolved.value) return;
      const canonicalRoot = resolved.value.canonicalPath;
      const latest = await readJobRecord(canonicalRoot, claim.jobId);
      if (this.disposed) return;
      if (!latest || !["scheduled", "confirmed"].includes(latest.status)) continue;
      if (this.inFlight.size >= this.maxConcurrent()) return;
      const key = `${canonicalRoot}\0${claim.jobId}`;
      if (this.inFlight.has(key)) continue;
      const task = await this.resolveTask(canonicalRoot, latest);
      if (this.disposed) return;
      // Capacity checks -> reservation is atomic: no await sits between them.
      if (this.inFlight.size >= this.maxConcurrent()) return;
      if ((this.taskInFlight.get(task.key) ?? 0) >= task.max) return;
      const controller = new AbortController();
      this.inFlight.set(key, controller);
      this.reserveTask(task.key);
      if (this.tryStartOn(roots, { llm, canonicalRoot, jobId: claim.jobId, taskKey: task.key, controller, key })) continue;
      // Every user root is busy: give the slot back and wait for a real idle edge.
      this.inFlight.delete(key);
      this.releaseTask(task.key);
      this.armIdleWakes(roots);
      return;
    }
  }
  /** Try the roots in order; `runMaintenance` throws synchronously while busy. */
  private tryStartOn(roots: readonly AgentLike[], pending: { llm: LlmExplainFace; canonicalRoot: string; jobId: string; taskKey: string; controller: AbortController; key: string }): boolean {
    for (const agent of roots) {
      if (this.disposed || pending.controller.signal.aborted || this.inFlight.get(pending.key) !== pending.controller) return false;
      let kicked = false;
      try {
        void agent.runMaintenance(async (signal) => {
          // Kickoff only: returning here releases the maintenance lock, so the
          // user session stays responsive while the dedicated child runs.
          if (this.disposed || pending.controller.signal.aborted || this.inFlight.get(pending.key) !== pending.controller) return;
          const relay = (): void => pending.controller.abort();
          signal.addEventListener("abort", relay, { once: true });
          const run: Promise<void> = processConfirmedJob(pending.llm, pending.canonicalRoot, pending.jobId, pending.controller.signal, this.ctx, agent).catch(() => undefined).finally(() => {
            signal.removeEventListener("abort", relay);
            this.inFlight.delete(pending.key);
            this.releaseTask(pending.taskKey);
            this.tasks.delete(run);
            if (!this.disposed) this.requestDrive();
          });
          this.tasks.add(run);
          if (this.disposed) pending.controller.abort();
          kicked = true;
        });
      } catch { continue; }
      if (!kicked) return false;
      return true;
    }
    return false;
  }
  /** One-shot, deduplicated idle wake per busy root (maintenance emits no status event). */
  private armIdleWakes(roots: readonly AgentLike[]): void {
    for (const agent of roots) {
      if (this.disposed) return;
      if (this.idleWakes.has(agent)) continue;
      this.idleWakes.add(agent);
      void agent.whenIdle().then(() => { this.idleWakes.delete(agent); if (!this.disposed) this.requestDrive(); }, () => { this.idleWakes.delete(agent); });
    }
  }

  async cancelJob(jobId: string): Promise<boolean> { for (const [key, controller] of this.inFlight) if (key.endsWith(`\0${jobId}`)) controller.abort(); const binding = this.ctx.get("workspaceBinding") as BindingFace | undefined; if (!binding) return false; const listed = await binding.list().catch(() => ({ ok: false, value: undefined } as Awaited<ReturnType<BindingFace["list"]>>)); for (const row of listed.value ?? []) { this.inFlight.get(`${row.canonicalPath}\0${jobId}`)?.abort(); const cancelled = await withExplainJobTransaction(row.canonicalPath, jobId, async () => { for (let attempt = 0; attempt < 20; attempt++) { const record = await readJobRecord(row.canonicalPath, jobId); if (!record) return false; if (record.status === "cancelled") return true; if (!["awaiting-input", "scheduled", "confirmed", "running"].includes(record.status)) return false; const updated = await updateJobRecord(row.canonicalPath, jobId, record.revision, { status: "cancelled", error: "cancelled" }).then(() => true).catch(() => false); if (updated) return true; await new Promise(resolve => setTimeout(resolve, 5)); } return (await readJobRecord(row.canonicalPath, jobId))?.status === "cancelled"; }); if (cancelled) { const timer = this.timers.get(jobId); if (timer) clearTimeout(timer); this.timers.delete(jobId); this.timerTargets.delete(jobId); } if (cancelled || (await readJobRecord(row.canonicalPath, jobId))?.status === "final") return cancelled; } return false; }
  poke(): void { if (this.disposed) return; this.requestDrive(); }
  dispose(): Promise<void> { if (this.disposePromise) return this.disposePromise; this.disposed = true; this.configDispose?.(); this.configDispose = undefined; for (const controller of this.inFlight.values()) controller.abort(); for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); this.timerTargets.clear(); this.disposePromise = (async () => { while (this.tasks.size > 0) await Promise.all([...this.tasks]); this.inFlight.clear(); this.taskInFlight.clear(); })(); return this.disposePromise; }
}
