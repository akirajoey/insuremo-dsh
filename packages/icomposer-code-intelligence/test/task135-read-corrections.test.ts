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
import { computeGraphDigest, createJobRecord, loadPrepare, prepareExplain, readPreparedText, readJobRecord, updateJobRecord } from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";
import { processConfirmedJob } from "../src/explain-scheduler.ts";

/**
 * TASK-135 (IssuePolicyAPI root cause): a swapped or out-of-range read request must be correctable,
 * a genuinely failing range must be labelled `source-range` (never collapsed to model-failed), and a
 * prepared-file read (full path or map handle) must reach the prepared content.
 */

const workspaceId = "task135";
const JOB = "1350000000000001";
const API = "PolicyAPI";
const EVIDENCE = ["src/dev/Tenant/STD/api/PolicyAPI/PolicyAPI.groovy#1"];

function toolCall(id: string, name: string, args: unknown): any[] { const text = JSON.stringify(args); return [{ type: "block-start", index: 0, blockType: "tool-call" }, { type: "tool-call-delta", index: 0, id, name, argumentsDelta: text }, { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: text } }, { type: "finish", reason: { kind: "tool-calls" } }]; }
function submitTurn(): any[] { return toolCall("submit", "ici_explain_submit", { technical: "t", business: "b", flow: ["API does its job"], evidence: EVIDENCE }); }

class ScriptedAdapter extends LlmAdapter {
  calls = 0; readonly requests: any[] = [];
  constructor(private readonly plan: Array<() => any[]>) { super(); }
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  override listModels(provider: string): Promise<any[]> { return Promise.resolve([{ provider, id: "mvp-model", name: "MVP model" }]); }
  async *stream(options: any): AsyncIterable<any> { this.requests.push(options); const step = this.plan[Math.min(this.calls, this.plan.length - 1)]!; this.calls++; yield* step(); }
}

async function harness(adapter: LlmAdapter): Promise<any> {
  const ctx: any = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(["mvp"], adapter); return ctx;
}

