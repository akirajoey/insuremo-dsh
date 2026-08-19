import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMO_AUTH_LOGIN_KIND,
  IMO_AUTH_REMOTE_KIND,
} from "../src/index.ts";
import {
  authActionsFixture,
  authResponse,
  expectAuthOk,
  makeFakeIo,
} from "./support/fake-subprocess.ts";

const optionLike = ["--", "insecure"].join("");
const envA = "aws_sg_insuremo_sandbox";
const envB = "aws_us_insuremo_sandbox";
const envKeyA = "complete --type env --profile portal:a";
const profileListKey = "auth profile list --format json";

async function approve(fx: Awaited<ReturnType<typeof authActionsFixture>>, operationId: string): Promise<void> {
  await fx.opLog.api.decide(operationId, true, "boundary-test");
}

async function operationId(result: { ok: boolean; value?: { operationId: string } }): Promise<string> {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("request failed");
  return result.value.operationId;
}

test("tampering an approved params digest blocks spawn", async () => {
  const io = makeFakeIo();
  const fx = await authActionsFixture(io);
  try {
    const id = await operationId(await fx.actions.requestPortalLogin());
    fx.opLog.records.get(id)!.paramsDigest = `sha256:${"0".repeat(64)}`;
    await approve(fx, id);
    const result = await fx.actions.executePortalLogin(id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "operation-params-mismatch");
    assert.equal(io.invocations.length, 0);
  } finally {
    await fx.dispose();
  }
});

test("swapping pending payload digests is rejected before spawn", async () => {
  const io = makeFakeIo();
  const fx = await authActionsFixture(io);
  try {
    const first = await operationId(await fx.actions.requestPortalLogin());
    const second = await operationId(await fx.actions.requestPortalLogin({ force: true }));
    fx.opLog.records.get(first)!.paramsDigest = fx.opLog.records.get(second)!.paramsDigest;
    await approve(fx, first);
    const result = await fx.actions.executePortalLogin(first);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "operation-params-mismatch");
    assert.equal(io.invocations.length, 0);
  } finally {
    await fx.dispose();
  }
});

test("cross-kind execution is an operation-params mismatch", async () => {
  const io = makeFakeIo();
  const fx = await authActionsFixture(io);
  try {
    const id = await operationId(await fx.actions.requestPortalLogin());
    await approve(fx, id);
    const result = await fx.actions.executeRemote(id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "operation-params-mismatch");
    assert.equal(io.invocations.length, 0);
  } finally {
    await fx.dispose();
  }
});

test("approved operation without in-memory arguments returns missing-pending-input", async () => {
  const fx = await authActionsFixture(makeFakeIo());
  try {
    const record = await fx.opLog.api.append({ requestId: "restart", kind: IMO_AUTH_LOGIN_KIND, paramsDigest: "sha256:restart", artifactRefs: [] });
    await approve(fx, record.id);
    const result = await fx.actions.executeAction(record.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "missing-pending-input");
  } finally {
    await fx.dispose();
  }
});

test("default precheck 401 finalizes a failed receipt exactly once", async () => {
  const io = makeFakeIo({ authResponses: new Map([[profileListKey, authResponse("", 1, "401 unauthorized")]]) });
  const fx = await authActionsFixture(io);
  try {
    const id = await operationId(await fx.actions.requestDefaultSwitch({ profile: "portal:demo" }));
    await approve(fx, id);
    const first = await fx.actions.executeDefaultSwitch(id);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.receipt.status, "failed");
      assert.equal(first.hint, "login-required");
    }
    assert.equal(fx.opLog.records.get(id)?.resultDigest !== undefined, true);
    const second = await fx.actions.executeDefaultSwitch(id);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "already-executed");
    assert.deepEqual(io.invocations, [["auth", "profile", "list", "--format", "json"]]);
  } finally {
    await fx.dispose();
  }
});

test("default precheck parse failure finalizes failed receipt and event", async () => {
  const io = makeFakeIo({ authResponses: new Map([[profileListKey, authResponse("not-json")]]) });
  const fx = await authActionsFixture(io);
  const events: unknown[] = [];
  fx.ctx.on("auth/action-failed", (event) => events.push(event));
  try {
    const id = await operationId(await fx.actions.requestDefaultSwitch({ profile: "portal:demo" }));
    await approve(fx, id);
    const result = await fx.actions.executeDefaultSwitch(id);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.receipt.status, "failed");
    assert.equal(events.length, 1);
    assert.deepEqual(io.invocations, [["auth", "profile", "list", "--format", "json"]]);
  } finally {
    await fx.dispose();
  }
});

