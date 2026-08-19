import { digest } from "../run.ts";
import { AUTH_ACTION_COMPLETED_EVENT, AUTH_ACTION_FAILED_EVENT } from "./action-types.ts";
import type {
  ImoAuthActionError,
  ImoAuthActionExecution,
  ImoAuthActionReceipt,
  ReceiptInput,
} from "./action-types.ts";

export interface ActionFinalizeContext {
  recordResult(id: string, input: { readonly resultDigest: string; readonly artifactRefs: readonly string[] }): Promise<unknown>;
  emit(event: string, payload: unknown): void;
  removePending(id: string): void;
}

/** Builds the allowlisted receipt and performs the sole approved record write. */
export async function finalizeAction(
  context: ActionFinalizeContext,
  input: ReceiptInput,
): Promise<ImoAuthActionExecution> {
  const receipt: ImoAuthActionReceipt = {
    operationId: input.operationId,
    kind: input.kind,
    status: input.status,
    exitCode: input.exitCode,
    stdoutDigest: input.stdoutDigest,
    stderrDigest: input.stderrDigest,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    ...(input.profileName === undefined ? {} : { profileName: input.profileName }),
    ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
    ...(input.targetProfile === undefined ? {} : { targetProfile: input.targetProfile }),
    ...(input.profileSnapshot === undefined ? {} : { profileSnapshot: input.profileSnapshot }),
  };
  const resultDigest = digest(JSON.stringify(receipt));
  try {
    await context.recordResult(input.operationId, { resultDigest, artifactRefs: [] });
  } catch (error) {
    if (codeOf(error) === "already-has-result") {
      return { ok: false, error: actionError("already-executed", "auth action operation already has a result", input.operationId) };
    }
    return { ok: false, error: actionError("record-failed", "could not record auth action result", input.operationId) };
  }
  context.removePending(input.operationId);
  context.emit(input.status === "completed" ? AUTH_ACTION_COMPLETED_EVENT : AUTH_ACTION_FAILED_EVENT, {
    operationId: input.operationId,
    kind: input.kind,
    status: input.status,
    resultDigest,
  });
  const hint = input.httpStatus === 401 ? "login-required" : input.httpStatus === 403 ? "permission-denied" : undefined;
  return hint === undefined ? { ok: true, receipt } : { ok: true, receipt, hint };
}

function actionError(
  code: "already-executed" | "record-failed",
  message: string,
  operationId: string,
): ImoAuthActionError {
  return { code, message, operationId };
}

function codeOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}
