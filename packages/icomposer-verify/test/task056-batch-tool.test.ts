import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import { registerIciExplainTools } from "../src/ici-explain-tools.ts";

const INLINE_GUIDANCE = /confirmation card is inline in this current DSH Web conversation at this ici_explain call; ask the user to configure it here\./;

function assertInlineGuidance(text: string, token: RegExp): void {
  assert.match(text, token);
  assert.doesNotMatch(text, /CLI|desktop|https?:\/\//i);
  assert.doesNotMatch(text, /(?:^|[ =])\/(?:Users|home|tmp)\//);
}

test("TASK-057 ici_explain canonical single and batch results guide users to the inline card", async () => {
  const ctx: any = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.provide("iciEngine", {
    explainPrepare: async () => ({ ok: true, value: {
      artifactPath: ".metadata/icomposer/ici/explain/A/prepare.json", jobId: "0123456789abcdef", jobStatus: "awaiting-input",
      api: { id: "api:A", name: "A" }, callChain: { nodes: [{}, {}], edges: [{}], truncated: false }, sources: [{}], references: [{}],
      manifest: { sourceFingerprint: "source", graphDigest: "graph" }, contextHash: "context",
    } }),
    explainPrepareBatch: async () => ({ ok: true, value: { batchId: "fedcba9876543210", workspaceId: "ws", jobs: [
      { apiId: "api:A", apiName: "A", jobId: "0123456789abcdef", artifactPath: ".metadata/icomposer/ici/explain/A/prepare.json", jobStatus: "awaiting-input", chainNodes: 2, chainEdges: 1, truncated: false, reused: false },
      { apiId: "api:B", apiName: "B", jobId: "abcdef0123456789", artifactPath: ".metadata/icomposer/ici/explain/B/prepare.json", jobStatus: "awaiting-input", chainNodes: 3, chainEdges: 2, truncated: false, reused: false },
    ] } }),
  });
  const disposers = registerIciExplainTools(ctx, defineTool as never);
  try {
    const tool: any = ctx.tools.get("ici_explain");
    assert.ok(tool);
    const signal = new AbortController().signal;

    const single: any = await ctx.tools.execute({ callId: "task057-single-dispatch" as any, name: "ici_explain", arguments: { workspace_id: "ws", query: "A" }, signal });
    assert.equal(single.isError, false);
    assert.equal(single.value.job_id, "0123456789abcdef");
    assertInlineGuidance(single.content[0].text, /job=0123456789abcdef/);

    const dispatched: any = await ctx.tools.execute({ callId: "task057-batch-dispatch" as any, name: "ici_explain", arguments: { workspace_id: "ws", queries: ["A", "B"] }, signal });
    assert.equal(dispatched.isError, false);
    assert.equal(dispatched.value.batch_id, "fedcba9876543210");
    assert.equal(dispatched.value.jobs_count, 2);
    assert.equal(dispatched.value.jobs.length, 2);
    assertInlineGuidance(dispatched.content[0].text, /batch=fedcba9876543210 jobs=2/);
    assert.equal(dispatched.content[0].text.includes("job="), false);

    const singleOutput = await tool.execute({ workspace_id: "ws", query: "A" }, { signal });
    assertInlineGuidance(tool.output.render({}, singleOutput)[0].text, /job=0123456789abcdef/);
    const batchOutput = await tool.execute({ workspace_id: "ws", queries: ["A", "B"] }, { signal });
    assertInlineGuidance(tool.output.render({}, batchOutput)[0].text, /batch=fedcba9876543210 jobs=2/);
    assert.equal(tool.output.render({}, batchOutput)[0].text.includes("job="), false);

    const invalid = await tool.execute({ workspace_id: "ws", queries: ["A"] }, { signal: new AbortController().signal });
    assert.equal(invalid.error.code, "invalid-workspace-id");
    const both = await tool.execute({ workspace_id: "ws", query: "A", queries: ["A", "B"] }, { signal: new AbortController().signal });
    assert.equal(both.error.code, "invalid-workspace-id");
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    await ctx.fiber.dispose();
  }
});
