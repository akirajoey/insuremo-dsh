import type { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { apiEmbeddingText, searchEvidence } from "./search-core.ts";
import { fingerprintSources } from "./graph.ts";
import type { IciErrorCode, Result } from "./types.ts";

function err2(code: IciErrorCode, message: string = code): Result<never> {
  return { ok: false, error: { code, message } };
}

export interface EmbeddingLeaseDeps {
  readonly auth?: {
    prepare(request: { profile?: string; env?: string }, signal?: AbortSignal): Promise<{
      ok: boolean;
      value?: { use<T2>(cb: (secret: { readonly accessToken: string }) => Promise<T2> | T2): Promise<T2> };
      error?: { code?: string };
    }>;
  };
  readonly profile: { profileName: string };
  readonly subprocess: unknown;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Run `run` inside an imoAuth.prepare lease from Workbench Active Profile. */
export async function embeddingLease<T>(
  deps: EmbeddingLeaseDeps,
  run: (rt: unknown, token: string) => Promise<T | { __failure: IciErrorCode }>,
): Promise<Result<T>> {
  const auth = deps.auth;
  if (!auth) return err2("embedding-error");
  const leaseResult = await auth.prepare({ profile: deps.profile.profileName }, deps.signal);
  if (!leaseResult.ok) {
    const code = (leaseResult.error as { code?: string } | undefined)?.code;
    if (code === "invalid-auth" || code === "forbidden" || code === "prepare-invalidated" || code === "lease-revoked") {
      return err2(code as IciErrorCode);
    }
    if (code === "timeout") return err2("embedding-error");
    if (code === "cancelled") return err2("cancelled");
    if (code === "service-disposed") return err2("service-disposed");
    return err2("embedding-error");
  }
  try {
    const outcome = await leaseResult.value!.use(async (secret) => await run(deps.subprocess, secret.accessToken));
    if (outcome !== null && typeof outcome === "object" && "__failure" in outcome) {
      return err2((outcome as unknown as { __failure: IciErrorCode }).__failure);
    }
    return { ok: true, value: outcome as T };
  } catch {
    return err2("lease-revoked");
  }
}

export interface SearchDocDeps {
  readonly canonicalPath: string;
  readonly graph: { nodes: Map<string, { id: string; kind: string; name: string; sourceFile?: string }>; edges: readonly unknown[] };
}

export interface SearchDocLike {
  apiId: string;
  apiName: string;
  sourceHash: string;
  technicalText: string;
  businessText: string;
  technicalEvidence: string;
  businessEvidence: string;
  textHash: string;
}

/** Build per-api embedding docs from the snapshot graph (name+downstream template). */
export async function loadSearchDocs(canonicalPath: string, graph: { nodes: Map<string, { id: string; kind: string; name: string; sourceFile?: string }>; edges: ReadonlyArray<{ from: string; to: string }> }): Promise<SearchDocLike[]> {
  const { readFile: rf } = await import("node:fs/promises");
  const apiNodes = [...graph.nodes.values()].filter(n => n.kind === "api").sort((a, b) => a.id.localeCompare(b.id));
  const docs: SearchDocLike[] = [];
  for (const node of apiNodes) {
    const downstream = downstreamNodeNamesShim(graph, node.id);
    const technicalText = apiEmbeddingText(node.name, "technical", "", downstream);
    const businessText = apiEmbeddingText(node.name, "business", "", downstream);
    const evidence = searchEvidence("", downstream);
    let sourceHash = "";
    if (node.sourceFile) {
      try {
        const content = await rf(join(canonicalPath, node.sourceFile), "utf8");
        sourceHash = fingerprintSources([{ source: content }]);
      } catch { /* unreadable */ }
    }
    docs.push({
      apiId: node.id,
      apiName: node.name,
      sourceHash,
      technicalText,
      businessText,
      technicalEvidence: evidence,
      businessEvidence: evidence,
      textHash: fingerprintSources([{ source: technicalText }, { source: businessText }]),
    });
  }
  return docs;
}

function downstreamNodeNamesShim(graph: { nodes: Map<string, { id: string; kind: string; name: string }>; edges: ReadonlyArray<{ from: string; to: string }> }, rootId: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const frontier: Array<[string, number]> = [[rootId, 0]];
  while (frontier.length > 0) {
    const [nodeId, depth] = frontier.shift()!;
    if (depth >= 2) continue;
    for (const edge of graph.edges.filter(e => e.from === nodeId)) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      const node = graph.nodes.get(edge.to);
      if (node) names.push(`${node.kind}:${node.name}`);
      frontier.push([edge.to, depth + 1]);
    }
  }
  names.sort();
  return names.slice(0, 80);
}
