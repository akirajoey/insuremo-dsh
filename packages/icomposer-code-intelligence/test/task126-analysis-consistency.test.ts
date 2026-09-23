import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
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
  computeGraphDigest, createJobRecord, finalizeExplain, loadPrepare, prepareExplain, readJobRecord, setExplainFinalizeFailpoint, updateJobRecord, validAnalysis,
} from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";
import { processConfirmedJob } from "../src/explain-scheduler.ts";
import { readValidatedExplainFinal } from "@icomposer/workbench-contracts/ici-explain";

/**
 * TASK-126: the submit side and the publish side must apply ONE rule set. The publish side used to
 * additionally reject any ".." substring in a flow item, which made ordinary Groovy varargs text
 * (`Long.valueOf(String.valueOf(...))`) un-publishable, and the resulting analysis-invalid was
 * mapped to model-failed because the scheduler's known-error set lacked it.
 */

const workspaceId = "task126";
const BATCH = "1260ace1260ace12";
const jobIds = ["1260000000000001", "1260000000000002"] as const;
const VARARGS_FLOW = "String.valueOf(Long.valueOf(String.valueOf(...)))";
const FIELD_ROOT = "/Users/junjie.zhang/skills/gbs/icomposer-source";
const FIELD_EXPLAIN = `${FIELD_ROOT}/.metadata/icomposer/ici/explain`;

function toolCall(id: string, name: string, args: unknown): any[] { const text = JSON.stringify(args); return [{ type: "block-start", index: 0, blockType: "tool-call" }, { type: "tool-call-delta", index: 0, id, name, argumentsDelta: text }, { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: text } }, { type: "finish", reason: { kind: "tool-calls" } }]; }

class SubmitAdapter extends LlmAdapter {
  calls = 0; readonly requests: any[] = [];
  constructor(private readonly flow: string[]) { super(); }
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  override listModels(provider: string): Promise<any[]> { return Promise.resolve([{ provider, id: "mvp-model", name: "MVP model" }]); }
  async *stream(options: any): AsyncIterable<any> { this.requests.push(options); this.calls++; yield* toolCall("submit", "ici_explain_submit", { technical: "technical", business: "business", flow: this.flow, evidence: ["src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI/ReduceSAAPI.groovy#1"] }); }
}

