import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTH_ACTION_COMPLETED_EVENT,
  AUTH_ACTION_FAILED_EVENT,
  IMO_AUTH_DEFAULT_KIND,
  IMO_AUTH_LOGIN_KIND,
  IMO_AUTH_REMOTE_KIND,
} from "../src/index.ts";
import {
  authActionsFixture,
  authResponse,
  makeFakeIo,
} from "./support/fake-subprocess.ts";

const envKey = "complete --type env --profile portal:demo";
const profileListKey = "auth profile list --format json";
const portalProfileJson = JSON.stringify([
  { name: "portal:demo", env: "portal", is_default: true, oauth_state: "drop-me" },
]);

async function approve(fx: Awaited<ReturnType<typeof authActionsFixture>>, operationId: string): Promise<void> {
  await fx.opLog.api.decide(operationId, true, "tester");
}

function requestId(result: { ok: boolean; value?: { operationId: string } }): string {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("request failed");
  return result.value.operationId;
}

test("environment completion keeps only strict full IDs and a digest", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    [envKey, authResponse("aws_sg_insuremo_sandbox\nnot safe\naws_sg_insuremo_sandbox\nimo_us_insuremo_prod.env-1\n")],
  ]) });
  const fx = await authActionsFixture(io);
  try {
    const result = await fx.actions.listEnvironmentIds("portal:demo");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.environmentIds, ["aws_sg_insuremo_sandbox", "imo_us_insuremo_prod.env-1"]);
      assert.match(result.value.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
    }
    assert.deepEqual(io.invocations[0], ["complete", "--type", "env", "--profile", "portal:demo"]);
  } finally {
    await fx.dispose();
  }
});

test("environment resolver prefers an exact full ID", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    [envKey, authResponse("aws_sg_insuremo_sandbox\naws_sg_insuremo_sandbox_2\n")],
  ]) });
  const fx = await authActionsFixture(io);
  try {
    const result = await fx.actions.resolveEnvironmentHint("aws_sg_insuremo_sandbox", "portal:demo");
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, {
      sourceProfile: "portal:demo",
      environmentId: "aws_sg_insuremo_sandbox",
      candidates: ["aws_sg_insuremo_sandbox"],
      environmentIds: ["aws_sg_insuremo_sandbox", "aws_sg_insuremo_sandbox_2"],
      stdoutDigest: result.value.stdoutDigest,
    });
  } finally {
    await fx.dispose();
  }
});

test("environment resolver reports not-found and ambiguous aliases without guessing", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    [envKey, authResponse("aws_sg_insuremo_sandbox\naws_us_insuremo_sandbox\n")],
  ]) });
  const fx = await authActionsFixture(io);
  try {
    const missing = await fx.actions.resolveEnvironmentHint("does-not-exist", "portal:demo");
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "not-found");
    const ambiguous = await fx.actions.resolveEnvironmentHint("sandbox", "portal:demo");
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) {
      assert.equal(ambiguous.error.code, "ambiguous");
      assert.deepEqual(ambiguous.error.candidates, ["aws_sg_insuremo_sandbox", "aws_us_insuremo_sandbox"]);
    }
    const url = await fx.actions.resolveEnvironmentHint("https://aws-sg-insuremo-sandbox.insuremo.com/?token=drop", "portal:demo");
    assert.equal(url.ok, true);
    if (url.ok) assert.equal(url.value.environmentId, "aws_sg_insuremo_sandbox");
  } finally {
    await fx.dispose();
  }
});

