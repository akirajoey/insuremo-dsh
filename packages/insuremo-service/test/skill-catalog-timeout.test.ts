import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { resolveConfig, type Config } from "../src/config.ts";
import { failureDiagnosis } from "../src/diagnosis.ts";
import { ImoSkillActionsService } from "../src/skill-actions/service.ts";
import { fakeHandle } from "./support/fake-subprocess.ts";

const CATALOG = [
  "T  skills",
  "o  Source: https://gitlab.insuremo.com/insuremo-public/insuremo-skills.git",
  "o  Git host unreachable — using npm registry (@insuremo/skills)",
  "o  Fetching skills from npm registry...",
  "o  Package resolved: @insuremo/skills@1.2.3",
  "o  Found 1 skill",
  "!  Available Skills",
  "General",
  "|    timeout-fixture",
  "|      A slow npm fallback catalog",
  "|  Use --skill <name> to install specific skills",
].join("\n");

async function openCatalog(config: Partial<Config> = {}) {
  const ctx = new Context();
  const spawns: SubprocessSpawnSpec[] = [];
  const handles: SubprocessHandle[] = [];
  ctx.provide("subprocess", {
    resolveExecutable: async () => "/fixture/npx",
    spawn(spec: SubprocessSpawnSpec) {
      spawns.push(spec);
      const handle = fakeHandle({ stdout: CATALOG, stderr: "", exitCode: 0, pending: true }, spec.signal);
      handles.push(handle);
      return handle;
    },
  } as unknown as SubprocessRuntime);
  // Catalog discovery needs none of the inventory/mutation faces.
  ctx.provide("imoSkills", {} as never);
  ctx.provide("imoSkillActivation", {} as never);
  ctx.provide("operationLog", {} as never);
  const fiber = ctx.plugin(ImoSkillActionsService, config);
  await fiber.await();
  const actions = ctx.get("imoSkillActions")!;
  return { actions, spawns, handles, dispose: () => fiber.dispose() };
}

async function untilSpawned(spawns: readonly SubprocessSpawnSpec[]) {
  for (let turn = 0; turn < 20 && spawns.length === 0; turn += 1) await Promise.resolve();
  assert.equal(spawns.length, 1);
}

test("catalog npm fallback can complete after 15 seconds within the default operation budget", async t => {
  const fx = await openCatalog();
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = fx.actions.refreshCatalog();
    await untilSpawned(fx.spawns);
    t.mock.timers.tick(16_000);
    assert.equal(fx.spawns[0]!.signal?.aborted, false);
    fx.handles[0]!.terminate();
    const result = await pending;
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.entries.some(entry => entry.name === "timeout-fixture"), true);
  } finally {
    await fx.dispose();
  }
});

test("catalog honors a user-configured operation budget above 15 seconds and still times out", async t => {
  const fx = await openCatalog({ skillActionTimeoutMs: 120_000 });
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = fx.actions.refreshCatalog();
    await untilSpawned(fx.spawns);
    t.mock.timers.tick(119_999);
    assert.equal(fx.spawns[0]!.signal?.aborted, false);
    t.mock.timers.tick(1);
    assert.equal((await pending).ok, false);
    assert.equal(fx.spawns[0]!.signal?.aborted, true);
    assert.equal(failureDiagnosis.snapshot("skill")?.error?.code, "timeout");
  } finally {
    await fx.dispose();
  }
});

test("catalog remains cancellable before its configured deadline", async () => {
  const fx = await openCatalog({ skillActionTimeoutMs: 120_000 });
  try {
    const controller = new AbortController();
    const pending = fx.actions.refreshCatalog(controller.signal);
    await untilSpawned(fx.spawns);
    controller.abort();
    assert.equal((await pending).ok, false);
    assert.equal(fx.spawns[0]!.signal?.aborted, true);
  } finally {
    await fx.dispose();
  }
});

test("Skills operation timeout keeps its existing 180s default and 300s safety ceiling", () => {
  assert.equal(resolveConfig().skillActionTimeoutMs, 180_000);
  assert.equal(resolveConfig({ skillActionTimeoutMs: 240_000 }).skillActionTimeoutMs, 240_000);
  assert.equal(resolveConfig({ skillActionTimeoutMs: 600_000 }).skillActionTimeoutMs, 300_000);
});
