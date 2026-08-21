import type {
  Confidence,
  EdgeKind,
  IciEdge,
  IciEdgeMeta,
  IciManifest,
  IciNode,
  ImpactHop,
  ImpactPath,
  QueryApiTreeNode,
} from "./types.ts";

export const DEFAULT_DEPTH = 10;
export const MAX_DEPTH = 50;
export const DEFAULT_MAX_NODES = 120;
export const MAX_MAX_NODES = 2000;
const MAX_PATHS = 200;
const MAX_HOPS = 32;
const MAX_CANDIDATES = 20;

export interface LoadedGraph {
  readonly nodes: Map<string, IciNode>;
  readonly edges: readonly IciEdge[];
  readonly manifest: IciManifest;
}

function edgeMeta(edge: IciEdge): IciEdgeMeta {
  return {
    kind: edge.kind as EdgeKind,
    source: edge.source as IciEdgeMeta["source"],
    confidence: edge.confidence as Confidence,
    evidence: edge.evidence,
    ownerFile: edge.ownerFile,
  };
}

/**
 * Case-insensitive substring match over id and name (TASK-024 semantics),
 * comma-separated multi-query, deduped in deterministic id order.
 */
export function resolveQueryNodes(nodes: Iterable<IciNode>, query: string, kind?: string): IciNode[] {
  const parts = query.split(",").map(p => p.trim().toLowerCase()).filter(p => p.length > 0);
  if (parts.length === 0) return [];
  const matches = new Map<string, IciNode>();
  for (const node of nodes) {
    if (kind !== undefined && node.kind !== kind) continue;
    const idLower = node.id.toLowerCase();
    const nameLower = node.name.toLowerCase();
    for (const part of parts) {
      if (idLower.includes(part) || nameLower.includes(part)) {
        matches.set(node.id, node);
        break;
      }
    }
  }
  return [...matches.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Rust resolve_focus_id: focus must resolve to exactly one function node. */
export function resolveFocusId(nodes: Iterable<IciNode>, focus: string | undefined): { ok: true; focusId?: string } | { ok: false; reason: "not-found" | "ambiguous"; candidates: string[] } {
  if (focus === undefined || focus === "") return { ok: true };
  const matches = resolveQueryNodes(nodes, focus, "function");
  if (matches.length === 0) return { ok: false, reason: "not-found", candidates: candidatesOf(matches) };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", candidates: matches.slice(0, MAX_CANDIDATES).map(n => n.id) };
  return { ok: true, focusId: matches[0].id };
}

export function candidatesOf(nodes: Iterable<IciNode>): string[] {
  return [...nodes].slice(0, MAX_CANDIDATES).map(n => n.id);
}

interface TreeState {
  printed: number;
  maxNodes: number;
  truncated: boolean;
  truncatedAt: Set<string>;
  expanded: Set<string>;
  branch: Set<string>;
}

function outgoing(edges: readonly IciEdge[], nodeId: string): IciEdge[] {
  return edges.filter(e => e.from === nodeId);
}

function incoming(edges: readonly IciEdge[], nodeId: string): IciEdge[] {
  return edges.filter(e => e.to === nodeId);
}

/**
 * Rust is_redundant_upstream_method_call: an upstream CALLS edge into a method
 * is redundant when the caller also calls the method's owning function
 * directly (the function-level call subsumes the method-level one).
 */
export function isRedundantUpstreamMethodCall(graph: LoadedGraph, nodeId: string, edge: IciEdge): boolean {
  if (edge.kind !== "CALLS") return false;
  const target = graph.nodes.get(nodeId);
  if (!target || target.kind !== "method") return false;
  return incoming(graph.edges, nodeId).some(container =>
    container.kind === "CONTAINS"
    && graph.nodes.get(container.from)?.kind === "function"
    && graph.edges.some(caller => caller.from === edge.from && caller.to === container.from && caller.kind === "CALLS"),
  );
}

function downstreamReaches(graph: LoadedGraph, nodeId: string, targetId: string, visited: Set<string>): boolean {
  if (nodeId === targetId) return true;
  if (visited.has(nodeId)) return false;
  visited.add(nodeId);
  return outgoing(graph.edges, nodeId).some(edge => downstreamReaches(graph, edge.to, targetId, visited));
}

function sortedChildren(edges: IciEdge[], direction: "down" | "up"): IciEdge[] {
  const target = (e: IciEdge) => (direction === "down" ? e.to : e.from);
  const key = (e: IciEdge) => `${target(e)}|${e.kind}`;
  const sorted = [...edges].sort((a, b) => key(a).localeCompare(key(b)));
  // Rust dedups displayed edges by (kind, next node) so parallel duplicates
  // (same pair, different ownerFile/evidence) collapse.
  const out: IciEdge[] = [];
  for (const e of sorted) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.kind === e.kind && target(prev) === target(e)) continue;
    out.push(e);
  }
  return out;
}

