import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOverview, type OverviewDependencies } from "../src/overview/snapshot.ts";
import type { ImoCli } from "../src/cli.ts";
import type { ImoAuth } from "../src/auth/types.ts";
import type { ImoSkills } from "../src/skills.ts";
import type { ImoSkillActivation } from "../src/skill-activation.ts";
import type { OperationLogLike } from "../src/operation-log-face.ts";

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function error(code: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message: code } };
}

function fakeDeps(over: Partial<OverviewDependencies> = {}): OverviewDependencies {
  const imoCli = {
    probe: async () => ok({ command: "imo", executablePath: "/opt/homebrew/bin/imo" }),
    version: async () => ok({ executablePath: "imo", currentVersion: "0.2.17", stdoutDigest: "sha256:x" }),
    upgradeCheck: async () => ok({ executablePath: "imo", currentVersion: "0.2.17", targetVersion: "0.2.18", updateAvailable: true, stdoutDigest: "sha256:y" }),
  } as unknown as ImoCli;
  const imoAuth = {
    listProfiles: async () => ok({
      profiles: [
        { profileName: "dev", env: "portal", tenantCode: "tenant-1", isDefault: true, valid: true },
      ],
      stdoutDigest: "sha256:a",
    }),
    defaultProfile: async () => ok({ profileName: "dev", stdoutDigest: "sha256:b" }),
  } as unknown as ImoAuth;
  const imoSkills = {
    list: async () => ok({ scope: "global", skills: [{ name: "alpha", description: "Alpha", path: "/home/user/.agents/skills/alpha" }], stdoutDigest: "sha256:c" }),
    validate: async () => ok({ scope: "global", inventoryComplete: true, items: [{ name: "alpha", description: "Alpha", path: "/home/user/.agents/skills/alpha", valid: true, reasons: [] }], checkedAt: "now" }),
  } as unknown as ImoSkills;
  const imoSkillActivation = {
    snapshot: async () => ({ initialized: true, installed: ["alpha"], enabled: ["alpha"], disabled: [], stale: [], revision: 1 }),
  } as unknown as ImoSkillActivation;
  const operationLog = {
    list: () => [
      { id: "op-1", kind: "imo-upgrade", decision: "pending", createdAt: "2026-01-01T00:00:00Z" },
      { id: "op-2", kind: "skill-install", decision: "approved", resultDigest: "sha256:r", createdAt: "2026-01-02T00:00:00Z" },
      { id: "op-3", kind: "auth-login", decision: "rejected", createdAt: "2026-01-03T00:00:00Z" },
    ],
  } as unknown as OperationLogLike;
  return { imoCli, imoAuth, imoSkills, imoSkillActivation, operationLog, ...over };
}

test("overview aggregates every section into an allowlist view", async () => {
  const view = await buildOverview(fakeDeps());
  assert.equal(view.schemaVersion, "0");
  assert.equal(view.imo.available, true);
  assert.equal(view.imo.current, "0.2.17");
  assert.equal(view.imo.target, "0.2.18");
  assert.equal(view.imo.updateAvailable, true);
  assert.equal(view.imo.status, "warning");
  assert.deepEqual(view.auth.profiles[0], { name: "dev", env: "portal", tenantCode: "tenant-1", isDefault: true, valid: true });
  assert.equal(view.auth.defaultProfile, "dev");
  assert.equal(view.auth.count, 1);
  assert.deepEqual(view.skills.names, ["alpha"]);
  assert.equal(view.skills.installed, 1);
  assert.equal(view.skills.enabled, 1);
  assert.equal(view.operations.pending, 1);
  assert.equal(view.operations.approved, 1);
  assert.equal(view.operations.rejected, 1);
  assert.equal(view.operations.recorded, 1);
  assert.equal(view.operations.recent.length, 3);
  const text = JSON.stringify(view);
  assert.equal(text.includes("access_token"), false);
  assert.equal(text.includes("/home/user"), false);
  assert.equal(text.includes("SKILL.md"), false);
  assert.equal(text.includes("paramsDigest"), false);
});

test("partial failure sections degrade to fixed codes and never leak secrets", async () => {
  const deps = fakeDeps({
    imoCli: {
      probe: async () => error("not-found"),
      version: async () => error("not-found"),
      upgradeCheck: async () => error("not-found"),
    } as unknown as ImoCli,
    imoAuth: {
      listProfiles: async () => ok({
        profiles: [{ profileName: "dev", access_token: "SECRETTOKEN", env: "portal" } as never],
        stdoutDigest: "sha256:d",
      }),
      defaultProfile: async () => error("unavailable"),
    } as unknown as ImoAuth,
    imoSkills: {
      list: async () => ok({ scope: "global", skills: [{ name: "alpha", description: "Alpha", path: "/secret/path" }], stdoutDigest: "sha256:e" }),
      validate: async () => ok({ scope: "global", inventoryComplete: false, items: [], checkedAt: "now" }),
    } as unknown as ImoSkills,
  });
  const view = await buildOverview(deps);
  assert.equal(view.imo.available, false);
  assert.equal(view.imo.status, "error");
  assert.equal(view.imo.code, "not-found");
  assert.deepEqual(view.auth.profiles[0], { name: "dev", env: "portal", isDefault: false });
  assert.equal(view.skills.status, "warning");
  assert.equal(view.diagnostics.diagnostics.some(d => d.id === "imo-unavailable"), true);
  assert.equal(view.diagnostics.diagnostics.some(d => d.id === "auth-no-default"), true);
  const text = JSON.stringify(view);
  assert.equal(text.includes("SECRETTOKEN"), false);
  assert.equal(text.includes("access_token"), false);
  assert.equal(text.includes("/secret/path"), false);
});
