import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { LlmAdapter } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { buildGraph } from "../src/graph.ts";
import { ExplainRoutesService } from "../src/explain-routes.ts";
import { computeGraphDigest, createJobRecord, finalizeExplain, listReferenceEntries, NONE_REFERENCE_TARGET, prepareExplain, readBatchRecord, readJobRecord, readReferenceText, updateJobRecord, writeBatchRecord } from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";
import { processConfirmedJob } from "../src/explain-scheduler.ts";
import { readValidatedExplainFinal } from "@icomposer/workbench-contracts/ici-explain";

const batchId = "ca4c2958f34fd8df";
const jobIds = ["0000000000000001", "0000000000000002", "0000000000000003", "0000000000000004"] as const;
const apiNames = ["AlphaAPI", "BetaAPI", "GammaAPI", "DeltaAPI"] as const;
type Engine = { explainPrepare(input: { workspaceId: string; query: string }, signal: AbortSignal): Promise<any> };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task059-recovery-")); await mkdir(join(root, "src"), { recursive: true }); await mkdir(join(root, "ref_doc"), { recursive: true });
  for (const [index, name] of apiNames.entries()) await writeFile(join(root, "src", `${name}.groovy`), `class ${name} { def run() { ${index} } }\n`);
  await writeFile(join(root, "ref_doc", "guide.md"), "guide\n");
  const raw = await buildGraph(root, apiNames.map(name => ({ name, type: "api" as const, sourcePath: join(root, "src", `${name}.groovy`) })));
  const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } }; const graphDir = join(root, ".metadata/icomposer/ici/graph/current"); await mkdir(graphDir, { recursive: true }); await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const jobs: any[] = [];
  for (const [index, name] of apiNames.entries()) { const prepared = await prepareExplain(root, "recovery", graph, raw.nodes.find(node => node.id === `api:${name}`)!, []); const job = await createJobRecord(root, { jobId: jobIds[index], workspaceId: "recovery", apiName: name, apiId: `api:${name}`, prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: null, model: null, docs: [], folderPath: "ref_doc" }); jobs.push({ prepared, job }); }
  await writeBatchRecord(root, { schemaVersion: 1, kind: "explain-batch", batchId, workspaceId: "recovery", jobIds: [...jobIds], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); return { root, jobs, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function req(method: string, url: string, body?: unknown): any { const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)); return { method, url, headers: { "x-workbench-action": "1", ...(body === undefined ? {} : { "content-type": "application/json" }), "content-length": String(bytes.byteLength) }, on: () => undefined, async *[Symbol.asyncIterator]() { if (bytes.byteLength > 0) yield bytes; } }; }
