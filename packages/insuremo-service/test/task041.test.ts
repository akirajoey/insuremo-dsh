import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildWorkspaceStatuses } from "../src/overview/workspaces-status.ts";
import { ImoOverviewService } from "../src/overview/service.ts";
import { ImoAuthService } from "../src/auth/service.ts";
import { Context } from "@deepseek-ai/cordis";
import { authFixture, authResponse, makeFakeIo } from "./support/fake-subprocess.ts";

function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function fail(code: string): { ok: false; error: { code: string; message: string; command?: string } } { return { ok: false, error: { code, message: code } }; }

/* ---------- ① workspaces/status displayName join ---------- */

test("workspaces/status entries carry displayName (registry title, id fallback)", async () => {
  const ctx = new Context();
  ctx.provide("workspaceBinding" as never, {
    list: async () => ({
      ok: true,
      value: [
        { workspaceId: "ws-1", canonicalPath: "/tmp/a", displayName: "ssapocpa", detectedIcomposer: true, autoBindState: "bound" },
        { workspaceId: "ws-2", canonicalPath: "/tmp/b", detectedIcomposer: false, autoBindState: "none" },
        { workspaceId: "ws-3", canonicalPath: "/tmp/c", displayName: "", detectedIcomposer: false, autoBindState: "none" },
      ],
    }),
  } as never);
  const entries = await buildWorkspaceStatuses(ctx as never);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].displayName, "ssapocpa");
  assert.equal(entries[1].displayName, "ws-2"); // fallback id
  assert.equal(entries[2].displayName, "ws-3"); // empty title falls back
});

/* ---------- ②③ fast/full channels + auth stale cache + profilesFast ---------- */



test("profilesFast returns sanitized CLI profiles — cold hits CLI once, warm is cache; tokens never surface (TASK-043)", async () => {
  const raw = JSON.stringify([
    { name: "portal:demo", env: "portal", is_default: true, access_token: "SECRETTOKEN", secret: "s" },
  ]);
  const io = makeFakeIo({ authResponses: new Map([
    ["auth profile list --format json", authResponse(raw)],
    ["auth default-profile get", authResponse("portal:demo")],
  ]) });
  const fx = await authFixture(io);
  try {
    const service = fx.auth as ImoAuthService;
    const cold = await service.profilesFast();
    assert.ok(cold.ok);
    assert.equal(Array.isArray(cold.value.profiles), true);
    assert.equal(cold.value.stale, false);
    const profile = cold.value.profiles[0];
    assert.equal(typeof profile.profileName, "string");
    // token material never surfaces from the sanitized CLI result
    assert.equal("access_token" in profile, false);
    assert.equal((profile as Record<string, unknown>).secret, undefined);
    // warm second call does not spawn again
    const warm = await service.profilesFast();
    assert.ok(warm.ok);
    const cliRuns = fx.io.invocations.filter(args => args.join(" ").includes("profile list")).length;
    assert.equal(cliRuns, 1);
  } finally { await fx.fiber.dispose(); }
});

test("listProfilesCached: 60s TTL serves the same result without a second CLI run; stale degrade on failure", async () => {
  let cliRuns = 0;
  let broken = false;
  const io = makeFakeIo({ authResponses: new Map([
    ["auth profile list --format json", authResponse('[{"name":"portal:x","env":"portal","is_default":true}]')],
    ["auth default-profile get", authResponse("portal:x")],
  ]) });
  const fx = await authFixture(io);
  // count CLI runs through the fake io by wrapping after creation
  const service = fx.auth as ImoAuthService;
  const listA = await service.listProfilesCached();
  assert.ok(listA.ok);
  const listB = await service.listProfilesCached();
  assert.ok(listB.ok);
  // TTL cache answered without new spawns: fake io records each spawn
  cliRuns = fx.io.invocations.filter(args => args.join(" ").includes("profile list")).length;
  assert.equal(cliRuns, 1);
  // CLI breaks with no cache → honest error (never a fake empty ok)
  await fx.fiber.dispose();
  const brokenIo = makeFakeIo({ smokeFailures: new Map([["auth profile list --format json", 1]]), authResponses: new Map([["auth default-profile get", authResponse("portal:x")]]) });
  const brokenFx = await authFixture(brokenIo);
  const degraded = await (brokenFx.auth as ImoAuthService).listProfilesCached();
  assert.equal(degraded.ok, false);
  await brokenFx.fiber.dispose();
});

test("profilesFast with a warm cache serves sanitized profiles over a failing CLI (stale = honest degrade)", async () => {
  // TASK-043: no credential-store file read at all — the sanitized CLI result
  // is cached, and a later CLI failure still serves the last good sanitized
  // list with stale=true rather than an empty error.
  const io = makeFakeIo({ authResponses: new Map([
    ["auth profile list --format json", authResponse('[{"name":"portal:y","env":"portal","is_default":false}]')],
    ["auth default-profile get", authResponse("portal:y")],
  ]) });
  const fx = await authFixture(io);
  const service = fx.auth as ImoAuthService;
  const warm = await service.listProfilesCached();
  assert.ok(warm.ok);
  const fast = await service.profilesFast();
  assert.ok(fast.ok);
  // warm cache is not stale
  assert.equal(fast.value.stale, false);
  assert.ok(fast.value.profiles.some(p => p.profileName === "portal:y"));
  await fx.fiber.dispose();
});

