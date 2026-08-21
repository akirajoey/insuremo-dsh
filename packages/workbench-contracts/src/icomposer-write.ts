import { z } from "zod";

const requestIdSchema = z.string().min(1).brand<"RequestId">();
const pushErrorCodeSchema = z.enum([
  "workspace-not-bound",
  "workspace-not-found",
  "invalid-workspace-id",
  "invalid-file-path",
  "invalid-choice",
  "invalid-params",
  "service-disposed",
  "cancelled",
  "invalid-auth",
  "forbidden",
  "prepare-invalidated",
  "lease-revoked",
  "command-failed",
  "timeout",
  "parse-error",
  "cli-error",
  "missing-operation",
  "not-approved",
  "already-executed",
  "missing-pending-input",
  "operation-params-mismatch",
  "busy",
  "record-failed",
  "execution-outcome-unknown",
  "conflict-resolution-required",
]);
export type PushError = z.infer<typeof pushErrorCodeSchema>;

const workspaceRelativeGroovy = z.string().min(1).max(256);

export const pushPreviewRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    files: z.array(workspaceRelativeGroovy).min(1).max(200),
    batch: z.boolean().optional(),
  })
  .strict();
export type PushPreviewRequest = z.infer<typeof pushPreviewRequestSchema>;

export const pushRequestRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    files: z.array(workspaceRelativeGroovy).min(1).max(200),
    batch: z.boolean().optional(),
    checkUsages: z.boolean().optional(),
    skipCompile: z.boolean().optional(),
  })
  .strict();
export type PushRequestRequest = z.infer<typeof pushRequestRequestSchema>;

export const pushExecuteRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    operationId: z.string().min(1),
  })
  .strict();
export type PushExecuteRequest = z.infer<typeof pushExecuteRequestSchema>;

export const pushResolveRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    operationId: z.string().min(1),
    choice: z.enum(["prefer-local", "prefer-server", "cancel"]),
    by: z.string().min(1).max(128),
  })
  .strict();
export type PushResolveRequest = z.infer<typeof pushResolveRequestSchema>;

export const pushStatusRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    operationId: z.string().min(1),
  })
  .strict();
export type PushStatusRequest = z.infer<typeof pushStatusRequestSchema>;

const pushCompileChecksSchema = z
  .object({
    compile: z.boolean(),
    callersFound: z.number().int().min(0),
    callersCompiled: z.number().int().min(0),
    callerFailures: z.number().int().min(0),
  })
  .strict();

export const pushFilePreviewSchema = z
  .object({
    file: z.string().min(1).max(256),
    target: z.string().min(1).max(200),
    localVersion: z.string().regex(/^(sha256:[0-9a-f]{64})?$/),
    serverVersion: z.string().max(200),
    conflict: z.boolean(),
    compileChecks: pushCompileChecksSchema.optional(),
    warnings: z.array(z.string().min(1).max(200)).max(20),
  })
  .strict();
export type PushFilePreview = z.infer<typeof pushFilePreviewSchema>;

export const pushPreviewViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    mode: z.enum(["current", "batch"]),
    files: z.array(pushFilePreviewSchema).max(200),
    conflictFiles: z.array(z.string().min(1).max(256)),
    count: z.number().int().min(0),
    truncated: z.boolean(),
    durationMs: z.number().int().min(0),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type PushPreviewView = z.infer<typeof pushPreviewViewSchema>;

export const pushRequestViewSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.enum(["imo-icomposer-push", "imo-icomposer-push-resolve"]),
    mode: z.enum(["current", "batch"]),
    files: z.array(z.string().min(1).max(256)),
    paramsDigest: z.string().min(1),
    decision: z.literal("pending"),
    preview: pushPreviewViewSchema,
  })
  .strict();
export type PushRequestView = z.infer<typeof pushRequestViewSchema>;

export const pushReceiptSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.enum(["imo-icomposer-push", "imo-icomposer-push-resolve"]),
    mode: z.enum(["current", "batch"]),
    files: z.array(z.string().min(1).max(256)),
    requestedFlags: z
      .object({
        checkUsages: z.boolean().optional(),
        skipCompile: z.boolean().optional(),
        prefer: z.enum(["prefer-local", "prefer-server"]).optional(),
      })
      .strict(),
    status: z.enum(["completed", "failed", "conflict"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdoutDigest: z.string().min(1),
    stderrDigest: z.string().min(1),
    conflictFiles: z.array(z.string().min(1).max(256)),
    conflictSummary: z.string().max(200),
    pushDigest: z.string().min(1),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
  })
  .strict();
export type PushReceipt = z.infer<typeof pushReceiptSchema>;

export const pushResolveViewSchema = z.discriminatedUnion("decision", [
  z
    .object({
      operationId: z.string().min(1),
      kind: z.literal("imo-icomposer-push-resolve"),
      choice: z.literal("cancel"),
      decision: z.literal("rejected"),
      reason: z.string().min(1),
      originalOperationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      operationId: z.string().min(1),
      kind: z.literal("imo-icomposer-push-resolve"),
      choice: z.enum(["prefer-local", "prefer-server"]),
      decision: z.literal("pending"),
      originalOperationId: z.string().min(1),
      paramsDigest: z.string().min(1),
      mode: z.enum(["current", "batch"]),
      files: z.array(z.string().min(1).max(256)),
    })
    .strict(),
]);
export type PushResolveView = z.infer<typeof pushResolveViewSchema>;

export const pushStatusViewSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.enum(["imo-icomposer-push", "imo-icomposer-push-resolve"]),
    decision: z.enum(["pending", "approved", "rejected"]),
    paramsDigest: z.string().min(1),
    resultDigest: z.string().min(1).optional(),
    executed: z.boolean(),
    status: z.enum(["completed", "failed", "conflict"]).optional(),
    conflictFiles: z.array(z.string().min(1).max(256)),
    prefer: z.enum(["prefer-local", "prefer-server"]).optional(),
    originalOperationId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();
export type PushStatusView = z.infer<typeof pushStatusViewSchema>;

export const pushExecutionSchema = z.union([
  z.object({ ok: z.literal(true), receipt: pushReceiptSchema, evidencePending: z.boolean().optional() }).strict(),
  z.object({
    ok: z.literal(false),
    error: z
      .object({ code: pushErrorCodeSchema, message: z.string().min(1), operationId: z.string().min(1) })
      .strict(),
  }).strict(),
]);
export type PushExecution = z.infer<typeof pushExecutionSchema>;
