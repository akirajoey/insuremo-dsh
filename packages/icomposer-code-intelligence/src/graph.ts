import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { confidenceForSource, extractMethods, stableEdgeId, stableHashText, truncateChars, assignedVariableName, calledMethodsOnVariable, containsLocalMethodCall, extractQuotedAfter, stripLineComments } from "./parser.ts";
import type { IciEdge, IciNode, ProgressCallback } from "./types.ts";

const META_LIMIT = 256 * 1024;
const GROOVY_LIMIT = 2 * 1024 * 1024;

function isContained(realPath: string, root: string): boolean {
  return realPath === root || realPath.startsWith(root + "/");
}
async function safeRealpath(p: string): Promise<string | null> {
  try { return await realpath(p); } catch { return null; }
}

interface BuildContext {
  nodes: Map<string, IciNode>;
  edges: Map<string, IciEdge>;
  sourceByName: Map<string, { kind: string; source: string; sourceFile: string }>;
}

export interface GraphAudit {
  readonly duplicateNodeIds: number;
  readonly duplicateEdgeTuples: number;
  readonly invalidRanges: number;
}

export function auditGraph(nodes: readonly IciNode[], edges: readonly IciEdge[]): GraphAudit {
  const nodeIds = new Set<string>();
  const edgeTuples = new Set<string>();
  let duplicateNodeIds = 0;
  let duplicateEdgeTuples = 0;
  let invalidRanges = 0;
  for (const node of nodes) {
    if (nodeIds.has(node.id)) duplicateNodeIds++; else nodeIds.add(node.id);
    if ((node.startLine !== undefined || node.endLine !== undefined) && (node.startLine === undefined || node.endLine === undefined || node.startLine <= 0 || node.endLine < node.startLine)) invalidRanges++;
  }
  for (const edge of edges) {
    const tuple = `${edge.from}|${edge.to}|${edge.kind}`;
    if (edgeTuples.has(tuple)) duplicateEdgeTuples++; else edgeTuples.add(tuple);
  }
  return { duplicateNodeIds, duplicateEdgeTuples, invalidRanges };
}

function nodeRichness(node: IciNode): number {
  const concrete = (value: string | undefined) => value !== undefined && value !== "" && !value.includes("*") && !value.startsWith("/");
  return (concrete(node.sourceFile) ? 32 : 0) + (node.sourceHash !== undefined ? 16 : 0) + (node.startLine !== undefined && node.startLine > 0 && node.endLine !== undefined && node.endLine >= node.startLine ? 8 : 0) + (node.signature !== undefined && node.signature !== "" ? 4 : 0) + (concrete(node.path) ? 2 : 0) + (node.evidence !== "" ? 1 : 0);
}

function nodeOrderKey(node: IciNode): string {
  return [node.id, node.sourceFile ?? "", node.sourceHash ?? "", String(node.startLine ?? 0), String(node.endLine ?? 0), node.signature ?? "", node.path, node.evidence, node.owner ?? ""].join("\u0000");
}

/** Commutative node merge: source identity/range/hash always comes from one primary rich node. */
function mergeNodeEvidence(left: string, right: string): string {
  return [...new Set([left, right].filter(Boolean))].sort((a, b) => b.length - a.length || a.localeCompare(b)).join(" | ").slice(0, 400);
}

export function mergeNode(left: IciNode, right: IciNode): IciNode {
  const leftScore = nodeRichness(left);
  const rightScore = nodeRichness(right);
  const primary = leftScore > rightScore || (leftScore === rightScore && nodeOrderKey(left) <= nodeOrderKey(right)) ? left : right;
  const secondary = primary === left ? right : left;
  const choose = (a: string | undefined, b: string | undefined) => a && a !== "" ? a : b;
  return {
    ...primary,
    path: choose(primary.path, secondary.path) ?? "",
    evidence: mergeNodeEvidence(primary.evidence, secondary.evidence),
    owner: primary.owner ?? secondary.owner,
  };
}

function addNode(ctx: BuildContext, node: IciNode) {
  const existing = ctx.nodes.get(node.id);
  ctx.nodes.set(node.id, existing === undefined ? node : mergeNode(existing, node));
}

/**
 * Workspace-relative POSIX path for an absolute (or already-relative) source
 * path. Resolves symlinks via realpath so /var vs /private/var style mounts
 * never leave an absolute prefix behind; returns undefined when the path
 * escapes the workspace root.
 */
