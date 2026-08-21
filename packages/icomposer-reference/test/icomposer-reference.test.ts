import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink, readdir, stat as fstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { IcomposerReferenceService } from "../src/service.ts";
import { scanSdk, scanUtils, extractMethods } from "../src/scan.ts";

const validEnv = "prod_insuremo_env_001_test";

type FakeGet = (id: string) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;

async function harness(workspacePath: string, binding: unknown | null, getImpl?: FakeGet) {
  const ctx = new Context();
  const expectedId = (binding as { workspaceId?: string } | null)?.workspaceId ?? "ws1";
  ctx.provide("workspaceBinding", {
    get: getImpl ?? (async (id: string) => {
      if (id === expectedId || id === "ws1") {
        if (binding === null) return { ok: true, value: { workspaceId: id, canonicalPath: workspacePath, binding: null } };
        return { ok: true, value: { workspaceId: id, canonicalPath: workspacePath, binding } };
      }
      return { ok: false, error: { code: "workspace-not-found", message: "not found" } };
    }),
  } as never);
  const fiber = await ctx.plugin(IcomposerReferenceService);
  await fiber.await();
  return { ctx, ref: ctx.get("icomposerReference") as IcomposerReferenceService, fiber };
}

const bindingFor = (workspaceId: string, canonicalPath: string) => ({
  workspaceId, canonicalPath, environmentId: validEnv, tenantCode: "t1", authProfile: "p1",
  writeMode: "read-only" as const, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

const swaggerOf = (client: string, ops: Array<[string, string, Record<string, unknown>]>) => {
  const paths: Record<string, unknown> = {};
  for (const [method, path, op] of ops) {
    paths[path] = { [method]: op };
  }
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "API", version: "1.0" },
    servers: [{ url: "http://x" }],
    paths,
  });
};

async function writeSdk(dir: string, client: string, content: string) {
  const p = join(dir, "sdk", client);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, `${client}_swagger.json`), content);
}

async function writeUtil(dir: string, name: string, headings: string[]) {
  const lines = [`# ${name}`, ""];
  for (const h of headings) lines.push(`## ${h}`, "");
  await mkdir(join(dir, "ref_doc"), { recursive: true });
  await writeFile(join(dir, "ref_doc", `${name}.md`), lines.join("\n"));
}

async function buildFixture(root: string) {
  await writeSdk(root, "AlphaSdkClient", swaggerOf("AlphaSdkClient", [
    ["get", "/alpha/ping", { operationId: "alphaPing", summary: "Ping alpha", tags: ["A"] }],
    ["post", "/alpha/submit", { summary: "no operationId" }],
  ]));
  await writeSdk(root, "BetaSdkClient", swaggerOf("BetaSdkClient", [
    ["get", "/beta/items", { operationId: "betaList", summary: "List beta items", tags: ["B"] }],
  ]));
  await writeSdk(root, "BadSdkClient", "{ not json ");
  // long summary + tag -> clipped to <=200 with ellipsis
  await writeSdk(root, "LongSdkClient", swaggerOf("LongSdkClient", [
    ["get", "/long", { operationId: "longOp", summary: "x".repeat(300), tags: ["t".repeat(250)] }],
  ]));

  await writeUtil(root, "IComposerJsonUtils", ["toJSON", "fromJSON", "fromJSON"]);
  await writeUtil(root, "IComposerDb", ["pagedQuery"]);
  await writeUtil(root, "IComposerEmpty", []);
  // oversized utility -> invalid
  await mkdir(join(root, "ref_doc"), { recursive: true });
  await writeFile(join(root, "ref_doc", "IComposerHuge.md"), "# IComposerHuge\n" + "x".repeat(1024 * 1024 + 1));
}

test("sdk index: client list, per-client counts, invalid JSON does not fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "ref-fixture-"));
  await buildFixture(root);
  const binding = bindingFor("ws1", root);
  const { ref } = await harness(root, binding);
  const res = await ref.listSdkClients({ workspaceId: "ws1" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.counts.clients, 4);
    assert.equal(res.value.counts.operations, 3); // alphaPing + betaList + longOp (no-opId skipped)
    const alpha = res.value.clients.find(c => c.client === "AlphaSdkClient")!;
    const bad = res.value.clients.find(c => c.client === "BadSdkClient")!;
    assert.equal(alpha.operationCount, 1);
    assert.equal(alpha.status, "ok");
    assert.equal(bad.status, "invalid");
    assert.equal(bad.operationCount, 0);
  }
  await rm(root, { recursive: true, force: true });
});

