import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ImoAuthService } from "../src/auth/service.ts";
import { fakeSubprocess, makeFakeIo, authResponse } from "./support/fake-subprocess.ts";

const LIST_KEY = "auth profile list --format json";
const VALIDATE_KEY = "auth profile validate --profile project-profile --json";
const PREPARE_PROJECT_KEY = "auth prepare --profile project-profile --json";
const PREPARE_GLOBAL_KEY = "auth prepare --profile global-profile --json";

async function mountAuth(workspacePath: string) {
  const io = makeFakeIo({
    authResponses: new Map([
      [LIST_KEY, authResponse(JSON.stringify([
        { name: "global-profile", scope: "global", env: "portal" },
        { name: "project-profile", scope: "workspace", env: "portal" },
        { name: "project-second", scope: "workspace", env: "portal" },
      ]))],
      [VALIDATE_KEY, authResponse(JSON.stringify({ profile_name: "project-profile", valid: true, status: "valid" }))],
      [PREPARE_PROJECT_KEY, authResponse(JSON.stringify({ profile_name: "project-profile", access_token: "synthetic-project-token" }))],
      [PREPARE_GLOBAL_KEY, authResponse(JSON.stringify({ profile_name: "global-profile", access_token: "synthetic-global-token" }))],
    ]),
  });
  const ctx = new Context();
  const fake = fakeSubprocess(io);
  ctx.provide("subprocess", fake as never);
  ctx.provide("workspaceRegistry", {
    get(id: string) {
      return id === "workspace-a" ? { id, path: workspacePath } : undefined;
    },
  } as never);
  const fiber = ctx.plugin(ImoAuthService, { command: "imo", timeoutMs: 5_000 });
  await fiber.await();
  const auth = ctx.get("imoAuth") as unknown as ImoAuthService;
  return { io, fake, auth, fiber };
}

test("workspace auth reads use the trusted canonical cwd and project rows precede global rows", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "task094-auth-workspace-"));
  try {
    const fx = await mountAuth(workspacePath);
    try {
      const listed = await fx.auth.listProfiles(undefined, "workspace-a");
      assert.equal(listed.ok, true);
      if (!listed.ok) return;
      assert.deepEqual(listed.value.profiles.map(profile => [profile.profileName, profile.scope]), [
        ["project-profile", "workspace"],
        ["project-second", "workspace"],
        ["global-profile", "global"],
      ]);
      const listSpawn = fx.fake.spawns.find(spec => [...spec.argv].join(" ").includes(LIST_KEY));
      assert.equal(listSpawn?.cwd, workspacePath);
      assert.equal((await readdir(workspacePath)).includes(".insuremo"), false);

      const projectLease = await fx.auth.prepare({ profile: "project-profile", workspaceId: "workspace-a" });
      const globalLease = await fx.auth.prepare({ profile: "global-profile" });
      assert.equal(projectLease.ok, true);
      assert.equal(globalLease.ok, true);
      assert.equal(fx.auth.cacheStatus().size, 2);
      const prepareSpawns = fx.fake.spawns.filter(spec => [...spec.argv].join(" ").startsWith("/opt/homebrew/bin/imo auth prepare"));
      assert.equal(prepareSpawns.length, 2);
      assert.equal(prepareSpawns.find(spec => [...spec.argv].join(" ").includes("project-profile"))?.cwd, workspacePath);
      const globalCwd = prepareSpawns.find(spec => [...spec.argv].join(" ").includes("global-profile"))?.cwd;
      assert.ok(typeof globalCwd === "string");
      assert.notEqual(globalCwd, workspacePath);
      assert.equal((await readdir(globalCwd!)).includes(".insuremo"), false);
      assert.equal((await lstat(globalCwd!)).mode & 0o777, 0o700);

      const validated = await fx.auth.validate("project-profile", undefined, "workspace-a");
      assert.equal(validated.ok, true);
      const validateSpawn = fx.fake.spawns.find(spec => [...spec.argv].join(" ").includes(VALIDATE_KEY));
      assert.equal(validateSpawn?.cwd, workspacePath);

      const missing = await fx.auth.listProfiles(undefined, "workspace-missing");
      assert.equal(missing.ok, false);
      if (!missing.ok) assert.equal(missing.error.code, "workspace-not-found");
      assert.equal(fx.fake.spawns.filter(spec => [...spec.argv].join(" ").includes("workspace-missing")).length, 0);
    } finally {
      await fx.fiber.dispose();
      const globalCwd = fx.fake.spawns.find(spec => [...spec.argv].join(" ").includes("global-profile"))?.cwd;
      if (globalCwd !== undefined) await assert.rejects(lstat(globalCwd));
    }
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("workspace auth cache namespaces keep project and global prepares independent", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "task094-auth-cache-"));
  try {
    const fx = await mountAuth(workspacePath);
    try {
      const project = await fx.auth.prepare({ profile: "project-profile", workspaceId: "workspace-a" });
      const global = await fx.auth.prepare({ profile: "project-profile" });
      assert.equal(project.ok, true);
      assert.equal(global.ok, true);
      assert.equal(fx.fake.spawns.filter(spec => [...spec.argv].join(" ").includes("auth prepare --profile project-profile --json")).length, 2);
      const cwdValues = fx.fake.spawns
        .filter(spec => [...spec.argv].join(" ").includes("auth prepare --profile project-profile --json"))
        .map(spec => spec.cwd);
      assert.equal(cwdValues[0], workspacePath);
      assert.notEqual(cwdValues[0], cwdValues[1]);
      assert.equal(fx.auth.cacheStatus().size, 2);
    } finally {
      await fx.fiber.dispose();
    }
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
