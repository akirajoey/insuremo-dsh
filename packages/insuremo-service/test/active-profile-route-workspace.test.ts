import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { mountWriteRoutes } from "../src/overview/write-routes.ts";

function fakeWebServer() {
  const routes = new Map<string, (req: any, res: any) => void>();
  return {
    routes,
    register(route: { path: string; handler: (req: any, res: any) => void }) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
}

function response() {
  let settle!: () => void;
  const done = new Promise<void>(resolve => { settle = resolve; });
  const state = { status: 0, body: "", headers: {} as Record<string, string> };
  const res: any = {
    on: () => res,
    off: () => res,
    writeHead: (status: number, headers: Record<string, string>) => { state.status = status; state.headers = headers; },
    end: (body?: string) => { state.body = body ?? ""; settle(); },
    destroyed: false,
    writableEnded: false,
  };
  return { res, state, done };
}

function request(body: unknown): any {
  const text = JSON.stringify(body);
  return {
    method: "POST",
    headers: { host: "127.0.0.1:1", origin: "http://127.0.0.1:1", "x-workbench-action": "1", "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(text); },
  };
}

test("active-profile route carries only a validated workspace id and preserves scoped selection", async () => {
  const ctx = new Context();
  const server = fakeWebServer();
  ctx.provide("webServer" as never, server as never);
  const calls: unknown[][] = [];
  ctx.provide("workspaceRegistry" as never, { get: (id: string) => id === "workspace-a" ? { id, path: "/tmp/workspace-a" } : undefined } as never);
  ctx.provide("imoActiveProfile" as never, {
    select: async (...args: unknown[]) => { calls.push(args); return { ok: true, value: { activeProfileName: "global-profile", revision: 2 } }; },
  } as never);
  const dispose = mountWriteRoutes(ctx);
  const handler = server.routes.get("/api/icomposer-workbench/insuremo/overview/actions/active-profile")!;
  try {
    const success = response();
    handler(request({ profile: "global-profile", workspaceId: "workspace-a", cwd: "/forged" }), success.res);
    await success.done;
    assert.deepEqual(JSON.parse(success.state.body), { ok: true, result: { status: "completed", profile: "global-profile", revision: 2, workspaceId: "workspace-a" } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "global-profile");
    assert.equal(calls[0]?.[2], "workspace-a");

    const rejected = response();
    handler(request({ profile: "global-profile", workspaceId: "workspace-missing" }), rejected.res);
    await rejected.done;
    assert.equal(JSON.parse(rejected.state.body).error.code, "workspace-not-found");
    assert.equal(calls.length, 1);
  } finally {
    dispose();
  }
});
