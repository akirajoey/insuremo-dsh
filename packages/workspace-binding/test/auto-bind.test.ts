import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { WorkspaceBindingService } from "../src/service.ts";
import { mountAutoBind, WORKSPACE_ICOMPOSER_AUTO_BOUND_EVENT } from "../src/auto-bind.ts";
import { detectIcomposerProject, deriveBindIdentity } from "../src/detect.ts";
import { workspaceBindingDomain } from "../src/domain.ts";

async function makeIcomposerDir(root: string, shape: "metadata-api" | "metadata-batch" | "src-dev" | "plain" | "empty-metadata" = "metadata-api"): Promise<string> {
  const dir = join(root, shape);
  await mkdir(dir, { recursive: true });
  if (shape === "metadata-api") {
    await mkdir(join(dir, ".metadata", "api"), { recursive: true });
    await writeFile(join(dir, ".metadata", "api", "DemoApi.metadata.json"), "{}", "utf8");
  } else if (shape === "metadata-batch") {
    await mkdir(join(dir, ".metadata", "batch"), { recursive: true });
    await writeFile(join(dir, ".metadata", "batch", "b.metadata.json"), "{}", "utf8");
  } else if (shape === "src-dev") {
    await mkdir(join(dir, "src", "dev", "Tenant", "Group", "api", "Demo"), { recursive: true });
    await writeFile(join(dir, "src", "dev", "Tenant", "Group", "api", "Demo", "Demo.groovy"), "class Demo {}", "utf8");
  } else if (shape === "empty-metadata") {
    await mkdir(join(dir, ".metadata"), { recursive: true });
  }
  return dir;
}