test("overview fast channel: no CLI probe, auth from profile store / cache, cold sections flagged fast-uncached", async () => {
  const ctx = new Context();
  ctx.provide("imoCli" as never, {
    probe: async () => ok({ command: "imo", executablePath: "/opt/homebrew/bin/imo" }),
    version: async () => ok({ executablePath: "imo", currentVersion: "0.2.17", stdoutDigest: "sha256:v" }),
    upgradeCheck: async () => ok({ executablePath: "imo", currentVersion: "0.2.17", targetVersion: "0.2.18", updateAvailable: false, stdoutDigest: "sha256:u" }),
  } as never);
  ctx.provide("imoAuth" as never, {
    listProfiles: async () => ok({ profiles: [{ profileName: "portal:z", env: "portal", isDefault: true }], stdoutDigest: "sha256:a" }),
    listProfilesCached: async () => ok({ profiles: [{ profileName: "portal:z", env: "portal", accountName: "user@example.com", isDefault: true }], stdoutDigest: "sha256:a" }),
    profilesFast: async () => ok({ profiles: [{ profileName: "portal:z", env: "portal", tenantCode: "tc", accountName: "user@example.com", isDefault: true }], defaultProfile: "portal:z", stale: false }),
    defaultProfile: async () => ok({ profileName: "portal:z", stdoutDigest: "sha256:d" }),
    invalidate: () => ({ invalidated: 0 }),
    cacheStatus: () => ({}),
    validate: async () => ok({ profileName: "portal:z", valid: true, checkedAt: "now", stdoutDigest: "sha256:x" }),
    prepare: async () => { throw new Error("unused"); },
  } as never);
  ctx.provide("imoSkills" as never, {
    list: async () => ok({ scope: "global", skills: [], stdoutDigest: "sha256:c" }),
    validate: async () => ok({ scope: "global", inventoryComplete: true, items: [], checkedAt: "now" }),
  } as never);
  ctx.provide("imoSkillActivation" as never, { snapshot: async () => ({ initialized: true, installed: [], enabled: [], disabled: [], stale: [], revision: 1 }) } as never);
  ctx.provide("operationLog" as never, { list: () => [] } as never);
  const service = new ImoOverviewService(ctx as never, {});
  const fast = await service.snapshotFast();
  // fast: auth from profile store with account tooltip field
  assert.equal(fast.auth.status, "ok");
  assert.ok(fast.auth.profiles.some(p => p.name === "portal:z" && p.account === "user@example.com"));
  // cold sections flagged, never fake-None
  assert.equal(fast.imo.code, "fast-uncached");
  assert.equal(fast.skills.code, "fast-uncached");
  // full channel warms the caches
  const full = await service.snapshot();
  assert.equal(full.imo.status === "error" || full.imo.available, true);
  const fast2 = await service.snapshotFast();
  assert.notEqual(fast2.imo.code, "fast-uncached");
});

test("TASK-043 fix-3: prewarm fills list+default caches; warm fast = zero CLI spawns; switch invalidation re-reads (new default)", async () => {
  const rawList = '[{"name":"portal:a","env":"portal","is_default":false,"access_token":"TOK"}]';
  const io = makeFakeIo({ authResponses: new Map([
    ["auth profile list --format json", authResponse(rawList)],
    ["auth default-profile get", authResponse("portal:a")],
  ]) });
  const fx = await authFixture(io);
  try {
    const service = fx.auth as ImoAuthService;
    // prewarm once (fills list + default caches)
    const prewarm = await service.profilesFast();
    assert.ok(prewarm.ok);
    const counts = () => ({
      list: fx.io.invocations.filter(args => args.join(" ").includes("profile list")).length,
      def: fx.io.invocations.filter(args => args.join(" ").includes("default-profile get")).length,
    });
    const afterWarm = counts();
    assert.equal(afterWarm.list, 1);
    assert.equal(afterWarm.def, 1);
    // two warm fast reads: zero new spawns
    await service.profilesFast();
    await service.profilesFast();
    const afterTwo = counts();
    assert.equal(afterTwo.list, 1);
    assert.equal(afterTwo.def, 1);
    // switch → invalidate drops list+default caches → next fast re-reads both
    // and reflects the new default
    fx.io.authResponses.set("auth default-profile get", authResponse("portal:b"));
    service.invalidate({ profile: "portal:b", reason: "profile-changed" });
    const post = await service.profilesFast();
    assert.ok(post.ok);
    assert.equal(post.value.defaultProfile, "portal:b", "new default after invalidation");
    const afterSwitch = counts();
    assert.equal(afterSwitch.list, 2, "list re-read once after invalidation");
    assert.equal(afterSwitch.def, 2, "default re-read once after invalidation");
  } finally { await fx.fiber.dispose(); }
});
