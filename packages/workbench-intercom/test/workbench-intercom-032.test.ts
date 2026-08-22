import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { applyIntercom, type IntercomProvider } from "../src/index.ts";

interface Face {
  register(input: { peerName: string; cwd: string }, signal?: AbortSignal): Promise<any>;
  heartbeat(input: { sessionId: string }, signal?: AbortSignal): Promise<any>;
  send(input: any, signal?: AbortSignal): Promise<any>;
  ask(input: any, signal?: AbortSignal): Promise<any>;
  reply(input: any, signal?: AbortSignal): Promise<any>;
  cancel(input: any, signal?: AbortSignal): Promise<any>;
  pendingAsks(input: { sessionId: string }, signal?: AbortSignal): Promise<any>;
  resolveStatus(input: { sessionId: string }, signal?: AbortSignal): Promise<any>;
  inbox(input: { sessionId: string }, signal?: AbortSignal): Promise<any>;
  read(input: { sessionId: string; seq: number }, signal?: AbortSignal): Promise<any>;
  markDelivered(input: { sessionId: string; seqs: readonly number[] }, signal?: AbortSignal): Promise<any>;
  pending(input: { sessionId: string }, signal?: AbortSignal): Promise<any>;
  listSessions(signal?: AbortSignal): Promise<any>;
}

async function fixture() {
  const storageDir = await mkdtemp(join(tmpdir(), "i032-store-"));
  const dshHome = await mkdtemp(join(tmpdir(), "i032-dsh-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  const ctx = new Context();
  const storage = new Storage(ctx);
  const backend = new JsonStorageBackend(storageDir);
  const unregisterBackend = storage.backend.register("json", backend);
  const storageDomain = new DomainFacility(ctx, { backend: "json" });
  let provider: IntercomProvider | undefined;
  let cleanup: (() => void | Promise<void>) | undefined;
  await applyIntercom({
    storageDomain,
    provide(name, value) { if (name === "intercom") provider = value as unknown as IntercomProvider; return () => {}; },
    effect(setup) { cleanup = setup(); return () => {}; },
  } as never);
  if (provider === undefined || cleanup === undefined) throw new Error("fixture failed");
  const intercom = provider as unknown as Face;
  return {
    intercom,
    reopen: async () => {
      await cleanup?.();
      let p2: IntercomProvider | undefined;
      let c2: (() => void | Promise<void>) | undefined;
      await applyIntercom({
        storageDomain,
        provide(name, value) { if (name === "intercom") p2 = value as unknown as IntercomProvider; return () => {}; },
        effect(setup) { c2 = setup(); return () => {}; },
      } as never);
      if (p2 === undefined || c2 === undefined) throw new Error("reopen failed");
      cleanup = c2;
      return p2 as unknown as Face;
    },
    dispose: async () => {
      await cleanup?.();
      unregisterBackend();
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      await rm(storageDir, { recursive: true, force: true });
      await rm(dshHome, { recursive: true, force: true });
    },
  };
}

test("ask → waiting; reply restores; inbox includes ask with pending status", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "asker", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "worker", cwd: "/tmp/b" });
    const asked: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "what is 2+2?" });
    assert.equal(asked.ok, true);
    assert.equal(asked.value.askStatus, "pending");
    // receiver's derived status is waiting
    const st: any = await h.intercom.resolveStatus({ sessionId: b.value.sessionId });
    assert.equal(st.value.status, "waiting");
    assert.deepEqual(st.value.waitingFor, [asked.value.seq]);
    // inbox contains the ask with askStatus
    const inbox: any = await h.intercom.inbox({ sessionId: b.value.sessionId });
    assert.equal(inbox.value[0].kind, "ask");
    assert.equal(inbox.value[0].askStatus, "pending");
    // reply restores
    const replied: any = await h.intercom.reply({ fromSessionId: b.value.sessionId, toSeq: asked.value.seq, text: "4" });
    assert.equal(replied.ok, true);
    assert.equal(replied.value.replyToSeq, asked.value.seq);
    assert.equal(replied.value.restored, true);
    const after: any = await h.intercom.resolveStatus({ sessionId: b.value.sessionId });
    assert.equal(after.value.status, "idle");
    assert.deepEqual(after.value.waitingFor, []);
    // the reply message lands in the original asker's inbox with replyToSeq
    const askerInbox: any = await h.intercom.inbox({ sessionId: a.value.sessionId });
    assert.equal(askerInbox.value[0].kind, "reply");
    assert.equal(askerInbox.value[0].replyToSeq, asked.value.seq);
    // resolveStatus for the asker stays derived from its own pending asks (none)
    const askerStatus: any = await h.intercom.resolveStatus({ sessionId: a.value.sessionId });
    assert.equal(askerStatus.value.status, "running");
  } finally { await h.dispose(); }
});

