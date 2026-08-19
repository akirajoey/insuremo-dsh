import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { authFixture, authResponse, expectAuthOk, fakeSubprocess, makeFakeIo } from "./support/fake-subprocess.ts";
import { runCapture } from "../src/run.ts";

test("auth invalidation revokes every old lease for the matching cache key", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --profile portal:demo --json", authResponse(JSON.stringify({ profile_name: "portal:demo", access_token: "revoke-token" }))],
  ]) });
  const fx = await authFixture(io);
  try {
    const first = await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo" }));
    const second = await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo" }));
    fx.auth.invalidate({ profile: "portal:demo", reason: "manual" });
    for (const lease of [first, second]) {
      await assert.rejects(lease.use(() => "unreachable"), (error: unknown) => (
        typeof error === "object" && error !== null && "code" in error && error.code === "lease-revoked"
      ));
    }
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth invalidation cannot erase a token already handed to a running callback", async () => {
  const canary = ["running", "callback", "token", "canary"].join("_");
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --profile portal:demo --json", authResponse(JSON.stringify({ profile_name: "portal:demo", access_token: canary }))],
  ]) });
  const fx = await authFixture(io);
  let startedResolve!: () => void;
  let releaseResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  try {
    const lease = await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo" }));
    const running = lease.use(async (secret) => {
      startedResolve();
      await release;
      return secret.accessToken;
    });
    await started;
    fx.auth.invalidate({ profile: "portal:demo", reason: "unauthorized" });
    await assert.rejects(lease.use(() => "unreachable"), (error: unknown) => (
      typeof error === "object" && error !== null && "code" in error && error.code === "lease-revoked"
    ));
    releaseResolve();
    assert.equal(await running, canary);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth disposal revokes an old lease and rejects new prepares without spawning", async () => {
  const key = "auth prepare --profile portal:demo --json";
  const io = makeFakeIo({ authResponses: new Map([
    [key, authResponse(JSON.stringify({ profile_name: "portal:demo", access_token: "dispose-revoke-token" }))],
  ]) });
  const fx = await authFixture(io);
  const lease = await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo" }));
  await fx.fiber.dispose();
  await assert.rejects(lease.use(() => "unreachable"), (error: unknown) => (
    typeof error === "object" && error !== null && "code" in error && error.code === "lease-revoked"
  ));
  const count = io.invocations.filter((args) => args.join(" ") === key).length;
  const result = await fx.auth.prepare({ profile: "portal:demo" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "service-disposed");
  assert.equal(io.invocations.filter((args) => args.join(" ") === key).length, count);
});

test("auth disposal settles an in-flight prepare as service-disposed without a lease", async () => {
  const key = "auth prepare --profile portal:demo --json";
  const io = makeFakeIo({
    pendingKey: key,
    authResponses: new Map([[key, authResponse(JSON.stringify({ access_token: "pending-dispose-token" }))]]),
  });
  const fx = await authFixture(io);
  const pending = fx.auth.prepare({ profile: "portal:demo" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(io.pendingHandles.length, 1);
  await fx.fiber.dispose();
  io.pendingHandles[0]!.terminate();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "service-disposed");
  assert.equal(fx.auth.cacheStatus().size, 0);
});

test("auth invalidation settles an in-flight prepare as prepare-invalidated", async () => {
  const key = "auth prepare --profile portal:demo --json";
  const io = makeFakeIo({
    pendingKey: key,
    authResponses: new Map([[key, authResponse(JSON.stringify({ access_token: "pending-invalidated-token" }))]]),
  });
  const fx = await authFixture(io);
  try {
    const pending = fx.auth.prepare({ profile: "portal:demo" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    fx.auth.invalidate({ profile: "portal:demo", reason: "profile-changed" });
    io.pendingHandles[0]!.terminate();
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "prepare-invalidated");
    assert.equal(fx.auth.cacheStatus().size, 0);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth internals are absent from service reflection", async () => {
  const canary = ["reflection", "token", "canary"].join("_");
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --profile portal:demo --json", authResponse(JSON.stringify({ profile_name: "portal:demo", access_token: canary }))],
  ]) });
  const fx = await authFixture(io);
  try {
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo" }));
    const keys = Reflect.ownKeys(fx.auth).map(String);
    for (const forbidden of ["cache", "inflight", "pendingMeta", "generations", "disposed", "epoch", canary]) {
      assert.equal(keys.includes(forbidden), false);
    }
    assert.equal(inspect(fx.auth).includes(canary), false);
  } finally {
    await fx.fiber.dispose();
  }
});

test("runCapture returns only allowlisted failure fields and no raw stream symbol", async () => {
  const canary = ["runner", "raw", "token", "canary"].join("_");
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --json", authResponse("", 1, canary)],
  ]) });
  const fake = fakeSubprocess(io);
  const result = await runCapture(fake, { command: "imo", args: ["auth", "prepare", "--json"], timeoutMs: 5_000 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const keys = Reflect.ownKeys(result.error).map(String);
    assert.equal(keys.includes("stdout"), false);
    assert.equal(keys.some((key) => key.includes("RUN_FAILURE")), false);
    assert.equal(JSON.stringify(result.error).includes(canary), false);
    assert.equal(result.error.httpStatus, undefined);
  }
});
