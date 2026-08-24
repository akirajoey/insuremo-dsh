import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import {
  ImoProfileContextService, decideProfileContext, shortDigest,
  PROFILE_DIGEST_SECTION, eventDigest, compactCheckpointSource,
  type InsuremoProfile,
} from "../src/profile-context.ts";

function makeProfile(name: string | null, env?: string): InsuremoProfile {
  return { name, ...(env === undefined ? {} : { env }), digest: name === null ? "none" : shortDigest(name) };
}

interface HistoryAgent { session: { events: unknown[] } }

/** Real roundtrip: drive the service's `decide` with a real history log. */
async function roundtrip(service: ImoProfileContextService, agent: HistoryAgent, step = 1) {
  const proposed: unknown = { type: "user/message", data: { content: [{ type: "text", text: "hello" }], source: { kind: "user" } } };
  const next = async (): Promise<{ kind: "enter"; messages: unknown[] }> => ({ kind: "enter", messages: [proposed] });
  const decision = await service.decide(
    { agent, turn: 1, step, signal: { aborted: false } },
    next,
  );
  let injected: unknown[] = [];
  if (decision.kind === "enter") injected = (decision.messages ?? []).filter(m => m !== proposed);
  // store in the real durable session event shape ({type:'user/message', data}) the
  // way Session.append produces it, so lifecycle scanning sees genuine history
  for (const m of injected) agent.session.events.push({ type: "user/message", data: m });
  return { injected, decision };
}

async function mountFixture(current: InsuremoProfile) {
  const ctx = new Context();
  let cur = current;
  ctx.provide("imoAuth", {
    profilesFast: async () => ({
      ok: true,
      value: { profiles: cur.name === null ? [] : [{ profileName: cur.name, env: cur.env }], defaultProfile: cur.name },
    }),
  } as never);
  // the static inject requires an `agents` service; a non-service value satisfies it
  ctx.provide("agents" as never, {} as never);
  const fiber = ctx.plugin(ImoProfileContextService as never);
  await fiber.await();
  const service = ctx.get("imoProfileContext" as never) as unknown as ImoProfileContextService;
  if (typeof (service as { decide?: unknown }).decide !== "function") throw new Error("service not available");
  return { ctx, fiber, service, set: (p: InsuremoProfile) => { cur = p; } };
}

