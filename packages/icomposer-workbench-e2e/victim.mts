/**
 * Stability victim: builds the large stress fixture under the e2e DSH_HOME.
 * The parent runner SIGKILLs this process mid-build and then asserts the
 * previously promoted `current` snapshot survived byte-intact (TASK-026
 * atomic-promote semantics verified at script level).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { buildLargeWorkspaceFixture } from "./fixtures.mts";

const workspaceRoot = process.env.E2E_STRESS_ROOT;
if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
  console.error("victim: E2E_STRESS_ROOT not set");
  process.exit(2);
}

const ctx = new Context();
ctx.provide("workspaceBinding", { get: async () => ({ ok: true, value: { binding: { authProfile: "portal:demo", environmentId: "portal:microsite" }, canonicalPath: workspaceRoot } }) } as never);
ctx.provide("imoAuth" as never, { prepare: async () => ({ ok: false, error: { code: "invalid-auth" } }) } as never);
ctx.provide("jobs" as never, { start: () => { throw new Error("jobs not expected"); } } as never);

const { IciEngineService } = await import("../icomposer-code-intelligence/src/service.ts");
// large catalog stub: the workspaceBinding gives canonicalPath; catalog feeds entries
const { entries } = { entries: await (async () => {
  // The engine derives sources from the catalog face; reuse the generator listing.
  const listing = await buildLargeWorkspaceFixture(workspaceRoot, 5000);
  void mkdtemp(join(tmpdir(), "victim-noop-"));
  return listing.entries;
})() };
ctx.provide("icomposerCatalog" as never, {
  listAssets: async () => ({ ok: true, value: { entries, counts: { api: 5000, function: 1, batch: 0, model: 0, total: 5001 }, truncated: false } }),
} as never);

const fiber = await ctx.plugin(IciEngineService as never);
await fiber.await();
const engine = ctx.get("iciEngine") as unknown as { build(input: unknown, options?: unknown): Promise<unknown> };
console.log("victim: build starting");
const result = await engine.build({ workspaceId: "stress" });
console.log(`victim: build finished ${JSON.stringify(result)}`);
process.exit(0);
