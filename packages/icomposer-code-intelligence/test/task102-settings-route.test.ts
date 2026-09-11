import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { buildGraph } from "../src/graph.ts";
import { ExplainRoutesService } from "../src/explain-routes.ts";
import { computeGraphDigest, createJobRecord, prepareExplain, writeBatchRecord } from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

const batchId = "fedcba9876543210";
const alphaId = "0123456789abcdef";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task102-settings-route-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "ref_doc"), { recursive: true });
  await writeFile(join(root, "src", "AlphaAPI.groovy"), "class AlphaAPI { def run() { 1 } }\n");
  await writeFile(join(root, "ref_doc", "guide.md"), "guide\n");
  const raw = await buildGraph(root, [{ name: "AlphaAPI", type: "api", sourcePath: join(root, "src", "AlphaAPI.groovy") }]);
  const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } };
  const graphDir = join(root, ".metadata/icomposer/ici/graph/current");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const prepared = await prepareExplain(root, "batch", graph, raw.nodes.find(node => node.id === "api:AlphaAPI")!, []);
  await createJobRecord(root, { jobId: alphaId, workspaceId: "batch", apiName: "AlphaAPI", apiId: "api:AlphaAPI", prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: null, model: null, docs: [], folderPath: "ref_doc" });
  await writeBatchRecord(root, { schemaVersion: 1, kind: "explain-batch", batchId, workspaceId: "batch", jobIds: [alphaId], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function req(method: string, url: string, body?: unknown, header = true): any {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return {
    method, url,
    headers: { ...(header ? { "x-workbench-action": "1" } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), "content-length": String(bytes.byteLength) },
    on: () => undefined,
    async *[Symbol.asyncIterator]() { if (bytes.byteLength > 0) yield bytes; },
  };
}
function response(): any { const value: any = { status: 0, body: "", headers: {}, destroyed: false, writableEnded: false, writeHead(status: number, headers: Record<string, string>) { value.status = status; value.headers = headers; }, end(body?: string) { value.body = body ?? ""; value.writableEnded = true; } }; return value; }
function decode(value: any): any { return JSON.parse(value.body); }

/** Route fixture with an injected config face; the real storage integration lives in task102-concurrency.test.ts. */
async function routeFixture(config?: unknown, schedulerStatus?: () => { maxConcurrent: number; inFlight: number }) {
  const fx = await fixture();
  const routes: any[] = [];
  const ctx: any = new Context();
  ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } });
  ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "batch", canonicalPath: fx.root }] }) });
  ctx.provide("llm", { listProviders: () => [{ id: "mvp" }], resolveModelInfo: async () => undefined });
  ctx.provide("iciEngine", {});
  ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async () => false, ...(schedulerStatus === undefined ? {} : { status: schedulerStatus }) });
  if (config !== undefined) ctx.provide("iciExplainConfig", config);
  ctx.provide("directoryPicker", { capability: () => undefined });
  const fiber: any = await ctx.plugin(ExplainRoutesService);
  await fiber.await();
  return { fx, fiber, handler: routes[0].handler };
}

test("TASK-102: status surfaces the effective cap and in-flight count from the live scheduler", async () => {
  const setup = await routeFixture(
    { maxConcurrent: 4, setMaxConcurrent: async () => ({ ok: true, value: { maxConcurrent: 4 } }) },
    () => ({ maxConcurrent: 4, inFlight: 3 }),
  );
  try {
    const status = response();
    await setup.handler(req("GET", `/api/icomposer-workbench/ici/explain/batches/${batchId}/status`), status);
    const view = decode(status);
    assert.equal(view.ok, true);
    assert.deepEqual(view.result.scheduler, { maxConcurrent: 4, inFlight: 3 });
    assert.equal(status.body.includes(setup.fx.root), false);
  } finally { await setup.fiber.dispose(); await setup.fx.cleanup(); }
});

test("TASK-102: the settings endpoint persists a valid integer and rejects malformed payloads without side effects", async () => {
  let stored = 4;
  let settingsCalls = 0;
  const setup = await routeFixture({
    get maxConcurrent() { return stored; },
    setMaxConcurrent: async (input: unknown) => {
      settingsCalls += 1;
      if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 32) return { ok: false, code: "invalid-input" };
      stored = input;
      return { ok: true, value: { maxConcurrent: input } };
    },
  }, () => ({ maxConcurrent: stored, inFlight: 2 }));
  try {
    const saved = response();
    await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/settings`, { maxConcurrent: 8 }), saved);
    assert.equal(decode(saved).ok, true);
    assert.deepEqual(decode(saved).result, { maxConcurrent: 8, inFlight: 2 });
    assert.equal(stored, 8);
    assert.equal(settingsCalls, 1);

    for (const invalid of [{ maxConcurrent: 0 }, { maxConcurrent: 33 }, { maxConcurrent: 1.5 }, { maxConcurrent: "8" }, {}]) {
      const rejected = response();
      await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/settings`, invalid), rejected);
      assert.equal(decode(rejected).error.code, "invalid-input");
      assert.equal(rejected.status, 422);
    }
    const extra = response();
    await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/settings`, { maxConcurrent: 4, other: true }), extra);
    assert.equal(decode(extra).error.code, "invalid-input");
    assert.equal(stored, 8, "invalid payloads never change the stored cap");
    assert.equal(settingsCalls, 6, "invalid payloads reach the service but never persist");

    const noHeader = response();
    await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/settings`, { maxConcurrent: 2 }, false), noHeader);
    assert.equal(noHeader.status, 405);
    const getAttempt = response();
    await setup.handler(req("GET", `/api/icomposer-workbench/ici/explain/settings`), getAttempt);
    assert.equal(getAttempt.status, 405);
    assert.equal(stored, 8);
  } finally { await setup.fiber.dispose(); await setup.fx.cleanup(); }
});

test("TASK-102: a persistence failure answers storage-error and never reports the new cap", async () => {
  const setup = await routeFixture({
    maxConcurrent: 4,
    setMaxConcurrent: async () => ({ ok: false, code: "storage-error" }),
  }, () => ({ maxConcurrent: 4, inFlight: 0 }));
  try {
    const failed = response();
    await setup.handler(req("POST", `/api/icomposer-workbench/ici/explain/settings`, { maxConcurrent: 6 }), failed);
    assert.equal(failed.status, 500);
    assert.equal(decode(failed).error.code, "storage-error");
    assert.equal(failed.body.includes("maxConcurrent\"\": 6"), false);
  } finally { await setup.fiber.dispose(); await setup.fx.cleanup(); }
});
