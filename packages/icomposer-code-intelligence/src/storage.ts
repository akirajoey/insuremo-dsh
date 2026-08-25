import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IciManifest } from "./types.ts";

export function getDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function workspaceHash(canonicalPathInput: string, workspaceId: string): string {
  let canonicalPath = canonicalPathInput;
  try { canonicalPath = realpathSync(canonicalPathInput); } catch {}
  return createHash("sha256").update(`${canonicalPath}:${workspaceId}`).digest("hex").slice(0, 16);
}

export function workspaceIciBaseDir(canonicalPath: string): string {
  return join(canonicalPath, ".metadata", "icomposer", "ici");
}

export function legacyGraphBaseDir(canonicalPath: string, workspaceId: string): string {
  return join(getDshHome(), "ici", workspaceHash(canonicalPath, workspaceId), "graph");
}

/** New writes live in the workspace-owned, CLI/cache metadata area. */
export function graphBaseDir(canonicalPath: string, _workspaceId: string): string {
  return join(workspaceIciBaseDir(canonicalPath), "graph");
}

export const GRAPH_ARTIFACT_RELATIVE_PATH = ".metadata/icomposer/ici/graph/current" as const;
export const SEARCH_ARTIFACT_RELATIVE_PATH = ".metadata/icomposer/ici/graph/search/api_embeddings.jsonl" as const;

export async function searchCachePath(canonicalPath: string, workspaceId: string): Promise<string> {
  const current = join(graphBaseDir(canonicalPath, workspaceId), "search", "api_embeddings.jsonl");
  try { await stat(current); return current; } catch { return join(legacyGraphBaseDir(canonicalPath, workspaceId), "search", "api_embeddings.jsonl"); }
}

export function explainBaseDir(canonicalPath: string): string {
  return join(workspaceIciBaseDir(canonicalPath), "explain");
}

export function explainStatePath(canonicalPath: string, _workspaceId: string): string {
  return join(explainBaseDir(canonicalPath), "state.json");
}

export function legacyExplainStatePath(canonicalPath: string, workspaceId: string): string {
  return join(legacyGraphBaseDir(canonicalPath, workspaceId), "explain-state.json");
}

function safeExplainSlug(apiName: string): string {
  const slug = apiName.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
  const suffix = createHash("sha256").update(apiName).digest("hex").slice(0, 12);
  return `${slug.length > 0 ? slug : "api"}-${suffix}`;
}

export function explainContextPath(canonicalPath: string, apiName: string): string {
  return join(explainBaseDir(canonicalPath), safeExplainSlug(apiName), "context.json");
}

export function explainDeterministicPath(canonicalPath: string, apiName: string): string {
  return join(explainBaseDir(canonicalPath), safeExplainSlug(apiName), "deterministic.json");
}

export function explainContextArtifactRelativePath(apiName: string): string {
  return `.metadata/icomposer/ici/explain/${safeExplainSlug(apiName)}/context.json`;
}

export function explainDeterministicArtifactRelativePath(apiName: string): string {
  return `.metadata/icomposer/ici/explain/${safeExplainSlug(apiName)}/deterministic.json`;
}

const MAX_EXPLAIN_API_NAME = 512;

export interface ExplainStateFile {
  readonly schemaVersion: 2;
  readonly kind: "context" | "deterministic";
  readonly generatedAt: string;
  readonly apiName: string;
  readonly artifactPath: string;
}

/** Read new state first. Legacy fallback is allowed only when the new state is absent. */
export async function readExplainState(canonicalPath: string, workspaceId: string): Promise<ExplainStateFile | null> {
  const newPath = explainStatePath(canonicalPath, workspaceId);
  let raw: string;
  try { raw = await readFile(newPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    try { raw = await readFile(legacyExplainStatePath(canonicalPath, workspaceId), "utf8"); } catch { return null; }
    try {
      const legacy = JSON.parse(raw) as { schemaVersion?: number; lastExplainAt?: string; apiName?: string };
      if (legacy.schemaVersion === 1 && typeof legacy.lastExplainAt === "string" && typeof legacy.apiName === "string") return { schemaVersion: 2, kind: "context", generatedAt: legacy.lastExplainAt, apiName: legacy.apiName, artifactPath: "" };
    } catch { /* invalid legacy marker */ }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: number; kind?: string; generatedAt?: string; apiName?: string; artifactPath?: string };
    const kind = parsed.kind === "context" || parsed.kind === "deterministic" ? parsed.kind : null;
    const expected = kind === "context" ? explainContextArtifactRelativePath(parsed.apiName ?? "") : kind === "deterministic" ? explainDeterministicArtifactRelativePath(parsed.apiName ?? "") : "";
    if (parsed.schemaVersion !== 2 || kind === null || typeof parsed.generatedAt !== "string" || parsed.generatedAt.length === 0 || typeof parsed.apiName !== "string" || parsed.apiName.length === 0 || parsed.artifactPath !== expected) return null;
    const artifact = JSON.parse(await readFile(join(canonicalPath, parsed.artifactPath), "utf8")) as { schemaVersion?: unknown; kind?: unknown };
    return artifact.schemaVersion === 2 && artifact.kind === kind ? parsed as ExplainStateFile : null;
  } catch { return null; }
}

