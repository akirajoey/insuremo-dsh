import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink, readdir, stat as fstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { IcomposerCatalogService } from "../src/service.ts";
import { scanWorkspace } from "../src/scan.ts";

const validEnv = "prod_insuremo_env_001_test";

type FakeGet = (id: string) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;

async function catalogHarness(workspacePath: string, binding: unknown | null, getImpl?: FakeGet) {
  const ctx = new Context();
  const expectedId = (binding as { workspaceId?: string } | null)?.workspaceId ?? "ws1";
  ctx.provide("workspaceBinding", {
    get: getImpl ?? (async (id: string) => {
      if (id === expectedId || id === "ws1" || id === "ws-real") {
        if (binding === null) return { ok: true, value: { workspaceId: id, canonicalPath: workspacePath, binding: null } };
        return { ok: true, value: { workspaceId: id, canonicalPath: workspacePath, binding } };
      }
      return { ok: false, error: { code: "workspace-not-found", message: "not found" } };
    }),
  } as never);
  const fiber = await ctx.plugin(IcomposerCatalogService);
  await fiber.await();
  return { ctx, catalog: ctx.get("icomposerCatalog") as IcomposerCatalogService, fiber };
}

const bindingFor = (workspaceId: string, canonicalPath: string) => ({
  workspaceId, canonicalPath, environmentId: validEnv, tenantCode: "t1", authProfile: "p1",
  writeMode: "read-only" as const, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

async function writeMeta(dir: string, type: string, name: string, meta: Record<string, unknown>) {
  await mkdir(join(dir, ".metadata", type), { recursive: true });
  await writeFile(join(dir, ".metadata", type, `${name}.metadata.json`), JSON.stringify({ [type]: meta }));
}

async function writeBatch(dir: string, brand: string, group: string, name: string, meta: Record<string, unknown>) {
  const batchDir = join(dir, ".metadata", "batch", brand, group, name);
  await mkdir(batchDir, { recursive: true });
  await writeFile(join(batchDir, "batch.metadata.json"), JSON.stringify({ batchJob: meta }));
  return batchDir;
}

async function writeBatchStep(batchDir: string, stepName: string, stepMeta: Record<string, unknown>, itemName = "someitem") {
  const stepDir = join(batchDir, stepName);
  await mkdir(stepDir, { recursive: true });
  await writeFile(join(stepDir, "step.metadata.json"), JSON.stringify({ batchStep: stepMeta }));
  await writeFile(join(stepDir, `${itemName}.metadata.json`), JSON.stringify({ batchStepItem: { Name: itemName } }));
}

async function writeGroovy(dir: string, tenant: string, group: string, type: string, name: string, content = `// ${name}\n`) {
  const p = join(dir, "src", "dev", tenant, group, type, name);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, `${name}.groovy`), content);
}

async function writeBatchGroovy(dir: string, tenant: string, group: string, name: string, step = "766_step", content = `// ${name}\n`) {
  const p = join(dir, "src", "dev", tenant, group, "batch", name, step);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, `${step.replace(/^\d+_/, "")}.groovy`), content);
}

