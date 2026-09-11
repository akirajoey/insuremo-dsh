import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import WorkbenchDistService from "../src/index.ts";

/**
 * TASK-105 FIX: dist-level aggregate smoke.
 *
 * TASK-102 added `iciExplainConfig` to the explain services' inject lists, but
 * the packaging aggregate never mounted `ExplainConfigService`, so in the
 * shipped bundle `ExplainScheduler`/`ExplainRoutesService` stayed dormant and
 * every `/api/icomposer-workbench/ici/explain/*` request 404'd. This test
 * mounts the REAL aggregate with minimal host faces and asserts the mounted
 * service set, the explain route prefix, and the explain HTTP contract — the
 * integration level the source-package suites cannot cover.
 */

const HOST_FACES: Record<string, unknown> = {
  subprocess: {
    resolveExecutable: async (command: string) => `/usr/bin/${command}`,
    spawn: () => ({ collected: {}, done: Promise.resolve({ exitCode: 0, signal: null }) }),
  },
  storageDomain: {
    open: async () => ({
      global: { get: () => ({ maxConcurrent: 4 }), set: async () => {} },
      table: () => ({ get: () => undefined, entries: () => [], keys: () => [], size: 0, put: async () => {}, delete: async () => false, update: async (_key: string, fn: (value: unknown) => unknown) => fn(undefined) }),
      close: async () => {},
    }),
  },
  workspaceRegistry: { list: () => [], get: () => undefined },
  skills: { registerProvider: () => () => {}, snapshot: async () => ({ skills: [] }), on: () => () => {} },
  tools: { register: () => () => {}, restrict: () => {}, get: () => undefined, schemas: () => [] },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
  jobs: { start: () => "job-1" },
  llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => undefined },
  agents: { roots: () => [], get: () => undefined, list: () => [], register: () => () => {} },
  directoryPicker: { capability: () => undefined },
};

interface RegisteredRoute {
  readonly kind: string;
  readonly path: string;
  readonly handler: (req: unknown, res: unknown) => void | Promise<void>;
}

interface FakeResponse {
  status: number;
  body: string;
  destroyed: boolean;
  writableEnded: boolean;
  writeHead(status: number): void;
  end(body?: string): void;
}

function fakeRequest(method: string, url: string, headers: Record<string, string> = {}, body?: unknown): unknown {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return {
    method,
    url,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "content-length": String(bytes.byteLength),
    },
    on: () => undefined,
    async *[Symbol.asyncIterator]() {
      if (bytes.byteLength > 0) yield bytes;
    },
  };
}

function fakeResponse(): FakeResponse {
  const response: FakeResponse = {
    status: 0,
    body: "",
    destroyed: false,
    writableEnded: false,
    writeHead(status: number) { response.status = status; },
    end(body?: string) { response.body = body ?? ""; response.writableEnded = true; },
  };
  return response;
}

async function mountAggregate(): Promise<{ ctx: Context; routes: RegisteredRoute[]; dispose(): Promise<void> }> {
  const routes: RegisteredRoute[] = [];
  const ctx = new Context();
  for (const [name, value] of Object.entries(HOST_FACES)) ctx.provide(name, value as never);
  ctx.provide("webServer", {
    register(route: RegisteredRoute) {
      routes.push(route);
      return () => undefined;
    },
  } as never);
  const fiber = ctx.plugin(WorkbenchDistService as never);
  await fiber.await();
  // Service activation is inject-driven; allow pending fibers to settle.
  await new Promise(resolve => setTimeout(resolve, 300));
  return {
    ctx, routes,
    dispose: async () => { await ctx.fiber.dispose(); },
  };
}

const isActive = (ctx: Context, name: string): boolean => {
  try {
    return ctx.get(name as never) !== undefined;
  } catch {
    return false;
  }
};

const dispatch = async (routes: RegisteredRoute[], method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<FakeResponse> => {
  const route = routes.find(candidate => candidate.kind === "prefix" && url.startsWith(candidate.path));
  assert.ok(route, `no aggregate route covers ${url}`);
  const response = fakeResponse();
  await route.handler(fakeRequest(method, url, headers, body), response);
  return response;
};

test("TASK-105 FIX: the shipped aggregate activates every mounted service, including iciExplainConfig", async () => {
  const fx = await mountAggregate();
  try {
    const expected = [
      "imoCli", "imoSkills", "imoAuth", "imoAuthActions", "imoActiveProfile", "imoOverview", "imoSkillActions",
      "insuremoSkillProvider", "operationLog", "workspaceBinding", "icomposerCatalog", "icomposerReference",
      "icomposerLifecycle", "icomposerVerify", "iciContext", "iciEngine", "iciExplainConfig", "iciExplainScheduler",
      "iciExplainRoutes", "icomposerVerifyTools", "icomposerWrite",
    ];
    const inactive = expected.filter(name => !isActive(fx.ctx, name));
    assert.deepEqual(inactive, [], "services whose inject is unsatisfied in the aggregate");
  } finally {
    await fx.dispose();
  }
});

test("TASK-105 FIX: the aggregate registers the explain route prefix and serves its JSON contract", async () => {
  const fx = await mountAggregate();
  try {
    const explain = fx.routes.filter(route => route.path.includes("/ici/explain"));
    assert.deepEqual(explain.map(route => route.path), ["/api/icomposer-workbench/ici/explain"]);

    // Explain settings endpoint: action-header gate answers JSON 405, not a text 404.
    const missingHeader = await dispatch(fx.routes, "POST", "/api/icomposer-workbench/ici/explain/settings", {}, { maxConcurrent: 8 });
    assert.equal(missingHeader.status, 405);
    assert.deepEqual(JSON.parse(missingHeader.body), { ok: false, error: { code: "method-not-allowed", message: "method-not-allowed" } });

    const applied = await dispatch(fx.routes, "POST", "/api/icomposer-workbench/ici/explain/settings", { "x-workbench-action": "1" }, { maxConcurrent: 8 });
    assert.equal(applied.status, 200);
    assert.deepEqual(JSON.parse(applied.body), { ok: true, result: { maxConcurrent: 8, inFlight: 0 } });

    const invalid = await dispatch(fx.routes, "POST", "/api/icomposer-workbench/ici/explain/settings", { "x-workbench-action": "1" }, { maxConcurrent: 0 });
    assert.equal(invalid.status, 422);
    assert.equal(JSON.parse(invalid.body).error.code, "invalid-input");

    // A real request reaches the routes service and answers the JSON job-missing envelope.
    for (const url of [
      "/api/icomposer-workbench/ici/explain/jobs/0123456789abcdef/status",
      "/api/icomposer-workbench/ici/explain/batches/0123456789abcdef/status",
    ]) {
      const missing = await dispatch(fx.routes, "GET", url);
      assert.equal(missing.status, 404, url);
      assert.deepEqual(JSON.parse(missing.body), { ok: false, error: { code: "job-missing", message: "job-missing" } });
    }
  } finally {
    await fx.dispose();
  }
});
