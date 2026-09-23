import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ExplainRoutesService } from "../src/explain-routes.ts";
import { createJobRecord, updateJobRecord, writeBatchRecord } from "../src/explain-artifacts.ts";

function req(method: string, url: string, body?: unknown): any { const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)); return { method, url, headers: { "x-workbench-action": "1", "content-type": "application/json", "content-length": String(bytes.byteLength) }, on: () => undefined, async *[Symbol.asyncIterator]() { if (bytes.byteLength > 0) yield bytes; } }; }
function response(): any { const value: any = { status: 0, body: "", headers: {}, destroyed: false, writableEnded: false, writeHead(status: number, headers: Record<string, string>) { value.status = status; value.headers = headers; }, end(body?: string) { value.body = body ?? ""; value.writableEnded = true; } }; return value; }
function decode(value: any): any { return JSON.parse(value.body); }

const batchId = "abcdefabcdefabcd";
const workspaceId = "ws-paging";

/** 12 members written directly: the status route is exercised without needing a graph. */
async function fixture(count = 12) {
  const root = await mkdtemp(join(tmpdir(), "task111-paging-"));
  await mkdir(join(root, ".metadata/icomposer/ici/explain/batches"), { recursive: true });
  const jobIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const jobId = index.toString(16).padStart(16, "0");
    jobIds.push(jobId);
    await createJobRecord(root, {
      jobId, batchId, workspaceId, apiName: `Api${String(index).padStart(2, "0")}`, apiId: `api:Api${index}`,
      prepareArtifactPath: `.metadata/icomposer/ici/explain/Api${index}/prepare.json`, contextHash: "c".repeat(64),
      prepareId: "a".repeat(32), sourceFingerprint: "a".repeat(64), graphDigest: "b".repeat(64),
      provider: null, model: null, docs: [], folderPath: "",
    });
    if (index % 4 === 0) await updateJobRecord(root, jobId, 1, { status: "failed", error: "model-failed" });
  }
  const now = new Date().toISOString();
  await writeBatchRecord(root, { schemaVersion: 1, kind: "explain-batch", batchId, workspaceId, jobIds, jobCount: jobIds.length, maxConcurrent: 4, requestedCount: jobIds.length, selector: { kind: "all", label: "all" }, createdAt: now, updatedAt: now });

  const routes: any[] = [];
  const ctx: any = new Context();
  ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } });
  ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId, canonicalPath: root }] }) });
  ctx.provide("llm", { listProviders: () => [{ id: "mvp" }], listModels: async () => [] });
  ctx.provide("iciEngine", {});
  ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async () => true, taskInFlightCount: () => 2 });
  ctx.provide("iciExplainConfig", { maxConcurrent: 4, setMaxConcurrent: async () => ({ ok: true, value: { maxConcurrent: 4, maxPromptBytes: 1048576, maxOutputTokens: 16384 } }) });
  const fiber: any = await ctx.plugin(ExplainRoutesService); await fiber.await();
  const status = async (query = ""): Promise<any> => { const res = response(); await routes[0].handler(req("GET", `/api/icomposer-workbench/ici/explain/batches/${batchId}/status${query}`), res); return decode(res); };
  return { root, jobIds, status, dispose: async () => { await fiber.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test("TASK-111 P4 the status route answers one bounded page plus real whole-task counts", async () => {
  const fx = await fixture();
  try {
    const first = await fx.status();
    assert.equal(first.ok, true);
    assert.equal(first.result.page.size, 5, "the server default page size matches the card");
    assert.equal(first.result.page.index, 1);
    assert.equal(first.result.page.totalPages, 3);
    assert.equal(first.result.jobs.length, 5, "only one page of members is returned");
    assert.deepEqual(first.result.jobs.map((job: any) => job.jobId), fx.jobIds.slice(0, 5));
    assert.equal(first.result.summary.jobCount, 12, "counts are for the whole task, not the page");
    assert.equal(first.result.summary.countsByStatus.failed, 3);
    assert.equal(first.result.summary.countsByStatus["awaiting-input"], 9);
    // The response never echoes the full id list (bounded), but the total stays exact.
    assert.equal(first.result.batch.jobIds, undefined);
    assert.equal(first.result.batch.jobCount, 12);
    assert.equal(first.result.batch.requestedCount, 12);

    const last = await fx.status("?page=3&size=5");
    assert.equal(last.result.jobs.length, 2);
    assert.deepEqual(last.result.jobs.map((job: any) => job.jobId), fx.jobIds.slice(10));

    const beyond = await fx.status("?page=99&size=5");
    assert.equal(beyond.result.page.index, 3, "an out-of-range page is clamped, never empty-by-accident");
    assert.equal(beyond.result.jobs.length, 2);

    const big = await fx.status("?page=1&size=200");
    assert.equal(big.result.jobs.length, 12);
    assert.equal(big.result.page.totalPages, 1);
  } finally { await fx.dispose(); }
});

test("TASK-111 P4 the summary cache is invalidated by the task status version", async () => {
  const fx = await fixture(4);
  try {
    const before = await fx.status();
    // The fixture marks every fourth member failed, so the first read is 1 failed / 3 awaiting.
    assert.equal(before.result.summary.countsByStatus.failed, 1);
    assert.equal(before.result.summary.countsByStatus["awaiting-input"], 3);
    // A member status change bumps the task version, so the next read must not serve the cached counts.
    const jobId = fx.jobIds[1]!;
    await updateJobRecord(fx.root, jobId, 1, { status: "failed", error: "model-failed" });
    const after = await fx.status();
    assert.equal(after.result.summary.countsByStatus.failed, 2);
    assert.equal(after.result.summary.countsByStatus["awaiting-input"], 2);
    assert.equal(after.result.summary.jobCount, 4);
    // The card's scheduler view keeps the task ceiling and the live count separate from the Host ceiling.
    assert.equal(after.result.scheduler.taskMaxConcurrent, 4);
    assert.equal(after.result.scheduler.taskInFlight, 2);
    assert.equal(after.result.scheduler.hostMaxConcurrent, 4);
  } finally { await fx.dispose(); }
});


test("TASK-111 P4 250 targets are ONE task card, every target browsable", async () => {
  const fx = await fixture(250);
  try {
    const first = await fx.status();
    // One task record carries every target: no 10-per-card split, and the counts are exact.
    assert.equal(first.result.batch.jobCount, 250);
    assert.equal(first.result.batch.requestedCount, 250);
    assert.equal(first.result.summary.jobCount, 250);
    assert.equal(first.result.page.totalPages, 50, "50 pages of the card's page size cover all 250 targets");
    assert.equal(first.result.jobs.length, 5, "one bounded page per request");
    // The last page is reachable and exact: nothing is truncated by paging.
    const last = await fx.status("?page=50");
    assert.equal(last.result.jobs.length, 5);
    assert.equal(last.result.jobs[4].apiName, "Api249");
    assert.equal(last.result.page.index, 50);
  } finally { await fx.dispose(); }
});