test("TASK-044 B real roundtrip: turn1 injects one; turn2 same profile does NOT inject (digest from source metadata)", async () => {
  const fx = await mountFixture(makeProfile("portal:microsite", "aws_sg_insuremo_portal"));
  try {
    const agent: HistoryAgent = { session: { events: [] } };
    // turn1 → one injected profile context
    const first = await roundtrip(fx.service, agent, 1);
    assert.equal(first.injected.length, 1);
    const msg = first.injected[0] as { content?: { text?: string }[]; source?: { sections?: { name?: string; text?: string }[] } };
    // content is human-only: no {d= } leak
    assert.match(msg.content?.[0]?.text ?? "", /InsureMO active profile: portal:microsite/);
    assert.doesNotMatch(msg.content?.[0]?.text ?? "", /\{d=/);
    // digest is recoverable from source metadata of the real stored event
    const digest = eventDigest(agent.session.events[agent.session.events.length - 1]);
    assert.equal(digest, shortDigest("portal:microsite"));
    assert.match(msg.source?.sections?.find(s => s.name === PROFILE_DIGEST_SECTION)?.text ?? "", /\{d=...\}\s*$|{d=/, undefined);

    // turn2 (real message now in history) same profile → no inject
    const second = await roundtrip(fx.service, agent, 1);
    assert.equal(second.injected.length, 0, "same profile deduped using real prior event");

    // tool step → never inject
    const tool = await roundtrip(fx.service, agent, 2);
    assert.equal(tool.injected.length, 0, "tool step does not inject");
  } finally { await fx.fiber.dispose(); }
});

test("TASK-044 B switch/compact lifecycle with real events", async () => {
  const fx = await mountFixture(makeProfile("portal:microsite"));
  try {
    const agent: HistoryAgent = { session: { events: [] } };
    await roundtrip(fx.service, agent, 1); // 1
    fx.set(makeProfile("portal:mo-re"));
    const sw = await roundtrip(fx.service, agent, 1); // 2 (changed)
    assert.equal(sw.injected.length, 1);
    const swMsg = sw.injected[0] as { content?: { text?: string }[] };
    assert.match(swMsg.content?.[0]?.text ?? "", /changed/);
    // same new profile → dedup
    assert.equal((await roundtrip(fx.service, agent, 1)).injected.length, 0);
    // manual compact via the REAL compaction checkpoint source shape
    agent.session.events.push({
      type: "user/message",
      data: { content: [{ type: "text", text: "(compacted)" }], source: compactCheckpointSource() },
    });
    const afterCompact = await roundtrip(fx.service, agent, 1);
    assert.equal(afterCompact.injected.length, 1, "compaction re-asserts");
    // next same profile after the checkpoint re-assert + new profile event → dedup
    assert.equal((await roundtrip(fx.service, agent, 1)).injected.length, 0, "post-reassert dedup");
  } finally { await fx.fiber.dispose(); }
});

test("TASK-044 B digest helper: stable non-secret id", () => {
  assert.equal(shortDigest("portal:microsite"), shortDigest("portal:microsite"));
  assert.notEqual(shortDigest("portal:microsite"), shortDigest("portal:mo-re"));
  assert.match(shortDigest("portal:microsite"), /^[0-9a-f]{8}$/);
});

test("TASK-044 B service registers from [Service.init], not constructor; survives a >100ms sweep window", async () => {
  const ctx = new Context();
  ctx.provide("imoAuth", { profilesFast: async () => ({ ok: false, error: {} }) } as never);
  ctx.provide("agents" as never, {} as never);
  const fiber = ctx.plugin(ImoProfileContextService as never);
  await fiber.await();
  await new Promise(resolve => setTimeout(resolve, 150));
  const svc = ctx.get("imoProfileContext" as never) as unknown as { decide: ImoProfileContextService["decide"]; disposeProfileContext?: () => void };
  assert.equal(typeof svc.decide, "function", "listener path survives sweep window");
  await fiber.dispose();
});

test("TASK-044 B: decideProfileContext matrix (pure)", () => {
  const ev = (name: string) => ({
    type: "user/message",
    data: { content: [{ type: "text", text: "hi" }], source: { kind: "plugin", plugin: "icomposer-current-profile", sections: [{ name: PROFILE_DIGEST_SECTION, text: `{d=${shortDigest(name)}}` }] } },
  });
  // first → inject
  assert.equal(decideProfileContext([], makeProfile("a")).inject, true);
  // same → dedup
  assert.equal(decideProfileContext([ev("a")], makeProfile("a")).inject, false);
  // switch → inject changed
  const sw = decideProfileContext([ev("a")], makeProfile("b"));
  assert.equal(sw.inject, true); assert.equal(sw.changed, true);
  // compact after last → re-assert
  const cps = compactCheckpointSource();
  assert.equal(decideProfileContext([ev("b"), { type: "user/message", data: { content: [], source: cps } }], makeProfile("b")).inject, true);
  void PROFILE_DIGEST_SECTION;
});

test("TASK-044 FIX-2 none-profile lifecycle: no-repeat after none; profile→none injects once; next none dedups", async () => {
  const fx = await mountFixture(makeProfile(null));
  try {
    const agent: HistoryAgent = { session: { events: [] } };
    // turn1 none → injects one
    const first = await roundtrip(fx.service, agent, 1);
    assert.equal(first.injected.length, 1);
    assert.match((first.injected[0] as { content?: { text?: string }[] }).content?.[0]?.text ?? "", /none/);
    // turn2 same none → no repeat (digest is a valid hash, not undefined)
    assert.equal((await roundtrip(fx.service, agent, 1)).injected.length, 0, "none deduped (no repeat)");

    // profile → none: switch to a profile then back to none
    fx.set(makeProfile("portal:a"));
    assert.equal((await roundtrip(fx.service, agent, 1)).injected.length, 1, "none→profile injects");
    fx.set(makeProfile(null));
    const backToNone = await roundtrip(fx.service, agent, 1);
    assert.equal(backToNone.injected.length, 1, "profile→none injects once");
    assert.match((backToNone.injected[0] as { content?: { text?: string }[] }).content?.[0]?.text ?? "", /none/);
    // next turn same none → dedup
    assert.equal((await roundtrip(fx.service, agent, 1)).injected.length, 0, "none dedups on next turn");
  } finally { await fx.fiber.dispose(); }
});

test("TASK-044 FIX: disposeProfileContext via ctx.get() proxy removes the real listener (ctx.waterfall), no #private throw, idempotent", async () => {
  const ctx = new Context();
  ctx.provide("imoAuth", {
    profilesFast: async () => ({
      ok: true,
      value: { profiles: [{ profileName: "portal:microsite" }], defaultProfile: "portal:microsite" },
    }),
  } as never);
  ctx.provide("agents" as never, {} as never);
  const fiber = ctx.plugin(ImoProfileContextService as never);
  await fiber.await();
  const proxy = ctx.get("imoProfileContext" as never) as unknown as {
    disposeProfileContext: () => void;
  };
  assert.equal(typeof proxy.disposeProfileContext, "function");

  const fire = async () => {
    const payload = { agent: { session: { events: [] } }, turn: 1, step: 1, signal: { aborted: false } };
    const decision = await (ctx as unknown as { waterfall(name: string, ...args: unknown[]): unknown }).waterfall(
      "agent/pre-step",
      payload,
      () => ({ kind: "enter", messages: [] }),
    );
    const resolved = decision as { kind?: string; messages?: unknown[] };
    return resolved.kind === "enter" ? (resolved.messages ?? []).length : 0;
  };

  // before dispose: real listener injects one profile context on step1
  assert.equal(await fire(), 1, "listener injects before disposal");
  // dispose via PROXY (the #private-bound path) — must not throw
  proxy.disposeProfileContext();
  // listener removed: a new empty-history step1 payload yields zero messages
  assert.equal(await fire(), 0, "listener removed after dispose");
  // idempotent: second dispose still no throw, still zero messages
  proxy.disposeProfileContext();
  assert.equal(await fire(), 0, "idempotent, still removed");
  await fiber.dispose();
});