test("remote request rejects an unconfirmed environment before appending or spawning", async () => {
  const io = makeFakeIo();
  const fx = await authActionsFixture(io);
  try {
    const result = await fx.actions.requestRemote({ env: "aws_sg_insuremo_sandbox" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "environment-not-resolved");
    assert.equal(io.invocations.length, 0);
    assert.equal(fx.opLog.records.size, 0);
  } finally {
    await fx.dispose();
  }
});

test("unapproved portal login never spawns", async () => {
  const io = makeFakeIo();
  const fx = await authActionsFixture(io);
  try {
    const request = await fx.actions.requestPortalLogin({ force: true });
    const operationId = requestId(request);
    const result = await fx.actions.executePortalLogin(operationId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not-approved");
    assert.equal(io.invocations.length, 0);
  } finally {
    await fx.dispose();
  }
});

test("portal login rejects non-portal and manual modes without operation records", async () => {
  const fx = await authActionsFixture(makeFakeIo());
  try {
    const nonPortal = await fx.actions.requestPortalLogin({ env: "dev" });
    const manual = await fx.actions.requestPortalLogin({ manual: true });
    assert.equal(nonPortal.ok, false);
    assert.equal(manual.ok, false);
    if (!nonPortal.ok) assert.equal(nonPortal.error.code, "invalid-input");
    if (!manual.ok) assert.equal(manual.error.code, "manual-not-supported");
    assert.equal(fx.opLog.records.size, 0);
  } finally {
    await fx.dispose();
  }
});

test("approved portal login uses fixed portal argv and returns sanitized snapshot receipt", async () => {
  const canary = "oauth-state-token-canary";
  const io = makeFakeIo({ authResponses: new Map([
    ["auth login --env portal --tenant-code t_demo --user-source-id cas --force --scope workspace", authResponse(`oauth_url=${canary}\n`)],
    [profileListKey, authResponse(portalProfileJson)],
  ]) });
  const fx = await authActionsFixture(io);
  const events: unknown[] = [];
  fx.ctx.on(AUTH_ACTION_COMPLETED_EVENT, (event) => events.push(event));
  try {
    const request = await fx.actions.requestPortalLogin({ tenantCode: "t_demo", userSourceId: "cas", force: true, scope: "workspace" });
    const operationId = requestId(request);
    await approve(fx, operationId);
    const result = await fx.actions.executePortalLogin(operationId);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.receipt.status, "completed");
      assert.equal(result.receipt.profileName, "portal:demo");
      assert.equal(JSON.stringify(result).includes(canary), false);
    }
    assert.deepEqual(io.invocations[0], ["auth", "login", "--env", "portal", "--tenant-code", "t_demo", "--user-source-id", "cas", "--force", "--scope", "workspace"]);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0] && Object.keys(events[0] as object).sort(), ["kind", "operationId", "resultDigest", "status"]);
  } finally {
    await fx.dispose();
  }
});

test("remote execute keeps source and target argv distinct and invalidates target cache", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    [envKey, authResponse("aws_sg_insuremo_sandbox\n")],
    ["auth remote-profile create --env aws_sg_insuremo_sandbox --profile portal:demo --target-profile remote:demo --target-tenant t_remote --scope workspace", authResponse("remote created\n")],
  ]) });
  const fx = await authActionsFixture(io);
  const invalidations: unknown[] = [];
  fx.ctx.on("auth/cache-invalidated", (event) => invalidations.push(event));
  try {
    await fx.actions.listEnvironmentIds("portal:demo");
    const request = await fx.actions.requestRemote({ env: "aws_sg_insuremo_sandbox", sourceProfile: "portal:demo", targetProfile: "remote:demo", targetTenant: "t_remote", scope: "workspace" });
    const operationId = requestId(request);
    await approve(fx, operationId);
    const result = await fx.actions.executeRemote(operationId);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.receipt.environmentId, "aws_sg_insuremo_sandbox");
      assert.equal(result.receipt.targetProfile, "remote:demo");
    }
    assert.deepEqual(io.invocations[1], ["auth", "remote-profile", "create", "--env", "aws_sg_insuremo_sandbox", "--profile", "portal:demo", "--target-profile", "remote:demo", "--target-tenant", "t_remote", "--scope", "workspace"]);
    assert.equal(invalidations.length, 1);
    assert.deepEqual(invalidations[0], { profile: "remote:demo", env: "aws_sg_insuremo_sandbox", reason: "profile-changed", invalidated: 0 });
  } finally {
    await fx.dispose();
  }
});

test("remote without target profile performs broad environment invalidation", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    [envKey, authResponse("aws_sg_insuremo_sandbox\n")],
    ["auth remote-profile create --env aws_sg_insuremo_sandbox", authResponse("ok\n")],
  ]) });
  const fx = await authActionsFixture(io);
  const events: unknown[] = [];
  fx.ctx.on("auth/cache-invalidated", (event) => events.push(event));
  try {
    await fx.actions.listEnvironmentIds("portal:demo");
    const operationId = requestId(await fx.actions.requestRemote({ environmentId: "aws_sg_insuremo_sandbox", sourceProfile: "portal:demo" }));
    await approve(fx, operationId);
    await fx.actions.executeRemote(operationId);
    assert.deepEqual(events[0], { env: "aws_sg_insuremo_sandbox", reason: "profile-changed", invalidated: 0 });
  } finally {
    await fx.dispose();
  }
});

