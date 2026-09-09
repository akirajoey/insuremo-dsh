import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { mountSkillCatalogRoute } from "../src/overview/skill-catalog-route.ts";
import { mountWriteRoutes } from "../src/overview/write-routes.ts";
import { SKILL_CATALOG_PATH } from "../src/overview/paths.ts";
import type { SkillCatalogSnapshot } from "../src/skill-actions/catalog.ts";

interface FakeWebServer {
  routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void>;
  register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void;
}

function webServer(): FakeWebServer {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
  return {
    routes,
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
}

function response(): any {
  let settle!: () => void;
  const done = new Promise<void>(resolve => { settle = resolve; });
  const state = { status: 0, headers: {} as Record<string, string | undefined>, body: "", done };
  const result = {
    destroyed: false,
    on() { return this; },
    off() { return this; },
    writeHead(status: number, headers: Record<string, string>) { state.status = status; state.headers = { ...state.headers, ...headers }; (this as any).status = status; (this as any).headers = state.headers; return this; },
    end(body?: string) { state.body = typeof body === "string" ? body : ""; (this as any).body = state.body; settle(); return this; },
  };
  Object.defineProperty(result, "writableEnded", { get: () => state.status >= 200 });
  (result as any).status = state.status;
  (result as any).headers = state.headers;
  (result as any).body = state.body;
  return Object.assign(result, { done: state.done });
}

function request(method = "GET", body = "{}", headers: Record<string, string> = {}): IncomingMessage {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() { if (body.length > 0) yield Buffer.from(body, "utf8"); },
  } as unknown as IncomingMessage;
}

const snapshot: SkillCatalogSnapshot = {
  schemaVersion: "1",
  status: "ready",
  source: "insuremo-skills",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:01:00.000Z",
  entries: [
    { type: "scenario", name: "ask-insuremo", description: "Scenario" },
    { type: "skill", name: "alpha-skill", description: "Alpha" },
  ],
};

function writeHeaders(): Record<string, string> {
  return { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", "x-workbench-action": "1", "content-type": "application/json" };
}

test("Skills catalog GET is cache-only and distinguishes an unavailable cache", async () => {
  const ctx = new Context();
  const server = webServer();
  ctx.provide("webServer" as never, server as never);
  let refreshCalls = 0;
  ctx.provide("imoSkillActions" as never, {
    getCatalog: async () => ({ ok: false, error: { code: "catalog-unavailable", message: "hidden" } }),
    refreshCatalog: async () => { refreshCalls += 1; return { ok: true, value: snapshot }; },
    runDirect: async () => ({ ok: true, receipt: { status: "completed" } }),
  } as never);
  const dispose = mountSkillCatalogRoute(ctx as never);
  try {
    const res = response();
    server.routes.get(SKILL_CATALOG_PATH)!(request(), res as ServerResponse);
    await res.done;
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: "catalog-unavailable", message: "the trusted Skills catalog is unavailable; refresh it explicitly" } });
    assert.equal(refreshCalls, 0);
    const post = response();
    server.routes.get(SKILL_CATALOG_PATH)!(request("POST", "{}", writeHeaders()), post as ServerResponse);
    await post.done;
    assert.equal(post.status, 405);
  } finally { dispose(); }
});

test("catalog GET drops malformed face metadata instead of exposing it", async () => {
  const ctx = new Context();
  const server = webServer();
  ctx.provide("webServer" as never, server as never);
  ctx.provide("imoSkillActions" as never, {
    getCatalog: async () => ({ ok: true, value: { ...snapshot, entries: [{ type: "skill", name: "../../secret", description: "/private/path" }] } }),
  } as never);
  const dispose = mountSkillCatalogRoute(ctx as never);
  try {
    const res = response();
    server.routes.get(SKILL_CATALOG_PATH)!(request(), res as ServerResponse);
    await res.done;
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: "catalog-unavailable", message: "the trusted Skills catalog is unavailable" } });
    assert.equal(res.body.includes("/private/path"), false);
  } finally { dispose(); }
});

test("catalog refresh is explicit POST and single-skill install revalidates exact names", async () => {
  const ctx = new Context();
  const server = webServer();
  ctx.provide("webServer" as never, server as never);
  let refreshCalls = 0;
  const directInputs: unknown[] = [];
  ctx.provide("imoSkillActions" as never, {
    getCatalog: async () => ({ ok: true, value: snapshot }),
    refreshCatalog: async (_signal?: AbortSignal, force?: boolean) => { refreshCalls += force === true ? 10 : 1; return { ok: true, value: snapshot }; },
    runDirect: async (input: unknown) => { directInputs.push(input); return { ok: true, receipt: { status: "completed" } }; },
  } as never);
  const disposeRead = mountSkillCatalogRoute(ctx as never);
  const disposeWrite = mountWriteRoutes(ctx as never);
  try {
    const refresh = response();
    server.routes.get("/api/icomposer-workbench/insuremo/overview/actions/skill-catalog-refresh")!(request("POST", JSON.stringify({ force: true }), writeHeaders()), refresh as ServerResponse);
    await refresh.done;
    assert.equal(JSON.parse(refresh.body).ok, true);
    assert.equal(refreshCalls, 10);

    const valid = response();
    server.routes.get("/api/icomposer-workbench/insuremo/overview/actions/skill-install")!(request("POST", JSON.stringify({ skill: "alpha-skill" }), writeHeaders()), valid as ServerResponse);
    await valid.done;
    assert.equal(JSON.parse(valid.body).ok, true);
    assert.deepEqual(directInputs, [{ kind: "skill-install", source: { type: "alias", value: "insuremo-skills" }, agent: "universal", skills: ["alpha-skill"] }]);

    for (const skill of ["../../evil", "not-listed", "--help"]) {
      const invalid = response();
      server.routes.get("/api/icomposer-workbench/insuremo/overview/actions/skill-install")!(request("POST", JSON.stringify({ skill }), writeHeaders()), invalid as ServerResponse);
      await invalid.done;
      assert.equal(JSON.parse(invalid.body).ok, false);
    }
    const mixed = response();
    server.routes.get("/api/icomposer-workbench/insuremo/overview/actions/skill-install")!(request("POST", JSON.stringify({ scenario: "ask-insuremo", skill: "alpha-skill" }), writeHeaders()), mixed as ServerResponse);
    await mixed.done;
    assert.equal(JSON.parse(mixed.body).ok, false);
    assert.equal(directInputs.length, 1);
  } finally { disposeWrite(); disposeRead(); }
});
