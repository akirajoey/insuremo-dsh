import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import type { IciEdge, IciNode } from "./types.ts";
import type { LoadedGraph } from "./query.ts";
import { readContainedExplainJson, readValidatedExplainFinal, setExplainWriterFailpoint, validExplainBatchPlan, validExplainBatchRecord, validExplainBatchJobIds, validExplainBatchShardRecord, withExplainFileLock, writeExplainFile, EXPLAIN_BATCH_INLINE_MAX, EXPLAIN_BATCH_SHARD_MAX, EXPLAIN_TASK_CONCURRENCY_MAX, EXPLAIN_TASK_CONCURRENCY_MIN, type ExplainBatchHeader, type ExplainBatchPlan, type ExplainBatchRecord as ContractExplainBatchRecord } from "@icomposer/workbench-contracts/ici-explain";
import { explainBaseDir, graphBaseDir, legacyGraphBaseDir, readManifest } from "./storage.ts";
import { ICI_ENGINE_VERSION } from "./engine-version.ts";
import { HOST_INSTANCE_ID } from "./host-instance.ts";

export const EXPLAIN_SCHEMA_VERSION = 3 as const;
export const EXPLAIN_PROMPT_VERSION = "explain-mvp-v1" as const;
export const MAX_EXPLAIN_SOURCE_BYTES = 256 * 1024;
export const MAX_EXPLAIN_FILES = 16;
export const MAX_EXPLAIN_NODES = 80;
export const MAX_EXPLAIN_EDGES = 240;
export const MAX_EXPLAIN_DEPTH = 24;
export const MAX_RANGE_LINES = 200;
export type ExplainReferenceTargetKind = "none" | "file" | "directory";
export interface ExplainReferenceTarget { readonly path: string; readonly kind: ExplainReferenceTargetKind; }
export const NONE_REFERENCE_TARGET: ExplainReferenceTarget = { path: "", kind: "none" } as const;
const SECRET_PATTERN = /(authorization\s*:|bearer\s+|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)/i;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'`])\/(?:Users|home|private|tmp|var|opt|etc)\/|[A-Za-z]:[\\/]/i;
const ABSOLUTE_PATH_TOKEN_PATTERN = /\/(?:Users|home|private|tmp|var|opt|etc)\/[^\s"'`<>()[\]{}]+|[A-Za-z]:[\\/][^\s"'`<>()[\]{}]+/gi;
const ABSOLUTE_PATH_REPLACEMENT = "[absolute-path-redacted]";
export type ExplainFinalizePhase = "before-final" | "after-final" | "after-state";
let explainFinalizeFailpoint: ((phase: ExplainFinalizePhase) => void | Promise<void>) | undefined;
export function setExplainFinalizeFailpoint(failpoint: ((phase: ExplainFinalizePhase) => void | Promise<void>) | undefined): void { explainFinalizeFailpoint = failpoint; }

export interface ExplainSourceRef { readonly nodeId?: string; readonly path: string; readonly startLine?: number; readonly endLine?: number; readonly sha256: string; readonly bytes: number; readonly kind: "source" | "reference"; readonly readable: boolean; }
export interface ExplainChainNode { readonly nodeId: string; readonly kind: string; readonly name: string; readonly owner?: string; readonly sourceFile: string; readonly startLine?: number; readonly endLine?: number; readonly signature?: string; readonly sourceHash?: string; readonly directCalls: readonly string[]; readonly pathFromApi: readonly string[]; readonly cycle: boolean; readonly repeated: boolean; }
export interface ExplainChainEdge { readonly from: string; readonly to: string; readonly kind: string; readonly source: string; readonly confidence: string; readonly evidence: string; readonly ownerFile: string; }
export interface ExplainPrepareArtifact {
  readonly schemaVersion: 3; readonly kind: "prepare"; readonly workspaceId: string; readonly api: { readonly id: string; readonly name: string };
  readonly callChain: { readonly nodes: readonly ExplainChainNode[]; readonly edges: readonly ExplainChainEdge[]; readonly paths: readonly (readonly string[])[]; readonly repeatedVisits: readonly string[]; readonly truncated: boolean };
  readonly sources: readonly ExplainSourceRef[]; readonly references: readonly ExplainSourceRef[];
  /** New prepares persist the graph protocol version; it is optional only when reading legacy schema-3 artifacts. */
  readonly manifest: { readonly sourceFingerprint: string; readonly graphDigest: string; readonly promptVersion: "explain-mvp-v1"; readonly engineVersion?: string };
  readonly contextHash: string; readonly prepareId: string; readonly generatedAt: string;
}
export interface ExplainSourceFile { readonly nodeId?: string; readonly path: string; readonly startLine?: number; readonly endLine?: number; readonly content: string; readonly sha256: string; }
export interface ExplainFinalArtifact {
  readonly schemaVersion: 3; readonly kind: "final"; readonly workspaceId: string; readonly api: { readonly id: string; readonly name: string };
  readonly callChain: ExplainPrepareArtifact["callChain"]; readonly manifest: ExplainPrepareArtifact["manifest"]; readonly prepareId: string; readonly sourceFingerprint: string; readonly graphDigest: string; readonly contextHash: string;
  readonly generatedBy: "current-agent"; readonly verified: false; readonly needsBusinessReview: true; readonly generatedAt: string;
  readonly apiAnalysis: { readonly technical: string; readonly business: string; readonly flow: readonly string[]; readonly evidence: readonly string[] };
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safeRel(value: string): boolean { return value !== "" && value.length <= 512 && !isAbsolute(value) && !value.startsWith("../") && !value.split("/").includes("..") && !value.includes("\\") && !value.includes("*") && !value.startsWith("."); }
function safeRefStem(value: string): boolean { return value.length > 0 && value.length <= 256 && value.endsWith(".md") && !value.includes("/") && !value.includes("\\") && value !== ".md" && value !== ".."; }
export function validFolderPath(value: unknown): value is string { return value === "" || typeof value === "string" && value.length <= 512 && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some(part => part === "" || part === "." || part === "..") && !value.startsWith(".metadata"); }
function isContainedPath(root: string, target: string): boolean { const child = relative(root, target); return child === "" || child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child); }
async function containedDirectory(root: string, folderPath: string): Promise<string> { if (!validFolderPath(folderPath)) throw new Error("folder-forbidden"); const rootReal = await realpath(root); let current = rootReal; for (const part of folderPath === "" ? [] : folderPath.split("/")) { current = join(current, part); const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("folder-forbidden"); } const target = await realpath(current); if (!isContainedPath(rootReal, target)) throw new Error("folder-forbidden"); return target; }
export async function listFolderEntries(root: string, folderPath: string): Promise<readonly { path: string; kind: "file" | "directory"; supported?: boolean }[]> { const target = await containedDirectory(root, folderPath); const entries = await readdir(target, { withFileTypes: true }); const result: Array<{ path: string; kind: "file" | "directory"; supported?: boolean }> = []; for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)) { if (!validFolderPath(entry.name) || entry.name.includes("/")) continue; if (entry.isSymbolicLink()) throw new Error("folder-forbidden"); if (entry.isDirectory()) result.push({ path: folderPath === "" ? entry.name : `${folderPath}/${entry.name}`, kind: "directory" }); else if (entry.isFile()) result.push({ path: folderPath === "" ? entry.name : `${folderPath}/${entry.name}`, kind: "file", supported: supportedFolderFile(entry.name) }); } return result; }
const FOLDER_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".log"]);
function supportedFolderFile(path: string): boolean { const dot = path.lastIndexOf("."); return dot > 0 && FOLDER_EXTENSIONS.has(path.slice(dot).toLowerCase()); }
export function supportedFolderPath(path: string): boolean { return supportedFolderFile(path); }
export function validReferenceTarget(value: unknown): value is ExplainReferenceTarget { if (typeof value !== "object" || value === null || Object.keys(value).length !== 2) return false; const target = value as Record<string, unknown>; if (target.kind === "none") return target.path === ""; return typeof target.path === "string" && validFolderPath(target.path) && (target.kind === "directory" || target.kind === "file" && supportedFolderFile(target.path)); }
export async function assertReferenceTarget(root: string, target: ExplainReferenceTarget): Promise<void> { if (!validReferenceTarget(target)) throw new Error("folder-forbidden"); if (target.kind === "none") return; try { if (target.kind === "directory") await containedDirectory(root, target.path); else await containedFile(root, target.path); } catch { throw new Error("folder-forbidden"); } }
export async function listReferenceEntries(root: string, target: ExplainReferenceTarget, subpath = ""): Promise<readonly { path: string; kind: "file" | "directory"; supported?: boolean }[]> { if (!validReferenceTarget(target)) throw new Error("folder-forbidden"); if (target.kind === "none") return []; if (!validFolderPath(subpath)) throw new Error("folder-forbidden"); const relativeSubpath = target.path === "" ? subpath : subpath === target.path ? "" : subpath.startsWith(`${target.path}/`) ? subpath.slice(target.path.length + 1) : subpath; if (target.kind === "file") { const name = target.path.slice(target.path.lastIndexOf("/") + 1); if (relativeSubpath !== "" && relativeSubpath !== target.path && relativeSubpath !== name) throw new Error("folder-forbidden"); return [{ path: name, kind: "file", supported: true }]; } const combined = target.path === "" ? relativeSubpath : relativeSubpath === "" ? target.path : `${target.path}/${relativeSubpath}`; const entries = await listFolderEntries(root, combined); const prefix = target.path === "" ? "" : `${target.path}/`; const nestedPrefix = `${prefix}${relativeSubpath === "" ? "" : `${relativeSubpath}/`}`; return entries.map(entry => ({ ...entry, path: entry.path.startsWith(nestedPrefix) ? entry.path.slice(nestedPrefix.length) : entry.path })); }
export async function readFolderText(root: string, folderPath: string, relativePath: string): Promise<{ path: string; content: string; bytes: number; sha256: string }> { if (!validFolderPath(relativePath) || relativePath.startsWith(`${folderPath}/`) || relativePath.includes("/../") || !supportedFolderFile(relativePath)) throw new Error("folder-forbidden"); return readReferenceText(root, { path: folderPath, kind: "directory" }, relativePath); }
export async function readReferenceText(root: string, target: ExplainReferenceTarget, relativePath: string): Promise<{ path: string; content: string; bytes: number; sha256: string }> { if (!validReferenceTarget(target) || typeof relativePath !== "string" || !validFolderPath(relativePath)) throw new Error("folder-forbidden"); if (target.kind === "none") throw new Error("folder-forbidden"); let path: string; if (target.kind === "file") { const name = target.path.slice(target.path.lastIndexOf("/") + 1); if (relativePath !== target.path && relativePath !== name) throw new Error("folder-forbidden"); path = target.path; } else { const childPath = target.path !== "" && relativePath.startsWith(`${target.path}/`) ? relativePath.slice(target.path.length + 1) : relativePath; if (!supportedFolderFile(childPath)) throw new Error("folder-forbidden"); path = target.path === "" ? childPath : `${target.path}/${childPath}`; } let file: string; try { file = await containedFile(root, path); } catch { throw new Error("folder-forbidden"); } if ((await lstat(file)).size > 64 * 1024) throw new Error("folder-oversize"); const raw = await readFile(file); const content = new TextDecoder("utf-8", { fatal: true }).decode(raw); const bytes = raw.byteLength; if (bytes > 64 * 1024) throw new Error("folder-oversize"); if (SECRET_PATTERN.test(content)) throw new Error("folder-forbidden"); const safeContent = content.replace(ABSOLUTE_PATH_TOKEN_PATTERN, ABSOLUTE_PATH_REPLACEMENT); if (ABSOLUTE_PATH_PATTERN.test(safeContent) || SECRET_PATTERN.test(safeContent)) throw new Error("folder-forbidden"); return { path, content: safeContent, bytes: Buffer.byteLength(safeContent, "utf8"), sha256: digest(content) }; }
function slug(name: string): string { return `${name.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "api"}-${digest(name).slice(0, 12)}`; }
function prepareRel(name: string): string { return `.metadata/icomposer/ici/explain/${slug(name)}/prepare.json`; }
function finalRel(name: string, jobId: string): string { return `.metadata/icomposer/ici/explain/${slug(name)}/finals/${jobId}.json`; }
function stateRel(): string { return ".metadata/icomposer/ici/explain/state.json"; }
function writeOptions(relativePath: string, signal?: AbortSignal): Record<string, unknown> { return relativePath === stateRel() ? { signal, lockKey: "workspace-publication" } : relativePath.includes("/finals/") ? { signal, exclusive: true } : { signal }; }
async function writeExplain(root: string, relativePath: string, content: string, signal?: AbortSignal): Promise<void> { await writeExplainFile(root, relativePath, content, writeOptions(relativePath, signal)); }
export async function readExplainPublicationState(root: string): Promise<unknown | null> { try { return (await readValidatedExplainFinal(root))?.state ?? null; } catch { return null; } }
export async function restoreExplainPublicationState(root: string, state: unknown | null): Promise<void> { if (state === null) { await rm(join(root, stateRel()), { force: true }); return; } await writeExplainFile(root, stateRel(), `${JSON.stringify(state, null, 2)}\n`, { lockKey: "workspace-publication", skipFailpoint: true }); }

