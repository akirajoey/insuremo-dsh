import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { ACTIVE_PROFILE_CHANGED_EVENT, ImoActiveProfileService } from "../src/active-profile.ts";
import { ImoOverviewService } from "../src/overview/service.ts";

function auth(defaultProfile: string | null) {
  const profiles = [
    { profileName: "portal:mo-re", env: "portal", isDefault: defaultProfile === "portal:mo-re" },
    { profileName: "portal:tpsgsp", env: "portal", isDefault: defaultProfile === "portal:tpsgsp" },
    { profileName: "portal:ptdev", env: "portal", isDefault: defaultProfile === "portal:ptdev" },
  ];
  return {
    profilesFast: async () => ({ ok: true, value: { profiles, defaultProfile, stale: false } }),
    listProfiles: async () => ({ ok: true, value: { profiles, stdoutDigest: "sha256:list" } }),
    listProfilesCached: async () => ({ ok: true, value: { profiles, stdoutDigest: "sha256:cached" } }),
  };
}

async function mount(directory: string, defaultProfile: string | null, imoAuth = auth(defaultProfile)) {
  const ctx = new Context();
  const storage = new Storage(ctx);
  storage.backend.register("json", new JsonStorageBackend(directory));
  ctx.provide("storageDomain" as never, new DomainFacility(ctx, { backend: "json" }) as never);
  ctx.provide("imoAuth" as never, imoAuth as never);
  const fiber = ctx.plugin(ImoActiveProfileService as never);
  await fiber.await();
  return { ctx, fiber, service: ctx.get("imoActiveProfile" as never) as unknown as ImoActiveProfileService };
}

