import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { buildGraph } from "../src/graph.ts";
import { computeGraphDigest, createJobRecord, prepareExplain, readJobRecord } from "../src/explain-artifacts.ts";
import { resolveTaskTargets, runPrepare, runPrepareTask } from "../src/explain-native.ts";
import { ExplainRoutesService } from "../src/explain-routes.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

/**
 * TASK-114: a new task blocked by an earlier waiting card must report the blocker's
 * identity (metadata only) and let the user cancel exactly that one job through an
 * audited, fail-closed action. Nothing here changes the anti-duplicate semantics.
 */

function req(method: string, url: string, body?: unknown): any { const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)); return { method, url, headers: { "x-workbench-action": "1", "content-type": "application/json", "content-length": String(bytes.byteLength) }, on: () => undefined, async *[Symbol.asyncIterator]() { if (bytes.byteLength > 0) yield bytes; } }; }
function response(): any { const value: any = { status: 0, body: "", headers: {}, destroyed: false, writableEnded: false, writeHead(status: number, headers: Record<string, string>) { value.status = status; value.headers = headers; }, end(body?: string) { value.body = body ?? ""; value.writableEnded = true; } }; return value; }
function decode(value: any): any { return JSON.parse(value.body); }

async function fixture(names: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "task114-blocked-"));
  await mkdir(join(root, "src"), { recursive: true });
  const entries: Array<{ name: string; type: "api"; sourcePath: string }> = [];
  for (const name of names) {
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
  return { root, graph, deps, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A legacy waiting card: no batchId, no host — exactly the shape the user's real job has. */
async function legacyWaitingJob(root: string, prepared: { artifactPath: string; artifact: any }, name: string, jobId: string, createdAt: string) {
  const record = await createJobRecord(root, {
    jobId, workspaceId: "ws", apiName: name, apiId: `api:${name}`, prepareArtifactPath: prepared.artifactPath,
    contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId,
    sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest,
    provider: null, model: null, docs: [], folderPath: "",
  });
  const { writeJobRecordUnderLock } = await import("../src/explain-artifacts.ts");
  const legacy = { ...record, createdAt, updatedAt: createdAt };
  delete (legacy as Record<string, unknown>).host;
  await writeJobRecordUnderLock(root, legacy as never);
  return legacy;
}

test("TASK-114 a blocked task reports every blocker as metadata-only identity", async () => {
  const fx = await fixture(["AlphaAPI", "BetaAPI"]);
  try {
    const alpha = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:AlphaAPI"), []);
    const beta = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:BetaAPI"), []);
    await legacyWaitingJob(fx.root, alpha, "AlphaAPI", "1111111111111111", "2026-09-18T02:55:23.513Z");
    await legacyWaitingJob(fx.root, beta, "BetaAPI", "2222222222222222", "2026-09-19T03:00:00.000Z");

    const task = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "all" } });
    assert.equal(task.ok, false);
    if (task.ok) return;
    assert.equal(task.error.code, "job-active");
    const blockers = task.error.blockers ?? [];
    assert.equal(blockers.length, 2, "every blocker is reported, not just the first");
    assert.deepEqual(blockers.map(entry => entry.apiName).sort(), ["AlphaAPI", "BetaAPI"]);
    for (const entry of blockers) {
      assert.match(entry.jobId, /^[a-f0-9]{16}$/);
      assert.equal(entry.status, "awaiting-input");
      assert.equal(typeof entry.createdAt, "string");
      // Metadata only: nothing about where the source lives may travel with a blocker.
      const serialized = JSON.stringify(entry);
      assert.equal(/prepare|artifact|\.metadata|\.groovy|\//.test(serialized), false, `blocker leaked a path: ${serialized}`);
    }
    assert.equal(task.error.blockersMore, 0);
    assert.match(task.error.message, /AlphaAPI/);
    assert.match(task.error.message, /1111111111111111/);

    // The single-API path reports the same identity for its one blocker.
    const single = await runPrepare(fx.deps, { workspaceId: "ws", query: "AlphaAPI" });
    assert.equal(single.ok, false);
    assert.equal(!single.ok && (single.error.blockers ?? [])[0]?.apiName, "AlphaAPI");
  } finally { await fx.cleanup(); }
});

