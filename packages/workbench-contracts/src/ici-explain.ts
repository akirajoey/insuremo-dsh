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
  if (!allowed(value.manifest, ["sourceFingerprint", "graphDigest", "promptVersion", "engineVersion"], ["sourceFingerprint", "graphDigest", "promptVersion"]) || value.manifest.sourceFingerprint !== state.sourceFingerprint || value.manifest.graphDigest !== state.graphDigest || value.manifest.promptVersion !== "explain-mvp-v1" || (value.manifest.engineVersion !== undefined && !text(value.manifest.engineVersion, 64))) return false;
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
    if (typeof manifest?.sourceFingerprint !== "string" || typeof manifest?.graphDigest !== "string" || manifest.sourceFingerprint !== state.sourceFingerprint || manifest.graphDigest !== state.graphDigest || (final.manifest.engineVersion !== undefined && final.manifest.engineVersion !== manifest.engineVersion)) return null;
    return { state, final, artifactPath: state.artifactPath };
  } catch { return null; }
}
export async function readContainedExplainJson(root: string, path: string): Promise<unknown> { return readArtifact(root, path); }
export async function isExplainArtifactPathContained(root: string, path: string): Promise<boolean> { try { await safeMetadataPath(root, path); return true; } catch { return false; } }
export async function assertExplainWritePath(root: string, relativePath: string): Promise<void> { await ensureParent(root, relativePath); }

/** TASK-111: task-level concurrency bounds (they mirror explain-config's Host bounds). */
export const EXPLAIN_TASK_CONCURRENCY_MIN = 1 as const;
export const EXPLAIN_TASK_CONCURRENCY_MAX = 32 as const;
/** TASK-111: the once-confirmed task plan. */
export interface ExplainBatchPlan {
  readonly provider: string;
  readonly model: string;
  readonly referenceTarget: { readonly path: string; readonly kind: "none" | "file" | "directory" };
  readonly notBefore: string;
  readonly confirmedAt: string;
}
/** TASK-111: the request shape of a task. `group`/`all` are resolved host-side against the workspace catalog snapshot. */
export type ExplainTaskSelectorKind = "api" | "group" | "all" | "queries";
export interface ExplainTaskSelector {
  readonly kind: ExplainTaskSelectorKind;
  /** The group name (`group`) or the api query (`api`); absent for `all` and explicit lists. */
  readonly label?: string;
}
/**
 * TASK-111 P2: the batch job list is stored as immutable shard files and the batch
 * record is only the header that points at one generation of them. The numbers bound
 * ONE FILE, never the number of targets: a task keeps every target, and the shard
 * count grows with it. A header that would need more than `INLINE_MAX` ids carries no
 * inline list at all, so a reader that ignores the shard fields fails loudly instead
 * of silently seeing a prefix.
 */
