import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import { registerIciExplainTools } from "../src/ici-explain-tools.ts";

test("TASK-051 MVP real ToolRuntime materializes ici_explain output.render without a source payload", async () => {
  const ctx: any = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide("iciEngine", { explainPrepareTask: async () => ({ ok: true, value: { batchId: "0123456789abcdef", workspaceId: "ws", requestedCount: 1, duplicates: 0, selector: { kind: "api", label: "A" }, jobs: [{ apiId: "api:A", apiName: "A", jobId: "abcdef0123456789", artifactPath: ".metadata/icomposer/ici/explain/A/prepare.json", jobStatus: "awaiting-input", chainNodes: 2, chainEdges: 0, truncated: false, reused: false }] } }) });
  const disposers = registerIciExplainTools(ctx, defineTool as never); try { const tool: any = ctx.tools.get("ici_explain"); assert.ok(tool); const output = await tool.execute({ workspace_id: "ws", query: "A" }, { signal: new AbortController().signal }); assert.equal(output.batch_id, "0123456789abcdef");
    assert.equal(output.job_id, "abcdef0123456789"); const rendered = tool.output.render({}, output)[0].text; assert.match(rendered, /batch=0123456789abcdef selector=api label=A targets=1 unique=1 concurrency=4/); assert.match(rendered, /confirmation card is inline/); assert.equal(rendered.includes("/Users/"), false); } finally { for (const dispose of disposers.reverse()) await dispose(); await ctx.fiber.dispose(); }
});
