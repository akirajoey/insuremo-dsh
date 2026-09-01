import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ImoInstallService, IMO_PACKAGE, IMO_REGISTRY, IMO_REGISTRY_SCOPE } from "../src/imo-install.ts";
import { ImoCliService } from "../src/index.ts";
import { fakeOperationLog, fakeSubprocess, makeFakeIo } from "./support/fake-subprocess.ts";

async function installFixture(overrides: Parameters<typeof makeFakeIo>[0] = {}, config: { installTimeoutMs?: number } = {}) {
  const io = makeFakeIo(overrides);
  const ctx = new Context();
  const fake = fakeSubprocess(io);
  const opLog = fakeOperationLog();
  ctx.provide("subprocess", fake as never);
  ctx.provide("operationLog", opLog.api as never);
  const cliFiber = ctx.plugin(ImoCliService, { command: "imo", timeoutMs: 5_000 });
  await cliFiber.await();
  const installFiber = ctx.plugin(ImoInstallService, config);
  await installFiber.await();
  const install = ctx.get("imoInstall");
  if (install === undefined) throw new Error("imoInstall service was not provided");
  return {
    install,
    io,
    opLog,
    ctx,
    dispose: async () => {
      await installFiber.dispose();
      await cliFiber.dispose();
    },
  };
}

test("npm path installs globally, probes after, and returns a completed digest-only receipt", async () => {
  const fx = await installFixture({ missingCommands: ["imo"] });
  try {
    const result = await fx.install.install();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const receipt = result.receipt;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.packageManager, "npm");
    assert.equal(receipt.before, null);
    assert.equal(receipt.after, "0.2.14");
    assert.equal(receipt.registryConfigured, true);
    assert.equal(receipt.steps.length, 2);
    assert.equal(receipt.steps[0]?.ok, true);
    assert.equal(receipt.steps[1]?.ok, true);
    for (const entry of receipt.steps) {
      assert.match(entry.stdoutDigest, /^sha256:/);
      assert.match(entry.stderrDigest, /^sha256:/);
    }
    // The spawned argv uses the fixed registry/package constants (arguments,
    // never shell); no client-supplied values exist.
    assert.deepEqual(fx.io.invocations[0], ["config", "set", IMO_REGISTRY_SCOPE, IMO_REGISTRY]);
    assert.deepEqual(fx.io.invocations[1], ["install", "-g", IMO_PACKAGE]);
    assert.equal(IMO_REGISTRY.startsWith("https://"), true);
    // Durable journal: appended, auto-decided, result recorded.
    const records = [...fx.opLog.records.values()];
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "imo-install");
    assert.match(String(records[0]?.resultDigest ?? ""), /^sha256:/);
    assert.equal(String(records[0]?.decision), "approved");
  } finally {
    await fx.dispose();
  }
});

test("pnpm is the fallback when npm is missing", async () => {
  const fx = await installFixture({ missingCommands: ["imo", "npm"] });
  try {
    const result = await fx.install.install();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.packageManager, "pnpm");
    assert.deepEqual(fx.io.invocations[1], ["add", "-g", IMO_PACKAGE]);
    assert.match(result.receipt.recovery, /pnpm remove -g/);
  } finally {
    await fx.dispose();
  }
});

test("without any package manager the structured no-package-manager error fires", async () => {
  const fx = await installFixture({ missingCommands: ["imo", "npm", "pnpm"] });
  try {
    const result = await fx.install.install();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "no-package-manager");
    assert.equal(fx.io.invocations.length, 0);
    assert.equal(fx.opLog.records.size, 0);
  } finally {
    await fx.dispose();
  }
});

test("an available imo short-circuits with already-installed and spawns nothing", async () => {
  const fx = await installFixture({});
  try {
    const result = await fx.install.install();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "already-installed");
    assert.match(result.error.message, /already installed/);
    // Only the read-only probe/version pair ran (no install argv).
    assert.deepEqual(fx.io.invocations, [["--version"]]);
  } finally {
    await fx.dispose();
  }
});

test("a second install while running is busy and the lock releases afterwards", async () => {
  const fx = await installFixture({ missingCommands: ["imo"], pendingKey: "install -g @insuremo/imo" }, { installTimeoutMs: 300 });
  try {
    const first = fx.install.install();
    const second = await fx.install.install();
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "busy");
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    if (firstResult.ok) {
      assert.equal(firstResult.receipt.status, "failed");
      assert.equal(firstResult.receipt.after, null);
      assert.equal(firstResult.receipt.registryConfigured, true);
      assert.match(firstResult.receipt.note, /[Ii]dempotent/);
    }
    assert.equal(fx.install.installStatus().running, false);
  } finally {
    await fx.dispose();
  }
});

test("a failed global install records a failed receipt with the retry note", async () => {
  const fx = await installFixture({ missingCommands: ["imo"], installExitCode: 7 });
  try {
    const result = await fx.install.install();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.receipt.exitCode, 7);
    assert.equal(result.receipt.after, null);
    assert.equal(result.receipt.registryConfigured, true);
    assert.match(result.receipt.note, /registry.*\.npmrc|@insuremo:registry/);
    assert.equal(fx.io.version, "0.2.14");
  } finally {
    await fx.dispose();
  }
});

test("completion and failure events carry operation metadata", async () => {
  const seen: Array<{ name: string; payload: { status?: string; after?: string | null; operationId?: string } }> = [];
  const fx = await installFixture({ missingCommands: ["imo"] });
  try {
    fx.ctx.on("imo/install-completed", (payload: { status?: string; after?: string | null; operationId?: string }) => { seen.push({ name: "completed", payload }); });
    const result = await fx.install.install();
    assert.equal(result.ok, true);
    await Promise.resolve();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.name, "completed");
    assert.equal(seen[0]?.payload.status, "completed");
    assert.equal(seen[0]?.payload.after, "0.2.14");
    assert.match(String(seen[0]?.payload.operationId ?? ""), /^imo-install:/);
  } finally {
    await fx.dispose();
  }
  const failed = await installFixture({ missingCommands: ["imo"], installExitCode: 7 });
  try {
    failed.ctx.on("imo/install-failed", (payload: { status?: string }) => { seen.push({ name: "failed", payload }); });
    await failed.install.install();
    await Promise.resolve();
    assert.equal(seen[1]?.name, "failed");
    assert.equal(seen[1]?.payload.status, "failed");
  } finally {
    await failed.dispose();
  }
});
