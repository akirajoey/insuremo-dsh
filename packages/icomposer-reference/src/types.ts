export interface SdkOperation {
  readonly client: string;
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly summary?: string;
  readonly tag?: string;
}

export interface SdkClientSummary {
  readonly client: string;
  readonly swaggerPath: string;
  readonly operationCount: number;
  readonly status: "ok" | "invalid" | "skipped-escape";
}

export interface SdkClientsResult {
  readonly workspaceId: string;
  readonly clients: readonly SdkClientSummary[];
  readonly counts: { readonly clients: number; readonly operations: number };
}

export interface SdkQueryResult {
  readonly workspaceId: string;
  readonly operations: readonly SdkOperation[];
  readonly counts: { readonly clients: number; readonly operations: number };
  readonly limit: number;
  readonly truncated: boolean;
}

export interface UtilMethod {
  readonly util: string;
  readonly method: string;
}

export interface UtilSummary {
  readonly util: string;
  readonly docPath: string;
  readonly methodCount: number;
  readonly status: "ok" | "invalid";
}

export interface UtilsResult {
  readonly workspaceId: string;
  readonly utils: readonly UtilSummary[];
  readonly counts: { readonly utils: number; readonly methods: number };
}

export interface UtilMethodsResult {
  readonly workspaceId: string;
  readonly methods: readonly UtilMethod[];
  readonly counts: { readonly utils: number; readonly methods: number };
  readonly limit: number;
  readonly truncated: boolean;
}

export type ReferenceErrorCode =
  | "workspace-not-bound"
  | "workspace-not-found"
  | "storage-error"
  | "invalid-workspace-id"
  | "invalid-limit"
  | "service-disposed"
  | "cancelled";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ReferenceErrorCode; readonly message: string } };

export interface SdkQueryInput {
  readonly workspaceId: string;
  readonly client?: string;
  readonly keyword?: string;
  readonly limit?: number;
}

export interface UtilQueryInput {
  readonly workspaceId: string;
  readonly util?: string;
  readonly keyword?: string;
  readonly limit?: number;
}

export interface IcomposerReferenceFace {
  listSdkClients(input: { readonly workspaceId: string }, signal?: AbortSignal): Promise<Result<SdkClientsResult>>;
  querySdkOperations(input: SdkQueryInput, signal?: AbortSignal): Promise<Result<SdkQueryResult>>;
  listUtilities(input: { readonly workspaceId: string }, signal?: AbortSignal): Promise<Result<UtilsResult>>;
  queryUtilityMethods(input: UtilQueryInput, signal?: AbortSignal): Promise<Result<UtilMethodsResult>>;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
