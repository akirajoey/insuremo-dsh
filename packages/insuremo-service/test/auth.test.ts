import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { authFixture, authResponse, expectAuthOk, makeFakeIo } from "./support/fake-subprocess.ts";

test("auth profile list exposes only the explicit sanitized allowlist", async () => {
  const canary = ["auth", "profile", "token", "canary"].join("_");
  const raw = [{
    name: "portal:demo",
    env: "portal",
    env_id: "env-1",
    tenant_code: "tenant-1",
    account_name: "person@example.test",
    domain: "https://user:pass@portal.example.test/ui?access_token=" + canary + "#fragment",
    gateway: "https://%75ser:%70ass@gateway.example.test/api?secret=" + canary + "#fragment",
    tenant_domain: "https://tenant.example.test:8443/",
    source: "stored",
    scope: "global",
    user_source_id: "source-1",
    valid: true,
    is_default: true,
    access_token: canary,
    secret: canary,
    nested: { password: canary },
    unknown_field: "discard-me",
  }];
  const io = makeFakeIo({ authResponses: new Map([
    ["auth profile list --format json", authResponse(JSON.stringify(raw))],
  ]) });
  const fx = await authFixture(io);
  try {
    const value = await expectAuthOk(await fx.auth.listProfiles());
    assert.deepEqual(value.profiles, [{
      profileName: "portal:demo",
      env: "portal",
      envId: "env-1",
      tenantCode: "tenant-1",
      accountName: "person@example.test",
      domain: "https://portal.example.test/ui",
      gateway: "https://gateway.example.test/api",
      tenantDomain: "tenant.example.test:8443",
      source: "stored",
      scope: "global",
      userSourceId: "source-1",
      valid: true,
      isDefault: true,
    }]);
    assert.equal(JSON.stringify(value).includes(canary), false);
    assert.equal(JSON.stringify(value).includes("unknown_field"), false);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth endpoint sanitizer rejects malformed values and strips encoded userinfo", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    ["auth profile list --format json", authResponse(JSON.stringify([
      {
        name: "malformed",
        domain: "not a URL %%%",
        gateway: "https://%75ser:%70ass@gateway.example.test/path?token=discard#fragment",
        tenant_domain: "https://user:pass@tenant.example.test/path?token=discard#fragment",
      },
      {
        name: "host",
        tenant_domain: "tenant.example.test:8443",
      },
    ]))],
  ]) });
  const fx = await authFixture(io);
  try {
    const value = await expectAuthOk(await fx.auth.listProfiles());
    assert.deepEqual(value.profiles, [
      {
        profileName: "malformed",
        gateway: "https://gateway.example.test/path",
      },
      {
        profileName: "host",
        tenantDomain: "tenant.example.test:8443",
      },
    ]);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth prepare lease view applies the same endpoint and tenant-domain sanitizers", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --profile portal:demo --json", authResponse(JSON.stringify({
      profile_name: "portal:demo",
      domain: "https://user:pass@portal.example.test/ui?token=discard#fragment",
      gateway: "https://gateway.example.test/api?access_token=discard#fragment",
      tenant_domain: "https://tenant.example.test:9443/",
      access_token: "lease-endpoint-token",
    }))],
  ]) });
  const fx = await authFixture(io);
  try {
    const lease = await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo" }));
    assert.equal(lease.view.domain, "https://portal.example.test/ui");
    assert.equal(lease.view.gateway, "https://gateway.example.test/api");
    assert.equal(lease.view.tenantDomain, "tenant.example.test:9443");
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth defaultProfile returns only the profile name and a digest", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    ["auth default-profile get", authResponse("portal:demo\n")],
  ]) });
  const fx = await authFixture(io);
  try {
    const value = await expectAuthOk(await fx.auth.defaultProfile());
    assert.equal(value.profileName, "portal:demo");
    assert.match(value.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal("stdout" in value, false);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth validate returns an allowlisted healthy view", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    ["auth profile validate --profile portal:demo --json", authResponse(JSON.stringify({
      profile_name: "portal:demo",
      valid: true,
      status: "valid",
      reason: "ok",
      access_token: "discarded",
      nested: { secret: "discarded" },
    }))],
  ]) });
  const fx = await authFixture(io);
  try {
    const value = await expectAuthOk(await fx.auth.validate("portal:demo"));
    assert.equal(value.profileName, "portal:demo");
    assert.equal(value.valid, true);
    assert.equal(value.status, "valid");
    assert.equal(value.reason, "valid");
    assert.match(value.stdoutDigest, /^sha256:/);
    assert.equal(JSON.stringify(value).includes("discarded"), false);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth validate maps 401 to invalid-auth, invalidates, and never retries", async () => {
  const canary = ["prepare", "token", "401", "canary"].join("_");
  const prepareKey = "auth prepare --profile portal:demo --env prod --json";
  const io = makeFakeIo({ authResponses: new Map([
    [prepareKey, authResponse(JSON.stringify({ profile_name: "portal:demo", env: "prod", access_token: canary }))],
    ["auth profile validate --profile portal:demo --json", authResponse("", 1, "401 Unauthorized " + canary)],
  ]) });
  const fx = await authFixture(io);
  try {
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo", env: "prod" }));
    assert.equal(fx.auth.cacheStatus().size, 1);
    const result = await fx.auth.validate("portal:demo");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid-auth");
      assert.equal(JSON.stringify(result).includes(canary), false);
    }
    assert.equal(fx.auth.cacheStatus().size, 0);
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo", env: "prod" }));
    assert.equal(io.invocations.filter((args) => args.join(" ") === prepareKey).length, 2);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth validate maps 403 to forbidden without invalidation or retry", async () => {
  const canary = ["forbidden", "token", "canary"].join("_");
  const prepareKey = "auth prepare --profile portal:demo --env prod --json";
  const io = makeFakeIo({ authResponses: new Map([
    [prepareKey, authResponse(JSON.stringify({ profile_name: "portal:demo", env: "prod", access_token: canary }))],
    ["auth profile validate --profile portal:demo --json", authResponse("", 1, "403 Forbidden " + canary)],
  ]) });
  const fx = await authFixture(io);
  try {
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo", env: "prod" }));
    const result = await fx.auth.validate("portal:demo");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "forbidden");
    assert.equal(fx.auth.cacheStatus().size, 1);
    const lease = await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo", env: "prod" }));
    assert.equal(lease.cache.reused, true);
    assert.equal(io.invocations.filter((args) => args.join(" ") === prepareKey).length, 1);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth lease reveals the canary only through use and has no inspectable token surface", async () => {
  const canary = ["opaque", "access", "token", "canary"].join("_");
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --profile portal:demo --json", authResponse(JSON.stringify({
      profile_name: "portal:demo",
      env: "portal",
      gateway: "https://gateway.example.test",
      access_token: canary,
    }))],
  ]) });
  const fx = await authFixture(io);
  try {
    const lease = await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo" }));
    assert.equal(await lease.use((secret) => secret.accessToken), canary);
    assert.equal("accessToken" in lease, false);
    assert.deepEqual(Object.keys(lease), ["view", "cache"]);
    const publicStrings = [
      JSON.stringify(lease),
      inspect(lease),
      JSON.stringify({ ...lease }),
      JSON.stringify(structuredClone(lease)),
    ];
    for (const text of publicStrings) {
      assert.equal(text.includes(canary), false);
      assert.equal(text.includes("accessToken"), false);
    }
    assert.equal(JSON.stringify(lease.view).includes(canary), false);
    assert.equal(JSON.stringify(lease.cache).includes(canary), false);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth prepare parse failures expose only digests", async () => {
  const canary = ["malformed", "token", "canary"].join("_");
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --json", authResponse(`{"access_token":"${canary}`)],
  ]) });
  const fx = await authFixture(io);
  try {
    const result = await fx.auth.prepare();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "parse-error");
      assert.match(result.error.stdoutDigest ?? "", /^sha256:/);
      assert.equal(JSON.stringify(result).includes(canary), false);
    }
    assert.equal(fx.auth.cacheStatus().size, 0);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth prepare non-zero failures expose no stderr token", async () => {
  const canary = ["stderr", "token", "canary"].join("_");
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --json", authResponse("", 1, "prepare failed " + canary)],
  ]) });
  const fx = await authFixture(io);
  try {
    const result = await fx.auth.prepare();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "non-zero-exit");
      assert.match(result.error.stderrDigest ?? "", /^sha256:/);
      assert.equal(JSON.stringify(result).includes(canary), false);
    }
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth prepare reuses one cache entry for the same profile and env", async () => {
  const key = "auth prepare --profile portal:demo --env prod --json";
  const io = makeFakeIo({ authResponses: new Map([
    [key, authResponse(JSON.stringify({ profile_name: "portal:demo", env: "prod", access_token: "same-key-token" }))],
  ]) });
  const fx = await authFixture(io);
  try {
    const first = await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo", env: "prod" }));
    const second = await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo", env: "prod" }));
    assert.equal(first.cache.reused, false);
    assert.equal(second.cache.reused, true);
    assert.equal(fx.auth.cacheStatus().size, 1);
    assert.equal(io.invocations.filter((args) => args.join(" ") === key).length, 1);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth concurrent prepares coalesce to one CLI spawn", async () => {
  const key = "auth prepare --profile portal:demo --env prod --json";
  const io = makeFakeIo({ authResponses: new Map([
    [key, authResponse(JSON.stringify({ profile_name: "portal:demo", env: "prod", access_token: "coalesced-token" }))],
  ]) });
  const fx = await authFixture(io);
  try {
    const [first, second] = await Promise.all([
      fx.auth.prepare({ profile: "portal:demo", env: "prod" }),
      fx.auth.prepare({ profile: "portal:demo", env: "prod" }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(io.invocations.filter((args) => args.join(" ") === key).length, 1);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth cache separates different profile and env keys", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --profile portal:a --env prod --json", authResponse(JSON.stringify({ profile_name: "portal:a", access_token: "a-token" }))],
    ["auth prepare --profile portal:b --env prod --json", authResponse(JSON.stringify({ profile_name: "portal:b", access_token: "b-token" }))],
  ]) });
  const fx = await authFixture(io);
  try {
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:a", env: "prod" }));
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:b", env: "prod" }));
    assert.equal(fx.auth.cacheStatus().size, 2);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth manual invalidation removes a key and makes the next prepare spawn", async () => {
  const key = "auth prepare --profile portal:demo --env prod --json";
  const io = makeFakeIo({ authResponses: new Map([
    [key, authResponse(JSON.stringify({ profile_name: "portal:demo", access_token: "invalidate-token" }))],
  ]) });
  const fx = await authFixture(io);
  try {
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo", env: "prod" }));
    const invalidation = fx.auth.invalidate({ profile: "portal:demo", env: "prod", reason: "manual" });
    assert.deepEqual(invalidation, { invalidated: 1, reason: "manual" });
    assert.equal(fx.auth.cacheStatus().size, 0);
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo", env: "prod" }));
    assert.equal(io.invocations.filter((args) => args.join(" ") === key).length, 2);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth profile-changed invalidation prevents reuse of the old lease", async () => {
  const key = "auth prepare --profile portal:demo --env prod --json";
  const io = makeFakeIo({ authResponses: new Map([
    [key, authResponse(JSON.stringify({ profile_name: "portal:demo", access_token: "changed-profile-token" }))],
  ]) });
  const fx = await authFixture(io);
  try {
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo", env: "prod" }));
    fx.auth.invalidate({ profile: "portal:demo", reason: "profile-changed" });
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo", env: "prod" }));
    assert.equal(io.invocations.filter((args) => args.join(" ") === key).length, 2);
  } finally {
    await fx.fiber.dispose();
  }
});

test("auth service clears its in-memory cache when its fiber is disposed", async () => {
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --profile portal:demo --json", authResponse(JSON.stringify({ profile_name: "portal:demo", access_token: "dispose-token" }))],
  ]) });
  const fx = await authFixture(io);
  await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo" }));
  assert.equal(fx.auth.cacheStatus().size, 1);
  await fx.fiber.dispose();
  assert.equal(fx.auth.cacheStatus().size, 0);
});

test("auth cache invalidation event contains metadata only", async () => {
  const canary = ["event", "token", "canary"].join("_");
  const io = makeFakeIo({ authResponses: new Map([
    ["auth prepare --profile portal:demo --json", authResponse(JSON.stringify({ profile_name: "portal:demo", access_token: canary }))],
  ]) });
  const fx = await authFixture(io);
  const events: unknown[] = [];
  fx.ctx.on("auth/cache-invalidated", (payload: unknown) => events.push(payload));
  try {
    await expectAuthOk(await fx.auth.prepare({ profile: "portal:demo" }));
    fx.auth.invalidate({ profile: "portal:demo", reason: "manual" });
    assert.equal(events.length, 1);
    assert.equal(JSON.stringify(events[0]).includes(canary), false);
    assert.deepEqual(events[0], {
      profile: "portal:demo",
      reason: "manual",
      invalidated: 1,
    });
  } finally {
    await fx.fiber.dispose();
  }
});

