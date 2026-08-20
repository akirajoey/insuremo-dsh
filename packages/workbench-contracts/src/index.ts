import { z } from "zod";

/** The first stable Workbench API schema version. */
export const schemaVersion = "0" as const;
/** Upper-case alias for consumers that use constants by convention. */
export const SCHEMA_VERSION = schemaVersion;
/** Numeric API generation corresponding to `schemaVersion`. */
export const API_VERSION = 0 as const;

export type SchemaVersion = typeof schemaVersion;

export const requestIdSchema = z.string().min(1).brand<"RequestId">();
export const jobIdSchema = z.string().min(1).brand<"JobId">();
export type RequestId = z.infer<typeof requestIdSchema>;
export type JobId = z.infer<typeof jobIdSchema>;
export const RequestIdSchema = requestIdSchema;
export const JobIdSchema = jobIdSchema;
export const schemaVersionSchema = z.literal(schemaVersion);
export const SchemaVersionSchema = schemaVersionSchema;

export const COMMANDS = {
  systemCapabilities: "system/capabilities",
  workspaceList: "workspace/list",
  workspaceInspect: "workspace/inspect",
  workspaceBind: "workspace/bind",
  workspaceUnbind: "workspace/unbind",
  operationRecord: "operation/record",
  operationList: "operation/list",
  operationDecide: "operation/decide",
} as const;

export type WorkbenchCommand = (typeof COMMANDS)[keyof typeof COMMANDS];

const requestShape = {
  requestId: requestIdSchema,
  schemaVersion: schemaVersionSchema,
};

export const systemCapabilitiesRequestSchema = z.object(requestShape).strict();
export type SystemCapabilitiesRequest = z.infer<typeof systemCapabilitiesRequestSchema>;
export const SystemCapabilitiesRequestSchema = systemCapabilitiesRequestSchema;

export const capabilitySchema = z
  .object({
    command: z.enum([COMMANDS.systemCapabilities, COMMANDS.workspaceList]),
    description: z.string().min(1).optional(),
  })
  .strict();
export type Capability = z.infer<typeof capabilitySchema>;
export const CapabilitySchema = capabilitySchema;

export const systemCapabilitiesResponseSchema = z
  .object({
    ...requestShape,
    capabilities: z.array(capabilitySchema),
  })
  .strict();
export type SystemCapabilitiesResponse = z.infer<typeof systemCapabilitiesResponseSchema>;
export const SystemCapabilitiesResponseSchema = systemCapabilitiesResponseSchema;

// Workspace schemas live in ./workspace.ts; re-export to preserve existing import paths.
export * from "./workspace.ts";

export const OPERATION_DECISIONS = {
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
} as const;

export type OperationDecision = (typeof OPERATION_DECISIONS)[keyof typeof OPERATION_DECISIONS];

export const operationDecisionSchema = z.enum([
  OPERATION_DECISIONS.pending,
  OPERATION_DECISIONS.approved,
  OPERATION_DECISIONS.rejected,
]);
export const OperationDecisionSchema = operationDecisionSchema;

/** Operation kinds are intentionally open-ended so new remote actions do not require a protocol bump. */
export const operationKindSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export type OperationKind = z.infer<typeof operationKindSchema>;
export const OperationKindSchema = operationKindSchema;

const operationTimestampSchema = z.string().datetime({ offset: true });
const operationDigestSchema = z.string().min(1);
const operationArtifactRefsSchema = z.array(z.string().min(1));

/** Durable, digest-only evidence record shared by Host and future clients. */
export const operationRecordSchema = z
  .object({
    id: z.string().min(1),
    requestId: requestIdSchema,
    kind: operationKindSchema,
    paramsDigest: operationDigestSchema,
    artifactRefs: operationArtifactRefsSchema,
    decision: operationDecisionSchema,
    decidedBy: z.string().min(1).optional(),
    decidedAt: operationTimestampSchema.optional(),
    reason: z.string().min(1).optional(),
    resultDigest: operationDigestSchema.optional(),
    schemaVersion: schemaVersionSchema,
    createdAt: operationTimestampSchema,
  })
  .strict()
  .superRefine((record, refinement) => {
    const final = record.decision !== OPERATION_DECISIONS.pending;
    if (final && record.decidedBy === undefined) {
      refinement.addIssue({ code: z.ZodIssueCode.custom, path: ["decidedBy"], message: "required after decision" });
    }
    if (final && record.decidedAt === undefined) {
      refinement.addIssue({ code: z.ZodIssueCode.custom, path: ["decidedAt"], message: "required after decision" });
    }
    if (!final && (record.decidedBy !== undefined || record.decidedAt !== undefined || record.reason !== undefined)) {
      refinement.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: "pending records cannot carry a decision" });
    }
  });
export type OperationRecord = z.infer<typeof operationRecordSchema>;
export const OperationRecordSchema = operationRecordSchema;

const operationRecordInputShape = {
  id: z.string().min(1).optional(),
  kind: operationKindSchema,
  paramsDigest: operationDigestSchema,
  artifactRefs: operationArtifactRefsSchema,
  resultDigest: operationDigestSchema.optional(),
  createdAt: operationTimestampSchema.optional(),
};

/** Request for `operation/record`; the request id is also the operation correlation id. */
export const operationRecordRequestSchema = z
  .object({
    ...requestShape,
    ...operationRecordInputShape,
  })
  .strict();
export type OperationRecordRequest = z.infer<typeof operationRecordRequestSchema>;
export const OperationRecordRequestSchema = operationRecordRequestSchema;

export const operationRecordResponseSchema = z
  .object({
    ...requestShape,
    operation: operationRecordSchema,
  })
  .strict();
export type OperationRecordResponse = z.infer<typeof operationRecordResponseSchema>;
export const OperationRecordResponseSchema = operationRecordResponseSchema;

export const operationListFilterSchema = z
  .object({
    requestId: requestIdSchema.optional(),
    kind: operationKindSchema.optional(),
    decision: operationDecisionSchema.optional(),
  })
  .strict();
export type OperationListFilter = z.infer<typeof operationListFilterSchema>;
export const OperationListFilterSchema = operationListFilterSchema;

export const operationListRequestSchema = z
  .object({
    ...requestShape,
    filter: operationListFilterSchema.optional(),
  })
  .strict();
export type OperationListRequest = z.infer<typeof operationListRequestSchema>;
export const OperationListRequestSchema = operationListRequestSchema;

export const operationListResponseSchema = z
  .object({
    ...requestShape,
    operations: z.array(operationRecordSchema),
  })
  .strict();
export type OperationListResponse = z.infer<typeof operationListResponseSchema>;
export const OperationListResponseSchema = operationListResponseSchema;

export const operationDecideRequestSchema = z
  .object({
    ...requestShape,
    id: z.string().min(1),
    approved: z.boolean(),
    by: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .strict();
export type OperationDecideRequest = z.infer<typeof operationDecideRequestSchema>;
export const OperationDecideRequestSchema = operationDecideRequestSchema;

export const operationDecideResponseSchema = z
  .object({
    ...requestShape,
    operation: operationRecordSchema,
  })
  .strict();
export type OperationDecideResponse = z.infer<typeof operationDecideResponseSchema>;
export const OperationDecideResponseSchema = operationDecideResponseSchema;