test("detection: strong signatures hit, plain/empty dirs miss", async () => {
  const root = await mkdtemp(join(tmpdir(), "w037-det-"));
  try {
    assert.equal(await detectIcomposerProject(await makeIcomposerDir(root, "metadata-api")), true);
    assert.equal(await detectIcomposerProject(await makeIcomposerDir(root, "metadata-batch")), true);
    assert.equal(await detectIcomposerProject(await makeIcomposerDir(root, "src-dev")), true);
    assert.equal(await detectIcomposerProject(await makeIcomposerDir(root, "plain")), false);
    assert.equal(await detectIcomposerProject(await makeIcomposerDir(root, "empty-metadata")), false);
    assert.equal(await detectIcomposerProject(join(root, "does-not-exist")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deriveBindIdentity: triple completeness gate", () => {
  assert.deepEqual(deriveBindIdentity({ profileName: "portal:microsite", envId: "aws_sg_insuremo_portal", tenantCode: "microsite" }), {
    environmentId: "aws_sg_insuremo_portal",
    tenantCode: "microsite",
    authProfile: "portal:microsite",
  });
  assert.equal(deriveBindIdentity(null), null);
  assert.equal(deriveBindIdentity({ profileName: "p", envId: "e" }), null); // no tenant
  assert.equal(deriveBindIdentity({ profileName: "p", tenantCode: "t" }), null); // no env id
  assert.equal(deriveBindIdentity({ envId: "e", tenantCode: "t" }), null); // no profile name
  assert.equal(deriveBindIdentity({ profileName: "p", envId: "", tenantCode: "t" }), null);
});

interface Fixture {
  ctx: Context;
  events: string[];
  emitChange(change: { domain: string; table: string; operation: string; value?: unknown }): void;
  autoBind: ReturnType<typeof mountAutoBind>;
  bindingCalls: { bindInputs: unknown[] };
  dispose(): Promise<void>;
}

async function fixture(opts: {
  profile?: { profileName: string; envId?: string; tenantCode?: string } | null;
  workspaces?: ReadonlyArray<{ id: string; path: string; title: string }>;
  bindResult?: { ok: boolean; error?: { code: string } };
  legacyAuth?: unknown;
} = {}): Promise<Fixture> {
  const ctx = new Context();
  const storage = new Storage(ctx);
  const directory = await mkdtemp(join(tmpdir(), "w037-store-"));
  const backend = new JsonStorageBackend(directory);
  storage.backend.register("json", backend);
  const storageDomain = new DomainFacility(ctx, { backend: "json" });
  ctx.provide("storageDomain", storageDomain as never);
  const events: string[] = [];
  const bindingCalls = { bindInputs: [] as unknown[] };
  const workspaceBinding = {
    list: async () => ({ ok: true, value: (opts.workspaces ?? []).map(w => ({ workspaceId: w.id, canonicalPath: w.path, displayName: w.title, binding: null, autoBindState: "none" as const })) }),
    get: async (id: string) => {
      const ws = (opts.workspaces ?? []).find(w => w.id === id);
      if (ws === undefined) return { ok: false, error: { code: "workspace-not-found" } };
      return { ok: true, value: { workspaceId: id, canonicalPath: ws.path, displayName: ws.title, status: "ok", binding: null } };
    },
    bind: async (input: unknown) => {
      bindingCalls.bindInputs.push(input);
      return opts.bindResult ?? { ok: true, value: {} };
    },
  };
  const activeProfile = opts.profile === undefined ? undefined : {
    get: async () => opts.profile === null
      ? { ok: true, value: { status: "none", activeProfileName: null } }
      : { ok: true, value: { status: "active", activeProfileName: opts.profile.profileName, profile: opts.profile } },
  };
  ctx.provide("workspaceBinding", workspaceBinding as never);
  if (activeProfile !== undefined) ctx.provide("imoActiveProfile" as never, activeProfile as never);
  if (opts.legacyAuth !== undefined) ctx.provide("imoAuth" as never, opts.legacyAuth as never);
  ctx.provide("workspaceRegistry" as never, {
    list: () => opts.workspaces ?? [],
    get: (id: string) => (opts.workspaces ?? []).find(w => w.id === id),
  } as never);
  ctx.on(WORKSPACE_ICOMPOSER_AUTO_BOUND_EVENT as never, ((payload: unknown) => { events.push(JSON.stringify(payload)); }) as never);
  const autoBind = mountAutoBind(ctx as never, { binding: () => workspaceBinding as never });
  return {
    ctx, events, autoBind, bindingCalls,
    emitChange(change) { (ctx as unknown as { emit(name: string, payload: unknown): void }).emit("domain/changed", change); },
    dispose: async () => {
      autoBind.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("auto-bind: iComposer put with complete Active Profile binds and emits the durable event", async () => {
  const root = await mkdtemp(join(tmpdir(), "w037-ab-"));
  const dir = await makeIcomposerDir(root, "metadata-api");
  const h = await fixture({
    profile: { profileName: "portal:microsite", envId: "aws_sg_insuremo_portal", tenantCode: "microsite" },
    workspaces: [{ id: "ws-1", path: dir, title: "demo" }],
  });
  try {
    h.emitChange({ domain: "workspace", table: "workspaces", operation: "put", value: { path: dir } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.bindingCalls.bindInputs.length, 1);
    const input = h.bindingCalls.bindInputs[0] as Record<string, unknown>;
    assert.equal(input.workspaceId, "ws-1");
    assert.equal(input.authProfile, "portal:microsite");
    assert.equal(input.environmentId, "aws_sg_insuremo_portal");
    assert.equal(input.tenantCode, "microsite");
    assert.equal(input.writeMode, "read-only");
    assert.deepEqual(h.events, [JSON.stringify({ workspaceId: "ws-1" })]);
    const state = await h.autoBind.stateOf("ws-1");
    void state; // fake binding.get returns binding:null — stateOf derives detected path
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("auto-bind: plain directory put never calls bind; unrelated domain/table events ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "w037-plain-"));
  const dir = await makeIcomposerDir(root, "plain");
  const h = await fixture({
    profile: { profileName: "portal:microsite", envId: "aws_sg_insuremo_portal", tenantCode: "microsite" },
    workspaces: [{ id: "ws-plain", path: dir, title: "plain" }],
  });
  try {
    h.emitChange({ domain: "workspace", table: "workspaces", operation: "put", value: { path: dir } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.bindingCalls.bindInputs.length, 0);
    assert.equal(h.events.length, 0);
    // non-matching events ignored
    h.emitChange({ domain: "other", table: "workspaces", operation: "put", value: { path: dir } });
    h.emitChange({ domain: "workspace", table: "workspaces", operation: "deleted" });
    h.emitChange({ domain: "workspace", table: "sessions", operation: "put", value: {} });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.bindingCalls.bindInputs.length, 0);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("auto-bind: missing identity pieces stay pending (no bind call)", async () => {
  const root = await mkdtemp(join(tmpdir(), "w037-pend-"));
  const dir = await makeIcomposerDir(root, "src-dev");
  const h = await fixture({
    profile: { profileName: "portal:microsite", tenantCode: "microsite" }, // envId missing
    workspaces: [{ id: "ws-p", path: dir, title: "p" }],
  });
  try {
    h.emitChange({ domain: "workspace", table: "workspaces", operation: "put", value: { path: dir } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.bindingCalls.bindInputs.length, 0);
    assert.equal(h.events.length, 0);
    const state = await h.autoBind.stateOf("ws-p");
    assert.equal(state.detected, true);
    assert.equal(state.state, "pending");
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("auto-bind: no Active Profile stays pending without CLI default reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "w037-noauth-"));
  const dir = await makeIcomposerDir(root, "metadata-api");
  const h = await fixture({ profile: null, workspaces: [{ id: "ws-n", path: dir, title: "n" }] });
  try {
    h.emitChange({ domain: "workspace", table: "workspaces", operation: "put", value: { path: dir } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.bindingCalls.bindInputs.length, 0);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("auto-bind: never reads the CLI default profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "w037-no-default-read-"));
  const dir = await makeIcomposerDir(root, "metadata-api");
  let defaultReads = 0;
  const h = await fixture({
    legacyAuth: { defaultProfile: async () => { defaultReads += 1; throw new Error("must not be called"); } },
    workspaces: [{ id: "ws-no-default", path: dir, title: "no-default" }],
  });
  try {
    h.emitChange({ domain: "workspace", table: "workspaces", operation: "put", value: { path: dir } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(defaultReads, 0);
    assert.equal(h.bindingCalls.bindInputs.length, 0);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("auto-bind: idempotent — repeated puts for the same workspace never rebind", async () => {
  const root = await mkdtemp(join(tmpdir(), "w037-idem-"));
  const dir = await makeIcomposerDir(root, "metadata-api");
  const h = await fixture({
    profile: { profileName: "p", envId: "e1", tenantCode: "t1" },
    workspaces: [{ id: "ws-i", path: dir, title: "i" }],
  });
  try {
    for (let i = 0; i < 3; i++) h.emitChange({ domain: "workspace", table: "workspaces", operation: "put", value: { path: dir } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.bindingCalls.bindInputs.length, 1);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("auto-bind: bind failure (binding-conflict) never throws, never retries, no event", async () => {
  const root = await mkdtemp(join(tmpdir(), "w037-fail-"));
  const dir = await makeIcomposerDir(root, "metadata-api");
  const h = await fixture({
    profile: { profileName: "p", envId: "e1", tenantCode: "t1" },
    workspaces: [{ id: "ws-f", path: dir, title: "f" }],
    bindResult: { ok: false, error: { code: "binding-conflict" } },
  });
  try {
    h.emitChange({ domain: "workspace", table: "workspaces", operation: "put", value: { path: dir } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.bindingCalls.bindInputs.length, 1); // attempted once
    assert.equal(h.events.length, 0); // no auto-bound event on failure
    // a second put still does not re-attempt (idempotent by handled-set)
    h.emitChange({ domain: "workspace", table: "workspaces", operation: "put", value: { path: dir } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.bindingCalls.bindInputs.length, 1);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("service view surfaces detectedIcomposer/autoBindState (get + list)", async () => {
  const root = await mkdtemp(join(tmpdir(), "w037-view-"));
  const dir = await makeIcomposerDir(root, "metadata-api");
  const plain = await makeIcomposerDir(root, "plain");
  const ctx = new Context();
  const storage = new Storage(ctx);
  const directory = await mkdtemp(join(tmpdir(), "w037-view-store-"));
  const backend = new JsonStorageBackend(directory);
  storage.backend.register("json", backend);
  ctx.provide("storageDomain", new DomainFacility(ctx, { backend: "json" }) as never);
  const byPath = new Map([[dir, "ws-ic"], [plain, "ws-plain"]]);
  ctx.provide("workspaceRegistry" as never, {
    list: () => [...byPath].map(([path, id]) => ({ id, path, title: id, status: async () => "ok" })),
    get: (id: string) => {
      for (const [path, wid] of byPath) if (wid === id) return { id, path, title: id, status: async () => "ok" };
      return undefined;
    },
  } as never);
  const fiber = await ctx.plugin(WorkspaceBindingService as never);
  await fiber.await();
  const binding = ctx.get("workspaceBinding") as unknown as {
    get(id: string): Promise<{ ok: boolean; value?: { detectedIcomposer?: boolean; autoBindState?: string } }>;
    list(): Promise<{ ok: boolean; value?: ReadonlyArray<{ workspaceId: string; detectedIcomposer?: boolean; autoBindState?: string }> }>;
    autoBindState(id: string): Promise<{ ok: boolean; value?: { detected: boolean; state: string } }>;
  };
  try {
    const ic = await binding.get("ws-ic");
    assert.equal(ic.ok, true);
    assert.equal(ic.value!.detectedIcomposer, true);
    assert.equal(ic.value!.autoBindState, "pending");
    const plainView = await binding.get("ws-plain");
    assert.equal(plainView.value!.detectedIcomposer, false);
    assert.equal(plainView.value!.autoBindState, "none");
    const listed = await binding.list();
    const rowMap = new Map(listed.value!.map(row => [row.workspaceId, row]));
    assert.equal(rowMap.get("ws-ic")!.autoBindState, "pending");
    assert.equal(rowMap.get("ws-plain")!.autoBindState, "none");
    const state = await binding.autoBindState("ws-ic");
    assert.equal(state.value!.detected, true);
    assert.equal(state.value!.state, "pending");
  } finally {
    await fiber.dispose();
    await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
