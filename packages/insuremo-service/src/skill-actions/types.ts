import type { ImoSkillActivationSnapshot } from "../skill-activation.ts";

export const SKILL_INSTALL_KIND = "skill-install" as const;
export const SKILL_UPDATE_KIND = "skill-update" as const;
export const SKILL_REMOVE_KIND = "skill-remove" as const;
export const SKILL_ACTIVATION_KIND = "skill-activation" as const;

export type SkillActionKind =
  | typeof SKILL_INSTALL_KIND
  | typeof SKILL_UPDATE_KIND
  | typeof SKILL_REMOVE_KIND
  | typeof SKILL_ACTIVATION_KIND;

export const SKILL_ACTION_COMPLETED_EVENT = "skills/action-completed" as const;
export const SKILL_ACTION_FAILED_EVENT = "skills/action-failed" as const;

export const SKILL_AGENTS = [
  "codex", "claude-code", "cursor", "opencode", "windsurf", "gemini-cli", "qwen-code",
  "github-copilot", "cline", "codebuddy", "augment", "continue", "kilo", "roo", "trae",
  "warp", "goose", "firebender", "universal",
] as const;
export type SkillAgent = typeof SKILL_AGENTS[number];

export const SKILL_SCENARIOS = [
  "icomposer-full-stack", "icomposer-coding-lite", "icomposer-api-design", "uic-developer", "ask-insuremo",
] as const;
export type SkillScenario = typeof SKILL_SCENARIOS[number];

export type SkillActionScope = "global" | "project";

export interface AliasSkillSource {
  readonly type: "alias";
  readonly value?: string;
  readonly alias?: string;
}
export interface GitSkillSource {
  readonly type: "git" | "https-git";
  readonly url: string;
}
export interface NpmSkillSource {
  readonly type: "npm";
  readonly package?: string;
  readonly packageName?: string;
}
export interface ScenarioSkillSource {
  readonly type: "scenario";
  readonly scenario: string;
}
export type SkillInstallSource = AliasSkillSource | GitSkillSource | NpmSkillSource | ScenarioSkillSource;

export interface SkillInstallActionInput {
  readonly kind?: typeof SKILL_INSTALL_KIND;
  readonly type?: typeof SKILL_INSTALL_KIND;
  readonly scope?: SkillActionScope | string;
  readonly source: SkillInstallSource | Record<string, unknown>;
  readonly agent: string;
  readonly skills?: readonly string[];
}
export interface SkillUpdateActionInput {
  readonly kind?: typeof SKILL_UPDATE_KIND;
  readonly type?: typeof SKILL_UPDATE_KIND;
  readonly scope?: SkillActionScope | string;
}
export interface SkillRemoveActionInput {
  readonly kind?: typeof SKILL_REMOVE_KIND;
  readonly type?: typeof SKILL_REMOVE_KIND;
  readonly scope?: SkillActionScope | string;
  readonly agent: string;
  readonly names?: readonly string[];
  readonly skills?: readonly string[];
}
export interface SkillActivationActionInput {
  readonly kind?: typeof SKILL_ACTIVATION_KIND;
  readonly type?: typeof SKILL_ACTIVATION_KIND;
  readonly scope?: SkillActionScope | string;
  readonly name: string;
  readonly enabled: boolean;
}
export type SkillActionInput =
  | SkillInstallActionInput
  | SkillUpdateActionInput
  | SkillRemoveActionInput
  | SkillActivationActionInput;

export type SkillActionErrorCode =
  | "busy"
  | "cancelled"
  | "missing-operation"
  | "not-approved"
  | "already-executed"
  | "missing-pending-input"
  | "operation-params-mismatch"
  | "record-failed"
  | "evidence-pending"
  | "execution-outcome-unknown"
  | "invalid-input"
  | "invalid-source"
  | "invalid-agent"
  | "invalid-skill-name"
  | "invalid-option"
  | "ssrf-blocked"
  | "workspace-not-bound"
  | "not-installed"
  | "revision-conflict"
  | "parse-error"
  | "pre-check-failed"
  | "service-disposed"
  | "not-found"
  | "spawn-failed"
  | "non-zero-exit"
  | "timeout";

