export type VerifyErrorCode =
  | "workspace-not-bound"
  | "workspace-not-found"
  | "invalid-workspace-id"
  | "invalid-file-path"
  | "invalid-keyword"
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
  | { readonly ok: false; readonly error: { readonly code: VerifyErrorCode; readonly message: string } };

export interface UtilClassSummary {
  readonly className: string;
  readonly methodCount: number;
  readonly description?: string;
}

export interface UtilsListView {
  readonly workspaceId: string;
  readonly classes: readonly UtilClassSummary[];
  readonly count: number;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly stdoutDigest: string;
}

export interface SearchMatch {
  readonly className: string;
  readonly method?: string;
  readonly description?: string;
}

export interface UtilsSearchView {
  readonly workspaceId: string;
  readonly query: string;
  readonly matches: readonly SearchMatch[];
  readonly count: number;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly stdoutDigest: string;
}

export interface VerifyIssue {
  readonly className?: string;
  readonly method?: string;
  readonly line?: string;
  readonly suggestions?: readonly string[];
}

export interface VerifyUsage {
  readonly className: string;
  readonly methods: readonly string[];
}

export interface VerifyReportView {
  readonly workspaceId: string;
  /** The workspace-relative path exactly as requested (never the CLI's absolute path). */
  readonly file: string;
  readonly valid: boolean;
  readonly classesChecked: number;
  readonly used: readonly VerifyUsage[];
  readonly unknownClasses: readonly string[];
  readonly invalidMethods: readonly VerifyIssue[];
  readonly durationMs: number;
  readonly stdoutDigest: string;
}

export interface VerifyUtilsInput {
  readonly workspaceId: string;
  readonly file?: string;
}

export interface IcomposerVerifyFace {
  verifyUtils(input: VerifyUtilsInput, signal?: AbortSignal): Promise<Result<VerifyReportView>>;
  listUtils(input: { readonly workspaceId: string }, signal?: AbortSignal): Promise<Result<UtilsListView>>;
  searchUtils(input: { readonly workspaceId: string; readonly keyword: string }, signal?: AbortSignal): Promise<Result<UtilsSearchView>>;
}
