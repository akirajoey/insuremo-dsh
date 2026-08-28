import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { IciContextService, ICI_CONTEXT_PLUGIN, ICI_CONTEXT_POLICY_VERSION } from "../src/ici-context-service.ts";

function agent(cwd: string, events: unknown[] = []) {
  return { session: { header: { cwd }, events } };
}
function binding(entries: readonly unknown[]) {
  return { list: async () => ({ ok: true, value: entries }) };
}
async function fixture(entries: readonly unknown[]) {
  const ctx = new Context();
  ctx.provide("agents" as never, {} as never);
  ctx.provide("workspaceBinding" as never, binding(entries) as never);
  const fiber = ctx.plugin(IciContextService as never);
  await fiber.await();
  return { ctx, fiber, service: ctx.get("iciContext" as never) as unknown as IciContextService };
}
async function step(service: IciContextService, current: ReturnType<typeof agent>, stepNo = 1, signal = new AbortController().signal) {
  const decision = await service.decide({ agent: current, step: stepNo, signal }, async () => ({ kind: "enter", messages: [] }));
  for (const message of decision.messages ?? []) current.session.events.push({ type: "user/message", data: message });
  return decision;
}

test("ICI context injects only for exact detected/bound workspace and deduplicates", async () => {
  const fx = await fixture([{ workspaceId: "ws-a", canonicalPath: "/repo/a", detectedIcomposer: true, binding: { environmentId: "env" } }]);
  try {
    const current = agent("/repo/a");
    const first = await step(fx.service, current);
    assert.equal(first.messages?.length, 1);
    const source = (first.messages?.[0] as { source?: { plugin?: string; workspaceId?: string } }).source;
    assert.equal(source?.plugin, ICI_CONTEXT_PLUGIN);
    assert.equal(source?.workspaceId, "ws-a");
    const text = String((first.messages?.[0] as { content?: readonly { text?: string }[] }).content?.[0]?.text);
    assert.match(text, /\[iComposer workspace\]/);
    assert.match(text, /workspace_id: ws-a/);
    assert.match(text, /tools: \{.*inspect: \[ici_query\].*explain: \[ici_explain\]/);
    assert.doesNotMatch(text, /ici_search|embedding|semantic/i);
    assert.match(text, /explain_results: \{files: \.metadata\/icomposer\/ici\/explain\/<api-name>-\*\/finals\/\*\.json, fields: \[apiAnalysis\.technical,apiAnalysis\.business,apiAnalysis\.flow,apiAnalysis\.evidence\]\}/);
    assert.match(text, /workspace_id\/schema authority/);
    assert.match(text, /named API business\/technical: locate\/read newest matching schemaVersion 3 kind final before answering/);
    assert.match(text, /never use prepare\.json as an explanation result/);
    assert.match(text, /no accessible matching Final: say so; do not invent one/);
    assert.match(text, /stale graph: ici_build before ici_explain/);
    assert.match(text, /ici_explain prepares only; card needs model; reference\/earliest optional/);
    assert.match(text, /artifact paths from tools/);
    assert.match(text, /Active Profile: Workbench Active Profile; never CLI defaults/);
    assert.doesNotMatch(text, /This is iComposer workspace/);
    assert.doesNotMatch(text, /canonical path|artifact layout|absolute|secret|digest/);
    assert.doesNotMatch(text, /imo auth|imo devops/);
    assert.equal(Buffer.byteLength(text, "utf8") <= 1000, true);
    const firstPolicy = (first.messages?.[0] as { source?: { policyVersion?: string } }).source?.policyVersion;
    assert.equal(firstPolicy, ICI_CONTEXT_POLICY_VERSION);
    assert.equal(ICI_CONTEXT_POLICY_VERSION, "6");
    assert.equal((await step(fx.service, current)).messages?.length, 0);
    assert.equal((await step(fx.service, current, 2)).messages?.length, 0);
  } finally { await fx.fiber.dispose(); }
});

test("TASK-067 ICI context stays within the 1000-byte gate at the maximum workspace id", async () => {
  const longId = "a".repeat(128);
  const fx = await fixture([{ workspaceId: longId, canonicalPath: "/repo/long", detectedIcomposer: true, binding: null }]);
  try {
    const current = agent("/repo/long");
    const first = await step(fx.service, current);
    const text = String((first.messages?.[0] as { content?: readonly { text?: string }[] }).content?.[0]?.text);
    assert.equal(Buffer.byteLength(text, "utf8") <= 1000, true);
    assert.match(text, new RegExp(`workspace_id: ${longId}`));
    assert.doesNotMatch(text, /ici_search|embedding|semantic/i);
    assert.match(text, /schemaVersion 3 kind final/);
  } finally { await fx.fiber.dispose(); }
});

test("ICI context reasserts after workspace switch and compaction, but not for unknown cwd", async () => {
  const fx = await fixture([
    { workspaceId: "ws-a", canonicalPath: "/repo/a", detectedIcomposer: true, binding: null },
    { workspaceId: "ws-b", canonicalPath: "/repo/b", detectedIcomposer: false, binding: { environmentId: "env" } },
  ]);
  try {
    const current = agent("/repo/a");
    assert.equal((await step(fx.service, current)).messages?.length, 1);
    current.session.header.cwd = "/repo/b";
    assert.equal((await step(fx.service, current)).messages?.length, 1);
    current.session.events.push({ type: "user/message", data: { source: { kind: "plugin", plugin: "compact" } } });
    assert.equal((await step(fx.service, current)).messages?.length, 1);
    current.session.header.cwd = "/other";
    assert.equal((await step(fx.service, current)).messages?.length, 0);
  } finally { await fx.fiber.dispose(); }
});

test("ICI context reasserts once for a legacy policy version and rejects unsafe workspace ids", async () => {
  const fx = await fixture([
    { workspaceId: "ws/unsafe", canonicalPath: "/unsafe", detectedIcomposer: true, binding: null },
    { workspaceId: "ws-safe", canonicalPath: "/safe", detectedIcomposer: true, binding: null },
  ]);
  try {
    const current = agent("/safe");
    assert.equal((await step(fx.service, current)).messages?.length, 1);
    const event = current.session.events[current.session.events.length - 1] as { type: string; data: { source: Record<string, unknown> } };
    current.session.events[current.session.events.length - 1] = { ...event, data: { ...event.data, source: { ...event.data.source, policyVersion: "0" } } };
    assert.equal((await step(fx.service, current)).messages?.length, 1);
    assert.equal((await step(fx.service, current)).messages?.length, 0);
    current.session.header.cwd = "/unsafe";
    assert.equal((await step(fx.service, current)).messages?.length, 0);
  } finally { await fx.fiber.dispose(); }
});

test("ICI context aborts a slow binding lookup and never injects after dispose", async () => {
  let release!: (value: { ok: true; value: readonly unknown[] }) => void;
  const ctx = new Context();
  ctx.provide("agents" as never, {} as never);
  ctx.provide("workspaceBinding" as never, { list: async (_signal?: AbortSignal) => await new Promise<{ ok: true; value: readonly unknown[] }>(resolve => { release = resolve; }) } as never);
  const fiber = ctx.plugin(IciContextService as never);
  await fiber.await();
  const service = ctx.get("iciContext" as never) as unknown as IciContextService;
  const controller = new AbortController();
  const current = agent("/repo");
  const pending = service.decide({ agent: current, step: 1, signal: controller.signal }, async () => ({ kind: "enter", messages: [] }));
  while (release === undefined) await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort();
  release({ ok: true, value: [{ workspaceId: "ws", canonicalPath: "/repo", detectedIcomposer: true, binding: null }] });
  assert.equal((await pending).messages?.length, 0);
  await fiber.dispose();
});

test("ICI context listener is disposed", async () => {
  const fx = await fixture([{ workspaceId: "ws", canonicalPath: "/repo", detectedIcomposer: true, binding: null }]);
  const current = agent("/repo");
  await fx.fiber.dispose();
  const decision = await fx.service.decide({ agent: current, step: 1 }, async () => ({ kind: "enter", messages: [] }));
  assert.equal(decision.messages?.length, 0);
});