test("join statuses, symlink escape, damaged JSON, truncated and containment", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-"));
  const groovyContent = "clean content";
  const md5 = createHash("md5").update(groovyContent).digest("hex");
  await writeMeta(root, "api", "CleanAPI", { Name: "CleanAPI", Md5Value: md5, AppName: "test" });
  await writeGroovy(root, "TenantA", "GroupA", "api", "CleanAPI", groovyContent);
  await writeMeta(root, "api", "ModifiedAPI", { Name: "ModifiedAPI", Md5Value: "deadbeefdeadbeefdeadbeefdeadbeef", AppName: "test" });
  await writeGroovy(root, "TenantA", "GroupA", "api", "ModifiedAPI", "different");
  await writeMeta(root, "api", "NoMd5API", { Name: "NoMd5API", AppName: "test" });
  await writeGroovy(root, "TenantA", "GroupA", "api", "NoMd5API", "content");
  await writeMeta(root, "function", "OrphanFunc", { Name: "OrphanFunc", AppName: "test" });
  await writeBatch(root, "Platform", "Agent", "BatchOnly", { BatchName: "BatchOnly", Id: 7, JobName: "job7", RecordUsage: "N", _IComposerSourceEnvironment: "prod" });
  await writeGroovy(root, "TenantA", "GroupA", "function", "NoMetaFunc", "orphan");
  await mkdir(join(root, ".metadata", "api"), { recursive: true });
  await writeFile(join(root, ".metadata", "api", "Bad.metadata.json"), "{ not json");
  const outside = await mkdtemp(join(tmpdir(), "outside-"));
  await writeFile(join(outside, "evil.metadata.json"), JSON.stringify({ api: { Name: "Evil", Md5Value: md5 } }));
  await symlink(join(outside, "evil.metadata.json"), join(root, ".metadata", "api", "Evil.metadata.json"));
  const { entries, truncated, sections } = await scanWorkspace(root);
  const byName = new Map(entries.map(e => [e.name, e]));
  assert.equal(byName.get("CleanAPI")?.joinStatus, "clean");
  assert.equal(byName.get("ModifiedAPI")?.joinStatus, "local-modified");
  assert.equal(byName.get("NoMd5API")?.joinStatus, "no-server-md5");
  assert.equal(byName.get("BatchOnly")?.joinStatus, "source-missing");
  assert.equal(byName.get("NoMetaFunc")?.joinStatus, "metadata-missing");
  assert.equal(byName.has("Bad"), false);
  assert.equal(byName.has("Evil"), false);
  assert.equal(truncated, false);
  assert.equal(sections.api.skipped! >= 2, true);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("nested batch discovery: step/stepitem ignored, batch projected with batchJob fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-batch-"));
  const bd = await writeBatch(root, "Platform", "Agent", "MyBatch", {
    BatchName: "MyBatch", Id: 10, GroupId: 20, ModuleId: 30, Status: 1, Version: 2,
    JobName: "myJob", RecordUsage: "N", _IComposerSourceEnvironment: "prod_insuremo_env_001",
  });
  await writeBatchStep(bd, "766_main", { Id: 1, StepName: "main", Seq: 1, Status: 1 });
  // batch source present at src/dev/Platform/Agent/batch/MyBatch/766_main/main.groovy
  await writeBatchGroovy(root, "Platform", "Agent", "MyBatch", "766_main", "step body");
  const { entries, sections } = await scanWorkspace(root);
  assert.equal(sections.batch.status, "ok");
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.type, "batch");
  assert.equal(e.name, "MyBatch");
  assert.equal(e.metadata.id, 10);
  assert.equal(e.metadata.jobName, "myJob");
  assert.equal(e.metadata.recordUsage, "N");
  assert.equal(e.metadata.sourceEnvironment, "prod_insuremo_env_001");
  assert.equal(e.tenant, "Platform");
  assert.equal(e.group, "Agent");
  assert.ok(e.sourcePath && e.sourcePath.endsWith("main.groovy"));
  assert.equal(e.joinStatus, "no-server-md5");
  await rm(root, { recursive: true, force: true });
});

test("truncated at 5000 and unbound gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-trunc-"));
  for (let i = 0; i < 5002; i++) {
    await writeMeta(root, "api", `API${i}`, { Name: `API${i}`, AppName: "test" });
  }
  const { entries, truncated } = await scanWorkspace(root);
  assert.equal(truncated, true);
  assert.equal(entries.length, 5000);
  await rm(root, { recursive: true, force: true });
  const wsRoot = await mkdtemp(join(tmpdir(), "catalog-unbound-"));
  const { catalog } = await catalogHarness(wsRoot, null);
  const res = await catalog.listAssets({ workspaceId: "ws1" });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "workspace-not-bound");
  await rm(wsRoot, { recursive: true, force: true });
});

test("catalog list via service respects type filter, containment and dispose", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-svc-"));
  await writeMeta(root, "api", "A1", { Name: "A1", AppName: "test" });
  await writeMeta(root, "function", "F1", { Name: "F1", AppName: "test" });
  const binding = bindingFor("ws1", root);
  const { ctx, catalog, fiber } = await catalogHarness(root, binding);
  const all = await catalog.listAssets({ workspaceId: "ws1" });
  assert.equal(all.ok && all.value.entries.length, 2);
  const onlyApi = await catalog.listAssets({ workspaceId: "ws1", type: "api" });
  assert.equal(onlyApi.ok && onlyApi.value.entries.every(e => e.type === "api"), true);
  const captured = ctx.get("icomposerCatalog") as IcomposerCatalogService;
  await fiber.dispose();
  const after = await captured.listAssets({ workspaceId: "ws1" });
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.error.code, "service-disposed");
  await rm(root, { recursive: true, force: true });
});

