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
  readonly canonicalPath: string;
}

export interface IciBuildResult {
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
  | "storage-error";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: IciErrorCode; readonly message: string } };

export type ProgressCallback = (current: number, total: number, label: string) => void;

export interface BuildOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressCallback;
}

export interface IciEngineFace {
  build(input: { readonly workspaceId: string }, options?: BuildOptions | AbortSignal): Promise<Result<IciBuildResult>>;
}
