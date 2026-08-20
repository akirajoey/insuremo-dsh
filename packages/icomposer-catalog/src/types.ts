export type AssetType = "api" | "function" | "batch" | "model";

export type JoinStatus = "clean" | "local-modified" | "no-server-md5" | "source-missing" | "metadata-missing";

export interface AssetEntry {
  readonly name: string;
  readonly type: AssetType;
  readonly metadata: {
    readonly id?: number;
    readonly groupId?: number;
    readonly moduleId?: number;
    readonly version?: number;
    readonly status?: number;
    readonly requestMethod?: number;
    readonly requestType?: number;
    readonly appName?: string;
    readonly md5Value?: string;
    readonly latestUpdateTime?: string;
    readonly jobName?: string;
    readonly recordUsage?: string;
    readonly sourceEnvironment?: string;
  };
  readonly sourcePath?: string;
  readonly sourceFingerprint?: string;
  readonly joinStatus: JoinStatus;
  readonly tenant?: string;
  readonly group?: string;
}

export interface AssetCatalog {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly entries: readonly AssetEntry[];
  readonly counts: Record<AssetType, number> & { total: number };
  readonly truncated: boolean;
  readonly sections: Record<AssetType, { status: "ok" | "missing" | "error"; skipped?: number }>;
}

export type CatalogErrorCode =
  | "workspace-not-bound"
  | "workspace-not-found"
  | "storage-error"
  | "invalid-workspace-id"
  | "invalid-type"
  | "service-disposed"
  | "cancelled";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: CatalogErrorCode; readonly message: string } };

export interface ListAssetsInput {
  readonly workspaceId: string;
  readonly type?: AssetType;
}

export interface IcomposercCatalogFace {
  listAssets(input: ListAssetsInput, signal?: AbortSignal): Promise<Result<AssetCatalog>>;
}
