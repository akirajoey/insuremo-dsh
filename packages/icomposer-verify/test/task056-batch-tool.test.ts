import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import { registerIciExplainTools } from "../src/ici-explain-tools.ts";

test("TASK-056 ici_explain renders a batch without a second job card key", async () => {
  const ctx: any = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); ctx.provide("iciEngine", {
    explainPrepare: async () => ({ ok: false, error: { code: "unused", message: "unused" } }),
    explainPrepareBatch: async () => ({ ok: true, value: { batchId: "fedcba9876543210", workspaceId: "ws", jobs: [
      { apiId: "api:A", apiName: "A", jobId: "0123456789abcdef", artifactPath: ".metadata/icomposer/ici/explain/A/prepare.json", jobStatus: "awaiting-input", chainNodes: 2, chainEdges: 1, truncated: false, reused: false },
      { apiId: "api:B", apiName: "B", jobId: "abcdef0123456789", artifactPath: ".metadata/icomposer/ici/explain/B/prepare.json", jobStatus: "awaiting-input", chainNodes: 3, chainEdges: 2, truncated: false, reused: false },
    ] } }),
  });
  const disposers = registerIciExplainTools(ctx, defineTool as never);
  try {
    const tool: any = ctx.tools.get("ici_explain"); assert.ok(tool); const signal = new AbortController().signal; const dispatched: any = await ctx.tools.execute({ callId: "task056-batch-dispatch" as any, name: "ici_explain", arguments: { workspace_id: "ws", queries: ["A", "B"] }, signal }); assert.equal(dispatched.isError, false); assert.equal(dispatched.value.batch_id, "fedcba9876543210"); assert.equal(dispatched.value.jobs_count, 2); assert.equal(dispatched.value.jobs.length, 2); assert.equal(dispatched.content[0].text, "batch=fedcba9876543210 jobs=2"); assert.equal(dispatched.content[0].text.includes("job="), false); const output = await tool.execute({ workspace_id: "ws", queries: ["A", "B"] }, { signal }); assert.equal(output.batch_id, "fedcba9876543210"); assert.equal(output.jobs_count, 2); assert.equal(output.jobs.length, 2); const rendered = tool.output.render({}, output)[0].text; assert.equal(rendered, "batch=fedcba9876543210 jobs=2"); assert.equal(rendered.includes("job="), false);
    const invalid = await tool.execute({ workspace_id: "ws", queries: ["A"] }, { signal: new AbortController().signal }); assert.equal(invalid.error.code, "invalid-workspace-id"); const both = await tool.execute({ workspace_id: "ws", query: "A", queries: ["A", "B"] }, { signal: new AbortController().signal }); assert.equal(both.error.code, "invalid-workspace-id");
  } finally { for (const dispose of disposers.reverse()) await dispose(); await ctx.fiber.dispose(); }
});
