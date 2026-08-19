import type { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

/** The durable record format version owned by this package. */
export const OPERATION_SCHEMA_VERSION = "0" as const;

/** Branded key type used by the storage-domain operations table. */
export type OperationId = string & { readonly __brand: "OperationId" };
export function operationId(value: string): OperationId {
  return value as OperationId;
}

/** Cordis service name provided by the operation-log provider. */
export const OPERATION_LOG_SERVICE = "operationLog" as const;

/** Event emitted after one operation record is durably appended. */
export const OPERATION_RECORDED_EVENT = "operation-log/recorded" as const;

/** Event emitted after one pending record is durably decided. */
export const OPERATION_DECIDED_EVENT = "operation-log/decided" as const;

export const operationDecisionSchema = z.enum(["pending", "approved", "rejected"]);
export type OperationDecision = z.infer<typeof operationDecisionSchema>;

/** Open-ended, lower-kebab operation kind vocabulary. */
export const operationKindSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export type OperationKind = z.infer<typeof operationKindSchema>;

const timestampSchema = z.string().datetime({ offset: true });
const digestSchema = z.string().min(1);
const artifactRefsSchema = z.array(z.string().min(1));

/** The only durable evidence shape: identifiers, digests, decisions, and references. */
export const operationRecordSchema = z
  .object({
    id: z.string().min(1),
    requestId: z.string().min(1),
    kind: operationKindSchema,
    paramsDigest: digestSchema,
    artifactRefs: artifactRefsSchema,
    decision: operationDecisionSchema,
    decidedBy: z.string().min(1).optional(),
    decidedAt: timestampSchema.optional(),
    reason: z.string().min(1).optional(),
    resultDigest: digestSchema.optional(),
    schemaVersion: z.literal(OPERATION_SCHEMA_VERSION),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((record, refinement) => {
    const final = record.decision !== "pending";
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

/** Input accepted by the Host provider; id and creation time are generated when omitted. */
export const operationRecordInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    requestId: z.string().min(1),
    kind: operationKindSchema,
    paramsDigest: digestSchema,
    artifactRefs: artifactRefsSchema,
    resultDigest: digestSchema.optional(),
    createdAt: timestampSchema.optional(),
  })
  .strict();
export type OperationRecordInput = z.infer<typeof operationRecordInputSchema>;

export interface OperationListFilter {
  requestId?: string;
  kind?: OperationKind;
  decision?: OperationDecision;
}

export interface OperationLogService {
  append(input: OperationRecordInput): Promise<OperationRecord>;
  list(filter?: OperationListFilter): OperationRecord[];
  decide(id: string, approved: boolean, by: string, reason?: string): Promise<OperationRecord>;
}

export interface OperationLogRecordedEvent {
  record: OperationRecord;
}

export interface OperationLogDecidedEvent {
  record: OperationRecord;
}

/** Structural context contract keeps this package Host-only without importing React or client types. */
export interface OperationLogContext {
  storageDomain: DomainFacility;
  provide(name: typeof OPERATION_LOG_SERVICE, value: OperationLogService): () => void;
  emit(
    name: typeof OPERATION_RECORDED_EVENT,
    event: OperationLogRecordedEvent,
  ): void;
  emit(
    name: typeof OPERATION_DECIDED_EVENT,
    event: OperationLogDecidedEvent,
  ): void;
  effect(
    setup: () => void | (() => void | Promise<void>),
    label?: string,
  ): unknown;
}