function uniqueByTarget(edges: IciEdge[], direction: "up"): IciEdge[] {
  const seen = new Set<string>();
  const out: IciEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}|${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function buildTreeNode(
  graph: LoadedGraph,
  nodeId: string,
  edge: IciEdge | undefined,
  direction: "down" | "up",
  depth: number,
  maxDepth: number,
  focusId: string | undefined,
  state: TreeState,
): QueryApiTreeNode | undefined {
  if (state.printed >= state.maxNodes) {
    state.truncated = true;
    state.truncatedAt.add(nodeId);
    return undefined;
  }
  const node = graph.nodes.get(nodeId);
  const cycle = state.branch.has(nodeId);
  const repeated = state.expanded.has(nodeId);
  const entry: { -readonly [K in keyof QueryApiTreeNode]?: unknown } & { id: string; kind: IciNode["kind"]; name: string; path: string } = {
    id: nodeId,
    kind: node?.kind ?? "method",
    name: node?.name ?? nodeId,
    path: node?.path ?? "",
  };
  if (edge !== undefined) entry.edge = edgeMeta(edge);
  if (cycle) entry.ref = "cycle";
  else if (repeated) entry.ref = "seen";
  state.printed += 1;

  // Upstream traversal stops at the api layer.
  if (direction === "up" && node?.kind === "api") return entry as QueryApiTreeNode;
  if (cycle || repeated) return entry as QueryApiTreeNode;
  if (depth >= maxDepth) return entry as QueryApiTreeNode;

  state.expanded.add(nodeId);
  state.branch.add(nodeId);

  let edges = direction === "down" ? outgoing(graph.edges, nodeId) : incoming(graph.edges, nodeId);
  if (direction === "up") {
    edges = edges.filter(e => !isRedundantUpstreamMethodCall(graph, nodeId, e));
  }
  if (direction === "down") {
    // Rust keep_agent_edge: a function's CONTAINS edges are pruned unless the
    // function itself is the focus.
    if (graph.nodes.get(nodeId)?.kind === "function") {
      edges = edges.filter(e => e.kind !== "CONTAINS" || focusId === nodeId);
    }
    // Rust keep_focus_edge: with a focus set, keep only edges whose subtree
    // passes through the focused function.
    if (focusId !== undefined) {
      if (nodeId !== focusId && !state.branch.has(focusId)) {
        edges = edges.filter(e => {
          const next = e.to;
          return next === focusId || downstreamReaches(graph, next, focusId, new Set());
        });
      }
    }
  }

  const children: QueryApiTreeNode[] = [];
  for (const childEdge of sortedChildren(edges, direction)) {
    const nextId = direction === "down" ? childEdge.to : childEdge.from;
    const child = buildTreeNode(graph, nextId, childEdge, direction, depth + 1, maxDepth, focusId, state);
    if (child !== undefined) children.push(child);
  }
  if (children.length > 0) entry.children = children;
  state.branch.delete(nodeId);
  return entry as QueryApiTreeNode;
}

export function buildDownstreamTrees(
  graph: LoadedGraph,
  startIds: readonly string[],
  depth: number,
  maxNodes: number,
  focusId?: string,
): { roots: QueryApiTreeNode[]; truncated: boolean; truncatedAt: string[] } {
  const state: TreeState = { printed: 0, maxNodes, truncated: false, truncatedAt: new Set(), expanded: new Set(), branch: new Set() };
  const roots: QueryApiTreeNode[] = [];
  for (const startId of startIds) {
    const root = buildTreeNode(graph, startId, undefined, "down", 0, depth, focusId, state);
    if (root !== undefined) roots.push(root);
  }
  return { roots, truncated: state.truncated, truncatedAt: [...state.truncatedAt].sort() };
}

export interface ImpactComputation {
  readonly paths: ImpactPath[];
  readonly confidenceCounts: { static: number; platform: number; inferred: number };
  readonly truncated: boolean;
}

export function buildImpactPaths(
  graph: LoadedGraph,
  startIds: readonly string[],
): ImpactComputation {
  const paths: ImpactPath[] = [];
  const counts = { static: 0, platform: 0, inferred: 0 };
  let truncated = false;

  for (const startId of startIds) {
    // Depth-first upstream walk; each node expands once per start to bound
    // path enumeration on cyclic graphs.
    const visited = new Set<string>();
    const stack: ImpactHop[] = [];
    const walk = (nodeId: string, edge?: IciEdgeMeta): void => {
      if (paths.length >= MAX_PATHS) {
        truncated = true;
        return;
      }
      if (visited.has(nodeId)) return;
      if (stack.length >= MAX_HOPS) {
        truncated = true;
        return;
      }
      visited.add(nodeId);
      stack.push({ nodeId, ...(edge !== undefined ? { edge } : {}) });
      const node = graph.nodes.get(nodeId);
      if (node?.kind === "api") {
        paths.push({ apiId: nodeId, hops: [...stack] });
        for (const hop of stack) {
          if (hop.edge !== undefined) counts[hop.edge.source] += 1;
        }
      } else {
        const incomingEdges = uniqueByTarget(
          incoming(graph.edges, nodeId).filter(e => !isRedundantUpstreamMethodCall(graph, nodeId, e)),
          "up",
        );
        for (const upstream of incomingEdges.sort((a, b) => a.from.localeCompare(b.from))) {
          walk(upstream.from, edgeMeta(upstream));
          if (paths.length >= MAX_PATHS) {
            truncated = true;
            break;
          }
        }
      }
      stack.pop();
    };
    walk(startId);
  }
  return { paths, confidenceCounts: counts, truncated };
}