function response() { const value: any = { status: 0, body: "", headers: {}, destroyed: false, writableEnded: false, writeHead(status: number, headers: Record<string, string>) { value.status = status; value.headers = headers; }, end(body?: string) { value.body = body ?? ""; value.writableEnded = true; } }; return value; }
function decode(value: any): any { return JSON.parse(value.body); }
const confirmBody = { provider: "mvp", model: "mvp-model", referenceTarget: { path: "ref_doc", kind: "directory" }, docs: [], notBefore: new Date().toISOString(), consent: true };
async function markFailed(root: string, jobId: string): Promise<void> { const job = await readJobRecord(root, jobId); await updateJobRecord(root, jobId, job!.revision, { status: "failed", error: "model-failed" }); }
async function markFinal(root: string, jobId: string): Promise<void> { let job = await readJobRecord(root, jobId); job = await updateJobRecord(root, jobId, job!.revision, { provider: "mvp", model: "mvp-model", status: "scheduled", notBefore: new Date().toISOString() }); job = await updateJobRecord(root, jobId, job.revision, { status: "running" }); await updateJobRecord(root, jobId, job.revision, { status: "final" }); }
async function routeFixture(fx: Awaited<ReturnType<typeof fixture>>, engine: Engine = { explainPrepare: async () => ({ ok: false, error: { code: "storage-error" } }) }) {
  const routes: any[] = []; const ctx: any = new Context(); ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } }); ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "recovery", canonicalPath: fx.root }] }) }); ctx.provide("llm", { listProviders: () => [{ id: "mvp" }], resolveModelInfo: async () => undefined }); ctx.provide("iciEngine", engine); ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async () => false }); ctx.provide("directoryPicker", { capability: () => ({ kind: "native", pick: async () => join(fx.root, "ref_doc") }) }); const fiber: any = await ctx.plugin(ExplainRoutesService); await fiber.await(); return { fiber, handler: routes[0].handler };
}
function retryEngine(fx: Awaited<ReturnType<typeof fixture>>, ids: readonly string[]): Engine { let index = 0; return { explainPrepare: async ({ query }) => { const old = await readJobRecord(fx.root, jobIds[apiNames.indexOf(query as never)]); const id = ids[index++]; await createJobRecord(fx.root, { jobId: id, workspaceId: old!.workspaceId, apiName: old!.apiName, apiId: old!.apiId, prepareArtifactPath: old!.prepareArtifactPath, contextHash: old!.contextHash, prepareId: old!.prepareId, sourceFingerprint: old!.sourceFingerprint, graphDigest: old!.graphDigest, provider: null, model: null, docs: [], folderPath: "ref_doc" }); return { ok: true, value: { jobId: id, jobStatus: "awaiting-input", artifactPath: old!.prepareArtifactPath } }; } }; }
function failingRetryEngine(fx: Awaited<ReturnType<typeof fixture>>, replacement: string): Engine { let calls = 0; return { explainPrepare: async ({ query }) => { if (calls++ > 0) return { ok: false, error: { code: "storage-error" } }; const old = await readJobRecord(fx.root, jobIds[apiNames.indexOf(query as never)]); await createJobRecord(fx.root, { jobId: replacement, workspaceId: old!.workspaceId, apiName: old!.apiName, apiId: old!.apiId, prepareArtifactPath: old!.prepareArtifactPath, contextHash: old!.contextHash, prepareId: old!.prepareId, sourceFingerprint: old!.sourceFingerprint, graphDigest: old!.graphDigest, provider: null, model: null, docs: [], folderPath: "ref_doc" }); return { ok: true, value: { jobId: replacement, jobStatus: "awaiting-input", artifactPath: old!.prepareArtifactPath } }; } }; }

test("TASK-059 reference reads redact Darwin/Linux/Windows absolute paths while retaining raw digest and lines", async () => {
  const fx = await fixture(); const raw = "darwin /Users/alice/project/file.md\nlinux /home/alice/project/file.md\nwindows C:\\Users\\alice\\project\\file.md\nline 4 evidence\n"; try {
    await writeFile(join(fx.root, "ref_doc", "paths.md"), raw); const value = await readReferenceText(fx.root, { path: "ref_doc", kind: "directory" }, "paths.md");
    assert.equal(value.content, "darwin [absolute-path-redacted]\nlinux [absolute-path-redacted]\nwindows [absolute-path-redacted]\nline 4 evidence\n"); assert.equal(value.content.split("\n").length, raw.split("\n").length); assert.equal(value.sha256, createHash("sha256").update(JSON.stringify(raw)).digest("hex")); assert.equal(value.bytes, Buffer.byteLength(value.content, "utf8")); assert.equal(value.content.includes("/Users/"), false); assert.equal(value.content.includes("/home/"), false); assert.equal(value.content.includes("C:\\"), false); await writeFile(join(fx.root, "ref_doc", "secret.md"), "Authorization: Bearer hidden\n"); await assert.rejects(() => readReferenceText(fx.root, { path: "ref_doc", kind: "directory" }, "secret.md"), /folder-forbidden/);
  } finally { await fx.cleanup(); }
});