export interface SkillActionError {
  readonly code: SkillActionErrorCode;
  readonly message: string;
  readonly operationId?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly httpStatus?: 401 | 403;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
}

export type SkillActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SkillActionError };

export interface SkillInventorySnapshot {
  readonly names: readonly string[];
  readonly digests: Readonly<Record<string, string>>;
  readonly inventoryDigest: string;
}

export interface NormalizedInstallAction {
  readonly kind: typeof SKILL_INSTALL_KIND;
  readonly scope: "global";
  readonly agent: SkillAgent;
  readonly source: { readonly type: "alias" | "https-git" | "npm" | "scenario"; readonly value: string };
  readonly skills: readonly string[];
}
export interface NormalizedUpdateAction {
  readonly kind: typeof SKILL_UPDATE_KIND;
  readonly scope: "global";
}
export interface NormalizedRemoveAction {
  readonly kind: typeof SKILL_REMOVE_KIND;
  readonly scope: "global";
  readonly agent: SkillAgent;
  readonly names: readonly string[];
}
export interface NormalizedActivationAction {
  readonly kind: typeof SKILL_ACTIVATION_KIND;
  readonly scope: "global";
  readonly name: string;
  readonly enabled: boolean;
}
export type NormalizedSkillAction =
  | NormalizedInstallAction
  | NormalizedUpdateAction
  | NormalizedRemoveAction
  | NormalizedActivationAction;

export interface SkillActionPreview {
  readonly kind: SkillActionKind;
  readonly scope: "global";
  readonly candidateNames?: readonly string[];
  readonly names?: readonly string[];
  readonly before?: SkillInventorySnapshot;
  readonly activation?: ImoSkillActivationSnapshot;
  readonly stdoutDigest?: string;
}

export interface SkillActionRequest {
  readonly operationId: string;
  readonly kind: SkillActionKind;
  readonly paramsDigest: string;
  readonly preview: SkillActionPreview;
}

export interface SkillActionReceipt {
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
  /** Install-only provenance: canonical source kind, HTTPS host, and descriptor digest. */
  readonly sourceKind?: "alias" | "https-git" | "npm" | "scenario";
  readonly sourceHost?: string;
  readonly sourceDigest?: string;
  /** Non-install target digest (remove names / update-all / activation target). */
  readonly actionTargetDigest?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type SkillActionExecution =
  | { readonly ok: true; readonly receipt: SkillActionReceipt; readonly hint?: "login-required" | "permission-denied"; readonly evidencePending?: true }
  | { readonly ok: false; readonly error: SkillActionError };

export interface SkillActionEvent {
  readonly operationId: string;
  readonly kind: SkillActionKind;
  readonly status: "completed" | "failed" | "partial-failure";
  readonly resultDigest: string;
  readonly sourceKind?: "alias" | "https-git" | "npm" | "scenario";
  readonly sourceHost?: string;
  readonly sourceDigest?: string;
  readonly actionTargetDigest?: string;
}

export interface SkillActionStatus {
  readonly running: boolean;
  readonly current?: { readonly operationId: string; readonly kind: SkillActionKind };
}

export interface ImoSkillActions {
  request(input: SkillActionInput, signal?: AbortSignal): Promise<SkillActionResult<SkillActionRequest>>;
  execute(operationId: string, signal?: AbortSignal): Promise<SkillActionExecution>;
  /** One-shot direct execution (TASK-039): no operation record, same kernel. */
  runDirect(input: SkillActionInput, signal?: AbortSignal): Promise<SkillActionExecution>;
  status(): SkillActionStatus;
}

export type PendingSkillAction = {
  readonly kind: SkillActionKind;
  readonly input: NormalizedSkillAction;
  readonly preview: SkillActionPreview;
  readonly paramsDigest: string;
};

export interface SkillActionConfig {
  readonly command: string;
  readonly timeoutMs: number;
  readonly allowedGitHosts: readonly string[];
}
