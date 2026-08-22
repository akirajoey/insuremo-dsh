import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { mountWriteRoutes } from "../src/overview/write-routes.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function fakeWebServer() {
  const routes = new Map<string, Handler>();
  const disposers: Array<() => void> = [];
  return {
    routes,
    register(route: { path: string; handler: Handler }) {
      routes.set(route.path, route.handler);
      const dispose = () => { routes.delete(route.path); };
      disposers.push(dispose);
      return dispose;
    },
    disposeAll: () => { for (const dispose of disposers) dispose(); },
  };
}

interface FakeReq {
  method?: string;
  host?: string;
  origin?: string;
  referer?: string;
  actionHeader?: string;
  contentType?: string;
  body?: string;
}
interface FakeRes {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

function makeReq(overrides: FakeReq = {}): IncomingMessage {
  const body = overrides.body ?? "{}";
  const headers: Record<string, string> = {};
  if (overrides.host !== undefined) headers.host = overrides.host;
  if (overrides.origin !== undefined) headers.origin = overrides.origin;
  if (overrides.referer !== undefined) headers.referer = overrides.referer;
  if (overrides.actionHeader !== undefined) headers["x-workbench-action"] = overrides.actionHeader;
  if (overrides.contentType !== undefined) headers["content-type"] = overrides.contentType;
  const req = {
    method: overrides.method ?? "POST",
    headers,
    async *[Symbol.asyncIterator]() { if (body.length > 0) yield Buffer.from(body, "utf8"); },
  };
  return req as unknown as IncomingMessage;
}

function makeRes(): FakeRes & ServerResponse & { done: Promise<void> } {
  let settle!: () => void;
  const done = new Promise<void>(resolve => { settle = resolve; });
  const state = { status: 0, headers: {} as Record<string, string | undefined>, body: "", done };
  const res = {
    on() { return this; },
    off() { return this; },
    writeHead(status: number, headers: Record<string, string>) { state.status = status; (this as unknown as FakeRes).status = status; Object.assign(state.headers, headers); return this; },
    end(payload?: string) { if (typeof payload === "string") { state.body = payload; (this as unknown as FakeRes).body = payload; } settle(); return this; },
  };
  const merged = Object.assign(res, state);
  // `destroyed`/`writableEnded` are plain properties (no getters) so reads work after the merge
  (merged as { destroyed: boolean }).destroyed = false;
  Object.defineProperty(merged, "writableEnded", { get: () => state.status >= 200, configurable: true });
  return merged as unknown as FakeRes & ServerResponse & { done: Promise<void> };
}

interface Fixture {
  ctx: Context;
  server: ReturnType<typeof fakeWebServer>;
  dispose(): Promise<void>;
}

function baseServices(overrides: {
  upgrade?: unknown;
  activation?: unknown;
  skillActions?: unknown;
  authActions?: unknown;
  operationLog?: unknown;
} = {}) {
  return {
    imoUpgrade: overrides.upgrade ?? {
      upgradeStatus: () => ({ running: false }),
      requestUpgrade: async () => ({ operationId: "op-up-1", targetVersion: null }),
      executeUpgrade: async () => ({ ok: true, receipt: { status: "completed", currentVersion: "0.2.17", targetVersion: "0.2.18" } }),
    },
    imoSkillActivation: overrides.activation ?? {
      snapshot: async () => ({ initialized: true, installed: ["a"], enabled: ["a"], disabled: [], stale: [], revision: 1 }),
      setEnabled: async (name: string, enabled: boolean) => ({ initialized: true, installed: [name], enabled: enabled ? [name] : [], disabled: enabled ? [] : [name], stale: [], revision: 2 }),
    },
    imoSkillActions: overrides.skillActions ?? {
      status: () => ({ running: false }),
      request: async () => ({ ok: true, value: { operationId: "op-sk-1", paramsDigest: "d", kind: "skill-update", preview: {} } }),
      execute: async () => ({ ok: true, receipt: { operationId: "op-sk-1", kind: "skill-update", status: "completed", updated: ["a", "b"] } }),
    },
    imoAuthActions: overrides.authActions ?? {
      requestDefaultSwitch: async () => ({ ok: true, value: { operationId: "op-dp-1", paramsDigest: "d", kind: "auth-default-switch" } }),
      executeDefaultSwitch: async () => ({ ok: true, receipt: { operationId: "op-dp-1", kind: "auth-default-switch", status: "completed" } }),
    },
    operationLog: overrides.operationLog ?? {
      append: async () => ({}),
      list: () => [],
      decide: async (id: string, approved: boolean, by: string) => ({ id, decision: approved ? "approved" : "rejected", decidedBy: by }),
    },
  };
}

async function fixture(services: ReturnType<typeof baseServices> = baseServices()): Promise<Fixture> {
  const ctx = new Context();
  const server = fakeWebServer();
  ctx.provide("webServer" as never, server as never);
  for (const [name, value] of Object.entries(services)) {
    ctx.provide(name as never, value as never);
  }
  const unregister = mountWriteRoutes(ctx as never, {
    getActivationController: () => services.imoSkillActivation as never,
  });
  return { ctx, server, dispose: async () => { unregister(); server.disposeAll(); } };
}

function actionPath(name: string): string {
  return `/api/icomposer-workbench/insuremo/overview/actions/${name}`;
}

async function call(server: ReturnType<typeof fakeWebServer>, name: string, overrides: FakeReq = {}): Promise<FakeRes> {
  const handler = server.routes.get(actionPath(name));
  if (handler === undefined) throw new Error(`route not mounted: ${name}`);
  const req = makeReq({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", actionHeader: "1", contentType: "application/json", ...overrides });
  const res = makeRes();
  handler(req, res as unknown as ServerResponse);
  await res.done;
  return res as unknown as FakeRes;
}

test("origin gate: missing origin/referer, cross-origin, and cross-port are 403", async () => {
  const h = await fixture();
  try {
    const noOrigin = await call(h.server, "imo-upgrade", { origin: undefined, referer: undefined });
    assert.equal(noOrigin.status, 403);
    assert.equal(JSON.parse(noOrigin.body).error.code, "origin-required");

    const crossOrigin = await call(h.server, "imo-upgrade", { origin: "http://evil.example" });
    assert.equal(crossOrigin.status, 403);
    assert.equal(JSON.parse(crossOrigin.body).error.code, "origin-mismatch");

    const crossPort = await call(h.server, "imo-upgrade", { referer: "http://127.0.0.1:9999/x" });
    assert.equal(crossPort.status, 403);
    assert.equal(JSON.parse(crossPort.body).error.code, "origin-mismatch");

    const noHost = await call(h.server, "imo-upgrade", { host: undefined });
    assert.equal(noHost.status, 403);

    const sameOrigin = await call(h.server, "imo-upgrade", {});
    assert.equal(sameOrigin.status, 200);
    assert.equal(JSON.parse(sameOrigin.body).ok, true);
  } finally { await h.dispose(); }
});

test("X-Workbench-Action header and content-type gate", async () => {
  const h = await fixture();
  try {
    const missingHeader = await call(h.server, "skill-activation", { actionHeader: undefined });
    assert.equal(missingHeader.status, 403);
    assert.equal(JSON.parse(missingHeader.body).error.code, "action-header-required");

    const wrongHeader = await call(h.server, "skill-activation", { actionHeader: "0" });
    assert.equal(wrongHeader.status, 403);

    const badContentType = await call(h.server, "skill-activation", { contentType: "text/plain" });
    assert.equal(badContentType.status, 400);
    assert.equal(JSON.parse(badContentType.body).error.code, "content-type");
  } finally { await h.dispose(); }
});

test("body limits: >8KB → 413, invalid JSON → 400, non-object → 400", async () => {
  const h = await fixture();
  try {
    const tooBig = await call(h.server, "imo-upgrade", { body: JSON.stringify({ targetVersion: "x".repeat(9 * 1024) }) });
    assert.equal(tooBig.status, 413);
    assert.equal(JSON.parse(tooBig.body).error.code, "body-too-large");

    const badJson = await call(h.server, "imo-upgrade", { body: "{not json" });
    assert.equal(badJson.status, 400);
    assert.equal(JSON.parse(badJson.body).error.code, "body-json");

    const arrayBody = await call(h.server, "imo-upgrade", { body: "[1,2]" });
    assert.equal(arrayBody.status, 400);
    assert.equal(JSON.parse(arrayBody.body).error.code, "body-shape");
  } finally { await h.dispose(); }
});

test("imo-upgrade happy path: request→decide(by web-ui)→execute order + sanitized result", async () => {
  const calls: string[] = [];
  const services = baseServices({
    upgrade: {
      upgradeStatus: () => ({ running: false }),
      requestUpgrade: async (targetVersion?: string) => { calls.push(`request:${targetVersion ?? "latest"}`); return { operationId: "op-1", targetVersion: targetVersion ?? null }; },
      executeUpgrade: async (id: string) => { calls.push(`execute:${id}`); return { ok: true, receipt: { status: "completed", currentVersion: "0.2.18", targetVersion: "0.2.18" } }; },
    },
    operationLog: {
      append: async () => ({}),
      list: () => [],
      decide: async (id: string, approved: boolean, by: string) => { calls.push(`decide:${id}:${approved}:${by}`); return { id }; },
    },
  });
  const h = await fixture(services);
  try {
    const res = await call(h.server, "imo-upgrade", { body: JSON.stringify({ targetVersion: "0.2.18" }) });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload, { ok: true, result: { status: "completed", currentVersion: "0.2.18", targetVersion: "0.2.18" } });
    assert.deepEqual(calls, ["request:0.2.18", "decide:op-1:true:web-ui", "execute:op-1"]);
    // security headers on every response
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
  } finally { await h.dispose(); }
});

test("busy mapping: running upgrade → busy code; running skill action → busy", async () => {
  const h = await fixture(baseServices({
    upgrade: {
      upgradeStatus: () => ({ running: true }),
      requestUpgrade: async () => ({ operationId: "op-x", targetVersion: null }),
      executeUpgrade: async () => ({ ok: true, receipt: {} }),
    },
  }));
  try {
    const res = await call(h.server, "imo-upgrade");
    assert.equal(JSON.parse(res.body).error.code, "busy");
  } finally { await h.dispose(); }

  const h2 = await fixture(baseServices({
    skillActions: {
      status: () => ({ running: true }),
      request: async () => ({ ok: true, value: { operationId: "op-s" } }),
      execute: async () => ({ ok: true, receipt: {} }),
    },
  }));
  try {
    const res = await call(h2.server, "skill-update", { body: JSON.stringify({ name: "__all__" }) });
    assert.equal(JSON.parse(res.body).error.code, "busy");
  } finally { await h2.dispose(); }
});

test("skill-activation: happy path shape + not-installed/conflict mapping", async () => {
  const h = await fixture();
  try {
    const res = await call(h.server, "skill-activation", { body: JSON.stringify({ name: "imo-audit-helper", enabled: true, expectedRevision: 3 }) });
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload, { ok: true, result: { name: "imo-audit-helper", enabled: true, revision: 2 } });
    const missingName = await call(h.server, "skill-activation", { body: JSON.stringify({ enabled: true }) });
    assert.equal(JSON.parse(missingName.body).error.code, "invalid-input");
    const badEnabled = await call(h.server, "skill-activation", { body: JSON.stringify({ name: "x", enabled: "yes" }) });
    assert.equal(JSON.parse(badEnabled.body).error.code, "invalid-input");
  } finally { await h.dispose(); }

  const h2 = await fixture(baseServices({
    activation: {
      snapshot: async () => { throw new Error("activation unavailable"); },
      setEnabled: async () => { const error = new Error("skill not installed: ghost"); (error as { code?: string }).code = "not-installed"; throw error; },
    },
  }));
  try {
    const res = await call(h2.server, "skill-activation", { body: JSON.stringify({ name: "ghost", enabled: true }) });
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "not-installed");
    assert.match(payload.error.message, /not installed/);
  } finally { await h2.dispose(); }
});