async function harness(adapter: LlmAdapter): Promise<any> {
  const ctx: any = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(["mvp"], adapter); return ctx;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task126-analysis-"));
  const dir = join(root, "src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI");
  await mkdir(dir, { recursive: true });
  const apiPath = join(dir, "ReduceSAAPI.groovy");
  await writeFile(apiPath, `class ReduceSAAPI {\n  def execute() { return String.valueOf(Long.valueOf(String.valueOf(...))) }\n}\n`);
  const raw = await buildGraph(root, [{ name: "ReduceSAAPI", type: "api", sourcePath: apiPath }]);
  const graph: any = { nodes: new Map(raw.nodes.map((node: any) => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } };
  const graphDir = join(root, ".metadata/icomposer/ici/graph/current"); await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const prepared = await prepareExplain(root, workspaceId, graph, raw.nodes.find((node: any) => node.id === "api:ReduceSAAPI")!, []);
  const artifact = prepared.artifact;
  const job = await createJobRecord(root, { jobId: jobIds[0], workspaceId, apiId: "api:ReduceSAAPI", apiName: "ReduceSAAPI", prepareArtifactPath: prepared.artifactPath, prepareId: artifact.prepareId, contextHash: artifact.contextHash, sourceFingerprint: artifact.manifest.sourceFingerprint, graphDigest: artifact.manifest.graphDigest, provider: null, model: null, docs: [], referenceTarget: { path: "", kind: "none" }, batchId: BATCH });
  await updateJobRecord(root, jobIds[0], job.revision, { provider: "mvp", model: "mvp-model", status: "scheduled", notBefore: new Date(Date.now() - 1000).toISOString() });
  return { root, prepared, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("TASK-126 (1) a Groovy varargs flow item (text contains '..') is now publishable", async () => {
  const fx = await fixture();
  try {
    const prepare = await loadPrepare(fx.root, fx.prepared.artifactPath);
    const payload = { technical: "t", business: "b", flow: [VARARGS_FLOW], evidence: ["src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI/ReduceSAAPI.groovy#1"] };
    assert.equal(validAnalysis({ api: payload } as any) || validAnalysis(payload as any), true, "the publish-side rule accepts varargs text");
    const published = await finalizeExplain(fx.root, workspaceId, fx.prepared.artifactPath, { api: payload }, { sourceFingerprint: prepare.manifest.sourceFingerprint, graphDigest: prepare.manifest.graphDigest, engineVersion: ICI_ENGINE_VERSION }, undefined, "126000000000000a");
    assert.deepEqual(published.artifact.apiAnalysis.flow, [VARARGS_FLOW]);
    // The absolute-path guard for flow items is unchanged.
    assert.equal(validAnalysis({ technical: "t", business: "b", flow: ["/etc/passwd"], evidence: ["src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI/ReduceSAAPI.groovy#1"] } as any), false);
  } finally { await fx.cleanup(); }
});

test("TASK-126 (2) the field failures' reconstructed payloads all pass the publish-side rule", async (t) => {
  if (!existsSync(FIELD_EXPLAIN)) { t.skip("field workspace not available on this machine"); return; }
  const jobsDir = join(FIELD_EXPLAIN, "jobs");
  const failed: Array<{ apiName: string; error?: string; prepareArtifactPath?: string }> = [];
  for (const entry of readdirSync(jobsDir)) {
    const file = join(jobsDir, entry, "job.json");
    if (!existsSync(file)) continue;
    const record = JSON.parse(await readFile(file, "utf8"));
    if (record.status === "failed" && record.error === "model-failed") failed.push(record);
  }
  assert.equal(failed.length, 29, "the recorded model-failed group");
  let withVarargs = 0;
  for (const job of failed) {
    // Rebuild the payload shape the child would have submitted: a flow item carrying the varargs
    // text that appears in that API's own prepared sources (fall back to the generic rendering).
    let flow = VARARGS_FLOW;
    try {
      const prepare = await loadPrepare(FIELD_ROOT, `${job.prepareArtifactPath}`);
      for (const ref of prepare.sources) {
        if (!ref.readable) continue;
        const text = await readFile(join(FIELD_ROOT, ref.path), "utf8").catch(() => "");
        const match = /[\w.()]{0,20}\.\.\.[\w.()]{0,20}/.exec(text);
        if (match !== null) { flow = match[0].includes("...") ? match[0] : "String.valueOf(...)"; withVarargs++; break; }
      }
    } catch { /* keep the generic rendering */ }
    const payload = { technical: "technical", business: "business", flow: [flow], evidence: ["src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI/ReduceSAAPI.groovy#1"] };
    assert.equal(validAnalysis(payload as any), true, `payload for ${job.apiName} must publish (flow=${flow})`);
  }
  t.diagnostic(`reconstructed payloads accepted for all ${failed.length} field failures (${withVarargs} carried varargs text taken from their own sources)`);
});

test("TASK-126 (3) an analysis-invalid at publication is recorded as analysis-invalid, not model-failed", async () => {
  const fx = await fixture();
  const adapter = new SubmitAdapter([VARARGS_FLOW]);
  const ctx = await harness(adapter);
  const parent = ctx.agentLoop.create(SessionId("task126-mapping"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root });
  try {
    setExplainFinalizeFailpoint((phase) => { if (phase === "before-final") throw new Error("analysis-invalid"); });
    await processConfirmedJob(ctx.llm, fx.root, jobIds[0], new AbortController().signal, ctx, parent);
    const after = await readJobRecord(fx.root, jobIds[0]);
    assert.equal(after?.status, "failed");
    assert.equal(after?.error, "analysis-invalid", "the scheduler must surface the real cause");
  } finally {
    setExplainFinalizeFailpoint(undefined);
    parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup();
  }
});

test("TASK-126 (4) end to end: a varargs flow reaches final AND the published artifact is readable", async () => {
  const fx = await fixture();
  const adapter = new SubmitAdapter([VARARGS_FLOW]);
  const ctx = await harness(adapter);
  const parent = ctx.agentLoop.create(SessionId("task126-e2e"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root });
  try {
    await processConfirmedJob(ctx.llm, fx.root, jobIds[0], new AbortController().signal, ctx, parent);
    const after = await readJobRecord(fx.root, jobIds[0]);
    assert.equal(after?.status, "final", after?.error);
    // TASK-129: "final" alone was never enough -- the read side (contracts validFinal) must accept
    // the SAME payload, otherwise the card shows a final job with no artifact.
    const readable = await readValidatedExplainFinal(fx.root, "ReduceSAAPI", workspaceId);
    assert.notEqual(readable, null, "the published final must be readable back");
    assert.deepEqual(readable?.final.apiAnalysis.flow, [VARARGS_FLOW]);
  } finally { parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup(); }
});

test("TASK-126 (5) all three sides of the submit boundary agree on the same flow payloads", async () => {
  const fx = await fixture();
  try {
    const prepare = await loadPrepare(fx.root, fx.prepared.artifactPath);
    const evidence = ["src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI/ReduceSAAPI.groovy#1"];
    const accepted = [
      VARARGS_FLOW,
      "String... names",
      "bizUtils.getAge(...)",
      "Tenant...TypeConverterUtils.resolve(...)",
    ];
    for (const [index, flow] of accepted.entries()) {
      const payload = { technical: "t", business: "b", flow: [flow], evidence };
      assert.equal(validAnalysis(payload as any), true, `publish side must accept ${flow}`);
      const published = await finalizeExplain(fx.root, workspaceId, fx.prepared.artifactPath, { api: payload }, { sourceFingerprint: prepare.manifest.sourceFingerprint, graphDigest: prepare.manifest.graphDigest, engineVersion: ICI_ENGINE_VERSION }, undefined, `12600000000000${(index + 1).toString().padStart(2, "0")}`);
      assert.deepEqual(published.artifact.apiAnalysis.flow, [flow]);
      const readable = await readValidatedExplainFinal(fx.root, "ReduceSAAPI", workspaceId);
      assert.notEqual(readable, null, `read side must accept ${flow}`);
      assert.deepEqual(readable?.final.apiAnalysis.flow, [flow]);
    }
    // The rules that remain identical on all three sides still reject absolute paths.
    const absolute = { technical: "t", business: "b", flow: ["/etc/passwd"], evidence };
    assert.equal(validAnalysis(absolute as any), false);
    await assert.rejects(() => finalizeExplain(fx.root, workspaceId, fx.prepared.artifactPath, { api: absolute }, { sourceFingerprint: prepare.manifest.sourceFingerprint, graphDigest: prepare.manifest.graphDigest, engineVersion: ICI_ENGINE_VERSION }, undefined, "12600000000000ff"));
  } finally { await fx.cleanup(); }
});