test("default switch rejects a missing profile before default-profile set", async () => {
  const io = makeFakeIo({ authResponses: new Map([[profileListKey, authResponse("[]")]]) });
  const fx = await authActionsFixture(io);
  try {
    const operationId = requestId(await fx.actions.requestDefaultSwitch({ profile: "portal:missing" }));
    await approve(fx, operationId);
    const result = await fx.actions.executeDefaultSwitch(operationId);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.receipt.status, "failed");
    assert.deepEqual(io.invocations, [["auth", "profile", "list", "--format", "json"]]);
    const second = await fx.actions.executeDefaultSwitch(operationId);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "already-executed");
  } finally {
    await fx.dispose();
  }
});

test("approved default switch validates existence, uses scope argv, and invalidates cache", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    [profileListKey, authResponse(portalProfileJson)],
    ["auth default-profile set portal:demo --scope workspace", authResponse("set\n")],
  ]) });
  const fx = await authActionsFixture(io);
  const invalidations: unknown[] = [];
  fx.ctx.on("auth/cache-invalidated", (event) => invalidations.push(event));
  try {
    const operationId = requestId(await fx.actions.requestDefaultSwitch({ profile: "portal:demo", scope: "workspace" }));
    await approve(fx, operationId);
    const result = await fx.actions.executeDefaultSwitch(operationId);
    assert.equal(result.ok, true);
    assert.deepEqual(io.invocations[1], ["auth", "default-profile", "set", "portal:demo", "--scope", "workspace"]);
    assert.deepEqual(invalidations[0], { profile: "portal:demo", reason: "profile-changed", invalidated: 0 });
  } finally {
    await fx.dispose();
  }
});

test("401 and 403 action failures record once, hint safely, and never retry", async () => {
  for (const [status, hint] of [[401, "login-required"], [403, "permission-denied"]] as const) {
    const io = makeFakeIo({ authResponses: new Map([
      ["auth login --env portal", authResponse("", 1, `${status} permission response`)],
    ]) });
    const fx = await authActionsFixture(io);
    const events: unknown[] = [];
    fx.ctx.on(AUTH_ACTION_FAILED_EVENT, (event) => events.push(event));
    try {
      const operationId = requestId(await fx.actions.requestPortalLogin());
      await approve(fx, operationId);
      const result = await fx.actions.executePortalLogin(operationId);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.receipt.status, "failed");
        assert.equal(result.hint, hint);
      }
      assert.equal(io.invocations.length, 1);
      assert.equal(events.length, 1);
    } finally {
      await fx.dispose();
    }
  }
});

test("the action service has one global busy lock", async () => {
  const io = makeFakeIo({ pendingKey: "auth login --env portal" });
  const fx = await authActionsFixture(io);
  try {
    const first = requestId(await fx.actions.requestPortalLogin());
    const second = requestId(await fx.actions.requestPortalLogin({ force: true }));
    await approve(fx, first);
    await approve(fx, second);
    const running = fx.actions.executePortalLogin(first);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const busy = await fx.actions.executePortalLogin(second);
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.error.code, "busy");
    io.pendingHandles[0]!.terminate();
    const completed = await running;
    assert.equal(completed.ok, true);
  } finally {
    await fx.dispose();
  }
});

test("completed action is idempotent and recordResult is not repeated", async () => {
  const io = makeFakeIo({ authResponses: new Map([["auth login --env portal", authResponse("ok\n")]]) });
  const fx = await authActionsFixture(io);
  try {
    const operationId = requestId(await fx.actions.requestPortalLogin());
    await approve(fx, operationId);
    const first = await fx.actions.executePortalLogin(operationId);
    const second = await fx.actions.executePortalLogin(operationId);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "already-executed");
    assert.equal(fx.opLog.records.get(operationId)?.resultDigest !== undefined, true);
  } finally {
    await fx.dispose();
  }
});

test("all public action surfaces exclude OAuth/token canaries", async () => {
  const canary = "oauth-url-callback-state-token-cookie-canary";
  const io = makeFakeIo({ authResponses: new Map([
    ["auth login --env portal", authResponse(canary)],
    [profileListKey, authResponse(JSON.stringify([{ name: "portal:demo", access_token: canary, oauth_state: canary }]))],
  ]) });
  const fx = await authActionsFixture(io);
  const events: unknown[] = [];
  fx.ctx.on(AUTH_ACTION_COMPLETED_EVENT, (event) => events.push(event));
  try {
    const operationId = requestId(await fx.actions.requestPortalLogin());
    await approve(fx, operationId);
    const result = await fx.actions.executePortalLogin(operationId);
    assert.equal(JSON.stringify(result).includes(canary), false);
    assert.equal(JSON.stringify(events).includes(canary), false);
    assert.equal(JSON.stringify([...fx.opLog.records.values()]).includes(canary), false);
  } finally {
    await fx.dispose();
  }
});
