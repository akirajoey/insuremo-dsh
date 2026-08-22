import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { applyIntercom, type IntercomProvider } from "../src/index.ts";
import { intercomDomain } from "../src/domain.ts";

async function fixture() {
  const storageDir = await mkdtemp(join(tmpdir(), "intercom-store-"));
  const dshHome = await mkdtemp(join(tmpdir(), "intercom-dsh-"));
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
    provide(name, value) {
      if (name === "intercom") provider = value as unknown as IntercomProvider;
      return () => { if (name === "intercom") provider = undefined; };
    },
    effect(setup) {
      cleanup = setup();
      return () => {};
    },
  } as never);
  if (provider === undefined || cleanup === undefined) throw new Error("intercom fixture did not register");
  return {
    intercom: provider as unknown as {
      register(input: { peerName: string; cwd: string }, signal?: AbortSignal): Promise<any>;
      heartbeat(input: { sessionId: string }, signal?: AbortSignal): Promise<any>;
      unregister(input: { sessionId: string }, signal?: AbortSignal): Promise<any>;
      listSessions(signal?: AbortSignal): Promise<any>;
      send(input: any, signal?: AbortSignal): Promise<any>;
      inbox(input: { sessionId: string }, signal?: AbortSignal): Promise<any>;
      read(input: { sessionId: string; seq: number }, signal?: AbortSignal): Promise<any>;
      markDelivered(input: { sessionId: string; seqs: readonly number[] }, signal?: AbortSignal): Promise<any>;
      pending(input: { sessionId: string }, signal?: AbortSignal): Promise<any>;
      acquireLease(input: { cwd: string; holder: string }, signal?: AbortSignal): Promise<any>;
      releaseLease(input: { cwd: string; holder: string }, signal?: AbortSignal): Promise<any>;
    },
    markDisposed: () => (provider as unknown as { markDisposed(): void }).markDisposed(),
    storageDir, dshHome,
    dispose: async () => {
      await cleanup?.();
      unregisterBackend();
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      await rm(storageDir, { recursive: true, force: true });
      await rm(dshHome, { recursive: true, force: true });
    },
  };
}

test("register/list/heartbeat/unregister: status derivation", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "alpha", cwd: "/tmp/proj-a" });
    const b: any = await h.intercom.register({ peerName: "beta", cwd: "/tmp/proj-b" });
    assert.equal(a.ok, true);
    assert.equal(typeof a.value.sessionId, "string");
    const list: any = await h.intercom.listSessions();
    assert.equal(list.value.length, 2);
    assert.equal(list.value.every((s: any) => s.status === "running"), true);
    assert.equal(list.value.every((s: any) => s.pending === 0), true);
    // heartbeat advances lastSeenAt
    const before = list.value[0].lastSeenAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    const hb: any = await h.intercom.heartbeat({ sessionId: a.value.sessionId });
    assert.equal(hb.ok, true);
    assert.ok(hb.value.lastSeenAt > before);
    // unknown session
    const missing: any = await h.intercom.heartbeat({ sessionId: "nope" });
    assert.equal(missing.error.code, "session-not-found");
    // unregister → stopped; heartbeat after stop fails
    const un: any = await h.intercom.unregister({ sessionId: b.value.sessionId });
    assert.equal(un.ok, true);
    const after: any = await h.intercom.listSessions();
    assert.equal(after.value.find((s: any) => s.sessionId === b.value.sessionId).status, "stopped");
    const dead: any = await h.intercom.heartbeat({ sessionId: b.value.sessionId });
    assert.equal(dead.error.code, "session-not-found");
  } finally { await h.dispose(); }
});

test("send: monotonic seq + concurrent CAS produces unique seqs", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "alpha", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "beta", cwd: "/tmp/b" });
    const first: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "hello one" });
    assert.equal(first.ok, true);
    assert.equal(first.value.seq, 1);
    // 20 concurrent sends: all unique, strictly ascending set
    const sends = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: `m${i}` })));
    const seqs = sends.map((r: any) => r.value.seq);
    assert.equal(new Set(seqs).size, 20);
    assert.equal(seqs.every(s => s > 1), true);
    const all = [first.value.seq, ...seqs].sort((x, y) => x - y);
    for (let i = 1; i < all.length; i++) assert.equal(all[i], all[i - 1] + 1);
    // by-peer resolution + ambiguity
    const byPeer: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toPeer: "beta", text: "by name" });
    assert.equal(byPeer.ok, true);
    await h.intercom.register({ peerName: "beta", cwd: "/tmp/b2" });
    const ambiguous: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toPeer: "beta", text: "x" });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.error.code, "peer-not-found");
    const unknownPeer: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toPeer: "ghost", text: "x" });
    assert.equal(unknownPeer.error.code, "peer-not-found");
    const bothMissing: any = await h.intercom.send({ fromSessionId: a.value.sessionId, text: "x" });
    assert.equal(bothMissing.error.code, "invalid-params");
  } finally { await h.dispose(); }
});