test("TASK-059 sanitized reference content reaches the child and final without absolute paths", async () => {
  const fx = await fixture(); const raw = "darwin /Users/alice/project/file.md\nlinux /home/alice/project/file.md\nwindows C:\\Users\\alice\\project\\file.md\n"; await writeFile(join(fx.root, "ref_doc", "paths.md"), raw); const adapter = new AbsoluteReferenceAdapter(); const ctx = await realHarness(adapter); const parent = ctx.agentLoop.create(SessionId("task059-reference-prompt"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root }); try { const scheduled = await schedule(fx.root, fx.jobs[0].job.jobId, fx.jobs[0].job.revision); await processConfirmedJob(ctx.llm, fx.root, scheduled.jobId, new AbortController().signal, ctx, parent); const requests = JSON.stringify(adapter.requests); assert.match(requests, /absolute-path-redacted/); assert.equal(requests.includes("/Users/alice"), false); assert.equal(requests.includes("/home/alice"), false); assert.equal(requests.includes("C:\\\\Users\\\\alice"), false); const final = await readValidatedExplainFinal(fx.root, "AlphaAPI", "recovery"); assert.ok(final); assert.equal((await readFile(join(fx.root, final!.artifactPath), "utf8")).includes("/Users/alice"), false); } finally { parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup(); }
});

test("TASK-059 batch retry recovers three failed jobs and preserves the awaiting member", async () => {
  const fx = await fixture(); const replacementIds = ["1000000000000001", "1000000000000002", "1000000000000003"] as const; const setup = await routeFixture(fx, retryEngine(fx, replacementIds)); try {
    await markFailed(fx.root, jobIds[0]); await markFailed(fx.root, jobIds[1]); await markFailed(fx.root, jobIds[2]); const result = response(); await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/retry`, {}), result); assert.equal(decode(result).ok, true); assert.deepEqual((await readBatchRecord(fx.root, batchId))?.jobIds, [...replacementIds, jobIds[3]]); assert.deepEqual(decode(result).result.retried.map((item: any) => item.from), jobIds.slice(0, 3)); assert.equal((await readJobRecord(fx.root, jobIds[3]))?.status, "awaiting-input"); assert.ok((await Promise.all(replacementIds.map(id => readJobRecord(fx.root, id)))).every(job => job?.status === "awaiting-input"));
  } finally { await setup.fiber.dispose(); await fx.cleanup(); }
});

test("TASK-059 batch retry rejects any running member without writes", async () => {
  const fx = await fixture(); let calls = 0; const setup = await routeFixture(fx, { explainPrepare: async () => { calls++; return { ok: true, value: { jobId: "1000000000000001", jobStatus: "awaiting-input" } }; } }); try {
    await markFailed(fx.root, jobIds[0]); let running = await readJobRecord(fx.root, jobIds[1]); running = await updateJobRecord(fx.root, running!.jobId, running!.revision, { provider: "mvp", model: "mvp-model", status: "scheduled", notBefore: new Date().toISOString() }); await updateJobRecord(fx.root, running.jobId, running.revision, { status: "running" }); const before = await readBatchRecord(fx.root, batchId); const result = response(); await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/retry`, {}), result); assert.equal(decode(result).error.code, "job-active"); assert.equal(calls, 0); assert.deepEqual((await readBatchRecord(fx.root, batchId))?.jobIds, before?.jobIds); assert.equal((await readJobRecord(fx.root, jobIds[0]))?.status, "failed"); assert.equal((await readJobRecord(fx.root, jobIds[1]))?.status, "running");
  } finally { await setup.fiber.dispose(); await fx.cleanup(); }
});

