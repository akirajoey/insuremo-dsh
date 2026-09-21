import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import { registerIciExplainTools } from "../src/ici-explain-tools.ts";

/**
 * TASK-114: a job-active refusal must carry the blocker identity (metadata only) into the
 * tool result and its rendered text, so the card can name the blocker and offer one cancel
 * instead of telling the user to repeat a call that would fail identically.
 */

function blockers(count: number): Array<{ apiId: string; apiName: string; jobId: string; status: string; createdAt: string }> {
  return Array.from({ length: count }, (_, index) => ({
    apiId: `api:Api${index}`,
    apiName: `Api${index}`,
    jobId: `${index + 1}`.repeat(16).slice(0, 16),
    status: "awaiting-input",
    createdAt: "2026-09-18T02:55:23.513Z",
  }));
}

test("TASK-114 a blocked prepare answers with the blocker identity and actionable wording", async () => {
  const ctx: any = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.provide("iciEngine", {
    explainPrepareTask: async () => ({ ok: false, error: { code: "job-active", message: "job-active: Api0 (1111111111111111, awaiting-input, since 2026-09-18T02:55:23.513Z)", blockers: blockers(7), blockersMore: 2 } }),
  });
  const disposers = registerIciExplainTools(ctx, defineTool as never);
  try {
    const tool: any = ctx.tools.get("ici_explain");
    const output: any = await tool.execute({ workspace_id: "ws", all: true }, { signal: new AbortController().signal });
    // The structured error keeps the identity, bounded to five entries plus the total.
    assert.equal(output.error.code, "job-active", JSON.stringify(output));
    assert.equal(output.blockers.length, 5);
    assert.equal(output.blockers_more, 7 - 5);
    assert.equal(output.blockers[0].api_name, "Api0");
    assert.equal(output.blockers[0].job_id, "1111111111111111");
    assert.equal(output.blockers[0].status, "awaiting-input");
    assert.equal(output.blockers[0].created_at, "2026-09-18T02:55:23.513Z");

    const text: string = tool.output.render({}, output)[0].text;
    // One parsable metadata line per blocker, plus the remaining count.
    const lines = text.split("\n").filter((line: string) => line.startsWith("blocked=job-active"));
    assert.equal(lines.length, 5, text);
    assert.match(text, /blocked=job-active api=Api0 old_job=1111111111111111 status=awaiting-input created=2026-09-18T02:55:23\.513Z/);
    assert.match(text, /blocked_more=2/);
    // The wording tells the user what to do instead of suggesting a blind retry.
    assert.match(text, /cancel it from this card, then run the task again/);
    assert.doesNotMatch(text, /finish or cancel that job before starting a new task/);
    // No path, artifact, or source detail travels with the blockers.
    assert.doesNotMatch(text, /\/Users\/|\.metadata|prepare\.json|\.groovy/);
    assert.doesNotMatch(JSON.stringify(output.blockers), /\/Users\/|\.metadata|prepare\.json|\.groovy/);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    await ctx.fiber.dispose();
  }
});

test("TASK-114 an ordinary refusal keeps its plain error text", async () => {
  const ctx: any = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.provide("iciEngine", { explainPrepareTask: async () => ({ ok: false, error: { code: "no-targets", message: "no API targets were resolved" } }) });
  const disposers = registerIciExplainTools(ctx, defineTool as never);
  try {
    const tool: any = ctx.tools.get("ici_explain");
    const output: any = await tool.execute({ workspace_id: "ws", all: true }, { signal: new AbortController().signal });
    assert.equal(output.error.code, "no-targets");
    assert.equal(output.blockers, undefined);
    const text: string = tool.output.render({}, output)[0].text;
    assert.doesNotMatch(text, /blocked=/);
    assert.match(text, /icomposer tools error: no-targets/);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    await ctx.fiber.dispose();
  }
});


test("TASK-114 a member conflict is reported without a cancel entry", async () => {
  const ctx: any = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.provide("iciEngine", {
    explainPrepareTask: async () => ({ ok: false, error: { code: "job-active", message: "job-active: 1 target already belong to another task card (handle them in that card: confirm or cancel)", memberConflicts: 1 } }),
  });
  const disposers = registerIciExplainTools(ctx, defineTool as never);
  try {
    const tool: any = ctx.tools.get("ici_explain");
    const output: any = await tool.execute({ workspace_id: "ws", all: true }, { signal: new AbortController().signal });
    assert.equal(output.error.code, "job-active");
    assert.equal(output.member_conflicts, 1);
    assert.equal(output.blockers, undefined, "a member is never offered as a cancellable blocker");
    const text: string = tool.output.render({}, output)[0].text;
    assert.match(text, /member_conflict=1/);
    assert.match(text, /already belong to another task card/);
    assert.match(text, /confirm or cancel it there/);
    assert.doesNotMatch(text, /^blocked=/m, "no cancellable blocker line is rendered for a member conflict");
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    await ctx.fiber.dispose();
  }
});