test("inbox/pending/markDelivered lifecycle", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "alpha", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "beta", cwd: "/tmp/b" });
    const s1: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "one" });
    const s2: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "two", kind: "ask" });
    let inbox: any = await h.intercom.inbox({ sessionId: b.value.sessionId });
    assert.equal(inbox.value.length, 2);
    assert.deepEqual(inbox.value.map((e: any) => e.seq), [s1.value.seq, s2.value.seq]);
    assert.match(inbox.value[0].textDigest, /^sha256:[0-9a-f]{64}$/);
    let pending: any = await h.intercom.pending({ sessionId: b.value.sessionId });
    assert.equal(pending.value, 2);
    // listSessions reflects pending count
    const list: any = await h.intercom.listSessions();
    assert.equal(list.value.find((s: any) => s.sessionId === b.value.sessionId).pending, 2);
    // mark delivered (one foreign seq is ignored)
    const foreign: any = await h.intercom.send({ fromSessionId: b.value.sessionId, toSessionId: a.value.sessionId, text: "back" });
    const marked: any = await h.intercom.markDelivered({ sessionId: b.value.sessionId, seqs: [s1.value.seq, foreign.value.seq, 999999] });
    assert.equal(marked.value.marked, 1);
    inbox = await h.intercom.inbox({ sessionId: b.value.sessionId });
    assert.equal(inbox.value.length, 1);
    pending = await h.intercom.pending({ sessionId: b.value.sessionId });
    assert.equal(pending.value, 1);
  } finally { await h.dispose(); }
});

test("read: sender/recipient allowed, third party denied; 64KB boundary", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "alpha", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "beta", cwd: "/tmp/b" });
    const c: any = await h.intercom.register({ peerName: "gamma", cwd: "/tmp/c" });
    const maxText = "x".repeat(64 * 1024);
    const sent: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: maxText });
    assert.equal(sent.ok, true);
    const over: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "x".repeat(64 * 1024 + 1) });
    assert.equal(over.error.code, "invalid-text");
    const nulText: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "a\u0000b" });
    assert.equal(nulText.error.code, "invalid-text");
    const empty: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "" });
    assert.equal(empty.error.code, "invalid-text");
    // sender reads full text
    const bySender: any = await h.intercom.read({ sessionId: a.value.sessionId, seq: sent.value.seq });
    assert.equal(bySender.ok, true);
    assert.equal(bySender.value.text.length, 64 * 1024);
    // recipient reads
    const byRecipient: any = await h.intercom.read({ sessionId: b.value.sessionId, seq: sent.value.seq });
    assert.equal(byRecipient.ok, true);
    // third party denied
    const byThird: any = await h.intercom.read({ sessionId: c.value.sessionId, seq: sent.value.seq });
    assert.equal(byThird.ok, false);
    assert.equal(byThird.error.code, "denied");
    // unknown seq
    const missing: any = await h.intercom.read({ sessionId: a.value.sessionId, seq: 424242 });
    assert.equal(missing.error.code, "message-not-found");
  } finally { await h.dispose(); }
});

test("bodies never enter the domain: storage dump has zero plaintext", async () => {
  const h = await fixture();
  try {
    const a: any = await h.intercom.register({ peerName: "alpha", cwd: "/tmp/a" });
    const b: any = await h.intercom.register({ peerName: "beta", cwd: "/tmp/b" });
    const secret = "TOPSECRET-plaintext-payload-123";
    const sent: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: secret });
    assert.equal(sent.ok, true);
    // scan every file in the storage dir for the plaintext
    const files = await readdir(h.storageDir, { recursive: true });
    let dump = "";
    for (const file of files) {
      try { dump += await readFile(join(h.storageDir, String(file)), "utf8"); } catch { /* ignore */ }
    }
    assert.equal(dump.includes(secret), false);
    assert.equal(dump.includes("TOPSECRET"), false);
    // but the body file exists under DSH_HOME and round-trips
    const { intercomBaseDir } = await import("../src/store.ts");
    const body = await readFile(join(intercomBaseDir(), "messages", `${sent.value.seq}.txt`), "utf8");
    assert.equal(body, secret);
    // domain record carries only digest+ref
    const inbox: any = await h.intercom.inbox({ sessionId: b.value.sessionId });
    assert.match(inbox.value[0].textDigest, /^sha256:/);
    assert.ok(inbox.value[0].contentRef.includes("messages"));
  } finally { await h.dispose(); }
});

