import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { buildGraph } from "../src/graph.ts";
import {
  computeGraphDigest, createJobRecord, listJobs, prepareExplain, readBatchRecord, readJobRecord, recoverOrphanJobs,
  recoverPendingConfirms, setExplainWriteFailpoint, updateJobRecord, writeJobRecordUnderLock, restoreBatchPlan, updateBatchPlan,
} from "../src/explain-artifacts.ts";
import { boundedCandidates, resolveTaskTargets, runPrepare, runPrepareTask } from "../src/explain-native.ts";
import { ExplainRoutesService } from "../src/explain-routes.ts";
import { enumerateSources, duplicateNames, listSourceGroups } from "../../icomposer-catalog/src/enumerate.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

const TOTAL = 25;

function req(method: string, url: string, body?: unknown): any { const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)); return { method, url, headers: { "x-workbench-action": "1", "content-type": "application/json", "content-length": String(bytes.byteLength) }, on: () => undefined, async *[Symbol.asyncIterator]() { if (bytes.byteLength > 0) yield bytes; } }; }
function response(): any { const value: any = { status: 0, body: "", headers: {}, destroyed: false, writableEnded: false, writeHead(status: number, headers: Record<string, string>) { value.status = status; value.headers = headers; }, end(body?: string) { value.body = body ?? ""; value.writableEnded = true; } }; return value; }
function decode(value: any): any { return JSON.parse(value.body); }

