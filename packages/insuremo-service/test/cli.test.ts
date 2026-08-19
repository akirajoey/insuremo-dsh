import assert from "node:assert/strict";
import { test } from "node:test";
import { cliFixture, fakeHandle, fakeSubprocess, makeFakeIo, expectOk } from "./support/fake-subprocess.ts";

test("probe resolves an executable without spawning a process", async () => {
  const fake = fakeSubprocess(makeFakeIo());
  const fixture = await cliFixture(fake);
  try {
    const value = await expectOk(await fixture.service.probe());
    assert.deepEqual(value, { command: "imo", executablePath: "/opt/homebrew/bin/imo" });
    assert.equal(fake.spawns.length, 0);
  } finally {
    await fixture.dispose();
  }
});

test("probe returns a structured not-found error", async () => {
  const fake = fakeSubprocess(makeFakeIo());
  fake.resolveExecutable = async () => { throw new Error("missing executable"); };
  const fixture = await cliFixture(fake);
  try {
    const result = await fixture.service.probe();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not-found");
  } finally {
    await fixture.dispose();
  }
});

test("version parses a semantic version and returns only a stdout digest", async () => {
  const io = makeFakeIo();
  const fake = fakeSubprocess(io);
  const fixture = await cliFixture(fake);
  try {
    const value = await expectOk(await fixture.service.version());
    assert.equal(value.currentVersion, "0.2.14");
    assert.match(value.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal("stdout" in value, false);
    assert.deepEqual(fake.spawns[0]?.argv.slice(1), ["--version"]);
  } finally {
    await fixture.dispose();
  }
});

test("upgradeCheck parses an available update", async () => {
  const io = makeFakeIo();
  const fake = fakeSubprocess(io);
  // The fake prints the same shape the real CLI does for the --check read.
  const original = fake.spawn;
  fake.spawn = (spec) => {
    const args = [...spec.argv.slice(1)];
    if (args[0] === "upgrade" && args[1] === "--check") {
      io.invocations.push(args);
      const text = "Current version: v0.2.14\nNew version available: v0.2.17 (current: v0.2.14)\n";
      return fakeHandle({ stdout: text, stderr: "", exitCode: 0 }, spec.signal);
    }
    return original(spec);
  };
  const fixture = await cliFixture(fake);
  try {
    const value = await expectOk(await fixture.service.upgradeCheck());
    assert.equal(value.currentVersion, "0.2.14");
    assert.equal(value.targetVersion, "0.2.17");
    assert.equal(value.updateAvailable, true);
    assert.deepEqual(io.invocations[0], ["upgrade", "--check"]);
  } finally {
    await fixture.dispose();
  }
});

test("upgradeCheck recognizes an up-to-date CLI", async () => {
  const io = makeFakeIo();
  const fake = fakeSubprocess(io);
  const original = fake.spawn;
  fake.spawn = (spec) => {
    const args = [...spec.argv.slice(1)];
    if (args[0] === "upgrade" && args[1] === "--check") {
      io.invocations.push(args);
      return fakeHandle({ stdout: "Current version: v0.2.17\nAlready up to date.\n", stderr: "", exitCode: 0 }, spec.signal);
    }
    return original(spec);
  };
  const fixture = await cliFixture(fake);
  try {
    const value = await expectOk(await fixture.service.upgradeCheck());
    assert.equal(value.currentVersion, "0.2.17");
    assert.equal(value.targetVersion, "0.2.17");
    assert.equal(value.updateAvailable, false);
  } finally {
    await fixture.dispose();
  }
});

test("non-zero CLI exit is returned as a structured failure", async () => {
  const io = makeFakeIo({ upgradeExitCode: 7 });
  const fake = fakeSubprocess(io);
  const fixture = await cliFixture(fake);
  try {
    const result = await fixture.service.upgradeCheck();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "non-zero-exit");
      assert.equal(result.error.exitCode, 7);
    }
  } finally {
    await fixture.dispose();
  }
});

test("timeout aborts a pending process and returns a timeout error", async () => {
  const io = makeFakeIo({ pendingKey: "--version" });
  const fake = fakeSubprocess(io);
  const fixture = await cliFixture(fake, { timeoutMs: 10 });
  try {
    const result = await fixture.service.version();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "timeout");
  } finally {
    await fixture.dispose();
  }
});

test("caller cancellation returns a cancellation error", async () => {
  const io = makeFakeIo({ pendingKey: "--version" });
  const fake = fakeSubprocess(io);
  const fixture = await cliFixture(fake, { timeoutMs: 5_000 });
  try {
    const controller = new AbortController();
    const promise = fixture.service.version(controller.signal);
    controller.abort(new Error("caller left"));
    const result = await promise;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "cancelled");
  } finally {
    await fixture.dispose();
  }
});

test("the service leaves environment forwarding to the subprocess scrubber", async () => {
  const io = makeFakeIo();
  const fake = fakeSubprocess(io);
  const fixture = await cliFixture(fake);
  try {
    await fixture.service.version();
    assert.equal(fake.resolves[0]?.env, undefined);
    assert.equal(fake.spawns[0]?.env, undefined);
  } finally {
    await fixture.dispose();
  }
});

