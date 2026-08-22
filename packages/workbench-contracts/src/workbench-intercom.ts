import { z } from "zod";

const requestIdSchema = z.string().min(1).brand<"RequestId">();
const peerNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sessionIdSchema = z.string().min(1).max(128);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const intercomErrorCodeSchema = z.enum([
  "invalid-session-id",
  "invalid-peer-name",
  "invalid-cwd",
  "invalid-text",
  "invalid-seq",
  "invalid-params",
  "session-not-found",
  "peer-not-found",
  "message-not-found",
  "denied",
  "storage-error",
  "disposed",
]);
export type IntercomError = z.infer<typeof intercomErrorCodeSchema>;

export const intercomRegisterRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    peerName: peerNameSchema,
    cwd: z.string().min(1).max(512),
  })
  .strict();
export type IntercomRegisterRequest = z.infer<typeof intercomRegisterRequestSchema>;

export const intercomSessionViewSchema = z
  .object({
    sessionId: sessionIdSchema,
    peerName: z.string().min(1).max(128),
    cwd: z.string().min(1).max(512),
    status: z.enum(["running", "idle", "waiting", "stopped"]),
    createdAt: timestampSchema,
    lastSeenAt: timestampSchema,
    pending: z.number().int().min(0),
  })
  .strict();
export type IntercomSessionView = z.infer<typeof intercomSessionViewSchema>;

export const intercomListResponseSchema = z
  .object({ sessions: z.array(intercomSessionViewSchema) })
  .strict();

export const intercomSendRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    fromSessionId: sessionIdSchema,
    toSessionId: sessionIdSchema.optional(),
    toPeer: z.string().min(1).max(128).optional(),
    kind: z.enum(["message", "ask"]).optional(),
    text: z.string().min(1).max(65536),
  })
  .strict();
export type IntercomSendRequest = z.infer<typeof intercomSendRequestSchema>;

export const intercomInboxEntrySchema = z
  .object({
    seq: z.number().int().min(1),
    from: sessionIdSchema,
    to: sessionIdSchema,
    kind: z.enum(["message", "ask"]),
    textDigest: digestSchema,
    contentRef: z.string().min(1).max(512),
    createdAt: timestampSchema,
  })
  .strict();
export type IntercomInboxEntry = z.infer<typeof intercomInboxEntrySchema>;

export const intercomReadResponseSchema = z
  .object({
    seq: z.number().int().min(1),
    text: z.string().min(1).max(65536),
    createdAt: timestampSchema,
  })
  .strict();

export const intercomLeaseViewSchema = z
  .object({
    cwd: z.string().min(1).max(512),
    holder: z.string().min(1).max(128),
    acquiredAt: timestampSchema,
    expiresAt: timestampSchema,
    valid: z.boolean(),
  })
  .strict();
export type IntercomLeaseView = z.infer<typeof intercomLeaseViewSchema>;

// ---- TASK-032: ask / reply / cancel / pending-asks / resolve-status ----

export const ASK_TIMEOUT_MAX_MS = 600_000;

export const intercomAskRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    fromSessionId: sessionIdSchema,
    toSessionId: sessionIdSchema,
    text: z.string().min(1).max(65536),
    timeoutMs: z.number().int().min(1).max(ASK_TIMEOUT_MAX_MS).optional(),
  })
  .strict();
export type IntercomAskRequest = z.infer<typeof intercomAskRequestSchema>;

export const intercomAskResponseSchema = z
  .object({
    seq: z.number().int().min(1),
    createdAt: timestampSchema,
    askStatus: z.literal("pending"),
  })
  .strict();

export const intercomReplyRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    fromSessionId: sessionIdSchema,
    toSeq: z.number().int().min(1),
    text: z.string().min(1).max(65536),
  })
  .strict();
export type IntercomReplyRequest = z.infer<typeof intercomReplyRequestSchema>;

export const intercomReplyResponseSchema = z
  .object({
    seq: z.number().int().min(1),
    createdAt: timestampSchema,
    replyToSeq: z.number().int().min(1),
    restored: z.boolean(),
  })
  .strict();

export const intercomCancelRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    fromSessionId: sessionIdSchema,
    seq: z.number().int().min(1),
  })
  .strict();
export type IntercomCancelRequest = z.infer<typeof intercomCancelRequestSchema>;

export const intercomPendingAskEntrySchema = z
  .object({
    seq: z.number().int().min(1),
    from: sessionIdSchema,
    to: sessionIdSchema,
    askStatus: z.literal("pending"),
    textDigest: digestSchema,
    contentRef: z.string().min(1).max(512),
    createdAt: timestampSchema,
  })
  .strict();
export type IntercomPendingAskEntry = z.infer<typeof intercomPendingAskEntrySchema>;

export const intercomResolveStatusResponseSchema = z
  .object({
    status: z.enum(["running", "idle", "waiting", "stopped"]),
    waitingFor: z.array(z.number().int().min(1)),
  })
  .strict();
