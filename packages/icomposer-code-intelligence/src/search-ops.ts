import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { cosineSimilarity, DEFAULT_EMBEDDING_URL, downstreamNodeNames, EMBEDDING_BATCH_SIZE, requestEmbeddings, truncate, type ApiEmbedding, type ApiSearchDoc } from "./search-core.ts";
import { writeFileAtomic } from "./storage.ts";
import type { EmbeddingMode, IciEdge, IciErrorCode, IciNode, SearchResult } from "./types.ts";

export interface IndexDeps {
  readonly rt: unknown;
  readonly token: string;
  readonly cachePath: string;
  readonly docs: readonly ApiSearchDoc[];
  readonly rebuild: boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface IndexOutcome {
  readonly total: number;
  readonly embedded: number;
  readonly reused: number;
}

type Failure = { readonly __failure: IciErrorCode };

function failure(code: IciErrorCode): Failure {
  return { __failure: code };
}

function isFailure(value: unknown): value is Failure {
  return value !== null && typeof value === "object" && "__failure" in value;
}

interface CacheLine {
  api_id: string;
  api_name: string;
  doc_path: string;
  technical_evidence: string;
  business_evidence: string;
  technical_vector: number[];
  business_vector: number[];
  text_hash: string;
  source_hash: string;
}

function parseCacheFile(text: string): ApiEmbedding[] {
  const out: ApiEmbedding[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Partial<CacheLine>;
      if (typeof obj.api_id !== "string" || typeof obj.api_name !== "string") continue;
      if (!Array.isArray(obj.technical_vector) || !Array.isArray(obj.business_vector)) continue;
      if (!obj.technical_vector.every(v => typeof v === "number" && Number.isFinite(v))) continue;
      if (!obj.business_vector.every(v => typeof v === "number" && Number.isFinite(v))) continue;
      out.push({
        apiId: obj.api_id,
        apiName: obj.api_name,
        docPath: typeof obj.doc_path === "string" ? obj.doc_path : "",
        technicalEvidence: typeof obj.technical_evidence === "string" ? obj.technical_evidence : "",
        businessEvidence: typeof obj.business_evidence === "string" ? obj.business_evidence : "",
        technicalVector: obj.technical_vector,
        businessVector: obj.business_vector,
        textHash: typeof obj.text_hash === "string" ? obj.text_hash : "",
        sourceHash: typeof obj.source_hash === "string" ? obj.source_hash : "",
      });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Incremental embedding index build (Rust load_or_build_api_embeddings):
 * cached entries whose source hash and text hash are unchanged are reused;
 * everything else is re-embedded in batches of two texts per api
 * (technical + business). The JSONL cache is written atomically.
 */
export async function indexEmbeddings(deps: IndexDeps): Promise<{ total: number; embedded: number; reused: number } | Failure> {
  const { signal, rebuild, rt, token, timeoutMs } = deps;
  let cache: ApiEmbedding[] = [];
  try {
    cache = parseCacheFile(await readFile(deps.cachePath, "utf8"));
  } catch { /* first index run */ }

  const reusable = new Map<string, ApiEmbedding>();
  const pending: ApiSearchDoc[] = [];
  for (const doc of deps.docs) {
    const cached = cache.find(e => e.apiId === doc.apiId);
    if (!rebuild && cached !== undefined && cached.sourceHash === doc.sourceHash
      && cached.textHash === doc.textHash
      && cached.technicalVector.length > 0 && cached.businessVector.length > 0) {
      reusable.set(doc.apiId, cached);
    } else {
      pending.push(doc);
    }
  }

  let embedded = 0;
  for (let i = 0; i < pending.length; i += EMBEDDING_BATCH_SIZE) {
    if (signal?.aborted) return failure("cancelled");
    const batch = pending.slice(i, i + EMBEDDING_BATCH_SIZE);
    const texts: string[] = [];
    for (const doc of batch) {
      texts.push(doc.technicalText);
      texts.push(doc.businessText);
    }
    const res = await requestEmbeddings(rt as SubprocessRuntime, {
      url: DEFAULT_EMBEDDING_URL,
      token,
      texts,
      timeoutMs,
      signal,
    });
    if ("kind" in res) {
      if (res.kind === "cancelled") return failure("cancelled");
      if (res.kind === "invalid-auth") return failure("invalid-auth");
      return failure("embedding-error");
    }
    if (res.vectors.length !== texts.length) return failure("embedding-error");
    for (let d = 0; d < batch.length; d++) {
      const doc = batch[d];
      freshPush(reusable, {
        apiId: doc.apiId,
        apiName: doc.apiName,
        docPath: `docs/API/${doc.apiName}.json`,
        technicalEvidence: doc.technicalEvidence,
        businessEvidence: doc.businessEvidence,
        technicalVector: res.vectors[d * 2],
        businessVector: res.vectors[d * 2 + 1],
        textHash: doc.textHash,
        sourceHash: doc.sourceHash,
      });
      embedded += 1;
    }
  }

  const merged: ApiEmbedding[] = deps.docs.map(doc => reusable.get(doc.apiId)).filter(e => e !== undefined);
  const lines = merged.map(toCacheLine);
  try {
    await writeFileAtomic(deps.cachePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), { signal });
  } catch {
    return failure("storage-error" as IciErrorCode);
  }
  return { total: merged.length, embedded, reused: merged.length - embedded };
}

function freshPush(reusable: Map<string, ApiEmbedding>, entry: ApiEmbedding): void {
  reusable.set(entry.apiId, entry);
}

function toCacheLine(e: ApiEmbedding): string {
  return JSON.stringify({
    api_id: e.apiId,
    api_name: e.apiName,
    doc_path: e.docPath,
    technical_evidence: e.technicalEvidence,
    business_evidence: e.businessEvidence,
    technical_vector: e.technicalVector,
    business_vector: e.businessVector,
    text_hash: e.textHash,
    source_hash: e.sourceHash,
  });
}

export interface SearchDeps {
  readonly rt: unknown;
  readonly token: string;
  readonly cachePath: string;
  readonly query: string;
  readonly mode: EmbeddingMode;
  readonly top: number;
  readonly graph: { nodes: Map<string, IciNode>; edges: IciEdge[] };
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Full in-memory cosine scoring over the JSONL cache (Rust search_api_embeddings_jsonl). */
export async function searchEmbeddings(deps: SearchDeps): Promise<SearchResult | Failure> {
  let cache: ApiEmbedding[];
  try {
    cache = parseCacheFile(await readFile(deps.cachePath, "utf8"));
  } catch {
    return failure("no-index");
  }
  if (cache.length === 0) return failure("no-index");

  const res = await requestEmbeddings(deps.rt as SubprocessRuntime, {
    url: DEFAULT_EMBEDDING_URL,
    token: deps.token,
    texts: [deps.query],
    timeoutMs: deps.timeoutMs,
    signal: deps.signal,
  });
  if ("kind" in res) {
    if (res.kind === "cancelled") return failure("cancelled");
    if (res.kind === "invalid-auth") return failure("invalid-auth");
    return failure("embedding-error");
  }
  const queryVector = res.vectors[0];
  if (!queryVector) return failure("embedding-error");

  const rows: Array<{ apiId: string; apiName: string; score: number; evidence: string; downstream: string[] }> = [];
  for (const entry of cache) {
    const candidates = deps.mode === "all"
      ? [entry.technicalVector, entry.businessVector]
      : [deps.mode === "technical" ? entry.technicalVector : entry.businessVector];
    let best: number | undefined;
    for (const vector of candidates) {
      const score = cosineSimilarity(queryVector, vector);
      if (score !== undefined && (best === undefined || score > best)) best = score;
    }
    if (best === undefined) continue;
    rows.push({
      apiId: entry.apiId,
      apiName: entry.apiName,
      score: best,
      evidence: truncate(deps.mode === "technical" ? entry.technicalEvidence : entry.businessEvidence, 200),
      downstream: downstreamNodeNames(deps.graph.nodes, deps.graph.edges, entry.apiId).slice(0, 5),
    });
  }
  rows.sort((a, b) => b.score - a.score || a.apiName.localeCompare(b.apiName));
  const truncated = rows.length > deps.top;
  const result: SearchResult = {
    workspaceId: "",
    rows: rows.slice(0, deps.top),
    truncated,
  };
  void join;
  return result;
}