/** 25 APIs in two groups, so `group`/`all` resolution is a real resolution. */
async function fixture(prefix = "task111-task-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "ref_doc"), { recursive: true });
  await writeFile(join(root, "ref_doc", "guide.md"), "reference material\n");
  const apis: Array<{ name: string; group: string }> = [];
  for (let index = 0; index < TOTAL; index += 1) apis.push({ name: `Api${String(index).padStart(2, "0")}`, group: index < 10 ? "Payments" : "Billing" });
  const entries: Array<{ name: string; type: "api"; sourcePath: string }> = [];
  for (const api of apis) {
    const dir = join(root, "src", "dev", "acme", api.group, "api", api.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${api.name}.groovy`), `class ${api.name} { def run() { 1 } }\n`);
    entries.push({ name: api.name, type: "api", sourcePath: join(dir, `${api.name}.groovy`) });
  }
  const raw = await buildGraph(root, entries);
  const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64), engineVersion: ICI_ENGINE_VERSION } };
  const graphDir = join(root, ".metadata/icomposer/ici/graph/current");
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const starts = new Map(entries.map(entry => [entry.name, graph.nodes.get(`api:${entry.name}`)]));
  const groupOf = (name: string): string => apis.find(api => api.name === name)!.group;
  const listings = new Map<string, any>([["ws", { entries: entries.map(entry => ({ name: entry.name, type: "api", tenant: "acme", group: groupOf(entry.name), sourcePath: `src/dev/acme/${groupOf(entry.name)}/api/${entry.name}/${entry.name}.groovy` })), duplicateNames: [] }]]);
  const deps: any = {
    disposed: () => false,
    loadBase: async (_workspaceId: string, query: string) => { const start = starts.get(query); return start ? { ok: true, value: { graph, canonicalPath: root, start } } : { ok: false, error: { code: "no-match", message: `no api matched: ${query}` } }; },
    current: async () => ({ ok: true, value: { canonicalPath: root, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph), engineVersion: ICI_ENGINE_VERSION } }),
    refs: async () => [],
    catalog: async (workspaceId: string) => listings.has(workspaceId) ? { ok: true, value: listings.get(workspaceId) } : { ok: false, error: { code: "workspace-not-found", message: "workspace does not exist" } },
  };
  return { root, graph, deps, listings, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function batchFile(root: string, batchId: string): Promise<any> { return JSON.parse(await readFile(join(root, ".metadata/icomposer/ici/explain/batches", `${batchId}.json`), "utf8")); }

/** Route fixture over a real task, for confirm/retry/fail-closed probes. */
async function routesFor(fx: Awaited<ReturnType<typeof fixture>>) {
  const routes: any[] = [];
  const ctx: any = new Context();
  ctx.provide("webServer", { register(route: any) { routes.push(route); return () => undefined; } });
  ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "ws", canonicalPath: fx.root }] }) });
  ctx.provide("llm", { listProviders: () => [{ id: "mvp" }], listModels: async () => [{ id: "mvp-model", name: "MVP model" }], resolveModelInfo: async () => ({ provider: "mvp", id: "mvp-model" }) });
  ctx.provide("iciEngine", { explainPrepare: (input: any, signal?: AbortSignal) => runPrepare(fx.deps, input, signal) });
  ctx.provide("iciExplainScheduler", { poke: () => undefined, cancelJob: async () => true, taskInFlightCount: () => 0 });
  ctx.provide("iciExplainConfig", { maxConcurrent: 4, setMaxConcurrent: async () => ({ ok: true, value: { maxConcurrent: 4 } }) });
  const fiber: any = await ctx.plugin(ExplainRoutesService); await fiber.await();
  return { routes, dispose: async () => { await fiber.dispose(); } };
}

test("TASK-111 one task covers every API of the workspace, per group, and one API through the same entry point", async () => {
  const fx = await fixture(); try {
    const all = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "all" } });
    assert.equal(all.ok, true);
    if (!all.ok) return;
    assert.equal(all.value.jobs.length, TOTAL);
    assert.equal(all.value.requestedCount, TOTAL);
    assert.equal(all.value.duplicates, 0);
    assert.deepEqual(all.value.selector, { kind: "all", label: "all" });
    const record = (await batchFile(fx.root, all.value.batchId)) as any;
    assert.equal(record.jobIds.length, TOTAL);
    assert.equal(record.requestedCount, TOTAL);
    assert.equal(record.maxConcurrent, 4);
    assert.deepEqual(record.selector, { kind: "all", label: "all" });
    assert.ok(record.jobIds.every((jobId: string) => jobId.length === 16));
    assert.ok((await listJobs(fx.root)).every(job => job.batchId === all.value.batchId));

    const group = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "group", group: "Billing" } });
    assert.equal(group.ok, false, "an API that already has an active job is an explicit conflict, never adopted");
    assert.equal(!group.ok && group.error.code, "job-active");
  } finally { await fx.cleanup(); }
});

test("TASK-111 group resolution is exact and refuses unknown or cross-tenant groups", async () => {
  const fx = await fixture(); try {
    const known = await resolveTaskTargets(fx.deps, "ws", { kind: "group", group: "payments" });
    assert.equal(known.ok, true);
    assert.equal(known.ok && known.names.length, 10);
    assert.deepEqual(known.ok ? known.names : [], [...(known.ok ? known.names : [])].sort());

    const missing = await resolveTaskTargets(fx.deps, "ws", { kind: "group", group: "Pay" });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.code, "group-not-found");
    assert.ok(!missing.ok && missing.message.length < 200, "diagnostics stay bounded");

    fx.listings.set("ws", { ...fx.listings.get("ws"), entries: [...fx.listings.get("ws").entries, { name: "Other", type: "api", tenant: "other", group: "Payments", sourcePath: "src/dev/other/Payments/api/Other/Other.groovy" }] });
    const crossTenant = await resolveTaskTargets(fx.deps, "ws", { kind: "group", group: "Payments" });
    assert.equal(crossTenant.ok, false);
    assert.equal(!crossTenant.ok && crossTenant.code, "ambiguous-target");
  } finally { await fx.cleanup(); }
});

test("TASK-111 same-named APIs at different paths are refused, never merged or picked", async () => {
  const fx = await fixture(); try {
    const entries = fx.listings.get("ws").entries;
    const collision = { name: entries[0].name, type: "api", tenant: "acme", group: "Billing", sourcePath: `src/dev/acme/Billing/api/${entries[0].name}/${entries[0].name}.groovy` };
    fx.listings.set("ws", { entries: [...entries, collision], duplicateNames: [entries[0].name] });

    const byApi = await resolveTaskTargets(fx.deps, "ws", { kind: "api", query: entries[0].name });
    assert.equal(byApi.ok, false);
    assert.equal(!byApi.ok && byApi.code, "ambiguous-target");
    assert.match(!byApi.ok ? byApi.message : "", /acme\/Billing/);
    assert.equal((await resolveTaskTargets(fx.deps, "ws", { kind: "queries", queries: [entries[0].name] })).ok, false);
    const byAll = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "all" } });
    assert.equal(byAll.ok, false);
    assert.equal(!byAll.ok && byAll.error.code, "ambiguous-target");
    assert.equal((await listJobs(fx.root)).length, 0, "a refused resolution writes nothing");
  } finally { await fx.cleanup(); }
});

test("TASK-111 recovery repairs another process's records and never its own", async () => {
  const fx = await fixture(); try {
    const batch = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "api", query: "Api00" } });
    assert.equal(batch.ok, true);
    if (!batch.ok) return;
    const jobId = batch.value.jobs[0]!.jobId;
    const live = await readJobRecord(fx.root, jobId);
    assert.ok(live?.host !== undefined, "every created record is stamped with its creating Host process");
    await rm(join(fx.root, ".metadata/icomposer/ici/explain/batches", `${batch.value.batchId}.json`), { force: true });
    assert.equal(await recoverOrphanJobs(fx.root), 0, "recovery never repairs its own process's records");
    await writeJobRecordUnderLock(fx.root, { ...live!, host: "host-previous-process" });
    assert.equal(await recoverOrphanJobs(fx.root), 1);
    const recovered = await readJobRecord(fx.root, jobId);
    assert.equal(recovered?.status, "cancelled");
    assert.equal(recovered?.error, "interrupted");

    const healthy = await createJobRecord(fx.root, { jobId: "aaaaaaaaaaaaaaaa", workspaceId: "ws", apiName: "Api01", apiId: "api:Api01", prepareArtifactPath: ".metadata/icomposer/ici/explain/Api01/prepare.json", contextHash: "c".repeat(64), prepareId: "a".repeat(32), sourceFingerprint: "a".repeat(64), graphDigest: "b".repeat(64), provider: null, model: null, docs: [], folderPath: "", host: "host-previous-process" });
    await updateJobRecord(fx.root, healthy.jobId, healthy.revision, { status: "scheduled", notBefore: new Date().toISOString() });
    assert.equal(await recoverOrphanJobs(fx.root), 0);
    assert.equal((await readJobRecord(fx.root, healthy.jobId))?.status, "scheduled");
  } finally { await fx.cleanup(); }
});

test("TASK-111 the confirmed plan lives on the task record and drives a user-clicked retry", async () => {
  const fx = await fixture("task111-plan-"); const routes = await routesFor(fx);
  try {
    const task = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "group", group: "Payments" }, maxConcurrent: 2 });
    assert.equal(task.ok, true);
    if (!task.ok) return;
    const batchId = task.value.batchId;
    const notBefore = new Date(Date.now() + 60_000).toISOString();
    const confirm = response();
    await routes.routes[0].handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/confirm`, { provider: "mvp", model: "mvp-model", docs: [], referenceTarget: { path: "ref_doc", kind: "directory" }, notBefore, consent: true }), confirm);
    assert.equal(decode(confirm).ok, true, JSON.stringify(decode(confirm)));
    const planned = await readBatchRecord(fx.root, batchId);
    assert.equal(planned?.plan?.provider, "mvp");
    assert.equal(planned?.plan?.model, "mvp-model");
    assert.deepEqual(planned?.plan?.referenceTarget, { path: "ref_doc", kind: "directory" });
    assert.equal(planned?.plan?.notBefore, notBefore);
    assert.equal(planned?.confirmPending, undefined, "the commit point releases the gate");
    const members = await Promise.all(planned!.jobIds.map(jobId => readJobRecord(fx.root, jobId)));
    assert.ok(members.every(job => job?.status === "scheduled" && job.provider === "mvp" && job.model === "mvp-model" && job.notBefore === notBefore));

    // Wipe the plan off every member, so the retry cannot be "guessed" from a job.
    for (const job of members) await updateJobRecord(fx.root, job!.jobId, job!.revision, { provider: null, model: null, status: "failed", error: "model-failed" });
    const retry = response();
    await routes.routes[0].handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/retry`, {}), retry);
    assert.equal(decode(retry).ok, true, JSON.stringify(decode(retry)));
    const after = await readBatchRecord(fx.root, batchId);
    const replacements = await Promise.all(after!.jobIds.map(jobId => readJobRecord(fx.root, jobId)));
    assert.equal(replacements.length, planned!.jobIds.length);
    assert.ok(replacements.every(job => job?.status === "scheduled" && job.provider === "mvp" && job.model === "mvp-model" && job.notBefore === notBefore));

    // Legacy: without a plan the replacement waits for confirmation again.
    await restoreBatchPlan(fx.root, batchId, undefined);
    for (const job of replacements) await updateJobRecord(fx.root, job!.jobId, job!.revision, { provider: null, model: null, status: "failed", error: "model-failed" });
    const legacy = response();
    await routes.routes[0].handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/retry`, {}), legacy);
    assert.equal(decode(legacy).ok, true);
    const legacyAfter = await readBatchRecord(fx.root, batchId);
    assert.ok((await Promise.all(legacyAfter!.jobIds.map(jobId => readJobRecord(fx.root, jobId)))).every(job => job?.status === "awaiting-input"));
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-111 a rejected confirmation never leaves a half-confirmed plan", async () => {
  const fx = await fixture("task111-planfail-"); const routes = await routesFor(fx);
  try {
    const task = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "api", query: "Api00" } });
    assert.equal(task.ok, true);
    if (!task.ok) return;
    const batchId = task.value.batchId;
    const refused = response();
    await routes.routes[0].handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/confirm`, { provider: "nope", model: "m", docs: [], referenceTarget: { path: "", kind: "none" }, notBefore: new Date().toISOString(), consent: true }), refused);
    assert.equal(decode(refused).ok, false);
    const record = await readBatchRecord(fx.root, batchId);
    assert.equal(record?.plan, undefined);
    assert.equal(record?.confirmPending, undefined);
    assert.equal((await readJobRecord(fx.root, record!.jobIds[0]!))?.status, "awaiting-input");

    await updateBatchPlan(fx.root, batchId, { provider: "mvp", model: "mvp-model", referenceTarget: { path: "", kind: "none" }, notBefore: new Date().toISOString(), confirmedAt: new Date().toISOString() });
    const badTarget = response();
    await routes.routes[0].handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/confirm`, { provider: "mvp", model: "mvp-model", docs: [], referenceTarget: { path: "missing-dir", kind: "directory" }, notBefore: new Date().toISOString(), consent: true }), badTarget);
    assert.equal(decode(badTarget).ok, false);
    assert.equal((await readBatchRecord(fx.root, batchId))?.plan?.model, "mvp-model", "the previous plan is preserved");
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-111 a confirmation whose rollback cannot be published fails closed", async () => {
  const fx = await fixture("task111-failclosed-"); const routes = await routesFor(fx);
  try {
    const task = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "queries", queries: ["Api00", "Api01", "Api02"] } });
    assert.equal(task.ok, true);
    if (!task.ok) return;
    const batchId = task.value.batchId;
    let jobWrites = 0; let batchWrites = 0;
    setExplainWriteFailpoint(path => {
      if (path.includes("/jobs/") && ++jobWrites === 3) throw new Error("member-write-failed");
      // The FIRST batch write arms the gate; every later publication (plan commit and
      // rollback restore) fails, so the rollback cannot be published.
      if (path.includes("/batches/") && ++batchWrites >= 2) throw new Error("batch-write-failed");
    });
    const refused = response();
    await routes.routes[0].handler(req("POST", `/api/icomposer-workbench/ici/explain/batches/${batchId}/confirm`, { provider: "mvp", model: "mvp-model", docs: [], referenceTarget: { path: "", kind: "none" }, notBefore: new Date().toISOString(), consent: true }), refused);
    assert.equal(decode(refused).ok, false);
    setExplainWriteFailpoint(undefined);
    const armed = await batchFile(fx.root, batchId);
    assert.equal(armed.confirmPending, true, "fail closed: the gate stays armed");
    assert.equal(typeof armed.confirmOwner, "string");
    assert.equal(armed.plan, undefined);
    const members = await Promise.all(armed.jobIds.map((jobId: string) => readJobRecord(fx.root, jobId)));
    assert.ok(members.every(job => job?.status === "awaiting-input"), "a rolled-back member is never left scheduled");

    assert.equal(await recoverPendingConfirms(fx.root, "host-other-process"), 1);
    const healed = await batchFile(fx.root, batchId);
    assert.equal(healed.confirmPending, undefined);
    assert.equal(healed.confirmOwner, undefined);
  } finally { await routes.dispose(); await fx.cleanup(); }
});