test("sdk query: keyword, client filter, limit/truncated, no-opId skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "ref-q-"));
  await buildFixture(root);
  const binding = bindingFor("ws1", root);
  const { ref } = await harness(root, binding);
  const all = await ref.querySdkOperations({ workspaceId: "ws1" });
  assert.equal(all.ok && all.value.operations.length, 3);
  assert.equal(all.ok && all.value.truncated, false);
  const kw = await ref.querySdkOperations({ workspaceId: "ws1", keyword: "beta" });
  assert.equal(kw.ok && kw.value.operations.length, 1);
  if (kw.ok) assert.equal(kw.value.operations[0].operationId, "betaList");
  const byClient = await ref.querySdkOperations({ workspaceId: "ws1", client: "AlphaSdkClient" });
  assert.equal(byClient.ok && byClient.value.operations.every(o => o.client === "AlphaSdkClient"), true);
  assert.equal(byClient.ok && byClient.value.operations.length, 1); // skipped one
  const limited = await ref.querySdkOperations({ workspaceId: "ws1", limit: 1 });
  assert.equal(limited.ok && limited.value.truncated, true);
  assert.equal(limited.ok && limited.value.operations.length, 1);
  const badLimit = await ref.querySdkOperations({ workspaceId: "ws1", limit: 201 });
  assert.equal(badLimit.ok, false);
  if (!badLimit.ok) assert.equal(badLimit.error.code, "invalid-limit");
  await rm(root, { recursive: true, force: true });
});

test("util index: list + query (filter/keyword/limit), no-method util ok, oversized invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "ref-u-"));
  await buildFixture(root);
  const binding = bindingFor("ws1", root);
  const { ref } = await harness(root, binding);
  const list = await ref.listUtilities({ workspaceId: "ws1" });
  assert.equal(list.ok, true);
  if (list.ok) {
    assert.equal(list.value.counts.utils, 4);
    assert.equal(list.value.counts.methods, 3); // toJSON fromJSON (Json) + pagedQuery (Db); Empty 0, Huge invalid 0
    const empty = list.value.utils.find(u => u.util === "IComposerEmpty")!;
    const huge = list.value.utils.find(u => u.util === "IComposerHuge")!;
    assert.equal(empty.methodCount, 0);
    assert.equal(empty.status, "ok");
    assert.equal(huge.status, "invalid");
  }
  const q = await ref.queryUtilityMethods({ workspaceId: "ws1", util: "IComposerJsonUtils" });
  assert.equal(q.ok && q.value.methods.length, 2); // deduped
  const kw = await ref.queryUtilityMethods({ workspaceId: "ws1", keyword: "paged" });
  assert.equal(kw.ok && kw.value.methods.length, 1);
  const limited = await ref.queryUtilityMethods({ workspaceId: "ws1", limit: 1 });
  assert.equal(limited.ok && limited.value.truncated, true);
  await rm(root, { recursive: true, force: true });
});

test("extractMethods: dedupe, skip Sample and util-name H1", () => {
  const text = "# IComposerFoo\n## a\n### Sample\n## b\n## a\n## Sample\n# IComposerOther\n## c\n";
  assert.deepEqual(extractMethods(text, "IComposerFoo"), ["a", "b", "c"]);
});

test("gates: unbound, not-found, storage-error fallback, dispose, cancelled signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ref-g-"));
  await buildFixture(root);
  const unboundHarness = await harness(root, null);
  const unbound = await unboundHarness.ref.listSdkClients({ workspaceId: "ws1" });
  assert.equal(unbound.ok, false);
  if (!unbound.ok) assert.equal(unbound.error.code, "workspace-not-bound");
  const binding = bindingFor("ws1", root);
  const h2 = await harness(root, binding, async (id: string) => {
    if (id === "wtf") return { ok: false, error: { code: "weird-internal-code", message: "opaque" } };
    return { ok: false, error: { code: "workspace-not-found", message: "nope" } };
  });
  const bad = await h2.ref.listSdkClients({ workspaceId: "wtf" });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.error.code, "storage-error");
    assert.equal(bad.error.message.includes("opaque"), false);
  }
  const missing = await h2.ref.listSdkClients({ workspaceId: "ghost" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "workspace-not-found");
  // dispose
  const { ctx, ref, fiber } = await harness(root, binding);
  const captured = ctx.get("icomposerReference") as IcomposerReferenceService;
  const aborted = await captured.listSdkClients({ workspaceId: "ws1" }, AbortSignal.abort());
  assert.equal(aborted.ok, false);
  if (!aborted.ok) assert.equal(aborted.error.code, "cancelled");
  await fiber.dispose();
  const after = await captured.listSdkClients({ workspaceId: "ws1" });
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.error.code, "service-disposed");
  void ref;
  await rm(root, { recursive: true, force: true });
});

