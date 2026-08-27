import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { buildGraph } from "../src/graph.ts";
import { ExplainRoutesService } from "../src/explain-routes.ts";
import { computeGraphDigest, createJobRecord, prepareExplain, readJobRecord, updateJobRecord } from "../src/explain-artifacts.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task051-route-")); await mkdir(join(root, "src"), { recursive: true }); await mkdir(join(root, "ref_doc", "nested"), { recursive: true });
  await writeFile(join(root, "src", "RouteAPI.groovy"), "class RouteAPI { def run() { 1 } }\n"); await writeFile(join(root, "ref_doc", "nested", "guide.md"), "guide\n");
  const raw = await buildGraph(root, [{ name: "RouteAPI", type: "api", sourcePath: join(root, "src", "RouteAPI.groovy") }]); const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } }; await mkdir(join(root, ".metadata/icomposer/ici/graph/current"), { recursive: true }); await writeFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), JSON.stringify({ sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const start = raw.nodes.find(node => node.id === "api:RouteAPI")!; const prepared = await prepareExplain(root, "route", graph, start, []); const job = await createJobRecord(root, { jobId: "abcdef0123456789", workspaceId: "route", apiName: "RouteAPI", apiId: "api:RouteAPI", prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: null, model: null, docs: [], folderPath: "ref_doc" }); return { root, job, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function req(method: string, url: string, body?: unknown, header = true): any { const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)); return { method, url, headers: { ...(header ? { "x-workbench-action": "1" } : {}), "content-length": String(bytes.byteLength) }, on: () => undefined, async *[Symbol.asyncIterator]() { if (bytes.byteLength > 0) yield bytes; } }; }
function response() { const value: any = { status: 0, body: "", headers: {}, destroyed: false, writableEnded: false, writeHead(status: number, headers: Record<string, string>) { value.status = status; value.headers = headers; }, end(body?: string) { value.body = body ?? ""; value.writableEnded = true; } }; return value; }
function decode(value: any): any { return JSON.parse(value.body); }

test("TASK-051 MVP routes expose bounded status/folder and CAS confirmation", async () => {
  const fx = await fixture(); const routes: any[] = []; const ctx: any = new Context(); ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } }); ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "route", canonicalPath: fx.root }] }) }); ctx.provide("llm", { listProviders: () => [{ id: "mvp" }] }); ctx.provide("iciEngine", {}); ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async () => false }); const fiber: any = await ctx.plugin(ExplainRoutesService); await fiber.await(); const handler = routes[0].handler;
  try {
    const statusRes = response(); await handler(req("GET", `/api/icomposer-workbench/ici/explain/jobs/${fx.job.jobId}/status`), statusRes); const status = decode(statusRes); assert.equal(status.ok, true); assert.equal(status.result.job.status, "awaiting-input"); assert.equal(status.result.folderPath, "ref_doc"); assert.ok(status.result.summary.nodes >= 1); assert.equal(status.result.providers[0].id, "mvp"); assert.equal(JSON.stringify(status).includes(fx.root), false);
    const folderRes = response(); await handler(req("GET", `/api/icomposer-workbench/ici/explain/jobs/${fx.job.jobId}/folder?path=ref_doc`), folderRes); const folder = decode(folderRes); assert.equal(folder.ok, true); assert.ok(folder.result.entries.some((entry: any) => entry.path === "ref_doc/nested"));
    const badFolder = response(); await handler(req("GET", `/api/icomposer-workbench/ici/explain/jobs/${fx.job.jobId}/folder?path=${encodeURIComponent("../")}`), badFolder); assert.equal(decode(badFolder).error.code, "folder-forbidden");
    const tooFar = response(); await handler(req("POST", `/api/icomposer-workbench/ici/explain/jobs/${fx.job.jobId}/confirm`, { provider: "mvp", model: "mvp-model", folderPath: "/tmp/private", docs: [], notBefore: new Date(Date.now() + 15 * 86400000).toISOString(), consent: true }), tooFar); assert.equal(decode(tooFar).error.code, "confirmation-invalid"); assert.equal(tooFar.body.includes("/tmp/private"), false);
    const confirmRes = response(); await handler(req("POST", `/api/icomposer-workbench/ici/explain/jobs/${fx.job.jobId}/confirm`, { provider: "mvp", model: "mvp-model", folderPath: "ref_doc", docs: [], notBefore: new Date(Date.now() - 1000).toISOString(), consent: true }), confirmRes); const confirmed = decode(confirmRes); assert.equal(confirmed.ok, true); assert.equal(confirmed.result.status, "scheduled"); assert.equal((await readJobRecord(fx.root, fx.job.jobId))?.status, "scheduled");
    const conflict = response(); await handler(req("POST", `/api/icomposer-workbench/ici/explain/jobs/${fx.job.jobId}/confirm`, { provider: "mvp", model: "mvp-model", folderPath: "ref_doc", docs: [], notBefore: new Date().toISOString(), consent: true }), conflict); assert.equal(decode(conflict).ok, true); assert.equal(decode(conflict).result.status, "scheduled");
    const noHeader = response(); await handler(req("POST", `/api/icomposer-workbench/ici/explain/jobs/${fx.job.jobId}/cancel`, {}, false), noHeader); assert.equal(noHeader.status, 405);
    await updateJobRecord(fx.root, fx.job.jobId, (await readJobRecord(fx.root, fx.job.jobId))!.revision, { status: "cancelled", error: "cancelled" });
  } finally { await fiber.dispose(); await fx.cleanup(); }
});

test("TASK-052 accepts routable custom models when the advisory catalog is empty", async () => {
  const fx = await fixture(); const routes: any[] = []; let rejectModel = false; const ctx: any = new Context(); ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } }); ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "route", canonicalPath: fx.root }] }) }); ctx.provide("llm", { listProviders: () => [{ id: "custom" }], listModels: async () => [], resolveModelInfo: async (_provider: string, _model: string) => { if (rejectModel) throw new Error("model unavailable"); } }); ctx.provide("iciEngine", {}); ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async () => false }); const fiber: any = await ctx.plugin(ExplainRoutesService); await fiber.await(); const handler = routes[0].handler;
  try {
    const statusRes = response(); await handler(req("GET", `/api/icomposer-workbench/ici/explain/jobs/${fx.job.jobId}/status`), statusRes); const status = decode(statusRes); assert.equal(status.ok, true); assert.deepEqual(status.result.providers, [{ id: "custom", models: [] }]);
    const confirmRes = response(); await handler(req("POST", `/api/icomposer-workbench/ici/explain/jobs/${fx.job.jobId}/confirm`, { provider: "custom", model: "custom-model", folderPath: "ref_doc", docs: [], consent: true }), confirmRes); assert.equal(decode(confirmRes).ok, true); assert.equal((await readJobRecord(fx.root, fx.job.jobId))?.model, "custom-model");
    rejectModel = true; const rejected = response(); await handler(req("POST", `/api/icomposer-workbench/ici/explain/jobs/${fx.job.jobId}/confirm`, { provider: "custom", model: "unroutable-model", folderPath: "ref_doc", docs: [], consent: true }), rejected); assert.equal(decode(rejected).error.code, "confirmation-invalid"); assert.equal((await readJobRecord(fx.root, fx.job.jobId))?.model, "custom-model");
  } finally { await fiber.dispose(); await fx.cleanup(); }
});
