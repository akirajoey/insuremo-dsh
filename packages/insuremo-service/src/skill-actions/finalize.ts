import { digest } from "../run.ts";
import { SKILL_ACTION_COMPLETED_EVENT, SKILL_ACTION_FAILED_EVENT } from "./types.ts";
import type {
  SkillActionError,
  SkillActionExecution,
  SkillActionKind,
  SkillActionReceipt,
} from "./types.ts";

export interface SkillFinalizeContext {
  recordResult(id: string, input: { readonly resultDigest: string; readonly artifactRefs: readonly string[] }): Promise<unknown>;
  emit(event: string, payload: unknown): void;
  removePending(id: string): void;
}

/** Build the immutable allowlisted receipt and its result digest. */
export function buildSkillReceipt(input: SkillReceiptInput): { readonly receipt: SkillActionReceipt; readonly resultDigest: string } {
  const receipt: SkillActionReceipt = {
    operationId: input.operationId,
    kind: input.kind,
    status: input.status,
    exitCode: input.exitCode,
    stdoutDigest: input.stdoutDigest,
    stderrDigest: input.stderrDigest,
    beforeCount: input.beforeCount,
    afterCount: input.afterCount,
    added: [...input.added],
    removed: [...input.removed],
    updated: [...input.updated],
    ...(input.activationBeforeRevision === undefined ? {} : { activationBeforeRevision: input.activationBeforeRevision }),
    ...(input.activationAfterRevision === undefined ? {} : { activationAfterRevision: input.activationAfterRevision }),
    catalogInvalidated: input.catalogInvalidated,
    ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
    ...(input.sourceHost === undefined ? {} : { sourceHost: input.sourceHost }),
    ...(input.sourceDigest === undefined ? {} : { sourceDigest: input.sourceDigest }),
    ...(input.actionTargetDigest === undefined ? {} : { actionTargetDigest: input.actionTargetDigest }),
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
  };
  return { receipt, resultDigest: digest(JSON.stringify(receipt)) };
}

export interface SkillReceiptInput {
  readonly operationId: string;
  readonly kind: SkillActionKind;
  readonly status: "completed" | "failed" | "partial-failure";
  readonly exitCode: number | null;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly updated: readonly string[];
  readonly activationBeforeRevision?: number;
  readonly activationAfterRevision?: number;
  readonly catalogInvalidated: boolean;
  readonly sourceKind?: "alias" | "https-git" | "npm" | "scenario";
  readonly sourceHost?: string;
  readonly sourceDigest?: string;
  readonly actionTargetDigest?: string;
  readonly startedAt: string;
  readonly hint?: "login-required" | "permission-denied";
}

export async function finalizeSkillAction(
  context: SkillFinalizeContext,
  input: SkillReceiptInput,
): Promise<SkillActionExecution> {
  const { receipt, resultDigest } = buildSkillReceipt(input);
  try {
    await context.recordResult(input.operationId, { resultDigest, artifactRefs: [] });
  } catch (error) {
    if (codeOf(error) === "already-has-result") return failure("already-executed", "skill action operation already has a result", input.operationId);
    return failure("record-failed", "could not record skill action result", input.operationId);
  }
  context.removePending(input.operationId);
  context.emit(input.status === "completed" ? SKILL_ACTION_COMPLETED_EVENT : SKILL_ACTION_FAILED_EVENT, {
    operationId: input.operationId,
    kind: input.kind,
    status: input.status,
    resultDigest,
    ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
    ...(input.sourceHost === undefined ? {} : { sourceHost: input.sourceHost }),
    ...(input.sourceDigest === undefined ? {} : { sourceDigest: input.sourceDigest }),
    ...(input.actionTargetDigest === undefined ? {} : { actionTargetDigest: input.actionTargetDigest }),
  });
  return input.hint === undefined ? { ok: true, receipt } : { ok: true, receipt, hint: input.hint };
}

function codeOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}

function failure(code: SkillActionError["code"], message: string, operationId: string): SkillActionExecution {
  return { ok: false, error: { code, message, operationId } };
}