test("TASK-114 the blocker count is bounded while the total stays visible", async () => {
  const names = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"];
  const fx = await fixture(names);
  try {
    for (const [index, name] of names.entries()) {
      const prepared = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get(`api:${name}`), []);
      await legacyWaitingJob(fx.root, prepared, name, `${index + 1}`.repeat(16).slice(0, 16), "2026-09-18T00:00:00.000Z");
    }
    const task = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "all" } });
    assert.equal(task.ok, false);
    if (task.ok) return;
    assert.equal((task.error.blockers ?? []).length, 5, "at most five blockers travel into the tool result");
    assert.equal(task.error.blockersMore, 2, "the remaining count is still reported");
  } finally { await fx.cleanup(); }
});

/** Minimal operation-log double: records the append/decide/recordResult lifecycle. */
function operationLogDouble(options: { failAppend?: boolean } = {}) {
  const records: Array<{ id: string; requestId: string; kind: string; paramsDigest: string; artifactRefs: readonly string[]; decision: string; decidedBy?: string; resultDigest?: string }> = [];
  let seq = 0;
  return {
    records,
    service: {
      async append(input: any) { if (options.failAppend === true) throw new Error("audit-unavailable"); const record = { id: `op-${++seq}`, decision: "pending", ...input }; records.push(record); return record; },
      list(filter?: any) { return records.filter(record => (filter?.requestId === undefined || record.requestId === filter.requestId) && (filter?.kind === undefined || record.kind === filter.kind)); },
      async decide(id: string, approved: boolean, by: string) { const record = records.find(entry => entry.id === id)!; record.decision = approved ? "approved" : "rejected"; record.decidedBy = by; return record; },
      async recordResult(id: string, input: { resultDigest: string; artifactRefs: readonly string[] }) { const record = records.find(entry => entry.id === id)!; if (record.resultDigest !== undefined) throw new Error("already-has-result"); record.resultDigest = input.resultDigest; return record; },
    },
  };
}

async function routesFor(fx: Awaited<ReturnType<typeof fixture>>, log: ReturnType<typeof operationLogDouble> | undefined, schedulerResult = true) {
  const routes: any[] = [];
  const ctx: any = new Context();
  ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } });
  ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "ws", canonicalPath: fx.root }] }) });
  ctx.provide("llm", { listProviders: () => [{ id: "mvp" }] });
  ctx.provide("iciEngine", {});
  ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async (jobId: string) => {
    if (!schedulerResult) return false;
    // Mirror ExplainScheduler.cancelJob: cancel the record itself (idempotent when already cancelled).
    const record = await readJobRecord(fx.root, jobId);
    if (record === null) return false;
    if (record.status === "cancelled") return true;
    if (!["awaiting-input", "scheduled", "confirmed", "running"].includes(record.status)) return false;
    const { updateJobRecord } = await import("../src/explain-artifacts.ts");
    return updateJobRecord(fx.root, jobId, record.revision, { status: "cancelled", error: "cancelled" }).then(() => true).catch(() => false);
  }, taskInFlightCount: () => 0 });
  ctx.provide("iciExplainConfig", { maxConcurrent: 4, setMaxConcurrent: async () => ({ ok: true, value: { maxConcurrent: 4, maxPromptBytes: 1048576, maxOutputTokens: 16384 } }) });
  if (log !== undefined) ctx.provide("operationLog", log.service);
  const fiber: any = await ctx.plugin(ExplainRoutesService); await fiber.await();
  return { routes, dispose: async () => { await fiber.dispose(); } };
}