async function writeJsonAtomic(final: string, value: unknown, signal?: AbortSignal): Promise<void> {
  await writeFileAtomic(final, `${JSON.stringify(value, null, 2)}\n`, { signal });
}

export async function writeExplainContext(canonicalPath: string, apiName: string, bundle: unknown, signal?: AbortSignal): Promise<string> {
  if (apiName.length === 0 || apiName.length > MAX_EXPLAIN_API_NAME) throw new Error("api name exceeds artifact bound");
  const generatedAt = new Date().toISOString();
  const artifactPath = explainContextArtifactRelativePath(apiName);
  await writeJsonAtomic(explainContextPath(canonicalPath, apiName), { schemaVersion: 2, kind: "context", generatedAt, bundle }, signal);
  await writeJsonAtomic(explainStatePath(canonicalPath, ""), { schemaVersion: 2, kind: "context", generatedAt, apiName, artifactPath }, signal);
  return artifactPath;
}

export async function writeExplainDeterministic(canonicalPath: string, apiName: string, result: unknown, signal?: AbortSignal): Promise<string> {
  if (apiName.length === 0 || apiName.length > MAX_EXPLAIN_API_NAME) throw new Error("api name exceeds artifact bound");
  const generatedAt = new Date().toISOString();
  const artifactPath = explainDeterministicArtifactRelativePath(apiName);
  await writeJsonAtomic(explainDeterministicPath(canonicalPath, apiName), { schemaVersion: 2, kind: "deterministic", generatedAt, result }, signal);
  await writeJsonAtomic(explainStatePath(canonicalPath, ""), { schemaVersion: 2, kind: "deterministic", generatedAt, apiName, artifactPath }, signal);
  return artifactPath;
}

export function currentDir(base: string): string {
  return join(base, "current");
}