async function containedFile(root: string, path: string): Promise<string> {
  if (!safeRel(path)) throw new Error("source-forbidden");
  const rootReal = await realpath(root); let current = rootReal;
  for (const part of normalize(path).split(/[\\/]+/)) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error("source-forbidden"); }
  const target = await realpath(join(rootReal, normalize(path)));
  if (!isContainedPath(rootReal, target)) throw new Error("source-forbidden");
  if (!(await lstat(target)).isFile()) throw new Error("source-forbidden");
  return target;
}
async function sourceRef(root: string, path: string, kind: "source" | "reference", nodeId?: string, startLine?: number, endLine?: number): Promise<ExplainSourceRef> {
  try {
    const target = await containedFile(root, path); if ((await lstat(target)).size > MAX_EXPLAIN_SOURCE_BYTES) throw new Error("source-oversize"); const content = await readFile(target, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_EXPLAIN_SOURCE_BYTES) throw new Error("source-oversize");
    const lines = content.split("\n"); const from = Math.max(1, startLine ?? 1); const to = Math.min(lines.length, endLine ?? lines.length); const excerpt = lines.slice(from - 1, to).join("\n"); return { ...(nodeId === undefined ? {} : { nodeId }), path, ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }), sha256: digest(content), bytes: Buffer.byteLength(kind === "source" ? excerpt : content, "utf8"), kind, readable: true };
  } catch (error) {
    if (error instanceof Error && error.message === "source-forbidden") throw error;
    return { ...(nodeId === undefined ? {} : { nodeId }), path, ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }), sha256: "", bytes: 0, kind, readable: false };
  }
}
function graphDigest(graph: LoadedGraph): string { return digest({ nodes: [...graph.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: [...graph.edges].sort((a, b) => `${a.from}|${a.to}|${a.kind}`.localeCompare(`${b.from}|${b.to}|${b.kind}`)) }); }
function chain(graph: LoadedGraph, start: IciNode): ExplainPrepareArtifact["callChain"] {
  const outgoing = new Map<string, IciEdge[]>();
  for (const edge of graph.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  for (const list of outgoing.values()) list.sort((a, b) => `${a.to}|${a.kind}|${a.evidence}`.localeCompare(`${b.to}|${b.kind}|${b.evidence}`));
  const queue: Array<{ id: string; path: string[]; depth: number }> = [{ id: start.id, path: [start.id], depth: 0 }]; const seen = new Set<string>(); const nodes: ExplainChainNode[] = []; const edges: ExplainChainEdge[] = []; const edgeKeys = new Set<string>(); const paths: string[][] = []; const repeated: string[] = []; let truncated = false;
  while (queue.length) {
    const item = queue.shift()!; const node = graph.nodes.get(item.id); if (!node) continue;
    if (seen.has(item.id)) { repeated.push(item.id); continue; }
    seen.add(item.id); nodes.push({ nodeId: node.id, kind: node.kind, name: node.name, ...(node.owner === undefined ? {} : { owner: node.owner }), sourceFile: safeRel(node.sourceFile ?? "") ? node.sourceFile ?? "" : "", ...(node.startLine === undefined ? {} : { startLine: node.startLine }), ...(node.endLine === undefined ? {} : { endLine: node.endLine }), ...(node.signature === undefined ? {} : { signature: node.signature }), ...(node.sourceHash === undefined ? {} : { sourceHash: node.sourceHash }), directCalls: (outgoing.get(item.id) ?? []).filter(edge => edge.kind === "CALLS").map(edge => edge.to).slice(0, 32), pathFromApi: item.path, cycle: item.path.slice(0, -1).includes(item.id), repeated: false }); paths.push(item.path);
    if (item.depth >= MAX_EXPLAIN_DEPTH) { if ((outgoing.get(item.id) ?? []).length) truncated = true; continue; }
    for (const edge of outgoing.get(item.id) ?? []) {
      if (edges.length >= MAX_EXPLAIN_EDGES || nodes.length + queue.length >= MAX_EXPLAIN_NODES) { truncated = true; break; }
      const key = `${edge.from}|${edge.to}|${edge.kind}`; if (edgeKeys.has(key)) continue; edgeKeys.add(key); edges.push({ from: edge.from, to: edge.to, kind: edge.kind, source: edge.source, confidence: edge.confidence, evidence: edge.evidence.slice(0, 400), ownerFile: safeRel(edge.ownerFile) ? edge.ownerFile : "" });
      if (!item.path.includes(edge.to)) queue.push({ id: edge.to, path: [...item.path, edge.to], depth: item.depth + 1 }); else paths.push([...item.path, edge.to]);
    }
  }
  return { nodes: nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId)), edges: edges.sort((a, b) => `${a.from}|${a.to}|${a.kind}`.localeCompare(`${b.from}|${b.to}|${b.kind}`)), paths: paths.sort((a, b) => a.join("|").localeCompare(b.join("|")) ).slice(0, MAX_EXPLAIN_NODES), repeatedVisits: [...new Set(repeated)].sort(), truncated };
}

