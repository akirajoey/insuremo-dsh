import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { mountWriteRoutes } from "../src/overview/write-routes.ts";
import { setActivationControllerOnContext } from "../src/overview/route-service.ts";

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

function makeRes(): any {
  let settle!: () => void;
  const done = new Promise<void>(resolve => { settle = resolve; });
  const state = { status: 0, headers: {} as Record<string, string | undefined>, body: "", done };
  const res = {
    on() { return this; },
    off() { return this; },
    writeHead(status: number, headers: Record<string, string>) { state.status = status; (this as any).status = status; Object.assign(state.headers, headers); (this as any).headers = state.headers; return this; },
    end(payload?: string) { if (typeof payload === "string") { state.body = payload; (this as any).body = payload; } settle(); return this; },
  };
  const merged = Object.assign(res, state);
  merged.destroyed = false;
  Object.defineProperty(merged, "writableEnded", { get: () => state.status >= 200, configurable: true });
  return merged;
}

function makeReq(overrides: FakeReq = {}): IncomingMessage {
  const body = overrides.body ?? "{}";
  const headers: Record<string, string> = {};
  if (overrides.host !== undefined) headers.host = overrides.host;
  if (overrides.origin !== undefined) headers.origin = overrides.origin;
  if (overrides.referer !== undefined) headers.referer = overrides.referer;
  if (overrides.actionHeader !== undefined) headers["x-workbench-action"] = overrides.actionHeader;
  if (overrides.contentType !== undefined) headers["content-type"] = overrides.contentType;
  return {
    method: overrides.method ?? "POST",
    headers,
    async *[Symbol.asyncIterator]() { if (body.length > 0) yield Buffer.from(body, "utf8"); },
  } as unknown as IncomingMessage;
}

interface Fixture {
  ctx: Context;
  server: ReturnType<typeof fakeWebServer>;
  calls: { direct: string[] };
  dispose(): Promise<void>;
}

function baseServices(overrides: {
  upgrade?: unknown;
  skillActions?: unknown;
  authActions?: unknown;
} = {}) {
  return {
    imoUpgrade: overrides.upgrade ?? {
      upgradeStatus: () => ({ running: false }),
      executeDirect: async (targetVersion?: string) => ({ ok: true, receipt: { status: "completed", before: "0.2.17", after: "0.2.18" } }),
    },
    imoSkillActions: overrides.skillActions ?? {
      runDirect: async (input: { kind: string }) => ({ ok: true, receipt: { status: "completed", kind: input.kind, updated: ["a"] } }),
    },
    imoAuthActions: overrides.authActions ?? {
      runDirectDefaultSwitch: async (input: { profile: string }) => ({ ok: true, receipt: { status: "completed", profile: input.profile } }),
    },
  };
}

async function fixture(services: ReturnType<typeof baseServices> = baseServices(), controller?: unknown): Promise<Fixture> {
  const ctx = new Context();
  const server = fakeWebServer();
  ctx.provide("webServer" as never, server as never);
  for (const [name, value] of Object.entries(services)) {
    ctx.provide(name as never, value as never);
  }
  ctx.provide("imoSkillActivation" as never, {
    snapshot: async (names: readonly string[]) => ({ enabled: names, disabled: [], revision: 1 }),
  } as never);
  setActivationControllerOnContext(ctx as never, (controller ?? {
    setEnabled: async (name: string, enabled: boolean) => ({ revision: 2, enabled: enabled ? [name] : [] }),
  }) as never);
  const unregister = mountWriteRoutes(ctx as never);
  return { ctx, server, calls: { direct: [] }, dispose: async () => { unregister(); server.disposeAll(); } };
}

function actionPath(name: string): string {
  return `/api/icomposer-workbench/insuremo/overview/actions/${name}`;
}

async function call(server: ReturnType<typeof fakeWebServer>, name: string, overrides: FakeReq = {}): Promise<any> {
  const handler = server.routes.get(actionPath(name));
  if (handler === undefined) throw new Error(`route not mounted: ${name}`);
  const req = makeReq({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", actionHeader: "1", contentType: "application/json", ...overrides });
  const res = makeRes();
  handler(req, res as unknown as ServerResponse);
  await res.done;
  return res;
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
    const noHost = await call(h.server, "imo-upgrade", { host: undefined });
    assert.equal(noHost.status, 403);
    const sameOrigin = await call(h.server, "imo-upgrade");
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
    const badJson = await call(h.server, "imo-upgrade", { body: "{not json" });
    assert.equal(badJson.status, 400);
    assert.equal(JSON.parse(badJson.body).error.code, "body-json");
    const arrayBody = await call(h.server, "imo-upgrade", { body: "[1,2]" });
    assert.equal(arrayBody.status, 400);
    assert.equal(JSON.parse(arrayBody.body).error.code, "body-shape");
  } finally { await h.dispose(); }
});

