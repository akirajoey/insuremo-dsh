import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGraph } from "../src/graph.ts";
import { computeGraphDigest, listJobs, readBatchRecord, setExplainWriteFailpoint } from "../src/explain-artifacts.ts";
import { runPrepare, runPrepareBatch } from "../src/explain-native.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

async function fixture(prefix = "task056-batch-") {
  const root = await mkdtemp(join(tmpdir(), prefix)); await mkdir(join(root, "src"), { recursive: true }); await mkdir(join(root, "ref_doc"), { recursive: true });
  await writeFile(join(root, "src", "AlphaAPI.groovy"), "class AlphaAPI { def run() { 1 } }\n"); await writeFile(join(root, "src", "BetaAPI.groovy"), "class BetaAPI { def run() { 2 } }\n");
  const raw = await buildGraph(root, [{ name: "AlphaAPI", type: "api", sourcePath: join(root, "src", "AlphaAPI.groovy") }, { name: "BetaAPI", type: "api", sourcePath: join(root, "src", "BetaAPI.groovy") }]);
  const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64), engineVersion: ICI_ENGINE_VERSION } };
  const graphDir = join(root, ".metadata/icomposer/ici/graph/current"); await mkdir(graphDir, { recursive: true }); await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const starts = new Map(["AlphaAPI", "BetaAPI"].map(name => [name, graph.nodes.get(`api:${name}`)]));
  const deps: any = { disposed: () => false, loadBase: async (_workspaceId: string, query: string) => { const start = starts.get(query); return start ? { ok: true, value: { graph, canonicalPath: root, start } } : { ok: false, error: { code: "no-match", message: `no api matched: ${query}` } }; }, current: async () => ({ ok: true, value: { canonicalPath: root, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph), engineVersion: ICI_ENGINE_VERSION } }), refs: async () => [] };
  return { root, graph, deps, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("TASK-056 batch prepare deduplicates APIs, writes one batch record, and reuses active jobs", async () => {
  const fx = await fixture(); try {
    const first = await runPrepareBatch(fx.deps, { workspaceId: "batch", queries: ["AlphaAPI", "BetaAPI", "AlphaAPI"] }); assert.equal(first.ok, true); assert.equal(first.value.jobs.length, 2); assert.match(first.value.batchId, /^[a-f0-9]{16}$/); assert.ok(first.value.jobs.every(job => job.reused === false));
    const record = await readBatchRecord(fx.root, first.value.batchId); assert.ok(record); assert.deepEqual(record?.jobIds, first.value.jobs.map(job => job.jobId)); assert.equal((await listJobs(fx.root)).length, 2); assert.ok(first.value.jobs.every(job => job.chainNodes >= 1 && job.artifactPath.startsWith(".metadata/")));
    const second = await runPrepareBatch(fx.deps, { workspaceId: "batch", queries: ["BetaAPI", "AlphaAPI"] }); assert.equal(second.ok, true); assert.deepEqual(second.value.jobs.map(job => job.jobId).sort(), first.value.jobs.map(job => job.jobId).sort()); assert.ok(second.value.jobs.every(job => job.reused === true)); assert.equal((await listJobs(fx.root)).length, 2);
  } finally { await fx.cleanup(); }
});

test("TASK-056 batch prepare validates all queries and freshness before writing", async () => {
  const bad = await fixture(); try { const result = await runPrepareBatch(bad.deps, { workspaceId: "batch", queries: ["AlphaAPI", "MissingAPI"] }); assert.equal(result.ok, false); assert.equal(result.error.code, "no-match"); assert.equal((await listJobs(bad.root)).length, 0); } finally { await bad.cleanup(); }
  const stale = await fixture(); try { const deps = { ...stale.deps, loadBase: async (_workspaceId: string, query: string) => { const value = await stale.deps.loadBase(_workspaceId, query); return query === "BetaAPI" && value.ok ? { ...value, value: { ...value.value, stale: true as const } } : value; } }; const result = await runPrepareBatch(deps, { workspaceId: "batch", queries: ["AlphaAPI", "BetaAPI"] }); assert.equal(result.ok, false); assert.equal(result.error.code, "stale-snapshot"); assert.equal((await listJobs(stale.root)).length, 0); } finally { await stale.cleanup(); }
});

test("TASK-056 batch prepare rolls back jobs when a later write fails", async () => {
  const fx = await fixture(); setExplainWriteFailpoint(path => { if (path.includes("/batches/")) throw new Error("batch-write-failed"); }); try { const result = await runPrepareBatch(fx.deps, { workspaceId: "batch", queries: ["AlphaAPI", "BetaAPI"] }); assert.equal(result.ok, false); assert.equal(result.error.code, "storage-error"); const jobs = await listJobs(fx.root); assert.equal(jobs.length, 2); assert.ok(jobs.every(job => job.status === "cancelled" && job.error === "storage-error")); } finally { setExplainWriteFailpoint(undefined); await fx.cleanup(); }
});

test("TASK-056 removing the workspace-wide limit still blocks duplicate single API prepares", async () => {
  const fx = await fixture(); try {
    const alpha = await runPrepare(fx.deps, { workspaceId: "batch", query: "AlphaAPI" }); assert.equal(alpha.ok, true); const beta = await runPrepare(fx.deps, { workspaceId: "batch", query: "BetaAPI" }); assert.equal(beta.ok, true); const duplicate = await runPrepare(fx.deps, { workspaceId: "batch", query: "AlphaAPI" }); assert.equal(duplicate.ok, false); assert.equal(duplicate.error.code, "job-active"); assert.equal((await listJobs(fx.root)).length, 2);
  } finally { await fx.cleanup(); }
});

test("TASK-056 batch records reject malformed or absolute job ids", async () => {
  const fx = await fixture(); try { const raw = JSON.parse(await readFile(join(fx.root, ".metadata/icomposer/ici/graph/current/manifest.json"), "utf8")); assert.equal(raw.engineVersion, ICI_ENGINE_VERSION); assert.equal(await readBatchRecord(fx.root, "../../../../../../tmp/secret"), null); } finally { await fx.cleanup(); }
});
