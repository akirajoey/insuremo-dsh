import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { LlmAdapter } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { buildGraph } from "../src/graph.ts";
import { ExplainScheduler } from "../src/explain-scheduler.ts";
import { computeGraphDigest, createJobRecord, prepareExplain, readJobRecord, updateJobRecord } from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

function toolCall(id: string, name: string, args: unknown): any[] { const text = JSON.stringify(args); return [{ type: "block-start", index: 0, blockType: "tool-call" }, { type: "tool-call-delta", index: 0, id, name, argumentsDelta: text }, { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: text } }, { type: "finish", reason: { kind: "tool-calls" } }]; }
class TwoJobAdapter extends LlmAdapter {
  calls = 0; activeStreams = 0; maxActiveStreams = 0;
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  override listModels(provider: string): Promise<any[]> { return Promise.resolve([{ provider, id: "mvp-model", name: "MVP model" }]); }
  async *stream(): AsyncIterable<any> { this.activeStreams++; this.maxActiveStreams = Math.max(this.maxActiveStreams, this.activeStreams); try { const step = this.calls++ % 3; if (step === 0) yield* toolCall(`list-${this.calls}`, "ici_explain_list", {}); else if (step === 1) yield* toolCall(`read-${this.calls}`, "ici_explain_read", { path: "nested/meaning.md" }); else yield* toolCall(`submit-${this.calls}`, "ici_explain_submit", { technical: "technical", business: "business", flow: ["API reads a request"], evidence: ["ref_doc/nested/meaning.md#1"] }); } finally { this.activeStreams--; } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task056-scheduler-")); await mkdir(join(root, "src"), { recursive: true }); await mkdir(join(root, "ref_doc", "nested"), { recursive: true }); await writeFile(join(root, "src", "AlphaAPI.groovy"), "class AlphaAPI { def run() { 1 } }\n"); await writeFile(join(root, "src", "BetaAPI.groovy"), "class BetaAPI { def run() { 2 } }\n"); await writeFile(join(root, "ref_doc", "nested", "meaning.md"), "meaning\n");
  const raw = await buildGraph(root, [{ name: "AlphaAPI", type: "api", sourcePath: join(root, "src", "AlphaAPI.groovy") }, { name: "BetaAPI", type: "api", sourcePath: join(root, "src", "BetaAPI.groovy") }]); const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } }; await mkdir(join(root, ".metadata/icomposer/ici/graph/current"), { recursive: true }); await writeFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const jobs = []; for (const [jobId, name] of [["0123456789abcdef", "AlphaAPI"], ["abcdef0123456789", "BetaAPI"]] as const) { const prepared = await prepareExplain(root, "batch", graph, graph.nodes.get(`api:${name}`), []); jobs.push(await createJobRecord(root, { jobId, workspaceId: "batch", apiName: name, apiId: `api:${name}`, prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: "mvp", model: "mvp-model", docs: [], folderPath: "ref_doc" })); }
  return { root, jobs, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function realHarness(adapter: TwoJobAdapter) { const ctx: any = new Context(); await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); ctx.llm.registerAdapter(["mvp"], adapter); return ctx; }

test("TASK-056 scheduler drains two scheduled jobs in order without concurrent children", async () => {
  const fx = await fixture(); const adapter = new TwoJobAdapter(); const ctx: any = await realHarness(adapter); const parent = ctx.agentLoop.create(SessionId("task056-batch-parent"), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root }); ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "batch", canonicalPath: fx.root }] }), get: async () => ({ ok: true, value: { canonicalPath: fx.root } }) });
  const scheduled = []; for (const job of fx.jobs) scheduled.push(await updateJobRecord(fx.root, job.jobId, job.revision, { status: "scheduled", notBefore: new Date().toISOString() })); void scheduled;
  const fiber: any = await ctx.plugin(ExplainScheduler); await fiber.await(); try { for (let i = 0; i < 400; i++) { const rows = await Promise.all(fx.jobs.map(job => readJobRecord(fx.root, job.jobId))); if (rows.every(row => row?.status === "final")) break; await new Promise(resolve => setTimeout(resolve, 5)); } assert.equal((await readJobRecord(fx.root, fx.jobs[0].jobId))?.status, "final"); assert.equal((await readJobRecord(fx.root, fx.jobs[1].jobId))?.status, "final"); assert.equal(adapter.calls, 6); assert.equal(adapter.maxActiveStreams, 1); } finally { await fiber.dispose(); parent.cancel("cancelled"); await parent.whenIdle(); await fx.cleanup(); }
});
