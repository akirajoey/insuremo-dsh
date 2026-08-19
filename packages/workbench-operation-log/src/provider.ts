import { randomUUID } from "node:crypto";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import { OperationLogError } from "./error.ts";
import { operationLogDomain, type OperationLogDomain } from "./domain.ts";
import {
  OPERATION_DECIDED_EVENT,
  OPERATION_LOG_SERVICE,
  OPERATION_RECORDED_EVENT,
  OPERATION_RESULT_RECORDED_EVENT,
  OPERATION_SCHEMA_VERSION,
  operationId,
  operationRecordInputSchema,
  operationRecordSchema,
  type OperationListFilter,
  type OperationLogContext,
  type OperationLogService,
  type OperationRecord,
  type OperationRecordInput,
} from "./types.ts";

function copyRecord(record: OperationRecord): OperationRecord {
  return { ...record, artifactRefs: [...record.artifactRefs] };
}

/** Host provider backed by the schema-validated storage domain. */
export class OperationLogProvider implements OperationLogService {
  private readonly table: ReturnType<Domain<OperationLogDomain>["table"]>;

  constructor(
    private readonly ctx: OperationLogContext,
    domain: Domain<OperationLogDomain>,
  ) {
    this.table = domain.table("operations");
  }

  async append(input: OperationRecordInput): Promise<OperationRecord> {
    const normalized = operationRecordInputSchema.parse(input);
    const id = normalized.id ?? randomUUID();
    const key = operationId(id);
    if (this.table.get(key) !== undefined) {
      throw new OperationLogError("duplicate-operation", `operation '${id}' already exists`);
    }

    const record = operationRecordSchema.parse({
      ...normalized,
      id,
      decision: "pending",
      schemaVersion: OPERATION_SCHEMA_VERSION,
      createdAt: normalized.createdAt ?? new Date().toISOString(),
    });
    await this.table.put(key, record);
    const detached = copyRecord(record);
    this.ctx.emit(OPERATION_RECORDED_EVENT, { record: detached });
    return detached;
  }

  list(filter: OperationListFilter = {}): OperationRecord[] {
    return [...this.table.entries()]
      .map(([, record]) => copyRecord(record))
      .filter((record) => filter.requestId === undefined || record.requestId === filter.requestId)
      .filter((record) => filter.kind === undefined || record.kind === filter.kind)
      .filter((record) => filter.decision === undefined || record.decision === filter.decision)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async decide(id: string, approved: boolean, by: string, reason?: string): Promise<OperationRecord> {
    const current = this.table.get(operationId(id));
    if (current === undefined) {
      throw new OperationLogError("missing-operation", `operation '${id}' does not exist`);
    }
    if (current.decision !== "pending") {
      throw new OperationLogError(
        "already-decided",
        `operation '${id}' is already ${current.decision}`,
      );
    }

    const candidate = {
      ...current,
      decision: approved ? "approved" : "rejected",
      decidedBy: by,
      decidedAt: new Date().toISOString(),
      ...(reason === undefined ? {} : { reason }),
    };
    const record = operationRecordSchema.parse(candidate);
    await this.table.put(operationId(id), record);
    const detached = copyRecord(record);
    this.ctx.emit(OPERATION_DECIDED_EVENT, { record: detached });
    return detached;
  }

  async recordResult(
    id: string,
    input: { resultDigest: string; artifactRefs: string[] },
  ): Promise<OperationRecord> {
    const current = this.table.get(operationId(id));
    if (current === undefined) {
      throw new OperationLogError("missing-operation", `operation '${id}' does not exist`);
    }
    if (current.decision !== "approved") {
      throw new OperationLogError(
        "not-approved",
        `operation '${id}' is ${current.decision}, only approved operations may record a result`,
      );
    }
    if (current.resultDigest !== undefined) {
      throw new OperationLogError(
        "already-has-result",
        `operation '${id}' already has a recorded result`,
      );
    }
    const record = operationRecordSchema.parse({
      ...current,
      resultDigest: input.resultDigest,
      artifactRefs: input.artifactRefs,
    });
    await this.table.put(operationId(id), record);
    const detached = copyRecord(record);
    this.ctx.emit(OPERATION_RESULT_RECORDED_EVENT, { record: detached });
    return detached;
  }
}

/** Register the provider after the injected storage-domain facility is ready. */
export async function applyOperationLog(ctx: OperationLogContext): Promise<void> {
  const domain = await ctx.storageDomain.open(operationLogDomain);
  try {
    const provider = new OperationLogProvider(ctx, domain);
    ctx.effect(() => {
      const unregister = ctx.provide(OPERATION_LOG_SERVICE, provider);
      return async () => {
        unregister();
        await domain.close();
      };
    }, "workbench-operation-log.provider");
  } catch (error) {
    await domain.close();
    throw error;
  }
}
