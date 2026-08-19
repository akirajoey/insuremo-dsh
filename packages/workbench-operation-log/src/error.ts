/** Stable error taxonomy for operation-log callers. */
export type OperationLogErrorCode =
  | "invalid-record"
  | "missing-operation"
  | "duplicate-operation"
  | "already-decided"
  | "not-approved"
  | "already-has-result";

export class OperationLogError extends Error {
  constructor(
    readonly code: OperationLogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OperationLogError";
  }
}
