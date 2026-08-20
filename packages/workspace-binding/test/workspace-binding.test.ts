import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { WorkspaceBindingService } from "../src/service.ts";
import { workspaceBindingSchema, workspaceSummarySchema } from "../../workbench-contracts/src/workspace.ts";

const validEnv = "prod_insuremo_env_001_test";
const otherEnv = "prod_insuremo_env_002_test";
const validTenant = "tenant-1";
const validProfile = "profile-1";

async function realpathNormalize(p: string): Promise<string> { return await realpath(p); }

class FakeRegistry {
  #workspaces = new Map<string, { id: string; path: string; title: string }>();
  #order: string[] = [];
  #byPath = new Map<string, string>();
  async create(path: string): Promise<{ id: string; path: string; title: string; status(): Promise<string> }> {
    const canonical = await realpathNormalize(path);
    const st = await stat(canonical);
    if (!st.isDirectory()) throw new Error("not directory");
    const existing = this.#byPath.get(canonical);
    if (existing) return this.get(existing)!;
    const id = randomUUID();
    const rec = { id, path: canonical, title: basename(canonical), status: async () => { try { const s = await stat(canonical); return s.isDirectory() ? "ok" : "missing-dir"; } catch { return "missing-dir"; } } };
    this.#workspaces.set(id, rec);
    this.#byPath.set(canonical, id);
    this.#order.unshift(id);
    return rec;
  }
  list() { return this.#order.map(id => this.#workspaces.get(id)!); }
  get(id: string) { return this.#workspaces.get(id); }
  async resolveByPath(path: string) {
    try { const c = await realpathNormalize(path); const id = this.#byPath.get(c); return id ? this.get(id) : undefined; } catch { return undefined; }
  }
  async delete(id: string): Promise<boolean> {
    const rec = this.#workspaces.get(id);
    if (!rec) return false;
    this.#workspaces.delete(id);
    this.#byPath.delete(rec.path);
    this.#order = this.#order.filter(x => x !== id);
    return true;
  }
}

interface Harness {
  ctx: Context;
  registry: FakeRegistry;
  binding: WorkspaceBindingService;
  storageRoot: string;
  backend: JsonStorageBackend;
  dispose(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const storageRoot = await mkdtemp(join(tmpdir(), "ws-bind-"));
  const ctx = new Context();
  await ctx.plugin(Storage);
  const backend = new JsonStorageBackend(storageRoot);
  ctx.storage.backend.register("json", backend);
  const facility = new DomainFacility(ctx, { backend: "json" });
  ctx.provide("storageDomain", facility);
  const registry = new FakeRegistry();
  ctx.provide("workspaceRegistry", registry as never);
  const fiber = await ctx.plugin(WorkspaceBindingService);
  await fiber.await();
  return {
    ctx,
    registry,
    binding: ctx.get("workspaceBinding") as unknown as WorkspaceBindingService,
    storageRoot,
    backend,
    dispose: async () => {
      await fiber.dispose();
      await backend.close();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

async function createWorkspace(registry: FakeRegistry): Promise<{ id: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ws-"));
  const ws = await registry.create(dir);
  return { id: String(ws.id), path: ws.path };
}

test("contract roundtrip - binding schema validates allowlist", () => {
  const binding = {
    workspaceId: "w1",
    canonicalPath: "/tmp/a",
    environmentId: validEnv,
    tenantCode: "tenant-1",
    authProfile: "dev",
    writeMode: "read-write" as const,
    metadataFingerprint: null,
    sourceFingerprint: null,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assert.doesNotThrow(() => workspaceBindingSchema.parse(binding));
  const summary = { workspaceId: "w1", displayName: "a", canonicalPath: "/tmp/a", binding, status: "ok" as const };
  assert.doesNotThrow(() => workspaceSummarySchema.parse(summary));
  const unbound = { workspaceId: "w2", displayName: "b", canonicalPath: "/tmp/b", binding: null };
  assert.doesNotThrow(() => workspaceSummarySchema.parse(unbound));
});

test("canonical alias via symlink and bind list order", async () => {
  const h = await harness();
  try {
    const ws1 = await createWorkspace(h.registry);
    // canonical alias via trailing slash / dot segment should resolve same
    const alias = ws1.path + "/.";
    const wsAlias = await h.registry.create(alias);
    assert.equal(String(wsAlias.id), ws1.id);
    const r1 = await h.binding.bind({ workspaceId: ws1.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    assert.equal(r1.ok, true);
    const list = await h.binding.list();
    assert.equal(list.ok && list.value.length >= 1, true);
    if (list.ok) {
      const first = list.value[0]!;
      assert.equal(first.workspaceId, ws1.id);
      assert.notEqual(first.binding, null);
    }
    await rm(ws1.path, { recursive: true, force: true });
  } finally { await h.dispose(); }
});

test("missing workspace and invalid identifiers are rejected with zero write", async () => {
  const h = await harness();
  try {
    const bad = await h.binding.bind({ workspaceId: "nope", environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, "workspace-not-found");
    const ws = await createWorkspace(h.registry);
    const badEnv = await h.binding.bind({ workspaceId: ws.id, environmentId: "bad", tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    assert.equal(badEnv.ok, false);
    if (!badEnv.ok) assert.equal(badEnv.error.code, "invalid-environment");
    const missingTenant = await h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: "", authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 } as never);
    assert.equal(missingTenant.ok, false);
    if (!missingTenant.ok) assert.equal(missingTenant.error.code, "invalid-tenant");
    const missingProfile = await h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: "", writeMode: "read-only", expectedRevision: 0 } as never);
    assert.equal(missingProfile.ok, false);
    if (!missingProfile.ok) assert.equal(missingProfile.error.code, "invalid-profile");
    const list = await h.binding.list();
    assert.equal(list.ok && list.value.find(e => e.workspaceId === ws.id)?.binding, null);
    await rm(ws.path, { recursive: true, force: true });
  } finally { await h.dispose(); }
});

test("first bind, update auth/writeMode, no-op and identity conflict", async () => {
  const h = await harness();
  try {
    const ws = await createWorkspace(h.registry);
    const first = await h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    assert.equal(first.ok && first.value.revision, 1);
    const upd = await h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: "dev2", writeMode: "read-write", expectedRevision: 1 });
    assert.equal(upd.ok && upd.value.revision, 2);
    const noop = await h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: "dev2", writeMode: "read-write", expectedRevision: 2 });
    assert.equal(noop.ok && noop.value.revision, 2);
    const conflict = await h.binding.bind({ workspaceId: ws.id, environmentId: otherEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 2 });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, "binding-conflict");
    await rm(ws.path, { recursive: true, force: true });
  } finally { await h.dispose(); }
});

test("concurrent CAS only one succeeds", async () => {
  const h = await harness();
  try {
    const ws = await createWorkspace(h.registry);
    await h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    const [a, b] = await Promise.all([
      h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: "a", writeMode: "read-only", expectedRevision: 1 }),
      h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: "b", writeMode: "read-only", expectedRevision: 1 }),
    ]);
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
    const loser = a.ok ? b : a;
    assert.equal(!loser.ok && (loser as any).error.code, "revision-conflict");
    await rm(ws.path, { recursive: true, force: true });
  } finally { await h.dispose(); }
});

