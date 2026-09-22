import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { buildGraph } from "../src/graph.ts";
import { computeGraphDigest, createJobRecord, prepareExplain, readJobRecord, writeJobRecordUnderLock } from "../src/explain-artifacts.ts";
import { runBlockedTargets, runPrepareTask } from "../src/explain-native.ts";
import { ExplainRoutesService } from "../src/explain-routes.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

/**
 * TASK-116: one request cancels every LEGACY blocker of a selector, in bounded chunks,
 * with exactly one audit record. Members of other tasks stay untouched and uncancellable,
 * partial failures are reported (never rolled back), and the audit stays fail-closed.
 */

function req(method: string, url: string, body?: unknown): any { const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)); return { method, url, headers: { "x-workbench-action": "1", "content-type": "application/json", "content-length": String(bytes.byteLength) }, on: () => undefined, async *[Symbol.asyncIterator]() { if (bytes.byteLength > 0) yield bytes; } }; }
function response(): any { const value: any = { status: 0, body: "", headers: {}, destroyed: false, writableEnded: false, writeHead(status: number, headers: Record<string, string>) { value.status = status; value.headers = headers; }, end(body?: string) { value.body = body ?? ""; value.writableEnded = true; } }; return value; }
function decode(value: any): any { return JSON.parse(value.body); }

const TOTAL = 63;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task116-batch-"));
  await mkdir(join(root, "src"), { recursive: true });
  const entries: Array<{ name: string; type: "api"; sourcePath: string }> = [];
  for (let index = 0; index < TOTAL; index += 1) {
    const name = `Api${String(index).padStart(2, "0")}`;
    const file = join(root, "src", `${name}.groovy`);
    await writeFile(file, `class ${name} { def run() { 1 } }\n`);
    entries.push({ name, type: "api", sourcePath: file });
  }
  const raw = await buildGraph(root, entries);
  const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64), engineVersion: ICI_ENGINE_VERSION } };
  await mkdir(join(root, ".metadata/icomposer/ici/graph/current"), { recursive: true });
  await writeFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const starts = new Map(entries.map(entry => [entry.name, graph.nodes.get(`api:${entry.name}`)]));
  const deps: any = {
    disposed: () => false,
    loadBase: async (_workspaceId: string, query: string) => { const start = starts.get(query); return start ? { ok: true, value: { graph, canonicalPath: root, start } } : { ok: false, error: { code: "no-match", message: `no api matched: ${query}` } }; },
    current: async () => ({ ok: true, value: { canonicalPath: root, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph), engineVersion: ICI_ENGINE_VERSION } }),
    refs: async () => [],
    catalog: async () => ({ ok: true, value: { entries: entries.map(entry => ({ name: entry.name, type: "api", tenant: "acme", group: "G", sourcePath: `src/dev/acme/G/api/${entry.name}/${entry.name}.groovy` })), duplicateNames: [] } }),
  };
  // Every API becomes a legacy waiting card (no batchId, no host) — the 63-card现场.
  for (const [index, entry] of entries.entries()) {
    const prepared = await prepareExplain(root, "ws", graph, graph.nodes.get(`api:${entry.name}`), []);
    const jobId = (index + 1).toString(16).padStart(16, "0");
    const record = await createJobRecord(root, {
      jobId, workspaceId: "ws", apiName: entry.name, apiId: `api:${entry.name}`, prepareArtifactPath: prepared.artifactPath,
      contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId,
      sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest,
      provider: null, model: null, docs: [], folderPath: "",
    });
    const legacy: any = { ...record };
    delete legacy.host;
    await writeJobRecordUnderLock(root, legacy);
  }
  return { root, graph, deps, entries, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function operationLogDouble(options: { failAppend?: boolean } = {}) {
  const records: Array<{ id: string; requestId: string; kind: string; paramsDigest: string; artifactRefs: readonly string[]; decision: string; resultDigest?: string }> = [];
  let seq = 0;
  return {
    records,
    service: {
      async append(input: any) { if (options.failAppend === true) throw new Error("audit-unavailable"); const record = { id: `op-${++seq}`, decision: "pending", ...input }; records.push(record); return record; },
      list(filter?: any) { return records.filter(record => (filter?.requestId === undefined || record.requestId === filter.requestId) && (filter?.kind === undefined || record.kind === filter.kind)); },
      async decide(id: string, approved: boolean, by: string) { const record = records.find(entry => entry.id === id)!; record.decision = approved ? "approved" : "rejected"; record.decidedBy = by; return record; },
      async recordResult(id: string, input: { resultDigest: string }) { const record = records.find(entry => entry.id === id)!; if (record.resultDigest !== undefined) throw new Error("already-has-result"); record.resultDigest = input.resultDigest; return record; },
    },
  };
}

async function routesFor(fx: Awaited<ReturnType<typeof fixture>>, log: ReturnType<typeof operationLogDouble>, refuse?: string) {
  const routes: any[] = [];
  const ctx: any = new Context();
  ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } });
  ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "ws", canonicalPath: fx.root }] }) });
  ctx.provide("llm", { listProviders: () => [{ id: "mvp" }] });
  ctx.provide("iciEngine", { explainBlockedTargets: (input: any) => input.workspaceId === "ws" ? runBlockedTargets(fx.deps, input) : Promise.resolve({ ok: false, error: { code: "workspace-not-found", message: "workspace does not exist" } }) });
  ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async (jobId: string) => {
    if (refuse !== undefined && jobId === refuse) return false;
    const record = await readJobRecord(fx.root, jobId);
    if (record === null) return false;
    if (record.status === "cancelled") return true;
    if (!["awaiting-input", "scheduled", "confirmed", "running"].includes(record.status)) return false;
    const { updateJobRecord } = await import("../src/explain-artifacts.ts");
    return updateJobRecord(fx.root, jobId, record.revision, { status: "cancelled", error: "cancelled" }).then(() => true).catch(() => false);
  }, taskInFlightCount: () => 0 });
  ctx.provide("iciExplainConfig", { maxConcurrent: 4, setMaxConcurrent: async () => ({ ok: true, value: { maxConcurrent: 4, maxPromptBytes: 1048576 } }) });
  ctx.provide("operationLog", log.service);
  const fiber: any = await ctx.plugin(ExplainRoutesService); await fiber.await();
  const batchCancel = async (body: unknown): Promise<any> => { const res = response(); await routes[0].handler(req("POST", "/api/icomposer-workbench/ici/explain/blocked-cancel", body), res); return { status: res.status, body: decode(res) }; };
  return { routes, batchCancel, dispose: async () => { await fiber.dispose(); } };
}

