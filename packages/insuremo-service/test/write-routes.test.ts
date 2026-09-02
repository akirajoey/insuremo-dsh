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
  imoInstall?: unknown;
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
    imoInstall: overrides.imoInstall ?? {
      installStatus: () => ({ running: false }),
      install: async () => ({ ok: true, receipt: { status: "completed", packageManager: "npm", after: "0.2.14" } }),
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

test("TASK-076 imo-install: POST envelope, result mapping, and error passthrough", async () => {
  const h = await fixture();
  try {
    // Body is ignored by design (constants live server-side).
    const ok = await call(h.server, "imo-install", { body: JSON.stringify({ registry: "https://evil.example", package: "@evil/x" }) });
    assert.equal(ok.status, 200);
    const okBody = JSON.parse(ok.body);
    assert.equal(okBody.ok, true);
    assert.equal(okBody.result.status, "completed");
    assert.equal(okBody.result.packageManager, "npm");
    assert.equal(okBody.result.currentVersion, "0.2.14");

    const busy = await fixture(baseServices({
      imoInstall: { installStatus: () => ({ running: true }), install: async () => ({ ok: false, error: { code: "busy" } }) },
    }));
    try {
      const busyResponse = await call(busy.server, "imo-install");
      assert.equal(busyResponse.status, 200);
      assert.equal(JSON.parse(busyResponse.body).error.code, "busy");
    } finally { await busy.dispose(); }

    const rejected = await fixture(baseServices({
      imoInstall: {
        installStatus: () => ({ running: false }),
        install: async () => ({ ok: false, error: { code: "already-installed", message: "IMO CLI is already installed (version 0.2.14)" } }),
      },
    }));
    try {
      const response = await call(rejected.server, "imo-install");
      assert.equal(response.status, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "already-installed");
    } finally { await rejected.dispose(); }
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
    // TASK-041 last-write-wins: no expectedRevision → commits without CAS and
    // returns the fresh revision (route passes undefined through).
    const noCas = await call(h.server, "skill-activation", { body: JSON.stringify({ name: "imo-audit-helper", enabled: false }) });
    const noCasPayload = JSON.parse(noCas.body);
    assert.deepEqual(noCasPayload, { ok: true, result: { name: "imo-audit-helper", enabled: false, revision: 7 } });
  } finally { await h.dispose(); }
});

test("skill scenario/update/remove direct kernels + default-profile direct", async () => {
  const directCalls: string[] = [];
  const services = baseServices({
    skillActions: {
      runDirect: async (input: { kind: string; source?: unknown; agent?: string; skills?: readonly string[]; names?: readonly string[] }) => {
        directCalls.push(`${input.kind}:${JSON.stringify(input.source ?? input.names ?? "all")}:${input.agent ?? ""}`);
        if (input.kind === "skill-remove") return { ok: true, receipt: { status: "completed", beforeCount: 2, afterCount: 1, added: [], removed: ["old-skill"], updated: [] } };
        if (input.kind === "skill-install") return { ok: true, receipt: { status: "completed", beforeCount: 1, afterCount: 3, added: ["insuremo-auth-cli", "insuremo-deep-search"], removed: [], updated: [] } };
        return { ok: true, receipt: { status: "completed", beforeCount: 2, afterCount: 2, added: [], removed: [], updated: ["a", "b"] } };
      },
    },
    authActions: {
      runDirectDefaultSwitch: async (input: { profile: string }) => { directCalls.push(`default:${input.profile}`); return { ok: true, receipt: { status: "completed" } }; },
    },
  });
  const h = await fixture(services);
  try {
    // update: the whole body is ignored by design (whole-inventory scope).
    const update = await call(h.server, "skill-update", { body: JSON.stringify({ junk: true, agent: "evil" }) });
    assert.deepEqual(JSON.parse(update.body).result, { status: "completed", beforeCount: 2, afterCount: 2, added: [], removed: [], updated: ["a", "b"] });
    // install: scenario-only, allowlisted, server-owned argv shape.
    const install = await call(h.server, "skill-install", { body: JSON.stringify({ scenario: "ask-insuremo", source: "https://evil", agent: "codex" }) });
    assert.deepEqual(JSON.parse(install.body).result, { status: "completed", beforeCount: 1, afterCount: 3, added: ["insuremo-auth-cli", "insuremo-deep-search"], removed: [], updated: [] });
    const remove = await call(h.server, "skill-remove", { body: JSON.stringify({ name: "old-skill" }) });
    assert.deepEqual(JSON.parse(remove.body).result, { status: "completed", beforeCount: 2, afterCount: 1, added: [], removed: ["old-skill"], updated: [] });
    const dp = await call(h.server, "default-profile", { body: JSON.stringify({ profile: "portal:mo-re" }) });
    assert.deepEqual(JSON.parse(dp.body).result, { status: "completed", profile: "portal:mo-re" });
    assert.deepEqual(directCalls, [
      'skill-update:"all":',
      'skill-install:{"type":"scenario","scenario":"ask-insuremo"}:universal',
      'skill-remove:["old-skill"]:universal',
      "default:portal:mo-re",
    ]);
    // Unknown/malformed scenario is rejected with zero action calls.
    const attempts = directCalls.length;
    for (const scenario of ["not-allowed", 42, undefined, "../../evil", "ask-insuremo "]) {
      const bad = await call(h.server, "skill-install", { body: JSON.stringify({ scenario }) });
      assert.equal(JSON.parse(bad.body).error.code, "invalid-input");
    }
    assert.equal(directCalls.length, attempts);
  } finally { await h.dispose(); }
});

test("failed and partial skill receipts stay structured ok envelopes; UI must inspect status", async () => {
  for (const [status, diff] of [
    ["failed", { added: [], removed: [], updated: [] }],
    ["partial-failure", { added: ["insuremo-auth-cli"], removed: ["stale"], updated: [] }],
  ] as const) {
    const h = await fixture(baseServices({
      skillActions: { runDirect: async () => ({ ok: true, receipt: { status, beforeCount: 2, afterCount: 3, ...diff } }) },
    }));
    try {
      const res = await call(h.server, "skill-install", { body: JSON.stringify({ scenario: "uic-developer" }) });
      const payload = JSON.parse(res.body);
      assert.equal(payload.ok, true);
      assert.equal(payload.result.status, status);
      assert.deepEqual(payload.result.added, diff.added);
      assert.deepEqual(payload.result.removed, diff.removed);
      assert.deepEqual(payload.result.updated, diff.updated);
    } finally { await h.dispose(); }
  }
  const h2 = await fixture(baseServices({
    skillActions: { runDirect: async () => ({ ok: false, error: { code: "tool-unavailable", message: "npx is unavailable" } }) },
  }));
  try {
    const res = await call(h2.server, "skill-install", { body: JSON.stringify({ scenario: "uic-developer" }) });
    assert.equal(JSON.parse(res.body).error.code, "tool-unavailable");
  } finally { await h2.dispose(); }
});

test("TASK-047 active-profile route delegates only to Active Profile and maps failures", async () => {
  const calls: string[] = [];
  const h = await fixture(baseServices({
    authActions: { runDirectDefaultSwitch: async () => { calls.push("default"); return { ok: true, receipt: { status: "completed" } }; } },
  }));
  try {
    const unavailable = await call(h.server, "active-profile", { body: JSON.stringify({ profile: "a" }) });
    assert.equal(JSON.parse(unavailable.body).error.code, "service-unavailable");
    const active = {
      select: async (name: string) => {
        calls.push(`active:${name}`);
        if (name === "bad") return { ok: false, error: { code: "invalid-profile", message: "profile is not available" } };
        if (name === "down") return { ok: false, error: { code: "unavailable", message: "unavailable" } };
        return { ok: true, value: { activeProfileName: name, revision: 4 } };
      },
    };
    h.ctx.provide("imoActiveProfile" as never, active as never);
    const success = await call(h.server, "active-profile", { body: JSON.stringify({ profile: "good" }) });
    assert.deepEqual(JSON.parse(success.body), { ok: true, result: { status: "completed", profile: "good", revision: 4 } });
    const invalid = await call(h.server, "active-profile", { body: JSON.stringify({ profile: "bad" }) });
    assert.equal(JSON.parse(invalid.body).error.code, "invalid-profile");
    const failure = await call(h.server, "active-profile", { body: JSON.stringify({ profile: "down" }) });
    assert.equal(JSON.parse(failure.body).error.code, "unavailable");
    const missing = await call(h.server, "active-profile", { body: JSON.stringify({}) });
    assert.equal(JSON.parse(missing.body).error.code, "invalid-input");
    assert.deepEqual(calls, ["active:good", "active:bad", "active:down"]);
  } finally { await h.dispose(); }
  assert.equal(h.server.routes.has(actionPath("active-profile")), false);
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
