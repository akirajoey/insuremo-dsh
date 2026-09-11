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
import { computeGraphDigest, createJobRecord, prepareExplain, readJobRecord, updateJobRecord, type ExplainJobRecord } from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

function toolCall(id: string, name: string, args: unknown): any[] { const text = JSON.stringify(args); return [{ type: "block-start", index: 0, blockType: "tool-call" }, { type: "tool-call-delta", index: 0, id, name, argumentsDelta: text }, { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: text } }, { type: "finish", reason: { kind: "tool-calls" } }]; }

/**
 * TASK-102 barrier adapter: every stream parks on a gate until the test
 * releases it, so concurrency is observed with real elapsed time instead of
 * the zero-delay interleaving that cannot prove throttling.
 */
class BarrierAdapter extends LlmAdapter {
  readonly gates: Array<() => void> = [];
  active = 0;
  maxActive = 0;
  calls = 0;
  submits = 0;
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  override listModels(provider: string): Promise<any[]> { return Promise.resolve([{ provider, id: "mvp-model", name: "MVP model" }]); }
  async *stream(): AsyncIterable<any> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise<void>(resolve => { this.gates.push(resolve); });
      this.calls += 1;
      this.submits += 1;
      yield* toolCall(`submit-${this.calls}`, "ici_explain_submit", { technical: "technical", business: "business", flow: ["API reads a request"], evidence: ["src/Shared.groovy#1"] });
    } finally {
      this.active -= 1;
    }
  }
  releaseAll(): void { for (const gate of this.gates.splice(0)) gate(); }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitAllFinal(root: string, jobs: readonly ExplainJobRecord[], timeoutMs = 30_000): Promise<void> {
  await waitFor(() => true, "noop", 1);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await Promise.all(jobs.map(job => readJobRecord(root, job.jobId)));
    if (rows.every(row => row?.status === "final" || row?.status === "cancelled" || row?.status === "failed")) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("timeout waiting for all jobs to settle");
}

interface WorkspaceJobs { readonly root: string; readonly workspaceId: string; readonly jobs: readonly ExplainJobRecord[] }

async function createWorkspaceJobs(count: number, index = 0): Promise<WorkspaceJobs> {
  const root = await mkdtemp(join(tmpdir(), `task102-concurrency-${index}-`));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "ref_doc", "nested"), { recursive: true });
  await writeFile(join(root, "ref_doc", "nested", "meaning.md"), "meaning\n");
  const sharedSource = join(root, "src", "Shared.groovy");
  await writeFile(sharedSource, "class Shared { def run() { 1 } }\n");
  const apis: Array<{ name: string; type: "api"; sourcePath: string }> = [];
  for (let i = 0; i < count; i += 1) {
    apis.push({ name: `Api${index}x${i}`, type: "api", sourcePath: sharedSource });
  }
  const raw = await buildGraph(root, apis);
  const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } };
  await mkdir(join(root, ".metadata/icomposer/ici/graph/current"), { recursive: true });
  await writeFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const workspaceId = `ws${index}`;
  const jobs: ExplainJobRecord[] = [];
  for (const api of apis) {
    const prepared = await prepareExplain(root, workspaceId, graph, graph.nodes.get(`api:${api.name}`), []);
    jobs.push(await createJobRecord(root, {
      jobId: randomBytes(8).toString("hex"), workspaceId, apiName: api.name, apiId: `api:${api.name}`,
      prepareArtifactPath: prepared.artifactPath, contextHash: prepared.artifact.contextHash, prepareId: prepared.artifact.prepareId,
      sourceFingerprint: prepared.artifact.manifest.sourceFingerprint, graphDigest: prepared.artifact.manifest.graphDigest,
      provider: "mvp", model: "mvp-model", docs: [], folderPath: "ref_doc",
    }));
  }
  return { root, workspaceId, jobs };
}