export async function prepareExplain(root: string, workspaceId: string, graph: LoadedGraph, start: IciNode, refNames: readonly string[], signal?: AbortSignal): Promise<{ artifact: ExplainPrepareArtifact; artifactPath: string }> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  const callChain = chain(graph, start); const sources: ExplainSourceRef[] = [];
  for (const node of callChain.nodes) if (safeRel(node.sourceFile ?? "") && node.sourceFile.endsWith(".groovy")) sources.push(await sourceRef(root, node.sourceFile, "source", node.nodeId, node.startLine, node.endLine));
  const references: ExplainSourceRef[] = [];
  for (const name of refNames.slice(0, 20)) { const file = name.endsWith(".md") ? name : `${name}.md`; if (!safeRefStem(file)) continue; references.push(await sourceRef(root, `ref_doc/${file}`, "reference")); }
  const manifest = { sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: graphDigest(graph), promptVersion: EXPLAIN_PROMPT_VERSION, engineVersion: ICI_ENGINE_VERSION } as const;
  const contextHash = digest({ api: start.id, callChain, sources, references, manifest }); const prepareId = digest(`${contextHash}|${Date.now()}|${Math.random()}`).slice(0, 32);
  const artifact: ExplainPrepareArtifact = { schemaVersion: 3, kind: "prepare", workspaceId, api: { id: start.id, name: start.name }, callChain, sources, references, manifest, contextHash, prepareId, generatedAt: new Date().toISOString() };
  await writeExplain(root, prepareRel(start.name), `${JSON.stringify(artifact, null, 2)}\n`, signal);
  return { artifact, artifactPath: prepareRel(start.name) };
}