export function toRelativeWorkspacePath(canonicalRoot: string, sourcePath: string): string | undefined {
  const absolute = isAbsolute(sourcePath) ? sourcePath : join(canonicalRoot, sourcePath);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return undefined;
  }
  if (!isContained(real, canonicalRoot)) return undefined;
  return relative(canonicalRoot, real).split("\\").join("/");
}

function isConcreteWorkspaceRelative(value: string): boolean {
  return value !== "" && !value.startsWith("/") && value !== ".." && !value.startsWith("../") && !value.includes("*") && !value.startsWith("platform:") && !value.startsWith("inferred") && !value.startsWith(".metadata");
}

function edgeSourceRank(source: IciEdge["source"]): number {
  return source === "static" ? 3 : source === "platform" ? 2 : 1;
}

function edgeConfidenceRank(confidence: IciEdge["confidence"]): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function mergeEvidence(left: string, right: string): string {
  return [...new Set([left, right].filter(Boolean))].sort((a, b) => b.length - a.length || a.localeCompare(b)).join(" | ").slice(0, 400);
}

/** Commutative logical-edge merge; richer local provenance wins without dropping bounded evidence. */
export function mergeEdge(left: IciEdge, right: IciEdge): IciEdge {
  const ownerCandidates = [left.ownerFile, right.ownerFile].filter(Boolean).sort((a, b) => Number(isConcreteWorkspaceRelative(b)) - Number(isConcreteWorkspaceRelative(a)) || a.length - b.length || a.localeCompare(b));
  const source = edgeSourceRank(left.source) >= edgeSourceRank(right.source) ? left.source : right.source;
  const confidence = edgeConfidenceRank(left.confidence) >= edgeConfidenceRank(right.confidence) ? left.confidence : right.confidence;
  return {
    ...left,
    id: stableEdgeId(left.from, left.to, left.kind, "", ""),
    ownerFile: ownerCandidates[0] ?? "",
    source,
    confidence,
    evidence: mergeEvidence(left.evidence, right.evidence),
  };
}

function addEdge(ctx: BuildContext, edge: IciEdge) {
  if (edge.from === edge.to && edge.kind === "CALLS") return;
  const key = `${edge.from}|${edge.to}|${edge.kind}`;
  const existing = ctx.edges.get(key);
  const normalized = { ...edge, id: stableEdgeId(edge.from, edge.to, edge.kind, "", "") };
  ctx.edges.set(key, existing === undefined ? normalized : mergeEdge(existing, normalized));
}

/** Discarded-tree marker: any path segment or name containing STD_DISCARD is skipped. */
export function isStdDiscard(pathOrName: string | undefined): boolean {
  return pathOrName !== undefined && pathOrName.includes("STD_DISCARD");
}

export async function buildGraph(
  canonicalRootInput: string,
  catalogEntries: Array<{ name: string; type: string; sourcePath?: string; metadata?: Record<string, unknown> }>,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<{ nodes: IciNode[]; edges: IciEdge[]; sourceFingerprint: string }> {
  const canonicalRoot = (await safeRealpath(canonicalRootInput)) ?? canonicalRootInput;
  const ctx: BuildContext = { nodes: new Map(), edges: new Map(), sourceByName: new Map() };
  const totalSteps = catalogEntries.length + 2;
  let current = 0;
  const progress = (label: string) => {
    current++;
    onProgress?.(current, totalSteps, label);
  };

  // Collect nodes from catalog entries + batch/model handling
  for (const entry of catalogEntries) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    // STD_DISCARD paths are discarded trees (Rust collect_build_sources semantics):
    // skipped assets produce no nodes/edges/placeholders.
    if (isStdDiscard(entry.sourcePath) || isStdDiscard(entry.name)) {
      progress(`skipping STD_DISCARD ${entry.type} ${entry.name}`);
      continue;
    }
    const kind = entry.type as IciNode["kind"];
    const id = `${kind}:${entry.name}`;
    const relPath = entry.sourcePath !== undefined ? toRelativeWorkspacePath(canonicalRoot, entry.sourcePath) : undefined;
    let sourceHash: string | undefined;
    let sourceLines: number | undefined;
    if (relPath !== undefined) {
      try {
        const content = await readFile(join(canonicalRoot, relPath), "utf8");
        sourceHash = stableHashText(content);
        sourceLines = content.split("\n").length;
        ctx.sourceByName.set(entry.name, { kind, source: content, sourceFile: relPath });
      } catch { /* ignore unreadable source */ }
    }
    const node: IciNode = {
      id,
      kind,
      name: entry.name,
      path: relPath !== undefined && relPath !== "" ? relPath : `src/dev/**/${entry.name}/${entry.name}.groovy`,
      evidence: "",
      sourceFile: relPath ?? "",
      ...(sourceLines === undefined ? {} : { startLine: 1, endLine: sourceLines }),
      ...(sourceHash === undefined ? {} : { sourceHash }),
    };
    addNode(ctx, node);
    progress(`scanning metadata ${kind} ${entry.name}`);
  }
  return finishBuild(ctx, progress, signal);
}