export const EXPLAIN_BATCH_INLINE_MAX = 512 as const;
export const EXPLAIN_BATCH_SHARD_MAX = 512 as const;
/** One generation of shard files inside `batches/<batchId>/gen-<generation>/`. */
export interface ExplainBatchShards {
  readonly generation: number;
  readonly count: number;
  readonly dir: string;
}
export interface ExplainBatchShardRecord {
  readonly schemaVersion: 1;
  readonly kind: "explain-batch-shard";
  readonly batchId: string;
  readonly generation: number;
  readonly index: number;
  readonly jobIds: readonly string[];
}
/** TASK-111: the disk header. Exactly one of `jobIds` (small task) and `jobShards` (large task) is present. */
export interface ExplainBatchHeader extends Omit<ExplainBatchRecord, "jobIds"> {
  readonly jobIds?: readonly string[];
  readonly jobShards?: ExplainBatchShards;
}
export interface ExplainBatchRecord {
  readonly schemaVersion: 1;
  readonly kind: "explain-batch";
  readonly batchId: string;
  readonly workspaceId: string;
  readonly jobIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** TASK-111 P2: total number of job ids across the inline list or every shard. */
  readonly jobCount?: number;
  /** TASK-111 task-level maximum concurrency; absent on legacy records (the Host default applies). */
  readonly maxConcurrent?: number;
  /** TASK-111 targets the triggering tool call declared (never below `jobIds.length`); absent on legacy records. */
  readonly requestedCount?: number;
  /** TASK-111 what the user asked for (api/group/all/explicit list), for card disclosure; absent on legacy records. */
  readonly selector?: ExplainTaskSelector;
  /**
   * TASK-111 the plan the user confirmed ONCE for the whole task. It is the task's
   * own record of that decision (not re-derived from a member job), so a retry
   * replacement and a restart both keep the same model, reference, and time.
   */
  readonly plan?: ExplainBatchPlan;
  /**
   * TASK-111: a confirmation that is still committing. While this is true the task
   * is not claimable, so a member scheduled by a half-finished confirmation can
   * never start, and a crash mid-commit is recoverable (the flag is cleared and
   * every member returns to awaiting-input on the next start).
   */
  readonly confirmPending?: boolean;
  /** TASK-111: the Host process that armed the gate; recovery only heals another process's gate. */
  readonly confirmOwner?: string;
}
export type ExplainBatchJobStatus = "awaiting-input" | "scheduled" | "confirmed" | "running" | "final" | "failed" | "cancelled" | "interrupted";
export interface ExplainBatchStatusJob { readonly jobId: string; readonly apiName: string; readonly status: ExplainBatchJobStatus; readonly artifactPath?: string; readonly error?: string; readonly promptBaseBytes: number; readonly sourceBytes: number; }
/** TASK-111: Host ceiling plus this task's own live concurrency, so the card can show both without another write path. */
export interface ExplainBatchSchedulerView { readonly maxConcurrent: number; readonly inFlight: number; readonly taskMaxConcurrent?: number; readonly taskInFlight?: number; readonly hostMaxConcurrent?: number; }
export interface ExplainBatchStatus { readonly batch: ExplainBatchRecord; readonly jobs: readonly ExplainBatchStatusJob[]; readonly providers: readonly { id: string; models: readonly { id: string; name: string }[] }[]; readonly summary: { promptBaseBytes: number; sourceBytes: number; maxPromptBaseBytes?: number; jobCount?: number }; readonly scheduler?: ExplainBatchSchedulerView; }
export interface ExplainBatchConfirmInput { readonly provider: string; readonly model: string; readonly docs: readonly { path: string; sha256: string }[]; readonly referenceTarget: { path: string; kind: "none" | "file" | "directory" }; readonly notBefore: string; readonly consent: true; }
/** TASK-111 removed the former hard 10-job ceiling: one task carries every target. */
export function validExplainBatchJobIds(value: unknown): value is readonly string[] { return Array.isArray(value) && value.length >= 1 && value.every(id => typeof id === "string" && /^[a-f0-9]{16}$/.test(id)) && new Set(value).size === value.length; }
function validShardList(value: unknown): value is readonly string[] { return Array.isArray(value) && value.length >= 1 && value.length <= EXPLAIN_BATCH_SHARD_MAX && value.every(id => typeof id === "string" && /^[a-f0-9]{16}$/.test(id)); }
function validExplainBatchShards(value: unknown): value is ExplainBatchShards {
  if (!allowed(value, ["generation", "count", "dir"], ["generation", "count", "dir"])) return false;
  const row = value as ExplainBatchShards;
  return Number.isSafeInteger(row.generation) && row.generation >= 1 && Number.isSafeInteger(row.count) && row.count >= 1 && row.dir === `gen-${row.generation}`;
}
export function validExplainBatchShardRecord(value: unknown): value is ExplainBatchShardRecord {
  if (!allowed(value, ["schemaVersion", "kind", "batchId", "generation", "index", "jobIds"], ["schemaVersion", "kind", "batchId", "generation", "index", "jobIds"])) return false;
  const row = value as ExplainBatchShardRecord;
  return row.schemaVersion === 1 && row.kind === "explain-batch-shard" && /^[a-f0-9]{16}$/.test(row.batchId) && Number.isSafeInteger(row.generation) && row.generation >= 1 && Number.isSafeInteger(row.index) && row.index >= 0 && validShardList(row.jobIds);
}
export function validExplainTaskSelector(value: unknown): value is ExplainTaskSelector {
  if (!allowed(value, ["kind", "label"], ["kind"])) return false;
  const row = value as ExplainTaskSelector;
  if (!["api", "group", "all", "queries"].includes(row.kind)) return false;
  if (row.label === undefined) return row.kind === "all" || row.kind === "queries";
  return text(row.label, 512);
}
const REFERENCE_TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".log"]);
function validPlanReferenceTarget(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 2) return false;
  const target = value as Record<string, unknown>;
  if (target.kind === "none") return target.path === "";
  if (target.kind !== "file" && target.kind !== "directory") return false;
  const path = target.path;
  if (typeof path !== "string" || path.length > 512 || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.startsWith(".metadata")) return false;
  if (path !== "" && path.split("/").some(part => part === "" || part === "." || part === "..")) return false;
  if (target.kind === "directory") return true;
  const dot = path.lastIndexOf(".");
  return dot > 0 && REFERENCE_TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}
