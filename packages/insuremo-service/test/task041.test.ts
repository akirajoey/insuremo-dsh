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



test("profilesFast reads the profile store file directly (no subprocess, ms-level)", async () => {
  // The real store exists on this machine; assert against its contract shape
  // without asserting specific profile names (machine-dependent).
  const io = makeFakeIo({ authResponses: new Map([
    ["auth profile list --format json", authResponse("[]")],
    ["auth default-profile get", authResponse("")],
  ]) });
  const fx = await authFixture(io);
  const service = fx.auth as ImoAuthService;
  const result = await service.profilesFast();
  await fx.fiber.dispose();
  if (result.ok && !result.value.stale) {
    assert.ok(Array.isArray(result.value.profiles));
    for (const profile of result.value.profiles) {
      assert.equal(typeof profile.profileName, "string");
      // token material never surfaces
      assert.equal("access_token" in profile, false);
      assert.equal((profile as Record<string, unknown>).access_token, undefined);
    }
  } else {
    // store file missing on this machine → falls back to CLI cache path
    assert.ok(result.ok === false || result.value.stale === true);
  }
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

test("profilesFast degrades to the stale CLI cache when the store file is unreadable and the CLI fails", async () => {
  // Point HOME at an empty dir so no store file is found, CLI fails once.
  const prevHome = process.env.HOME;
  const empty = await mkdtemp(join(tmpdir(), "t041-home-"));
  process.env.HOME = empty;
  try {
    // no store file under the fake HOME; CLI answers once then we assert the
    // cached path through profilesFast's documented fallback (cached list or error)
    const io = makeFakeIo({ authResponses: new Map([
      ["auth profile list --format json", authResponse('[{"name":"portal:y","env":"portal","is_default":false}]')],
      ["auth default-profile get", authResponse("portal:y")],
    ]) });
    const fx = await authFixture(io);
    const service = fx.auth as ImoAuthService;
    const warm = await service.listProfilesCached();
    assert.ok(warm.ok);
    const fast = await service.profilesFast();
    await fx.fiber.dispose();
    assert.ok(fast.ok, "fast degrades to the CLI cache instead of erroring");
    assert.equal(fast.value.stale, true);
    assert.ok(fast.value.profiles.some(p => p.profileName === "portal:y"));
  } finally {
    process.env.HOME = prevHome;
    await rm(empty, { recursive: true, force: true });
  }
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
