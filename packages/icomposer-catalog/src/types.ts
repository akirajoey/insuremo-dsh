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

/** TASK-111: one path-identified source discovery of the workspace (no count cap, never name-merged). */
export interface SourceEntry {
  readonly name: string;
  readonly type: "api" | "function";
  readonly tenant: string;
  readonly group: string;
  /** Workspace-relative POSIX source path; the stable identity of this discovery. */
  readonly sourcePath: string;
}
export interface SourceListing {
  readonly entries: readonly SourceEntry[];
  /** Names discovered at more than one source path: two distinct assets, never one. */
  readonly duplicateNames: readonly string[];
}
export interface ListSourcesInput { readonly workspaceId: string }

export interface IcomposercCatalogFace {
  listAssets(input: ListAssetsInput, signal?: AbortSignal): Promise<Result<AssetCatalog>>;
  /**
   * TASK-111: complete, path-identified api/function enumeration for task target
   * resolution and graph building. `listAssets` keeps its 5000-item display
   * bound; this call is deliberately uncapped and reports same-name collisions
   * instead of resolving them.
   */
  listSourcesComplete(input: ListSourcesInput, signal?: AbortSignal): Promise<Result<SourceListing>>;
}
