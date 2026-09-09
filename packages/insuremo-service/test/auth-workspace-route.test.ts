import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { WebServer } from "../../../../deepseek-harness/packages/host/webserver/src/index.ts";
import { OVERVIEW_PATH } from "../src/overview/service.ts";
import { mountOverviewRoute } from "../src/overview/route.ts";

const VIEW = {
  schemaVersion: "0" as const,
  generatedAt: "now",
  imo: { status: "ok" as const, available: true, updateAvailable: false },
  auth: { status: "ok" as const, profiles: [], count: 0 },
  skills: { status: "ok" as const, installed: 0, valid: 0, enabled: 0, disabled: 0, names: [], entries: [], entriesTruncated: false, formatInvalidCount: 0, pathIssueCount: 0, diagnosticCount: 0, diagnostics: [], diagnosticsTruncated: false },
  operations: { status: "ok" as const, pending: 0, approved: 0, rejected: 0, recorded: 0, recent: [] },
  diagnostics: { status: "ok" as const, diagnostics: [] },
  ici: { status: "ok" as const, embeddingUrl: "", graphWorkspaces: 0, explainWorkspaces: 0 },
};

test("workspace overview resolves only registry ids and rejects stale or malformed selectors", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "task094-route-workspace-"));
  const ctx = new Context();
  const fiber = ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 });
  await fiber.await();
  const calls: unknown[][] = [];
  ctx.provide("workspaceRegistry" as never, {
    get(id: string) {
      return id === "workspace-a" ? { id, path: workspacePath } : undefined;
    },
  } as never);
  ctx.provide("imoOverview" as never, {
    snapshot: async (...args: unknown[]) => { calls.push(["full", ...args]); return VIEW; },
    snapshotFast: async (...args: unknown[]) => { calls.push(["fast", ...args]); return VIEW; },
  } as never);
  const dispose = mountOverviewRoute(ctx);
  const port = (ctx.get("webServer") as unknown as { port: number }).port;
  try {
    const valid = await fetch(`http://127.0.0.1:${port}${OVERVIEW_PATH}?fast=1&workspaceId=workspace-a&cwd=%2Fforged`);
    assert.equal(valid.status, 200);
    assert.deepEqual(calls.map(call => [call[0], call.length, call[2]]), [["fast", 3, "workspace-a"]]);

    const malformed = await fetch(`http://127.0.0.1:${port}${OVERVIEW_PATH}?workspaceId=../forged`);
    assert.equal(malformed.status, 400);
    const missing = await fetch(`http://127.0.0.1:${port}${OVERVIEW_PATH}?workspaceId=workspace-missing`);
    assert.equal(missing.status, 404);
    assert.equal(calls.length, 1);
  } finally {
    dispose();
    await fiber.dispose();
    await rm(workspacePath, { recursive: true, force: true });
  }
});
