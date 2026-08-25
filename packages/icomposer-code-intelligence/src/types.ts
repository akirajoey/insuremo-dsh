export type NodeKind = "api" | "function" | "method" | "model" | "batch";
export type EdgeKind = "CONTAINS" | "CALLS";
export type EdgeSource = "static" | "platform" | "inferred";
export type Confidence = "high" | "medium" | "inferred";

export interface IciNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly path: string;
  readonly evidence: string;
  readonly sourceFile?: string;
  readonly owner?: string;
}

export interface IciEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly ownerFile: string;
  readonly source: EdgeSource;
  readonly confidence: Confidence;
  readonly evidence: string;
}

export interface IciManifest {
  readonly schemaVersion: 1;
  readonly engineVersion: string;
  readonly sourceFingerprint: string;
  readonly builtAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly workspaceId: string;
  readonly canonicalPath?: string;
}

export interface IciBuildResult {
  readonly artifactPath: string;
  readonly manifest: IciManifest;
  readonly nodes: readonly IciNode[];
  readonly edges: readonly IciEdge[];
}

export type IciErrorCode =
  | "workspace-not-bound"
  | "workspace-not-found"
  | "invalid-workspace-id"
  | "service-disposed"
  | "cancelled"
  | "storage-error"
  | "no-match"
  | "no-snapshot"
  | "no-index"
  | "embedding-error"
  | "invalid-auth"
  | "forbidden"
  | "prepare-invalidated"
  | "lease-revoked";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: IciErrorCode; readonly message: string } };

export type ProgressCallback = (current: number, total: number, label: string) => void;

export interface BuildOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressCallback;
}

export interface ExplainContextBundle {
  readonly artifactPath: string;
  readonly api: { readonly id: string; readonly name: string; readonly path: string };
  readonly technicalText: string;
  readonly downstream: readonly QueryApiTreeNode[];
  readonly impact: ReadonlyArray<{ readonly apiId: string; readonly hops: ReadonlyArray<{ readonly nodeId: string }> }>;
  readonly businessReference: readonly string[];
  readonly manifest: {
    readonly schemaVersion: number;
    readonly engineVersion: string;
    readonly sourceFingerprint: string;
    readonly stale?: true;
  };
}

export interface ExplainDeterministicResult {
  readonly artifactPath: string;
  readonly generatedBy: "deterministic-v1";
  readonly promptVersion: "none";
  readonly sourceFingerprint: string;
  readonly generatedAt: string;
  readonly technical: string;
  readonly business: string;
  readonly method: readonly string[];
}

export interface IciEngineFace {
  build(input: { readonly workspaceId: string }, options?: BuildOptions | AbortSignal): Promise<Result<IciBuildResult>>;
  queryApi(input: QueryApiInput, options?: BuildOptions | AbortSignal): Promise<Result<QueryApiResult>>;
  queryImpact(input: QueryImpactInput, options?: BuildOptions | AbortSignal): Promise<Result<QueryImpactResult>>;
  index(input: SearchIndexInput, options?: BuildOptions | AbortSignal): Promise<Result<SearchIndexResult>>;
  search(input: SearchInput, options?: BuildOptions | AbortSignal): Promise<Result<SearchResult>>;
  diagnostics(input: { readonly workspaceId: string }): Promise<Result<DiagnosticsResult>>;
  cleanupPlan(input: { readonly workspaceId: string }): Promise<Result<CleanupPlan>>;
  cleanupApply(input: { readonly workspaceId: string; readonly expectedPaths: readonly string[] }): Promise<Result<CleanupApplyResult>>;
  explainContext(input: { readonly workspaceId: string; readonly query: string }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainContextBundle>>;
  explainDeterministic(input: { readonly workspaceId: string; readonly query: string }, options?: BuildOptions | AbortSignal): Promise<Result<ExplainDeterministicResult>>;
}

// ---- query surface (TASK-024; Rust query/mod.rs semantics) ----

export interface QueryApiInput {
  readonly workspaceId: string;
  readonly query: string;
  readonly depth?: number;
  readonly focus?: string;
  readonly maxNodes?: number;
}

export interface QueryImpactInput {
  readonly workspaceId: string;
  readonly query: string;
}

/** Projected edge metadata attached to each tree child / impact hop. */
export interface IciEdgeMeta {
  readonly kind: EdgeKind;
  readonly source: EdgeSource;
  readonly confidence: Confidence;
  readonly evidence: string;
  readonly ownerFile: string;
}

export interface QueryApiTreeNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly path: string;
  /** present when the node was already expanded ("seen") or closes a cycle. */
  readonly ref?: "seen" | "cycle";
  /** edge metadata for the hop from the parent to this node (absent at root). */
  readonly edge?: IciEdgeMeta;
  readonly children?: readonly QueryApiTreeNode[];
}

export interface QueryApiResult {
  readonly workspaceId: string;
  readonly matched: readonly string[];
  readonly roots: readonly QueryApiTreeNode[];
  readonly truncated: boolean;
  readonly truncatedAt: readonly string[];
  readonly stale?: true;
}

export interface ImpactHop {
  readonly nodeId: string;
  readonly edge?: IciEdgeMeta;
}

export interface ImpactPath {
  readonly apiId: string;
  readonly hops: readonly ImpactHop[];
}

export interface QueryImpactResult {
  readonly workspaceId: string;
  readonly matched: readonly string[];
  readonly paths: readonly ImpactPath[];
  readonly confidenceCounts: { readonly static: number; readonly platform: number; readonly inferred: number };
  readonly truncated: boolean;
  readonly stale?: true;
}

// ---- semantic search surface (TASK-025; Rust search/mod.rs semantics) ----

export type EmbeddingMode = "technical" | "business" | "all";

export interface SearchIndexInput {
  readonly workspaceId: string;
  /** Which text(s) to embed; default embeds both vectors per api. */
  readonly mode?: EmbeddingMode;
  /** true re-embeds every api, ignoring cached vectors. */
  readonly rebuild?: boolean;
}

export interface SearchIndexResult {
  readonly artifactPath: string;
  readonly workspaceId: string;
  readonly total: number;
  readonly embedded: number;
  readonly reused: number;
  readonly stale?: true;
}

export interface SearchInput {
  readonly workspaceId: string;
  readonly query: string;
  readonly mode?: EmbeddingMode;
  readonly top?: number;
}

export interface SearchRow {
  readonly apiId: string;
  readonly apiName: string;
  readonly score: number;
  readonly evidence: string;
  readonly downstream: readonly string[];
}

export interface SearchResult {
  readonly workspaceId: string;
  readonly rows: readonly SearchRow[];
  readonly truncated: boolean;
  readonly stale?: true;
}

// ---- jobs / diagnostics / cleanup (TASK-026) ----

export type IciJobMode = "graph" | "search-index";

export interface DiagnosticsResult {
  readonly workspaceId: string;
  /** Paths relative to DSH_HOME. */
  readonly indexPaths: { readonly graphCurrent: string; readonly searchJsonl: string };
  readonly schemaVersion: number;
  readonly engineVersion: string;
  readonly builtAt: string | null;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly searchVectors: number;
  readonly stale: boolean;
  readonly requiredFiles: { readonly nodes: boolean; readonly edges: boolean; readonly manifest: boolean };
}

export interface CleanupPlan {
  readonly workspaceId: string;
  /** Absolute DSH_HOME paths safe to delete (generated residue only). */
  readonly paths: readonly string[];
}

export interface CleanupApplyResult {
  readonly workspaceId: string;
  readonly removed: readonly string[];
  readonly skipped: readonly string[];
}
