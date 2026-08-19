import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { operationRecordSchema, type OperationId, type OperationRecord } from "./types.ts";

/** Durable storage unit for Workbench operation evidence. */
export const operationLogDomain = defineDomain({
  name: "workbench_operation_log",
  version: 1,
  tables: {
    operations: domainTable<OperationId, OperationRecord>(operationRecordSchema),
  },
});

export type OperationLogDomain = typeof operationLogDomain;