test("binding error codes: workspace-not-found passthrough, unknown falls back to storage-error", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-err-"));
  const binding = bindingFor("ws1", root);
  const { catalog } = await catalogHarness(root, binding, async (id: string) => {
    if (id === "unknown-code") return { ok: false, error: { code: "some-unexpected-code", message: "opaque internal detail" } };
    if (id === "passthrough") return { ok: false, error: { code: "service-disposed", message: "binding disposed" } };
    if (id === "nope") return { ok: false, error: { code: "workspace-not-found", message: "missing" } };
    return { ok: true, value: { workspaceId: id, canonicalPath: root, binding } };
  });
  const unknown = await catalog.listAssets({ workspaceId: "unknown-code" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.error.code, "storage-error");
    assert.equal(unknown.error.message, "storage-error");
    assert.equal(unknown.error.message.includes("opaque internal detail"), false);
  }
  const passthrough = await catalog.listAssets({ workspaceId: "passthrough" });
  assert.equal(passthrough.ok, false);
  if (!passthrough.ok) assert.equal(passthrough.error.code, "service-disposed");
  const missing = await catalog.listAssets({ workspaceId: "nope" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "workspace-not-found");
  await rm(root, { recursive: true, force: true });
});

test("invalid workspace id and type are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-invalid-"));
  const binding = bindingFor("ws1", root);
  const { catalog } = await catalogHarness(root, binding);
  const badId = await catalog.listAssets({ workspaceId: "" });
  assert.equal(badId.ok, false);
  if (!badId.ok) assert.equal(badId.error.code, "invalid-workspace-id");
  const badType = await catalog.listAssets({ workspaceId: "ws1", type: "bad" as never });
  assert.equal(badType.ok, false);
  if (!badType.ok) assert.equal(badType.error.code, "invalid-type");
  await rm(root, { recursive: true, force: true });
});

test("absolute path outside workspace is contained", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-contain-"));
  const outside = await mkdtemp(join(tmpdir(), "outside2-"));
  const outsideFile = join(outside, "Out.metadata.json");
  await writeFile(outsideFile, JSON.stringify({ api: { Name: "Out", Md5Value: "x" } }));
  await mkdir(join(root, ".metadata", "api"), { recursive: true });
  await symlink(outsideFile, join(root, ".metadata", "api", "Out.metadata.json"));
  const { entries } = await scanWorkspace(root);
  assert.equal(entries.find(e => e.name === "Out"), undefined);
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
        if (full.includes("/.metadata/icomposer")) continue;
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
  const beforeFiles = await snapshot(projectRoot);
  const wsPath = projectRoot;
  const binding = bindingFor("ws-real", wsPath);
  const { catalog } = await catalogHarness(wsPath, binding);
  const res = await catalog.listAssets({ workspaceId: "ws-real" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.truncated, false);
    // independent counts via find
    const apiCount = (await findCount(join(projectRoot, ".metadata", "api"), (n) => n.endsWith(".metadata.json")));
    const fnCount = (await findCount(join(projectRoot, ".metadata", "function"), (n) => n.endsWith(".metadata.json")));
    const batchCount = (await findCount(join(projectRoot, ".metadata", "batch"), (n) => n === "batch.metadata.json"));
    const modelCount = (await findCount(join(projectRoot, ".metadata", "model"), (n) => n.endsWith(".metadata.json")));
    assert.equal(res.value.counts.api, apiCount);
    assert.equal(res.value.counts.function, fnCount);
    assert.equal(res.value.counts.batch, batchCount);
    assert.equal(res.value.counts.model, modelCount);
    assert.equal(res.value.counts.batch, 11);
    assert.ok(res.value.counts.api >= 230);
    assert.ok(res.value.counts.function >= 200);
    // digest spot-check against independent sha256
    const samples = res.value.entries.filter(e => e.sourceFingerprint).slice(0, 3);
    for (const s of samples) {
      const content = await readText(s.sourcePath!);
      const expected = createHash("sha256").update(content).digest("hex");
      assert.equal(s.sourceFingerprint, expected);
    }
  }
  const afterFiles = await snapshot(projectRoot);
  assert.equal(beforeFiles.size, afterFiles.size);
  for (const [k, v] of beforeFiles) assert.equal(afterFiles.get(k), v);
});

async function findCount(dir: string, matcher: (name: string) => boolean): Promise<number> {
  let count = 0;
  async function walk(p: string) {
    let entries;
    try { entries = await readdir(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) await walk(full);
      else if (matcher(e.name)) count += 1;
    }
  }
  await walk(dir);
  return count;
}

async function readText(p: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(p, "utf8");
}
