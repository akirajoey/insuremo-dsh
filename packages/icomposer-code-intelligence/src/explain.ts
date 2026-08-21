import type { IciEdge, IciNode, QueryApiTreeNode } from "./types.ts";
import { resolveQueryNodes } from "./query.ts";
import { apiEmbeddingText, downstreamNodeNames } from "./search-core.ts";

export interface GraphViewLike {
  nodes: Map<string, IciNode>;
  edges: IciEdge[];
}

function downstreamNamesFor(graph: GraphViewLike, nodeId: string): string[] {
  return downstreamNodeNames(graph.nodes, graph.edges, nodeId);
}

export interface ExplainBundle {
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

export interface DeterministicExplain {
  readonly generatedBy: "deterministic-v1";
  readonly promptVersion: "none";
  readonly sourceFingerprint: string;
  readonly generatedAt: string;
  readonly technical: string;
  readonly business: string;
  readonly method: readonly string[];
}

/** Collect ref_doc filenames whose stem shares tokens with the api/module name. */
export function matchBusinessReference(refDocNames: readonly string[], apiName: string, downstreamNames: readonly string[], limit = 20): string[] {
  const tokens = new Set<string>();
  for (const token of apiName.split(/(?=[A-Z])/).map(t => t.toLowerCase()).filter(t => t.length >= 3)) {
    tokens.add(token);
  }
  for (const dn of downstreamNames) {
    for (const token of dn.split(/(?=[A-Z])/).map(t => t.toLowerCase()).filter(t => t.length >= 4)) {
      tokens.add(token);
    }
  }
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of refDocNames) {
    const lower = name.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (lower.includes(token)) score += 1;
    }
    if (score > 0) scored.push({ name, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit).map(s => s.name);
}

/** Flatten the first level of a downstream tree into step strings. */
export function treeFirstLevelSteps(root: QueryApiTreeNode | undefined): string[] {
  const steps: string[] = [];
  for (const child of root?.children ?? []) {
    const edgeKind = child.edge?.kind ?? "RELATED";
    steps.push(`${edgeKind} ${child.id}`);
  }
  return steps;
}

export function countInferredEdges(edges: Iterable<IciEdge>, reachableNodeIds: ReadonlySet<string>): number {
  let count = 0;
  for (const e of edges) {
    if (e.source === "inferred" && reachableNodeIds.has(e.from)) count += 1;
  }
  return count;
}

export function collectReachable(root: QueryApiTreeNode | undefined, into: Set<string>): void {
  if (root === undefined) return;
  into.add(root.id);
  for (const child of root.children ?? []) collectReachable(child, into);
}

export function resolveSingleStart(nodes: Iterable<IciNode>, query: string): { ok: true; node: IciNode } | { ok: false; reason: "not-found" | "ambiguous"; candidates: string[] } {
  const matches = resolveQueryNodes(nodes, query, "api");
  if (matches.length === 0) return { ok: false, reason: "not-found", candidates: [] };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", candidates: matches.slice(0, 20).map(n => n.id) };
  return { ok: true, node: matches[0] };
}

export function countTreeNodes(nodes: readonly QueryApiTreeNode[]): number {
  let count = 0;
  for (const n of nodes) {
    count += 1;
    count += countTreeNodes(n.children ?? []);
  }
  return count;
}

export function countKind(nodes: readonly QueryApiTreeNode[], kind: IciNode["kind"]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.kind === kind) count += 1;
    count += countKind(n.children ?? [], kind);
  }
  return count;
}

export interface ExplainDeps {
  readonly graph: GraphViewLike;
  readonly canonicalPath: string;
  readonly start: IciNode;
  readonly stale?: true;
  readonly downstreamRoot: QueryApiTreeNode | undefined;
  readonly impactPaths: ReadonlyArray<{ readonly apiId: string; readonly hops: ReadonlyArray<{ readonly nodeId: string }> }>;
  readonly refDocNames: readonly string[];
}

/** Assemble the bounded context bundle for one api start node. */
export function buildExplainBundle(deps: ExplainDeps): ExplainBundle {
  const { start, downstreamRoot, stale } = deps;
  const downstreamNames = downstreamNamesFor(deps.graph, start.id);
  return {
    api: { id: start.id, name: start.name, path: start.sourceFile ?? "" },
    technicalText: apiEmbeddingText(start.name, "technical", "", downstreamNames),
    downstream: downstreamRoot?.children ?? [],
    impact: deps.impactPaths,
    businessReference: matchBusinessReference(deps.refDocNames, start.name, downstreamNames),
    manifest: {
      schemaVersion: (deps.graph as unknown as { manifest: { schemaVersion: number; engineVersion: string; sourceFingerprint: string } }).manifest.schemaVersion,
      engineVersion: (deps.graph as unknown as { manifest: { engineVersion: string } }).manifest.engineVersion,
      sourceFingerprint: (deps.graph as unknown as { manifest: { sourceFingerprint: string } }).manifest.sourceFingerprint,
      ...(stale ? { stale: true } : {}),
    },
  };
}

export interface DeterministicDeps {
  readonly graph: GraphViewLike;
  readonly canonicalPath: string;
  readonly start: IciNode;
  readonly downstreamRoot: QueryApiTreeNode | undefined;
  readonly refDocNames: readonly string[];
  readonly sourceFingerprint: string;
}

/** Deterministic three-part explanation derived from graph structure only. */
export function buildDeterministicExplain(deps: DeterministicDeps): { technical: string; business: string; method: readonly string[] } {
  const reachable = new Set<string>();
  collectReachable(deps.downstreamRoot, reachable);
  const inferredCount = countInferredEdges(deps.graph.edges, reachable);
  const functionCount = countKind([deps.downstreamRoot].filter(n => n !== undefined) as QueryApiTreeNode[], "function");
  const methodSteps = treeFirstLevelSteps(deps.downstreamRoot);
  const businessReference = matchBusinessReference(deps.refDocNames, deps.start.name, downstreamNamesFor(deps.graph, deps.start.id));

  const technical = [
    `- API node: \`${deps.start.name}\`.`,
    `- Downstream graph nodes: ${countTreeNodes([deps.downstreamRoot].filter(n => n !== undefined) as QueryApiTreeNode[])} (functions: ${functionCount}, platform-inferred dependency edges: ${inferredCount}).`,
    "- Deterministic mode: derived from graph structure only; not confirmed business facts.",
  ].join("\n");

  const glossaryHint = businessReference.length > 0
    ? `Related reference docs: ${businessReference.join(", ")}.`
    : "No matching reference docs found.";
  const business = [
    "- Business scenario/rules/fees/queues: NOT CONFIRMED — deterministic mode infers from names and graph structure only.",
    `- Name-based hint: API \`${deps.start.name}\`.`,
    `- ${glossaryHint}`,
    "- Next evidence step: have the current Agent read the referenced sources and produce a factual explanation.",
  ].join("\n");

  return { technical, business, method: methodSteps };
}
