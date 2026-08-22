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

// ---- TASK-029: test + release ----

const assetName = z.string().min(1).max(200);

export const testRunRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    kind: z.enum(["api", "function"]),
    name: assetName,
    data: z.string().max(65536).optional(),
    method: z.string().min(1).max(128).optional(),
    overrideUnpushed: z.boolean().optional(),
  })
  .strict();
export type TestRunRequest = z.infer<typeof testRunRequestSchema>;

export const testRunViewSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.literal("imo-icomposer-test"),
    assetKind: z.enum(["api", "function"]),
    name: assetName,
    paramsDigest: z.string().min(1),
    decision: z.literal("pending"),
    joinState: z.enum(["clean", "local-modified", "no-server-md5", "source-missing", "metadata-missing"]),
    overrideUnpushed: z.boolean(),
  })
  .strict();
export type TestRunView = z.infer<typeof testRunViewSchema>;

export const releasePreviewRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    type: z.enum(["api", "function"]),
    name: assetName,
    repo: z.string().min(1).max(512),
    branch: z.string().min(1).max(128),
    message: z.string().min(1).max(500),
  })
  .strict();
export type ReleasePreviewRequest = z.infer<typeof releasePreviewRequestSchema>;

export const releasePreviewViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    type: z.enum(["api", "function"]),
    name: assetName,
    valid: z.boolean(),
    warnings: z.array(z.string().min(1).max(200)).max(20),
    durationMs: z.number().int().min(0),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type ReleasePreviewView = z.infer<typeof releasePreviewViewSchema>;

export const releaseReposRequestSchema = z
  .object({ requestId: requestIdSchema, schemaVersion: z.literal("0"), workspaceId: z.string().min(1) })
  .strict();
export type ReleaseReposRequest = z.infer<typeof releaseReposRequestSchema>;

export const releaseRepoViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    repos: z.array(z.string().min(1).max(512)).max(200),
    count: z.number().int().min(0),
    truncated: z.boolean(),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type ReleaseRepoView = z.infer<typeof releaseRepoViewSchema>;

export const releaseBranchesRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    repo: z.string().min(1).max(512),
  })
  .strict();
export type ReleaseBranchesRequest = z.infer<typeof releaseBranchesRequestSchema>;

export const releaseBranchViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    repo: z.string().min(1).max(512),
    branches: z.array(z.string().min(1).max(128)).max(200),
    count: z.number().int().min(0),
    truncated: z.boolean(),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type ReleaseBranchView = z.infer<typeof releaseBranchViewSchema>;

export const releaseApplyRequestSchema = releasePreviewRequestSchema;
export type ReleaseApplyRequest = ReleasePreviewRequest;

export const releaseApplyViewSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.literal("imo-icomposer-release"),
    type: z.enum(["api", "function"]),
    name: assetName,
    repo: z.string().min(1).max(512),
    branch: z.string().min(1).max(128),
    paramsDigest: z.string().min(1),
    decision: z.literal("pending"),
  })
  .strict();
export type ReleaseApplyView = z.infer<typeof releaseApplyViewSchema>;

// ---- TASK-030: create + metadata ----

const createOptionEntrySchema = z
  .object({
    code: z.number().int(),
    label: z.string().min(1).max(200),
    canonicalInput: z.string().min(1).max(200),
    allowedMethods: z.array(z.string().min(1).max(32)).max(16).optional(),
  })
  .strict();
export type CreateOptionEntry = z.infer<typeof createOptionEntrySchema>;

const optionList = z.array(createOptionEntrySchema).max(50);

export const createOptionsRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    kind: z.enum(["api", "function"]),
  })
  .strict();
export type CreateOptionsRequest = z.infer<typeof createOptionsRequestSchema>;

export const createOptionsViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    kind: z.enum(["api", "function"]),
    status: optionList,
    funcScope: optionList,
    requestMethod: optionList,
    requestType: optionList,
    responseType: optionList,
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type CreateOptionsView = z.infer<typeof createOptionsViewSchema>;

const numericId = z.string().regex(/^[0-9]{1,19}$/);
const aliasToken = z.string().min(1).max(64);

export const createPreviewRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    kind: z.enum(["api", "function"]),
    params: z
      .object({
        name: assetName,
        moduleId: numericId,
        groupId: numericId,
        status: aliasToken,
        requestMethod: aliasToken.optional(),
        requestType: aliasToken.optional(),
        responseType: aliasToken.optional(),
        requestModelId: numericId.optional(),
        responseModelId: numericId.optional(),
        path: z.string().min(1).max(256).optional(),
        description: z.string().min(1).max(500).optional(),
        sse: z.boolean().optional(),
        integration: z.string().min(1).max(200).optional(),
        funcScope: aliasToken.optional(),
      })
      .strict(),
  })
  .strict();
export type CreatePreviewRequest = z.infer<typeof createPreviewRequestSchema>;

export const createPreviewViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    kind: z.enum(["api", "function"]),
    name: assetName,
    valid: z.boolean(),
    warnings: z.array(z.string().min(1).max(200)).max(20),
    durationMs: z.number().int().min(0),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type CreatePreviewView = z.infer<typeof createPreviewViewSchema>;

export const createExecuteRequestSchema = z
  .object({ requestId: requestIdSchema, schemaVersion: z.literal("0"), operationId: z.string().min(1) })
  .strict();
export type CreateExecuteRequest = z.infer<typeof createExecuteRequestSchema>;

export const createReceiptSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.literal("imo-icomposer-create"),
    assetKind: z.enum(["api", "function"]),
    name: assetName,
    status: z.enum(["completed", "failed"]),
    exitCode: z.number().int().nullable(),
    stdoutDigest: z.string().min(1),
    stderrDigest: z.string().min(1),
    catalogVerified: z.boolean(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
  })
  .strict();
export type CreateReceipt = z.infer<typeof createReceiptSchema>;

const metadataFieldsSchema = z
  .object({
    status: aliasToken.optional(),
    description: z.string().max(500).optional(),
    sse: z.boolean().optional(),
    integration: z.string().min(1).max(200).optional(),
    funcScope: aliasToken.optional(),
  })
  .strict();
export type MetadataFields = z.infer<typeof metadataFieldsSchema>;

export const metadataPreviewRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    file: z.string().min(1).max(256),
    fields: metadataFieldsSchema,
  })
  .strict();
export type MetadataPreviewRequest = z.infer<typeof metadataPreviewRequestSchema>;

export const metadataPreviewViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    file: z.string().min(1).max(256),
    valid: z.boolean(),
    warnings: z.array(z.string().min(1).max(200)).max(20),
    durationMs: z.number().int().min(0),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type MetadataPreviewView = z.infer<typeof metadataPreviewViewSchema>;

export const metadataExecuteRequestSchema = createExecuteRequestSchema;
export type MetadataExecuteRequest = CreateExecuteRequest;

export const metadataReceiptSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.literal("imo-icomposer-metadata-update"),
    file: z.string().min(1).max(256),
    fieldsApplied: z.array(z.enum(["status", "description", "sse", "integration", "funcScope"])).min(1),
    status: z.enum(["completed", "failed"]),
    exitCode: z.number().int().nullable(),
    stdoutDigest: z.string().min(1),
    stderrDigest: z.string().min(1),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
  })
  .strict();
export type MetadataReceipt = z.infer<typeof metadataReceiptSchema>;
