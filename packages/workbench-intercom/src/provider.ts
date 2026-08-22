import { randomUUID } from "node:crypto";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import type { IntercomDomain } from "./domain.ts";
import { messageKey, seqFromKey } from "./domain.ts";
import {
  canonicalCwd,
  digestText,
  isValidText,
  leaseValid,
  messagePath,
  readLease,
  readMessageText,
  removeLease,
  writeLease,
  writeMessageText,
} from "./store.ts";
import {
  ASK_TIMEOUT_MAX_MS,
  type InboxEntry,
  type IntercomContext,
  type IntercomErrorCode,
  type MessageKind,
  type MessageRecord,
  type Result,
  type SessionRecord,
  type SessionStatus,
  type SessionView,
} from "./types.ts";

const PEER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEASE_TTL_MS = 30 * 60 * 1000;

function err(code: IntercomErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}

function isKind(value: unknown): value is MessageKind {
  return value === "message" || value === "ask" || value === "reply" || value === "cancel";
}

/**
 * Host provider: session registry + digest-only message metadata in a
 * storage domain, message bodies as bounded files under DSH_HOME. All
 * mutations serialize on one write chain; seq allocation reads and
 * durably replaces the domain global inside that chain (CAS by
 * construction — the chain is the serialization point).
 *
 * Per send exactly one message record is stored, `direction=inbound`,
 * addressed to the receiving session; the sender-side view derives from
 * the `from` field (both endpoints may `read`).
 */
export class IntercomProvider {
  #disposed = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #sessions: ReturnType<Domain<IntercomDomain>["table"]>;
  readonly #messages: ReturnType<Domain<IntercomDomain>["table"]>;
  #globalSet: ((value: { nextDeliverySeq: number }) => Promise<void>) | undefined;
  #globalGet: (() => { nextDeliverySeq: number }) | undefined;

  constructor(
    private readonly ctx: IntercomContext,
    domain: Domain<IntercomDomain>,
  ) {
    this.#sessions = domain.table("sessions");
    this.#messages = domain.table("messages");
  }

  markDisposed(): void {
    this.#disposed = true;
  }

  /** Wire the durable global handles (called once by applyIntercom). */
  bindGlobal(getter: () => { nextDeliverySeq: number }, setter: (value: { nextDeliverySeq: number }) => Promise<void>): void {
    this.#globalGet = getter;
    this.#globalSet = setter;
  }