test("TASK-059 concurrent batch retries serialize on the batch record and create one replacement", async () => {
  const fx = await fixture(); const replacement = "1000000000000006"; let calls = 0; let entered!: () => void; let release!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; }); const setup = await routeFixture(fx, { explainPrepare: async ({ query }) => { calls++; const old = await readJobRecord(fx.root, jobIds[apiNames.indexOf(query as never)]); await createJobRecord(fx.root, { jobId: replacement, workspaceId: old!.workspaceId, apiName: old!.apiName, apiId: old!.apiId, prepareArtifactPath: old!.prepareArtifactPath, contextHash: old!.contextHash, prepareId: old!.prepareId, sourceFingerprint: old!.sourceFingerprint, graphDigest: old!.graphDigest, provider: null, model: null, docs: [], folderPath: "ref_doc" }); entered(); await gate; return { ok: true, value: { jobId: replacement, jobStatus: "awaiting-input", artifactPath: old!.prepareArtifactPath } }; } }); try {
    await markFailed(fx.root, jobIds[0]); const firstResult = response(); const first = setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/retry`, {}), firstResult); await enteredPromise; const secondResult = response(); const second = setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/retry`, {}), secondResult); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(secondResult.writableEnded, false); release(); await Promise.all([first, second]); assert.equal(calls, 1); assert.equal(decode(firstResult).ok, true); assert.equal(decode(secondResult).error.code, "revision-conflict"); assert.deepEqual((await readBatchRecord(fx.root, batchId))?.jobIds, [replacement, jobIds[1], jobIds[2], jobIds[3]]); assert.equal((await readJobRecord(fx.root, replacement))?.status, "awaiting-input");
  } finally { release(); await setup.fiber.dispose(); await fx.cleanup(); }
});

