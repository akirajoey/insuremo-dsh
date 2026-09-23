import { existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { IciEngineService } from "../src/service.ts";

/**
 * TASK-132: capability discovery must work without an Active Profile, without the network and
 * without an embedding index. The engine falls back to a local term-frequency ranking over the same
 * explanation docs and marks the result `degraded`; these tests pin that path and the field quality
 * gate ("which APIs can modify group policy member" -> AddGroupMemberAPI in the top five).
 */

const FIELD_ROOT = "/Users/junjie.zhang/skills/gbs/icomposer-source";

async function engineFor(root: string, profileOk: boolean): Promise<{ engine: any; dispose: () => Promise<void> }> {
  const ctx: any = new Context();
  ctx.provide("workspaceBinding", { list: async () => ({ ok: true, value: [{ workspaceId: "ws", canonicalPath: root }] }), get: async () => ({ ok: true, value: { workspaceId: "ws", canonicalPath: root } }) });
  ctx.provide("icomposerCatalog", { listAssets: async () => ({ ok: true, value: { entries: [], counts: { api: 0, function: 0, batch: 0, model: 0, total: 0 }, truncated: false } }), listSourcesComplete: async () => ({ ok: true, value: { entries: [], duplicateNames: [] } }) });
  ctx.provide("imoAuth", { prepare: async () => (profileOk ? { ok: true, value: { token: "t" } } : { ok: false, error: { code: "invalid-auth" } }) });
  ctx.provide("imoActiveProfile", { get: async () => (profileOk ? { ok: true, value: { status: "active", activeProfileName: "portal:demo", profile: { profileName: "portal:demo" } } } : { ok: false, error: { code: "invalid-auth", message: "no active profile" } }) });
  ctx.provide("jobs", { start: () => { throw new Error("jobs registry not wired"); } });
  const fiber: any = await ctx.plugin(IciEngineService); await fiber.await();
  return { engine: ctx.get("iciEngine"), dispose: () => fiber.dispose() };
}

test("TASK-132 (1) without an Active Profile the engine ranks locally instead of failing closed", async (t) => {
  if (!existsSync(join(FIELD_ROOT, ".metadata/icomposer/ici/graph/current/manifest.json"))) { t.skip("field workspace not available on this machine"); return; }
  const { engine, dispose } = await engineFor(FIELD_ROOT, false);
  try {
    const result: any = await engine.search({ workspaceId: "ws", query: "add a member to a group policy", mode: "business", top: 10 });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.value.degraded, true, "the local ranking is marked degraded");
    assert.match(String(result.value.degradedReason), /no-profile/, "the reason names the missing profile");
    assert.ok((result.value.rows ?? []).length > 0, "local ranking still returns candidates");
    assert.equal(result.value.rows[0].apiName, "AddGroupMemberAPI", "the best local hit is the member-adding API");
    assert.equal(result.value.rows.some((row: any) => String(row.evidence).includes("business")), true, "evidence says which text matched");
    // No profile + no embedding call: this path is fully offline and read-only.
  } finally { await dispose(); }
});

test("TASK-132 (2) the quality gate: 'group policy member' finds AddGroupMemberAPI in the top five (field workspace, read-only)", async (t) => {
  if (!existsSync(join(FIELD_ROOT, ".metadata/icomposer/ici/graph/current/manifest.json"))) { t.skip("field workspace not available on this machine"); return; }
  const { engine, dispose } = await engineFor(FIELD_ROOT, false);
  try {
    for (const query of ["modify group policy member", "group policy member", "which APIs can change group policy member"]) {
      const result: any = await engine.search({ workspaceId: "ws", query, mode: "business", top: 10 });
      assert.equal(result.ok, true, `query "${query}": ${JSON.stringify(result.error)}`);
      const top5 = (result.value.rows ?? []).slice(0, 5).map((row: any) => row.apiName);
      t.diagnostic(`"${query}" -> ${top5.join(", ")} (degraded=${result.value.degraded})`);
      assert.equal(top5.includes("AddGroupMemberAPI"), true, `query "${query}" must rank AddGroupMemberAPI in the top five, got ${top5.join(", ")}`);
    }
  } finally { await dispose(); }
});
