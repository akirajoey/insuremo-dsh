/**
 * Structural face of the operation-log service used by the upgrade loop.
 * Cross-plugin collaboration goes through the cordis service boundary; this
 * package never imports the operation-log implementation at runtime, so it
 * declares only the members it consumes.
 */
export interface OperationLogRecordLike {
  readonly id: string;
  readonly kind: string;
  readonly decision: "pending" | "approved" | "rejected";
  readonly paramsDigest?: string;
  readonly resultDigest?: string;
  readonly artifactRefs?: readonly string[];
}

export interface OperationLogLike {
  append(input: {
    readonly requestId: string;
    readonly kind: string;
    readonly paramsDigest: string;
    readonly artifactRefs: readonly string[];
  }): Promise<OperationLogRecordLike>;
  list(): readonly OperationLogRecordLike[];
  recordResult(
    id: string,
    input: { readonly resultDigest: string; readonly artifactRefs: readonly string[] },
  ): Promise<OperationLogRecordLike>;
}