/**
 * Collect workspace groovy sources referenced by catalog entries (STD_DISCARD
 * and out-of-root paths skipped). Shared by build and query staleness checks.
 */
export async function collectSources(
  canonicalRootInput: string,
  catalogEntries: Array<{ name: string; type: string; sourcePath?: string }>,
  signal?: AbortSignal,
): Promise<Map<string, { kind: string; source: string; sourceFile: string }>> {
  const canonicalRoot = (await safeRealpath(canonicalRootInput)) ?? canonicalRootInput;
  const sourceByName = new Map<string, { kind: string; source: string; sourceFile: string }>();
  for (const entry of catalogEntries) {
    if (signal?.aborted) break;
    if (isStdDiscard(entry.sourcePath) || isStdDiscard(entry.name)) continue;
    if (!entry.sourcePath) continue;
    const relPath = toRelativeWorkspacePath(canonicalRoot, entry.sourcePath);
    if (relPath === undefined) continue;
    try {
      const content = await readFile(join(canonicalRoot, relPath), "utf8");
      sourceByName.set(entry.name, { kind: entry.type, source: content, sourceFile: relPath });
    } catch { /* ignore */ }
  }
  return sourceByName;
}

/** Aggregated sha256 over per-file hashes (order-independent). */
export function fingerprintSources(sources: Iterable<{ source: string }>): string {
  const hashes: string[] = [];
  for (const info of sources) hashes.push(stableHashText(info.source));
  hashes.sort();
  return createHash("sha256").update(hashes.join(""), "utf8").digest("hex");
}

function finishBuild(
  ctx: BuildContext,
  progress: (label: string) => void,
  signal?: AbortSignal,
): { nodes: IciNode[]; edges: IciEdge[]; sourceFingerprint: string } {
  // Direct scan of src/dev for groovy files not in catalog (e.g., methods sources)
  // Reuse containment and 5000 bound implicitly via catalog limit; for method extraction we scan files we already have
  // Progress for relationship extraction
  const knownFunctions = new Set([...ctx.nodes.values()].filter(n => n.kind === "function").map(n => n.name));
  const sources = [...ctx.sourceByName.entries()];

  for (const [ownerName, info] of sources) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const ownerId = `${info.kind}:${ownerName}`;
    if (!ctx.nodes.has(ownerId)) continue;
    let methods = extractMethods(info.source);
    if (methods.length === 0 && info.kind === "api") {
      methods = [{ name: "execute", signature: "execute()", body: info.source, startLine: 1, endLine: info.source.split("\n").length }];
    }
    const ownerMethodNames = new Set(methods.map(m => m.name));
    for (const method of methods) {
      const methodId = `method:${ownerName}.${method.name}`;
      const methodNode: IciNode = {
        id: methodId,
        kind: "method",
        name: method.name,
        path: info.sourceFile,
        evidence: method.signature,
        sourceFile: info.sourceFile,
        startLine: method.startLine,
        endLine: method.endLine,
        signature: method.signature,
        sourceHash: stableHashText(method.body),
        owner: ownerId,
      };
      addNode(ctx, methodNode);
      addEdge(ctx, {
        id: "",
        from: ownerId,
        to: methodId,
        kind: "CONTAINS",
        ownerFile: info.sourceFile,
        source: "static",
        confidence: confidenceForSource("static:method"),
        evidence: "",
      });
      // Static edges for this method
      addStaticEdgesForMethod(ctx, methodId, method.body, info.sourceFile, knownFunctions, ownerName, ownerMethodNames, signal);
    }
    progress(`processing ${info.kind} ${ownerName} relationships`);
  }

  // Source fingerprint: aggregate sha256 of all source files sorted
  const sourceFingerprint = fingerprintSources(ctx.sourceByName.values());

  const nodes = [...ctx.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...ctx.edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges, sourceFingerprint };
}

