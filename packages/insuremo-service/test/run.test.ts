import assert from "node:assert/strict";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import { test } from "node:test";
import { runCapture } from "../src/run.ts";
import {
  cliFixture,
  fakeHandle,
  fakeSubprocess,
  makeFakeIo,
  skillsFixture,
} from "./support/fake-subprocess.ts";

function options(signal?: AbortSignal) {
  return { command: "imo", args: ["--version"], timeoutMs: 25, signal };
}

function rejectingRuntime(cause: string) {
  const fake = fakeSubprocess(makeFakeIo());
  fake.spawn = (spec) => {
    const base = fakeHandle({ stdout: "", stderr: "", exitCode: null, pending: true }, spec.signal);
    return { ...base, done: Promise.reject(new Error(cause)) } as SubprocessHandle;
  };
  return fake;
}

function abortRejectingRuntime(cause: string) {
  const fake = fakeSubprocess(makeFakeIo());
  fake.spawn = (spec) => {
    const base = fakeHandle({ stdout: "", stderr: "", exitCode: null, pending: true }, spec.signal);
    const done = new Promise<never>((_resolve, reject) => {
      const rejectOnAbort = (): void => reject(new Error(cause));
      if (spec.signal?.aborted) rejectOnAbort();
      else spec.signal?.addEventListener("abort", rejectOnAbort, { once: true });
    });
    return { ...base, done } as SubprocessHandle;
  };
  return fake;
}

function assertNoCause(
  result: Awaited<ReturnType<typeof runCapture>>,
  canary: string,
): asserts result is Extract<Awaited<ReturnType<typeof runCapture>>, { ok: false }> {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(JSON.stringify(result.error).includes(canary), false);
  assert.equal(Reflect.ownKeys(result.error).includes("cause"), false);
}

test("runCapture spawn exceptions use a fixed failure message", async () => {
  const canary = ["spawn", "cause", "401", "canary"].join("_");
  const fake = fakeSubprocess(makeFakeIo());
  fake.spawn = () => { throw new Error(canary); };
  const result = await runCapture(fake, options());
  assertNoCause(result, canary);
  if (!result.ok) {
    assert.equal(result.error.code, "spawn-failed");
    assert.equal(result.error.message, "IMO CLI process could not be started");
    assert.equal(result.error.httpStatus, undefined);
  }
});

test("runCapture handle.done rejection does not expose its cause", async () => {
  const canary = ["done", "rejected", "stack", "canary"].join("_");
  const result = await runCapture(rejectingRuntime(canary), options());
  assertNoCause(result, canary);
  if (!result.ok) {
    assert.equal(result.error.code, "spawn-failed");
    assert.equal(result.error.message, "IMO CLI process failed");
  }
});

test("parent abort reasons never cross the runCapture error boundary", async () => {
  const canary = ["parent", "abort", "reason", "canary"].join("_");
  const controller = new AbortController();
  controller.abort(new Error(canary));
  const result = await runCapture(fakeSubprocess(makeFakeIo()), options(controller.signal));
  assertNoCause(result, canary);
  if (!result.ok) {
    assert.equal(result.error.code, "cancelled");
    assert.equal(result.error.message, "IMO CLI operation was cancelled");
  }
});

test("timeout reasons never cross a rejecting handle.done boundary", async () => {
  const canary = ["timeout", "reason", "secret", "canary"].join("_");
  const result = await runCapture(abortRejectingRuntime(canary), options());
  assertNoCause(result, canary);
  if (!result.ok) {
    assert.equal(result.error.code, "timeout");
    assert.equal(result.error.message, "IMO CLI operation timed out");
  }
});

test("401/403 text in a rejection cause cannot create HTTP classification", async () => {
  const canary = ["transport", "401", "forbidden", "403", "canary"].join("_");
  const result = await runCapture(rejectingRuntime(canary), options());
  assertNoCause(result, canary);
  if (!result.ok) {
    assert.equal(result.error.code, "spawn-failed");
    assert.equal(result.error.httpStatus, undefined);
  }
});

test("CLI version and Skills list public errors do not expose runner causes", async () => {
  const canary = ["public", "runner", "cause", "canary"].join("_");

  const cliFake = fakeSubprocess(makeFakeIo());
  cliFake.spawn = () => { throw new Error(canary); };
  const cli = await cliFixture(cliFake);
  try {
    const result = await cli.service.version();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "spawn-failed");
      assert.equal(result.error.message, "IMO CLI process could not be started");
      assert.equal(JSON.stringify(result.error).includes(canary), false);
    }
  } finally {
    await cli.dispose();
  }

  const skillsIo = makeFakeIo();
  const skillsFake = fakeSubprocess(skillsIo);
  skillsFake.spawn = () => { throw new Error(canary); };
  const skills = await skillsFixture(skillsIo, {}, undefined, skillsFake);
  try {
    const result = await skills.skills.list();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "spawn-failed");
      assert.equal(result.error.message, "IMO CLI process could not be started");
      assert.equal(JSON.stringify(result.error).includes(canary), false);
    }
  } finally {
    await skills.dispose();
  }
});