test("TASK-114 cancelling one blocker is audited, idempotent, and never touches other cards", async () => {
  const fx = await fixture(["AlphaAPI", "BetaAPI"]);
  const log = operationLogDouble();
  const routes = await routesFor(fx, log);
  try {
    const alpha = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:AlphaAPI"), []);
    const beta = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:BetaAPI"), []);
    await legacyWaitingJob(fx.root, alpha, "AlphaAPI", "1111111111111111", "2026-09-18T02:55:23.513Z");
    await legacyWaitingJob(fx.root, beta, "BetaAPI", "2222222222222222", "2026-09-18T02:55:24.000Z");

    const cancel = response();
    await routes.routes[0].handler(req("POST", "/api/icomposer-workbench/ici/explain/jobs/1111111111111111/cancel", {}), cancel);
    const body = decode(cancel);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.result.status, "cancelled");
    assert.equal(body.result.apiName, "AlphaAPI");
    assert.equal(body.result.alreadyCancelled, false);
    assert.equal(body.result.audit.requestId, "ici-explain-cancel:1111111111111111");
    // Audit: one approved record with a metadata-only digest and a result.
    assert.equal(log.records.length, 1);
    assert.equal(log.records[0]!.kind, "ici-explain-job-cancel");
    assert.equal(log.records[0]!.decision, "approved");
    assert.equal(log.records[0]!.decidedBy, "workbench-card");
    assert.match(log.records[0]!.paramsDigest, /^[a-f0-9]{64}$/);
    assert.equal(log.records[0]!.artifactRefs.length, 0, "no artifact reference is recorded");
    assert.match(log.records[0]!.resultDigest ?? "", /^[a-f0-9]{64}$/);
    assert.equal((await readJobRecord(fx.root, "1111111111111111"))?.status, "cancelled");
    assert.equal((await readJobRecord(fx.root, "2222222222222222"))?.status, "awaiting-input", "the other waiting card is untouched");

    // Idempotent: the second request is a no-op success and adds no audit record.
    const again = response();
    await routes.routes[0].handler(req("POST", "/api/icomposer-workbench/ici/explain/jobs/1111111111111111/cancel", {}), again);
    const second = decode(again);
    assert.equal(second.ok, true);
    assert.equal(second.result.alreadyCancelled, true);
    assert.equal(log.records.length, 1, "a repeated cancel never duplicates the audit record");

    // The gate and the unknown-id case stay as they were: no header → 405, unknown → 404.
    const ungated = { ...req("POST", "/api/icomposer-workbench/ici/explain/jobs/2222222222222222/cancel", {}), headers: { "content-type": "application/json" } };
    const denied = response();
    await routes.routes[0].handler(ungated, denied);
    assert.equal(denied.status, 405);
    const missing = response();
    await routes.routes[0].handler(req("POST", "/api/icomposer-workbench/ici/explain/jobs/9999999999999999/cancel", {}), missing);
    assert.equal(decode(missing).ok, false);
    assert.equal(missing.status, 404);
    assert.equal((await readJobRecord(fx.root, "2222222222222222"))?.status, "awaiting-input");
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-114 the audit gate is fail-closed: without a recordable action nothing is cancelled", async () => {
  const fx = await fixture(["AlphaAPI"]);
  const log = operationLogDouble({ failAppend: true });
  const routes = await routesFor(fx, log);
  try {
    const alpha = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:AlphaAPI"), []);
    await legacyWaitingJob(fx.root, alpha, "AlphaAPI", "1111111111111111", "2026-09-18T02:55:23.513Z");
    const res = response();
    await routes.routes[0].handler(req("POST", "/api/icomposer-workbench/ici/explain/jobs/1111111111111111/cancel", {}), res);
    assert.equal(res.status, 500);
    assert.equal(decode(res).ok, false);
    assert.equal((await readJobRecord(fx.root, "1111111111111111"))?.status, "awaiting-input", "the job is untouched when the audit cannot be written");
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-114 a final job is never cancellable through the blocker path", async () => {
  const fx = await fixture(["AlphaAPI"]);
  const log = operationLogDouble();
  const routes = await routesFor(fx, log);
  try {
    const alpha = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:AlphaAPI"), []);
    const legacy = await legacyWaitingJob(fx.root, alpha, "AlphaAPI", "1111111111111111", "2026-09-18T02:55:23.513Z");
    const { updateJobRecord } = await import("../src/explain-artifacts.ts");
    await updateJobRecord(fx.root, legacy.jobId, legacy.revision, { status: "failed", error: "model-failed" });
    const res = response();
    await routes.routes[0].handler(req("POST", "/api/icomposer-workbench/ici/explain/jobs/1111111111111111/cancel", {}), res);
    assert.equal(res.status, 409, "a terminal card reports a conflict instead of pretending to cancel");
    assert.equal(log.records.length, 0, "no audit record is written for a job that cannot be cancelled");
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-114 resolution itself is unchanged: active jobs still block, aliases never collide with themselves", async () => {
  const fx = await fixture(["AlphaAPI", "BetaAPI"]);
  try {
    // Two aliases for the same API inside one call still dedupe before the conflict check.
    const first = await resolveTaskTargets(fx.deps, "ws", { kind: "queries", queries: ["Alpha", "AlphaAPI"] });
    assert.equal(first.ok, true);
    const task = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "queries", queries: ["AlphaAPI", "BetaAPI"] } });
    assert.equal(task.ok, true);
    if (!task.ok) return;
    assert.equal(task.value.jobs.length, 2);
    // Re-running the same task now hits its own active members: the protection is intact.
    const repeat = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "queries", queries: ["BetaAPI"] } });
    assert.equal(repeat.ok, false);
    assert.equal(!repeat.ok && repeat.error.code, "job-active");
    // BetaAPI now belongs to the task created above (batchId set): legacy-only policy means
    // it is reported as a member conflict, never offered as a cancellable blocker.
    assert.equal(!repeat.ok && (repeat.error.blockers ?? []).length, 0);
    assert.equal(!repeat.ok && repeat.error.memberConflicts, 1);
  } finally { await fx.cleanup(); }
});


