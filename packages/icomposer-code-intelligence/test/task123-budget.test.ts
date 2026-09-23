import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { buildGraph } from "../src/graph.ts";
import { computeGraphDigest, createJobRecord, prepareExplain, readJobRecord, updateJobRecord, writeBatchRecord } from "../src/explain-artifacts.ts";
import { ExplainConfigService, EXPLAIN_DEFAULT_PROMPT_BYTES, EXPLAIN_MAX_PROMPT_BYTES, EXPLAIN_MIN_PROMPT_BYTES } from "../src/explain-config.ts";
import { ExplainRoutesService } from "../src/explain-routes.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

/**
 * TASK-123: the prompt budget is a Host-wide setting (default 256 KiB, up to 1 MiB) and a batch
 * confirmation schedules every member that fits while NAMING the oversized ones (they stay
 * awaiting-input) instead of failing or blocking the whole batch. The reported case is a 68-member
 * task with exactly one oversized member (CommonQueryInvestmentAPI, 372.2 KiB of prepared input).
 */

const BATCH_ID = "e0aa54380708cf18";
const TOTAL = 68;
const OVER_API = "CommonQueryInvestmentAPI";
const DEFAULT_BUDGET = EXPLAIN_DEFAULT_PROMPT_BYTES;

function req(method: string, url: string, body?: unknown): any { const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)); return { method, url, headers: { "x-workbench-action": "1", "content-type": "application/json", "content-length": String(bytes.byteLength) }, on: () => undefined, async *[Symbol.asyncIterator]() { if (bytes.byteLength > 0) yield bytes; } }; }
function response(): any { const value: any = { status: 0, body: "", headers: {}, destroyed: false, writableEnded: false, writeHead(status: number, headers: Record<string, string>) { value.status = status; value.headers = headers; }, end(body?: string) { value.body = body ?? ""; value.writableEnded = true; } }; return value; }
function decode(value: any): any { return JSON.parse(value.body); }

const jobIdOf = (index: number): string => (index + 1).toString(16).padStart(16, "0");

async function fixture(count = TOTAL, inflateIndex = 1, inflateSources = 1) {
  const root = await mkdtemp(join(tmpdir(), "task123-budget-"));
  await mkdir(join(root, "src"), { recursive: true });
  const source = join(root, "src", "Shared.groovy");
  await writeFile(source, "class Shared { def run() { 1 } }\n");
  // The inflated member gets one extra method per wanted source ref, all inside its own file.
  const bigSource = join(root, "src", "Big.groovy");
  const methods = Array.from({ length: Math.max(1, inflateSources) }, (_, index) => `  def step${index}() { def x = ${index} }`).join("\n");
  await writeFile(bigSource, `class Big {\n${methods}\n}\n`);
  const entries = Array.from({ length: count }, (_, index) => ({ name: `Api${index}`, type: "api" as const, sourcePath: index === inflateIndex ? bigSource : source }));
  const raw = await buildGraph(root, entries);
  const graph: any = { nodes: new Map(raw.nodes.map((node: any) => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64), engineVersion: ICI_ENGINE_VERSION } };
  await mkdir(join(root, ".metadata/icomposer/ici/graph/current"), { recursive: true });
  await writeFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const jobIds: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const name = index === inflateIndex ? OVER_API : entry.name;
    const prepared = await prepareExplain(root, "ws", graph, graph.nodes.get(`api:${entry.name}`), []);
    const jobId = jobIdOf(index);
    jobIds.push(jobId);
    await createJobRecord(root, {
      jobId, batchId: BATCH_ID, workspaceId: "ws", apiName: name, apiId: `api:${entry.name}`,
      prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId,
      sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest,
      provider: null, model: null, docs: [], folderPath: "",
    });
    if (index === inflateIndex) {
      // Inflate the prepared input accounting the same way the status route measures it:
      // a 300 KiB readable source range plus the call chain pushes this member over 256 KiB.
      const artifact = JSON.parse(await readFile(join(root, prepared.artifactPath), "utf8"));
      // The per-file source cap is 256 KiB, so inflate every source ref to that ceiling: with N refs
      // the member's prepared input is N * 256 KiB (+ chain + 1024), which is what a big API looks like.
      for (const ref of artifact.sources) ref.bytes = 256 * 1024;
      // The inflated range must stay self-consistent: the artifact hash covers exactly these fields.
      artifact.contextHash = createHash("sha256").update(JSON.stringify({ api: artifact.api.id, callChain: artifact.callChain, sources: artifact.sources, references: artifact.references, manifest: artifact.manifest })).digest("hex");
      await writeFile(join(root, prepared.artifactPath), `${JSON.stringify(artifact, null, 2)}\n`);
    }
  }
  const now = new Date().toISOString();
  await writeBatchRecord(root, { schemaVersion: 1, kind: "explain-batch", batchId: BATCH_ID, workspaceId: "ws", jobIds, jobCount: jobIds.length, maxConcurrent: 4, requestedCount: count, selector: { kind: "all", label: "all" }, createdAt: now, updatedAt: now });
  return { root, jobIds, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Config double: durable-ish global with strict validation, mirroring ExplainConfigService behaviour. */
function configDouble(initial: Record<string, number> = { maxConcurrent: 4, maxPromptBytes: DEFAULT_BUDGET }) {
  let stored = { ...initial };
  const face = {
    get maxConcurrent() { return stored.maxConcurrent; },
    get maxPromptBytes() { return stored.maxPromptBytes; },
    async setMaxConcurrent(input: unknown) {
      if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 32) return { ok: false as const, code: "invalid-input" };
      stored = { ...stored, maxConcurrent: input };
      return { ok: true as const, value: { ...stored } };
    },
    async setMaxPromptBytes(input: unknown) {
      if (typeof input !== "number" || !Number.isInteger(input) || input < EXPLAIN_MIN_PROMPT_BYTES || input > EXPLAIN_MAX_PROMPT_BYTES) return { ok: false as const, code: "invalid-input" };
      stored = { ...stored, maxPromptBytes: input };
      return { ok: true as const, value: { ...stored } };
    },
  };
  return { face, current: () => ({ ...stored }) };
}

