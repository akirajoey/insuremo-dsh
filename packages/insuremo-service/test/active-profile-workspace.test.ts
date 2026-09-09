import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { ImoActiveProfileService } from "../src/active-profile.ts";

async function mount(directory: string, workspacePath: string) {
  const ctx = new Context();
  let currentWorkspacePath = workspacePath;
  const storage = new Storage(ctx);
  storage.backend.register("json", new JsonStorageBackend(directory));
  ctx.provide("storageDomain" as never, new DomainFacility(ctx, { backend: "json" }) as never);
  const calls: Array<{ method: string; workspaceId?: string | null }> = [];
  const profiles = [
    { profileName: "global-profile", scope: "global" },
    { profileName: "workspace-profile", scope: "workspace" },
  ];
  const auth = {
    profilesFast: async (_signal?: AbortSignal, workspaceId?: string | null) => {
      calls.push({ method: "profilesFast", workspaceId });
      return { ok: true as const, value: { profiles, defaultProfile: workspaceId === undefined ? "global-profile" : "workspace-profile", stale: false } };
    },
    listProfiles: async (_signal?: AbortSignal, workspaceId?: string | null) => {
      calls.push({ method: "listProfiles", workspaceId });
      return { ok: true as const, value: { profiles, stdoutDigest: "sha256:list" } };
    },
    listProfilesCached: async (_signal?: AbortSignal, workspaceId?: string | null) => {
      calls.push({ method: "listProfilesCached", workspaceId });
      return { ok: true as const, value: { profiles, stdoutDigest: "sha256:cached" } };
    },
  };
  ctx.provide("imoAuth" as never, auth as never);
  ctx.provide("workspaceRegistry" as never, {
    get(id: string) {
      return id === "workspace-a" ? { id, path: currentWorkspacePath } : undefined;
    },
  } as never);
  const fiber = ctx.plugin(ImoActiveProfileService as never);
  await fiber.await();
  return {
    service: ctx.get("imoActiveProfile" as never) as unknown as ImoActiveProfileService,
    fiber,
    calls,
    setWorkspacePath: (path: string) => { currentWorkspacePath = path; },
  };
}

test("workspace Active Profile keys are isolated and global-source rows do not change other scopes", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "task094-active-workspace-store-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "task094-active-workspace-path-"));
  try {
    const fx = await mount(storageRoot, workspacePath);
    try {
      const globalBoot = await fx.service.get();
      assert.equal(globalBoot.ok && globalBoot.value.activeProfileName, "global-profile");
      const workspaceBootstrap = await fx.service.get(undefined, "workspace-a");
      assert.equal(workspaceBootstrap.ok && workspaceBootstrap.value.activeProfileName, "workspace-profile");
      const selected = await fx.service.select("workspace-profile", undefined, "workspace-a");
      assert.equal(selected.ok && selected.value.activeProfileName, "workspace-profile");
      const global = await fx.service.get();
      assert.equal(global.ok && global.value.activeProfileName, "global-profile");
      const workspace = await fx.service.get(undefined, "workspace-a");
      assert.equal(workspace.ok && workspace.value.activeProfileName, "workspace-profile");
      const globalSource = await fx.service.select("global-profile", undefined, "workspace-a");
      assert.equal(globalSource.ok && globalSource.value.profile?.scope, "global");
      const globalAfterSourceSelection = await fx.service.get();
      assert.equal(globalAfterSourceSelection.ok && globalAfterSourceSelection.value.activeProfileName, "global-profile");
      fx.setWorkspacePath(`${workspacePath}-replaced`);
      const staleWorkspace = await fx.service.get(undefined, "workspace-a");
      assert.equal(staleWorkspace.ok, false);
      if (!staleWorkspace.ok) assert.equal(staleWorkspace.error.code, "workspace-unavailable");
      fx.setWorkspacePath(workspacePath);
      const unknownWorkspace = await fx.service.get(undefined, "workspace-missing");
      assert.equal(unknownWorkspace.ok, false);
      if (!unknownWorkspace.ok) assert.equal(unknownWorkspace.error.code, "workspace-not-found");
      assert.ok(fx.calls.some(call => call.method === "listProfiles" && call.workspaceId === "workspace-a"));

      const files = await readdir(storageRoot, { recursive: true });
      const persisted = (await Promise.all(files.filter(file => typeof file === "string").map(file => readFile(join(storageRoot, file), "utf8").catch(() => "")))).join("\n");
      assert.equal(persisted.includes(workspacePath), false);
      assert.equal(persisted.includes("global-profile"), true);
      assert.equal(persisted.includes("workspace:workspace-a"), true);
    } finally {
      await fx.fiber.dispose();
    }
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  }
});
