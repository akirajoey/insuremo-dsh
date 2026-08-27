import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { buildGraph } from "../src/graph.ts";
import { ExplainRoutesService, type NativeFilePicker } from "../src/explain-routes.ts";
import { ICI_ENGINE_VERSION } from "../src/service.ts";
import { computeGraphDigest, createJobRecord, prepareExplain, readJobRecord } from "../src/explain-artifacts.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task055-route-")); await mkdir(join(root, "src"), { recursive: true }); await mkdir(join(root, "ref_doc"), { recursive: true });
  await writeFile(join(root, "src", "PickerAPI.groovy"), "class PickerAPI { def run() { 1 } }\n"); await writeFile(join(root, "ref_doc", "guide.md"), "guide\n");
  const raw = await buildGraph(root, [{ name: "PickerAPI", type: "api", sourcePath: join(root, "src", "PickerAPI.groovy") }]); const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } }; const graphDir = join(root, ".metadata/icomposer/ici/graph/current"); await mkdir(graphDir, { recursive: true }); await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const start = raw.nodes.find(node => node.id === "api:PickerAPI")!; const prepared = await prepareExplain(root, "picker", graph, start, []); const job = await createJobRecord(root, { jobId: "abcdef0123456789", workspaceId: "picker", apiName: "PickerAPI", apiId: "api:PickerAPI", prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId, sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest, provider: null, model: null, docs: [], folderPath: "ref_doc" }); return { root, job, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function req(body: unknown, onAbort?: (callback: () => void) => void): any { const bytes = Buffer.from(JSON.stringify(body)); return { method: "POST", url: "/api/icomposer-workbench/ici/explain/jobs/abcdef0123456789/native-pick", headers: { "x-workbench-action": "1", "content-type": "application/json", "content-length": String(bytes.byteLength) }, on(event: string, callback: () => void) { if (event === "aborted") onAbort?.(callback); }, async *[Symbol.asyncIterator]() { yield bytes; } }; }
function response() { const value: any = { status: 0, body: "", destroyed: false, writableEnded: false, writeHead(status: number) { value.status = status; }, end(body?: string) { value.body = body ?? ""; value.writableEnded = true; } }; return value; }
function decode(value: any): any { return JSON.parse(value.body); }
async function routeFixture(filePickerFactory: (root: string) => NativeFilePicker, directoryRelative = "ref_doc", directoryPicker: unknown = "default") {
  const fx = await fixture(); const routes: any[] = []; const ctx: any = new Context(); ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } }); ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "picker", canonicalPath: fx.root }] }) }); ctx.provide("llm", { listProviders: () => [{ id: "mvp" }] }); if (directoryPicker === "default") ctx.provide("directoryPicker", { capability: () => ({ kind: "native", pick: async () => join(fx.root, directoryRelative) }) }); else if (directoryPicker !== null) ctx.provide("directoryPicker", directoryPicker); ctx.provide("iciEngine", {}); ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async () => false }); const fiber: any = await ctx.plugin(ExplainRoutesService, { nativeFilePicker: filePickerFactory(fx.root) }); await fiber.await(); return { fx, fiber, handler: routes[0].handler };
}

test("TASK-055 native-pick route returns only relative file/folder targets", async () => {
  const setup = await routeFixture(root => ({ pick: async () => join(root, "ref_doc", "guide.md") })); const fx = setup.fx; try {
    const fileResponse = response(); await setup.handler(req({ kind: "file" }), fileResponse); const file = decode(fileResponse); assert.deepEqual(file.result, { path: "ref_doc/guide.md", kind: "file" }); assert.equal(fileResponse.body.includes(fx.root), false);
    const directoryResponse = response(); await setup.handler(req({ kind: "directory" }), directoryResponse); assert.deepEqual(decode(directoryResponse).result, { path: "ref_doc", kind: "directory" }); assert.equal(directoryResponse.body.includes(fx.root), false); assert.deepEqual((await readJobRecord(fx.root, fx.job.jobId))?.referenceTarget, { path: "ref_doc", kind: "directory" });
  } finally { await setup.fiber.dispose(); await fx.cleanup(); }
});

test("TASK-055 native-pick route makes cancellation/errors/abort explicit without changing selection", async () => {
  let mode: "cancel" | "error" | "abort" = "cancel"; let release!: () => void; const setup = await routeFixture(root => ({ pick: signal => mode === "cancel" ? Promise.resolve(null) : mode === "error" ? Promise.reject(new Error("/private/picker")) : new Promise((_resolve, reject) => { release = () => reject(signal.reason ?? new Error("aborted")); }) })); const fx = setup.fx; try {
    const cancelled = response(); await setup.handler(req({ kind: "file" }), cancelled); assert.equal(decode(cancelled).error.code, "picker-cancelled"); assert.equal(cancelled.body.includes(fx.root), false);
    mode = "error"; const failed = response(); await setup.handler(req({ kind: "file" }), failed); assert.equal(decode(failed).error.code, "picker-failed"); assert.equal(failed.body.includes(fx.root), false);
    mode = "abort"; let abort!: () => void; const abortResponse = response(); const pending = setup.handler(req({ kind: "file" }, callback => { abort = callback; }), abortResponse); for (let attempt = 0; attempt < 20 && !abort; attempt++) await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof abort, "function"); abort(); release(); await pending; assert.equal(decode(abortResponse).error.code, "picker-aborted"); assert.equal(abortResponse.body.includes(fx.root), false);
  } finally { await setup.fiber.dispose(); await fx.cleanup(); }
});

test("TASK-055 reports native directory capability absence without exposing a path", async () => {
  const setup = await routeFixture(() => ({ pick: async () => null }), "ref_doc", null); try { const result = response(); await setup.handler(req({ kind: "directory" }), result); const body = decode(result); assert.equal(body.error.code, "picker-unavailable"); assert.equal(result.body.includes(setup.fx.root), false); } finally { await setup.fiber.dispose(); await setup.fx.cleanup(); }
});