test("containment: symlinked client dir is skipped-escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "ref-c-"));
  const outside = await mkdtemp(join(tmpdir(), "outside-"));
  await mkdir(join(outside, "EvilSdkClient"), { recursive: true });
  await writeFile(join(outside, "EvilSdkClient", "EvilSdkClient_swagger.json"), swaggerOf("EvilSdkClient", [["get", "/x", { operationId: "x" }]]));
  await mkdir(join(root, "sdk"), { recursive: true });
  await symlink(join(outside, "EvilSdkClient"), join(root, "sdk", "EvilSdkClient"));
  const { clients } = await scanSdk(root);
  const evil = clients.find(c => c.client === "EvilSdkClient");
  assert.equal(evil?.status, "skipped-escape");
  assert.equal(evil?.operationCount, 0);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("real project smoke - strictly read-only", async () => {
  const projectRoot = "/Users/junjie.zhang/skills/ssapocpa";
  async function snapshot(dir: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    async function walk(p: string) {
      const entries = await readdir(p, { withFileTypes: true });
      for (const e of entries) {
        const full = join(p, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const st = await fstat(full);
          map.set(full, st.mtimeMs);
        }
      }
    }
    await walk(dir);
    return map;
  }
  const before = await snapshot(projectRoot);
  const binding = bindingFor("ws-real", projectRoot);
  const { ref } = await harness(projectRoot, binding);
  const sdk = await ref.listSdkClients({ workspaceId: "ws-real" });
  assert.equal(sdk.ok, true);
  if (sdk.ok) {
    assert.equal(sdk.value.counts.clients, 45);
    assert.equal(sdk.value.counts.operations, 1389); // 1393 total - 4 no-operationId
    const appchat = sdk.value.clients.find(c => c.client === "AppchatSdkClient")!;
    assert.equal(appchat.operationCount, 12);
    // summary/tag bound across the whole real catalog
    const allOps = await ref.querySdkOperations({ workspaceId: "ws-real" });
    assert.equal(allOps.ok, true);
    if (allOps.ok) {
      assert.ok(allOps.value.operations.every(o => (o.summary ?? "").length <= 200));
      assert.ok(allOps.value.operations.every(o => (o.tag ?? "").length <= 200));
    }
    // single client query spot check against raw swagger
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(join(projectRoot, "sdk", "AppchatSdkClient", "AppchatSdkClient_swagger.json"), "utf8"));
    const q = await ref.querySdkOperations({ workspaceId: "ws-real", client: "AppchatSdkClient" });
    assert.equal(q.ok && q.value.operations.length, 12);
    const firstReal = q.ok ? q.value.operations[0] : null;
    const rawOp = raw.paths[firstReal!.path][firstReal!.method];
    assert.equal(firstReal!.operationId, rawOp.operationId);
    if (rawOp.summary) assert.equal(firstReal!.summary, rawOp.summary);
    if (Array.isArray(rawOp.tags) && rawOp.tags.length) assert.equal(firstReal!.tag, rawOp.tags[0]);
  }
  const utils = await ref.listUtilities({ workspaceId: "ws-real" });
  assert.equal(utils.ok, true);
  if (utils.ok) {
    assert.equal(utils.value.counts.utils, 35);
    assert.equal(utils.value.counts.methods, 313);
    const jsonUtils = utils.value.utils.find(u => u.util === "IComposerJsonUtils")!;
    assert.equal(jsonUtils.methodCount, 19);
  }
  const after = await snapshot(projectRoot);
  assert.equal(before.size, after.size);
  for (const [k, v] of before) assert.equal(after.get(k), v);
});


test("summary/tag are clipped to <=200 chars with ellipsis", async () => {
  const root = await mkdtemp(join(tmpdir(), "ref-a4-"));
  await buildFixture(root);
  const binding = bindingFor("ws1", root);
  const { ref } = await harness(root, binding);
  const q = await ref.querySdkOperations({ workspaceId: "ws1", keyword: "longOp" });
  assert.equal(q.ok, true);
  if (q.ok) {
    const op = q.value.operations[0];
    assert.equal(op.summary!.length, 200);
    assert.equal(op.summary!.endsWith("…"), true);
    assert.equal(op.summary!.endsWith("x"), false);
    assert.ok(op.tag!.length <= 200);
    assert.equal(op.tag!.length, 200);
    assert.equal(op.tag!.endsWith("…"), true);
  }
  await rm(root, { recursive: true, force: true });
});