test("successful login broadly revokes old leases before snapshot", async () => {
  const canary = "old-login-token-canary";
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --profile portal:demo --json", authResponse(JSON.stringify({ profile_name: "portal:demo", access_token: canary }))],
    ["auth login --env portal", authResponse("login ok")],
    [profileListKey, authResponse(JSON.stringify([{ name: "portal:demo", env: "portal", is_default: true }]))],
  ]) });
  const fx = await authActionsFixture(io);
  const invalidations: unknown[] = [];
  fx.ctx.on("auth/cache-invalidated", (event) => invalidations.push(event));
  try {
    const lease = await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo" }));
    const id = await operationId(await fx.actions.requestPortalLogin());
    await approve(fx, id);
    const result = await fx.actions.executePortalLogin(id);
    assert.equal(result.ok, true);
    await assert.rejects(lease.use(() => "not-used"), (error: unknown) => (
      typeof error === "object" && error !== null && "code" in error && error.code === "lease-revoked"
    ));
    assert.deepEqual(invalidations[0], { reason: "profile-changed", invalidated: 1 });
  } finally {
    await fx.dispose();
  }
});

test("environment provenance separates source profiles", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    [envKeyA, authResponse(`${envA}\n`)],
    ["complete --type env --profile portal:b", authResponse(`${envB}\n`)],
  ]) });
  const fx = await authActionsFixture(io);
  try {
    await fx.actions.listEnvironmentIds("portal:a");
    await fx.actions.listEnvironmentIds("portal:b");
    const wrong = await fx.actions.requestRemote({ env: envB, sourceProfile: "portal:a" });
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.error.code, "environment-not-resolved");
    const right = await fx.actions.requestRemote({ env: envA, sourceProfile: "portal:a" });
    assert.equal(right.ok, true);
  } finally {
    await fx.dispose();
  }
});

test("refreshing one source replaces only that source collection", async () => {
  const io = makeFakeIo({ authResponses: new Map([[envKeyA, authResponse(`${envA}\n`)]]) });
  const fx = await authActionsFixture(io);
  try {
    await fx.actions.listEnvironmentIds("portal:a");
    io.authResponses.set(envKeyA, authResponse(`${envB}\n`));
    await fx.actions.listEnvironmentIds("portal:a");
    const old = await fx.actions.requestRemote({ env: envA, sourceProfile: "portal:a" });
    const current = await fx.actions.requestRemote({ env: envB, sourceProfile: "portal:a" });
    assert.equal(old.ok, false);
    assert.equal(current.ok, true);
  } finally {
    await fx.dispose();
  }
});

test("completion filters option-like, sensitive, and incomplete IDs", async () => {
  const io = makeFakeIo({ authResponses: new Map([[envKeyA, authResponse([
    envA,
    "aws_sg_insuremo_oauth",
    "foo_insuremo_bar",
    optionLike,
    "aws_sg_insuremo_secret",
    "-aws_sg_insuremo_bad",
    "imo_kic_insuremo_ptdev",
  ].join("\n"))]]) });
  const fx = await authActionsFixture(io);
  try {
    const result = await fx.actions.listEnvironmentIds("portal:a");
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.environmentIds, [envA, "imo_kic_insuremo_ptdev"]);
    const rejected = await fx.actions.requestRemote({ env: optionLike, sourceProfile: "portal:a" });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "invalid-input");
  } finally {
    await fx.dispose();
  }
});

test("each argv value field rejects option-like input", async () => {
  const io = makeFakeIo({ authResponses: new Map([[envKeyA, authResponse(`${envA}\n`)]]) });
  const fx = await authActionsFixture(io);
  try {
    const loginTenant = await fx.actions.requestPortalLogin({ tenantCode: optionLike });
    const loginSource = await fx.actions.requestPortalLogin({ userSourceId: optionLike });
    const defaultProfile = await fx.actions.requestDefaultSwitch({ profile: optionLike });
    await fx.actions.listEnvironmentIds("portal:a");
    const remoteSource = await fx.actions.requestRemote({ env: envA, sourceProfile: optionLike });
    const remoteTarget = await fx.actions.requestRemote({ env: envA, sourceProfile: "portal:a", targetProfile: optionLike });
    const remoteTenant = await fx.actions.requestRemote({ env: envA, sourceProfile: "portal:a", targetTenant: optionLike });
    for (const result of [loginTenant, loginSource, defaultProfile, remoteSource, remoteTarget, remoteTenant]) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "invalid-input");
    }
    assert.equal(fx.opLog.records.size, 0);
  } finally {
    await fx.dispose();
  }
});

test("remote non-zero failure finalizes and does not retry", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    [envKeyA, authResponse(`${envA}\n`)],
    [`auth remote-profile create --env ${envA} --profile portal:a`, authResponse("", 1, "401 unauthorized")],
  ]) });
  const fx = await authActionsFixture(io);
  try {
    await fx.actions.listEnvironmentIds("portal:a");
    const id = await operationId(await fx.actions.requestRemote({ env: envA, sourceProfile: "portal:a" }));
    await approve(fx, id);
    const result = await fx.actions.executeRemote(id);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.receipt.status, "failed");
      assert.equal(result.hint, "login-required");
    }
    const second = await fx.actions.executeRemote(id);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "already-executed");
    assert.equal(io.invocations.length, 2);
  } finally {
    await fx.dispose();
  }
});
