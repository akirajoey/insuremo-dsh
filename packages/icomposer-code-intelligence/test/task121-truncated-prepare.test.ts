import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { buildGraph } from "../src/graph.ts";
import { computeGraphDigest, createJobRecord, loadPrepare, prepareExplain, updateJobRecord } from "../src/explain-artifacts.ts";
import { ExplainRoutesService } from "../src/explain-routes.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

/**
 * TASK-121: a deeply truncated call chain keeps its nodes but loses the edges that the edge
 * budget could not hold, so `directCalls` may have no CALLS edge. `truncated` is the explicit
 * declaration of exactly that, so the reader must accept it — while every other check (hash,
 * ranges, containment, tamper detection) stays strict, including for untruncated artifacts.
 */
const REF_ENGINE = ICI_ENGINE_VERSION;

async function chain(links: number) {
  const root = await mkdtemp(join(tmpdir(), "task121-chain-"));
  await mkdir(join(root, "src"), { recursive: true });
  const entries: Array<{ name: string; type: "api" | "function"; sourcePath: string }> = [];
  const api = join(root, "src", "ChainApi.groovy");
  await writeFile(api, `class ChainApi { def execute() { def s = getCommonService("F000"); s.run() } }\n`);
  entries.push({ name: "ChainApi", type: "api", sourcePath: api });
  for (let index = 0; index < links; index += 1) {
    const name = `F${String(index).padStart(3, "0")}`;
    const next = `F${String(index + 1).padStart(3, "0")}`;
    const file = join(root, "src", `${name}.groovy`);
    await writeFile(file, index + 1 < links ? `class ${name} { def run() { def s = getCommonService("${next}"); s.run() } }\n` : `class ${name} { def run() { 1 } }\n`);
    entries.push({ name, type: "function", sourcePath: file });
  }
  const raw = await buildGraph(root, entries);
  const graph: any = { nodes: new Map(raw.nodes.map((node: any) => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64), engineVersion: REF_ENGINE } };
  await mkdir(join(root, ".metadata/icomposer/ici/graph/current"), { recursive: true });
  await writeFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), JSON.stringify({ engineVersion: REF_ENGINE, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  return { root, graph, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Missing CALLS edges whose target WAS selected: the invariant the reader enforces (and B-lite must satisfy). */
const missingSelectedCallEdges = (chain: any): number => {
  const selected = new Set<string>((chain.nodes ?? []).map((node: any) => node.nodeId));
  const keys = new Set<string>((chain.edges ?? []).map((edge: any) => `${edge.from}|${edge.to}|${edge.kind}`));
  return (chain.nodes ?? []).flatMap((node: any) => (node.directCalls ?? []).filter((id: string) => selected.has(id) && !keys.has(`${node.nodeId}|${id}|CALLS`))).length;
};
const contextHash = (artifact: any): string => createHash("sha256").update(JSON.stringify({ api: artifact.api.id, callChain: artifact.callChain, sources: artifact.sources, references: artifact.references, manifest: artifact.manifest })).digest("hex");

test("TASK-121 (1) a truncated prepare artifact is readable instead of being self-rejected", async () => {
  const fx = await chain(120);
  try {
    const prepared = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:ChainApi"), []);
    assert.equal((prepared.artifact.callChain as any).truncated, true, "the synthetic chain must be truncated for this test to mean anything");
    const loaded = await loadPrepare(fx.root, prepared.artifactPath);
    assert.equal(loaded.api.name, "ChainApi", "a truncated chain must load (previously: prepare-invalidated)");
  } finally { await fx.cleanup(); }
});

test("TASK-121 (2) an UNtruncated artifact with a missing CALLS edge is still rejected", async () => {
  const fx = await chain(3);
  try {
    const prepared = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:ChainApi"), []);
    const artifact = JSON.parse(await readFile(join(fx.root, prepared.artifactPath), "utf8"));
    assert.equal(artifact.callChain.truncated, false);
    // Drop one CALLS edge but keep everything else consistent, including the recomputed hash:
    // only the completeness rule can reject this, proving it was not relaxed globally.
    const dropped = artifact.callChain.edges.filter((edge: any) => edge.kind !== "CALLS").concat(artifact.callChain.edges.filter((edge: any) => edge.kind === "CALLS").slice(1));
    artifact.callChain.edges = dropped;
    artifact.contextHash = contextHash(artifact);
    await writeFile(join(fx.root, prepared.artifactPath), `${JSON.stringify(artifact, null, 2)}\n`);
    await assert.rejects(() => loadPrepare(fx.root, prepared.artifactPath), /prepare-invalidated/);
  } finally { await fx.cleanup(); }
});

test("TASK-121 (3) a truncated artifact with tampered content is still rejected", async () => {
  const fx = await chain(120);
  try {
    const prepared = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:ChainApi"), []);
    const original = JSON.parse(await readFile(join(fx.root, prepared.artifactPath), "utf8"));
    // Tamper a prepared source hash: hash/range freshness must still fail for truncated artifacts.
    const tampered = JSON.parse(JSON.stringify(original));
    tampered.sources[0].sha256 = "0".repeat(64);
    await writeFile(join(fx.root, prepared.artifactPath), `${JSON.stringify(tampered, null, 2)}\n`);
    await assert.rejects(() => loadPrepare(fx.root, prepared.artifactPath), /prepare-invalidated/);
    // Tamper with an absolute path inside a chain node: the safety rejection must still fire.
    const withPath = JSON.parse(JSON.stringify(original));
    withPath.callChain.nodes[0].sourceFile = "/Users/someone/secret.groovy";
    await writeFile(join(fx.root, prepared.artifactPath), `${JSON.stringify(withPath, null, 2)}\n`);
    await assert.rejects(() => loadPrepare(fx.root, prepared.artifactPath), /prepare-invalidated/);
    // Untouched artifact still loads (the file was restored by the two tampering attempts only in temp copies).
    await writeFile(join(fx.root, prepared.artifactPath), `${JSON.stringify(original, null, 2)}\n`);
    assert.equal((await loadPrepare(fx.root, prepared.artifactPath)).api.name, "ChainApi");
  } finally { await fx.cleanup(); }
});

test("TASK-121 (4) a new truncated artifact keeps every directCalls CALLS edge the budget can hold", async () => {
  const fx = await chain(120);
  try {
    const prepared = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:ChainApi"), []);
    const chain = prepared.artifact.callChain as any;
    assert.equal(chain.truncated, true);
    assert.equal(missingSelectedCallEdges(chain), 0, "B-lite: the edge budget must be spent on the selected nodes' CALLS edges first");
    // References to nodes the budget never selected are exactly what truncation means: allowed,
    // and the reader accepts them only because `truncated === true`.
    const dangling = (chain.nodes ?? []).flatMap((node: any) => node.directCalls ?? []).filter((id: string) => !(chain.nodes ?? []).some((node: any) => node.nodeId === id)).length;
    assert.ok(dangling >= 0);
  } finally { await fx.cleanup(); }
});

test("TASK-121 (5) confirming a task whose member chain is truncated no longer fails with stale-snapshot", async () => {
  const fx = await chain(120);
  const routes: any[] = [];
  try {
    const prepared = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:ChainApi"), []);
    const job = await createJobRecord(fx.root, {
      jobId: "0123456789abcdef", batchId: "fedcba9876543210", workspaceId: "ws", apiName: "ChainApi", apiId: "api:ChainApi",
      prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId,
      sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest,
      provider: null, model: null, docs: [], folderPath: "",
    });
    const now = new Date().toISOString();
    await (await import("../src/explain-artifacts.ts")).writeBatchRecord(fx.root, { schemaVersion: 1, kind: "explain-batch", batchId: "fedcba9876543210", workspaceId: "ws", jobIds: [job.jobId], jobCount: 1, maxConcurrent: 4, requestedCount: 1, selector: { kind: "api", label: "ChainApi" }, createdAt: now, updatedAt: now });
    const ctx: any = new Context();
    ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } });
    ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "ws", canonicalPath: fx.root }] }) });
    ctx.provide("llm", { listProviders: () => [{ id: "mvp" }], resolveModelInfo: async () => ({ provider: "mvp" }) });
    ctx.provide("iciEngine", {});
    ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async () => true, taskInFlightCount: () => 0 });
    ctx.provide("iciExplainConfig", { maxConcurrent: 4, setMaxConcurrent: async () => ({ ok: true, value: { maxConcurrent: 4, maxPromptBytes: 1048576 } }) });
    const fiber: any = await ctx.plugin(ExplainRoutesService); await fiber.await();
    try {
      const bytes = JSON.stringify({ provider: "mvp", model: "mvp-model", docs: [], referenceTarget: { path: "", kind: "none" }, notBefore: new Date().toISOString(), consent: true });
      const res: any = { status: 0, body: "", headers: {}, destroyed: false, writableEnded: false, writeHead(status: number, headers: Record<string, string>) { res.status = status; res.headers = headers; }, end(body?: string) { res.body = body ?? ""; res.writableEnded = true; } };
      await routes[0].handler({ method: "POST", url: "/api/icomposer-workbench/ici/explain/batches/fedcba9876543210/confirm", headers: { "x-workbench-action": "1", "content-type": "application/json", "content-length": String(Buffer.byteLength(bytes)) }, on: () => undefined, async *[Symbol.asyncIterator]() { yield Buffer.from(bytes); } }, res);
      const body = JSON.parse(res.body);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.result.status, "scheduled");
      assert.equal((await (await import("../src/explain-artifacts.ts")).readJobRecord(fx.root, job.jobId))?.status, "scheduled");
      await updateJobRecord(fx.root, job.jobId, 2, { status: "awaiting-input" }).catch(() => undefined);
    } finally { await fiber.dispose(); }
  } finally { await fx.cleanup(); }
});