test("cancel: asker cancels pending ask; receiver released; replied → invalid-state; non-asker denied", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "asker", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "worker", cwd: "/tmp/b" });
    const c: any = await h.intercom.register({ peerName: "other", cwd: "/tmp/c" });
    const asked: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "q" });
    // non-asker cannot cancel
    const stranger: any = await h.intercom.cancel({ fromSessionId: c.value.sessionId, seq: asked.value.seq });
    assert.equal(stranger.ok, false);
    assert.equal(stranger.error.code, "denied");
    // receiver cannot cancel either (only the asker may)
    const byReceiver: any = await h.intercom.cancel({ fromSessionId: b.value.sessionId, seq: asked.value.seq });
    assert.equal(byReceiver.error.code, "denied");
    // asker cancels
    const cancelled: any = await h.intercom.cancel({ fromSessionId: a.value.sessionId, seq: asked.value.seq });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.value.released, true);
    const st: any = await h.intercom.resolveStatus({ sessionId: b.value.sessionId });
    assert.deepEqual(st.value.waitingFor, []);
    // double cancel → invalid-state
    const again: any = await h.intercom.cancel({ fromSessionId: a.value.sessionId, seq: asked.value.seq });
    assert.equal(again.error.code, "invalid-state");
    // reply to cancelled → invalid-state
    const late: any = await h.intercom.reply({ fromSessionId: b.value.sessionId, toSeq: asked.value.seq, text: "late" });
    assert.equal(late.error.code, "invalid-state");
    // replied ask cannot be cancelled
    const asked2: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "q2" });
    await h.intercom.reply({ fromSessionId: b.value.sessionId, toSeq: asked2.value.seq, text: "a2" });
    const cancelReplied: any = await h.intercom.cancel({ fromSessionId: a.value.sessionId, seq: asked2.value.seq });
    assert.equal(cancelReplied.error.code, "invalid-state");
    // unknown seq → ask-not-found
    const ghost: any = await h.intercom.cancel({ fromSessionId: a.value.sessionId, seq: 424242 });
    assert.equal(ghost.error.code, "ask-not-found");
    // reply to a plain message → ask-not-found
    const plain: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "plain" });
    const notAsk: any = await h.intercom.reply({ fromSessionId: b.value.sessionId, toSeq: plain.value.seq, text: "x" });
    assert.equal(notAsk.error.code, "ask-not-found");
  } finally { await h.dispose(); }
});

test("reply only by the asked session; concurrent replies — only one wins", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "asker", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "worker", cwd: "/tmp/b" });
    const c: any = await h.intercom.register({ peerName: "other", cwd: "/tmp/c" });
    const asked: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "q" });
    // third party cannot reply (ask was addressed to b)
    const stranger: any = await h.intercom.reply({ fromSessionId: c.value.sessionId, toSeq: asked.value.seq, text: "me first" });
    assert.equal(stranger.error.code, "denied");
    // 10 concurrent replies from the legitimate responder: exactly one succeeds
    const replies = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      h.intercom.reply({ fromSessionId: b.value.sessionId, toSeq: asked.value.seq, text: `answer ${i}` })));
    const winners = replies.filter((r: any) => r.ok);
    const losers = replies.filter((r: any) => !r.ok);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 9);
    assert.equal((losers[0] as any).error.code, "invalid-state");
    // ask resolved exactly once
    const pendingAsks: any = await h.intercom.pendingAsks({ sessionId: b.value.sessionId });
    assert.equal(pendingAsks.value.length, 0);
  } finally { await h.dispose(); }
});