test("TASK-114 a conflict with another task's member is refused without a cancel entry", async () => {
  const fx = await fixture(["AlphaAPI", "BetaAPI"]);
  const log = operationLogDouble();
  const routes = await routesFor(fx, log);
  try {
    // AlphaAPI becomes a member of a NEW-style task (batchId set), i.e. not cancellable here.
    const member = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "api", query: "AlphaAPI" } });
    assert.equal(member.ok, true);
    if (!member.ok) return;
    const memberJobId = member.value.jobs[0]!.jobId;

    const task = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "all" } });
    assert.equal(task.ok, false, "a member conflict still refuses the whole task");
    if (task.ok) return;
    assert.equal(task.error.code, "job-active");
    assert.equal((task.error.blockers ?? []).length, 0, "a new-style member is never offered as a cancellable blocker");
    assert.equal(task.error.memberConflicts, 1, "the member conflict is reported honestly instead");
    assert.match(task.error.message, /another task card/);

    // The direct route refuses to cancel a member of another task, even with the action header.
    const direct = response();
    await routes.routes[0].handler(req("POST", `/api/icomposer-workbench/ici/explain/jobs/${memberJobId}/cancel`, {}), direct);
    assert.equal(direct.status, 409, JSON.stringify(decode(direct)));
    assert.equal((await readJobRecord(fx.root, memberJobId))?.status, "awaiting-input", "the member record is untouched");
    assert.equal(log.records.length, 0, "a refused cross-task cancel writes no audit record");

    // A legacy blocker in the same target set is still cancellable (and audited).
    const beta = await prepareExplain(fx.root, "ws", fx.graph, fx.graph.nodes.get("api:BetaAPI"), []);
    await legacyWaitingJob(fx.root, beta, "BetaAPI", "3333333333333333", "2026-09-20T00:00:00.000Z");
    const again = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "all" } });
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.deepEqual((again.error.blockers ?? []).map(entry => entry.apiName), ["BetaAPI"]);
    assert.equal(again.error.memberConflicts, 1);
    const cancel = response();
    await routes.routes[0].handler(req("POST", "/api/icomposer-workbench/ici/explain/jobs/3333333333333333/cancel", {}), cancel);
    assert.equal(decode(cancel).ok, true);
    assert.equal((await readJobRecord(fx.root, "3333333333333333"))?.status, "cancelled");
    assert.equal(log.records.length, 1, "only the legacy cancellation is audited");
  } finally { await routes.dispose(); await fx.cleanup(); }
});