test("file lease: acquire/expire/release + advisory reads unaffected", async () => {
  const h = await fixture();
  try {
    const cwd = "/tmp/leased-proj";
    const first: any = await h.intercom.acquireLease({ cwd, holder: "alpha" });
    assert.equal(first.ok, true);
    assert.equal(first.value.holder, "alpha");
    assert.equal(first.value.valid, true);
    // another holder sees the existing lease (advisory info, not a block)
    const second: any = await h.intercom.acquireLease({ cwd, holder: "beta" });
    assert.equal(second.ok, true);
    assert.equal(second.value.holder, "alpha");
    // same holder re-acquires (refresh)
    const again: any = await h.intercom.acquireLease({ cwd, holder: "alpha" });
    assert.equal(again.value.holder, "alpha");
    // wrong holder cannot release
    const wrongRelease: any = await h.intercom.releaseLease({ cwd, holder: "beta" });
    assert.equal(wrongRelease.ok, false);
    assert.equal(wrongRelease.error.code, "denied");
    // right holder releases; then another can acquire
    const released: any = await h.intercom.releaseLease({ cwd, holder: "alpha" });
    assert.equal(released.ok, true);
    const third: any = await h.intercom.acquireLease({ cwd, holder: "beta" });
    assert.equal(third.value.holder, "beta");
    // expired lease (older than TTL) is overwritable: simulate by writing an old lease file
    const { writeLease } = await import("../src/store.ts");
    await writeLease(cwd, "stale-holder");
    const { readLease, leasePath } = await import("../src/store.ts");
    const path = leasePath(cwd);
    const stale = { holder: "stale-holder", acquiredAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify(stale), "utf8");
    const reRead = await readLease(cwd);
    assert.equal(reRead !== null, true);
    const takeover: any = await h.intercom.acquireLease({ cwd, holder: "gamma" });
    assert.equal(takeover.value.holder, "gamma");
    // advisory: reads/inbox/sends are never blocked by any lease
    const a: any = await h.intercom.register({ peerName: "alpha", cwd });
    const b: any = await h.intercom.register({ peerName: "beta", cwd });
    const sent: any = await h.intercom.send({ fromSessionId: a.value.sessionId, toSessionId: b.value.sessionId, text: "not blocked" });
    assert.equal(sent.ok, true);
    const read: any = await h.intercom.read({ sessionId: b.value.sessionId, seq: sent.value.seq });
    assert.equal(read.ok, true);
  } finally { await h.dispose(); }
});

test("gates: disposed provider refuses; aborted signal refuses", async () => {
  const h = await fixture();
  try {
    const c = new AbortController();
    c.abort();
    const a: any = await h.intercom.register({ peerName: "x", cwd: "/tmp/x" }, c.signal);
    assert.equal(a.error.code, "invalid-params");
    h.markDisposed();
    const b: any = await h.intercom.listSessions();
    assert.equal(b.error.code, "disposed");
    const s: any = await h.intercom.send({ fromSessionId: "x", toSessionId: "y", text: "z" });
    assert.equal(s.error.code, "disposed");
  } finally { await h.dispose(); }
});

test("durability: reopen continues seq and preserves state", async () => {
  // first provider writes two messages
  const storageDir = await mkdtemp(join(tmpdir(), "intercom-dur-"));
  const dshHome = await mkdtemp(join(tmpdir(), "intercom-dur-dsh-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  const openProvider = async () => {
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
    if (provider === undefined || cleanup === undefined) throw new Error("reopen failed");
    return { provider: provider as any, cleanup: cleanup as () => any, unregisterBackend };
  };
  try {
    const p1 = await openProvider();
    const a1: any = await p1.provider.register({ peerName: "alpha", cwd: "/tmp/a" });
    const b1: any = await p1.provider.register({ peerName: "beta", cwd: "/tmp/b" });
    await p1.provider.send({ fromSessionId: a1.value.sessionId, toSessionId: b1.value.sessionId, text: "first" });
    const second: any = await p1.provider.send({ fromSessionId: a1.value.sessionId, toSessionId: b1.value.sessionId, text: "second" });
    assert.equal(second.value.seq, 2);
    await p1.cleanup();
    // reopen: seq continues at 3, state preserved
    const p2 = await openProvider();
    const list: any = await p2.provider.listSessions();
    assert.equal(list.value.length, 2);
    const third: any = await p2.provider.send({ fromSessionId: a1.value.sessionId, toSessionId: b1.value.sessionId, text: "third" });
    assert.equal(third.ok, true);
    assert.equal(third.value.seq, 3);
    const pending: any = await p2.provider.pending({ sessionId: b1.value.sessionId });
    assert.equal(pending.value, 3);
    const readBack: any = await p2.provider.read({ sessionId: b1.value.sessionId, seq: 1 });
    assert.equal(readBack.value.text, "first");
    await p2.cleanup();
    p1.unregisterBackend();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(storageDir, { recursive: true, force: true });
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("domain shape: global initial + zero-padded message keys", async () => {
  const { messageKey, seqFromKey } = await import("../src/domain.ts");
  assert.equal(messageKey(1), "000000000001");
  assert.equal(messageKey(123456789012), "123456789012");
  assert.equal(seqFromKey("000000000042"), 42);
  // lexicographic == numeric order
  const keys = [2, 10, 100, 9].map(messageKey).sort();
  assert.deepEqual(keys, [2, 9, 10, 100].map(messageKey));
});