test("skill-update accepts only __all__; skill-install requires name+source object; default-profile chain", async () => {
  const calls: string[] = [];
  const services = baseServices({
    skillActions: {
      status: () => ({ running: false }),
      request: async (input: { kind: string }) => { calls.push(`request:${input.kind}`); return { ok: true, value: { operationId: `op-${input.kind}` } }; },
      execute: async (id: string) => { calls.push(`execute:${id}`); return { ok: true, receipt: { status: "completed", updated: ["imo-audit-helper"] } }; },
    },
    authActions: {
      requestDefaultSwitch: async (input: { profile: string }) => { calls.push(`dp-request:${input.profile}`); return { ok: true, value: { operationId: "op-dp" } }; },
      executeDefaultSwitch: async (id: string) => { calls.push(`dp-execute:${id}`); return { ok: true, receipt: { status: "completed" } }; },
    },
  });
  const h = await fixture(services);
  try {
    const all = await call(h.server, "skill-update", { body: JSON.stringify({ name: "__all__" }) });
    const payload = JSON.parse(all.body);
    assert.deepEqual(payload.result, { status: "completed", names: ["imo-audit-helper"] });

    const scoped = await call(h.server, "skill-update", { body: JSON.stringify({ name: "imo-audit-helper" }) });
    assert.equal(JSON.parse(scoped.body).error.code, "invalid-input");

    const noName = await call(h.server, "skill-install", { body: JSON.stringify({}) });
    assert.equal(JSON.parse(noName.body).error.code, "invalid-input");

    const badSource = await call(h.server, "skill-install", { body: JSON.stringify({ name: "x", source: "https://evil" }) });
    assert.equal(JSON.parse(badSource.body).error.code, "invalid-input");

    const install = await call(h.server, "skill-install", { body: JSON.stringify({ name: "imo-new", source: { type: "alias", value: "imo" } }) });
    assert.equal(JSON.parse(install.body).ok, true);

    const dp = await call(h.server, "default-profile", { body: JSON.stringify({ profile: "portal:microsite" }) });
    const dpPayload = JSON.parse(dp.body);
    assert.deepEqual(dpPayload.result, { status: "completed", profile: "portal:microsite" });
    assert.deepEqual(calls, [
      "request:skill-update", "execute:op-skill-update",
      "request:skill-install", "execute:op-skill-install",
      "dp-request:portal:microsite", "dp-execute:op-dp",
    ]);
  } finally { await h.dispose(); }
});