test("pendingAsks filter + delivery does not change ask status", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "asker", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "worker", cwd: "/tmp/b" });
    const q1: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "q1" });
    await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "not an ask" });
    const q2: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "q2" });
    // pendingAsks: only asks, no plain messages; asker's own pendingAsks empty
    const asks: any = await h.intercom.pendingAsks({ sessionId: b.value.sessionId });
    assert.deepEqual(asks.value.map((e: any) => e.seq), [q1.value.seq, q2.value.seq]);
    assert.equal(asks.value.every((e: any) => e.askStatus === "pending"), true);
    const own: any = await h.intercom.pendingAsks({ sessionId: a.value.sessionId });
    assert.equal(own.value.length, 0);
    // markDelivered on the ask: delivery ≠ answer
    const delivered: any = await h.intercom.markDelivered({ sessionId: b.value.sessionId, seqs: [q1.value.seq] });
    assert.equal(delivered.value.marked, 1);
    const stillPending: any = await h.intercom.pendingAsks({ sessionId: b.value.sessionId });
    assert.equal(stillPending.value.length, 2);
    const st: any = await h.intercom.resolveStatus({ sessionId: b.value.sessionId });
    assert.equal(st.value.status, "waiting");
  } finally { await h.dispose(); }
});

test("ask validation: 64KB boundary + timeoutMs bounds", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "asker", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "worker", cwd: "/tmp/b" });
    const max: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "y".repeat(64 * 1024) });
    assert.equal(max.ok, true);
    const over: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "y".repeat(64 * 1024 + 1) });
    assert.equal(over.error.code, "invalid-text");
    const badTimeout: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "q", timeoutMs: 600001 });
    assert.equal(badTimeout.error.code, "invalid-params");
    const zeroTimeout: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "q", timeoutMs: 0 });
    assert.equal(zeroTimeout.error.code, "invalid-params");
    const goodTimeout: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "q2", timeoutMs: 600000 });
    assert.equal(goodTimeout.ok, true);
  } finally { await h.dispose(); }
});

test("multiple pending asks: waiting holds until all resolve; partial release", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "asker", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "worker", cwd: "/tmp/b" });
    const q1: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "q1" });
    const q2: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "q2" });
    let st: any = await h.intercom.resolveStatus({ sessionId: b.value.sessionId });
    assert.deepEqual(st.value.waitingFor.sort(), [q1.value.seq, q2.value.seq].sort());
    // answer one → still waiting for the other
    const r1: any = await h.intercom.reply({ fromSessionId: b.value.sessionId, toSeq: q1.value.seq, text: "a1" });
    assert.equal(r1.value.restored, false);
    st = await h.intercom.resolveStatus({ sessionId: b.value.sessionId });
    assert.equal(st.value.status, "waiting");
    assert.deepEqual(st.value.waitingFor, [q2.value.seq]);
    // answer the other → released
    const r2: any = await h.intercom.reply({ fromSessionId: b.value.sessionId, toSeq: q2.value.seq, text: "a2" });
    assert.equal(r2.value.restored, true);
    st = await h.intercom.resolveStatus({ sessionId: b.value.sessionId });
    assert.equal(st.value.status, "idle");
  } finally { await h.dispose(); }
});

test("durability: ask state survives provider reopen", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "asker", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "worker", cwd: "/tmp/b" });
    const asked: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "persist me" });
    const reopened = await h.reopen();
    const pending: any = await reopened.pendingAsks({ sessionId: b.value.sessionId });
    assert.equal(pending.value.length, 1);
    assert.equal(pending.value[0].seq, asked.value.seq);
    const st: any = await reopened.resolveStatus({ sessionId: b.value.sessionId });
    assert.equal(st.value.status, "waiting");
    assert.deepEqual(st.value.waitingFor, [asked.value.seq]);
    const body: any = await reopened.read({ sessionId: b.value.sessionId, seq: asked.value.seq });
    assert.equal(body.value.text, "persist me");
    // resolve after reopen works
    const replied: any = await reopened.reply({ fromSessionId: b.value.sessionId, toSeq: asked.value.seq, text: "after reopen" });
    assert.equal(replied.ok, true);
    assert.equal(replied.value.restored, true);
  } finally { await h.dispose(); }
});

test("gates: disposed/abort refuse ask paths; unknown session ask fails", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "asker", cwd: "/tmp/a" });
    const c = new AbortController();
    c.abort();
    const aborted: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: "x", text: "q" }, c.signal);
    assert.equal(aborted.error.code, "invalid-params");
    const unknown: any = await h.intercom.ask({ fromSessionId: a.value.sessionId, toSessionId: "ghost-session", text: "q" });
    assert.equal(unknown.error.code, "session-not-found");
    const missing: any = await h.intercom.pendingAsks({ sessionId: "ghost-session" });
    assert.equal(missing.value.length, 0);
    const stMissing: any = await h.intercom.resolveStatus({ sessionId: "ghost-session" });
    assert.equal(stMissing.error.code, "session-not-found");
  } finally { await h.dispose(); }
});
