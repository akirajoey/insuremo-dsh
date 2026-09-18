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

const jobs = [
  { apiId: "api:A", apiName: "A", jobId: "0123456789abcdef", artifactPath: ".metadata/icomposer/ici/explain/A/prepare.json", jobStatus: "awaiting-input", chainNodes: 2, chainEdges: 1, truncated: false, reused: false },
  { apiId: "api:B", apiName: "B", jobId: "abcdef0123456789", artifactPath: ".metadata/icomposer/ici/explain/B/prepare.json", jobStatus: "awaiting-input", chainNodes: 3, chainEdges: 2, truncated: false, reused: false },
];

test("TASK-111 ici_explain prepares ONE task for api/queries/group/all and guides the inline card", async () => {
  const ctx: any = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const seen: any[] = [];
  let refuse: { code: string; message: string } | undefined;
  ctx.provide("iciEngine", {
    explainPrepareTask: async (input: any) => {
      seen.push(input);
      if (refuse !== undefined) return { ok: false, error: refuse };
      const requested = input.selector.kind === "api" ? 1 : input.selector.kind === "queries" ? input.selector.queries.length : input.selector.kind === "group" ? 2 : 25;
      const rowJobs = input.selector.kind === "api" ? jobs.slice(0, 1) : jobs;
      return { ok: true, value: {
        batchId: "fedcba9876543210", workspaceId: "ws", requestedCount: requested, duplicates: 0,
        selector: { kind: input.selector.kind, ...(input.selector.kind === "api" ? { label: input.selector.query } : input.selector.kind === "group" ? { label: input.selector.group } : input.selector.kind === "all" ? { label: "all" } : {}) },
        jobs: rowJobs,
      } };
    },
  });
  const disposers = registerIciExplainTools(ctx, defineTool as never);
  try {
    const tool: any = ctx.tools.get("ici_explain");
    assert.ok(tool);
    const signal = new AbortController().signal;

    // A single API is a task with one target: same card, same once-only model/time.
    const single: any = await tool.execute({ workspace_id: "ws", query: "A" }, { signal });
    assert.equal(single.batch_id, "fedcba9876543210");
    assert.equal(single.targets, 1);
    assert.equal(single.concurrency, 4);
    assert.equal(single.selector_kind, "api");
    assertInlineGuidance(tool.output.render({}, single)[0].text, /batch=fedcba9876543210 selector=api label=A targets=1 unique=1 concurrency=4/);

    // An explicit list stays one task and is never truncated by a window.
    const list: any = await tool.execute({ workspace_id: "ws", queries: ["A", "B"] }, { signal });
    assert.equal(list.targets, 2);
    assert.equal(list.jobs_count, 2);
    assertInlineGuidance(tool.output.render({}, list)[0].text, /selector=queries targets=2 unique=2/);

    // A group / the whole workspace is resolved by the host: the caller passes a selector, not a list.
    const group: any = await tool.execute({ workspace_id: "ws", group: "Billing", concurrency: 2 }, { signal });
    assert.equal(group.selector_kind, "group");
    assert.equal(group.concurrency, 2);
    assert.equal(seen.at(-1).selector.group, "Billing");
    assert.equal(seen.at(-1).maxConcurrent, 2);
    assertInlineGuidance(tool.output.render({}, group)[0].text, /selector=group label=Billing targets=2/);

    const all: any = await tool.execute({ workspace_id: "ws", all: true }, { signal });
    assert.equal(all.selector_kind, "all");
    assert.equal(all.targets, 25);
    // The response stays bounded: counts, never one row per target.
    assert.equal(all.jobs_count, 2);
    assertInlineGuidance(tool.output.render({}, all)[0].text, /selector=all label=all targets=25 unique=2/);

    // Exactly one selector per call; malformed selector shapes are refused.
    assert.equal((await tool.execute({ workspace_id: "ws", query: "A", group: "B" }, { signal })).error.code, "invalid-workspace-id");
    assert.equal((await tool.execute({ workspace_id: "ws" }, { signal })).error.code, "invalid-workspace-id");
    assert.equal((await tool.execute({ workspace_id: "ws", queries: [] }, { signal })).error.code, "invalid-workspace-id");
    assert.equal((await tool.execute({ workspace_id: "ws", queries: ["A", ""] }, { signal })).error.code, "invalid-workspace-id");
    assert.equal((await tool.execute({ workspace_id: "ws", group: " " }, { signal })).error.code, "invalid-workspace-id");
    assert.equal((await tool.execute({ workspace_id: "ws", all: true, concurrency: 33 }, { signal })).error.code, "invalid-workspace-id");
    assert.equal((await tool.execute({ workspace_id: "ws", all: false }, { signal })).error.code, "invalid-workspace-id");

    // A host-side refusal is surfaced verbatim: no silent narrowing, no partial card.
    refuse = { code: "ambiguous-target", message: "api names exist at several source paths: A" };
    const refused: any = await tool.execute({ workspace_id: "ws", all: true }, { signal });
    assert.equal(refused.error.code, "ambiguous-target");
    assert.match(tool.output.render({}, refused)[0].text, /ambiguous-target/);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    await ctx.fiber.dispose();
  }
});
