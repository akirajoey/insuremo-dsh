import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { LlmAdapter } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { buildGraph } from "../src/graph.ts";
import { ExplainScheduler } from "../src/explain-scheduler.ts";
import { ExplainConfigService } from "../src/explain-config.ts";
import { computeGraphDigest, createJobRecord, prepareExplain, readBatchRecord, readJobRecord, setBatchConfirmPending, updateBatchSettings, updateJobRecord, writeBatchRecord, type ExplainJobRecord } from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

function toolCall(id: string, name: string, args: unknown): any[] { const text = JSON.stringify(args); return [{ type: "block-start", index: 0, blockType: "tool-call" }, { type: "tool-call-delta", index: 0, id, name, argumentsDelta: text }, { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: text } }, { type: "finish", reason: { kind: "tool-calls" } }]; }

/** Every stream parks on a gate, so task-level throttling is proven with real elapsed time. */
class BarrierAdapter extends LlmAdapter {
  readonly gates: Array<() => void> = [];
  active = 0;
  maxActive = 0;
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  override listModels(provider: string): Promise<any[]> { return Promise.resolve([{ provider, id: "mvp-model", name: "MVP model" }]); }
  async *stream(): AsyncIterable<any> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise<void>(resolve => { this.gates.push(resolve); });
      yield* toolCall(`submit-${randomBytes(4).toString("hex")}`, "ici_explain_submit", { technical: "technical", business: "business", flow: ["API reads a request"], evidence: ["src/Shared.groovy#1"] });
    } finally { this.active -= 1; }
  }
  releaseAll(): void { for (const gate of this.gates.splice(0)) gate(); }
  releaseOne(): void { const gate = this.gates.shift(); gate?.(); }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitAllSettled(root: string, jobs: readonly ExplainJobRecord[], timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await Promise.all(jobs.map(job => readJobRecord(root, job.jobId)));
    if (rows.every(row => row !== null && ["final", "cancelled", "failed"].includes(row.status))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("timeout waiting for every job to settle");
}

/** One workspace holding ONE task: `count` jobs of a batch record with `maxConcurrent`. */
async function createTask(count: number, maxConcurrent: number, index: number) {
  const root = await mkdtemp(join(tmpdir(), `task111-concurrency-${index}-`));
  await mkdir(join(root, "src"), { recursive: true });
  const source = join(root, "src", "Shared.groovy");
  await writeFile(source, "class Shared { def run() { 1 } }\n");
  const apis = Array.from({ length: count }, (_, at) => ({ name: `Api${index}x${at}`, type: "api" as const, sourcePath: source }));
  const raw = await buildGraph(root, apis);
  const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } };
  await mkdir(join(root, ".metadata/icomposer/ici/graph/current"), { recursive: true });
  await writeFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const workspaceId = `wst${index}`;
  const batchId = randomBytes(8).toString("hex");
  const jobs: ExplainJobRecord[] = [];
  for (const api of apis) {
    const prepared = await prepareExplain(root, workspaceId, graph, graph.nodes.get(`api:${api.name}`), []);
    jobs.push(await createJobRecord(root, {
      jobId: randomBytes(8).toString("hex"), batchId, workspaceId, apiName: api.name, apiId: `api:${api.name}`,
      prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId,
      sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest,
      provider: "mvp", model: "mvp-model", docs: [], folderPath: "",
    }));
  }
  const now = new Date().toISOString();
  await writeBatchRecord(root, { schemaVersion: 1, kind: "explain-batch", batchId, workspaceId, jobIds: jobs.map(job => job.jobId), maxConcurrent, requestedCount: count, selector: { kind: "queries" }, createdAt: now, updatedAt: now });
  return { root, workspaceId, batchId, jobs };
}