test("TASK-116 the read-only blocker resolution matches the current catalog and never writes", async () => {
  const fx = await fixture();
  try {
    const scope = await runBlockedTargets(fx.deps, { workspaceId: "ws", selector: { kind: "all" } });
    assert.equal(scope.ok, true);
    if (!scope.ok) return;
    assert.equal(scope.value.blockers.length, TOTAL);
    assert.equal(scope.value.targets, TOTAL);
    assert.equal(scope.value.memberConflicts, 0);
    assert.equal(scope.value.unresolved, 0);
    assert.equal(scope.value.root, fx.root);
    for (const blocker of scope.value.blockers) assert.equal(/prepare|artifact|\/Users|\.groovy/.test(JSON.stringify(blocker)), false);
  } finally { await fx.cleanup(); }
});

test("TASK-116 one request cancels all 63 legacy cards in chunks with exactly one audit record", async () => {
  const fx = await fixture(); const log = operationLogDouble(); const routes = await routesFor(fx, log);
  try {
    const out = await routes.batchCancel({ workspace_id: "ws", selector: { kind: "all" } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const result = out.body.result;
    assert.equal(result.requested, TOTAL);
    assert.equal(result.cancelled, TOTAL);
    assert.equal(result.alreadyCancelled, 0);
    assert.deepEqual(result.failed, []);
    assert.equal(result.chunks, Math.ceil(TOTAL / 20), "execution is chunked internally");
    assert.equal(result.recomputedTargets, TOTAL);
    assert.equal(result.memberConflicts, 0);
    // Exactly one audit record for the whole batch, metadata-only.
    assert.equal(log.records.length, 1);
    assert.equal(log.records[0]!.kind, "ici-explain-jobs-cancel");
    assert.equal(log.records[0]!.decision, "approved");
    assert.equal(log.records[0]!.artifactRefs.length, 0);
    assert.match(log.records[0]!.paramsDigest, /^[a-f0-9]{64}$/);
    assert.match(log.records[0]!.resultDigest ?? "", /^[a-f0-9]{64}$/);
    assert.match(result.audit.requestId, /^ici-explain-jobs-cancel:[a-f0-9]{16}$/);
    // Every legacy card is cancelled.
    for (const blocker of (await runBlockedTargets(fx.deps, { workspaceId: "ws", selector: { kind: "all" } })).value?.blockers ?? []) void blocker;
    const statuses: string[] = [];
    for (let index = 0; index < TOTAL; index += 1) statuses.push((await readJobRecord(fx.root, (index + 1).toString(16).padStart(16, "0")))?.status ?? "missing");
    assert.ok(statuses.every(status => status === "cancelled"), JSON.stringify(statuses.filter(status => status !== "cancelled")));

    // A repeat finds nothing left: no new audit record, honest 422.
    const again = await routes.batchCancel({ workspace_id: "ws", selector: { kind: "all" } });
    assert.equal(again.status, 422);
    assert.equal(again.body.error.code, "no-targets");
    assert.equal(log.records.length, 1, "an empty re-run never appends another audit record");
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-116 a partial failure is reported per job and never rolls back the successes", async () => {
  const fx = await fixture(); const log = operationLogDouble();
  const refused = "0000000000000005";
  const routes = await routesFor(fx, log, refused);
  try {
    const out = await routes.batchCancel({ workspace_id: "ws", selector: { kind: "all" } });
    assert.equal(out.status, 200);
    const result = out.body.result;
    assert.equal(result.cancelled, TOTAL - 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].jobId, refused);
    assert.equal(result.failed[0].code, "revision-conflict");
    assert.equal((await readJobRecord(fx.root, refused))?.status, "awaiting-input", "the refused job keeps its state");
    assert.equal((await readJobRecord(fx.root, "0000000000000001"))?.status, "cancelled", "successes are not rolled back");
    // The audit still records the executed action (one record with a result).
    assert.equal(log.records.length, 1);
    assert.match(log.records[0]!.resultDigest ?? "", /^[a-f0-9]{64}$/);
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-116 the batch audit is fail-closed and the gate/shape checks stay", async () => {
  const fx = await fixture(); const log = operationLogDouble({ failAppend: true });
  const routes = await routesFor(fx, log);
  try {
    const refused = await routes.batchCancel({ workspace_id: "ws", selector: { kind: "all" } });
    assert.equal(refused.status, 500);
    assert.equal((await readJobRecord(fx.root, "0000000000000001"))?.status, "awaiting-input", "nothing is cancelled when the audit cannot be written");
    assert.equal((await readJobRecord(fx.root, "000000000000003f"))?.status, "awaiting-input", "the last legacy card keeps its state too");

    // Shape/gate checks: no action header → 405; bad selector/workspace → 422; unknown workspace → 404.
    const ungated = { ...req("POST", "/api/icomposer-workbench/ici/explain/blocked-cancel", { workspace_id: "ws", selector: { kind: "all" } }), headers: { "content-type": "application/json" } };
    const denied = response(); await routes.routes[0].handler(ungated, denied);
    assert.equal(denied.status, 405);
    assert.equal((await routes.batchCancel({ workspace_id: "ws", selector: { kind: "api", query: "" } })).status, 422);
    assert.equal((await routes.batchCancel({ workspace_id: "", selector: { kind: "all" } })).status, 422);
    assert.equal((await routes.batchCancel({ workspace_id: "ws", selector: { kind: "all" }, extra: 1 })).status, 422);
    // An unknown workspace surfaces the shared resolution status mapping (422), never a cancel.
    const unknown = await routes.batchCancel({ workspace_id: "missing", selector: { kind: "all" } });
    assert.equal(unknown.status, 422);
    assert.equal((await readJobRecord(fx.root, "0000000000000001"))?.status, "awaiting-input");
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-116 members of another task are never part of a batch cancel", async () => {
  const fx = await fixture(); const log = operationLogDouble();
  const routes = await routesFor(fx, log);
  try {
    // Cancel every legacy card first, then create a NEW-style task over one API.
    const first = await routes.batchCancel({ workspace_id: "ws", selector: { kind: "all" } });
    assert.equal(first.status, 200);
    const task = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "api", query: "Api00" } });
    assert.equal(task.ok, true);
    if (!task.ok) return;
    const memberId = task.value.jobs[0]!.jobId;

    const scope = await runBlockedTargets(fx.deps, { workspaceId: "ws", selector: { kind: "all" } });
    assert.equal(scope.value?.blockers.length, 0, "a batch cancel has nothing to do when only members remain");
    assert.equal(scope.value?.memberConflicts, 1);
    const out = await routes.batchCancel({ workspace_id: "ws", selector: { kind: "all" } });
    assert.equal(out.status, 422, "legacy-only: a member-only scope is not cancellable");
    assert.equal(out.body.error.code, "no-targets");
    assert.equal(out.body.result.memberConflicts, 1);
    assert.equal((await readJobRecord(fx.root, memberId))?.status, "awaiting-input", "the member is untouched");
    assert.equal(log.records.length, 1, "no extra audit record for a member-only scope");
  } finally { await routes.dispose(); await fx.cleanup(); }
});


test("TASK-116 the batch endpoint rejects a wrong content type and an oversized body with zero writes", async () => {
  const fx = await fixture(); const log = operationLogDouble();
  const routes = await routesFor(fx, log);
  try {
    // 415: a non-JSON content type is refused before any resolution or audit.
    const wrongType = { ...req("POST", "/api/icomposer-workbench/ici/explain/blocked-cancel", { workspace_id: "ws", selector: { kind: "all" } }), headers: { "x-workbench-action": "1", "content-type": "text/plain", "content-length": "42" } };
    const refused = response(); await routes.routes[0].handler(wrongType, refused);
    assert.equal(refused.status, 415);

    // 413: a body over the 64 KiB request bound is refused the same way.
    const oversized = "x".repeat(70 * 1024);
    const huge = { method: "POST", url: "/api/icomposer-workbench/ici/explain/blocked-cancel", headers: { "x-workbench-action": "1", "content-type": "application/json", "content-length": String(oversized.length) }, on: () => undefined, async *[Symbol.asyncIterator]() { yield Buffer.from(oversized); } };
    const tooBig = response(); await routes.routes[0].handler(huge, tooBig);
    assert.equal(tooBig.status, 413);

    // Zero writes in both cases: no audit record, every legacy card untouched.
    assert.equal(log.records.length, 0);
    for (const jobId of ["0000000000000001", "0000000000000002", "000000000000003f"]) assert.equal((await readJobRecord(fx.root, jobId))?.status, "awaiting-input");
  } finally { await routes.dispose(); await fx.cleanup(); }
});