  async register(input: { peerName: string; cwd: string }, signal?: AbortSignal): Promise<Result<{ sessionId: string }>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.peerName !== "string" || !PEER_NAME_RE.test(input.peerName)) return err("invalid-peer-name");
    if (typeof input?.cwd !== "string" || input.cwd.length < 1 || input.cwd.length > 512) return err("invalid-cwd");
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const record: SessionRecord = {
      sessionId,
      peerName: input.peerName,
      cwd: canonicalCwd(input.cwd),
      createdAt: now,
      lastSeenAt: now,
      status: "running",
      schemaVersion: "0",
    };
    try {
      await this.enqueue(() => this.#sessions.put(sessionId, record));
    } catch {
      return err("storage-error");
    }
    return { ok: true, value: { sessionId } };
  }

  async heartbeat(input: { sessionId: string }, signal?: AbortSignal): Promise<Result<{ lastSeenAt: string }>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.sessionId !== "string" || !SESSION_ID_RE.test(input.sessionId)) return err("invalid-session-id");
    try {
      return await this.enqueue(async () => {
        const current = this.#sessions.get(input.sessionId);
        if (current === undefined) return err("session-not-found");
        if (current.status === "stopped") return err("session-not-found", "session is stopped");
        const lastSeenAt = new Date().toISOString();
        await this.#sessions.put(input.sessionId, { ...current, lastSeenAt });
        return { ok: true, value: { lastSeenAt } };
      });
    } catch {
      return err("storage-error");
    }
  }

  async unregister(input: { sessionId: string }, signal?: AbortSignal): Promise<Result<true>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.sessionId !== "string" || !SESSION_ID_RE.test(input.sessionId)) return err("invalid-session-id");
    try {
      return await this.enqueue(async () => {
        const current = this.#sessions.get(input.sessionId);
        if (current === undefined) return err("session-not-found");
        await this.#sessions.put(input.sessionId, { ...current, status: "stopped", lastSeenAt: new Date().toISOString() });
        return { ok: true, value: true as const };
      });
    } catch {
      return err("storage-error");
    }
  }

  async listSessions(signal?: AbortSignal): Promise<Result<readonly SessionView[]>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    const pendingBySession = new Map<string, number>();
    for (const [, record] of this.#messages.entries()) {
      if (record.deliveredAt !== undefined || record.direction !== "inbound") continue;
      pendingBySession.set(record.to, (pendingBySession.get(record.to) ?? 0) + 1);
    }
    const views: SessionView[] = [];
    for (const [, record] of this.#sessions.entries()) {
      views.push({
        sessionId: record.sessionId,
        peerName: record.peerName,
        cwd: record.cwd,
        status: record.status,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
        pending: pendingBySession.get(record.sessionId) ?? 0,
      });
    }
    views.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId));
    return { ok: true, value: views };
  }

  async send(input: { fromSessionId: string; toSessionId?: string; toPeer?: string; text: string; kind?: MessageKind }, signal?: AbortSignal): Promise<Result<{ seq: number; createdAt: string }>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.fromSessionId !== "string" || !SESSION_ID_RE.test(input.fromSessionId)) return err("invalid-session-id");
    if (input.kind !== undefined && !isKind(input.kind)) return err("invalid-params", "kind must be message, ask, reply, or cancel");
    if (!isValidText(input?.text)) return err("invalid-text", "text must be 1-64KB without NUL bytes");
    if ((input.toSessionId === undefined) === (input.toPeer === undefined)) {
      return err("invalid-params", "exactly one of toSessionId or toPeer is required");
    }
    if (input.toSessionId !== undefined && !SESSION_ID_RE.test(input.toSessionId)) return err("invalid-session-id");
    try {
      return await this.enqueue(async () => {
        const from = this.#liveSession(input.fromSessionId);
        if (!from.ok) return from;
        const toIdRaw: string | undefined = input.toSessionId;
        if (toIdRaw === undefined) {
          const matches = [...this.#sessions.entries()].filter(([, record]) => record.peerName === input.toPeer);
          if (matches.length === 0) return err("peer-not-found");
          if (matches.length > 1) return err("peer-not-found", "peer name is ambiguous; use toSessionId");
          return this.#deliver(input.fromSessionId, (matches[0][1] as SessionRecord).sessionId, input.text, "message", {});
        }
        return this.#deliver(input.fromSessionId, toIdRaw, input.text, "message", {});
      });
    } catch {
      return err("storage-error");
    }
  }

  // ---- TASK-032: ask / reply / cancel ----

  async ask(input: { fromSessionId: string; toSessionId: string; text: string; timeoutMs?: number }, signal?: AbortSignal): Promise<Result<{ seq: number; createdAt: string; askStatus: "pending" }>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.fromSessionId !== "string" || !SESSION_ID_RE.test(input.fromSessionId)) return err("invalid-session-id");
    if (typeof input?.toSessionId !== "string" || !SESSION_ID_RE.test(input.toSessionId)) return err("invalid-session-id");
    if (!isValidText(input?.text)) return err("invalid-text", "text must be 1-64KB without NUL bytes");
    if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > ASK_TIMEOUT_MAX_MS)) {
      return err("invalid-params", `timeoutMs must be 1-${ASK_TIMEOUT_MAX_MS}`);
    }
    try {
      return await this.enqueue(async () => {
        const from = this.#liveSession(input.fromSessionId);
        if (!from.ok) return from;
        const delivered = await this.#deliver(input.fromSessionId, input.toSessionId, input.text, "ask", { askStatus: "pending", askedAt: new Date().toISOString(), markReceiverWaiting: true });
        if (!delivered.ok) return delivered;
        return { ok: true, value: { seq: delivered.value.seq, createdAt: delivered.value.createdAt, askStatus: "pending" as const } };
      });
    } catch {
      return err("storage-error");
    }
  }

  async reply(input: { fromSessionId: string; toSeq: number; text: string }, signal?: AbortSignal): Promise<Result<{ seq: number; createdAt: string; replyToSeq: number; restored: boolean }>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.fromSessionId !== "string" || !SESSION_ID_RE.test(input.fromSessionId)) return err("invalid-session-id");
    if (typeof input?.toSeq !== "number" || !Number.isInteger(input.toSeq) || input.toSeq < 1) return err("invalid-seq");
    if (!isValidText(input?.text)) return err("invalid-text", "text must be 1-64KB without NUL bytes");
    try {
      return await this.enqueue(async () => {
        const replier = this.#liveSession(input.fromSessionId);
        if (!replier.ok) return replier;
        const askRecord = this.#messages.get(messageKey(input.toSeq));
        if (askRecord === undefined || askRecord.kind !== "ask") return err("ask-not-found");
        if (askRecord.to !== input.fromSessionId) return err("denied", "only the asked session may reply");
        if (askRecord.askStatus === "replied") return err("invalid-state", "ask is already replied");
        if (askRecord.askStatus === "cancelled") return err("invalid-state", "ask is cancelled");
        const delivered = await this.#deliver(input.fromSessionId, askRecord.from, input.text, "reply", { replyToSeq: input.toSeq });
        if (!delivered.ok) return delivered;
        await this.#messages.put(messageKey(input.toSeq), { ...askRecord, askStatus: "replied", resolvedAt: new Date().toISOString() });
        // release the waiting mark on the replier (simplification: restored flag)
        const restored = await this.#releaseWaiting(input.fromSessionId);
        return { ok: true, value: { seq: delivered.value.seq, createdAt: delivered.value.createdAt, replyToSeq: input.toSeq, restored } };
      });
    } catch {
      return err("storage-error");
    }
  }

  async cancel(input: { fromSessionId: string; seq: number }, signal?: AbortSignal): Promise<Result<{ seq: number; cancelled: true; released: boolean }>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.fromSessionId !== "string" || !SESSION_ID_RE.test(input.fromSessionId)) return err("invalid-session-id");
    if (typeof input?.seq !== "number" || !Number.isInteger(input.seq) || input.seq < 1) return err("invalid-seq");
    try {
      return await this.enqueue(async () => {
        const asker = this.#liveSession(input.fromSessionId);
        if (!asker.ok) return asker;
        const askRecord = this.#messages.get(messageKey(input.seq));
        if (askRecord === undefined || askRecord.kind !== "ask") return err("ask-not-found");
        if (askRecord.from !== input.fromSessionId) return err("denied", "only the asker may cancel");
        if (askRecord.askStatus === "replied") return err("invalid-state", "ask is already replied");
        if (askRecord.askStatus === "cancelled") return err("invalid-state", "ask is already cancelled");
        await this.#messages.put(messageKey(input.seq), { ...askRecord, askStatus: "cancelled", resolvedAt: new Date().toISOString() });
        const released = await this.#releaseWaiting(askRecord.to);
        return { ok: true, value: { seq: input.seq, cancelled: true as const, released } };
      });
    } catch {
      return err("storage-error");
    }
  }

  async pendingAsks(input: { sessionId: string }, signal?: AbortSignal): Promise<Result<readonly InboxEntry[]>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.sessionId !== "string" || !SESSION_ID_RE.test(input.sessionId)) return err("invalid-session-id");
    return { ok: true, value: this.#pendingAsksFor(input.sessionId) };
  }

  async resolveStatus(input: { sessionId: string }, signal?: AbortSignal): Promise<Result<{ status: SessionStatus; waitingFor: readonly number[] }>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.sessionId !== "string" || !SESSION_ID_RE.test(input.sessionId)) return err("invalid-session-id");
    const session = this.#sessions.get(input.sessionId);
    if (session === undefined) return err("session-not-found");
    const waitingFor = this.#pendingAsksFor(input.sessionId).map(entry => entry.seq);
    // Derived fresh from the domain: a session is waiting iff pending asks
    // exist addressed to it (the stored flag is advisory only).
    const derived: SessionStatus = session.status === "stopped" ? "stopped" : waitingFor.length > 0 ? "waiting" : session.status === "waiting" ? "idle" : session.status;
    return { ok: true, value: { status: derived, waitingFor } };
  }

  async inbox(input: { sessionId: string }, signal?: AbortSignal): Promise<Result<readonly InboxEntry[]>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.sessionId !== "string" || !SESSION_ID_RE.test(input.sessionId)) return err("invalid-session-id");
    const entries: InboxEntry[] = [];
    for (const [, record] of this.#messages.entries()) {
      if (record.direction !== "inbound" || record.to !== input.sessionId || record.deliveredAt !== undefined) continue;
      entries.push({
        seq: record.seq,
        from: record.from,
        to: record.to,
        kind: record.kind,
        textDigest: record.textDigest,
        contentRef: record.contentRef,
        createdAt: record.createdAt,
        ...(record.askStatus === undefined ? {} : { askStatus: record.askStatus }),
        ...(record.replyToSeq === undefined ? {} : { replyToSeq: record.replyToSeq }),
      });
    }
    entries.sort((a, b) => a.seq - b.seq);
    return { ok: true, value: entries };
  }

  async read(input: { sessionId: string; seq: number }, signal?: AbortSignal): Promise<Result<{ seq: number; text: string; createdAt: string }>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.sessionId !== "string" || !SESSION_ID_RE.test(input.sessionId)) return err("invalid-session-id");
    if (typeof input?.seq !== "number" || !Number.isInteger(input.seq) || input.seq < 1) return err("invalid-seq");
    const record = this.#messages.get(messageKey(input.seq));
    if (record === undefined) return err("message-not-found");
    if (record.from !== input.sessionId && record.to !== input.sessionId) return err("denied");
    const text = await readMessageText(input.seq);
    if (text === null) return err("storage-error", "message body is missing or oversized");
    if (digestText(text) !== record.textDigest) return err("storage-error", "message body digest mismatch");
    return { ok: true, value: { seq: record.seq, text, createdAt: record.createdAt } };
  }

  async markDelivered(input: { sessionId: string; seqs: readonly number[] }, signal?: AbortSignal): Promise<Result<{ marked: number }>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.sessionId !== "string" || !SESSION_ID_RE.test(input.sessionId)) return err("invalid-session-id");
    if (!Array.isArray(input?.seqs) || input.seqs.length < 1 || input.seqs.length > 1000) return err("invalid-seq");
    if (!input.seqs.every(seq => Number.isInteger(seq) && seq >= 1)) return err("invalid-seq");
    try {
      return await this.enqueue(async () => {
        const now = new Date().toISOString();
        let marked = 0;
        for (const seq of input.seqs) {
          const key = messageKey(seq);
          const record = this.#messages.get(key);
          if (record === undefined || record.to !== input.sessionId || record.direction !== "inbound") continue;
          if (record.deliveredAt !== undefined) { marked += 1; continue; }
          await this.#messages.put(key, { ...record, deliveredAt: now });
          marked += 1;
        }
        return { ok: true, value: { marked } };
      });
    } catch {
      return err("storage-error");
    }
  }

  async pending(input: { sessionId: string }, signal?: AbortSignal): Promise<Result<number>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.sessionId !== "string" || !SESSION_ID_RE.test(input.sessionId)) return err("invalid-session-id");
    let count = 0;
    for (const [, record] of this.#messages.entries()) {
      if (record.direction === "inbound" && record.to === input.sessionId && record.deliveredAt === undefined) count += 1;
    }
    return { ok: true, value: count };
  }

  async acquireLease(input: { cwd: string; holder: string }, signal?: AbortSignal): Promise<Result<{ cwd: string; holder: string; acquiredAt: string; expiresAt: string; valid: boolean }>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.cwd !== "string" || input.cwd.length < 1 || input.cwd.length > 512) return err("invalid-cwd");
    if (typeof input?.holder !== "string" || !PEER_NAME_RE.test(input.holder)) return err("invalid-params", "holder must be a session-scoped name");
    const cwd = canonicalCwd(input.cwd);
    try {
      const existing = await readLease(cwd);
      if (existing !== null && leaseValid(existing) && existing.holder !== input.holder) {
        const expiresAt = new Date(Date.parse(existing.acquiredAt) + LEASE_TTL_MS).toISOString();
        return { ok: true, value: { cwd, holder: existing.holder, acquiredAt: existing.acquiredAt, expiresAt, valid: true } };
      }
      await writeLease(cwd, input.holder);
      const acquiredAt = new Date().toISOString();
      return { ok: true, value: { cwd, holder: input.holder, acquiredAt, expiresAt: new Date(Date.parse(acquiredAt) + LEASE_TTL_MS).toISOString(), valid: true } };
    } catch {
      return err("storage-error");
    }
  }

  async releaseLease(input: { cwd: string; holder: string }, signal?: AbortSignal): Promise<Result<true>> {
    if (this.#disposed) return err("disposed");
    if (signal?.aborted) return err("invalid-params", "cancelled");
    if (typeof input?.cwd !== "string" || input.cwd.length < 1 || input.cwd.length > 512) return err("invalid-cwd");
    if (typeof input?.holder !== "string" || !PEER_NAME_RE.test(input.holder)) return err("invalid-params", "holder must be a session-scoped name");
    const cwd = canonicalCwd(input.cwd);
    try {
      const existing = await readLease(cwd);
      if (existing === null) return { ok: true, value: true as const };
      if (existing.holder !== input.holder) return err("denied", "lease is held by another holder");
      await removeLease(cwd);
      return { ok: true, value: true as const };
    } catch {
      return err("storage-error");
    }
  }

  /** Live (non-stopped) session lookup or a structured error. */
  #liveSession(sessionId: string): Result<SessionRecord> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return err("session-not-found");
    if (record.status === "stopped") return err("session-not-found", "session is stopped");
    return { ok: true, value: record };
  }

  /** Core delivery: seq CAS + record + body file (+ ask/waiting extras). */
  async #deliver(
    fromSessionId: string,
    toSessionId: string,
    text: string,
    kind: MessageKind,
    extras: { askStatus?: "pending" | "replied" | "cancelled"; askedAt?: string; replyToSeq?: number; markReceiverWaiting?: boolean },
  ): Promise<Result<{ seq: number; createdAt: string }>> {
    const to = this.#sessions.get(toSessionId);
    if (to === undefined) return err("session-not-found", "target session does not exist");
    if (to.status === "stopped") return err("session-not-found", "target session is stopped");
    const currentSeq = this.#globalGet?.().nextDeliverySeq ?? 1;
    const seq = currentSeq;
    if (this.#globalSet !== undefined) await this.#globalSet({ nextDeliverySeq: seq + 1 });
    const now = new Date().toISOString();
    const record: MessageRecord = {
      seq,
      sessionId: toSessionId,
      direction: "inbound",
      kind,
      from: fromSessionId,
      to: toSessionId,
      textDigest: digestText(text),
      contentRef: messagePath(seq),
      createdAt: now,
      ...(extras.askStatus === undefined ? {} : { askStatus: extras.askStatus }),
      ...(extras.askedAt === undefined ? {} : { askedAt: extras.askedAt }),
      ...(extras.replyToSeq === undefined ? {} : { replyToSeq: extras.replyToSeq }),
      schemaVersion: "0",
    };
    await this.#messages.put(messageKey(seq), record);
    await writeMessageText(seq, text);
    if (extras.markReceiverWaiting === true && to.status !== "waiting") {
      await this.#sessions.put(toSessionId, { ...to, status: "waiting", lastSeenAt: to.lastSeenAt });
    }
    return { ok: true, value: { seq, createdAt: now } };
  }

  /** Clear a receiver's waiting mark when its last pending ask resolves. */
  async #releaseWaiting(sessionId: string): Promise<boolean> {
    if (this.#pendingAsksFor(sessionId).length > 0) return false;
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.status !== "waiting") return false;
    await this.#sessions.put(sessionId, { ...session, status: "idle" });
    return true;
  }

  /** Pending asks addressed to one session, derived fresh from the domain. */
  #pendingAsksFor(sessionId: string): InboxEntry[] {
    const entries: InboxEntry[] = [];
    for (const [, record] of this.#messages.entries()) {
      if (record.kind !== "ask" || record.to !== sessionId || record.askStatus !== "pending") continue;
      entries.push({
        seq: record.seq,
        from: record.from,
        to: record.to,
        kind: record.kind,
        textDigest: record.textDigest,
        contentRef: record.contentRef,
        createdAt: record.createdAt,
        askStatus: "pending",
      });
    }
    entries.sort((a, b) => a.seq - b.seq);
    return entries;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => undefined, () => undefined);
    return p;
  }
}

void seqFromKey;

/** Register the provider after the injected storage-domain facility is ready. */
export async function applyIntercom(ctx: IntercomContext): Promise<void> {
  const { intercomDomain } = await import("./domain.ts");
  const domain = await ctx.storageDomain.open(intercomDomain);
  try {
    const provider = new IntercomProvider(ctx, domain);
    provider.bindGlobal(
      () => domain.global.get(),
      (value) => domain.global.set(value),
    );
    ctx.effect(() => {
      const unregister = ctx.provide("intercom", provider);
      return async () => {
        unregister();
        provider.markDisposed();
        await domain.close();
      };
    }, "workbench-intercom.provider");
  } catch (error) {
    await domain.close();
    throw error;
  }
}