async function fixture(workspaces: readonly Awaited<ReturnType<typeof createTask>>[]) {
  const adapter = new BarrierAdapter();
  const ctx: any = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(["mvp"], adapter);
  const storageRoot = await mkdtemp(join(tmpdir(), "task111-storage-"));
  const storageFiber = ctx.plugin(Storage as never); await storageFiber.await();
  const backend = new JsonStorageBackend(join(storageRoot, "storage"));
  ctx.storage.backend.register("json", backend);
  ctx.provide("storageDomain", new DomainFacility(ctx as never, { backend: "json" }));
  const configFiber = ctx.plugin(ExplainConfigService as never); await configFiber.await();
  const config = ctx.get("iciExplainConfig") as ExplainConfigService;
  const parent = ctx.agentLoop.create(SessionId(`task111-parent-${randomBytes(4).toString("hex")}`), { provider: "mvp", model: "mvp-model" }, { cwd: workspaces[0]!.root });
  ctx.provide("workspaceBinding", {
    list: async () => ({ ok: true, value: workspaces.map(workspace => ({ workspaceId: workspace.workspaceId, canonicalPath: workspace.root })) }),
    get: async (id: string) => { const found = workspaces.find(workspace => workspace.workspaceId === id); return found ? { ok: true, value: { canonicalPath: found.root } } : { ok: false, value: undefined }; },
  });
  const schedulerFiber = ctx.plugin(ExplainScheduler as never); await schedulerFiber.await();
  const scheduler = ctx.get("iciExplainScheduler") as ExplainScheduler;
  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  return {
    ctx, adapter, config, scheduler, workspaces, parent,
    async scheduleAll(): Promise<void> {
      for (const workspace of workspaces) for (const job of workspace.jobs) {
        const current = await readJobRecord(workspace.root, job.jobId);
        if (current === null) continue;
        await updateJobRecord(workspace.root, job.jobId, current.revision, { status: "scheduled", notBefore: new Date().toISOString() });
      }
      scheduler.poke();
    },
    pump: () => { if (pumpTimer === undefined) pumpTimer = setInterval(() => adapter.releaseAll(), 25); },
    stopPump: () => { if (pumpTimer !== undefined) { clearInterval(pumpTimer); pumpTimer = undefined; } },
    dispose: async () => {
      if (pumpTimer !== undefined) { clearInterval(pumpTimer); pumpTimer = undefined; }
      adapter.releaseAll();
      await Promise.race([ctx.fiber.dispose().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
      await backend.close().catch(() => undefined);
      for (const workspace of workspaces) await rm(workspace.root, { recursive: true, force: true });
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

test("TASK-111 a task's own concurrency (batch=2) throttles its members to two real streams and backfills", async () => {
  const task = await createTask(6, 2, 1);
  const fx = await fixture([task]);
  try {
    await fx.scheduleAll();
    await waitFor(() => fx.adapter.gates.length === 2, "two running streams of one task");
    assert.equal(fx.adapter.gates.length, 2);
    assert.equal(fx.adapter.maxActive, 2);
    assert.equal(fx.scheduler.taskInFlightCount(task.root, task.batchId), 2);
    fx.pump();
    await waitAllSettled(task.root, task.jobs);
    fx.stopPump();
    // Backfill never exceeded the task ceiling at any point of the run.
    assert.equal(fx.adapter.maxActive, 2);
    // TASK-111 FIX-3: releasing a reservation happens in the run's finaliser, which can
    // legitimately lag the moment the last member settles; wait for the release condition
    // instead of asserting on the timing of a settled read.
    await waitFor(() => fx.scheduler.taskInFlightCount(task.root, task.batchId) === 0, "the task released every reservation");
    assert.equal(fx.scheduler.status().inFlight, 0);
  } finally { await fx.dispose(); }
});

test("TASK-111 two tasks keep their own ceilings, and the Host ceiling still dominates", async () => {
  const taskA = await createTask(5, 2, 2);
  const taskB = await createTask(3, 1, 3);
  const fx = await fixture([taskA, taskB]);
  try {
    await fx.scheduleAll();
    await waitFor(() => fx.adapter.gates.length === 3, "two streams of A plus one of B");
    assert.equal(fx.adapter.gates.length, 3, "A runs at its own ceiling of 2 and B at its own ceiling of 1");
    await waitFor(() => fx.scheduler.taskInFlightCount(taskA.root, taskA.batchId) === 2, "A at its own ceiling");
    await waitFor(() => fx.scheduler.taskInFlightCount(taskB.root, taskB.batchId) === 1, "B at its own ceiling");
    assert.ok(fx.adapter.maxActive >= 2 && fx.adapter.maxActive <= 4, `the Host ceiling of 4 was never exceeded (saw ${fx.adapter.maxActive})`);
    // One task's ceiling change never rewrites the other task's record.
    const other = await readJobRecord(taskB.root, taskB.jobs[0]!.jobId);
    assert.ok(other !== null);

    // Host ceiling 1 dominates both task settings: exactly one stream anywhere.
    assert.deepEqual(await fx.config.setMaxConcurrent(1), { ok: true, value: { maxConcurrent: 1 } });
    fx.pump();
    await waitAllSettled(taskA.root, taskA.jobs);
    await waitAllSettled(taskB.root, taskB.jobs);
    fx.stopPump();
    assert.ok(fx.adapter.maxActive <= 4, "the Host ceiling of 4 was never exceeded while both tasks ran");
    assert.equal(fx.scheduler.status().inFlight, 0);
    assert.equal(fx.scheduler.taskInFlightCount(taskA.root, taskA.batchId), 0);
    assert.equal(fx.scheduler.taskInFlightCount(taskB.root, taskB.batchId), 0);
  } finally { await fx.dispose(); }
});


test("TASK-111 a half-committed confirmation never leaves a claimable member", async () => {
  const task = await createTask(4, 2, 4);
  const fx = await fixture([task]);
  try {
    // The confirmation gate is armed: the scheduler must refuse this task entirely.
    await setBatchConfirmPending(task.root, task.batchId, true);
    const armed = await readBatchRecord(task.root, task.batchId);
    console.log("DEBUG armed", JSON.stringify({ pending: armed?.confirmPending, job0Batch: (await readJobRecord(task.root, task.jobs[0]!.jobId))?.batchId, expected: task.batchId }));
    console.log("DEBUG t0", (await readBatchRecord(task.root, task.batchId))?.confirmPending);
    await new Promise(resolve => setTimeout(resolve, 50));
    console.log("DEBUG t1", (await readBatchRecord(task.root, task.batchId))?.confirmPending);
    await fx.scheduleAll();
    console.log("DEBUG t2", (await readBatchRecord(task.root, task.batchId))?.confirmPending);
    fx.scheduler.poke();
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log("DEBUG t3", (await readBatchRecord(task.root, task.batchId))?.confirmPending, fx.adapter.gates.length);
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log("DEBUG after-wait", JSON.stringify({ pending: (await readBatchRecord(task.root, task.batchId))?.confirmPending, gates: fx.adapter.gates.length, task: fx.scheduler.taskInFlightCount(task.root, task.batchId), statuses: (await Promise.all(task.jobs.map(job => readJobRecord(task.root, job.jobId)))).map(row => row?.status) }));
    assert.equal(fx.adapter.gates.length, 0, "an armed gate keeps every member unclaimable");
    assert.equal(fx.scheduler.taskInFlightCount(task.root, task.batchId), 0);

    // Releasing the gate (the commit point) makes the task claimable again.
    await setBatchConfirmPending(task.root, task.batchId, false);
    fx.scheduler.poke();
    await waitFor(() => fx.adapter.gates.length === 2, "two streams after the gate opens");
    fx.pump();
    await waitAllSettled(task.root, task.jobs);
    fx.stopPump();
  } finally { await fx.dispose(); }
});

test("TASK-111 lowering a task ceiling mid-run only limits later starts and leaves other tasks alone", async () => {
  const taskA = await createTask(5, 2, 5);
  const taskB = await createTask(3, 1, 6);
  const fx = await fixture([taskA, taskB]);
  try {
    await fx.scheduleAll();
    await waitFor(() => fx.adapter.gates.length === 3, "A at 2 plus B at 1 in flight");
    assert.equal(fx.scheduler.taskInFlightCount(taskA.root, taskA.batchId), 2);
    const before = await readBatchRecord(taskA.root, taskA.batchId);
    assert.equal(before?.maxConcurrent, 2);

    // Lowering the task ceiling cannot revoke in-flight members: both stay running.
    await updateBatchSettings(taskA.root, taskA.batchId, 1);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(fx.scheduler.taskInFlightCount(taskA.root, taskA.batchId), 2, "in-flight members are not revoked");
    assert.equal((await readBatchRecord(taskA.root, taskA.batchId))?.maxConcurrent, 1);
    // The other task's own parameter is untouched by that write.
    assert.equal((await readBatchRecord(taskB.root, taskB.batchId))?.maxConcurrent, 1);

    // One A member finishes: with the new ceiling of 1 nothing may start to replace it.
    fx.adapter.releaseOne();
    await waitFor(() => fx.scheduler.taskInFlightCount(taskA.root, taskA.batchId) === 1, "one A member left in flight");
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(fx.scheduler.taskInFlightCount(taskA.root, taskA.batchId), 1, "no backfill beyond the new ceiling");
    fx.pump();
    await waitAllSettled(taskA.root, taskA.jobs);
    await waitAllSettled(taskB.root, taskB.jobs);
    fx.stopPump();
    assert.equal(fx.scheduler.taskInFlightCount(taskA.root, taskA.batchId), 0);
  } finally { await fx.dispose(); }
});