test("TASK-059 batch retry cleans created replacements and preserves the old batch on failure", async () => {
  const fx = await fixture(); const replacement = "1000000000000005"; const setup = await routeFixture(fx, failingRetryEngine(fx, replacement)); try { await markFailed(fx.root, jobIds[0]); await markFailed(fx.root, jobIds[1]); const before = await readBatchRecord(fx.root, batchId); const result = response(); await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/retry`, {}), result); assert.equal(decode(result).error.code, "storage-error"); assert.deepEqual((await readBatchRecord(fx.root, batchId))?.jobIds, before?.jobIds); assert.equal((await readJobRecord(fx.root, jobIds[0]))?.status, "failed"); assert.equal((await readJobRecord(fx.root, replacement))?.status, "cancelled"); } finally { await setup.fiber.dispose(); await fx.cleanup(); }
});

test("TASK-059 final plus failed retries to final plus awaiting, then confirms only awaiting", async () => {
  const fx = await fixture(); const replacement = "1000000000000004"; const setup = await routeFixture(fx, retryEngine(fx, [replacement])); try {
    await markFinal(fx.root, jobIds[0]); await markFailed(fx.root, jobIds[1]); await markFinal(fx.root, jobIds[2]); await markFinal(fx.root, jobIds[3]); const retry = response(); await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/retry`, {}), retry); assert.equal(decode(retry).ok, true); const replacementJob = await readJobRecord(fx.root, replacement); assert.equal(replacementJob?.status, "awaiting-input"); const beforeFinal = await Promise.all([jobIds[0], jobIds[2], jobIds[3]].map(id => readJobRecord(fx.root, id))); const confirm = response(); await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/confirm`, confirmBody), confirm); assert.equal(decode(confirm).ok, true); assert.equal(decode(confirm).result.applied.length, 1); assert.equal((await readJobRecord(fx.root, replacement))?.status, "scheduled"); for (const job of beforeFinal) assert.equal((await readJobRecord(fx.root, job!.jobId))?.status, "final");
  } finally { await setup.fiber.dispose(); await fx.cleanup(); }
});

function toolCall(id: string, name: string, args: unknown): any[] { const text = JSON.stringify(args); return [{ type: "block-start", index: 0, blockType: "tool-call" }, { type: "tool-call-delta", index: 0, id, name, argumentsDelta: text }, { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: text } }, { type: "finish", reason: { kind: "tool-calls" } }]; }
async function realHarness(adapter: LlmAdapter): Promise<any> { const ctx: any = new Context(); await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); ctx.llm.registerAdapter(["mvp"], adapter); return ctx; }
class AbsoluteReferenceAdapter extends LlmAdapter {
  calls = 0; readonly requests: any[] = [];
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  override listModels(provider: string): Promise<any[]> { return Promise.resolve([{ provider, id: "mvp-model", name: "MVP model" }]); }
  async *stream(options: any): AsyncIterable<any> { this.requests.push(options); const call = this.calls++; if (call === 0) yield* toolCall("list", "ici_explain_list", {}); else if (call === 1) yield* toolCall("read", "ici_explain_read", { path: "paths.md" }); else yield* toolCall("submit", "ici_explain_submit", { technical: "technical", business: "business", flow: ["API reads a request"], evidence: ["ref_doc/paths.md#1"] }); }
}
class FirstIdleThenSubmitAdapter extends LlmAdapter {
  calls = 0; readonly requests: any[] = [];
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  override listModels(provider: string): Promise<any[]> { return Promise.resolve([{ provider, id: "mvp-model", name: "MVP model" }]); }
  async *stream(options: any): AsyncIterable<any> { this.requests.push(options); if (this.calls++ === 0) yield { type: "finish", reason: { kind: "stop" } }; else yield* toolCall("submit", "ici_explain_submit", { technical: "technical", business: "business", flow: ["API reads a request"], evidence: ["src/AlphaAPI.groovy#1"] }); }
}
class AlwaysIdleAdapter extends LlmAdapter {
  calls = 0;
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(): AsyncIterable<any> { this.calls++; yield { type: "finish", reason: { kind: "stop" } }; }
}
class ToolFailureAdapter extends LlmAdapter {
  calls = 0;
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(): AsyncIterable<any> { this.calls++; yield* toolCall("read", "ici_explain_read", { path: "missing.md" }); }
}
async function schedule(root: string, jobId: string, revision: number): Promise<any> { return updateJobRecord(root, jobId, revision, { provider: "mvp", model: "mvp-model", status: "scheduled", notBefore: new Date(Date.now() - 1000).toISOString() }); }

test("TASK-059 no-submit first idle gets one fixed corrective turn, then can submit", async () => {
  const fx = await fixture(); const adapter = new FirstIdleThenSubmitAdapter(); const ctx = await realHarness(adapter); const parent = ctx.agentLoop.create(SessionId("task059-corrective-submit"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root }); try { const scheduled = await schedule(fx.root, fx.jobs[0].job.jobId, fx.jobs[0].job.revision); await processConfirmedJob(ctx.llm, fx.root, scheduled.jobId, new AbortController().signal, ctx, parent); assert.equal(adapter.calls, 2); assert.equal((await readJobRecord(fx.root, scheduled.jobId))?.status, "final"); assert.ok(await readValidatedExplainFinal(fx.root, "AlphaAPI", "recovery")); const correction = String(adapter.requests[1]?.messages?.at(-1)?.content?.[0]?.text ?? ""); assert.match(correction, /ici_explain_list.*ici_explain_read.*ici_explain_submit.*ici_explain_submit/); assert.doesNotMatch(correction, /source|paths?|secret/i); } finally { parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup(); }
});

test("TASK-059 second idle without submit fails model-failed after exactly two turns", async () => {
  const fx = await fixture(); const adapter = new AlwaysIdleAdapter(); const ctx = await realHarness(adapter); const parent = ctx.agentLoop.create(SessionId("task059-corrective-fail"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root }); try { const scheduled = await schedule(fx.root, fx.jobs[0].job.jobId, fx.jobs[0].job.revision); await processConfirmedJob(ctx.llm, fx.root, scheduled.jobId, new AbortController().signal, ctx, parent); const after = await readJobRecord(fx.root, scheduled.jobId); assert.equal(adapter.calls, 2); assert.equal(after?.status, "failed"); assert.equal(after?.error, "model-failed"); } finally { parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup(); }
});

test("TASK-059 first-turn tool failure does not receive a corrective retry", async () => {
  const fx = await fixture(); const adapter = new ToolFailureAdapter(); const ctx = await realHarness(adapter); const parent = ctx.agentLoop.create(SessionId("task059-tool-failure"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root }); try { const scheduled = await schedule(fx.root, fx.jobs[0].job.jobId, fx.jobs[0].job.revision); await processConfirmedJob(ctx.llm, fx.root, scheduled.jobId, new AbortController().signal, ctx, parent); const after = await readJobRecord(fx.root, scheduled.jobId); assert.equal(adapter.calls, 1); assert.equal(after?.status, "failed"); assert.equal(after?.error, "folder-forbidden"); } finally { parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup(); }
});

function abortedFinish(): any[] { return [{ type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "provider aborted" } } }]; }

class AbortedOnceThenSubmitAdapter extends LlmAdapter {
  calls = 0; readonly requests: any[] = [];
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(options: any): AsyncIterable<any> { this.requests.push(options); if (this.calls++ === 0) yield* abortedFinish(); else yield* toolCall("submit", "ici_explain_submit", { technical: "technical", business: "business", flow: ["API reads a request"], evidence: ["src/AlphaAPI.groovy#1"] }); }
}

class AlwaysAbortedAdapter2 extends LlmAdapter {
  calls = 0;
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(): AsyncIterable<any> { this.calls++; yield* abortedFinish(); }
}

class NoneSubmitAdapter extends LlmAdapter {
  calls = 0; readonly requests: any[] = [];
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(options: any): AsyncIterable<any> { this.requests.push(options); this.calls++; if (this.calls === 1) yield* toolCall("submit", "ici_explain_submit", { technical: "technical", business: "business", flow: ["API reads a request"], evidence: ["src/AlphaAPI.groovy#1"] }); else yield { type: "finish", reason: { kind: "stop" } }; }
}

test("TASK-060 stream abort is attributed stream-aborted, gets one retry, then submits", async () => {
  const fx = await fixture(); const adapter = new AbortedOnceThenSubmitAdapter(); const ctx = await realHarness(adapter); const parent = ctx.agentLoop.create(SessionId("task060-abort-retry"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root }); try { const scheduled = await schedule(fx.root, fx.jobs[0].job.jobId, fx.jobs[0].job.revision); await processConfirmedJob(ctx.llm, fx.root, scheduled.jobId, new AbortController().signal, ctx, parent); const after = await readJobRecord(fx.root, scheduled.jobId); assert.equal(adapter.calls, 2); assert.equal(after?.status, "final"); assert.ok(after?.childSessionId && /^[0-9a-f-]{36}$/i.test(after.childSessionId)); assert.ok(after?.startedAt?.endsWith("Z")); assert.ok(after?.finishedAt?.endsWith("Z")); const correction = String(adapter.requests[1]?.messages?.at(-1)?.content?.[0]?.text ?? ""); assert.match(correction, /aborted/); assert.match(correction, /ici_explain_submit/); } finally { parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup(); }
});

test("TASK-060 twice-aborted child fails with stream-aborted after two turns", async () => {
  const fx = await fixture(); const adapter = new AlwaysAbortedAdapter2(); const ctx = await realHarness(adapter); const parent = ctx.agentLoop.create(SessionId("task060-abort-fail"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root }); try { const scheduled = await schedule(fx.root, fx.jobs[0].job.jobId, fx.jobs[0].job.revision); await processConfirmedJob(ctx.llm, fx.root, scheduled.jobId, new AbortController().signal, ctx, parent); const after = await readJobRecord(fx.root, scheduled.jobId); assert.equal(adapter.calls, 2); assert.equal(after?.status, "failed"); assert.equal(after?.error, "stream-aborted"); assert.ok(after?.childSessionId); assert.ok(after?.finishedAt?.endsWith("Z")); } finally { parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup(); }
});

test("TASK-060 status routes expose run metadata without absolute paths", async () => {
  const fx = await fixture(); const setup = await routeFixture(fx); try {
    const sessionId = "123e4567-e89b-12d3-a456-426614174000";
    const startedAt = "2026-08-27T01:02:03.000Z"; const finishedAt = "2026-08-27T01:03:00.000Z";
    await markFailed(fx.root, jobIds[0]);
    const failed = await readJobRecord(fx.root, jobIds[0]);
    await updateJobRecord(fx.root, jobIds[0], failed!.revision, { childSessionId: sessionId, startedAt, finishedAt });
    const batch = response(); await setup.handler(req("GET", `/api/icomposer-workbench/ici/explain/batches/${batchId}/status`), batch); const view = decode(batch);
    const row = view.result.jobs.find((job: any) => job.jobId === jobIds[0]);
    assert.equal(row.childSessionId, sessionId); assert.equal(row.startedAt, startedAt); assert.equal(row.finishedAt, finishedAt); assert.equal(row.provider, null); assert.equal(row.model, null); assert.equal(batch.body.includes(fx.root), false); assert.equal(batch.body.includes(sessionId), true);
    const single = response(); await setup.handler(req("GET", `/api/icomposer-workbench/ici/explain/jobs/${jobIds[0]}/status`), single); const singleView = decode(single);
    assert.equal(singleView.result.job.childSessionId, sessionId); assert.equal(singleView.result.job.startedAt, startedAt); assert.equal(singleView.result.job.finishedAt, finishedAt); assert.equal(single.body.includes(fx.root), false);
  } finally { await setup.fiber.dispose(); await fx.cleanup(); }
});

test("TASK-061 none target: list empty, read denied, no filesystem assertion", async () => {
  const fx = await fixture(); try {
    assert.deepEqual(await listReferenceEntries(fx.root, NONE_REFERENCE_TARGET), []);
    assert.deepEqual(await listReferenceEntries(fx.root, NONE_REFERENCE_TARGET, "ref_doc"), []);
    await assert.rejects(() => readReferenceText(fx.root, NONE_REFERENCE_TARGET, "ref_doc/guide.md"));
    await assert.rejects(() => readReferenceText(fx.root, { path: "ref_doc", kind: "none" }, "ref_doc/guide.md"));
    await assert.rejects(() => listReferenceEntries(fx.root, { path: "ref_doc", kind: "none" }));
  } finally { await fx.cleanup(); }
});

test("TASK-061 finalize rejects nonempty folderReads for none target", async () => {
  const fx = await fixture(); try {
    const analysis = { api: { technical: "technical", business: "business", flow: ["API reads a request"], evidence: ["src/AlphaAPI.groovy#1"] } };
    const current = { sourceFingerprint: fx.jobs[0].job.sourceFingerprint, graphDigest: fx.jobs[0].job.graphDigest, engineVersion: ICI_ENGINE_VERSION };
    await assert.rejects(() => finalizeExplain(fx.root, "recovery", fx.jobs[0].prepared.artifactPath, analysis, current, undefined, "3333333333333333", [{ path: "ref_doc/guide.md", sha256: "a".repeat(64) }], "", NONE_REFERENCE_TARGET), /folder-changed/);
    const ok = await finalizeExplain(fx.root, "recovery", fx.jobs[0].prepared.artifactPath, analysis, current, undefined, "4444444444444444", [], "", NONE_REFERENCE_TARGET);
    assert.ok(ok.artifactPath.includes("4444444444444444"));
  } finally { await fx.cleanup(); }
});

test("TASK-061 single none confirm schedules, restricted child submits without reference, final records none", async () => {
  const fx = await fixture(); const adapter = new NoneSubmitAdapter(); const ctx = await realHarness(adapter); const parent = ctx.agentLoop.create(SessionId("task061-none-child"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root }); const setup = await routeFixture(fx); try {
    const confirmBodyNone = { ...confirmBody, referenceTarget: { path: "", kind: "none" }, notBefore: new Date(Date.now() - 1000).toISOString() };
    const confirmed = response(); await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/confirm`, confirmBodyNone), confirmed); assert.equal(decode(confirmed).ok, true); assert.equal(decode(confirmed).result.jobs, 4);
    const job = await readJobRecord(fx.root, jobIds[0]); assert.equal(job?.status, "scheduled"); assert.equal(job?.referenceTarget?.kind, "none"); assert.equal(job?.folderPath, "");
    await processConfirmedJob(ctx.llm, fx.root, jobIds[0], new AbortController().signal, ctx, parent);
    const after = await readJobRecord(fx.root, jobIds[0]); assert.equal(after?.status, "final"); assert.equal(after?.referenceTarget?.kind, "none");
    const correction = JSON.stringify(adapter.requests[0]?.messages?.[0] ?? ""); assert.match(correction, /No optional reference selected/);
    assert.equal(adapter.calls, 1);
  } finally { parent.cancel("cancelled"); await parent.whenIdle(); await setup.fiber.dispose(); await fx.cleanup(); }
});