function addStaticEdgesForMethod(
  ctx: BuildContext,
  methodId: string,
  body: string,
  ownerFile: string,
  knownFunctions: Set<string>,
  ownerName: string,
  ownerMethodNames: Set<string>,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return;
  const code = stripLineComments(body);
  const serviceVars = new Map<string, string>();
  for (const line of code.split("\n")) {
    const serviceName = extractQuotedAfter(line, "getCommonService");
    if (serviceName && knownFunctions.has(serviceName)) {
      addEdge(ctx, {
        id: "",
        from: methodId,
        to: `function:${serviceName}`,
        kind: "CALLS",
        ownerFile,
        source: "static",
        confidence: confidenceForSource("static:getCommonService"),
        evidence: truncateChars(line.trim(), 160),
      });
      const varName = assignedVariableName(line);
      if (varName) serviceVars.set(varName, serviceName);
    }
    const beanName = extractQuotedAfter(line, "getBean");
    if (beanName && knownFunctions.has(beanName)) {
      addEdge(ctx, {
        id: "",
        from: methodId,
        to: `function:${beanName}`,
        kind: "CALLS",
        ownerFile,
        source: "static",
        confidence: confidenceForSource("static:getBean"),
        evidence: truncateChars(line.trim(), 160),
      });
    }
  }
  for (const [varName, serviceName] of serviceVars) {
    if (!knownFunctions.has(serviceName)) continue;
    for (const called of calledMethodsOnVariable(code, varName)) {
      const target = `method:${serviceName}.${called}`;
      // ensure placeholder method node exists
      if (!ctx.nodes.has(target)) {
        addNode(ctx, {
          id: target,
          kind: "method",
          name: called,
          path: "",
          evidence: `${called}()`,
          sourceFile: "",
          owner: `function:${serviceName}`,
        });
        addEdge(ctx, {
          id: "",
          from: `function:${serviceName}`,
          to: target,
          kind: "CONTAINS",
          ownerFile: "",
          source: "static",
          confidence: "medium",
          evidence: "",
        });
      }
      addEdge(ctx, {
        id: "",
        from: methodId,
        to: target,
        kind: "CALLS",
        ownerFile,
        source: "static",
        confidence: confidenceForSource("static:service.method"),
        evidence: truncateChars(`${varName}.${called}`, 160),
      });
    }
  }
  const currentMethod = methodId.split(".").pop() ?? methodId;
  for (const local of ownerMethodNames) {
    if (local === currentMethod) continue;
    if (containsLocalMethodCall(code, local)) {
      const target = `method:${ownerName}.${local}`;
      if (!ctx.nodes.has(target)) {
        addNode(ctx, {
          id: target,
          kind: "method",
          name: local,
          path: ownerFile,
          evidence: `${local}()`,
          sourceFile: ownerFile,
          owner: `${ctx.nodes.get(`function:${ownerName}`) ? `function:${ownerName}` : `api:${ownerName}`}`,
        });
      }
      addEdge(ctx, {
        id: "",
        from: methodId,
        to: target,
        kind: "CALLS",
        ownerFile,
        source: "static",
        confidence: confidenceForSource("static:local-method"),
        evidence: truncateChars(local, 160),
      });
    }
  }
  // Platform inferred: SdkClient usage. Edge target matches the node id
  // (`model:<client>`) so no dangling edges are emitted.
  const sdkMatches = code.matchAll(/(\w+SdkClient)/g);
  for (const m of sdkMatches) {
    const client = m[1];
    const platId = `model:${client}`;
    if (!ctx.nodes.has(platId)) {
      ctx.nodes.set(platId, {
        id: platId,
        kind: "model",
        name: client,
        path: "",
        evidence: "inferred platform dependency",
      });
    }
    addEdge(ctx, {
      id: "",
      from: methodId,
      to: platId,
      kind: "CALLS",
      ownerFile,
      source: "inferred",
      confidence: "inferred",
      evidence: truncateChars(client, 160),
    });
  }
}
