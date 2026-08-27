import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

const ROOT = ".metadata/icomposer/ici/";
const MAX_BYTES = 2 * 1024 * 1024;
const LOCK_RETRY_INITIAL_MS = 10;
const LOCK_RETRY_MAX_MS = 100;
const LOCK_TIMEOUT_MS = 2000;
const FINAL_KEYS = ["schemaVersion", "kind", "workspaceId", "api", "callChain", "manifest", "prepareId", "sourceFingerprint", "graphDigest", "contextHash", "generatedBy", "verified", "needsBusinessReview", "generatedAt", "apiAnalysis"];
const STATE_KEYS = ["schemaVersion", "kind", "apiName", "artifactPath", "generatedAt", "sourceFingerprint", "graphDigest", "contextHash", "finalDigest"];
const SECRET_PATTERN = /(authorization\s*:|bearer\s+|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)/i;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'`])\/(?:Users|home|private|tmp|var|opt|etc)\/|[A-Za-z]:[\\/]/i;

function exact(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return typeof value === "object" && value !== null && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function allowed(value: unknown, keys: readonly string[], required: readonly string[]): value is Record<string, any> {
  return typeof value === "object" && value !== null && Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !SECRET_PATTERN.test(value) && !ABSOLUTE_PATH_PATTERN.test(value);
}
function safeRel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !isAbsolute(value) && !value.includes("\\") && !value.split("/").includes("..") && !value.startsWith(".");
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safeApiSlug(value: string): string { return `${value.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "api"}-${digest(value).slice(0, 12)}`; }

async function safeMetadataPath(root: string, relativePath: string): Promise<string> {
  if (!relativePath.startsWith(ROOT) || isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").includes("..")) throw new Error("artifact-path");
  const rootReal = await realpath(root);
  let current = rootReal;
  for (const segment of normalize(relativePath).split("/")) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("artifact-symlink");
  }
  const target = await realpath(current);
  if (target !== rootReal && !target.startsWith(`${rootReal}/`)) throw new Error("artifact-containment");
  if (!(await stat(target)).isFile()) throw new Error("artifact-file");
  return target;
}
async function readArtifact(root: string, path: string): Promise<any> {
  const target = await safeMetadataPath(root, path);
  const raw = await readFile(target, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) throw new Error("artifact-oversize");
  return JSON.parse(raw);
}
async function ensureParent(root: string, relativePath: string): Promise<{ rootReal: string; target: string }> {
  if (!relativePath.startsWith(ROOT) || isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").includes("..")) throw new Error("artifact-path");
  const rootReal = await realpath(root);
  const parts = normalize(relativePath).split("/");
  let current = rootReal;
  for (const segment of parts.slice(0, -1)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("artifact-symlink");
      await chmod(current, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("artifact-symlink");
    }
  }
  const parent = await realpath(current);
  if (parent !== rootReal && !parent.startsWith(`${rootReal}/`)) throw new Error("artifact-containment");
  return { rootReal, target: join(current, parts.at(-1)!) };
}
async function explainLock(root: string, lockKey: string, task: () => Promise<any>): Promise<any> {
  const hash = createHash("sha256").update(`${await realpath(root)}\0${lockKey}`).digest("hex");
  const lockRel = `${ROOT}.locks/${hash}.lock`;
  const { target } = await ensureParent(root, lockRel);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = LOCK_RETRY_INITIAL_MS;
  for (;;) {
    try { await writeFile(target, `${process.pid}\n`, { flag: "wx", mode: 0o600 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("lock-timeout");
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
    }
  }
  try { return await task(); } finally { await rm(target, { force: true }); }
}
let writeFailpoint: ((relativePath: string) => void) | undefined;
export function setExplainWriterFailpoint(failpoint: ((relativePath: string) => void) | undefined): void { writeFailpoint = failpoint; }
export interface ExplainWriteOptions { readonly exclusive?: boolean; readonly lockKey?: string; readonly signal?: AbortSignal; readonly skipLock?: boolean; readonly skipFailpoint?: boolean; }
export async function withExplainFileLock<T>(root: string, relativePath: string, task: () => Promise<T>, lockKey = relativePath): Promise<T> {
  await ensureParent(root, relativePath);
  return explainLock(root, lockKey, task);
}
/** All ICI metadata writes use this seam. It creates private parents, rejects symlink escapes, and publishes by rename. */
export async function writeExplainFile(root: string, relativePath: string, content: string, options: ExplainWriteOptions = {}): Promise<void> {
  if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
  await ensureParent(root, relativePath);
  const operation = async (): Promise<void> => {
    const { target } = await ensureParent(root, relativePath);
    if (!options.skipFailpoint) writeFailpoint?.(relativePath);
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error("artifact-symlink"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (options.exclusive) {
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error("artifact-symlink");
        if (await readFile(target, "utf8") === content) return;
        throw new Error("immutable-conflict");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (error as Error).message === "immutable-conflict" || (error as Error).message === "artifact-symlink") throw error;
      }
    }
    const temp = `${target}.${createHash("sha256").update(`${Date.now()}|${Math.random()}`).digest("hex").slice(0, 12)}.tmp`;
    try {
      await writeFile(temp, content, { flag: "wx", mode: 0o600 });
      if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
      await rename(temp, target);
      const info = await lstat(target);
      const targetReal = await realpath(target);
      const rootReal = await realpath(root);
      if (info.isSymbolicLink() || (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}/`))) throw new Error("artifact-containment");
    } catch (error) { await rm(temp, { force: true }); throw error; }
  };
  if (options.skipLock) await operation(); else await explainLock(root, options.lockKey ?? relativePath, operation);
}
export async function writeExplainAbsolute(filename: string, content: string, options: ExplainWriteOptions = {}): Promise<void> {
  const normalized = filename.replaceAll("\\", "/");
  const marker = `/${ROOT}`;
  const index = normalized.lastIndexOf(marker);
  if (index < 0) throw new Error("artifact-path");
  await writeExplainFile(normalized.slice(0, index), normalized.slice(index + 1), content, options);
}

function validState(value: any): boolean {
  const prefix = typeof value?.apiName === "string" ? `${ROOT}explain/${safeApiSlug(value.apiName)}/finals/` : "";
  return exact(value, STATE_KEYS) && value.schemaVersion === 3 && value.kind === "final" && text(value.apiName, 512) && typeof value.artifactPath === "string" && value.artifactPath.length <= 512 && !value.artifactPath.includes("\\") && !value.artifactPath.split("/").includes("..") && value.artifactPath.startsWith(prefix) && /^[a-f0-9]{16}\.json$/.test(value.artifactPath.slice(value.artifactPath.lastIndexOf("/") + 1)) && text(value.generatedAt, 128) && /^[a-f0-9]{64}$/.test(value.sourceFingerprint) && /^[a-f0-9]{64}$/.test(value.graphDigest) && /^[a-f0-9]{64}$/.test(value.contextHash) && /^[a-f0-9]{64}$/.test(value.finalDigest);
}
function validEvidence(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(item => typeof item === "string" && item.length <= 400 && !SECRET_PATTERN.test(item) && /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+#\d+(?:-\d+)?$/.test(item) && !item.split("#", 1)[0].split("/").some((part: string) => part === "." || part === ".." || part === ".metadata"));
}
function validChain(value: any): boolean {
  if (!exact(value, ["nodes", "edges", "paths", "repeatedVisits", "truncated"]) || !Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > 80 || !Array.isArray(value.edges) || value.edges.length > 240 || !Array.isArray(value.paths) || value.paths.length > 80 || !Array.isArray(value.repeatedVisits) || value.repeatedVisits.length > 80 || typeof value.truncated !== "boolean") return false;
  const ids = value.nodes.map((node: any) => node?.nodeId);
  if (ids.some((id: unknown) => !text(id, 512)) || new Set(ids).size !== ids.length || value.repeatedVisits.some((id: unknown) => !ids.includes(id as string))) return false;
  for (const node of value.nodes) {
    if (!allowed(node, ["nodeId", "kind", "name", "owner", "sourceFile", "startLine", "endLine", "signature", "sourceHash", "directCalls", "pathFromApi", "cycle", "repeated"], ["nodeId", "kind", "name", "sourceFile", "directCalls", "pathFromApi", "cycle", "repeated"]) || !text(node.name, 512) || !["api", "function", "method", "model", "batch"].includes(node.kind) || typeof node.sourceFile !== "string" || (node.sourceFile !== "" && !safeRel(node.sourceFile)) || (node.owner !== undefined && !text(node.owner, 512)) || (node.signature !== undefined && !text(node.signature, 2000)) || (node.sourceHash !== undefined && !/^[a-f0-9]{16,64}$/.test(node.sourceHash)) || !Array.isArray(node.directCalls) || node.directCalls.some((id: unknown) => !ids.includes(id as string)) || new Set(node.directCalls).size !== node.directCalls.length || !Array.isArray(node.pathFromApi) || node.pathFromApi.some((id: unknown) => !ids.includes(id as string)) || typeof node.cycle !== "boolean" || typeof node.repeated !== "boolean" || (node.startLine !== undefined && (!Number.isInteger(node.startLine) || node.startLine < 1 || node.startLine > 10000000)) || (node.endLine !== undefined && (!Number.isInteger(node.endLine) || node.endLine < (node.startLine ?? 1) || node.endLine > 10000000))) return false;
  }
  const edges = new Set<string>();
  for (const edge of value.edges) {
    if (!exact(edge, ["from", "to", "kind", "source", "confidence", "evidence", "ownerFile"]) || !ids.includes(edge.from) || !ids.includes(edge.to) || !["CALLS", "CONTAINS"].includes(edge.kind) || !["static", "platform", "inferred"].includes(edge.source) || !["high", "medium", "inferred"].includes(edge.confidence) || typeof edge.evidence !== "string" || edge.evidence.length > 400 || SECRET_PATTERN.test(edge.evidence) || ABSOLUTE_PATH_PATTERN.test(edge.evidence) || typeof edge.ownerFile !== "string" || (edge.ownerFile !== "" && !safeRel(edge.ownerFile))) return false;
    const key = `${edge.from}|${edge.to}|${edge.kind}`;
    if (edges.has(key)) return false;
    edges.add(key);
  }
  for (const node of value.nodes) {
    const calls = new Set<string>(node.directCalls);
    for (const id of calls) if (!edges.has(`${node.nodeId}|${id}|CALLS`)) return false;
  }
  return value.paths.every((path: any) => Array.isArray(path) && path.length > 0 && path.length <= 25 && path.every((id: unknown) => ids.includes(id as string)));
}
function validFinal(value: any, state: any): boolean {
  if (!exact(value, FINAL_KEYS) || value.schemaVersion !== 3 || value.kind !== "final" || value.generatedBy !== "current-agent" || value.verified !== false || value.needsBusinessReview !== true) return false;
  if (value.sourceFingerprint !== state.sourceFingerprint || value.graphDigest !== state.graphDigest || value.contextHash !== state.contextHash || value.finalSemanticDigest !== undefined) return false;
  if (!/^[a-f0-9]{32}$/.test(value.prepareId) || !text(value.workspaceId, 256) || !text(value.api?.id, 512) || !text(value.api?.name, 512) || value.api.id !== `api:${state.apiName}` || value.api.name !== state.apiName) return false;
  if (!exact(value.manifest, ["sourceFingerprint", "graphDigest", "promptVersion"]) || value.manifest.sourceFingerprint !== state.sourceFingerprint || value.manifest.graphDigest !== state.graphDigest || value.manifest.promptVersion !== "explain-mvp-v1") return false;
  if (!validChain(value.callChain) || !exact(value.apiAnalysis, ["technical", "business", "flow", "evidence"]) || !text(value.apiAnalysis.technical, 12000) || !text(value.apiAnalysis.business, 12000) || !Array.isArray(value.apiAnalysis.flow) || value.apiAnalysis.flow.length > 64 || !value.apiAnalysis.flow.every((item: unknown) => text(item, 500) && !String(item).startsWith("/") && !String(item).includes("..")) || !validEvidence(value.apiAnalysis.evidence)) return false;
  return digest({ ...value, generatedAt: undefined }) === state.finalDigest;
}
export interface ValidatedExplainFinal { readonly state: any; readonly final: any; readonly artifactPath: string; }
export async function readValidatedExplainFinal(root: string, expectedApiName?: string, expectedWorkspaceId?: string): Promise<ValidatedExplainFinal | null> {
  try {
    const state = await readArtifact(root, `${ROOT}explain/state.json`);
    if (!validState(state) || (expectedApiName !== undefined && state.apiName !== expectedApiName)) return null;
    const prefix = `${ROOT}explain/${safeApiSlug(state.apiName)}/finals/`;
    if (!state.artifactPath.startsWith(prefix)) return null;
    const final = await readArtifact(root, state.artifactPath);
    if (!validFinal(final, state) || (expectedWorkspaceId !== undefined && final.workspaceId !== expectedWorkspaceId)) return null;
    const manifest = await readArtifact(root, `${ROOT}graph/current/manifest.json`);
    if (typeof manifest?.sourceFingerprint !== "string" || typeof manifest?.graphDigest !== "string" || manifest.sourceFingerprint !== state.sourceFingerprint || manifest.graphDigest !== state.graphDigest) return null;
    return { state, final, artifactPath: state.artifactPath };
  } catch { return null; }
}
export async function readContainedExplainJson(root: string, path: string): Promise<unknown> { return readArtifact(root, path); }
export async function isExplainArtifactPathContained(root: string, path: string): Promise<boolean> { try { await safeMetadataPath(root, path); return true; } catch { return false; } }
export async function assertExplainWritePath(root: string, relativePath: string): Promise<void> { await ensureParent(root, relativePath); }
