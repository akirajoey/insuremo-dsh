export type LifecycleErrorCode =
  | "workspace-not-bound"
  | "workspace-not-found"
  | "invalid-workspace-id"
  | "invalid-group-id"
  | "service-disposed"
  | "cancelled"
  | "invalid-auth"
  | "forbidden"
  | "prepare-invalidated"
  | "lease-revoked"
  | "command-failed"
  | "timeout"
  | "parse-error"
  | "cli-error";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: LifecycleErrorCode; readonly message: string } };

export interface InitPreviewGroup {
  readonly id: string;
  readonly name: string;
  readonly path?: string;
  readonly code?: string;
}

export interface InitPreviewGroupsView {
  readonly workspaceId: string;
  readonly mode: "groups";
  readonly groups: readonly InitPreviewGroup[];
  readonly count: number;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly stdoutDigest: string;
}

export interface InitPreviewPlanView {
  readonly workspaceId: string;
  readonly mode: "plan";
  readonly groupId: string | null;
  readonly steps: readonly string[];
  readonly count: number;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly stdoutDigest: string;
}

export type InitPreviewView = InitPreviewGroupsView | InitPreviewPlanView;

export interface InitPreviewInput {
  readonly workspaceId: string;
  readonly groupId?: string;
  readonly listGroups?: boolean;
}

export type AssetType = "api" | "function" | "batch" | "model";

export interface JoinSample {
  readonly name: string;
  readonly type: AssetType;
}

export interface ReloadPreviewView {
  readonly workspaceId: string;
  readonly distribution: {
    readonly clean: number;
    readonly localModified: number;
    readonly noServerMd5: number;
    readonly sourceMissing: number;
    readonly metadataMissing: number;
  };
  readonly total: number;
  readonly top: readonly JoinSample[];
  readonly scannedAt: string;
}

export interface IcomposerLifecycleFace {
  initPreview(input: InitPreviewInput, signal?: AbortSignal): Promise<Result<InitPreviewView>>;
  reloadPreview(input: { readonly workspaceId: string }, signal?: AbortSignal): Promise<Result<ReloadPreviewView>>;
}