export function stagingDir(base: string): string {
  return join(base, `staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

export async function readManifest(base: string, legacyBase?: string): Promise<IciManifest | null> {
  for (const candidate of [base, ...(legacyBase === undefined ? [] : [legacyBase])]) {
    try { return JSON.parse(await readFile(join(currentDir(candidate), "manifest.json"), "utf8")) as IciManifest; } catch { /* fallback */ }
  }
  return null;
}

export interface WriteFileAtomicOptions {
  readonly signal?: AbortSignal;
  readonly renameFn?: typeof rename;
  readonly rmFn?: typeof rm;
  readonly warn?: (message: string) => void;
}

/**
 * Three-phase atomic file write (same promote semantics as the graph
 * snapshot, applied to a single file such as the JSONL vector cache):
 * final → stale-<ts> (skip if absent), tmp → final (rollback on failure),
 * best-effort stale cleanup.
 */
export async function writeFileAtomic(
  finalPath: string,
  content: string,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const signal = options.signal;
  const renameFn = options.renameFn ?? rename;
  const rmFn = options.rmFn ?? rm;
  const warn = options.warn ?? ((message: string) => console.warn(`[ici] ${message}`));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const dir = join(finalPath, "..");
  const tmp = `${finalPath}.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, content, "utf8");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const stale = `${finalPath}.stale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let movedStale = false;
    let hasFinal = false;
    try {
      await stat(finalPath);
      hasFinal = true;
    } catch {
      hasFinal = false;
    }
    if (hasFinal) {
      try {
        await renameFn(finalPath, stale);
        movedStale = true;
      } catch (error) {
        await rmFn(tmp, { force: true }).catch(() => {});
        warn(`promote: could not move previous file aside (${String(error)}); previous version kept`);
        throw error;
      }
    }
    try {
      await renameFn(tmp, finalPath);
    } catch (error) {
      if (movedStale) {
        try {
          await renameFn(stale, finalPath);
          movedStale = false;
        } catch (rollbackError) {
          warn(`promote rollback failed: ${String(rollbackError)}`);
        }
      }
      await rmFn(tmp, { force: true }).catch(() => {});
      throw error;
    }
    if (movedStale) {
      try {
        await rmFn(stale, { force: true });
      } catch (error) {
        warn(`cleanup of stale file failed: ${String(error)}`);
      }
    }
  } catch (error) {
    // Abort can occur after the write and must not leave staging residue.
    await rmFn(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
export interface GraphSnapshot {
  readonly manifest: IciManifest;
  readonly nodes: IciNodeLike[];
  readonly edges: IciEdgeLike[];
}

export interface IciNodeLike {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly path: string;
  readonly evidence: string;
  readonly sourceFile?: string;
  readonly owner?: string;
}

export interface IciEdgeLike {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly ownerFile: string;
  readonly source: string;
  readonly confidence: string;
  readonly evidence: string;
}

/** Load the promoted `current` snapshot; null when no snapshot exists. */
export async function loadSnapshot(base: string, legacyBase?: string): Promise<GraphSnapshot | null> {
  for (const candidate of [base, ...(legacyBase === undefined ? [] : [legacyBase])]) {
    try {
      const [manifestText, nodesText, edgesText] = await Promise.all([
        readFile(join(currentDir(candidate), "manifest.json"), "utf8"),
        readFile(join(currentDir(candidate), "nodes.json"), "utf8"),
        readFile(join(currentDir(candidate), "edges.json"), "utf8"),
      ]);
      const manifest = JSON.parse(manifestText) as IciManifest;
      const nodes = JSON.parse(nodesText) as IciNodeLike[];
      const edges = JSON.parse(edgesText) as IciEdgeLike[];
      if (Array.isArray(nodes) && Array.isArray(edges)) return { manifest, nodes, edges };
    } catch { /* fallback */ }
  }
  return null;
}

export interface WriteAtomicOptions {
  readonly signal?: AbortSignal;
  /** Test seam: override rename to inject promote failures. */
  readonly renameFn?: typeof rename;
  /** Test seam: override rm to inject cleanup failures. */
  readonly rmFn?: typeof rm;
  /** Test seam / diagnostics sink for non-fatal cleanup warnings. */
  readonly warn?: (message: string) => void;
}

/**
 * Atomic snapshot write with a three-phase promote (Rust current/ semantics):
 *
 *   1. `rename(current → stale-<ts>)` — skipped when no previous version
 *      exists; failure leaves the previous `current` fully intact.
 *   2. `rename(staging → current)` — on failure the stale directory is rolled
 *      back so `current` is never half-deleted.
 *   3. `rm(stale)` — best-effort cleanup; failure only warns and does not
 *      affect the result.
 */
export async function writeAtomic(
  base: string,
  manifest: IciManifest,
  nodes: unknown[],
  edges: unknown[],
  options: WriteAtomicOptions = {},
): Promise<void> {
  const signal = options.signal;
  const renameFn = options.renameFn ?? rename;
  const rmFn = options.rmFn ?? rm;
  const warn = options.warn ?? ((message: string) => console.warn(`[ici] ${message}`));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const staging = stagingDir(base);
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, "nodes.json"), JSON.stringify(nodes, null, 2), "utf8");
    await writeFile(join(staging, "edges.json"), JSON.stringify(edges, null, 2), "utf8");
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await mkdir(base, { recursive: true });
    const current = currentDir(base);

    // Phase 1: move any previous version aside. Failure here leaves `current`
    // untouched (e.g. immutable-flag scenarios) and propagates.
    const stale = join(base, `stale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    let movedStale = false;
    let hasCurrent = false;
    try {
      await stat(current);
      hasCurrent = true;
    } catch {
      hasCurrent = false;
    }
    if (hasCurrent) {
      try {
        await renameFn(current, stale);
        movedStale = true;
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        warn(`promote: could not move previous current aside (${String(error)}); previous version kept`);
        throw error;
      }
    }

    // Phase 2: promote staging → current; roll the stale copy back on failure
    // so `current` is never left missing.
    try {
      await renameFn(staging, current);
    } catch (error) {
      if (movedStale) {
        try {
          await renameFn(stale, current);
          movedStale = false;
        } catch (rollbackError) {
          warn(`promote rollback failed: ${String(rollbackError)}`);
        }
      }
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    // Phase 3: best-effort stale cleanup; failure only warns.
    if (movedStale) {
      try {
        await rmFn(stale, { recursive: true, force: true });
      } catch (error) {
        warn(`cleanup of stale snapshot failed: ${String(error)}`);
      }
    }
  } catch (error) {
    if (!(error instanceof DOMException)) {
      await rmFn(staging, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}