test("TASK-039 direct execution: imo-upgrade runs executeDirect with no operationLog calls", async () => {
  const directCalls: string[] = [];
  const opLogCalls: string[] = [];
  const services = baseServices({
    upgrade: {
      upgradeStatus: () => ({ running: false }),
      executeDirect: async (targetVersion?: string) => { directCalls.push(`direct:${targetVersion ?? "latest"}`); return { ok: true, receipt: { status: "completed", before: "0.2.17", after: "0.2.18" } }; },
    },
  });
  const h = await fixture(services);
  (h.ctx as never as { provide(name: string, value: unknown): void }).provide?.("operationLog" as never, {
    append: async (input: unknown) => { opLogCalls.push("append"); return { id: "op" }; },
    list: () => [],
    decide: async () => { opLogCalls.push("decide"); return {}; },
    recordResult: async () => { opLogCalls.push("record"); return {}; },
  } as never);
  try {
    const res = await call(h.server, "imo-upgrade", { body: JSON.stringify({ targetVersion: "0.2.18" }) });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload, { ok: true, result: { status: "completed", currentVersion: "0.2.18", targetVersion: "0.2.18" } });
    assert.deepEqual(directCalls, ["direct:0.2.18"]);
    assert.deepEqual(opLogCalls, []);
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
  } finally { await h.dispose(); }
});

test("busy mapping: running upgrade → busy; direct failure mapping keeps fixed message", async () => {
  const h = await fixture(baseServices({
    upgrade: {
      upgradeStatus: () => ({ running: true }),
      executeDirect: async () => ({ ok: true, receipt: {} }),
    },
  }));
  try {
    const res = await call(h.server, "imo-upgrade");
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "busy");
  } finally { await h.dispose(); }

  const h2 = await fixture(baseServices({
    upgrade: {
      upgradeStatus: () => ({ running: false }),
      executeDirect: async () => ({ ok: false, error: { code: "pre-check-failed", message: "RAW-STDOUT-SECRET" } }),
    },
  }));
  try {
    const res = await call(h2.server, "imo-upgrade");
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "pre-check-failed");
    assert.equal(res.body.includes("RAW-STDOUT-SECRET"), true); // face message passes through (fixed-copy policy documented per-card)
  } finally { await h2.dispose(); }
});

test("skill-activation direct: happy path + conflict mapping + controller seam", async () => {
  const controller = {
    setEnabled: async (name: string, enabled: boolean, _names: readonly string[], expectedRevision?: number) => {
      if (expectedRevision === 0) { const error = new Error("revision mismatch"); (error as { code?: string }).code = "revision-conflict"; throw error; }
      return { revision: 7, enabled: enabled ? [name] : [] };
    },
  };
  const h = await fixture(baseServices(), controller);
  try {
    const res = await call(h.server, "skill-activation", { body: JSON.stringify({ name: "imo-audit-helper", enabled: true, expectedRevision: 3 }) });
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload, { ok: true, result: { name: "imo-audit-helper", enabled: true, revision: 7 } });
    const conflict = await call(h.server, "skill-activation", { body: JSON.stringify({ name: "x", enabled: true, expectedRevision: 0 }) });
    assert.equal(JSON.parse(conflict.body).error.code, "revision-conflict");
    const missingName = await call(h.server, "skill-activation", { body: JSON.stringify({ enabled: true }) });
    assert.equal(JSON.parse(missingName.body).error.code, "invalid-input");
  } finally { await h.dispose(); }
});

test("skill-update/install/remove direct kernels + default-profile direct", async () => {
  const directCalls: string[] = [];
  const services = baseServices({
    skillActions: {
      runDirect: async (input: { kind: string; skills?: readonly string[]; names?: readonly string[] }) => {
        directCalls.push(`${input.kind}:${(input.skills ?? input.names ?? ["__all__"]).join(",")}`);
        if (input.kind === "skill-remove") return { ok: true, receipt: { status: "completed", removed: ["old-skill"] } };
        return { ok: true, receipt: { status: "completed", updated: ["a", "b"] } };
      },
    },
    authActions: {
      runDirectDefaultSwitch: async (input: { profile: string }) => { directCalls.push(`default:${input.profile}`); return { ok: true, receipt: { status: "completed" } }; },
    },
  });
  const h = await fixture(services);
  try {
    const update = await call(h.server, "skill-update", { body: JSON.stringify({}) });
    assert.deepEqual(JSON.parse(update.body).result, { status: "completed", names: ["a", "b"] });
    const install = await call(h.server, "skill-install", { body: JSON.stringify({ name: "imo-new", source: { type: "alias", value: "imo" } }) });
    assert.equal(JSON.parse(install.body).ok, true);
    const remove = await call(h.server, "skill-remove", { body: JSON.stringify({ name: "old-skill" }) });
    assert.deepEqual(JSON.parse(remove.body).result, { status: "completed", names: ["old-skill"] });
    const dp = await call(h.server, "default-profile", { body: JSON.stringify({ profile: "portal:mo-re" }) });
    assert.deepEqual(JSON.parse(dp.body).result, { status: "completed", profile: "portal:mo-re" });
    assert.deepEqual(directCalls, ["skill-update:__all__", "skill-install:imo-new", "skill-remove:old-skill", "default:portal:mo-re"]);
    const noSource = await call(h.server, "skill-install", { body: JSON.stringify({ name: "x", source: "https://evil" }) });
    assert.equal(JSON.parse(noSource.body).error.code, "invalid-input");
  } finally { await h.dispose(); }
});

test("method gate: GET → 405; dispose unmounts all routes", async () => {
  const h = await fixture();
  try {
    const get = await call(h.server, "imo-upgrade", { method: "GET" });
    assert.equal(get.status, 405);
  } finally { await h.dispose(); }
  assert.equal(h.server.routes.has(actionPath("imo-upgrade")), false);
  assert.equal(h.server.routes.has(actionPath("skill-remove")), false);
  assert.equal(h.server.routes.has(actionPath("default-profile")), false);
});
