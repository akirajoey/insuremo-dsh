import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import { registerIciExplainTools } from "../src/ici-explain-tools.ts";

test("TASK-051 MVP real ToolRuntime materializes ici_explain output.render without a source payload", async () => {
  const ctx: any = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide("iciEngine", { explainPrepare: async () => ({ ok: true, value: { artifactPath: ".metadata/icomposer/ici/explain/A/prepare.json", jobId: "0123456789abcdef", jobStatus: "awaiting-input", api: { id: "api:A", name: "A" }, callChain: { nodes: [{ nodeId: "api:A" }, { nodeId: "method:A.run" }], edges: [], truncated: false }, sources: [{ path: "src/A.groovy" }], references: [], manifest: { sourceFingerprint: "f".repeat(64), graphDigest: "g".repeat(64), promptVersion: "explain-mvp-v1" }, contextHash: "c".repeat(64) } }) });
  const disposers = registerIciExplainTools(ctx, defineTool as never); try { const tool: any = ctx.tools.get("ici_explain"); assert.ok(tool); const output = await tool.execute({ workspace_id: "ws", query: "A" }, { signal: new AbortController().signal }); assert.equal(output.job_id, "0123456789abcdef"); const rendered = tool.output.render({}, output)[0].text; assert.match(rendered, /job=0123456789abcdef/); assert.match(rendered, /Start/); assert.equal(rendered.includes("/Users/"), false); } finally { for (const dispose of disposers.reverse()) await dispose(); await ctx.fiber.dispose(); }
});
