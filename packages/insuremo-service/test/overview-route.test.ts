import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { WebServer } from "../../../../deepseek-harness/packages/host/webserver/src/index.ts";
import { OVERVIEW_PATH } from "../src/overview/service.ts";
import { mountOverviewRoute } from "../src/overview/route.ts";
import type { ImoOverviewView } from "../src/overview/types.ts";

const FIXTURE_VIEW: ImoOverviewView = {
  schemaVersion: "0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  imo: { status: "ok", available: true, current: "0.2.17", target: "0.2.18", updateAvailable: true },
  auth: { status: "ok", profiles: [{ name: "dev", isDefault: true }], count: 1, defaultProfile: "dev" },
  skills: { status: "ok", installed: 1, valid: 1, enabled: 1, disabled: 0, names: ["alpha"] },
  operations: { status: "ok", pending: 1, approved: 0, rejected: 0, recorded: 0, recent: [] },
  diagnostics: { status: "ok", diagnostics: [] },
};

async function fixture() {
  const ctx = new Context();
  const fiber = ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 });
  await fiber.await();
  const snapshot = async () => FIXTURE_VIEW;
  ctx.provide("imoOverview", { snapshot } as never);
  const disposable = mountOverviewRoute(ctx);
  const port = (ctx.get("webServer") as unknown as { port: number }).port;
  return { ctx, port, disposable, snapshot };
}

test("overview GET returns bounded JSON with safe headers", async () => {
  const fx = await fixture();
  try {
    const response = await fetch(`http://127.0.0.1:${fx.port}${OVERVIEW_PATH}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const body = await response.json() as { schemaVersion?: string; imo?: { available?: boolean } };
    assert.equal(body.schemaVersion, "0");
    assert.equal(body.imo?.available, true);
  } finally {
    await fx.ctx.fiber.dispose();
  }
});

test("overview rejects non-GET with Allow and 404s after the route is disposed", async () => {
  const fx = await fixture();
  try {
    const post = await fetch(`http://127.0.0.1:${fx.port}${OVERVIEW_PATH}`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
    const head = await fetch(`http://127.0.0.1:${fx.port}${OVERVIEW_PATH}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    fx.disposable();
    const after = await fetch(`http://127.0.0.1:${fx.port}${OVERVIEW_PATH}`);
    assert.equal(after.status, 404);
  } finally {
    await fx.ctx.fiber.dispose();
  }
});