async function fixture(lines = 40) {
  const root = await mkdtemp(join(tmpdir(), "task135-read-"));
  const dir = join(root, "src/dev/Tenant/STD/api/PolicyAPI");
  await mkdir(dir, { recursive: true });
  const body = Array.from({ length: lines }, (_, index) => `  def step${index}() { return ${index} }`).join("\n");
  const path = join(dir, "PolicyAPI.groovy");
  await writeFile(path, `class PolicyAPI {\n${body}\n}\n`);
  const raw = await buildGraph(root, [{ name: API, type: "api", sourcePath: path }]);
  const graph: any = { nodes: new Map(raw.nodes.map((node: any) => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } };
  const graphDir = join(root, ".metadata/icomposer/ici/graph/current"); await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const prepared = await prepareExplain(root, workspaceId, graph, raw.nodes.find((node: any) => node.id === `api:${API}`)!, []);
  const artifact = prepared.artifact;
  const job = await createJobRecord(root, { jobId: JOB, workspaceId, apiId: `api:${API}`, apiName: API, prepareArtifactPath: prepared.artifactPath, prepareId: artifact.prepareId, contextHash: artifact.contextHash, sourceFingerprint: artifact.manifest.sourceFingerprint, graphDigest: artifact.manifest.graphDigest, provider: null, model: null, docs: [], referenceTarget: { path: "", kind: "none" } });
  await updateJobRecord(root, JOB, job.revision, { provider: "mvp", model: "mvp-model", status: "scheduled", notBefore: new Date(Date.now() - 1000).toISOString() });
  return { root, prepared, path, lines, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function runChild(fx: Awaited<ReturnType<typeof fixture>>, plan: Array<() => any[]>): Promise<{ adapter: ScriptedAdapter; status?: string; error?: string }> {
  const adapter = new ScriptedAdapter(plan);
  const ctx = await harness(adapter);
  const parent = ctx.agentLoop.create(SessionId(`task135-${Math.random().toString(16).slice(2)}`), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root });
  try {
    await processConfirmedJob(ctx.llm, fx.root, JOB, new AbortController().signal, ctx, parent);
    const record = await readJobRecord(fx.root, JOB);
    return { adapter, status: record?.status, error: record?.error };
  } finally { parent.cancel("cancelled"); await parent.whenIdle(); }
}

test("TASK-135 (1) an artifact-level read normalises a swapped range and names totalLines when past EOF", async () => {
  const fx = await fixture(40);
  try {
    const prepare = await loadPrepare(fx.root, fx.prepared.artifactPath);
    const path = prepare.sources[0]!.path;
    // Swapped range: normalised, both directions read the same lines.
    const swapped = await readPreparedText(fx.root, prepare, path, 12, 3);
    const straight = await readPreparedText(fx.root, prepare, path, 3, 12);
    assert.equal(swapped.content, straight.content);
    assert.equal(swapped.startLine, 3);
    assert.equal(swapped.endLine, 12);
    assert.ok(swapped.totalLines > 12);
    // Past the end: a corrective message that names the file and its line count.
    await assert.rejects(() => readPreparedText(fx.root, prepare, path, swapped.totalLines + 500, swapped.totalLines + 600), (error: Error) => {
      assert.match(error.message, /^source-range: startLine \d+ is past the end of .*PolicyAPI\.groovy \(totalLines \d+\)$/);
      return true;
    });
  } finally { await fx.cleanup(); }
});

test("TASK-135 (2) a single bad range no longer kills the job: the child corrects itself and reaches final", async () => {
  const fx = await fixture(40);
  try {
    const path = fx.prepared.artifact.sources.find(() => true)!.path;
    const { adapter, status, error } = await runChild(fx, [
      () => toolCall("r1", "ici_explain_read", { path, startLine: 30, endLine: 5 }),
      () => toolCall("r2", "ici_explain_read", { path, startLine: 1, endLine: 5 }),
      () => submitTurn(),
    ]);
    assert.equal(status, "final", `expected final, got ${status} (${error})`);
    const transcript = JSON.stringify(adapter.requests.map((request) => request.messages));
    assert.equal(transcript.includes(path), true);
  } finally { await fx.cleanup(); }
});

test("TASK-135 (3) three bad ranges fail the job labelled source-range, not model-failed", async () => {
  const fx = await fixture(40);
  try {
    const prepare = await loadPrepare(fx.root, fx.prepared.artifactPath);
    const path = prepare.sources[0]!.path;
    const total = (await readPreparedText(fx.root, prepare, path, 1, 1)).totalLines;
    let n = 0;
    const bad = () => toolCall(`bad-${++n}`, "ici_explain_read", { path, startLine: total + 100, endLine: total + 200 });
    const { status, error } = await runChild(fx, [bad, bad, bad, () => submitTurn()]);
    assert.equal(status, "failed");
    assert.equal(error, "source-range", "the job must carry the real code");
  } finally { await fx.cleanup(); }
});

test("TASK-135 (4) a single TRUE past-EOF range is correctable (never fatal): read it, fix the range, submit", async () => {
  const fx = await fixture(40);
  try {
    const prepare = await loadPrepare(fx.root, fx.prepared.artifactPath);
    const path = prepare.sources[0]!.path;
    const total = (await readPreparedText(fx.root, prepare, path, 1, 1)).totalLines;
    const { adapter, status, error } = await runChild(fx, [
      () => toolCall("oob-1", "ici_explain_read", { path, startLine: total + 100, endLine: total + 200 }),
      () => toolCall("ok-1", "ici_explain_read", { path, startLine: 1, endLine: 5 }),
      () => submitTurn(),
    ]);
    assert.equal(status, "final", `a single out-of-range read must not kill the job (got ${status}, error=${error})`);
    // The child was told what went wrong, including the file's line count, so one fix was enough.
    const transcript = JSON.stringify(adapter.requests.map((request) => request.messages));
    assert.match(transcript, /source-range: startLine \d+ is past the end of/);
    assert.match(transcript, new RegExp(`totalLines ${total}`));
    // The corrected read really returned the prepared content (not a correction notice).
    assert.equal(transcript.includes("step1()"), true);
  } finally { await fx.cleanup(); }
});
