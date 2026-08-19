import assert from "node:assert/strict";
import { test } from "node:test";
import { approveAndRun, makeFakeIo, upgradeFixture } from "./support/fake-subprocess.ts";

test("executeUpgrade rejects an unapproved operation without spawning", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const request = await fx.upgrade.requestUpgrade();
    const result = await fx.upgrade.executeUpgrade(request.operationId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not-approved");
    assert.equal(io.invocations.length, 0);
    assert.equal(fx.upgrade.upgradeStatus().running, false);
  } finally {
    await fx.dispose();
  }
});

test("executeUpgrade on a missing operation rejects without spawning", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const result = await fx.upgrade.executeUpgrade("does-not-exist");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "missing-operation");
    assert.equal(io.invocations.length, 0);
  } finally {
    await fx.dispose();
  }
});

test("approved execution succeeds with a complete digest-only receipt", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const { request, result } = await approveAndRun(fx);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const receipt = result.receipt;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.before, "0.2.14");
    assert.equal(receipt.after, "0.2.17");
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.smoke.length, 7);
    assert.ok(receipt.smoke.every((entry) => entry.ok));
    assert.match(receipt.smoke[0]?.cmd ?? "", /imo --version$/);
    assert.match(receipt.recovery, /0\.2\.14/);
    // Every smoke command prints a digest, never raw output.
    assert.ok(receipt.smoke.every((entry) => /^sha256:/.test(entry.stdoutDigest)));
    // The durable record carries the receipt digest.
    const record = fx.opLog.records.get(request.operationId);
    assert.match(String(record?.resultDigest ?? ""), /^sha256:/);
    assert.equal(fx.upgrade.upgradeStatus().running, false);
    // The upgrade actually ran against the fake: pre version, upgrade, then 7 smoke.
    assert.deepEqual(io.invocations[0], ["--version"]);
    assert.deepEqual(io.invocations[1], ["upgrade", "--yes"]);
    assert.equal(io.version, "0.2.17");
  } finally {
    await fx.dispose();
  }
});

test("an explicit target becomes the --version argument", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const request = await fx.upgrade.requestUpgrade("0.2.15");
    await fx.opLog.api.decide(request.operationId, true, "alice");
    const result = await fx.upgrade.executeUpgrade(request.operationId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.after, "0.2.15");
    assert.deepEqual(io.invocations[1], ["upgrade", "--version", "0.2.15", "--yes"]);
  } finally {
    await fx.dispose();
  }
});

test("a second execution while running returns busy and the lock releases", async () => {
  const io = makeFakeIo({ pendingKey: "upgrade --yes" });
  const fx = await upgradeFixture(io, { upgradeTimeoutMs: 300 });
  try {
    const request = await fx.upgrade.requestUpgrade();
    await fx.opLog.api.decide(request.operationId, true, "alice");
    const first = fx.upgrade.executeUpgrade(request.operationId);
    const second = await fx.upgrade.executeUpgrade(request.operationId);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "busy");
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    if (firstResult.ok) assert.equal(firstResult.receipt.status, "failed");
    assert.equal(fx.upgrade.upgradeStatus().running, false);
  } finally {
    await fx.dispose();
  }
});

test("a failed upgrade records a failed receipt with recovery and releases the lock", async () => {
  const io = makeFakeIo({ upgradeExitCode: 7 });
  const fx = await upgradeFixture(io);
  try {
    const { result } = await approveAndRun(fx);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.receipt.exitCode, 7);
    assert.equal(result.receipt.smoke.length, 0);
    assert.match(result.receipt.recovery, /恢复命令：imo upgrade --version 0\.2\.14 --yes/);
    assert.match(result.receipt.stderrDigest, /^sha256:/);
    assert.equal(fx.upgrade.upgradeStatus().running, false);
    assert.equal(io.version, "0.2.14");
  } finally {
    await fx.dispose();
  }
});

test("a partially failing smoke battery is recorded accurately", async () => {
  const io = makeFakeIo({ smokeFailures: new Map([["auth --help", 3]]) });
  const fx = await upgradeFixture(io);
  try {
    const { result } = await approveAndRun(fx);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "completed");
    const auth = result.receipt.smoke.find((entry) => entry.cmd === "imo auth --help");
    assert.equal(auth?.ok, false);
    assert.equal(auth?.exitCode, 3);
    assert.ok(result.receipt.smoke.filter((entry) => entry.ok).length >= 6);
  } finally {
    await fx.dispose();
  }
});

test("a completed operation cannot be executed again (already-executed)", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const { request, result } = await approveAndRun(fx);
    assert.equal(result.ok, true);
    const second = await fx.upgrade.executeUpgrade(request.operationId);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "already-executed");
  } finally {
    await fx.dispose();
  }
});

test("requestUpgrade appends a pending imo-upgrade record with a params digest", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const request = await fx.upgrade.requestUpgrade();
    const record = fx.opLog.records.get(request.operationId);
    assert.equal(record?.kind, "imo-upgrade");
    assert.equal(record?.decision, "pending");
    assert.match(String(record?.paramsDigest ?? ""), /^sha256:/);
    assert.equal(fx.upgrade.upgradeStatus().running, false);
  } finally {
    await fx.dispose();
  }
});