test("TASK-111 path-aware enumeration is uncapped and reports same-name collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "task111-enumerate-"));
  try {
    for (const group of ["G1", "G2"]) for (let index = 0; index < 2501; index += 1) {
      const name = `Api${group}${String(index).padStart(4, "0")}`;
      const dir = join(root, "src", "dev", "acme", group, "api", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name}.groovy`), `class ${name} {}\n`);
    }
    const found: string[] = [];
    for await (const item of enumerateSources(root)) found.push(item.relativePath);
    assert.equal(found.length, 5002, "one more than the catalog's 5000 display bound, and nothing is lost");
    assert.equal(new Set(found).size, 5002);
    assert.deepEqual(await listSourceGroups(root), [{ tenant: "acme", group: "G1" }, { tenant: "acme", group: "G2" }]);
    const first = found[0]!;
    const name = first.split("/")[5]!;
    const twin = { name, type: "api" as const, tenant: "acme", group: "G2", relativePath: first.replace("/G1/", "/G2/"), absolutePath: "" };
    assert.deepEqual(duplicateNames([{ name, type: "api" as const, tenant: "acme", group: "G1", relativePath: first, absolutePath: "" }, twin]), [name]);
    assert.equal(boundedCandidates(["a", "b", "c"], 2), "a, b … (+1 more)");
  } finally { await rm(root, { recursive: true, force: true }); }
});