async function routesFor(fx: Awaited<ReturnType<typeof fixture>>, config: ReturnType<typeof configDouble>) {
  const routes: any[] = [];
  const ctx: any = new Context();
  ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } });
  ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "ws", canonicalPath: fx.root }] }) });
  ctx.provide("llm", { listProviders: () => [{ id: "mvp" }], resolveModelInfo: async () => ({ provider: "mvp" }) });
  ctx.provide("iciEngine", {});
  ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async (jobId: string) => {
    // Mirror ExplainScheduler.cancelJob: cancel the record itself (idempotent when already cancelled).
    const record = await readJobRecord(fx.root, jobId);
    if (record === null) return false;
    if (record.status === "cancelled") return true;
    if (!["awaiting-input", "scheduled", "confirmed", "running"].includes(record.status)) return false;
    return updateJobRecord(fx.root, jobId, record.revision, { status: "cancelled", error: "cancelled" }).then(() => true).catch(() => false);
  }, taskInFlightCount: () => 0 });
  ctx.provide("iciExplainConfig", config.face);
  const fiber: any = await ctx.plugin(ExplainRoutesService); await fiber.await();
  const confirm = async (): Promise<{ status: number; body: any }> => { const res = response(); await routes[0].handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${BATCH_ID}/confirm`, { provider: "mvp", model: "mvp-model", docs: [], referenceTarget: { path: "", kind: "none" }, notBefore: new Date().toISOString(), consent: true }), res); return { status: res.status, body: decode(res) }; };
  const settings = async (body: unknown): Promise<{ status: number; body: any }> => { const res = response(); await routes[0].handler(req("POST", "/api/icomposer-workbench/ici/explain/settings", body), res); return { status: res.status, body: decode(res) }; };
  const batchStatus = async (): Promise<{ status: number; body: any }> => { const res = response(); await routes[0].handler(req("GET", `/api/icomposer-workbench/ici/explain/batches/${BATCH_ID}/status?page=1&size=5`), res); return { status: res.status, body: decode(res) }; };
  return { routes, confirm, settings, batchStatus, dispose: async () => { await fiber.dispose(); } };
}

test("TASK-123 (1a) the user's 372 KiB member passes under the 1 MiB default: all 68 members are scheduled", async () => {
  const fx = await fixture(TOTAL, 1, 1);
  const config = configDouble();
  const routes = await routesFor(fx, config);
  try {
    const out = await routes.confirm();
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.result.jobs, TOTAL, "no member is skipped under the default budget");
    assert.equal(out.body.result.status, "scheduled");
    assert.equal(out.body.result.skipped, undefined);
    assert.equal(out.body.result.maxPromptBytes, DEFAULT_BUDGET);
    assert.ok(DEFAULT_BUDGET > 372 * 1024, "the default budget covers the reported 372.2 KiB member");
    assert.equal((await readJobRecord(fx.root, jobIdOf(1)))?.status, "scheduled");
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-123 (1b) a member above the default 1 MiB is skipped and NAMED, the other 67 are scheduled", async () => {
  const fx = await fixture(TOTAL, 1, 6);
  const config = configDouble();
  const routes = await routesFor(fx, config);
  try {
    const out = await routes.confirm();
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.result.jobs, TOTAL - 1, "every member within budget is scheduled");
    assert.equal(out.body.result.status, "partial");
    assert.equal(out.body.result.skipped.length, 1);
    assert.equal(out.body.result.skipped[0].apiName, OVER_API);
    assert.equal(out.body.result.skipped[0].code, "input-too-large");
    assert.ok(out.body.result.skipped[0].promptBaseBytes > DEFAULT_BUDGET);
    assert.equal(out.body.result.maxPromptBytes, DEFAULT_BUDGET);
    // The oversized member is untouched and still waiting; the rest are scheduled.
    assert.equal((await readJobRecord(fx.root, jobIdOf(1)))?.status, "awaiting-input");
    for (const index of [0, 2, TOTAL - 1]) assert.equal((await readJobRecord(fx.root, jobIdOf(index)))?.status, "scheduled");
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-123 (2) raising the Host budget lets the same member run (one source of truth)", async () => {
  const fx = await fixture(TOTAL, 1, 6);
  const config = configDouble();
  const routes = await routesFor(fx, config);
  try {
    const raised = await routes.settings({ maxPromptBytes: 4 * 1024 * 1024 });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    assert.equal(raised.body.result.maxPromptBytes, 4 * 1024 * 1024);
    const out = await routes.confirm();
    assert.equal(out.status, 200);
    assert.equal(out.body.result.jobs, TOTAL, "with a larger budget no member is skipped");
    assert.equal(out.body.result.status, "scheduled");
    assert.equal(out.body.result.skipped, undefined);
    assert.equal((await readJobRecord(fx.root, jobIdOf(1)))?.status, "scheduled");
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-123 (3) a single oversized job is refused explicitly at confirmation", async () => {
  const fx = await fixture(2, 1, 6);
  const config = configDouble();
  const routes: any[] = [];
  const ctx: any = new Context();
  ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } });
  ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "ws", canonicalPath: fx.root }] }) });
  ctx.provide("llm", { listProviders: () => [{ id: "mvp" }], resolveModelInfo: async () => ({ provider: "mvp" }) });
  ctx.provide("iciEngine", {});
  ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async () => true });
  ctx.provide("iciExplainConfig", config.face);
  const fiber: any = await ctx.plugin(ExplainRoutesService); await fiber.await();
  try {
    const res = response();
    await routes[0].handler(req("POST", `/api/icomposer-workbench/ici/explain/jobs/${jobIdOf(1)}/confirm`, { provider: "mvp", model: "mvp-model", docs: [], referenceTarget: { path: "", kind: "none" }, notBefore: new Date().toISOString(), consent: true }), res);
    assert.equal(res.status, 409);
    assert.equal(decode(res).error.code, "input-too-large");
    assert.equal((await readJobRecord(fx.root, jobIdOf(1)))?.status, "awaiting-input", "a refused job is not scheduled");
  } finally { await fiber.dispose(); await fx.cleanup(); }
});

test("TASK-123 (4) the status payload reports the effective budget for the card", async () => {
  const fx = await fixture(2, 1, 6);
  const config = configDouble();
  const routes = await routesFor(fx, config);
  try {
    const before = await routes.batchStatus();
    assert.equal(before.body.result.scheduler.maxPromptBytes, DEFAULT_BUDGET);
    await routes.settings({ maxPromptBytes: 640 * 1024 });
    const after = await routes.batchStatus();
    assert.equal(after.body.result.scheduler.maxPromptBytes, 640 * 1024, "a smaller value is honoured too");
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-123 (5) the settings endpoint validates the budget strictly and never touches storage on refusal", async () => {
  const fx = await fixture(2, 1, 6);
  const config = configDouble();
  const routes = await routesFor(fx, config);
  try {
    for (const bad of [EXPLAIN_MIN_PROMPT_BYTES - 1, EXPLAIN_MAX_PROMPT_BYTES + 1, 1.5, "262144"]) {
      const refused = await routes.settings({ maxPromptBytes: bad });
      assert.equal(refused.status, 422, `expected 422 for ${JSON.stringify(bad)}`);
      assert.equal(config.current().maxPromptBytes, DEFAULT_BUDGET);
    }
    assert.equal((await routes.settings({})).status, 422);
    assert.equal((await routes.settings({ maxPromptBytes: DEFAULT_BUDGET, extra: 1 })).status, 422);
    const accepted = await routes.settings({ maxConcurrent: 2, maxPromptBytes: EXPLAIN_MAX_PROMPT_BYTES });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.result.maxConcurrent, 2);
    assert.equal(accepted.body.result.maxPromptBytes, EXPLAIN_MAX_PROMPT_BYTES);
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-123 (6) the config service defaults the budget and persists a change (legacy records keep the default)", async () => {
  // A legacy durable record without the new field must parse with the default value.
  let stored: Record<string, number> = { maxConcurrent: 4 };
  const ctx: any = new Context();
  ctx.provide("storageDomain", { open: async () => ({ global: { get: () => ({ ...stored }), set: async (value: any) => { stored = { ...value }; } }, close: async () => undefined }) });
  const fiber: any = await ctx.plugin(ExplainConfigService); await fiber.await();
  try {
    const service = ctx.get("iciExplainConfig") as ExplainConfigService;
    assert.equal(service.maxPromptBytes, DEFAULT_BUDGET);
    assert.equal(service.maxOutputTokens, 16384, "TASK-125: the child output budget defaults to 16384");
    assert.deepEqual(service.view, { maxConcurrent: 4, maxPromptBytes: DEFAULT_BUDGET, maxOutputTokens: 16384 });
    assert.equal((await service.setMaxPromptBytes(1)).ok, false);
    assert.equal((await service.setMaxPromptBytes(EXPLAIN_MAX_PROMPT_BYTES + 1)).ok, false);
    assert.equal(service.maxPromptBytes, DEFAULT_BUDGET, "a refused write keeps the effective value");
    const ok = await service.setMaxPromptBytes(524288);
    assert.equal(ok.ok, true);
    assert.equal(service.maxPromptBytes, 524288);
    assert.equal(stored.maxPromptBytes, 524288, "the value is persisted");
    assert.equal((await service.setMaxPromptBytes(2 * 1024 * 1024)).ok, true, "the value can also be raised above the default");
    assert.equal(service.maxPromptBytes, 2 * 1024 * 1024);
    assert.equal(stored.maxConcurrent, 4, "the concurrency value is preserved");
  } finally { await fiber.dispose(); }
});

test("TASK-123 (7) retry and cancel semantics are untouched by the budget split", async () => {
  const fx = await fixture(3, 1, 6);
  const config = configDouble();
  const routes = await routesFor(fx, config);
  try {
    const out = await routes.confirm();
    assert.equal(out.body.result.jobs, 2);
    // The scheduler double refuses nothing: cancelling the whole batch still cancels every active member,
    // including the oversized one that was never scheduled (TASK-116 semantics).
    const cancelRes = response();
    await routes.routes[0].handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${BATCH_ID}/cancel`, {}), cancelRes);
    assert.equal(decode(cancelRes).ok, true);
    assert.equal((await readJobRecord(fx.root, jobIdOf(0)))?.status, "cancelled");
    assert.equal((await readJobRecord(fx.root, jobIdOf(1)))?.status, "cancelled", "the skipped member stays cancellable");
  } finally { await routes.dispose(); await fx.cleanup(); }
});
