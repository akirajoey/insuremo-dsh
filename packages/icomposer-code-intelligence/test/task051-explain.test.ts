import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGraph } from "../src/graph.ts";
import { prepareExplain } from "../src/explain-artifacts.ts";
import { harness, writeGroovy, writeMeta } from "./support/helpers.ts";

test("TASK-051 MVP prepare/source/finalize is aggregate-only and final-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "task051-explain-")); await writeMeta(root, "api", "ExplainAPI"); await writeMeta(root, "function", "ExplainService");
  const api = await writeGroovy(root, "api", "ExplainAPI", `class ExplainAPI {\n  def execute() { return getCommonService("ExplainService").execute() }\n}`); await writeGroovy(root, "function", "ExplainService", `class ExplainService {\n  def execute() { return "business" }\n}`);
  const fresh = await harness({ root, catalogEntries: [{ name: "ExplainAPI", type: "api", sourcePath: api }, { name: "ExplainService", type: "function", sourcePath: join(root, "src/dev/Tenant/Group/function/ExplainService/ExplainService.groovy") }] });
  try {
    assert.equal((await fresh.engine.build({ workspaceId: "task051" })).ok, true); const prepared: any = await fresh.engine.explainPrepare({ workspaceId: "task051", query: "ExplainAPI" }); assert.equal(prepared.ok, true); assert.equal(prepared.value.manifest.promptVersion, "explain-mvp-v1"); assert.ok(prepared.value.callChain.nodes.length >= 2); assert.equal("cache" in prepared.value, false); const active: any = await fresh.engine.explainPrepare({ workspaceId: "task051", query: "ExplainAPI" }); assert.equal(active.ok, false); assert.equal(active.error.code, "job-active");
    const source: any = await fresh.engine.explainSource({ workspaceId: "task051", prepareArtifactPath: prepared.value.artifactPath, nodeIds: prepared.value.callChain.nodes.map((node: any) => node.nodeId), referencePaths: [] }); assert.equal(source.ok, true); assert.ok(source.value.files.length >= 1);
    const final: any = await fresh.engine.explainFinalize({ workspaceId: "task051", prepareArtifactPath: prepared.value.artifactPath, analysis: { api: { technical: "source-backed", business: "needs review", flow: ["API invokes service"], evidence: ["src/ExplainAPI/ExplainAPI.groovy#1"] } } }); assert.equal(final.ok, true); assert.equal(final.value.schemaVersion, 3); assert.equal(final.value.generatedBy, "current-agent"); assert.deepEqual(final.value.flow, ["API invokes service"]);
    await writeFile(api, `class ExplainAPI { def execute() { return "changed" } }`, "utf8"); const invalidated: any = await fresh.engine.explainFinalize({ workspaceId: "task051", prepareArtifactPath: prepared.value.artifactPath, analysis: { api: { technical: "x", business: "x", flow: [], evidence: ["src/ExplainAPI/ExplainAPI.groovy#1"] } } }); assert.equal(invalidated.ok, false); assert.equal(invalidated.error.code, "source-changed");
  } finally { await fresh.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("TASK-051 prepare rejects traversal reference paths before hashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "task051-boundary-")); try { await writeMeta(root, "api", "BoundaryAPI"); const api = await writeGroovy(root, "api", "BoundaryAPI", "class BoundaryAPI { def execute() { return 1 } }"); const raw = await buildGraph(root, [{ name: "BoundaryAPI", type: "api", sourcePath: api }]); const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } }; const start = raw.nodes.find(node => node.id === "api:BoundaryAPI")!; const prepared = await prepareExplain(root, "ws", graph, start, ["../../task051-outside"]); assert.equal(prepared.artifact.references.length, 0); assert.equal(prepared.artifact.sources.every((source: any) => !source.path.includes("..")), true); } finally { await rm(root, { recursive: true, force: true }); }
});
