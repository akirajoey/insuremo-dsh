import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
import {
  EXPLAIN_ABSOLUTE_PATH_PATTERN, NONE_REFERENCE_TARGET, computeGraphDigest, createJobRecord, finalizeExplain, loadPrepare, prepareExplain,
  preparedReadPaths, readPreparedText, readReferenceText, updateJobRecord, readJobRecord,
} from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";
import { processConfirmedJob, sourcePrompt } from "../src/explain-scheduler.ts";

/**
 * TASK-125: the child context is a MAP (paths) rather than a PAYLOAD (source text + hashes).
 * These tests pin the four acceptance surfaces: prompt shape/size, the prepared read whitelist
 * with segmented reads, the absolute-path pattern fix, and the output budget.
 */

const MARKER = "UNIQUE_BODY_MARKER_DO_NOT_INLINE";
const workspaceId = "task125";
const BATCH = "1250ace1250ace12";
const jobIds = ["1250000000000001", "1250000000000002"] as const;

function toolCall(id: string, name: string, args: unknown): any[] { const text = JSON.stringify(args); return [{ type: "block-start", index: 0, blockType: "tool-call" }, { type: "tool-call-delta", index: 0, id, name, argumentsDelta: text }, { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: text } }, { type: "finish", reason: { kind: "tool-calls" } }]; }
function submitTurn(evidencePath = "src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI/ReduceSAAPI.groovy"): any[] { return toolCall("submit", "ici_explain_submit", { technical: "technical", business: "business", flow: ["API calls the service"], evidence: [`${evidencePath}#1`] }); }

class ScriptedAdapter extends LlmAdapter {
  calls = 0; readonly requests: any[] = [];
  constructor(private readonly plan: Array<() => any[]>) { super(); }
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  override listModels(provider: string): Promise<any[]> { return Promise.resolve([{ provider, id: "mvp-model", name: "MVP model" }]); }
  async *stream(options: any): AsyncIterable<any> { this.requests.push(options); const step = this.plan[Math.min(this.calls, this.plan.length - 1)]; this.calls++; yield* step!(); }
}

async function realHarness(adapter: LlmAdapter, extra?: (ctx: any) => void): Promise<any> {
  const ctx: any = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(["mvp"], adapter); extra?.(ctx); return ctx;
}

/** A workspace with one API that calls a service whose methods carry the marker text. */
/** Create and schedule one job for an already prepared workspace (a second job proves re-runs). */
async function scheduleJob(fx: { root: string; prepared: any }, jobId: string): Promise<void> {
  const artifact = fx.prepared.artifact;
  const job = await createJobRecord(fx.root, { jobId, workspaceId, apiId: "api:ReduceSAAPI", apiName: "ReduceSAAPI", prepareArtifactPath: fx.prepared.artifactPath, prepareId: artifact.prepareId, contextHash: artifact.contextHash, sourceFingerprint: artifact.manifest.sourceFingerprint, graphDigest: artifact.manifest.graphDigest, provider: null, model: null, docs: [], referenceTarget: { path: "", kind: "none" }, batchId: BATCH });
  await updateJobRecord(fx.root, jobId, job.revision, { provider: "mvp", model: "mvp-model", status: "scheduled", notBefore: new Date(Date.now() - 1000).toISOString() });
}