test("TASK-047 Active Profile bootstraps once, selects independently, and survives restart/cwd default changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "active-profile-"));
  try {
    const first = await mount(directory, "portal:mo-re");
    const boot = await first.service.get();
    assert.equal(boot.ok, true);
    if (!boot.ok) return;
    assert.equal(boot.value.activeProfileName, "portal:mo-re");
    const selected = await first.service.select("portal:tpsgsp");
    assert.equal(selected.ok, true);
    if (!selected.ok) return;
    assert.equal(selected.value.activeProfileName, "portal:tpsgsp");
    const files = await readdir(directory, { recursive: true });
    const persisted = (await Promise.all(files.filter(file => typeof file === "string").map(file => readFile(join(directory, file), "utf8").catch(() => "")))).join("\\n");
    assert.equal(/access_token|token|gateway|tenantDomain|path/i.test(persisted), false);
    assert.match(persisted, /profileName|revision|updatedAt/);
    await first.fiber.dispose();

    const second = await mount(directory, "portal:ptdev");
    const restored = await second.service.get();
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.value.activeProfileName, "portal:tpsgsp");
    assert.equal(restored.value.revision, 2);
    await second.fiber.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("TASK-047 fast overview uses one sanitized list and zero default reads after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "active-profile-fast-"));
  const provideOverviewFaces = (ctx: Context) => {
    ctx.provide("imoCli" as never, { probe: async () => ({ ok: true, value: {} }), version: async () => ({ ok: true, value: {} }), upgradeCheck: async () => ({ ok: true, value: {} }) } as never);
    ctx.provide("imoSkills" as never, { list: async () => ({ ok: true, value: { scope: "global", skills: [], stdoutDigest: "sha256:s" } }), validate: async () => ({ ok: true, value: { inventoryComplete: true, items: [], checkedAt: "now" } }) } as never);
    ctx.provide("imoSkillActivation" as never, { snapshot: async () => ({ initialized: true, installed: [], enabled: [], disabled: [], stale: [], revision: 1 }) } as never);
    ctx.provide("operationLog" as never, { list: () => [] } as never);
  };
  const makeAuth = () => {
    let cached = false;
    const counts = { list: 0, fast: 0, default: 0 };
    const profiles = [{ profileName: "a", isDefault: true }];
    return {
      counts,
      face: {
        profilesFast: async () => { counts.fast += 1; counts.default += 1; return { ok: true, value: { profiles, defaultProfile: "a", stale: false } }; },
        listProfilesCached: async () => { if (!cached) { cached = true; counts.list += 1; } return { ok: true, value: { profiles, stdoutDigest: "sha256:list" } }; },
        listProfiles: async () => ({ ok: true, value: { profiles, stdoutDigest: "sha256:fresh" } }),
      },
    };
  };
  try {
    const firstAuth = makeAuth();
    const first = await mount(directory, "a", firstAuth.face);
    provideOverviewFaces(first.ctx);
    const firstOverview = new ImoOverviewService(first.ctx, {});
    const firstFast = await firstOverview.snapshotFast();
    assert.equal(firstFast.auth.activeProfileName, "a");
    assert.deepEqual(firstAuth.counts, { list: 1, fast: 1, default: 1 });
    await first.fiber.dispose();

    const secondAuth = makeAuth();
    const second = await mount(directory, "a", secondAuth.face);
    provideOverviewFaces(second.ctx);
    const secondOverview = new ImoOverviewService(second.ctx, {});
    const restored = await secondOverview.snapshotFast();
    assert.equal(restored.auth.activeProfileName, "a");
    assert.deepEqual(secondAuth.counts, { list: 1, fast: 0, default: 0 });
    await secondOverview.snapshotFast();
    assert.deepEqual(secondAuth.counts, { list: 1, fast: 0, default: 0 });
    await second.fiber.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("TASK-047 overview cache is invalidated immediately by metadata-only active change", async () => {
  const ctx = new Context();
  let current = "a";
  ctx.provide("imoCli" as never, { probe: async () => ({ ok: true, value: {} }), version: async () => ({ ok: true, value: {} }), upgradeCheck: async () => ({ ok: true, value: {} }) } as never);
  ctx.provide("imoAuth" as never, { listProfiles: async () => ({ ok: true, value: { profiles: [{ profileName: "a" }, { profileName: "b" }], stdoutDigest: "sha256:list" } }), defaultProfile: async () => ({ ok: true, value: { profileName: "a", stdoutDigest: "sha256:def" } }) } as never);
  ctx.provide("imoActiveProfile" as never, { get: async () => ({ ok: true, value: { activeProfileName: current, revision: current === "a" ? 1 : 2, status: "active", profile: { profileName: current } } }) } as never);
  ctx.provide("imoSkills" as never, { list: async () => ({ ok: true, value: { scope: "global", skills: [], stdoutDigest: "sha256:s" } }), validate: async () => ({ ok: true, value: { scope: "global", inventoryComplete: true, items: [], checkedAt: "now" } }) } as never);
  ctx.provide("imoSkillActivation" as never, { snapshot: async () => ({ initialized: true, installed: [], enabled: [], disabled: [], stale: [], revision: 1 }) } as never);
  ctx.provide("operationLog" as never, { list: () => [] } as never);
  const overview = new ImoOverviewService(ctx, { overviewTtlMs: 5000 });
  const first = await overview.snapshot();
  assert.equal(first.auth.activeProfileName, "a");
  current = "b";
  ctx.emit(ACTIVE_PROFILE_CHANGED_EVENT, { profileName: "b", revision: 2 });
  const second = await overview.snapshot();
  assert.equal(second.auth.activeProfileName, "b");
});

test("TASK-047 cached inventory reports missing, recovers, and fails closed when stale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "active-profile-recovery-"));
  try {
    let inventory = [{ profileName: "portal:mo-re" }, { profileName: "portal:tpsgsp" }];
    let stale = false;
    const imoAuth = {
      profilesFast: async () => ({ ok: true, value: { profiles: inventory, defaultProfile: "portal:mo-re", stale } }),
      listProfiles: async () => ({ ok: true, value: { profiles: inventory, stdoutDigest: "sha256:list" } }),
      listProfilesCached: async () => stale ? ({ ok: false, error: { code: "unavailable", message: "unavailable" } }) : ({ ok: true, value: { profiles: inventory, stdoutDigest: "sha256:cached" } }),
    };
    const mounted = await mount(directory, "portal:mo-re", imoAuth);
    await mounted.service.select("portal:tpsgsp");
    inventory = [{ profileName: "portal:mo-re" }];
    let view = await mounted.service.get();
    assert.equal(view.ok && view.value.status, "missing");
    inventory = [{ profileName: "portal:mo-re" }, { profileName: "portal:tpsgsp" }];
    view = await mounted.service.get();
    assert.equal(view.ok && view.value.activeProfileName, "portal:tpsgsp");
    stale = true;
    view = await mounted.service.get();
    assert.equal(view.ok && view.value.status, "unavailable");
    await mounted.fiber.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("TASK-047 concurrent selection is serialized and revisions are monotonic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "active-profile-concurrent-"));
  try {
    let listCalls = 0;
    const imoAuth = {
      profilesFast: async () => ({ ok: true, value: { profiles: [{ profileName: "a" }, { profileName: "b" }], defaultProfile: "a", stale: false } }),
      listProfiles: async () => { listCalls += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true, value: { profiles: [{ profileName: "a" }, { profileName: "b" }], stdoutDigest: "sha256:list" } }; },
      listProfilesCached: async () => ({ ok: true, value: { profiles: [{ profileName: "a" }, { profileName: "b" }], stdoutDigest: "sha256:cached" } }),
    };
    const mounted = await mount(directory, "a", imoAuth);
    const [left, right] = await Promise.all([mounted.service.select("a"), mounted.service.select("b")]);
    assert.equal(left.ok && left.value.revision, 1);
    assert.equal(right.ok && right.value.revision, 2);
    assert.equal(listCalls, 2);
    await mounted.fiber.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("TASK-047 missing stored Active Profile is explicit and never falls back to CLI default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "active-profile-missing-"));
  try {
    const mounted = await mount(directory, "portal:mo-re");
    await mounted.service.select("portal:tpsgsp");
    const face = mounted.service;
    (face as unknown as { get: () => Promise<unknown> });
    // The fake inventory is adjusted by using a fresh context with the same
    // durable record but an inventory that no longer contains the selection.
    await mounted.fiber.dispose();
    const ctx = new Context();
    const storage = new Storage(ctx);
    storage.backend.register("json", new JsonStorageBackend(directory));
    ctx.provide("storageDomain" as never, new DomainFacility(ctx, { backend: "json" }) as never);
    ctx.provide("imoAuth" as never, { profilesFast: async () => ({ ok: true, value: { profiles: [{ profileName: "portal:mo-re" }], defaultProfile: "portal:mo-re", stale: false } }), listProfiles: async () => ({ ok: true, value: { profiles: [{ profileName: "portal:mo-re" }], stdoutDigest: "sha256:list" } }), listProfilesCached: async () => ({ ok: true, value: { profiles: [{ profileName: "portal:mo-re" }], stdoutDigest: "sha256:cached" } }) } as never);
    const fiber = ctx.plugin(ImoActiveProfileService as never);
    await fiber.await();
    const active = ctx.get("imoActiveProfile" as never) as { get(): Promise<{ ok: true; value: { activeProfileName: string | null; storedProfileName?: string; status: string } }> };
    const view = await active.get();
    assert.equal(view.value.activeProfileName, null);
    assert.equal(view.value.storedProfileName, "portal:tpsgsp");
    assert.equal(view.value.status, "missing");
    await fiber.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
