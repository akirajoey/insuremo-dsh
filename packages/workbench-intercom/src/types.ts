import { z } from "zod";

/** Durable record format version owned by this package. */
export const INTERCOM_SCHEMA_VERSION = "0" as const;

/** Cordis service name provided by this package. */
export const INTERCOM_SERVICE = "intercom" as const;

export type IntercomErrorCode =
  | "invalid-session-id"
  | "invalid-peer-name"
  | "invalid-cwd"
  | "invalid-text"
  | "invalid-seq"
  | "invalid-params"
  | "session-not-found"
  | "peer-not-found"
  | "message-not-found"
  | "denied"
  | "storage-error"
  | "disposed";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: IntercomErrorCode; readonly message: string } };

export type SessionStatus = "running" | "idle" | "waiting" | "stopped";
export type MessageDirection = "inbound" | "outbound";
export type MessageKind = "message" | "ask";

const timestampSchema = z.string().datetime({ offset: true });
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const sessionRecordSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    peerName: z.string().min(1).max(128),
    cwd: z.string().min(1).max(512),
    createdAt: timestampSchema,
    lastSeenAt: timestampSchema,
    status: z.enum(["running", "idle", "waiting", "stopped"]),
    schemaVersion: z.literal(INTERCOM_SCHEMA_VERSION),
  })
  .strict();
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export const messageRecordSchema = z
  .object({
    seq: z.number().int().min(1),
    sessionId: z.string().min(1).max(128),
    direction: z.enum(["inbound", "outbound"]),
    kind: z.enum(["message", "ask"]),
    from: z.string().min(1).max(128),
    to: z.string().min(1).max(128),
    textDigest: digestSchema,
    contentRef: z.string().min(1).max(512),
    createdAt: timestampSchema,
    deliveredAt: timestampSchema.optional(),
    schemaVersion: z.literal(INTERCOM_SCHEMA_VERSION),
  })
  .strict();
export type MessageRecord = z.infer<typeof messageRecordSchema>;

export const intercomGlobalSchema = z.object({ nextDeliverySeq: z.number().int().min(1) }).strict();
export type IntercomGlobal = z.infer<typeof intercomGlobalSchema>;

export interface SessionView {
  readonly sessionId: string;
  readonly peerName: string;
  readonly cwd: string;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly pending: number;
}

export interface InboxEntry {
  readonly seq: number;
  readonly from: string;
  readonly to: string;
  readonly kind: MessageKind;
  readonly textDigest: string;
  readonly contentRef: string;
  readonly createdAt: string;
}

export interface LeaseView {
  readonly cwd: string;
  readonly holder: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly valid: boolean;
}

export interface IntercomFace {
  register(input: { readonly peerName: string; readonly cwd: string }, signal?: AbortSignal): Promise<Result<{ readonly sessionId: string }>>;
  heartbeat(input: { readonly sessionId: string }, signal?: AbortSignal): Promise<Result<{ readonly lastSeenAt: string }>>;
  unregister(input: { readonly sessionId: string }, signal?: AbortSignal): Promise<Result<true>>;
  listSessions(signal?: AbortSignal): Promise<Result<readonly SessionView[]>>;
  send(input: { readonly fromSessionId: string; readonly toSessionId?: string; readonly toPeer?: string; readonly text: string; readonly kind?: MessageKind }, signal?: AbortSignal): Promise<Result<{ readonly seq: number; readonly createdAt: string }>>;
  inbox(input: { readonly sessionId: string }, signal?: AbortSignal): Promise<Result<readonly InboxEntry[]>>;
  read(input: { readonly sessionId: string; readonly seq: number }, signal?: AbortSignal): Promise<Result<{ readonly seq: number; readonly text: string; readonly createdAt: string }>>;
  markDelivered(input: { readonly sessionId: string; readonly seqs: readonly number[] }, signal?: AbortSignal): Promise<Result<{ readonly marked: number }>>;
  pending(input: { readonly sessionId: string }, signal?: AbortSignal): Promise<Result<number>>;
  acquireLease(input: { readonly cwd: string; readonly holder: string }, signal?: AbortSignal): Promise<Result<LeaseView>>;
  releaseLease(input: { readonly cwd: string; readonly holder: string }, signal?: AbortSignal): Promise<Result<true>>;
}

/** Structural context contract keeps this package Host-only. */
export interface IntercomContext {
  storageDomain: import("@deepseek-ai/dsh-storage-domain").DomainFacility;
  provide(name: typeof INTERCOM_SERVICE, value: IntercomFace): () => void;
  effect(setup: () => void | (() => void | Promise<void>), label?: string): unknown;
}