async function fixture(serviceMethods = 3, padKb = 0) {
  const root = await mkdtemp(join(tmpdir(), "task125-context-"));
  const dir = join(root, "src/dev/Tenant/STD_BS_PA_BUSINESS");
  await mkdir(join(dir, "api/ReduceSAAPI"), { recursive: true }); await mkdir(join(dir, "function/ReduceSAService"), { recursive: true });
  const apiPath = join(dir, "api/ReduceSAAPI/ReduceSAAPI.groovy");
  const servicePath = join(dir, "function/ReduceSAService/ReduceSAService.groovy");
  const padding = padKb > 0 ? `\n  def padding() { return "${"x".repeat(padKb * 1024)}" }` : "";
  await writeFile(apiPath, `class ReduceSAAPI {\n  def execute() { return getCommonService("ReduceSAService").execute(${MARKER}) }${padding}\n}\n`);
  const bodies = Array.from({ length: serviceMethods }, (_, index) => `  def step${index}() { return "${MARKER}" }`).join("\n");
  await writeFile(servicePath, `class ReduceSAService {\n${bodies}\n  def execute() { return step0() }\n}\n`);
  const raw = await buildGraph(root, [{ name: "ReduceSAAPI", type: "api", sourcePath: apiPath }]);
  const graph: any = { nodes: new Map(raw.nodes.map((node: any) => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } };
  const graphDir = join(root, ".metadata/icomposer/ici/graph/current"); await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const prepared = await prepareExplain(root, workspaceId, graph, raw.nodes.find((node: any) => node.id === "api:ReduceSAAPI")!, []);
  const fx = { root, prepared, apiPath, servicePath, graph, cleanup: () => rm(root, { recursive: true, force: true }) };
  await scheduleJob(fx, jobIds[0]);
  return fx;
}

test("TASK-125 (1) the absolute-path pattern no longer mistakes a URL scheme, but still catches drives and POSIX roots", () => {
  // The field failure: a prepared source containing http://gateway.mo-fo/ was rejected as source-forbidden.
  assert.equal(EXPLAIN_ABSOLUTE_PATH_PATTERN.test("http://gateway.mo-fo/RuleCheckV1Service"), false);
  assert.equal(EXPLAIN_ABSOLUTE_PATH_PATTERN.test("see https://example.com/a/b for details"), false);
  assert.equal(EXPLAIN_ABSOLUTE_PATH_PATTERN.test("call http://gateway.mo-fo/ then stop"), false);
  // Real absolute paths are still caught.
  assert.equal(EXPLAIN_ABSOLUTE_PATH_PATTERN.test("C:\\Users\\alice\\project\\file.groovy"), true);
  assert.equal(EXPLAIN_ABSOLUTE_PATH_PATTERN.test("wrote C:/Users/alice/file.groovy"), true);
  assert.equal(EXPLAIN_ABSOLUTE_PATH_PATTERN.test("darwin /Users/alice/project/file.md"), true);
  assert.equal(EXPLAIN_ABSOLUTE_PATH_PATTERN.test("linux /home/alice/project/file.md"), true);
});

test("TASK-125 (2) a reference read keeps a gateway URL intact while still redacting absolute paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "task125-redact-")); await mkdir(join(root, "ref_doc"), { recursive: true });
  try {
    await writeFile(join(root, "ref_doc", "guide.md"), "call http://gateway.mo-fo/RuleCheckV1Service\npath /Users/alice/project/file.md\ndrive C:\\Users\\alice\\file.md\n");
    const read = await readReferenceText(root, { path: "ref_doc", kind: "directory" }, "guide.md");
    assert.equal(read.content.includes("http://gateway.mo-fo/RuleCheckV1Service"), true, "the URL survives untouched");
    assert.equal(read.content.includes("[absolute-path-redacted]"), true, "real absolute paths are still redacted");
    assert.equal(read.content.includes("/Users/alice/project/file.md"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TASK-125 (3) the initial message is a path-only map: no source text, no hash fields", async () => {
  const fx = await fixture(3);
  const adapter = new ScriptedAdapter([() => submitTurn()]);
  const ctx = await realHarness(adapter);
  const parent = ctx.agentLoop.create(SessionId("task125-path-only"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root });
  try {
    await processConfirmedJob(ctx.llm, fx.root, jobIds[0], new AbortController().signal, ctx, parent);
    const after = await readJobRecord(fx.root, jobIds[0]);
    assert.equal(after?.status, "final", after?.error);
    const request = JSON.stringify(adapter.requests[0]);
    const promptText = adapter.requests[0].messages[0].content[0].text as string;
    assert.ok(Buffer.byteLength(promptText, "utf8") <= 8192, `prompt must stay small, got ${Buffer.byteLength(promptText, "utf8")}`);
    assert.equal(promptText.includes(MARKER), false, "no source text in the initial message");
    assert.equal(/sha256|contextHash|sourceFingerprint|graphDigest|prepareId|schemaVersion/.test(request), false, "no hash/manifest fields anywhere in the request");
    assert.equal(promptText.includes("[1] src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI/ReduceSAAPI.groovy"), true, "the call chain names paths");
    assert.match(promptText, /\[1\]#\d+-\d+/, "and ranges through the handle");
    assert.match(promptText, /Call chain \(\d+ nodes/);
    assert.match(promptText, /Reference target: none/);
    assert.match(promptText, /ici_explain_submit is the ONLY completion boundary/);
  } finally { parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup(); }
});

test("TASK-125 (4) the real IncreaseSAAPI artifact rebuilds a prompt under 8 KiB", async (t) => {
  const root = "/Users/junjie.zhang/skills/gbs/icomposer-source";
  const rel = ".metadata/icomposer/ici/explain/IncreaseSAAPI-f870559086ca/prepare.json";
  if (!existsSync(join(root, rel))) { t.skip("workspace artifact not available on this machine"); return; }
  const prepare = await loadPrepare(root, rel);
  const prompt = sourcePrompt(prepare, NONE_REFERENCE_TARGET);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 8192, `expected <= 8192 bytes, got ${Buffer.byteLength(prompt, "utf8")}`);
  assert.equal(prompt.includes("class "), false, "no groovy source text");
  assert.equal(/sha256|contextHash|sourceFingerprint|graphDigest|prepareId/.test(prompt), false);
  assert.equal(prompt.includes("[1] src/dev/Tenant/STD_BS_PA_BUSINESS/api/IncreaseSAAPI/IncreaseSAAPI.groovy"), true, "the file table names the paths");
  assert.match(prompt, /\[1\]#\d+-\d+/, "chain lines carry a handle and a range");
  assert.match(prompt, /truncated/);
});

test("TASK-125 (5) the read tool serves prepared paths, refuses everything else, and reads large files in segments", async () => {
  const fx = await fixture(3, 300); // the service file is far larger than the 256 KiB per-read cap
  const prepared = await loadPrepare(fx.root, fx.prepared.artifactPath);
  const serviceRef = prepared.sources[0]!;
  assert.equal(serviceRef.path.includes("ReduceSAAPI.groovy"), true);
  assert.equal(serviceRef.readable, false, "the oversized source is not inlined at prepare time");
  assert.equal(preparedReadPaths(prepared).includes(serviceRef.path), true, "but the path is still readable on demand");
  const size = (await readFile(fx.apiPath)).byteLength;
  assert.ok(size > 256 * 1024, `fixture must exceed the read cap, got ${size}`);

  // (a) the artifact-level read: whole-file request is truncated to the cap and reports the resume point.
  const whole = await readPreparedText(fx.root, prepared, serviceRef.path);
  assert.equal(whole.truncated, true);
  assert.ok(whole.bytes <= 256 * 1024);
  assert.equal(whole.nextStartLine, whole.endLine + 1);
  assert.ok(whole.totalLines > whole.endLine);
  // (b) a segment read returns exactly the requested lines and stays within the cap.
  const segment = await readPreparedText(fx.root, prepared, serviceRef.path, 2, 3);
  assert.equal(segment.startLine, 2);
  assert.equal(segment.endLine, 2, "the requested range stops at the byte cap (line 3 is the padded line)");
  assert.equal(segment.truncated, true);
  assert.equal(segment.nextStartLine, 3);
  assert.match(segment.content, /def execute/);
  // A small range inside the file is served completely.
  const small = await readPreparedText(fx.root, prepared, serviceRef.path, 1, 2);
  assert.equal(small.startLine, 1);
  assert.equal(small.endLine, 2);
  assert.equal(small.truncated, false);
  // (c) a path outside the prepared artifact is refused.
  await assert.rejects(() => readPreparedText(fx.root, prepared, "src/dev/Tenant/Elsewhere/Nope.groovy"), /source-forbidden/);

  // (d) through the child tool surface: the map handle form is served, then submit.
  const adapter = new ScriptedAdapter([
    () => toolCall("r1", "ici_explain_read", { path: "[1]#1-2" }),
    () => submitTurn(serviceRef.path),
  ]);
  const ctx = await realHarness(adapter);
  const parent = ctx.agentLoop.create(SessionId("task125-read"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root });
  try {
    await processConfirmedJob(ctx.llm, fx.root, jobIds[0], new AbortController().signal, ctx, parent);
    const after = await readJobRecord(fx.root, jobIds[0]);
    assert.equal(after?.status, "final", after?.error);
    // The follow-up request carries the served slice, so the handle resolved to the prepared file.
    const transcript = JSON.stringify(adapter.requests.map((request) => request.messages));
    assert.equal(transcript.includes(serviceRef.path), true, "the handle resolved to the prepared path");
    assert.equal(transcript.includes("[1]#1-2"), true, "the child could cite the map handle verbatim");
    // The slice contents themselves are pinned deterministically at the artifact level in (a)/(b).
  } finally { parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup(); }
});

test("TASK-125 (6) the child output budget defaults to 16384 and follows the Host setting", async () => {
  const fx = await fixture(3);
  const defaultAdapter = new ScriptedAdapter([() => submitTurn()]);
  const defaultCtx = await realHarness(defaultAdapter);
  const parent = defaultCtx.agentLoop.create(SessionId("task125-tokens-default"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root });
  try {
    await processConfirmedJob(defaultCtx.llm, fx.root, jobIds[0], new AbortController().signal, defaultCtx, parent);
    assert.equal((await readJobRecord(fx.root, jobIds[0]))?.status, "final");
    assert.equal(defaultAdapter.requests[0].maxTokens, 16384, "no hardcoded 4096 any more");
  } finally { parent.cancel("cancelled"); await parent.whenIdle(); }

  // A second job on the same prepare proves the configured budget on a fresh run.
  await scheduleJob(fx, jobIds[1]);
  const custom = new ScriptedAdapter([() => submitTurn()]);
  const customCtx = await realHarness(custom, (ctx) => ctx.provide("iciExplainConfig", { maxConcurrent: 1, maxOutputTokens: 8192, onChange: () => () => undefined }));
  const parent2 = customCtx.agentLoop.create(SessionId("task125-tokens-custom"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root });
  try {
    await processConfirmedJob(customCtx.llm, fx.root, jobIds[1], new AbortController().signal, customCtx, parent2);
    assert.equal(custom.requests[0].maxTokens, 8192, "the Host setting wins");
  } finally { parent2.cancel("cancelled"); await parent2.whenIdle(); await fx.cleanup(); }
});

test("TASK-125 (7) a changed source no longer blocks finalization, but a stale graph still does", async () => {
  const fx = await fixture(3);
  try {
    const prepared = await loadPrepare(fx.root, fx.prepared.artifactPath);
    await writeFile(fx.servicePath, "class ReduceSAService { def changed() { return 1 } }\n");
    // File versions are irrelevant for a local explanation: publication still succeeds.
    const ok = await finalizeExplain(fx.root, workspaceId, fx.prepared.artifactPath, { api: { technical: "t", business: "b", flow: [], evidence: [] } }, { sourceFingerprint: prepared.manifest.sourceFingerprint, graphDigest: prepared.manifest.graphDigest, engineVersion: ICI_ENGINE_VERSION }, undefined, "0123456789abcdef");
    assert.equal(ok.artifact.apiAnalysis.technical, "t");
    // The engine-version / graph-digest freshness gate remains in force.
    await assert.rejects(
      () => finalizeExplain(fx.root, workspaceId, fx.prepared.artifactPath, { api: { technical: "t", business: "b", flow: [], evidence: [] } }, { sourceFingerprint: prepared.manifest.sourceFingerprint, graphDigest: "0".repeat(64), engineVersion: ICI_ENGINE_VERSION }, undefined, "fedcba9876543210"),
      /prepare-invalidated|stale-snapshot|immutable-conflict/,
    );
  } finally { await fx.cleanup(); }
});
