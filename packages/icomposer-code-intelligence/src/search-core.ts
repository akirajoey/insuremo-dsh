import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import type { IciEdge, IciNode } from "./types.ts";

export const EMBEDDING_BATCH_SIZE = 16;
export const EMBEDDING_TEXT_LIMIT = 8000;
export const EVIDENCE_LIMIT = 400;
export const OUTPUT_EVIDENCE_LIMIT = 200;
/** Default InsureMO embedding endpoint (Rust DEFAULT_EMBEDDING_URL). */
export const DEFAULT_EMBEDDING_URL = "https://portal-gw.insuremo.com/mo-re/1.0/aiqa/api/embedding";
const DOWNSTREAM_NAMES_MAX = 80;
const DOWNSTREAM_DEPTH = 2;

export type SearchMode = "technical" | "business";

export interface ApiSearchDoc {
  readonly apiId: string;
  readonly apiName: string;
  /** sha256 of the api's current groovy source (incremental reuse key). */
  readonly sourceHash: string;
  readonly technicalText: string;
  readonly businessText: string;
  readonly technicalEvidence: string;
  readonly businessEvidence: string;
  /** Content hash of both texts; unchanged docs reuse cached vectors. */
  readonly textHash: string;
}

export interface ApiEmbedding {
  readonly apiId: string;
  readonly apiName: string;
  readonly sourceHash: string;
  readonly docPath: string;
  readonly technicalEvidence: string;
  readonly businessEvidence: string;
  readonly technicalVector: number[];
  readonly businessVector: number[];
  readonly textHash: string;
}

/** Rust api_embedding_text template: API/Mode/[Downstream]/body, 8000 chars. */
export function apiEmbeddingText(apiName: string, mode: string, body: string, downstream: readonly string[]): string {
  let text = `API: ${apiName}\nMode: ${mode}\n`;
  if (downstream.length > 0) text += `Downstream: ${downstream.join(", ")}\n`;
  text += body;
  return truncate(text, EMBEDDING_TEXT_LIMIT);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Rust downstream_node_names: BFS depth 2, labels sorted, capped at 80. */
export function downstreamNodeNames(nodes: Map<string, IciNode>, edges: readonly IciEdge[], rootId: string, maxDepth = DOWNSTREAM_DEPTH): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const frontier: Array<[string, number]> = [[rootId, 0]];
  while (frontier.length > 0) {
    const [nodeId, depth] = frontier.shift()!;
    if (depth >= maxDepth) continue;
    for (const edge of edges.filter(e => e.from === nodeId)) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      const node = nodes.get(edge.to);
      if (node) names.push(`${node.kind}:${node.name}`);
      frontier.push([edge.to, depth + 1]);
    }
  }
  names.sort();
  return names.slice(0, DOWNSTREAM_NAMES_MAX);
}

/** Rust search_evidence: first three meaningful doc lines + downstream sample. */
export function searchEvidence(docText: string, downstream: readonly string[]): string {
  const lines: string[] = [];
  for (const raw of docText.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "---" || trimmed.startsWith("<!--")
      || trimmed.startsWith("type:") || trimmed.startsWith("id:")
      || trimmed.startsWith("code_hash:") || trimmed.startsWith("context_hash:")
      || trimmed.startsWith("last_scan:")) {
      continue;
    }
    lines.push(trimmed.replace(/^- /, "").replace(/^# /, ""));
    if (lines.length >= 3) break;
  }
  if (downstream.length > 0) {
    lines.push(`downstream: ${downstream.slice(0, 8).join(", ")}`);
  }
  return truncate(lines.join(" | "), EVIDENCE_LIMIT);
}

/** Rust embedding_request_body: {"text":[...],"batch_size":N}. */
export function embeddingRequestBody(texts: readonly string[]): string {
  const values = texts.map(t => JSON.stringify(t)).join(",");
  return `{"text":[${values}],"batch_size":${texts.length}}`;
}

export interface EmbeddingRequestResult {
  readonly vectors: number[][];
}

export type EmbeddingRequestError =
  | { readonly kind: "invalid-auth" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "embedding-error"; readonly message: string };

/**
 * One embedding batch through `ctx.subprocess` curl (Rust request_embeddings):
 * -sS, HTTP status trailer, fixed portal headers, Bearer auth, --data-raw
 * body. Raw stdout never escapes — only parsed vectors or fixed-code errors.
 */
export async function requestEmbeddings(
  rt: SubprocessRuntime,
  options: { url: string; token: string; texts: readonly string[]; timeoutMs: number; signal?: AbortSignal },
): Promise<EmbeddingRequestResult | EmbeddingRequestError> {
  const body = embeddingRequestBody(options.texts);
  let executablePath: string;
  try {
    executablePath = await rt.resolveExecutable("curl", undefined, options.signal);
  } catch {
    return { kind: "embedding-error", message: "embedding-error" };
  }
  let handle;
  try {
    handle = rt.spawn({
      argv: [
        executablePath,
        "-sS",
        "-w",
        "\n__ICI_HTTP_STATUS__:%{http_code}",
        options.url,
        "-H",
        "accept: application/json, text/plain, */*",
        "-H",
        "content-type: application/json;charset=UTF-8",
        "-H",
        "origin: https://portal.insuremo.com",
        "-H",
        "referer: https://portal.insuremo.com/",
        "-H",
        `authorization: Bearer ${options.token}`,
        "--data-raw",
        body,
      ],
      cwd: "/tmp",
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 16 * 1024 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 1000,
      signal: options.signal,
    });
  } catch {
    return { kind: "embedding-error", message: "embedding-error" };
  }
  try {
    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0)?.text ?? "";
    if (options.signal?.aborted) return { kind: "cancelled" };
    const marker = "\n__ICI_HTTP_STATUS__:";
    const idx = stdout.lastIndexOf(marker);
    if (idx < 0) return { kind: "embedding-error", message: "embedding-error" };
    const responseBody = stdout.slice(0, idx);
    const status = Number(stdout.slice(idx + marker.length).trim());
    if (outcome.exitCode !== 0 || !Number.isFinite(status)) return { kind: "embedding-error", message: "embedding-error" };
    if (status === 401) return { kind: "invalid-auth" };
    if (!(status >= 200 && status < 300)) return { kind: "embedding-error", message: "embedding-error" };
    const vectors = extractEmbeddingVectors(responseBody);
    if (vectors.length === 0) return { kind: "embedding-error", message: "embedding-error" };
    return { vectors };
  } catch {
    if (options.signal?.aborted) return { kind: "cancelled" };
    return { kind: "embedding-error", message: "embedding-error" };
  }
}

/** Rust extract_embedding_vectors: collect numeric vectors from arbitrary JSON shape. */
export function extractEmbeddingVectors(text: string): number[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const vectors: number[][] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every(item => typeof item === "number" && Number.isFinite(item))) {
        vectors.push(value as number[]);
        return;
      }
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(parsed);
  return vectors;
}

/** Rust cosine_similarity: None on dimension mismatch or zero norm. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number | undefined {
  if (left.length !== right.length || left.length === 0) return undefined;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm === 0 || rightNorm === 0) return undefined;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
