import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGraph } from "../src/graph.ts";
import { computeGraphDigest, createJobRecord, markRunningJobsInterrupted, prepareExplain, readJobRecord, updateJobRecord } from "../src/explain-artifacts.ts";
import { validNodeAnalysis } from "../src/explain-scheduler.ts";

test("TASK-051 MVP scheduler accepts only the compatibility node shape outside aggregate submit", () => {
  assert.equal(validNodeAnalysis({ node_id: "api:A", technical: "t", business: "b", evidence: ["src/A.groovy#1"] }), true);
  assert.equal(validNodeAnalysis({ node_id: "api:A", technical: "t", business: "b", evidence: ["/absolute#1"] }), false);
  assert.equal(validNodeAnalysis({ node_id: "api:A", unavailable_reason: "not readable" }), true);
  assert.equal(validNodeAnalysis({ node_id: "api:A", unavailable_reason: { secret: "x" } }), false);
});

async function jobFixture() {
  const root = await mkdtemp(join(tmpdir(), "task051-scheduler-")); await mkdir(join(root, "src"), { recursive: true }); await mkdir(join(root, "ref_doc"), { recursive: true }); await writeFile(join(root, "src", "A.groovy"), "class A { def run() { 1 } }\n");
  const raw = await buildGraph(root, [{ name: "A", type: "api", sourcePath: join(root, "src", "A.groovy") }]); const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } }; await mkdir(join(root, ".metadata/icomposer/ici/graph/current"), { recursive: true }); await writeFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), JSON.stringify({ sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const prepared = await prepareExplain(root, "w", graph, raw.nodes.find(node => node.id === "api:A")!, []); const job = await createJobRecord(root, { jobId: "fedcba9876543210", workspaceId: "w", apiName: "A", apiId: "api:A", prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: "p", model: "m", docs: [], folderPath: "ref_doc" }); return { root, job, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("TASK-051 MVP scheduler CAS and restart transition are durable", async () => {
  const fx = await jobFixture(); try { const scheduled = await updateJobRecord(fx.root, fx.job.jobId, fx.job.revision, { status: "scheduled", notBefore: new Date().toISOString() }); const running = await updateJobRecord(fx.root, fx.job.jobId, scheduled.revision, { status: "running" }); await markRunningJobsInterrupted(fx.root); const interrupted = await readJobRecord(fx.root, fx.job.jobId); assert.equal(interrupted?.status, "interrupted"); assert.equal(interrupted?.error, "interrupted"); await assert.rejects(() => updateJobRecord(fx.root, fx.job.jobId, running.revision, { status: "final" })); } finally { await fx.cleanup(); }
});