function utcTime(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && !Number.isNaN(Date.parse(value)) && value.endsWith("Z"); }
export function validExplainBatchPlan(value: unknown): value is ExplainBatchPlan {
  if (!allowed(value, ["provider", "model", "referenceTarget", "notBefore", "confirmedAt"], ["provider", "model", "referenceTarget", "notBefore", "confirmedAt"])) return false;
  const row = value as ExplainBatchPlan;
  return text(row.provider, 256) && text(row.model, 256) && validPlanReferenceTarget(row.referenceTarget) && utcTime(row.notBefore) && utcTime(row.confirmedAt);
}
export function validExplainBatchRecord(value: unknown): value is ExplainBatchRecord {
  const keys = ["schemaVersion", "kind", "batchId", "workspaceId", "jobIds", "jobShards", "jobCount", "createdAt", "updatedAt", "maxConcurrent", "requestedCount", "selector", "plan", "confirmPending", "confirmOwner"];
  if (!allowed(value, keys, ["schemaVersion", "kind", "batchId", "workspaceId", "createdAt", "updatedAt"])) return false;
  const row = value as ExplainBatchHeader;
  if (row.schemaVersion !== 1 || row.kind !== "explain-batch" || !/^[a-f0-9]{16}$/.test(row.batchId) || !text(row.workspaceId, 256) || !text(row.createdAt, 128) || !text(row.updatedAt, 128)) return false;
  const inline = row.jobIds !== undefined;
  const sharded = row.jobShards !== undefined;
  if (inline === sharded) return false; // exactly one carrier: a sharded header has no inline prefix
  if (inline && !validExplainBatchJobIds(row.jobIds)) return false;
  if (inline && row.jobIds !== undefined && row.jobIds.length > EXPLAIN_BATCH_INLINE_MAX) return false;
  if (sharded && !validExplainBatchShards(row.jobShards)) return false;
  if (sharded && (!Number.isSafeInteger(row.jobCount) || (row.jobCount ?? 0) < (row.jobShards?.count ?? 1))) return false;
  if (inline && row.jobCount !== undefined && row.jobCount !== row.jobIds?.length) return false;
  if (row.maxConcurrent !== undefined && (!Number.isInteger(row.maxConcurrent) || row.maxConcurrent < EXPLAIN_TASK_CONCURRENCY_MIN || row.maxConcurrent > EXPLAIN_TASK_CONCURRENCY_MAX)) return false;
  if (row.requestedCount !== undefined && (!Number.isInteger(row.requestedCount) || row.requestedCount < (inline ? (row.jobIds?.length ?? 0) : (row.jobCount ?? 0)))) return false;
  if (row.selector !== undefined && !validExplainTaskSelector(row.selector)) return false;
  if (row.plan !== undefined && !validExplainBatchPlan(row.plan)) return false;
  if (row.confirmPending !== undefined && typeof row.confirmPending !== "boolean") return false;
  if (row.confirmOwner !== undefined && (row.confirmPending !== true || typeof row.confirmOwner !== "string" || row.confirmOwner.length > 64)) return false;
  return true;
}