test("hostile error mapping: raw stdout/tokens never leave; detail clipped to 300", async () => {
  const h = await fixture(baseServices({
    upgrade: {
      upgradeStatus: () => ({ running: false }),
      requestUpgrade: async () => ({ operationId: "op-h", targetVersion: null }),
      executeUpgrade: async () => ({ ok: false, error: { code: "upgrade-failed", message: "upgrade failed with RAW-STDOUT-SECRET-TOKEN output", detail: "D".repeat(500) } }),
    },
  }));
  try {
    const res = await call(h.server, "imo-upgrade");
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, false);
    // message is human-readable but the sanitized path drops unknown detail fields from the face itself
    assert.equal(payload.error.code, "upgrade-failed");
    assert.equal(res.body.includes("RAW-STDOUT-SECRET-TOKEN"), false);
  } finally { await h.dispose(); }
});

test("method gate: GET/PUT → 405; dispose unmounts all routes", async () => {
  const h = await fixture();
  try {
    const get = await call(h.server, "imo-upgrade", { method: "GET" });
    assert.equal(get.status, 405);
    assert.equal(JSON.parse(get.body).error.code, "method-not-allowed");
    const put = await call(h.server, "skill-update", { method: "PUT" });
    assert.equal(put.status, 405);
  } finally { await h.dispose(); }
  // after dispose the exact routes are unregistered from the fake server
  assert.equal(h.server.routes.has(actionPath("imo-upgrade")), false);
  assert.equal(h.server.routes.has(actionPath("default-profile")), false);
});