interface Fixture {
  readonly ctx: any;
  readonly adapter: BarrierAdapter;
  readonly config: ExplainConfigService;
  readonly scheduler: ExplainScheduler;
  readonly parent: any;
  readonly workspaces: readonly WorkspaceJobs[];
  scheduleAll(notBefore?: string): Promise<void>;
  pump(): void;
  stopPump(): void;
  dispose(): Promise<void>;
}

async function fixture(workspaces: readonly WorkspaceJobs[]): Promise<Fixture> {
  const adapter = new BarrierAdapter();
  const ctx: any = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(["mvp"], adapter);
  const storageRoot = await mkdtemp(join(tmpdir(), "task102-storage-"));
  const storageFiber = ctx.plugin(Storage as never); await storageFiber.await();
  const backend = new JsonStorageBackend(join(storageRoot, "storage"));
  ctx.storage.backend.register("json", backend);
  ctx.provide("storageDomain", new DomainFacility(ctx as never, { backend: "json" }));
  const configFiber = ctx.plugin(ExplainConfigService as never); await configFiber.await();
  const config = ctx.get("iciExplainConfig") as ExplainConfigService;
  const parent = ctx.agentLoop.create(SessionId(`task102-parent-${randomBytes(4).toString("hex")}`), { provider: "mvp", model: "mvp-model" }, { cwd: workspaces[0]!.root });
  ctx.provide("workspaceBinding", {
    list: async () => ({ ok: true, value: workspaces.map(workspace => ({ workspaceId: workspace.workspaceId, canonicalPath: workspace.root })) }),
    get: async (id: string) => { const found = workspaces.find(workspace => workspace.workspaceId === id); return found ? { ok: true, value: { canonicalPath: found.root } } : { ok: false, value: undefined }; },
  });
  const schedulerFiber = ctx.plugin(ExplainScheduler as never); await schedulerFiber.await();
  const scheduler = ctx.get("iciExplainScheduler") as ExplainScheduler;
  const scheduleAll = async (notBefore?: string): Promise<void> => {
    for (const workspace of workspaces) {
      for (const job of workspace.jobs) {
        const current = await readJobRecord(workspace.root, job.jobId);
        if (current === undefined) continue;
        await updateJobRecord(workspace.root, job.jobId, current.revision, { status: "scheduled", notBefore: notBefore ?? new Date().toISOString() });
      }
    }
    scheduler.poke();
  };
  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  return {
    ctx, adapter, config, scheduler, parent, workspaces, scheduleAll,
    pump: () => { if (pumpTimer === undefined) pumpTimer = setInterval(() => adapter.releaseAll(), 25); },
    stopPump: () => { if (pumpTimer !== undefined) { clearInterval(pumpTimer); pumpTimer = undefined; } },
    dispose: async () => {
      // Release parked streams so disposal can never deadlock on an unreleased gate.
      if (pumpTimer !== undefined) { clearInterval(pumpTimer); pumpTimer = undefined; }
      adapter.releaseAll();
      await Promise.race([ctx.fiber.dispose().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
      await backend.close().catch(() => undefined);
      for (const workspace of workspaces) await rm(workspace.root, { recursive: true, force: true });
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

const readStatuses = async (fixtureValue: Fixture): Promise<string[]> => {
  const rows: string[] = [];
  for (const workspace of fixtureValue.workspaces) for (const job of workspace.jobs) rows.push((await readJobRecord(workspace.root, job.jobId))?.status ?? "missing");
  return rows;
};

test("TASK-102: default cap 4 throttles 12 queued jobs to four real streams", async () => {
  const workspace = await createWorkspaceJobs(12);
  const fx = await fixture([workspace]);
  try {
    await fx.scheduleAll();
    await waitFor(() => fx.adapter.gates.length === 4, "four running streams");
    assert.equal(fx.adapter.gates.length, 4);
    assert.equal(fx.adapter.maxActive, 4);
    fx.pump();
    await waitAllFinal(workspace.root, workspace.jobs);
    fx.stopPump();
    fx.adapter.releaseAll();
    assert.equal(fx.adapter.maxActive, 4);
    assert.deepEqual((await readStatuses(fx)).filter(status => status === "final").length, 12);
  } finally { await fx.dispose(); }
});

test("TASK-102: cap 1 serializes streams (no more than one active stream)", async () => {
  const workspace = await createWorkspaceJobs(3);
  const fx = await fixture([workspace]);
  try {
    assert.deepEqual(await fx.config.setMaxConcurrent(1), { ok: true, value: { maxConcurrent: 1 } });
    await fx.scheduleAll();
    await waitFor(() => fx.adapter.gates.length === 1, "one running stream");
    assert.equal(fx.adapter.maxActive, 1);
    fx.pump();
    await waitAllFinal(workspace.root, workspace.jobs);
    fx.stopPump();
    assert.equal(fx.adapter.maxActive, 1);
    assert.deepEqual((await readStatuses(fx)).filter(status => status === "final").length, 3);
  } finally { await fx.dispose(); }
});

test("TASK-102: raising the cap fills the new capacity immediately", async () => {
  const workspace = await createWorkspaceJobs(4);
  const fx = await fixture([workspace]);
  try {
    await fx.config.setMaxConcurrent(1);
    await fx.scheduleAll();
    await waitFor(() => fx.adapter.gates.length === 1, "initial single stream");
    assert.deepEqual(await fx.config.setMaxConcurrent(3), { ok: true, value: { maxConcurrent: 3 } });
    await waitFor(() => fx.adapter.gates.length === 3, "capacity filled to the new cap");
    assert.equal(fx.adapter.maxActive, 3);
    fx.pump();
    await waitAllFinal(workspace.root, workspace.jobs);
    fx.stopPump();
  } finally { await fx.dispose(); }
});

test("TASK-102: lowering the cap keeps in-flight jobs and throttles only new starts", async () => {
  const workspace = await createWorkspaceJobs(6);
  const fx = await fixture([workspace]);
  try {
    await fx.scheduleAll();
    await waitFor(() => fx.adapter.gates.length === 4, "four running at the default cap");
    assert.deepEqual(await fx.config.setMaxConcurrent(1), { ok: true, value: { maxConcurrent: 1 } });
    assert.equal(fx.adapter.gates.length, 4, "lowering never cancels in-flight jobs");
    assert.equal(fx.adapter.maxActive, 4);
    assert.deepEqual(fx.scheduler.status(), { maxConcurrent: 1, inFlight: 4 });
    fx.pump();
    await waitFor(() => fx.adapter.gates.length <= 1, "at most one new stream at the reduced cap");
    assert.ok(fx.adapter.gates.length <= 1);
    await waitAllFinal(workspace.root, workspace.jobs);
    fx.stopPump();
  } finally { await fx.dispose(); }
});

test("TASK-102: two workspaces share the one Host-wide cap", async () => {
  const first = await createWorkspaceJobs(3, 0);
  const second = await createWorkspaceJobs(3, 1);
  const fx = await fixture([first, second]);
  try {
    await fx.scheduleAll();
    await waitFor(() => fx.adapter.gates.length === 4, "four running spread across both workspaces");
    assert.equal(fx.adapter.gates.length, 4);
    assert.equal(fx.adapter.maxActive, 4);
    fx.pump();
    await waitAllFinal(first.root, first.jobs);
    await waitAllFinal(second.root, second.jobs);
    fx.stopPump();
    assert.ok(fx.adapter.maxActive <= 4);
  } finally { await fx.dispose(); }
});

test("TASK-102: cancelling an in-flight job frees capacity for the next queued job", async () => {
  const workspace = await createWorkspaceJobs(2);
  const fx = await fixture([workspace]);
  try {
    await fx.config.setMaxConcurrent(1);
    await fx.scheduleAll();
    await waitFor(() => fx.adapter.gates.length === 1, "first running stream");
    const running = await Promise.all(workspace.jobs.map(job => readJobRecord(workspace.root, job.jobId)));
    const active = running.find(row => row?.status === "running");
    assert.ok(active, "one job is running");
    await fx.scheduler.cancelJob(active.jobId);
    await waitFor(() => true, "noop", 1);
    {
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        if ((await readJobRecord(workspace.root, active.jobId))?.status === "cancelled") break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal((await readJobRecord(workspace.root, active.jobId))?.status, "cancelled");
    }
    fx.pump();
    await waitFor(() => fx.adapter.calls >= 2, "replacement stream after the cancel");
    await waitAllFinal(workspace.root, workspace.jobs);
    fx.stopPump();
    const statuses = await readStatuses(fx);
    assert.equal(statuses.filter(status => status === "final").length, 1);
    assert.equal(statuses.filter(status => status === "cancelled").length, 1);
  } finally { await fx.dispose(); }
});

test("TASK-102: a future notBefore never starves an already-due job", async () => {
  const workspace = await createWorkspaceJobs(2);
  const fx = await fixture([workspace]);
  try {
    await fx.config.setMaxConcurrent(1);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    for (const [index, job] of workspace.jobs.entries()) {
      const current = await readJobRecord(workspace.root, job.jobId);
      await updateJobRecord(workspace.root, job.jobId, current!.revision, { status: "scheduled", notBefore: index === 0 ? future : new Date().toISOString() });
    }
    fx.scheduler.poke();
    await waitFor(() => fx.adapter.gates.length === 1, "due job runs while the future job waits");
    assert.equal(fx.adapter.gates.length, 1);
    fx.adapter.releaseAll();
    await waitFor(() => fx.adapter.submits === 1, "due job submitted");
    {
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        if ((await readJobRecord(workspace.root, workspace.jobs[1]!.jobId))?.status === "final") break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const statuses = await readStatuses(fx);
    assert.equal(statuses.filter(status => status === "final").length, 1, "the due job completed");
    assert.equal(statuses.filter(status => status === "scheduled").length, 1, "the future job is untouched");
  } finally { await fx.dispose(); }
});

test("TASK-102: strict setting validation and storage failure keep the previous cap", async () => {
  const workspace = await createWorkspaceJobs(1);
  const fx = await fixture([workspace]);
  try {
    for (const invalid of [0, -1, 1.5, 33, Number.NaN, Number.POSITIVE_INFINITY, "4", null, undefined, true]) {
      const result = await fx.config.setMaxConcurrent(invalid);
      assert.deepEqual(result, { ok: false, code: "invalid-input" }, `rejects ${String(invalid)}`);
      assert.equal(fx.config.maxConcurrent, 4, "invalid input never changes the effective cap");
    }
    assert.deepEqual(await fx.config.setMaxConcurrent(8), { ok: true, value: { maxConcurrent: 8 } });
    assert.equal(fx.config.maxConcurrent, 8);
    await fx.config.dispose();
    assert.deepEqual(await fx.config.setMaxConcurrent(2), { ok: false, code: "storage-error" });
    assert.equal(fx.config.maxConcurrent, 8, "a persistence failure keeps the previous value");
  } finally { await fx.dispose(); }
});

test("TASK-102: disposing waits for in-flight jobs and never starts new ones", async () => {
  const workspace = await createWorkspaceJobs(6);
  const fx = await fixture([workspace]);
  try {
    await fx.scheduleAll();
    await waitFor(() => fx.adapter.gates.length === 4, "four running before disposal");
    let disposed = false;
    const disposal = fx.scheduler.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(disposed, false, "disposal waits for in-flight jobs");
    assert.equal(fx.adapter.gates.length, 4, "no replacement starts after disposal");
    fx.adapter.releaseAll();
    await disposal;
    assert.equal(disposed, true);
    const statuses = await readStatuses(fx);
    assert.equal(statuses.filter(status => status === "scheduled").length, 2, "queued jobs stay scheduled and untouched");
  } finally { await fx.dispose(); }
});

test("TASK-102 P1-01: a busy first root never starves an idle second root", async () => {
  const workspace = await createWorkspaceJobs(2);
  const fx = await fixture([workspace]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    let entered = false;
    const maintenance = fx.parent.runMaintenance(async () => { entered = true; await gate; });
    await waitFor(() => entered, "first root maintenance entered");
    const second = fx.ctx.agentLoop.create(SessionId(`task102-second-${randomBytes(4).toString("hex")}`), { provider: "mvp", model: "mvp-model" }, { cwd: workspace.root });
    await second.whenIdle();
    await fx.scheduleAll();
    // The first root is blocked by the real maintenance gate; both jobs must
    // still run on the idle second root (the pre-fix pin wedged the fill loop).
    await waitFor(() => fx.adapter.gates.length === 2, "both jobs start on the idle second root", 5_000);
    assert.equal(fx.adapter.active, 2);
    release(); await maintenance;
    fx.pump(); await waitAllFinal(workspace.root, workspace.jobs); fx.stopPump();
    assert.deepEqual((await readStatuses(fx)).filter(status => status === "final").length, 2);
  } finally {
    release(); await fx.dispose();
  }
});

test("TASK-102 P1-01: releasing one busy root resumes the queue without an explicit poke", async () => {
  const workspace = await createWorkspaceJobs(1);
  const fx = await fixture([workspace]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    let entered = false;
    const maintenance = fx.parent.runMaintenance(async () => { entered = true; await gate; });
    await waitFor(() => entered, "only user root maintenance entered");
    await fx.scheduleAll();
    // Every user root is busy: nothing may start, and no reservation may leak.
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(fx.adapter.gates.length, 0, "no job starts while every user root is busy");
    assert.deepEqual(fx.scheduler.status(), { maxConcurrent: 4, inFlight: 0 });
    release(); await maintenance;
    // No manual poke: the one-shot idle wake must resume the queue.
    await waitFor(() => fx.adapter.gates.length === 1, "queue resumes from the idle wake alone", 5_000);
    fx.pump(); await waitAllFinal(workspace.root, workspace.jobs); fx.stopPump();
    assert.equal((await readStatuses(fx)).filter(status => status === "final").length, 1);
  } finally {
    release(); await fx.dispose();
  }
});

test("TASK-102 P1-02: decreasing the cap inside the binding.get window starts nothing beyond it", async () => {
  const workspace = await createWorkspaceJobs(2);
  const fx = await fixture([workspace]);
  let releaseGet!: () => void;
  const getGate = new Promise<void>(resolve => { releaseGet = resolve; });
  const originalGet = fx.ctx.workspaceBinding.get;
  try {
    await fx.config.setMaxConcurrent(2);
    const [first, secondJob] = workspace.jobs as [ExplainJobRecord, ExplainJobRecord];
    await updateJobRecord(workspace.root, first.jobId, first.revision, { status: "scheduled", notBefore: new Date().toISOString() });
    fx.scheduler.poke();
    await waitFor(() => fx.adapter.gates.length === 1, "first stream running");
    let getEntered = false;
    fx.ctx.workspaceBinding.get = async (id: string) => { getEntered = true; await getGate; return originalGet(id); };
    await updateJobRecord(workspace.root, secondJob.jobId, secondJob.revision, { status: "scheduled", notBefore: new Date().toISOString() });
    fx.scheduler.poke();
    await waitFor(() => getEntered, "second job parked in binding.get");
    assert.deepEqual(fx.scheduler.status(), { maxConcurrent: 2, inFlight: 1 });
    assert.deepEqual(await fx.config.setMaxConcurrent(1), { ok: true, value: { maxConcurrent: 1 } });
    releaseGet();
    await new Promise(resolve => setTimeout(resolve, 1_200));
    assert.equal(fx.adapter.gates.length, 1, "no second stream past the reduced cap");
    assert.equal(fx.adapter.active, 1);
    assert.deepEqual(fx.scheduler.status(), { maxConcurrent: 1, inFlight: 1 });
    assert.equal((await readJobRecord(workspace.root, secondJob.jobId))?.status, "scheduled", "the parked job stays claimable");
    // The slot is intact: after the running job completes, the queued one runs.
    fx.pump();
    await waitAllFinal(workspace.root, workspace.jobs);
    fx.stopPump();
    const statuses = await readStatuses(fx);
    assert.equal(statuses.filter(status => status === "final").length, 2, "no capacity slot was leaked");
  } finally {
    releaseGet(); fx.ctx.workspaceBinding.get = originalGet; await fx.dispose();
  }
});

test("TASK-102 P1-02: a cancel inside the binding.get window never starts the job", async () => {
  const workspace = await createWorkspaceJobs(2);
  const fx = await fixture([workspace]);
  let releaseGet!: () => void;
  const getGate = new Promise<void>(resolve => { releaseGet = resolve; });
  const originalGet = fx.ctx.workspaceBinding.get;
  try {
    await fx.config.setMaxConcurrent(2);
    const [first, secondJob] = workspace.jobs as [ExplainJobRecord, ExplainJobRecord];
    await updateJobRecord(workspace.root, first.jobId, first.revision, { status: "scheduled", notBefore: new Date().toISOString() });
    fx.scheduler.poke();
    await waitFor(() => fx.adapter.gates.length === 1, "first stream running");
    let getEntered = false;
    fx.ctx.workspaceBinding.get = async (id: string) => { getEntered = true; await getGate; return originalGet(id); };
    await updateJobRecord(workspace.root, secondJob.jobId, secondJob.revision, { status: "scheduled", notBefore: new Date().toISOString() });
    fx.scheduler.poke();
    await waitFor(() => getEntered, "second job parked in binding.get");
    await fx.scheduler.cancelJob(secondJob.jobId);
    releaseGet();
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal((await readJobRecord(workspace.root, secondJob.jobId))?.status, "cancelled");
    assert.equal(fx.adapter.gates.length, 1, "a cancelled claim never becomes a stream");
    assert.deepEqual(fx.scheduler.status(), { maxConcurrent: 2, inFlight: 1 }, "the reservation is released exactly once");
    fx.pump(); await waitAllFinal(workspace.root, workspace.jobs); fx.stopPump();
  } finally {
    releaseGet(); fx.ctx.workspaceBinding.get = originalGet; await fx.dispose();
  }
});

test("TASK-102 P1-02: disposing inside the binding.get window starts nothing afterwards", async () => {
  const workspace = await createWorkspaceJobs(2);
  const fx = await fixture([workspace]);
  let releaseGet!: () => void;
  const getGate = new Promise<void>(resolve => { releaseGet = resolve; });
  const originalGet = fx.ctx.workspaceBinding.get;
  try {
    await fx.config.setMaxConcurrent(2);
    const [first, secondJob] = workspace.jobs as [ExplainJobRecord, ExplainJobRecord];
    await updateJobRecord(workspace.root, first.jobId, first.revision, { status: "scheduled", notBefore: new Date().toISOString() });
    fx.scheduler.poke();
    await waitFor(() => fx.adapter.gates.length === 1, "first stream running");
    let getEntered = false;
    fx.ctx.workspaceBinding.get = async (id: string) => { getEntered = true; await getGate; return originalGet(id); };
    await updateJobRecord(workspace.root, secondJob.jobId, secondJob.revision, { status: "scheduled", notBefore: new Date().toISOString() });
    fx.scheduler.poke();
    await waitFor(() => getEntered, "second job parked in binding.get");
    const disposal = fx.scheduler.dispose();
    releaseGet();
    // The abort cannot un-park a raw async stream: release the running job's
    // gate so its task settles and disposal can drain.
    fx.adapter.releaseAll();
    await disposal;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal((await readJobRecord(workspace.root, secondJob.jobId))?.status, "scheduled", "the parked job never starts after dispose");
    assert.deepEqual(fx.scheduler.status(), { maxConcurrent: 2, inFlight: 0 }, "dispose releases every reservation");
  } finally {
    releaseGet(); fx.ctx.workspaceBinding.get = originalGet; await fx.dispose();
  }
});