function validText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !SECRET_PATTERN.test(value) && !ABSOLUTE_PATH_PATTERN.test(value); }
function validEvidence(value: unknown): value is readonly string[] { return Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === "string" && /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+#\d+(?:-\d+)?$/.test(item) && !/(authorization|bearer|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)/i.test(item) && !item.split("#", 1)[0].split("/").some((part: string) => part === "." || part === ".." || part === ".metadata")); }
function allowed(value: unknown, keys: readonly string[], required: readonly string[]): value is Record<string, any> { return typeof value === "object" && value !== null && Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.prototype.hasOwnProperty.call(value, key)); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, any> { return allowed(value, keys, keys) && Object.keys(value as object).length === keys.length; }
function validRef(value: any, source: boolean): boolean { const keys = source ? ["nodeId", "path", "startLine", "endLine", "sha256", "bytes", "kind", "readable"] : ["path", "sha256", "bytes", "kind", "readable"]; return allowed(value, keys, source ? ["nodeId", "path", "sha256", "bytes", "kind", "readable"] : ["path", "sha256", "bytes", "kind", "readable"]) && (source ? validText(value.nodeId, 512) : true) && safeRel(value.path) && (source ? value.path.endsWith(".groovy") : value.path.startsWith("ref_doc/")) && (value.sha256 === "" || /^[a-f0-9]{64}$/.test(value.sha256)) && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_EXPLAIN_SOURCE_BYTES && value.kind === (source ? "source" : "reference") && typeof value.readable === "boolean" && (value.readable ? /^[a-f0-9]{64}$/.test(value.sha256) : value.sha256 === "" && value.bytes === 0) && (value.startLine === undefined || Number.isInteger(value.startLine) && value.startLine > 0) && (value.endLine === undefined || Number.isInteger(value.endLine) && value.endLine >= (value.startLine ?? 1)); }
function validPrepareShape(value: any): boolean {
  if (!exact(value, ["schemaVersion", "kind", "workspaceId", "api", "callChain", "sources", "references", "manifest", "contextHash", "prepareId", "generatedAt"]) || value.schemaVersion !== 3 || value.kind !== "prepare" || !validText(value.workspaceId, 256) || !exact(value.api, ["id", "name"]) || !validText(value.api.id, 512) || !validText(value.api.name, 512) || !allowed(value.manifest, ["sourceFingerprint", "graphDigest", "promptVersion", "engineVersion"], ["sourceFingerprint", "graphDigest", "promptVersion"]) || !/^[a-f0-9]{64}$/.test(value.manifest.sourceFingerprint) || !/^[a-f0-9]{64}$/.test(value.manifest.graphDigest) || value.manifest.promptVersion !== EXPLAIN_PROMPT_VERSION || (value.manifest.engineVersion !== undefined && !validText(value.manifest.engineVersion, 64)) || !/^[a-f0-9]{64}$/.test(value.contextHash) || !/^[a-f0-9]{32}$/.test(value.prepareId) || !validText(value.generatedAt, 128) || !Array.isArray(value.sources) || value.sources.length > MAX_EXPLAIN_NODES || !Array.isArray(value.references) || value.references.length > 20) return false;
  if (value.sources.some((ref: any) => !validRef(ref, true)) || value.references.some((ref: any) => !validRef(ref, false)) || new Set(value.sources.map((ref: any) => ref.nodeId)).size !== value.sources.length || new Set(value.references.map((ref: any) => ref.path)).size !== value.references.length) return false;
  if (!exact(value.callChain, ["nodes", "edges", "paths", "repeatedVisits", "truncated"]) || !Array.isArray(value.callChain.nodes) || value.callChain.nodes.length === 0 || value.callChain.nodes.length > MAX_EXPLAIN_NODES || !Array.isArray(value.callChain.edges) || value.callChain.edges.length > MAX_EXPLAIN_EDGES || !Array.isArray(value.callChain.paths) || value.callChain.paths.length > MAX_EXPLAIN_NODES || !Array.isArray(value.callChain.repeatedVisits) || value.callChain.repeatedVisits.length > MAX_EXPLAIN_NODES || typeof value.callChain.truncated !== "boolean") return false;
  const ids = value.callChain.nodes.map((node: any) => node?.nodeId); if (ids.some((id: unknown) => !validText(id, 512)) || new Set(ids).size !== ids.length || value.sources.some((ref: any) => !ids.includes(ref.nodeId)) || value.callChain.paths.some((path: any) => !Array.isArray(path) || path.length === 0 || path.length > MAX_EXPLAIN_DEPTH + 1 || path.some((id: unknown) => !ids.includes(id as string)))) return false;
  for (const node of value.callChain.nodes) if (!allowed(node, ["nodeId", "kind", "name", "owner", "sourceFile", "startLine", "endLine", "signature", "sourceHash", "directCalls", "pathFromApi", "cycle", "repeated"], ["nodeId", "kind", "name", "sourceFile", "directCalls", "pathFromApi", "cycle", "repeated"]) || !validText(node.name, 512) || !["api", "function", "method", "model", "batch"].includes(node.kind) || (node.owner !== undefined && !validText(node.owner, 512)) || (node.signature !== undefined && !validText(node.signature, 2000)) || (node.sourceHash !== undefined && !/^[a-f0-9]{16,64}$/.test(node.sourceHash)) || typeof node.sourceFile !== "string" || (node.sourceFile !== "" && !safeRel(node.sourceFile)) || !Array.isArray(node.directCalls) || node.directCalls.some((id: unknown) => !ids.includes(id as string)) || new Set(node.directCalls).size !== node.directCalls.length || !Array.isArray(node.pathFromApi) || node.pathFromApi.some((id: unknown) => !ids.includes(id as string)) || typeof node.cycle !== "boolean" || typeof node.repeated !== "boolean" || (node.startLine !== undefined && (!Number.isInteger(node.startLine) || node.startLine < 1 || node.startLine > 10000000)) || (node.endLine !== undefined && (!Number.isInteger(node.endLine) || node.endLine < (node.startLine ?? 1) || node.endLine > 10000000))) return false;
  const edgeKeys = new Set<string>(); for (const edge of value.callChain.edges) { if (!exact(edge, ["from", "to", "kind", "source", "confidence", "evidence", "ownerFile"]) || !ids.includes(edge.from) || !ids.includes(edge.to) || !["CALLS", "CONTAINS"].includes(edge.kind) || !["static", "platform", "inferred"].includes(edge.source) || !["high", "medium", "inferred"].includes(edge.confidence) || typeof edge.evidence !== "string" || edge.evidence.length > 400 || SECRET_PATTERN.test(edge.evidence) || ABSOLUTE_PATH_PATTERN.test(edge.evidence) || typeof edge.ownerFile !== "string" || (edge.ownerFile !== "" && !safeRel(edge.ownerFile))) return false; const key = `${edge.from}|${edge.to}|${edge.kind}`; if (edgeKeys.has(key)) return false; edgeKeys.add(key); }
  for (const node of value.callChain.nodes) for (const id of node.directCalls) if (!edgeKeys.has(`${node.nodeId}|${id}|CALLS`)) return false;
  return digest({ api: value.api.id, callChain: value.callChain, sources: value.sources, references: value.references, manifest: value.manifest }) === value.contextHash;
}
export async function loadPrepare(root: string, artifactPath: string): Promise<ExplainPrepareArtifact> {
  if (isAbsolute(artifactPath) || artifactPath.includes("\\") || artifactPath.split("/").includes("..") || !artifactPath.startsWith(".metadata/icomposer/ici/explain/") || !artifactPath.endsWith("/prepare.json")) throw new Error("prepare-invalidated");
  const artifact: any = await readContainedExplainJson(root, artifactPath);
  if (!validPrepareShape(artifact) || prepareRel(artifact.api.name) !== artifactPath) throw new Error("prepare-invalidated");
  return artifact as ExplainPrepareArtifact;
}

export async function readPreparedSources(root: string, workspaceId: string, artifactPath: string, nodeIds: readonly string[], referencePaths: readonly string[], signal?: AbortSignal): Promise<readonly ExplainSourceFile[]> {
  const prepare = await loadPrepare(root, artifactPath); if (prepare.workspaceId !== workspaceId || nodeIds.length + referencePaths.length === 0 || nodeIds.length + referencePaths.length > MAX_EXPLAIN_FILES) throw new Error("source-forbidden");
  const sourceMap = new Map(prepare.sources.map(ref => [ref.nodeId!, ref])); const refMap = new Map(prepare.references.map(ref => [ref.path, ref])); const result: ExplainSourceFile[] = []; let bytes = 0;
  for (const nodeId of nodeIds) { const ref = sourceMap.get(nodeId); if (!ref || !ref.readable) throw new Error("source-forbidden"); const target = await containedFile(root, ref.path); if ((await lstat(target)).size > MAX_EXPLAIN_SOURCE_BYTES) throw new Error("source-oversize"); const content = await readFile(target, "utf8"); if (digest(content) !== ref.sha256) throw new Error("source-changed"); const lines = content.split("\n"); const start = ref.startLine ?? 1; const end = ref.endLine ?? lines.length; if (end < start || end > lines.length) throw new Error("source-range"); for (let cursor = start; cursor <= end; cursor += MAX_RANGE_LINES) { const finish = Math.min(end, cursor + MAX_RANGE_LINES - 1); const part = lines.slice(cursor - 1, finish).join("\n"); bytes += Buffer.byteLength(part, "utf8"); if (bytes > MAX_EXPLAIN_SOURCE_BYTES) throw new Error("source-oversize"); result.push({ nodeId, path: ref.path, startLine: cursor, endLine: finish, content: part, sha256: ref.sha256 }); } }
  for (const path of referencePaths) { const ref = refMap.get(path); if (!ref || !ref.readable) throw new Error("source-forbidden"); const target = await containedFile(root, path); if ((await lstat(target)).size > MAX_EXPLAIN_SOURCE_BYTES) throw new Error("source-oversize"); const content = await readFile(target, "utf8"); if (digest(content) !== ref.sha256) throw new Error("source-changed"); bytes += Buffer.byteLength(content, "utf8"); if (bytes > MAX_EXPLAIN_SOURCE_BYTES) throw new Error("source-oversize"); result.push({ path, content, sha256: ref.sha256 }); }
  if (signal?.aborted) throw new DOMException("aborted", "AbortError"); return result;
}

function validAnalysis(analysis: any): boolean { return exact(analysis, ["technical", "business", "flow", "evidence"]) && validText(analysis.technical, 12000) && validText(analysis.business, 12000) && Array.isArray(analysis.flow) && analysis.flow.length <= 64 && analysis.flow.every((item: unknown) => validText(item, 500) && !String(item).startsWith("/") && !String(item).includes("..")) && validEvidence(analysis.evidence); }
export async function finalizeExplain(root: string, workspaceId: string, preparePathRel: string, analysis: { api: { technical: string; business: string; flow: readonly string[]; evidence: readonly string[] } }, current: { sourceFingerprint: string; graphDigest: string; engineVersion: string }, signal?: AbortSignal, finalId?: string, folderReads: readonly { path: string; sha256: string }[] = [], folderPath = "", referenceTarget?: ExplainReferenceTarget): Promise<{ artifact: ExplainFinalArtifact; artifactPath: string }> {
  const prepare = await loadPrepare(root, preparePathRel); if (prepare.workspaceId !== workspaceId) throw new Error("prepare-invalidated"); const graphManifest = await readManifest(graphBaseDir(root, workspaceId), legacyGraphBaseDir(root, workspaceId)); if (!graphManifest || current.engineVersion !== ICI_ENGINE_VERSION || graphManifest.engineVersion !== ICI_ENGINE_VERSION || prepare.manifest.engineVersion !== ICI_ENGINE_VERSION || prepare.manifest.sourceFingerprint !== current.sourceFingerprint || prepare.manifest.graphDigest !== current.graphDigest || graphManifest.sourceFingerprint !== current.sourceFingerprint || graphManifest.graphDigest !== current.graphDigest) throw new Error("stale-snapshot"); if (!validAnalysis(analysis.api)) throw new Error("analysis-invalid");
  for (const ref of [...prepare.sources, ...prepare.references]) if (ref.readable) { const target = await containedFile(root, ref.path); if ((await lstat(target)).size > MAX_EXPLAIN_SOURCE_BYTES) throw new Error("source-changed"); if (digest(await readFile(target, "utf8")) !== ref.sha256) throw new Error("source-changed"); }
  const selectedTarget = referenceTarget ?? (folderPath === "" ? NONE_REFERENCE_TARGET : { path: folderPath, kind: "directory" as const }); if (!validReferenceTarget(selectedTarget)) throw new Error("folder-changed"); await assertReferenceTarget(root, selectedTarget); if (selectedTarget.kind === "none") { if (folderReads.length > 0) throw new Error("folder-changed"); } else { const folderPrefix = selectedTarget.path === "" ? "" : `${selectedTarget.path}/`; const seenFolderReads = new Map<string, string>(); for (const ref of folderReads) { const validPath = selectedTarget.kind === "file" ? ref.path === selectedTarget.path : ref.path.startsWith(folderPrefix); if (!safeRel(ref.path) || !validPath || !supportedFolderFile(ref.path) || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error("folder-changed"); const previousDigest = seenFolderReads.get(ref.path); if (previousDigest !== undefined) { if (previousDigest !== ref.sha256) throw new Error("folder-changed"); continue; } seenFolderReads.set(ref.path, ref.sha256); try { const target = await containedFile(root, ref.path); if ((await lstat(target)).size > 64 * 1024 || digest(await readFile(target, "utf8")) !== ref.sha256) throw new Error("folder-changed"); } catch { throw new Error("folder-changed"); } } }
  const artifactPath = finalRel(prepare.api.name, finalId ?? prepare.prepareId.slice(0, 16)); const artifact: ExplainFinalArtifact = { schemaVersion: 3, kind: "final", workspaceId: prepare.workspaceId, api: prepare.api, callChain: prepare.callChain, manifest: prepare.manifest, prepareId: prepare.prepareId, sourceFingerprint: prepare.manifest.sourceFingerprint, graphDigest: prepare.manifest.graphDigest, contextHash: prepare.contextHash, generatedBy: "current-agent", verified: false, needsBusinessReview: true, generatedAt: new Date().toISOString(), apiAnalysis: { technical: analysis.api.technical, business: analysis.api.business, flow: [...analysis.api.flow].slice(0, 64), evidence: [...analysis.api.evidence].slice(0, 64) } };
  const finalDigest = digest({ ...artifact, generatedAt: undefined }); const previousState = await readExplainPublicationState(root); try { await explainFinalizeFailpoint?.("before-final"); await writeExplain(root, artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, signal); await explainFinalizeFailpoint?.("after-final"); await writeExplain(root, stateRel(), `${JSON.stringify({ schemaVersion: 3, kind: "final", apiName: prepare.api.name, artifactPath, generatedAt: artifact.generatedAt, sourceFingerprint: artifact.sourceFingerprint, graphDigest: artifact.graphDigest, contextHash: artifact.contextHash, finalDigest }, null, 2)}\n`, signal); await explainFinalizeFailpoint?.("after-state"); } catch (cause) { try { await restoreExplainPublicationState(root, previousState); } catch { /* preserve the original publication failure; readiness remains fail-closed */ } throw cause; }
  return { artifact, artifactPath };
}
export function prepareArtifactPath(apiName: string): string { return prepareRel(apiName); }
export function finalArtifactPath(apiName: string, jobId: string): string { return finalRel(apiName, jobId); }
export function computeGraphDigest(graph: LoadedGraph): string { return graphDigest(graph); }
export function setExplainWriteFailpoint(failpoint: ((relativePath: string) => void) | undefined): void { setExplainWriterFailpoint(failpoint); }
export const setExplainWriteFailpointForTests = setExplainWriteFailpoint;

export const JOB_SCHEMA_VERSION = 1 as const;
export type JobStatus = "awaiting-input" | "scheduled" | "confirmed" | "running" | "final" | "failed" | "cancelled" | "interrupted";
export interface ExplainJobRecord { readonly schemaVersion: 1; readonly kind: "explain-job"; readonly jobId: string; readonly workspaceId: string; readonly apiName: string; readonly apiId: string; /** TASK-111: owning task (batch) id; absent on single-API and legacy records. */ readonly batchId?: string; /** TASK-111: Host process that created this record. */ readonly host?: string; readonly prepareArtifactPath: string; readonly contextHash: string; readonly prepareId: string; readonly sourceFingerprint: string; readonly graphDigest: string; readonly engineVersion?: string; readonly provider: string | null; readonly model: string | null; readonly docs: readonly { path: string; sha256: string }[]; readonly folderPath: string; readonly referenceTarget?: ExplainReferenceTarget; readonly notBefore?: string; readonly status: JobStatus; readonly revision: number; readonly childSessionId?: string; readonly startedAt?: string; readonly finishedAt?: string; readonly error?: string; readonly createdAt: string; readonly updatedAt: string; }
export function referenceTargetOf(job: Pick<ExplainJobRecord, "folderPath" | "referenceTarget">): ExplainReferenceTarget { if (validReferenceTarget(job.referenceTarget)) return job.referenceTarget; if (typeof job.folderPath === "string" && job.folderPath !== "" && validFolderPath(job.folderPath)) return { path: job.folderPath, kind: "directory" }; return NONE_REFERENCE_TARGET; }
const JOB_KEYS = ["schemaVersion", "kind", "jobId", "workspaceId", "apiName", "apiId", "batchId", "host", "prepareArtifactPath", "contextHash", "prepareId", "sourceFingerprint", "graphDigest", "engineVersion", "provider", "model", "docs", "folderPath", "referenceTarget", "notBefore", "status", "revision", "childSessionId", "startedAt", "finishedAt", "createdAt", "updatedAt", "error"];
const JOB_ERRORS = new Set(["confirmation-invalid", "cancelled", "interrupted", "job-active", "stale-snapshot", "source-changed", "folder-changed", "analysis-invalid", "prepare-invalidated", "input-too-large", "output-oversize", "stream-error", "stream-incomplete", "stream-tool-call", "stream-invalid", "stream-aborted", "stream-no-finish", "stream-after-finish", "schema-invalid", "source-forbidden", "folder-forbidden", "folder-oversize", "tool-limit", "model-failed", "lock-timeout", "storage-error"]);
function jobRel(jobId: string): string { if (!/^[a-f0-9]{16}$/.test(jobId)) throw new Error("invalid-job-id"); return `.metadata/icomposer/ici/explain/jobs/${jobId}/job.json`; }
export function jobRecordPath(root: string, jobId: string): string { return join(explainBaseDir(root), "jobs", jobId, "job.json"); }
export function jobRecordRelativePath(jobId: string): string { return jobRel(jobId); }
export function newJobId(): string { return createHash("sha256").update(`${Date.now()}|${Math.random()}|${process.pid}`).digest("hex").slice(0, 16); }
export type ExplainJobInput = Omit<ExplainJobRecord, "schemaVersion" | "kind" | "status" | "revision" | "createdAt" | "updatedAt" | "engineVersion" | "folderPath" | "referenceTarget" | "host"> & { readonly engineVersion?: string; readonly folderPath?: string; readonly referenceTarget?: ExplainReferenceTarget; readonly host?: string };
export async function createJobRecord(root: string, input: ExplainJobInput): Promise<ExplainJobRecord> { const now = new Date().toISOString(); if (input.folderPath !== undefined && input.referenceTarget !== undefined && input.folderPath !== input.referenceTarget.path) throw new Error("confirmation-invalid"); const referenceTarget = input.referenceTarget ?? (typeof input.folderPath === "string" && input.folderPath !== "" ? { path: input.folderPath, kind: "directory" as const } : NONE_REFERENCE_TARGET); const record: ExplainJobRecord = { schemaVersion: 1, kind: "explain-job", ...input, host: input.host ?? HOST_INSTANCE_ID, engineVersion: input.engineVersion ?? ICI_ENGINE_VERSION, referenceTarget, folderPath: referenceTarget.path, status: "awaiting-input", revision: 1, createdAt: now, updatedAt: now }; if (!validJobRecord(record)) throw new Error("confirmation-invalid"); bumpBatchStatusVersion(root, record.batchId); await writeExplain(root, jobRel(record.jobId), `${JSON.stringify(record, null, 2)}\n`); return record; }
function optionalUtcTime(value: unknown): boolean { return value === undefined || typeof value === "string" && !Number.isNaN(Date.parse(value)) && value.endsWith("Z"); }
export function validJobRecord(value: unknown): value is ExplainJobRecord { const r = value as ExplainJobRecord; return allowed(value, JOB_KEYS, JOB_KEYS.filter(key => key !== "error" && key !== "notBefore" && key !== "engineVersion" && key !== "batchId" && key !== "host" && key !== "referenceTarget" && key !== "folderPath" && key !== "childSessionId" && key !== "startedAt" && key !== "finishedAt")) && (r.error === undefined || typeof r.error === "string") && (r.notBefore === undefined || typeof r.notBefore === "string" && !Number.isNaN(Date.parse(r.notBefore)) && r.notBefore.endsWith("Z")) && optionalUtcTime(r.startedAt) && optionalUtcTime(r.finishedAt) && (r.childSessionId === undefined || typeof r.childSessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.childSessionId)) ? r.schemaVersion === 1 && r.kind === "explain-job" && /^[a-f0-9]{16}$/.test(r.jobId) && validText(r.workspaceId, 256) && validText(r.apiName, 512) && validText(r.apiId, 512) && typeof r.prepareArtifactPath === "string" && r.prepareArtifactPath.startsWith(".metadata/icomposer/ici/explain/") && !r.prepareArtifactPath.includes("..") && /^[a-f0-9]{64}$/.test(r.contextHash) && /^[a-f0-9]{32}$/.test(r.prepareId) && /^[a-f0-9]{64}$/.test(r.sourceFingerprint) && /^[a-f0-9]{64}$/.test(r.graphDigest) && (r.engineVersion === undefined || validText(r.engineVersion, 64)) && (r.batchId === undefined || /^[a-f0-9]{16}$/.test(r.batchId)) && (r.host === undefined || validText(r.host, 64)) && (r.provider === null || validText(r.provider, 256)) && (r.model === null || validText(r.model, 256)) && Array.isArray(r.docs) && r.docs.length <= 50 && r.docs.every(doc => typeof doc.path === "string" && safeRel(doc.path) && /^[a-f0-9]{64}$/.test(doc.sha256)) && (r.folderPath === undefined || validFolderPath(r.folderPath)) && (r.referenceTarget !== undefined && validReferenceTarget(r.referenceTarget) || r.folderPath !== undefined && validFolderPath(r.folderPath)) && (r.referenceTarget === undefined || r.folderPath === undefined || r.referenceTarget.path === r.folderPath) && (r.status !== "scheduled" || r.notBefore !== undefined) && ["awaiting-input", "scheduled", "confirmed", "running", "final", "failed", "cancelled", "interrupted"].includes(r.status) && Number.isSafeInteger(r.revision) && r.revision > 0 && validText(r.createdAt, 128) && validText(r.updatedAt, 128) && (r.error === undefined || JOB_ERRORS.has(r.error)) : false; }
export async function readJobRecord(root: string, jobId: string): Promise<ExplainJobRecord | null> { try { const value = await readContainedExplainJson(root, jobRel(jobId)); if (!validJobRecord(value)) return null; const target = value.referenceTarget ?? { path: value.folderPath!, kind: "directory" as const }; return { ...value, folderPath: value.folderPath ?? target.path, referenceTarget: target }; } catch { return null; } }
export async function listJobs(root: string): Promise<ExplainJobRecord[]> { let ids: string[]; try { ids = await readdir(join(explainBaseDir(root), "jobs")); } catch { return []; } const jobs: ExplainJobRecord[] = []; for (const id of ids) { const row = await readJobRecord(root, id); if (row) jobs.push(row); } return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
export async function listActiveJobs(root: string): Promise<ExplainJobRecord[]> { return (await listJobs(root)).filter(row => ["awaiting-input", "scheduled", "confirmed", "running"].includes(row.status)); }
export async function findWorkspaceActiveJob(root: string, workspaceId: string): Promise<ExplainJobRecord | null> { return (await listActiveJobs(root)).find(row => row.workspaceId === workspaceId) ?? null; }
export async function findActiveJobByApiId(root: string, workspaceId: string, apiId: string): Promise<ExplainJobRecord | null> { return (await listActiveJobs(root)).find(row => row.workspaceId === workspaceId && row.apiId === apiId) ?? null; }
export async function updateJobRecord(root: string, jobId: string, expectedRevision: number, patch: Partial<Pick<ExplainJobRecord, "status" | "provider" | "model" | "docs" | "folderPath" | "referenceTarget" | "notBefore" | "childSessionId" | "startedAt" | "finishedAt" | "error">>): Promise<ExplainJobRecord> { return withExplainFileLock(root, jobRel(jobId), async () => { const current = await readJobRecord(root, jobId); if (!current) throw new Error("job-missing"); if (current.revision !== expectedRevision) throw new Error("revision-conflict"); if (patch.error !== undefined && !JOB_ERRORS.has(patch.error)) throw new Error("error-invalid"); if (patch.notBefore !== undefined && (Number.isNaN(Date.parse(patch.notBefore)) || !patch.notBefore.endsWith("Z"))) throw new Error("confirmation-invalid"); if (patch.startedAt !== undefined && (Number.isNaN(Date.parse(patch.startedAt)) || !patch.startedAt.endsWith("Z"))) throw new Error("confirmation-invalid"); if (patch.finishedAt !== undefined && (Number.isNaN(Date.parse(patch.finishedAt)) || !patch.finishedAt.endsWith("Z"))) throw new Error("confirmation-invalid"); if (patch.childSessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(patch.childSessionId)) throw new Error("confirmation-invalid"); if (patch.folderPath !== undefined && !validFolderPath(patch.folderPath)) throw new Error("confirmation-invalid"); if (patch.referenceTarget !== undefined && !validReferenceTarget(patch.referenceTarget)) throw new Error("confirmation-invalid"); if (patch.referenceTarget !== undefined && patch.folderPath !== undefined && patch.referenceTarget.path !== patch.folderPath) throw new Error("confirmation-invalid"); if (patch.provider !== undefined && patch.provider !== null && !validText(patch.provider, 256)) throw new Error("confirmation-invalid"); if (patch.model !== undefined && patch.model !== null && !validText(patch.model, 256)) throw new Error("confirmation-invalid"); if (patch.docs !== undefined && (patch.docs.length > 50 || new Set(patch.docs.map(doc => doc.path)).size !== patch.docs.length || patch.docs.some(doc => !safeRel(doc.path) || !/^[a-f0-9]{64}$/.test(doc.sha256)))) throw new Error("confirmation-invalid"); // TASK-111: `scheduled|confirmed -> awaiting-input` exists ONLY for the confirmation-gate
// recovery (a member scheduled by a confirmation that never committed returns to the card).
const transitions: Record<JobStatus, readonly JobStatus[]> = { "awaiting-input": ["awaiting-input", "scheduled", "confirmed", "cancelled", "failed"], scheduled: ["scheduled", "awaiting-input", "running", "cancelled", "failed"], confirmed: ["confirmed", "awaiting-input", "running", "cancelled", "failed"], running: ["running", "final", "cancelled", "failed", "interrupted"], final: ["final"], failed: ["failed"], cancelled: ["cancelled"], interrupted: ["interrupted"] }; if (patch.status !== undefined && !transitions[current.status].includes(patch.status)) throw new Error("invalid-state-transition"); if (patch.status !== undefined && patch.status !== current.status) bumpBatchStatusVersion(root, current.batchId); const next = { ...current, ...patch, ...(patch.referenceTarget === undefined ? patch.folderPath === undefined ? {} : { referenceTarget: { path: patch.folderPath, kind: "directory" as const } } : { folderPath: patch.referenceTarget.path }), }; if (next.status === "scheduled" && next.notBefore === undefined) throw new Error("confirmation-invalid"); const committed = { ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() }; await writeExplainFile(root, jobRel(jobId), `${JSON.stringify(committed, null, 2)}\n`, { skipLock: true }); return committed; }); }
export async function restoreJobRecord(root: string, previous: ExplainJobRecord, committedRevision: number): Promise<ExplainJobRecord> { return withExplainFileLock(root, jobRel(previous.jobId), async () => { const current = await readJobRecord(root, previous.jobId); if (!current || current.revision !== committedRevision) throw new Error("revision-conflict"); await writeExplainFile(root, jobRel(previous.jobId), `${JSON.stringify(previous, null, 2)}\n`, { skipLock: true, skipFailpoint: true }); return previous; }); }
export async function withExplainJobLocks<T>(root: string, jobIds: readonly string[], task: () => Promise<T>): Promise<T> { const ids = [...new Set(jobIds)].sort(); const acquire = (index: number): Promise<T> => index >= ids.length ? task() : withExplainFileLock(root, jobRel(ids[index]), () => acquire(index + 1)); return acquire(0); }
export async function writeJobRecordUnderLock(root: string, record: ExplainJobRecord, skipFailpoint = false): Promise<void> { if (!validJobRecord(record)) throw new Error("confirmation-invalid"); bumpBatchStatusVersion(root, record.batchId); await writeExplainFile(root, jobRel(record.jobId), `${JSON.stringify(record, null, 2)}\n`, { skipLock: true, skipFailpoint }); }
export async function markRunningJobsInterrupted(root: string): Promise<void> { for (const row of await listJobs(root)) if (row.status === "running") await updateJobRecord(root, row.jobId, row.revision, { status: "interrupted", error: "interrupted" }).catch(() => undefined); }
export function explainStatePath(root: string): string { return join(explainBaseDir(root), "state.json"); }

export const BATCH_SCHEMA_VERSION = 1 as const;
export type ExplainBatchRecord = ContractExplainBatchRecord;
function batchRel(batchId: string): string { if (!/^[a-f0-9]{16}$/.test(batchId)) throw new Error("invalid-batch-id"); return `.metadata/icomposer/ici/explain/batches/${batchId}.json`; }
export function batchRecordRelativePath(batchId: string): string { return batchRel(batchId); }
export function batchRecordPath(root: string, batchId: string): string { batchRel(batchId); return join(explainBaseDir(root), "batches", `${batchId}.json`); }
export function newBatchId(): string { return createHash("sha256").update(`${Date.now()}|${Math.random()}|${process.pid}`).digest("hex").slice(0, 16); }
function batchDir(root: string): string { return join(explainBaseDir(root), "batches"); }
export const validBatchRecord = validExplainBatchRecord;
/**
 * TASK-111 P2 disk forms. The header is the only mutable file: it points either at an
 * inline list (small task) or at one immutable shard generation. Shards are written
 * BEFORE the header switches, so a crash leaves the old complete generation or the new
 * complete generation referenced — never a mixture — and a missing shard makes the task
 * unreadable instead of silently short.
 */
function shardDirRel(batchId: string, generation: number): string { return `.metadata/icomposer/ici/explain/batches/${batchId}/gen-${generation}`; }
function shardRel(batchId: string, generation: number, index: number): string { return `${shardDirRel(batchId, generation)}/shard-${index}.json`; }
/**
 * Generation numbers are never reused: the next generation is one past the highest
 * directory this task already owns, so a leftover from a failed swap can never be
 * overwritten while another reader may still reference it.
 */
async function nextGeneration(root: string, batchId: string): Promise<number> {
  let entries: string[] = [];
  try { entries = await readdir(join(explainBaseDir(root), "batches", batchId)); } catch { return 1; }
  let highest = 0;
  for (const entry of entries) { const match = /^gen-(\d+)$/.exec(entry); if (match) highest = Math.max(highest, Number(match[1])); }
  return highest + 1;
}
/** Keep the current and the previous generation, so a reader that already resolved the old header still completes. */
async function pruneGenerations(root: string, batchId: string, keep: number): Promise<void> {
  let entries: string[] = [];
  try { entries = await readdir(join(explainBaseDir(root), "batches", batchId)); } catch { return; }
  for (const entry of entries) { const match = /^gen-(\d+)$/.exec(entry); if (!match) continue; if (Number(match[1]) < keep) await rm(join(explainBaseDir(root), "batches", batchId, entry), { recursive: true, force: true }).catch(() => undefined); }
}
async function readBatchHeader(root: string, batchId: string): Promise<ExplainBatchHeader | null> { try { const value = await readContainedExplainJson(root, batchRel(batchId)); return validBatchRecord(value) ? value as ExplainBatchHeader : null; } catch { return null; } }
/** Expand a header into the complete record; null means "fail loudly", never "partial". */
async function expandBatch(root: string, header: ExplainBatchHeader): Promise<ExplainBatchRecord | null> {
  if (header.jobIds !== undefined) return { ...header, jobIds: header.jobIds, jobCount: header.jobIds.length };
  const shards = header.jobShards;
  if (shards === undefined) return null;
  const ids: string[] = [];
  for (let index = 0; index < shards.count; index += 1) {
    let value: unknown;
    try { value = await readContainedExplainJson(root, shardRel(header.batchId, shards.generation, index)); } catch { return null; }
    if (!validExplainBatchShardRecord(value)) return null;
    if (value.batchId !== header.batchId || value.generation !== shards.generation || value.index !== index) return null;
    ids.push(...value.jobIds);
  }
  if (ids.length !== header.jobCount || new Set(ids).size !== ids.length) return null;
  return { ...header, jobIds: ids };
}
/** Write the header for a complete record: inline when small, otherwise a fresh immutable generation. */
async function writeBatchTask(root: string, record: ExplainBatchRecord, options: { readonly signal?: AbortSignal; readonly skipLock?: boolean } = {}): Promise<void> {
  const ids = [...record.jobIds];
  if (!validExplainBatchJobIds(ids)) throw new Error("confirmation-invalid");
  const base = { ...record, jobIds: undefined, jobCount: ids.length } as Record<string, unknown>;
  delete base.jobIds;
  delete base.jobShards;
  const previous = await readBatchHeader(root, record.batchId);
  if (ids.length <= EXPLAIN_BATCH_INLINE_MAX) {
    const header: ExplainBatchHeader = { ...(base as unknown as ExplainBatchHeader), jobIds: ids };
    if (!validBatchRecord(header)) throw new Error("confirmation-invalid");
    await writeExplainFile(root, batchRel(record.batchId), `${JSON.stringify(header, null, 2)}\n`, { ...(options.skipLock === true ? { skipLock: true } : {}), ...(options.signal === undefined ? {} : { signal: options.signal }) });
    // A task that no longer needs shards owns (and drops) its old generations.
    if (previous?.jobShards !== undefined) await rm(join(explainBaseDir(root), "batches", record.batchId), { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  const generation = await nextGeneration(root, record.batchId);
  const count = Math.ceil(ids.length / EXPLAIN_BATCH_SHARD_MAX);
  for (let index = 0; index < count; index += 1) {
    const chunk = ids.slice(index * EXPLAIN_BATCH_SHARD_MAX, (index + 1) * EXPLAIN_BATCH_SHARD_MAX);
    const shard = { schemaVersion: 1 as const, kind: "explain-batch-shard" as const, batchId: record.batchId, generation, index, jobIds: chunk };
    if (!validExplainBatchShardRecord(shard)) throw new Error("confirmation-invalid");
    // Immutable: an existing shard file is never overwritten (a referenced generation stays intact).
    await writeExplainFile(root, shardRel(record.batchId, generation, index), `${JSON.stringify(shard, null, 2)}\n`, { skipLock: true, exclusive: true });
  }
  const header: ExplainBatchHeader = { ...(base as unknown as ExplainBatchHeader), jobShards: { generation, count, dir: `gen-${generation}` } };
  if (!validBatchRecord(header)) throw new Error("confirmation-invalid");
  await writeExplainFile(root, batchRel(record.batchId), `${JSON.stringify(header, null, 2)}\n`, { ...(options.skipLock === true ? { skipLock: true } : {}), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  // The superseded generation survives one swap (grace for an in-flight reader).
  await pruneGenerations(root, record.batchId, generation - 1);
}
export async function writeBatchRecord(root: string, record: ExplainBatchRecord, signal?: AbortSignal): Promise<void> { await writeBatchTask(root, record, { signal }); }
export async function writeBatchRecordUnderLock(root: string, record: ExplainBatchRecord): Promise<void> { await writeBatchTask(root, record, { skipLock: true }); }
/**
 * TASK-111 P2 test seam: a hook that runs after the header is read and before it is
 * expanded, so a controlled interleaving can swap the generation at exactly the moment
 * an in-flight reader already resolved the previous one.
 */
let batchReadObserver: ((batchId: string) => void | Promise<void>) | undefined;
export function setExplainBatchReadObserver(observer: ((batchId: string) => void | Promise<void>) | undefined): void { batchReadObserver = observer; }
/**
 * TASK-111 P2: a generation swap must never surface as `recordMissing` to a reader that
 * had already resolved the previous header. Expansion is retried (bounded) against a
 * freshly read header, so a concurrent swap simply resolves the new generation; only a
 * header whose CURRENT generation is incomplete still fails loudly.
 */
export async function readBatchRecord(root: string, batchId: string): Promise<ExplainBatchRecord | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const header = await readBatchHeader(root, batchId);
    if (header === null) return null;
    if (batchReadObserver !== undefined) { const observer = batchReadObserver; batchReadObserver = undefined; await observer(batchId); }
    const expanded = await expandBatch(root, header);
    if (expanded !== null) return expanded;
  }
  return null;
}
/**
 * NOTE(TASK-111): the former hard 10-job ceiling was removed. A host capacity
 * ceiling is a product decision that is still pending, so no new bound is
 * invented here; oversized requests must never be silently truncated.
 */
export async function updateBatchJobIds(root: string, batchId: string, jobIds: readonly string[]): Promise<ExplainBatchRecord> { if (jobIds.length < 1 || new Set(jobIds).size !== jobIds.length || jobIds.some(id => !/^[a-f0-9]{16}$/.test(id))) throw new Error("confirmation-invalid"); return withExplainFileLock(root, batchRel(batchId), async () => { const current = await readBatchRecord(root, batchId); if (!current) throw new Error("batch-missing"); const committed: ExplainBatchRecord = { ...current, jobIds: [...jobIds], updatedAt: new Date().toISOString() }; await writeBatchTask(root, committed, { skipLock: true }); return committed; }); }

/**
 * TASK-111 P4: per-task status version. Every seam that can change a member's status
 * (record write, create, or removal) bumps it, so the status route may cache its summary
 * and still answer with real counts; the map is per process, so a restart rebuilds it.
 */
const batchStatusVersions = new Map<string, number>();
function bumpBatchStatusVersion(root: string, batchId: string | undefined): void { if (batchId === undefined) return; const key = `${root}\0${batchId}`; batchStatusVersions.set(key, (batchStatusVersions.get(key) ?? 0) + 1); }
/** Current version of one task's member statuses (0 when this process has seen no write yet). */
export function batchStatusVersion(root: string, batchId: string): number { return batchStatusVersions.get(`${root}\0${batchId}`) ?? 0; }
/** TASK-111: remove a job record this task created (rollback of a failed task creation); never used on reused records. */
export async function removeJobRecord(root: string, jobId: string, batchId?: string): Promise<void> { bumpBatchStatusVersion(root, batchId); try { await rm(jobRecordPath(root, jobId), { force: true }); } catch { /* best-effort: the record stays inert without its task */ } }
/**
 * TASK-111: mark active jobs whose task record is gone as cancelled, so a partially
 * written task never stays claimable. Ownership is decided by `host` (the process that
 * created the record): recovery never repairs a record created by the live process,
 */
export async function recoverOrphanJobs(root: string, instanceId: string = HOST_INSTANCE_ID): Promise<number> { let recovered = 0; for (const job of await listActiveJobs(root)) { if (job.batchId === undefined) continue; if (job.host === instanceId) continue; const batch = await readBatchRecord(root, job.batchId); if (batch !== null && batch.jobIds.includes(job.jobId)) continue; await updateJobRecord(root, job.jobId, job.revision, { status: "cancelled", error: "interrupted" }).then(() => { recovered += 1; }).catch(() => undefined); } return recovered; }
/** TASK-111: every job id of every readable batch record in this workspace (used to attribute legacy jobs, which carry no `batchId`, to their task). */
export async function listBatchJobIds(root: string): Promise<Map<string, string>> { const map = new Map<string, string>(); let ids: string[]; try { ids = await readdir(batchDir(root)); } catch { return map; } for (const file of ids) { const batchId = file.endsWith(".json") ? file.slice(0, -5) : ""; if (!/^[a-f0-9]{16}$/.test(batchId)) continue; const record = await readBatchRecord(root, batchId); if (!record) continue; for (const jobId of record.jobIds) if (!map.has(jobId)) map.set(jobId, batchId); } return map; }

/**
 * TASK-111: persist the plan the user confirmed once for this task. The task record
 * — not a member job — is the source of truth for the model, reference target, and
 * not-before, so retry replacements and restarts keep the same decision.
 */
export async function updateBatchPlan(root: string, batchId: string, plan: ExplainBatchPlan): Promise<ExplainBatchRecord> { if (!validExplainBatchPlan(plan)) throw new Error("confirmation-invalid"); return withExplainFileLock(root, batchRel(batchId), async () => { const current = await readBatchHeader(root, batchId); if (!current) throw new Error("batch-missing"); const { confirmPending: _pending, confirmOwner: _owner, ...rest } = current; const header: ExplainBatchHeader = { ...rest, plan, updatedAt: new Date().toISOString() }; if (!validBatchRecord(header)) throw new Error("confirmation-invalid"); await writeExplainFile(root, batchRel(batchId), `${JSON.stringify(header, null, 2)}\n`, { skipLock: true }); const expanded = await expandBatch(root, header); if (expanded === null) throw new Error("batch-missing"); return expanded; }); }
/**
 * TASK-111 confirmation gate. `setBatchConfirmPending(true)` arms the gate BEFORE
 * any member is written, so the scheduler refuses to claim this task while the
 * members are being committed; `updateBatchPlan` is the single commit point that
 * writes the plan and clears the gate together. A crash between the two is healed
 * by `recoverPendingConfirms`, which returns every member to awaiting-input.
 */
export async function setBatchConfirmPending(root: string, batchId: string, pending: boolean, owner: string = HOST_INSTANCE_ID): Promise<ExplainBatchRecord> { return withExplainFileLock(root, batchRel(batchId), async () => { const current = await readBatchHeader(root, batchId); if (!current) throw new Error("batch-missing"); const { confirmPending: _armed, confirmOwner: _owner, ...rest } = current; const header: ExplainBatchHeader = { ...rest, ...(pending ? { confirmPending: true, confirmOwner: owner } : {}), updatedAt: new Date().toISOString() }; if (!validBatchRecord(header)) throw new Error("confirmation-invalid"); await writeExplainFile(root, batchRel(batchId), `${JSON.stringify(header, null, 2)}\n`, { skipLock: true }); const expanded = await expandBatch(root, header); if (expanded === null) throw new Error("batch-missing"); return expanded; }); }
/** TASK-111 startup recovery for a confirmation that never committed: clear the gate and un-schedule its members. */
export async function recoverPendingConfirms(root: string, instanceId: string = HOST_INSTANCE_ID): Promise<number> { let healed = 0; let names: string[]; try { names = await readdir(batchDir(root)); } catch { return 0; } for (const file of names) { const batchId = file.endsWith(".json") ? file.slice(0, -5) : ""; if (!/^[a-f0-9]{16}$/.test(batchId)) continue; const record = await readBatchRecord(root, batchId); if (!record || record.confirmPending !== true) continue; if (record.confirmOwner === instanceId) continue;
      for (const jobId of record.jobIds) { const job = await readJobRecord(root, jobId); if (!job || !["scheduled", "confirmed"].includes(job.status)) continue; await updateJobRecord(root, jobId, job.revision, { status: "awaiting-input" }).catch(() => undefined); } await setBatchConfirmPending(root, batchId, false).catch(() => undefined); healed += 1; } return healed; }
/** TASK-111: restore (or clear) the task plan after a failed confirmation, so no half-confirmed plan survives. */
export async function restoreBatchPlan(root: string, batchId: string, plan: ExplainBatchPlan | undefined): Promise<ExplainBatchRecord> { return withExplainFileLock(root, batchRel(batchId), async () => { const current = await readBatchHeader(root, batchId); if (!current) throw new Error("batch-missing"); const { plan: _dropped, ...rest } = current; const header: ExplainBatchHeader = { ...rest, ...(plan === undefined ? {} : { plan }), updatedAt: new Date().toISOString() }; if (!validBatchRecord(header)) throw new Error("confirmation-invalid"); await writeExplainFile(root, batchRel(batchId), `${JSON.stringify(header, null, 2)}\n`, { skipLock: true }); const expanded = await expandBatch(root, header); if (expanded === null) throw new Error("batch-missing"); return expanded; }); }
/** TASK-111: rewrite only the task-level concurrency of one batch record; other tasks and the Host setting stay untouched. */
export async function updateBatchSettings(root: string, batchId: string, maxConcurrent: number): Promise<ExplainBatchRecord> { if (!Number.isInteger(maxConcurrent) || maxConcurrent < EXPLAIN_TASK_CONCURRENCY_MIN || maxConcurrent > EXPLAIN_TASK_CONCURRENCY_MAX) throw new Error("confirmation-invalid"); return withExplainFileLock(root, batchRel(batchId), async () => { const current = await readBatchHeader(root, batchId); if (!current) throw new Error("batch-missing"); const header: ExplainBatchHeader = { ...current, maxConcurrent, updatedAt: new Date().toISOString() }; if (!validBatchRecord(header)) throw new Error("confirmation-invalid"); await writeExplainFile(root, batchRel(batchId), `${JSON.stringify(header, null, 2)}\n`, { skipLock: true }); const expanded = await expandBatch(root, header); if (expanded === null) throw new Error("batch-missing"); return expanded; }); }