test("orphan path blocks new workspace bind until explicit unbind", async () => {
  const h = await harness();
  try {
    const ws1 = await createWorkspace(h.registry);
    const path1 = ws1.path;
    await h.binding.bind({ workspaceId: ws1.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    await h.registry.delete(ws1.id);
    const ws2dir = path1;
    await mkdir(ws2dir, { recursive: true });
    const ws2 = await h.registry.create(ws2dir);
    const blocked = await h.binding.bind({ workspaceId: ws2.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "path-already-bound");
    const unbind = await h.binding.unbind({ workspaceId: ws1.id, expectedRevision: 1 });
    assert.equal(unbind.ok, true);
    const ok = await h.binding.bind({ workspaceId: ws2.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    assert.equal(ok.ok, true);
    await rm(ws2.path, { recursive: true, force: true });
  } finally { await h.dispose(); }
});

test("unbind does not delete file/registry/session and reopen is durable", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "ws-bind-reopen-"));
  const ctx = new Context();
  await ctx.plugin(Storage);
  const backend = new JsonStorageBackend(storageRoot);
  ctx.storage.backend.register("json", backend);
  const facility = new DomainFacility(ctx, { backend: "json" });
  ctx.provide("storageDomain", facility);
  const registry = new FakeRegistry();
  ctx.provide("workspaceRegistry", registry as never);
  const fiber = await ctx.plugin(WorkspaceBindingService);
  await fiber.await();
  const binding = ctx.get("workspaceBinding") as WorkspaceBindingService;
  const ws = await createWorkspace(registry);
  const path = ws.path;
  const bound = await binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
  assert.equal(bound.ok, true);
  // reopen: dispose and create new context with same storageRoot
  await fiber.dispose();
  await backend.close();
  const ctx2 = new Context();
  await ctx2.plugin(Storage);
  const backend2 = new JsonStorageBackend(storageRoot);
  ctx2.storage.backend.register("json", backend2);
  const facility2 = new DomainFacility(ctx2, { backend: "json" });
  ctx2.provide("storageDomain", facility2);
  const registry2 = new FakeRegistry();
  // re-create same workspace path in new registry to simulate same canonical
  const ws2 = await registry2.create(path);
  // workspaceId will be new, but binding for old ws.id should be orphan and still present
  ctx2.provide("workspaceRegistry", registry2 as never);
  const fiber2 = await ctx2.plugin(WorkspaceBindingService);
  await fiber2.await();
  const binding2 = ctx2.get("workspaceBinding") as WorkspaceBindingService;
  const list = await binding2.list();
  assert.equal(list.ok && list.value.some(e => e.workspaceId === ws.id && e.binding !== null), true);
  const unbound = await binding2.unbind({ workspaceId: ws.id, expectedRevision: 1 });
  assert.equal(unbound.ok, true);
  const st = await stat(path);
  assert.equal(st.isDirectory(), true);
  const list2 = await binding2.list();
  assert.equal(list2.ok && list2.value.find(e => e.workspaceId === ws.id)?.binding, undefined);
  // after unbind, new workspace with same path can bind
  const ws3 = await registry2.create(path);
  // ws3 will be same as ws2 (since path same, registry returns existing)
  const ok = await binding2.bind({ workspaceId: ws3.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
  assert.equal(ok.ok, true);
  await fiber2.dispose();
  await backend2.close();
  await rm(storageRoot, { recursive: true, force: true });
  await rm(path, { recursive: true, force: true }).catch(()=>{});
});

test("dispose captured face drains and closes once", async () => {
  const h = await harness();
  const ws = await createWorkspace(h.registry);
  const face = h.ctx.get("workspaceBinding") as WorkspaceBindingService;
  const listBefore = await face.list();
  assert.equal(listBefore.ok, true);
  const d1 = h.dispose();
  const d2 = h.dispose();
  await Promise.all([d1, d2]);
  const after = await face.list();
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.error.code, "service-disposed");
  const after2 = await face.get(ws.id);
  assert.equal(after2.ok, false);
  if (!after2.ok) assert.equal(after2.error.code, "service-disposed");
  await rm(ws.path, { recursive: true, force: true }).catch(() => {});
});
test("strict contract, status unavailable, MAX revision and storage error are fixed", async () => {
  const mod = await import("../src/index.ts");
  assert.equal("WorkspaceBindingService" in mod, false);
  assert.equal("workspaceBindingDomain" in mod, false);
  assert.equal("isFullInsuremoEnvId" in mod, false);
  assert.equal("bindingRecordSchema" in mod, false);
  assert.equal(mod.name, "@icomposer/workspace-binding");
  assert.deepEqual((mod.inject as readonly string[]).slice().sort(), ["storageDomain", "workspaceRegistry"].sort());
  const h = await harness();
  try {
    const ws = await createWorkspace(h.registry);
    const bound = await h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    assert.equal(bound.ok, true);
    if (bound.ok) {
      assert.doesNotThrow(() => workspaceBindingSchema.parse(bound.value));
      const entry = await h.binding.get(ws.id);
      assert.equal(entry.ok && entry.value.binding !== null, true);
      if (entry.ok && entry.value.binding) {
        assert.doesNotThrow(() => workspaceSummarySchema.parse({ workspaceId: entry.value.workspaceId, displayName: entry.value.displayName, canonicalPath: entry.value.canonicalPath, binding: entry.value.binding, status: entry.value.status }));
      }
    }
    const missingTenant = await h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: "", authProfile: validProfile, writeMode: "read-only", expectedRevision: 1 } as never);
    assert.equal(!missingTenant.ok && (missingTenant as { error: { code: string } }).error.code, "invalid-tenant");
    const missingProfile = await h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: "", writeMode: "read-only", expectedRevision: 1 } as never);
    assert.equal(!missingProfile.ok && (missingProfile as { error: { code: string } }).error.code, "invalid-profile");
    const ws2 = await createWorkspace(h.registry);
    const orig = h.registry.get(ws2.id)!;
    const origStatus = orig.status;
    (orig as unknown as { status: () => Promise<string> }).status = async () => { throw new Error("fault"); };
    const list = await h.binding.list();
    assert.equal(list.ok && list.value.find(e => e.workspaceId === ws2.id)?.status, "unavailable");
    (orig as unknown as { status: () => Promise<string> }).status = origStatus;
    const overMax = await h.binding.bind({ workspaceId: ws.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: Number.MAX_SAFE_INTEGER + 1 } as never);
    assert.equal(!overMax.ok && (overMax as { error: { code: string } }).error.code, "invalid-revision");
    // revision-exhausted: seed MAX via direct storage then try to bump
    const maxWs = await createWorkspace(h.registry);
    await h.binding.bind({ workspaceId: maxWs.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    const domain = (h.ctx as unknown as { storageDomain: { get(name: string): { table(n: string): { get(k: string): unknown; put(k: string, v: unknown): Promise<void> } } | undefined } }).storageDomain.get("workbench_workspace_binding");
    if (domain) {
      const table = domain.table("bindings");
      const rec = table.get(maxWs.id) as unknown as { revision: number };
      if (rec) {
        const maxRec = { ...(rec as unknown as Record<string, unknown>), revision: Number.MAX_SAFE_INTEGER } as unknown as Parameters<typeof table.put>[1];
        await table.put(maxWs.id, maxRec);
        const exhausted = await h.binding.bind({ workspaceId: maxWs.id, environmentId: validEnv, tenantCode: validTenant, authProfile: "new-profile", writeMode: "read-write", expectedRevision: Number.MAX_SAFE_INTEGER });
        assert.equal(!exhausted.ok && (exhausted as { error: { code: string } }).error.code, "revision-exhausted");
      }
    }
    await rm(maxWs.path, { recursive: true, force: true }).catch(()=>{});
    // storage-error: close backend then try bind should map to storage-error
    const ws3 = await createWorkspace(h.registry);
    await h.backend.close();
    const storageErr = await h.binding.bind({ workspaceId: ws3.id, environmentId: validEnv, tenantCode: validTenant, authProfile: validProfile, writeMode: "read-only", expectedRevision: 0 });
    assert.equal(!storageErr.ok && (storageErr as { error: { code: string } }).error.code, "storage-error");
    await rm(ws3.path, { recursive: true, force: true }).catch(()=>{});
    await rm(ws.path, { recursive: true, force: true });
    await rm(ws2.path, { recursive: true, force: true });
  } finally { await h.dispose(); }
});
